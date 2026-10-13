/*
 * metrics1 with source "internal", replaying scripted samples in the real
 * bridge's envelope (cockpit-bridge 356, channels/metrics.py):
 *
 *   ready, then a meta message (pretty JSON):
 *     {"source": "internal", "interval": N, "timestamp": <float ms>, "now": <ms>,
 *      "metrics": [{"name", "derive", "units", "semantics"}            plain
 *                  {"name", "units", "instances", "semantics"}]}       instanced
 *   then one data message per interval, Python json.dumps() style:
 *     [[<value per metric; an array per instanced metric>]]
 *
 * The installed Python bridge never compresses: every row carries every
 * value. "derive": "rate" sends false for the first sample (there is no
 * previous one), then (value - previous) / seconds. The real bridge divides
 * by the measured wall-clock gap; the mock uses the nominal interval so the
 * numbers are deterministic. A new meta message precedes the data whenever an
 * instanced metric's set of instances changes.
 *
 * "metricsCompress": true in the scenario emulates the legacy C bridge
 * instead: values unchanged since the previous row become null, trailing
 * unchanged values are dropped, and instanced metrics are always present as
 * an array (possibly empty). That is what the library's decompression in
 * cockpit.metrics() exists for.
 */
import { scenario, control, sendJson, writeFrame, finish, schedule, pyJson, isPlainObject } from "./core.mjs";

/*
 * Everything the real internal source knows (samples.py), as
 * [units, semantics, instanced]. These names are always accepted, as they are
 * by the real bridge; unscripted ones sample as 0 (instanced: no instances).
 */
const KNOWN = {};
function known(names, units, semantics, instanced) {
    for (const name of names)
        KNOWN[name] = [units, semantics, instanced];
}
known(["cpu.basic.nice", "cpu.basic.user", "cpu.basic.system", "cpu.basic.iowait"], "millisec", "counter", false);
known(["cpu.core.nice", "cpu.core.user", "cpu.core.system", "cpu.core.iowait"], "millisec", "counter", true);
known(["memory.free", "memory.used", "memory.cached", "memory.swap-used"], "bytes", "instant", false);
known(["cpu.temperature"], "celsius", "instant", true);
known(["disk.all.read", "disk.all.written"], "bytes", "counter", false);
known(["disk.dev.read", "disk.dev.written"], "bytes", "counter", true);
known(["cgroup.memory.usage", "cgroup.memory.limit", "cgroup.memory.sw-usage", "cgroup.memory.sw-limit"],
      "bytes", "instant", true);
known(["cgroup.cpu.usage"], "millisec", "counter", true);
known(["cgroup.cpu.shares"], "count", "instant", true);
known(["disk.cgroup.read", "disk.cgroup.written"], "bytes", "counter", true);
known(["network.interface.tx", "network.interface.rx"], "bytes", "counter", true);
known(["mount.total", "mount.used"], "bytes", "instant", true);
known(["block.device.read", "block.device.written"], "bytes", "counter", true);

/** The description of a metric name, or null if the bridge would not know it. */
function describe(name) {
    const scripted = (scenario.metrics ?? {})[name];
    const builtin = KNOWN[name];
    if (!scripted && !builtin)
        return null;
    const def = scripted ?? {};
    const samples = def.samples ?? [];
    const firstSample = samples[0];
    return {
        name,
        units: def.units ?? builtin?.[0] ?? "count",
        semantics: def.semantics ?? builtin?.[1] ?? "instant",
        instanced: def.instances !== undefined || Array.isArray(firstSample) || isPlainObject(firstSample)
            || Boolean(builtin?.[2]),
        instances: def.instances,
        samples,
    };
}

/** Sample k of a metric, repeating the last one when they run out. */
function sampleAt(desc, k) {
    const { samples } = desc;
    const raw = samples.length ? samples[Math.min(k, samples.length - 1)] : undefined;
    if (!desc.instanced)
        return raw ?? 0;
    if (isPlainObject(raw))
        return { names: Object.keys(raw), values: Object.values(raw) };
    const names = desc.instances ?? (Array.isArray(raw) ? raw.map((_, i) => String(i)) : []);
    const values = Array.isArray(raw) ? raw : names.map(() => 0);
    return { names, values };
}

function getInterval(options) {
    if (!Object.hasOwn(options, "interval"))
        return { interval: 1000 };
    const interval = options.interval;
    if (!Number.isInteger(interval))
        // A JsonError inside the AsyncChannel's task: {problem, message}.
        return { error: { problem: "protocol-error", message: "attribute 'interval': must have type int" } };
    if (interval <= 0)
        return { error: { message: `invalid "interval" value: ${interval}`, problem: "protocol-error" } };
    return { interval };
}

export const metrics1 = {
    open(state) {
        const options = state.options;
        const { interval, error } = getInterval(options);
        if (error) {
            finish(state, error);
            return;
        }

        // Anything but "internal" goes to the PCP channel, which this mock
        // emulates as a host without python3-pcp installed: after its option
        // checks, the import fails before the source is even looked at.
        if (options.source !== "internal") {
            if (!options.source)
                finish(state, { message: 'no "source" option specified for metrics channel', problem: "protocol-error" });
            else
                finish(state, { message: "python3-pcp not installed", problem: "not-supported" });
            return;
        }

        const requested = options.metrics;
        if (!Array.isArray(requested) || requested.length === 0) {
            finish(state, {
                message: 'invalid "metrics" option was specified (not an array)', problem: "protocol-error",
            });
            return;
        }

        state.metrics = [];
        for (const metric of requested) {
            // parse_options() takes each entry for a dict: anything else
            // raises AttributeError at metric.get('name'), and an unhashable
            // name TypeError at the samplers lookup -- both escape as
            // internal-error with the traceback.
            if (!isPlainObject(metric)) {
                finish(state, internalError(62, "name = metric.get('name')",
                                            `AttributeError: '${pyTypeName(metric)}' object has no attribute 'get'`));
                return;
            }
            const name = metric.name;
            if (Array.isArray(name) || isPlainObject(name)) {
                finish(state, internalError(67, "sampler, desc = self.samplers_cache[name]",
                                            `TypeError: unhashable type: '${pyTypeName(name)}'`));
                return;
            }
            const desc = typeof name === "string" ? describe(name) : null;
            if (!desc) {
                // f'unsupported metric: {name}', with Python's str() of the name
                const shown = name === undefined || name === null ? "None"
                    : typeof name === "boolean" ? (name ? "True" : "False") : String(name);
                finish(state, { message: `unsupported metric: ${shown}`, problem: "not-supported" });
                return;
            }
            if (metric.units && metric.units !== desc.units) {
                const units = metric.units === true ? "True" : typeof metric.units === "string" ? metric.units
                    : JSON.stringify(metric.units);
                finish(state, { message: `${name} has units ${desc.units}, not ${units}`, problem: "not-supported" });
                return;
            }
            state.metrics.push({ desc, derive: metric.derive ?? null, last: undefined, lastNames: null });
        }

        state.interval = interval;
        state.tick = 0;
        state.needMeta = true;
        state.previousRow = null;
        state.compress = scenario.metricsCompress === true;

        control.ready(state.id);
        sample(state);
    },

    // AsyncChannel queues data it is sent; the internal source never reads it.
    data() {},

    clientClose(state) {
        finish(state, {}); // also stops the sampling timer
    },
};

/** Python's type name for a JSON value. */
function pyTypeName(value) {
    if (value === null || value === undefined)
        return "NoneType";
    if (typeof value === "boolean")
        return "bool";
    if (typeof value === "number")
        return Number.isInteger(value) ? "int" : "float";
    if (typeof value === "string")
        return "str";
    return Array.isArray(value) ? "list" : "dict";
}

/** An exception escaping parse_options(): run_wrapper closes with the traceback, no message. */
function internalError(line, code, exception) {
    const site = "/usr/lib/python3.9/site-packages/cockpit";
    return {
        problem: "internal-error",
        cause: "Traceback (most recent call last):\n" +
            `  File "${site}/channel.py", line 519, in run_wrapper\n    self.close(await self.run(options))\n` +
            `  File "${site}/channels/metrics.py", line 162, in run\n    self.parse_options(options)\n` +
            `  File "${site}/channels/metrics.py", line ${line}, in parse_options\n    ${code}\n` +
            `${exception}\n`,
    };
}

function rate(state, value, previous) {
    if (previous === undefined || previous === null || previous === false)
        return false;
    if (value === null || value === false)
        return value;
    return (value - previous) / (state.interval / 1000);
}

function sample(state) {
    const k = state.tick++;
    const row = [];
    for (const metric of state.metrics) {
        const value = sampleAt(metric.desc, k);
        if (metric.desc.instanced) {
            const { names, values } = value;
            if (!metric.lastNames || names.join("\0") !== metric.lastNames.join("\0"))
                state.needMeta = true;
            const previous = metric.last ?? new Map();
            row.push(metric.derive === "rate"
                ? names.map((name, i) => rate(state, values[i], previous.get(name)))
                : [...values]);
            metric.last = new Map(names.map((name, i) => [name, values[i]]));
            metric.lastNames = names;
        } else {
            row.push(metric.derive === "rate" ? rate(state, value, metric.last) : value);
            metric.last = value;
        }
    }

    let reset = false;
    if (state.needMeta) {
        sendMeta(state);
        reset = true;
    }
    const sent = state.compress ? compressRow(state, row, reset) : row;
    writeFrame(state.id, pyJson([sent]));

    schedule(state, state.interval, () => sample(state));
}

function sendMeta(state) {
    const timestamp = performance.timeOrigin + performance.now();
    sendJson(state.id, {
        source: "internal",
        interval: state.interval,
        timestamp,
        now: Math.floor(Date.now() / 1000) * 1000,
        metrics: state.metrics.map(({ desc, derive, lastNames }) => desc.instanced
            ? { name: desc.name, units: desc.units, instances: [...lastNames], semantics: desc.semantics }
            : { name: desc.name, derive, units: desc.units, semantics: desc.semantics }),
    });
    state.needMeta = false;
}

/*
 * The C bridge's interframe compression (cockpitmetrics.c): only values that
 * differ from the previous row are present; gaps are null, trailing
 * unchanged values are omitted. After a meta message everything is sent.
 */
function compressRow(state, row, reset) {
    const previous = state.previousRow;
    state.previousRow = row;
    if (reset || !previous)
        return row;

    const out = [];
    const put = (array, index, value) => {
        while (array.length < index)
            array.push(null);
        array.push(value);
    };
    row.forEach((value, i) => {
        if (Array.isArray(value)) {
            const changed = [];
            value.forEach((v, j) => {
                if (v !== previous[i][j])
                    put(changed, j, v);
            });
            put(out, i, changed); // instanced metrics are always present
        } else if (value !== previous[i]) {
            put(out, i, value);
        }
    });
    return out;
}
