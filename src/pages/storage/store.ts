/*
 * UDisks2's objects, read once and then kept current by signals.
 * Upstream: pkg/storaged/client.js (cockpit 356).
 *
 * Upstream opens a proxies() set per interface over one namespace watch. Here
 * it is one GetManagedObjects and one match rule on the whole namespace,
 * which carries all three signals that change the tree:
 *
 *   ObjectManager.InterfacesAdded / InterfacesRemoved   devices come and go
 *   Properties.PropertiesChanged                        a mount, an unlock, a format
 *
 * One rule, because the bridge delivers a signal once per matching rule and
 * cannot remove a rule again. A PropertiesChanged that only invalidates
 * (names a property without its value) is answered with a fresh
 * GetManagedObjects, debounced.
 *
 * Ordering. cockpit.js runs a reply's continuation after the signals that
 * arrived behind it (see services/store.ts), so signals received while a
 * read is in flight are kept and applied again over its reply: they are
 * newer than it, or already contained in it, and either way end at the
 * latest state.
 *
 * Filesystem usage comes from the bridge's own sampler, as upstream's
 * client.fsys_sizes does: metrics1 "mount.used" and "mount.total", by mount
 * point.
 *
 * Throughput, for the two plots (upstream's plot.jsx): the same sampler's
 * "disk.dev.read" and "disk.dev.written" as rates, by kernel device name.
 * Only whole drives are added up -- their partitions and the device-mapper
 * devices on top of them would count the same bytes again.
 */
import cockpit from "../../cockpit.js";
import type { DBusClient } from "../../tui/hooks.js";
import { errorText } from "../../tui/status.js";
import { Decompressor } from "../../lib/metrics.js";
import { decodeFilename, I, MANAGER_PATH, parseManagedObjects, plainProps, ROOT, UDISKS, type Interfaces, type Usage } from "./model.js";

const OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager";
const PROPERTIES = "org.freedesktop.DBus.Properties";

/** Upstream's client: the system bus, privileged once administrative access is on. */
export const CLIENT_OPTIONS = { bus: "system", superuser: "try" } as const;

export type StoreStatus = "loading" | "ready" | "absent" | "error";

/** Bytes per second read from and written to the drives, and how that went over the last while. */
export interface Throughput {
    /** Null until the first rate is in (a rate needs two samples). */
    readonly read: number | null;
    readonly write: number | null;
    /** Oldest first; at most HISTORY samples. */
    readonly readHistory: readonly number[];
    readonly writeHistory: readonly number[];
    /** When each sample was taken (milliseconds, this machine's clock), for the plots' time axis. */
    readonly times: readonly number[];
}

/** Samples kept for the plots: as many columns as a wide terminal shows. */
export const HISTORY = 240;

const NO_THROUGHPUT: Throughput = { read: null, write: null, readHistory: [], writeHistory: [], times: [] };

export interface StoreTimings {
    /** Quiet period before re-reading everything after an invalidation. */
    readonly rereadMs: number;
    /** How often throughput is sampled: one column of the plots. */
    readonly throughputMs: number;
    /** Repaint at most this often. */
    readonly repaintMs: number;
    /** How often filesystem usage is sampled. */
    readonly usageMs: number;
}

export const DEFAULT_TIMINGS: StoreTimings = { rereadMs: 200, repaintMs: 100, usageMs: 5000, throughputMs: 2000 };

/** What the page's own store is made with; tests shorten the sampling. */
export const storeSettings: { timings: Partial<StoreTimings> } = { timings: {} };

type MutableObjects = Map<string, Record<string, Record<string, unknown>>>;
type Signal = readonly [path: string, iface: string, member: string, args: unknown[]];

export class StorageStore {
    readonly client: DBusClient;
    readonly timings: StoreTimings;

    /** Every object under /org/freedesktop/UDisks2. Replaced, never mutated: safe to memoize on. */
    objects: ReadonlyMap<string, Interfaces> = new Map();
    /** Used and total bytes by mount point. */
    usage: ReadonlyMap<string, Usage> = new Map();
    /** Replaced with every sample, never mutated. */
    throughput: Throughput = NO_THROUGHPUT;
    /** A later re-read failed; what is shown is the last good state. */
    warning: string | null = null;
    /** Changes on every repaint; what React subscribes to. */
    version = 0;

    #objects: MutableObjects = new Map();
    #closed = false;
    #loaded = false;
    #error: string | null = null;
    #absent = false;
    #listeners = new Set<() => void>();
    #repaintTimer: NodeJS.Timeout | null = null;
    #lastRepaint = 0;
    #rereadTimer: NodeJS.Timeout | null = null;
    #reading = 0;
    #pending: Signal[] = [];
    #generation = 0;
    #metrics: { close(): void } | null = null;
    #throughputChannel: { close(): void } | null = null;

    constructor(timings: Partial<StoreTimings> = {}) {
        this.timings = { ...DEFAULT_TIMINGS, ...storeSettings.timings, ...timings };
        this.client = cockpit.dbus(UDISKS, { ...CLIENT_OPTIONS });
    }

    get status(): StoreStatus {
        if (this.#absent)
            return "absent";
        if (this.#error !== null)
            return "error";
        return this.#loaded ? "ready" : "loading";
    }

    get error(): string | null {
        return this.#error;
    }

    get closed(): boolean {
        return this.#closed;
    }

    /** UDisks2's version, once known. */
    get udisksVersion(): string {
        const version = this.objects.get(MANAGER_PATH)?.[I.manager]?.Version;
        return typeof version === "string" ? version : "";
    }

    /** The rule first, then the read: nothing that happens after the read can be missed. */
    start(): void {
        this.client.subscribe({ path_namespace: ROOT }, (path, iface, member, args) => {
            if (this.#closed)
                return;
            try {
                const signal: Signal = [path, iface, member, Array.isArray(args) ? args : []];
                if (this.#reading > 0)
                    this.#pending.push(signal);
                this.#apply(signal);
            } catch (error) {
                console.error("storage: signal handler failed:", error);
            }
        });
        this.client.addEventListener("close", ((_event: unknown, options: { problem?: string, message?: string } | undefined) => {
            if (this.#closed)
                return;
            // Nothing owns the name: UDisks2 is not installed (it is bus-activated where it is).
            if (options?.problem === "not-found") {
                this.#absent = true;
            } else {
                const reason = options?.message || (options?.problem ? cockpit.message(options.problem) : "disconnected");
                this.#error = this.#loaded ? `The connection to UDisks2 closed: ${reason}` : `Connecting to UDisks2 failed: ${reason}`;
            }
            this.#changed();
        }) as never);
        this.#startUsage();
        this.#startThroughput();
        void this.#read().then(() => this.#enableLvm2());
    }

    close(): void {
        if (this.#closed)
            return;
        this.#closed = true;
        for (const timer of [this.#repaintTimer, this.#rereadTimer])
            if (timer)
                clearTimeout(timer);
        this.#listeners.clear();
        this.#metrics?.close();
        this.#throughputChannel?.close();
        this.client.close();
    }

    /** Read everything again: Ctrl+R, and the way out of a failed first read. */
    reread(): void {
        if (this.#closed || this.#absent)
            return;
        void this.#read();
    }

    /** For useSyncExternalStore. */
    readonly subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };

    readonly getVersion = (): number => this.version;

    async #read(): Promise<void> {
        const generation = ++this.#generation;
        this.#reading++;
        try {
            // A native promise before anything is chained: see services/store.ts.
            const [reply] = await Promise.resolve(this.client.call(ROOT, OBJECT_MANAGER, "GetManagedObjects", [], { type: "" }));
            if (this.#closed || generation !== this.#generation)
                return;
            this.#objects = parseManagedObjects(reply);
            for (const signal of this.#pending)
                this.#apply(signal, true);
            this.#loaded = true;
            this.#error = null;
            this.warning = null;
            this.#publish();
        } catch (error) {
            if (this.#closed || generation !== this.#generation)
                return;
            // A closed channel is reported by its close event, with a better reason.
            if ((error as { problem?: unknown } | null)?.problem === "not-found") {
                this.#absent = true;
            } else if (this.#loaded) {
                this.warning = `Refreshing failed: ${errorText(error)}`;
            } else {
                this.#error = `Reading the storage devices failed: ${errorText(error)}`;
            }
            this.#changed();
        } finally {
            this.#reading--;
            if (this.#reading === 0)
                this.#pending = [];
        }
    }

    /**
     * Volume groups and logical volumes only exist as objects once UDisks2's
     * lvm2 module is loaded; upstream asks for it on every page load
     * (client.js enable_udisks_features). Asked only when it is not there
     * already, and a refusal (limited access) just means no LVM rows -- and
     * one warning in the diagnostic log per visit. That refusal has not been
     * seen on a real host: the ones tried had the module loaded.
     */
    async #enableLvm2(): Promise<void> {
        const manager = this.objects.get(MANAGER_PATH);
        if (this.#closed || !this.#loaded || !manager || manager[I.managerLvm2])
            return;
        try {
            await Promise.resolve(this.client.call(MANAGER_PATH, I.manager, "EnableModule", ["lvm2", true], { type: "sb" }));
        } catch (error) {
            console.warn("storage: can't enable the UDisks2 lvm2 module:", errorText(error));
            return;
        }
        // The module's objects are announced by signals, but older UDisks2
        // versions fill them in late: read once more.
        this.#scheduleReread();
    }

    #scheduleReread(): void {
        if (this.#closed || this.#rereadTimer)
            return;
        this.#rereadTimer = setTimeout(() => {
            this.#rereadTimer = null;
            void this.#read();
        }, this.timings.rereadMs);
    }

    #apply(signal: Signal, replay = false): void {
        const [path, iface, member, args] = signal;
        if (iface === OBJECT_MANAGER && member === "InterfacesAdded") {
            const [object, interfaces] = args;
            if (typeof object !== "string" || !interfaces || typeof interfaces !== "object")
                return;
            const entry = { ...(this.#objects.get(object) ?? {}) };
            for (const [name, props] of Object.entries(interfaces))
                entry[name] = plainProps(props);
            this.#objects.set(object, entry);
        } else if (iface === OBJECT_MANAGER && member === "InterfacesRemoved") {
            const [object, names] = args;
            const current = typeof object === "string" ? this.#objects.get(object) : undefined;
            if (typeof object !== "string" || !current || !Array.isArray(names))
                return;
            const entry = { ...current };
            for (const name of names)
                if (typeof name === "string")
                    delete entry[name];
            // GDBus objects always carry the standard interfaces; ours are the UDisks2 ones.
            if (Object.keys(entry).some(name => name.startsWith(UDISKS)))
                this.#objects.set(object, entry);
            else
                this.#objects.delete(object);
        } else if (iface === PROPERTIES && member === "PropertiesChanged") {
            const [name, changed, invalidated] = args;
            const current = this.#objects.get(path);
            if (typeof name !== "string" || !current?.[name])
                return;
            this.#objects.set(path, { ...current, [name]: { ...current[name], ...plainProps(changed) } });
            if (!replay && Array.isArray(invalidated) && invalidated.length)
                this.#scheduleReread();
        } else {
            return;
        }
        if (!replay && this.#loaded)
            this.#publish();
    }

    /** Hand React a new map (rows are memoized on it) and repaint. */
    #publish(): void {
        this.objects = new Map(this.#objects);
        this.#changed();
    }

    #startUsage(): void {
        const decompressor = new Decompressor();
        const channel = cockpit.channel({
            payload: "metrics1",
            source: "internal",
            interval: this.timings.usageMs,
            metrics: [{ name: "mount.used" }, { name: "mount.total" }],
        });
        channel.addEventListener("message", (_event, data) => {
            if (this.#closed)
                return;
            try {
                const sample = decompressor.push(JSON.parse(data)).at(-1);
                const instances = decompressor.meta?.metrics[0]?.instances;
                if (!sample || !instances)
                    return;
                const [used, total] = sample;
                const usage = new Map<string, Usage>();
                instances.forEach((mountPoint, i) => {
                    const u = Array.isArray(used) ? used[i] : undefined;
                    const t = Array.isArray(total) ? total[i] : undefined;
                    if (typeof u === "number" && typeof t === "number")
                        usage.set(mountPoint, { used: u, total: t });
                });
                const same = usage.size === this.usage.size && [...usage].every(([mountPoint, value]) => {
                    const old = this.usage.get(mountPoint);
                    return old && old.used === value.used && old.total === value.total;
                });
                if (!same) {
                    this.usage = usage;
                    this.#changed();
                }
            } catch (error) {
                console.error("storage: usage sample failed:", error);
            }
        });
        // An old bridge without these metrics closes the channel: usage is then just not shown.
        this.#metrics = { close: () => channel.close() };
    }

    /** The kernel names of whole drives ("sda", "nvme0n1"): what the plots add up. Null while none is known. */
    #driveDevices(): Set<string> | null {
        const names = new Set<string>();
        for (const interfaces of this.#objects.values()) {
            const block = interfaces[I.block];
            if (!block || interfaces[I.partition] || typeof block.Drive !== "string" || block.Drive === "/")
                continue;
            const device = decodeFilename(block.Device);
            if (device.startsWith("/dev/"))
                names.add(device.slice(5));
        }
        return names.size ? names : null;
    }

    #startThroughput(): void {
        const decompressor = new Decompressor();
        const channel = cockpit.channel({
            payload: "metrics1",
            source: "internal",
            interval: this.timings.throughputMs,
            metrics: [
                { name: "disk.dev.read", units: "bytes", derive: "rate" },
                { name: "disk.dev.written", units: "bytes", derive: "rate" },
            ],
        });
        channel.addEventListener("message", (_event, data) => {
            if (this.#closed)
                return;
            try {
                const sample = decompressor.push(JSON.parse(data)).at(-1);
                const metrics = decompressor.meta?.metrics;
                if (!sample || !metrics)
                    return;
                const drives = this.#driveDevices();
                const total = (index: number): number | null => {
                    const instances = metrics[index]?.instances;
                    const values = sample[index];
                    if (!instances || !Array.isArray(values))
                        return null;
                    let sum = 0;
                    let seen = false;
                    instances.forEach((name, i) => {
                        const value = values[i];
                        // `false` is a rate's first sample: not a figure yet.
                        if (typeof value !== "number" || (drives && !drives.has(name)))
                            return;
                        seen = true;
                        // A counter that was reset reads as a negative rate for one sample.
                        sum += Math.max(0, value);
                    });
                    return seen ? sum : null;
                };
                const read = total(0);
                const write = total(1);
                if (read === null || write === null)
                    return;
                const previous = this.throughput;
                this.throughput = {
                    read, write,
                    readHistory: [...previous.readHistory, read].slice(-HISTORY),
                    writeHistory: [...previous.writeHistory, write].slice(-HISTORY),
                    times: [...previous.times, Date.now()].slice(-HISTORY),
                };
                this.#changed();
            } catch (error) {
                console.error("storage: throughput sample failed:", error);
            }
        });
        // A bridge without these metrics closes the channel: the plots then stay empty.
        this.#throughputChannel = { close: () => channel.close() };
    }

    /** Schedule a repaint, at most one per `repaintMs`. */
    #changed(): void {
        if (this.#closed || this.#repaintTimer)
            return;
        const wait = Math.max(0, this.#lastRepaint + this.timings.repaintMs - Date.now());
        this.#repaintTimer = setTimeout(() => {
            this.#repaintTimer = null;
            this.#lastRepaint = Date.now();
            this.version += 1;
            for (const listener of [...this.#listeners]) {
                try {
                    listener();
                } catch (error) {
                    console.error("storage: store listener failed:", error);
                }
            }
        }, wait);
    }
}
