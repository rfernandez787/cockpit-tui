/*
 * One systemd manager (the system's, or the user's own), listed once and then
 * kept current by signals.
 *
 * systemd is the noisiest thing on the bus. One idle service exiting was
 * measured at 563 signals (814 kB of JSON) in 290 ms, so this store never
 * does per-signal I/O and never repaints per signal:
 *
 *  - Two broad match rules, sent once per client and never overlapping (the
 *    bridge delivers one frame per matching rule, and cannot remove a rule
 *    again: remove-match is unimplemented). Everything else -- the details
 *    view included -- subscribes client-side only, `subscribe(match, cb,
 *    false)`, which reaches no further than cockpit.js's own dispatch.
 *  - No proxy(), proxies() or watch: on systemd those cost a Get round trip
 *    per invalidated property per signal, and a namespace watch fails with
 *    AccessDenied while leaking its match.
 *  - A run-state change of a known unit is patched in place. A unit we have
 *    not seen, or one systemd loaded or unloaded (UnitNew/UnitRemoved), goes
 *    into one debounced ListUnitsByPatterns() probe: unlike GetAll on the
 *    unit's path, LoadUnit or ListUnitsByNames, that call does not load
 *    anything, so it cannot set off another UnitNew. A storm collapses to a
 *    handful of distinct names and one call.
 *  - Between Reloading(true) and Reloading(false) every unit is torn down and
 *    re-created: all signals are muted, then the list is re-read once.
 *  - UnitFilesChanged without a daemon-reload (systemctl enable --no-reload)
 *    re-reads only the unit files, once per burst: ListUnitFiles scans the
 *    disk and takes most of a second.
 *  - Repaints are throttled to 10 per second.
 *
 * Ordering. cockpit.js delivers a method reply and the signals after it from
 * one queue drained in a single timer tick, but an awaited reply resumes only
 * in a microtask after that tick -- so a signal that arrived just after a
 * reply reaches us *before* the reply does, and the (older) reply would
 * overwrite it. While a list or probe is in flight, the run-state props of
 * every signal are therefore also kept, merged per unit, and replayed over
 * each reply. Every run-state change is signalled (they are emits-change
 * properties), so the newest signalled value is always the truth.
 *
 * Library promises are wrapped in native ones before anything is chained on
 * them: the vendored Deferred runs its callbacks inside that timer tick,
 * where an exception is fatal rather than a rejection.
 */
import cockpit from "../../cockpit.js";
import { runFull, type DBusClient } from "../../tui/hooks.js";
import { errorText } from "../../tui/status.js";
import {
    exactPattern, idFromPath, pathIsHandled, unitFilesFrom, unitType,
    type LoadedUnit, type Owner, type TimerInfo, type UnitFile,
} from "./model.js";

export const SYSTEMD = "org.freedesktop.systemd1";
export const MANAGER_PATH = "/org/freedesktop/systemd1";
export const MANAGER = "org.freedesktop.systemd1.Manager";
export const PROPERTIES = "org.freedesktop.DBus.Properties";
export const UNIT = "org.freedesktop.systemd1.Unit";
export const TIMER = "org.freedesktop.systemd1.Timer";
export const JOB = "org.freedesktop.systemd1.Job";

/** The broad rules, exactly as sent: nothing else adds a match on a store's client. */
export const UNIT_PROPERTIES_RULE = {
    interface: PROPERTIES, member: "PropertiesChanged", path_namespace: "/org/freedesktop/systemd1/unit",
} as const;
export const MANAGER_RULE = { interface: MANAGER } as const;

/**
 * Upstream's clients (services.jsx:44-47): the system manager with
 * superuser "try" (privileged when administrative access is on), the user's
 * own manager on the session bus as the login user.
 */
export function clientOptions(owner: Owner): cockpit.DBusOptions {
    return owner === "system" ? { bus: "system", superuser: "try" } : { bus: "session" };
}

/**
 * Why a systemd channel closed, in words. "not-found" means nothing owns
 * systemd's name on that bus: no systemd there, or for the user's manager,
 * no user session (no session bus, or no systemd --user).
 */
export function closeReason(owner: Owner, options: { problem?: string | null, message?: string } | undefined): string {
    const problem = options?.problem ?? null;
    if (problem === "not-found")
        return owner === "user" ? "your user session has no systemd (no session bus, or no systemd --user)" : "systemd is not running";
    if (options?.message)
        return options.message;
    return problem ? cockpit.message(problem) : "disconnected";
}

/** Errors Subscribe() returns when this bus connection is already subscribed: harmless. */
export function alreadySubscribed(error: unknown): boolean {
    const name = (error as { name?: unknown } | null)?.name;
    return name === "org.freedesktop.systemd1.AlreadySubscribed" || name === "org.freedesktop.DBus.Error.FileExists";
}

/** Call a systemd method, as a native promise; arguments carry their signature (no introspection). */
export function callManager(client: DBusClient, method: string, args: unknown[], type?: string): Promise<unknown[]> {
    return Promise.resolve(client.call(MANAGER_PATH, MANAGER, method, args, type === undefined ? undefined : { type }));
}

/** Properties.GetAll on a unit (or job) object, as a native promise. */
export async function getAll(client: DBusClient, path: string, iface: string): Promise<Record<string, unknown>> {
    const [props] = await Promise.resolve(client.call(path, PROPERTIES, "GetAll", [iface], { type: "s" }));
    return props && typeof props === "object" ? props as Record<string, unknown> : {};
}

/**
 * CLOCK_REALTIME and CLOCK_MONOTONIC of the host, read together: the only way
 * to put a date on a monotonic timer (OnBootSec=, OnUnitInactiveSec=). No
 * shell tool reads CLOCK_MONOTONIC; upstream does exactly this (python.ts,
 * services.jsx:59-68). Any host with the Python bridge has python3.
 */
export const CLOCKS_ARGV = [
    "sh", "-ec", 'exec $(command -v /usr/libexec/platform-python || command -v python3) -c "$@"', "--",
    "import time; print(int(time.clock_gettime(time.CLOCK_REALTIME) * 1000000), " +
    "int(time.clock_gettime(time.CLOCK_MONOTONIC) * 1000000))",
];

/** Unwrap a D-Bus variant ({t, v}) if it is one. */
function plain(value: unknown): unknown {
    if (value && typeof value === "object" && !Array.isArray(value) && "t" in value && "v" in value)
        return (value as { v: unknown }).v;
    return value;
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** ListUnits()-shaped rows, a(ssssssouso), checked field by field: this is host data. */
export function parseUnitRows(value: unknown): LoadedUnit[] {
    if (!Array.isArray(value))
        return [];
    const units: LoadedUnit[] = [];
    for (const row of value) {
        if (!Array.isArray(row) || row.length < 7)
            continue;
        const [id, description, loadState, activeState, subState, , path] = row as unknown[];
        if (typeof id !== "string" || typeof path !== "string" || !id || !path)
            continue;
        units.push({
            id, path,
            description: text(description),
            loadState: text(loadState),
            activeState: text(activeState),
            subState: text(subState),
        });
    }
    return units;
}

/** ListUnitFiles() rows, a(ss). */
export function parseFileRows(value: unknown): [string, string][] {
    if (!Array.isArray(value))
        return [];
    return value.filter((row): row is [string, string] =>
        Array.isArray(row) && typeof row[0] === "string" && typeof row[1] === "string");
}

export function emptyTimer(): TimerInfo {
    return { lastTrigger: null, nextRealtime: null, nextMonotonic: null };
}

/** Copy the Timer props present in `props` (GetAll or PropertiesChanged) onto `target`. */
export function timerFields(target: Partial<TimerInfo>, props: Record<string, unknown>): void {
    const read = (name: string): number | null | undefined => {
        if (!(name in props))
            return undefined;
        const v = plain(props[name]);
        return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    const last = read("LastTriggerUSec");
    const realtime = read("NextElapseUSecRealtime");
    const monotonic = read("NextElapseUSecMonotonic");
    if (last !== undefined)
        target.lastTrigger = last;
    if (realtime !== undefined)
        target.nextRealtime = realtime;
    if (monotonic !== undefined)
        target.nextMonotonic = monotonic;
}

type UnitPatch = Partial<Pick<LoadedUnit, "activeState" | "subState" | "loadState" | "description">>;

/** The props of a Unit PropertiesChanged that the list shows. Only the run state is ever signalled. */
function unitPatch(changed: Record<string, unknown>): UnitPatch {
    const patch: UnitPatch = {};
    const take = (prop: string, field: keyof UnitPatch) => {
        const v = plain(changed[prop]);
        if (typeof v === "string")
            patch[field] = v;
    };
    take("ActiveState", "activeState");
    take("SubState", "subState");
    take("LoadState", "loadState");
    take("Description", "description");
    return patch;
}

export interface StoreTimings {
    /** Quiet period before probing units that changed. */
    readonly probeQuietMs: number;
    /** Longest a probe is put off while signals keep coming. */
    readonly probeMaxWaitMs: number;
    /** Repaint at most this often. */
    readonly repaintMs: number;
    /** Quiet period before re-reading unit files after UnitFilesChanged. */
    readonly filesQuietMs: number;
    /** Stop waiting for Reloading(false) after this long, and re-list anyway. */
    readonly reloadTimeoutMs: number;
}

export const DEFAULT_TIMINGS: StoreTimings = {
    probeQuietMs: 250,
    probeMaxWaitMs: 1000,
    repaintMs: 100,
    filesQuietMs: 500,
    reloadTimeoutMs: 30_000,
};

/** More names than this in one probe: re-list instead. */
const PROBE_LIMIT = 300;

export type StoreStatus = "loading" | "ready" | "error";

export type SignalHandler = (path: string, iface: string, member: string, args: unknown[]) => void;

export interface SignalMatch {
    readonly path?: string;
    readonly path_namespace?: string;
    readonly interface?: string;
    readonly member?: string;
}

/** A timer's GetAll in flight: the list generation it began in, and what was signalled since. */
interface TimerFetch {
    readonly signalled: Partial<TimerInfo>;
    readonly generation: number;
}

export class UnitStore {
    readonly owner: Owner;
    readonly client: DBusClient;
    readonly timings: StoreTimings;

    /** A later refresh failed; the list shown is the last good one. */
    warning: string | null = null;
    /** systemd is reloading its configuration: the list is frozen until it is done. */
    reloading = false;
    /** Loaded units of the handled types, by object path. */
    readonly units = new Map<string, LoadedUnit>();
    readonly pathById = new Map<string, string>();
    /** Unit files by name; null until listed. */
    files: Map<string, UnitFile> | null = null;
    /** Timer state by object path, once the Timers tab asked for it. */
    readonly timers = new Map<string, TimerInfo>();
    /** realtime - monotonic on the host, in microseconds: dates monotonic timers. */
    monotonicBase: number | null = null;
    /** Changes on every repaint; what React subscribes to. */
    version = 0;

    #closed = false;
    #listeners = new Set<() => void>();
    #repaintTimer: NodeJS.Timeout | null = null;
    #lastRepaint = 0;

    /** Unrecoverable: no signals (Subscribe failed), or the channel closed. */
    #fatal: string | null = null;
    /** The first list failed; cleared by a retry. */
    #listError: string | null = null;
    #loaded = false;

    /** Bumped by every full list; results of an older one are dropped. */
    #listGeneration = 0;
    #listing = false;
    /** Lists and probes in flight; while any is, signalled props are kept for replay. */
    #inflight = 0;
    #patches = new Map<string, UnitPatch>();

    #probeIds = new Set<string>();
    #probeTimer: NodeJS.Timeout | null = null;
    #probeFirstQueued: number | null = null;
    #probing = false;

    #filesTimer: NodeJS.Timeout | null = null;
    #filesWanted = false;
    #reloadTimer: NodeJS.Timeout | null = null;

    #timersWanted = false;
    /** A view dates monotonic timers: the host's clocks are read, and read again on each re-list. */
    #clocksWanted = false;
    /** The list generation the clocks were last read in: a list re-reads them only if they are older. */
    #clocksGeneration = -1;
    /** Timer GetAlls in flight, with what was signalled meanwhile (it wins over the reply). */
    #timerFetches = new Map<string, TimerFetch>();
    /**
     * The list generation each timer was last read in. A daemon-reload
     * changes schedules (an edited OnCalendar=, a new RandomizedDelaySec=
     * roll) without a Timer PropertiesChanged, so every full list reads the
     * timers again.
     */
    #timerRead = new Map<string, number>();
    #timerFailed = new Set<string>();
    #readingClocks = false;

    constructor(owner: Owner, timings: Partial<StoreTimings> = {}) {
        this.owner = owner;
        this.timings = { ...DEFAULT_TIMINGS, ...timings };
        this.client = cockpit.dbus(SYSTEMD, clientOptions(owner));
    }

    get status(): StoreStatus {
        if (this.#fatal !== null || (!this.#loaded && this.#listError !== null))
            return "error";
        return this.#loaded ? "ready" : "loading";
    }

    get error(): string | null {
        return this.#fatal ?? (this.#loaded ? null : this.#listError);
    }

    /** True for an error a retry cannot fix (a new store can). */
    get fatal(): boolean {
        return this.#fatal !== null;
    }

    get closed(): boolean {
        return this.#closed;
    }

    /** A full list is being read (the first, or after a daemon-reload). */
    get listing(): boolean {
        return this.#listing;
    }

    /**
     * Send the rules, subscribe, list -- in this order on the wire, which the
     * bridge and systemd both keep, so nothing that happens after the list
     * was read can be missed.
     */
    start(): void {
        // The only two add-match rules this client ever sends. The store's own
        // handlers ride on them; views add client-side subscribers (onSignal).
        this.client.subscribe(UNIT_PROPERTIES_RULE, this.#guard((path, _iface, _member, args) =>
            this.#onPropertiesChanged(path, args)));
        this.client.subscribe(MANAGER_RULE, this.#guard((_path, _iface, member, args) =>
            this.#onManager(member, args)));
        this.client.addEventListener("close", ((_event: unknown, options: { problem?: string, message?: string } | undefined) => {
            if (this.#closed)
                return;
            const reason = closeReason(this.owner, options);
            this.#fatal = this.#loaded ? `The connection to systemd closed: ${reason}` : `Connecting to systemd failed: ${reason}`;
            this.#changed();
        }) as never);

        callManager(this.client, "Subscribe", []).catch((error: unknown) => {
            if (this.#closed || alreadySubscribed(error))
                return;
            // A channel problem (no such bus, no systemd on it) says more than "subscribing failed".
            const problem = (error as { problem?: unknown }).problem;
            this.#fatal ??= problem
                ? `Connecting to systemd failed: ${errorText(error)}`
                : `Subscribing to systemd signals failed: ${errorText(error)}`;
            this.#changed();
        });
        this.relist();
    }

    close(): void {
        if (this.#closed)
            return;
        this.#closed = true;
        for (const timer of [this.#repaintTimer, this.#probeTimer, this.#filesTimer, this.#reloadTimer])
            if (timer)
                clearTimeout(timer);
        this.#listeners.clear();
        this.client.close();
    }

    /** For useSyncExternalStore. */
    readonly subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };

    readonly getVersion = (): number => this.version;

    /**
     * A client-side subscription on this store's client: no add-match goes to
     * the bridge, so per-view subscriptions cannot pile up there. It sees what
     * the two broad rules let through. The handler is exception-guarded:
     * cockpit.js runs it from a timer, where a throw would be fatal.
     */
    onSignal(match: SignalMatch, handler: SignalHandler): { remove(): void } {
        return this.client.subscribe({ ...match }, this.#guard(handler), false);
    }

    #guard(handler: SignalHandler): SignalHandler {
        return (path, iface, member, args) => {
            if (this.#closed)
                return;
            try {
                handler(path, iface, member, Array.isArray(args) ? args : []);
            } catch (error) {
                console.error("services: signal handler failed:", error);
            }
        };
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
                    console.error("services: store listener failed:", error);
                }
            }
        }, wait);
    }

    // ---- listing -----------------------------------------------------------------

    /** Re-read everything: ListUnits() and ListUnitFiles(), together. */
    relist(): void {
        if (this.#closed || this.#fatal !== null)
            return;
        const generation = ++this.#listGeneration;
        this.#listing = true;
        this.#inflight += 1;
        this.#listError = null;
        // This list reads the unit files too; a refresh asked for before it is moot.
        if (this.#filesTimer)
            clearTimeout(this.#filesTimer);
        this.#filesTimer = null;
        this.#filesWanted = false;
        this.#changed();

        Promise.all([callManager(this.client, "ListUnits", []), callManager(this.client, "ListUnitFiles", [])])
            .then(([[units], [files]]) => {
                if (this.#closed || generation !== this.#listGeneration)
                    return;
                this.units.clear();
                this.pathById.clear();
                for (const unit of parseUnitRows(units)) {
                    if (unitType(unit.id))
                        this.#put(unit);
                }
                this.files = unitFilesFrom(parseFileRows(files));
                // Timers no longer loaded: what was read of them is of a previous life.
                for (const path of new Set([...this.timers.keys(), ...this.#timerFetches.keys()])) {
                    if (!this.units.has(path))
                        this.#forgetTimer(path);
                }
                this.#replay();
                this.#loaded = true;
                this.warning = null;
                this.#timerFailed.clear();
                if (this.#clocksWanted && this.#clocksGeneration !== generation)
                    this.#readClocks();
                this.#fetchTimers();
            }, (error: unknown) => {
                if (this.#closed || generation !== this.#listGeneration)
                    return;
                if (this.#loaded)
                    this.warning = `Refreshing the unit list failed: ${errorText(error)}`;
                else
                    this.#listError = `Listing units failed: ${errorText(error)}`;
            })
            .finally(() => {
                this.#settle();
                if (generation !== this.#listGeneration || this.#closed)
                    return;
                this.#listing = false;
                this.#changed();
                // Work held back while the list was being read.
                if (this.#probeIds.size)
                    this.#scheduleProbe();
                if (this.#filesWanted)
                    this.#scheduleFiles(0);
            });
    }

    #put(unit: LoadedUnit): void {
        this.units.set(unit.path, unit);
        this.pathById.set(unit.id, unit.path);
    }

    #drop(id: string): void {
        const path = this.pathById.get(id);
        if (path === undefined)
            return;
        this.pathById.delete(id);
        this.units.delete(path);
        // Loaded again later, it is read again: its schedule may have changed meanwhile.
        this.#forgetTimer(path);
    }

    #forgetTimer(path: string): void {
        this.timers.delete(path);
        this.#timerRead.delete(path);
        this.#timerFetches.delete(path); // a read in flight is dropped when it lands
        this.#timerFailed.delete(path);
    }

    /** Signalled run states that may be newer than the reply just applied. */
    #replay(): void {
        for (const [path, patch] of this.#patches) {
            const unit = this.units.get(path);
            if (unit)
                Object.assign(unit, patch);
        }
    }

    #settle(): void {
        this.#inflight = Math.max(0, this.#inflight - 1);
        if (this.#inflight === 0)
            this.#patches.clear();
    }

    // ---- signals -----------------------------------------------------------------

    #onPropertiesChanged(path: string, args: unknown[]): void {
        if (this.reloading || !pathIsHandled(path))
            return;
        const [iface, changed] = args;
        if (!changed || typeof changed !== "object" || Array.isArray(changed))
            return;
        const props = changed as Record<string, unknown>;

        if (iface === TIMER) {
            this.#onTimerProperties(path, props);
            return;
        }
        if (iface !== UNIT)
            return; // Service, Socket, ...: nothing the list shows

        const patch = unitPatch(props);
        if (Object.keys(patch).length === 0)
            return;
        if (this.#inflight > 0)
            this.#patches.set(path, { ...this.#patches.get(path), ...patch });
        const unit = this.units.get(path);
        if (unit) {
            Object.assign(unit, patch);
            this.#changed();
        } else if (this.#loaded) {
            // Loaded since we listed: find out what it is. (Before the first
            // list lands every path is unknown; the list itself answers those,
            // with this patch replayed over it.)
            const id = idFromPath(path);
            if (id)
                this.#queueProbe(id);
        }
    }

    #onTimerProperties(path: string, props: Record<string, unknown>): void {
        if (!this.#timersWanted)
            return;
        // A signal carries only what changed (a timer just started sends its
        // next elapse, not its last trigger): it updates what was read, or
        // what is being read, and never stands in for a read.
        const pending = this.#timerFetches.get(path);
        if (pending)
            timerFields(pending.signalled, props);
        const info = this.timers.get(path);
        if (info) {
            timerFields(info, props);
            this.#changed();
        }
    }

    #onManager(member: string, args: unknown[]): void {
        switch (member) {
        case "UnitNew":
        case "UnitRemoved": {
            const [id, path] = args;
            if (this.reloading || typeof id !== "string" || !unitType(id))
                return;
            // A unit re-created after garbage collection starts afresh: what
            // was signalled for its previous life must not be replayed.
            if (typeof path === "string")
                this.#patches.delete(path);
            this.#queueProbe(id);
            break;
        }
        case "Reloading":
            if (args[0] === true)
                this.#reloadStarted();
            else if (args[0] === false)
                this.#reloadFinished();
            break;
        case "UnitFilesChanged":
            // Unit files changed on disk (enable, disable, mask, ...). Usually a
            // daemon-reload follows and re-lists everything; this covers the
            // ones without (systemctl enable --no-reload).
            if (!this.reloading)
                this.#scheduleFiles(this.timings.filesQuietMs);
            break;
        default:
            break; // JobNew, JobRemoved, StartupFinished: the views listen for these themselves
        }
    }

    #reloadStarted(): void {
        this.reloading = true;
        this.#probeIds.clear();
        this.#probeFirstQueued = null;
        this.#patches.clear();
        for (const timer of [this.#probeTimer, this.#filesTimer, this.#reloadTimer])
            if (timer)
                clearTimeout(timer);
        this.#probeTimer = null;
        this.#filesTimer = null;
        this.#filesWanted = false;
        // Reloading(false) should follow; if it is lost, do not stay frozen forever.
        this.#reloadTimer = setTimeout(() => this.#reloadFinished(), this.timings.reloadTimeoutMs);
        this.#changed();
    }

    #reloadFinished(): void {
        if (this.#reloadTimer)
            clearTimeout(this.#reloadTimer);
        this.#reloadTimer = null;
        if (!this.reloading)
            return;
        this.reloading = false;
        this.relist();
    }

    // ---- probing -----------------------------------------------------------------

    #queueProbe(id: string): void {
        if (this.reloading || this.#closed)
            return;
        this.#probeIds.add(id);
        this.#scheduleProbe();
    }

    /** Debounced, but never put off longer than probeMaxWaitMs by a continuous storm. */
    #scheduleProbe(): void {
        const now = Date.now();
        this.#probeFirstQueued ??= now;
        const at = Math.min(now + this.timings.probeQuietMs, this.#probeFirstQueued + this.timings.probeMaxWaitMs);
        if (this.#probeTimer)
            clearTimeout(this.#probeTimer);
        this.#probeTimer = setTimeout(() => {
            this.#probeTimer = null;
            void this.#probe();
        }, Math.max(0, at - now));
    }

    /**
     * Which of the queued names are loaded now, and in what state. A name not
     * returned is not loaded (garbage-collected, or a stopped transient unit):
     * its row falls back to its unit file, or disappears -- exactly what a full
     * re-list would show.
     */
    async #probe(): Promise<void> {
        if (this.#closed || this.reloading || this.#probeIds.size === 0)
            return;
        // A list in flight was read before these changes: probe after it has
        // landed, or the older list would overwrite the probe's newer answer.
        // Whatever finishes last re-schedules this.
        if (this.#listing || this.#probing || !this.#loaded)
            return;
        const ids = [...this.#probeIds];
        this.#probeIds.clear();
        this.#probeFirstQueued = null;
        if (ids.length > PROBE_LIMIT) {
            this.relist();
            return;
        }

        this.#probing = true;
        this.#inflight += 1;
        const generation = this.#listGeneration;
        try {
            const [rows] = await callManager(this.client, "ListUnitsByPatterns", [[], ids.map(exactPattern)], "asas");
            if (this.#closed || this.reloading || generation !== this.#listGeneration)
                return;
            const asked = new Set(ids);
            const found = new Set<string>();
            for (const unit of parseUnitRows(rows)) {
                // Exact patterns can only match the names asked for; anything
                // else in the reply is not trusted over the signals we have.
                if (!asked.has(unit.id) || !unitType(unit.id))
                    continue;
                found.add(unit.id);
                this.#put(unit);
            }
            for (const id of ids)
                if (!found.has(id))
                    this.#drop(id);
            this.#replay();
            this.#fetchTimers();
            this.#changed();
        } catch (error) {
            if (this.#closed)
                return;
            // ListUnitsByPatterns is systemd 230+; without it, re-list instead.
            if ((error as { name?: unknown }).name === "org.freedesktop.DBus.Error.UnknownMethod")
                this.relist();
            else
                console.warn("services: probing units failed:", errorText(error));
        } finally {
            this.#probing = false;
            this.#settle();
            if (this.#probeIds.size && !this.#closed)
                this.#scheduleProbe();
        }
    }

    // ---- unit files ----------------------------------------------------------------

    #scheduleFiles(ms: number): void {
        this.#filesWanted = true;
        if (this.#filesTimer)
            clearTimeout(this.#filesTimer);
        this.#filesTimer = setTimeout(() => {
            this.#filesTimer = null;
            void this.#refreshFiles();
        }, ms);
    }

    async #refreshFiles(): Promise<void> {
        // A list in flight re-reads the files anyway, and re-schedules this.
        if (this.#closed || this.reloading || this.#listing || !this.#loaded)
            return;
        this.#filesWanted = false;
        const generation = this.#listGeneration;
        try {
            const [rows] = await callManager(this.client, "ListUnitFiles", []);
            if (this.#closed || this.reloading || generation !== this.#listGeneration)
                return;
            this.files = unitFilesFrom(parseFileRows(rows));
            this.#changed();
        } catch (error) {
            if (!this.#closed)
                console.warn("services: listing unit files failed:", errorText(error));
        }
    }

    // ---- timers --------------------------------------------------------------------

    /**
     * Timer state is not part of ListUnits(): it takes a GetAll per loaded
     * timer, so it is fetched only once the Timers tab is shown, and then kept
     * current by Timer PropertiesChanged.
     */
    wantTimers(): void {
        if (this.#timersWanted || this.#closed)
            return;
        this.#timersWanted = true;
        this.wantClocks();
        this.#fetchTimers();
    }

    /**
     * The host's clocks only, for a view that dates one timer of its own (the
     * details): a monotonic timer has no date without them. Read once now,
     * and again with every re-list, as for the Timers tab.
     */
    wantClocks(): void {
        if (this.#clocksWanted || this.#closed)
            return;
        this.#clocksWanted = true;
        this.#readClocks();
    }

    #fetchTimers(): void {
        if (!this.#timersWanted || this.#closed || !this.#loaded)
            return;
        const generation = this.#listGeneration;
        for (const unit of this.units.values()) {
            const path = unit.path;
            if (unitType(unit.id) !== "timer" || unit.loadState !== "loaded" || this.#timerRead.get(path) === generation ||
                this.#timerFetches.has(path) || this.#timerFailed.has(path))
                continue;
            const fetch: TimerFetch = { signalled: {}, generation };
            this.#timerFetches.set(path, fetch);
            // Until the reply, the row keeps what was read before (if anything).
            const current = () => !this.#closed && this.#timerFetches.get(path) === fetch;
            getAll(this.client, path, TIMER).then(props => {
                if (!current())
                    return;
                const info = emptyTimer();
                timerFields(info, props);
                this.timers.set(path, { ...info, ...fetch.signalled });
                this.#timerRead.set(path, fetch.generation);
                this.#changed();
            }, (error: unknown) => {
                if (!current())
                    return;
                this.#timerFailed.add(path);
                console.warn(`services: reading timer ${unit.id} failed:`, errorText(error));
            }).finally(() => {
                if (!current())
                    return;
                this.#timerFetches.delete(path);
                // Listed again while this was read: it may predate a reload.
                if (fetch.generation !== this.#listGeneration)
                    this.#fetchTimers();
            });
        }
    }

    /*
     * Deliberately not cancelled on close: the script is a one-shot print
     * that ends by itself, and a late answer is ignored. (Cancelling through
     * runFull's AbortSignal currently surfaces the cancellation as an
     * uncaught exception; see the report.)
     */
    #readClocks(): void {
        if (this.#readingClocks || this.#closed)
            return;
        this.#readingClocks = true;
        this.#clocksGeneration = this.#listGeneration;
        runFull(CLOCKS_ARGV, { err: "message" }).then(({ stdout }) => {
            const [realtime, monotonic] = stdout.trim().split(/\s+/).map(Number);
            if (this.#closed || !Number.isFinite(realtime) || !Number.isFinite(monotonic))
                return;
            this.monotonicBase = realtime! - monotonic!;
            this.#changed();
        }, (error: unknown) => {
            if (!this.#closed)
                console.warn("services: reading the host's clocks failed; monotonic timers show no next run:", errorText(error));
        }).finally(() => {
            this.#readingClocks = false;
        });
    }
}
