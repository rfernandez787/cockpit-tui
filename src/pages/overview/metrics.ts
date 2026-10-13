/*
 * Live usage from a raw metrics1 channel: the pure half.
 *
 * Why a raw channel and our own decompressor rather than cockpit.metrics():
 * the library's series/grid machinery exists for time-indexed plots. Its
 * index starts up to a second ahead of the wall clock and drifts, so a
 * walking grid hides the newest sample; its decompressor fills gaps from the
 * previous row up to the previous row's length and never truncates when an
 * instance disappears, so a removed network interface's last value leaks into
 * the sum ([7, 8] after [a, b, c] -> [a, b] decodes as [7, 8, 3]). A usage
 * panel wants "the latest value now", which a raw channel gives directly.
 * See specs/metrics.md G3, G11, §7.1.
 *
 * Wire format (bridge channels/metrics.py, doc/protocol.md "metrics1"):
 *
 *   - a JSON object is a meta message: {metrics: [{name, units, derive?,
 *     instances?}], interval, timestamp, now}. Scalar metrics carry
 *     `derive` (possibly null), instanced ones carry `instances` instead.
 *   - a JSON array is data: one or more rows, each with one value per
 *     metric in meta order; an instanced metric's value is an array in the
 *     meta's instance order.
 *   - `false` is a real value meaning "not available yet": every rate in the
 *     first row after open, and a new instance's first rate.
 *   - The Python bridge sends every row complete. The legacy C bridge (still
 *     met over ssh on old hosts) compresses: an unchanged value becomes null,
 *     and trailing unchanged values are dropped, giving shorter arrays. It
 *     only omits a value when the same instance name sits at the same index
 *     as in the previous row, and it keeps compressing across a mid-stream
 *     meta, so the previous row must survive a meta and gaps are filled by
 *     index.
 *   - Rates are per SECOND (the protocol doc says per millisecond; both
 *     bridges divide by seconds): CPU in ms/s, disk and network in B/s.
 */

/** One entry of the channel's "metrics" open option. */
export interface MetricRequest {
    readonly name: string;
    readonly units?: string;
    readonly derive?: "rate";
}

/*
 * Every name and unit here exists in both the Python bridge (356) and the C
 * bridges before it, so no single optional metric can make an older bridge
 * close the whole channel "not-supported" (G14). Temperature, per-core and
 * cgroup families are deliberately left off.
 */
export const USAGE_METRICS: readonly MetricRequest[] = [
    { name: "cpu.basic.user", derive: "rate" },
    { name: "cpu.basic.system", derive: "rate" },
    { name: "cpu.basic.nice", derive: "rate" },
    { name: "memory.used" },
    { name: "memory.swap-used" },
    { name: "disk.all.read", units: "bytes", derive: "rate" },
    { name: "disk.all.written", units: "bytes", derive: "rate" },
    { name: "network.interface.rx", units: "bytes", derive: "rate" },
    { name: "network.interface.tx", units: "bytes", derive: "rate" },
];

import { Decompressor, isMeta, type Meta, type MetaMetric, type Sample, type Scalar, type Value } from "../../lib/metrics.js";

export { Decompressor, isMeta, type Meta, type MetaMetric, type Sample, type Scalar, type Value };

// ---- totals the metrics do not carry -------------------------------------------

/** argv for the totals: upstream's machine_info.cpu_ram_info(). */
export const MACHINE_INFO_ARGV = ["cat", "/proc/meminfo", "/proc/cpuinfo"] as const;

export interface MachineInfo {
    /** Bytes. */
    readonly memTotal: number | null;
    /** Bytes; 0 when the host has no swap. */
    readonly swapTotal: number | null;
    /** Online CPUs; 0 if the count could not be read. */
    readonly cpus: number;
}

/**
 * /proc/meminfo followed by /proc/cpuinfo. The CPU count is the number of
 * "processor" lines ("cpu number" on s390x), as upstream counts them.
 */
export function parseMachineInfo(text: string): MachineInfo {
    const kb = (key: string): number | null => {
        const match = new RegExp(`^${key}:\\s*(\\d+)\\s*kB`, "mi").exec(text);
        return match ? Number(match[1]) * 1024 : null;
    };
    const cpus = (text.match(/^(processor|cpu number)\s*:/gm) ?? []).length;
    return { memTotal: kb("MemTotal"), swapTotal: kb("SwapTotal"), cpus };
}

/** argv listing the virtual network interfaces; the physical ones are the rest. */
export const VIRTUAL_NET_ARGV = ["ls", "-1", "/sys/devices/virtual/net"] as const;

export function parseNameList(text: string): Set<string> {
    return new Set(text.split("\n").map(line => line.trim()).filter(Boolean));
}

// ---- the model the page shows ----------------------------------------------------

export interface UsageModel {
    /** 0..100, or null until two samples and the CPU count are in. */
    readonly cpuPercent: number | null;
    readonly cpus: number | null;
    readonly memUsed: number | null;
    readonly memTotal: number | null;
    /** null: no swap on this host (the row is hidden), or not known yet. */
    readonly swap: { readonly used: number | null, readonly total: number } | null;
    readonly diskRead: number | null;
    readonly diskWrite: number | null;
    readonly netRx: number | null;
    readonly netTx: number | null;
}

export const EMPTY_USAGE: UsageModel = {
    cpuPercent: null, cpus: null, memUsed: null, memTotal: null, swap: null,
    diskRead: null, diskWrite: null, netRx: null, netTx: null,
};

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function valueOf(sample: Sample, meta: Meta, name: string): Value {
    const index = meta.metrics.findIndex(metric => metric.name === name);
    return index < 0 ? undefined : sample[index];
}

/** A rate that can go negative for one sample after a counter reset (G13). */
function rate(value: Value): number | null {
    return isNumber(value) ? Math.max(0, value) : null;
}

/**
 * Sum an instanced rate over the physical interfaces. Loopback and virtual
 * devices (bridges, taps, veths) would count the same traffic again (G5).
 * `virtual` null means the classification is not known yet: show nothing
 * rather than a double-counted number. A new interface's first `false` is
 * skipped; only when no interface has a value is the sum unknown.
 */
function physicalSum(sample: Sample, meta: Meta, name: string, virtual: ReadonlySet<string> | null): number | null {
    if (virtual === null)
        return null;
    const index = meta.metrics.findIndex(metric => metric.name === name);
    const instances = meta.metrics[index]?.instances;
    const values = sample[index];
    if (!instances || !Array.isArray(values))
        return null;
    let sum = 0;
    let any = false;
    instances.forEach((instance, i) => {
        const value = values[i];
        if (virtual.has(instance) || !isNumber(value))
            return;
        sum += Math.max(0, value);
        any = true;
    });
    return any ? sum : null;
}

/**
 * The latest sample, as the page shows it. CPU% is (user + system + nice)
 * ms/s over 1000 ms/s per CPU: upstream's round((u + s + n) / 10 / nCPU). It
 * waits for the CPU count rather than assuming one CPU, which would inflate
 * it by the number of CPUs, and for real rates rather than the first row's
 * false (which arithmetic would treat as 0).
 */
export function usageModel(sample: Sample | null, meta: Meta | null, info: MachineInfo | null,
                           virtual: ReadonlySet<string> | null): UsageModel {
    const cpus = info && info.cpus > 0 ? info.cpus : null;
    const memTotal = info?.memTotal ?? null;
    const swapTotal = info?.swapTotal ?? null;
    if (!sample || !meta) {
        return {
            ...EMPTY_USAGE, cpus, memTotal,
            swap: swapTotal ? { used: null, total: swapTotal } : null,
        };
    }

    const user = valueOf(sample, meta, "cpu.basic.user");
    const system = valueOf(sample, meta, "cpu.basic.system");
    const nice = valueOf(sample, meta, "cpu.basic.nice");
    let cpuPercent: number | null = null;
    if (cpus !== null && isNumber(user) && isNumber(system) && isNumber(nice))
        cpuPercent = Math.max(0, Math.min(100, (user + system + nice) / 10 / cpus));

    const memUsed = valueOf(sample, meta, "memory.used");
    const swapUsed = valueOf(sample, meta, "memory.swap-used");

    return {
        cpuPercent,
        cpus,
        memUsed: isNumber(memUsed) ? memUsed : null,
        memTotal,
        swap: swapTotal ? { used: isNumber(swapUsed) ? swapUsed : null, total: swapTotal } : null,
        diskRead: rate(valueOf(sample, meta, "disk.all.read")),
        diskWrite: rate(valueOf(sample, meta, "disk.all.written")),
        netRx: physicalSum(sample, meta, "network.interface.rx", virtual),
        netTx: physicalSum(sample, meta, "network.interface.tx", virtual),
    };
}

/** The network instances a meta lists, for re-classifying when they change. */
export function networkInstances(meta: Meta | null): string[] {
    return [...(meta?.metrics.find(metric => metric.name === "network.interface.rx")?.instances ?? [])];
}
