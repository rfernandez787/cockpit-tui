/*
 * NetworkManager's objects, read once and then kept current by signals; each
 * connection's settings; what every interface sends and receives; and the
 * firewall's state.
 * Upstream: pkg/networkmanager/interfaces.js, firewall-client.js (cockpit 356).
 *
 * NetworkManager's ObjectManager is at /org/freedesktop, one level above its
 * own objects, so its InterfacesAdded/Removed do not fall under the
 * namespace its PropertiesChanged do. Three match rules, none overlapping
 * another (the bridge delivers a signal once per matching rule and cannot
 * remove a rule): the ObjectManager's, PropertiesChanged under
 * /org/freedesktop/NetworkManager, and Settings.Connection's own signals
 * (Updated: a connection's settings changed, which no property says).
 *
 * Signals that arrive while a read is in flight are applied again over its
 * reply; see storage/store.ts for why.
 *
 * Traffic is the bridge's own sampler, metrics1 "network.interface.rx" and
 * ".tx" as rates, by interface name -- what upstream falls back to without
 * PCP. The plots add up the interfaces the page lists: the loopback and the
 * ports of a bridge or bond would count the same bytes again.
 *
 * The firewall is firewalld, and whether it is on is its systemd unit's
 * state: firewalld itself tells an unprivileged caller its zones but not its
 * state. Its unit's PropertiesChanged need a Subscribe() on systemd, as on
 * the Services page.
 */
import cockpit from "../../cockpit.js";
import type { DBusClient } from "../../tui/hooks.js";
import { errorText } from "../../tui/status.js";
import { Decompressor } from "../../lib/metrics.js";
import { parseManagedObjects, plainProps, type Interfaces } from "../../lib/objects.js";
import { buildInterfaces, I, NM, NM_PATH, NO_FIREWALL, parseActiveZones, ROOT, type Firewall, type Settings } from "./model.js";

const OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager";
const PROPERTIES = "org.freedesktop.DBus.Properties";
const SYSTEMD = "org.freedesktop.systemd1";
const FIREWALLD = "org.fedoraproject.FirewallD1";
const FIREWALLD_PATH = "/org/fedoraproject/FirewallD1";
export const FIREWALL_UNIT = "firewalld.service";

/** Upstream's client: the system bus, privileged once administrative access is on. */
export const CLIENT_OPTIONS = { bus: "system", superuser: "try" } as const;

export type StoreStatus = "loading" | "ready" | "absent" | "error";

/** Bytes per second an interface receives and sends. */
export interface Traffic {
    readonly rx: number;
    readonly tx: number;
}

/** What the listed interfaces together send and receive, in bits per second, over the last while. */
export interface Throughput {
    readonly rx: number | null;
    readonly tx: number | null;
    readonly rxHistory: readonly number[];
    readonly txHistory: readonly number[];
    /** When each sample was taken (milliseconds, this machine's clock). */
    readonly times: readonly number[];
}

export const HISTORY = 240;
const NO_THROUGHPUT: Throughput = { rx: null, tx: null, rxHistory: [], txHistory: [], times: [] };

export interface StoreTimings {
    readonly rereadMs: number;
    readonly repaintMs: number;
    /** How often traffic is sampled: one column of the plots. */
    readonly trafficMs: number;
}

export const DEFAULT_TIMINGS: StoreTimings = { rereadMs: 200, repaintMs: 100, trafficMs: 2000 };

/** What the page's own store is made with; tests shorten the sampling. */
export const storeSettings: { timings: Partial<StoreTimings> } = { timings: {} };

type MutableObjects = Map<string, Record<string, Record<string, unknown>>>;
type Signal = readonly [path: string, iface: string, member: string, args: unknown[]];

/** NetworkManager's own objects, less the checkpoints an action makes while it runs. */
function wanted(path: string): boolean {
    return path.startsWith(NM_PATH) && !path.startsWith(`${NM_PATH}/Checkpoint/`);
}

export class NetworkStore {
    readonly client: DBusClient;
    readonly timings: StoreTimings;

    /** Replaced, never mutated: safe to memoize on. */
    objects: ReadonlyMap<string, Interfaces> = new Map();
    /** Each connection's settings, by its object path; replaced with every change. */
    settings: ReadonlyMap<string, Settings> = new Map();
    /** By interface name; replaced with every sample. */
    traffic: ReadonlyMap<string, Traffic> = new Map();
    throughput: Throughput = NO_THROUGHPUT;
    firewall: Firewall = NO_FIREWALL;
    warning: string | null = null;
    version = 0;

    #objects: MutableObjects = new Map();
    #settings = new Map<string, Settings>();
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
    #systemd: DBusClient | null = null;
    #firewalld: DBusClient | null = null;
    #firewallUnit: string | null = null;
    #firewallGeneration = 0;

    constructor(timings: Partial<StoreTimings> = {}) {
        this.timings = { ...DEFAULT_TIMINGS, ...storeSettings.timings, ...timings };
        this.client = cockpit.dbus(NM, { ...CLIENT_OPTIONS });
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

    get nmVersion(): string {
        const version = this.objects.get(NM_PATH)?.[I.manager]?.Version;
        return typeof version === "string" ? version : "";
    }

    readonly subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };

    readonly getVersion = (): number => this.version;

    /** The rules first, then the read: nothing that happens after the read can be missed. */
    start(): void {
        const take = (path: string, iface: string, member: string, args: unknown[]) => {
            if (this.#closed)
                return;
            try {
                const signal: Signal = [path, iface, member, Array.isArray(args) ? args : []];
                if (this.#reading > 0)
                    this.#pending.push(signal);
                this.#apply(signal);
            } catch (error) {
                console.error("networking: signal handler failed:", error);
            }
        };
        this.client.subscribe({ path: ROOT, interface: OBJECT_MANAGER }, take);
        this.client.subscribe({ path_namespace: NM_PATH, interface: PROPERTIES }, take);
        this.client.subscribe({ path_namespace: NM_PATH, interface: I.settings }, take);
        this.client.addEventListener("close", ((_event: unknown, options: { problem?: string, message?: string } | undefined) => {
            if (this.#closed)
                return;
            if (options?.problem === "not-found") {
                this.#absent = true;
            } else {
                const reason = options?.message || (options?.problem ? cockpit.message(options.problem) : "disconnected");
                this.#error = this.#loaded ? `The connection to NetworkManager closed: ${reason}` : `Connecting to NetworkManager failed: ${reason}`;
            }
            this.#changed();
        }) as never);
        this.#startTraffic();
        void this.#read();
        void this.#startFirewall();
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
        this.#systemd?.close();
        this.#firewalld?.close();
        this.client.close();
    }

    /** Read everything again: Ctrl+R, and the way out of a failed first read. */
    reread(): void {
        if (this.#closed || this.#absent)
            return;
        void this.#read();
        void this.refreshFirewall();
    }

    async #read(): Promise<void> {
        const generation = ++this.#generation;
        this.#reading++;
        try {
            const [reply] = await Promise.resolve(this.client.call(ROOT, OBJECT_MANAGER, "GetManagedObjects", [], { type: "" }));
            if (this.#closed || generation !== this.#generation)
                return;
            this.#objects = new Map([...parseManagedObjects(reply)].filter(([path]) => wanted(path)));
            for (const signal of this.#pending)
                this.#apply(signal, true);
            this.#loaded = true;
            this.#error = null;
            this.warning = null;
            this.#publish();
            // Every connection's settings, and none of those that are gone.
            for (const path of [...this.#settings.keys()])
                if (!this.#objects.get(path)?.[I.settings])
                    this.#settings.delete(path);
            for (const [path, interfaces] of this.#objects)
                if (interfaces[I.settings])
                    void this.#readSettings(path);
        } catch (error) {
            if (this.#closed || generation !== this.#generation)
                return;
            if ((error as { problem?: unknown } | null)?.problem === "not-found")
                this.#absent = true;
            else if (this.#loaded)
                this.warning = `Refreshing failed: ${errorText(error)}`;
            else
                this.#error = `Reading the network interfaces failed: ${errorText(error)}`;
            this.#changed();
        } finally {
            this.#reading--;
            if (this.#reading === 0)
                this.#pending = [];
        }
    }

    /** GetSettings: without secrets, by NetworkManager's design. */
    async #readSettings(path: string): Promise<void> {
        try {
            const [reply] = await Promise.resolve(this.client.call(path, I.settings, "GetSettings", [], { type: "" }));
            if (this.#closed || !this.#objects.get(path)?.[I.settings])
                return;
            if (reply && typeof reply === "object" && !Array.isArray(reply)) {
                this.#settings.set(path, reply as Settings);
                this.settings = new Map(this.#settings);
                this.#changed();
            }
        } catch (error) {
            // Not ours to read (another user's connection), or gone meanwhile.
            console.warn(`networking: reading the settings of ${path} failed:`, errorText(error));
        }
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
            if (typeof object !== "string" || !wanted(object) || !interfaces || typeof interfaces !== "object")
                return;
            const entry = { ...(this.#objects.get(object) ?? {}) };
            for (const [name, props] of Object.entries(interfaces))
                entry[name] = plainProps(props);
            this.#objects.set(object, entry);
            if (!replay && entry[I.settings])
                void this.#readSettings(object);
        } else if (iface === OBJECT_MANAGER && member === "InterfacesRemoved") {
            const [object, names] = args;
            const current = typeof object === "string" ? this.#objects.get(object) : undefined;
            if (typeof object !== "string" || !current || !Array.isArray(names))
                return;
            const entry = { ...current };
            for (const name of names)
                if (typeof name === "string")
                    delete entry[name];
            if (Object.keys(entry).some(name => name.startsWith(NM)))
                this.#objects.set(object, entry);
            else
                this.#objects.delete(object);
            if (!entry[I.settings] && this.#settings.delete(object))
                this.settings = new Map(this.#settings);
        } else if (iface === PROPERTIES && member === "PropertiesChanged") {
            const [name, changed, invalidated] = args;
            const current = this.#objects.get(path);
            if (typeof name !== "string" || !current?.[name])
                return;
            this.#objects.set(path, { ...current, [name]: { ...current[name], ...plainProps(changed) } });
            if (!replay && Array.isArray(invalidated) && invalidated.length)
                this.#scheduleReread();
        } else if (iface === I.settings && member === "Updated") {
            if (!replay)
                void this.#readSettings(path);
            return;
        } else {
            return;
        }
        if (!replay && this.#loaded)
            this.#publish();
    }

    #publish(): void {
        this.objects = new Map(this.#objects);
        this.#changed();
    }

    // ---- traffic ---------------------------------------------------------------------

    #startTraffic(): void {
        const decompressor = new Decompressor();
        const channel = cockpit.channel({
            payload: "metrics1",
            source: "internal",
            interval: this.timings.trafficMs,
            metrics: [
                { name: "network.interface.rx", units: "bytes", derive: "rate" },
                { name: "network.interface.tx", units: "bytes", derive: "rate" },
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
                const rates = (index: number): Map<string, number> => {
                    const out = new Map<string, number>();
                    const values = sample[index];
                    metrics[index]?.instances?.forEach((name, i) => {
                        const value = Array.isArray(values) ? values[i] : undefined;
                        // `false` is a rate's first sample; a reset counter reads negative once.
                        if (typeof value === "number")
                            out.set(name, Math.max(0, value));
                    });
                    return out;
                };
                const rx = rates(0);
                const tx = rates(1);
                if (rx.size === 0 && tx.size === 0)
                    return;
                const traffic = new Map<string, Traffic>();
                for (const name of new Set([...rx.keys(), ...tx.keys()]))
                    traffic.set(name, { rx: rx.get(name) ?? 0, tx: tx.get(name) ?? 0 });
                this.traffic = traffic;
                // The plots: the interfaces the page lists, once they are known; until then, all but the loopback.
                const lists = this.#loaded ? buildInterfaces(this.#objects) : null;
                const listed = lists ? new Set([...lists.managed, ...lists.unmanaged].map(iface => iface.name)) : null;
                let rxTotal = 0;
                let txTotal = 0;
                for (const [name, rate] of traffic) {
                    if (listed ? !listed.has(name) : name === "lo")
                        continue;
                    rxTotal += rate.rx * 8;
                    txTotal += rate.tx * 8;
                }
                const previous = this.throughput;
                this.throughput = {
                    rx: rxTotal, tx: txTotal,
                    rxHistory: [...previous.rxHistory, rxTotal].slice(-HISTORY),
                    txHistory: [...previous.txHistory, txTotal].slice(-HISTORY),
                    times: [...previous.times, Date.now()].slice(-HISTORY),
                };
                this.#changed();
            } catch (error) {
                console.error("networking: traffic sample failed:", error);
            }
        });
        this.#metrics = { close: () => channel.close() };
    }

    // ---- the firewall ----------------------------------------------------------------

    async #startFirewall(): Promise<void> {
        const systemd = cockpit.dbus(SYSTEMD, { ...CLIENT_OPTIONS });
        this.#systemd = systemd;
        try {
            // Signals flow only to subscribed connections; already subscribed is fine.
            await Promise.resolve(systemd.call("/org/freedesktop/systemd1", `${SYSTEMD}.Manager`, "Subscribe", [], { type: "" })).catch(() => {});
            const [unit] = await Promise.resolve(systemd.call("/org/freedesktop/systemd1", `${SYSTEMD}.Manager`, "LoadUnit", [FIREWALL_UNIT], { type: "s" }));
            if (this.#closed || typeof unit !== "string")
                return;
            this.#firewallUnit = unit;
            systemd.subscribe({ path: unit, interface: PROPERTIES, member: "PropertiesChanged" }, () => {
                if (!this.#closed)
                    void this.refreshFirewall();
            });
        } catch (error) {
            // No systemd to ask (a container): the firewall is just not shown.
            console.warn("networking: asking systemd about firewalld failed:", errorText(error));
            return;
        }
        await this.refreshFirewall();
    }

    /** Read the firewall's state again: after its unit changed, and after switching it here. */
    async refreshFirewall(): Promise<void> {
        const systemd = this.#systemd;
        const unit = this.#firewallUnit;
        if (this.#closed || !systemd || !unit)
            return;
        const generation = ++this.#firewallGeneration;
        let next: Firewall = NO_FIREWALL;
        try {
            const [props] = await Promise.resolve(systemd.call(unit, PROPERTIES, "GetAll", [`${SYSTEMD}.Unit`], { type: "s" }));
            const p = plainProps(props);
            const installed = p.LoadState === "loaded";
            const active = p.ActiveState === "active" || p.ActiveState === "reloading";
            next = { installed, active, enabled: p.UnitFileState === "enabled" || p.UnitFileState === "enabled-runtime", defaultZone: null, zones: [] };
            if (installed && active) {
                // A client per read: one opened while firewalld was off stays dead (firewall-client.js's HACK).
                this.#firewalld?.close();
                const firewalld = cockpit.dbus(FIREWALLD, { ...CLIENT_OPTIONS });
                this.#firewalld = firewalld;
                const [zone, zones] = await Promise.all([
                    Promise.resolve(firewalld.call(FIREWALLD_PATH, FIREWALLD, "getDefaultZone", [], { type: "" })).then(r => r[0], () => null),
                    Promise.resolve(firewalld.call(FIREWALLD_PATH, `${FIREWALLD}.zone`, "getActiveZones", [], { type: "" })).then(r => r[0], () => null),
                ]);
                next = { ...next, defaultZone: typeof zone === "string" ? zone : null, zones: parseActiveZones(zones) };
            }
        } catch (error) {
            console.warn("networking: reading firewalld's state failed:", errorText(error));
        }
        if (this.#closed || generation !== this.#firewallGeneration)
            return;
        this.firewall = next;
        this.#changed();
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
                    console.error("networking: store listener failed:", error);
                }
            }
        }, wait);
    }
}
