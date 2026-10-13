/*
 * The overview's live data: hooks that open channels for the page's
 * lifetime and close them on unmount (the shell remounts the page when
 * administrative access changes, so nothing here reconnects by itself).
 *
 * Everything returned is raw host data; the page cleans text before showing it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import cockpit from "../../cockpit.js";
import { run, unvariant, useAsync, useDBusClient, useInterval } from "../../tui/hooks.js";
import { usePersistentStore } from "../../tui/session-context.js";
import { errorText } from "../../tui/status.js";
import {
    Decompressor, MACHINE_INFO_ARGV, USAGE_METRICS, VIRTUAL_NET_ARGV, networkInstances, parseMachineInfo,
    parseNameList, usageModel, type MachineInfo, type Meta, type Sample, type UsageModel,
} from "./metrics.js";
import { DATE_ARGV, countsAsFailed, parseDate, parseUptime, type HostClock } from "./system.js";

// ---- usage (metrics1) --------------------------------------------------------------

/*
 * One sample a second. Upstream's card uses 3 s, but the channel is reopened
 * on every visit (upstream closes it while the page is hidden) and CPU needs
 * two samples, so a short interval is what makes the numbers appear promptly.
 * Four small /proc reads a second cost nothing measurable, also over ssh.
 * Mutable so tests can speed it up.
 */
export const usageSettings = { interval: 1000 };

/** Persistent-store key for the last complete usage figures. */
const USAGE_CACHE = "overview:usage";

export interface UsageState {
    readonly model: UsageModel;
    /** The values are from an earlier visit, shown until fresh ones arrive. */
    readonly stale: boolean;
    /** The channel failed: "<problem>: <message>". */
    readonly error: string | null;
}

interface Latest {
    readonly sample: Sample;
    readonly meta: Meta;
}

export function useUsage(): UsageState {
    const [latest, setLatest] = useState<Latest | null>(null);
    const [info, setInfo] = useState<MachineInfo | null>(null);
    const [virtual, setVirtual] = useState<ReadonlySet<string> | null>(null);
    const [netKey, setNetKey] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    // The last complete figures from an earlier visit (see below).
    const store = usePersistentStore();
    const [cached] = useState(() => (store?.get(USAGE_CACHE) as UsageModel | undefined) ?? null);

    // Totals and the CPU count: once per visit, as upstream does.
    useEffect(() => {
        let live = true;
        run([...MACHINE_INFO_ARGV]).then(
            text => { if (live) setInfo(parseMachineInfo(text)) },
            failure => {
                // Without totals the page still shows what it can: memory
                // used without a bar, no CPU percentage.
                console.warn("overview: reading /proc/meminfo and /proc/cpuinfo failed:", errorText(failure));
                if (live) setInfo({ memTotal: null, swapTotal: null, cpus: 0 });
            });
        return () => { live = false };
    }, []);

    useEffect(() => {
        const decompressor = new Decompressor();
        const channel = cockpit.channel({
            payload: "metrics1",
            source: "internal",
            interval: usageSettings.interval,
            metrics: USAGE_METRICS.map(metric => ({ ...metric })),
        });
        let open = true;
        channel.addEventListener("message", (_event, data) => {
            let message: unknown;
            try {
                message = JSON.parse(data);
            } catch {
                return;
            }
            const samples = decompressor.push(message);
            const meta = decompressor.meta;
            if (!meta)
                return;
            if (!Array.isArray(message))
                setNetKey(networkInstances(meta).join("\n"));
            const sample = samples.at(-1);
            if (sample)
                setLatest({ sample, meta });
        });
        // The typings resolve this listener's arguments to never; the close
        // options are a plain object ({problem, message} on failure).
        channel.addEventListener("close", ((_event: unknown, options: Record<string, unknown>) => {
            if (!open)
                return;
            open = false;
            const problem = typeof options.problem === "string" ? options.problem : null;
            if (problem) {
                const message = typeof options.message === "string" && options.message ? `: ${options.message}` : "";
                setError(`${problem}${message}`);
            }
        }) as never);
        return () => {
            open = false;
            channel.close();
        };
    }, []);

    // Which interfaces are physical, re-checked whenever the set changes.
    useEffect(() => {
        if (netKey === null)
            return;
        let live = true;
        run([...VIRTUAL_NET_ARGV]).then(
            text => { if (live) setVirtual(parseNameList(text)) },
            () => { if (live) setVirtual(new Set(["lo"])) }); // at least never count loopback
        return () => { live = false };
    }, [netKey]);

    const model = useMemo(() => usageModel(latest?.sample ?? null, latest?.meta ?? null, info, virtual),
                          [latest, info, virtual]);
    const complete = model.cpuPercent !== null;

    /*
     * Remember complete figures for the next visit, so it opens on them
     * (dimmed, "updating") instead of dashes while the first rates come in.
     * Written straight into the shell's store rather than through
     * usePersistentState: that one writes the store from inside a state
     * updater, and React drops an update queued on a component that is about
     * to unmount -- which is exactly when the last write matters (an effect
     * flushed by the render that leaves the page). Read once, at mount, so it
     * never needs to re-render anything.
     */
    useEffect(() => {
        if (complete)
            store?.set(USAGE_CACHE, model);
    }, [model, complete, store]);

    if (!complete && cached && !error)
        return { model: cached, stale: true, error: null };
    return { model, stale: false, error };
}

// ---- failed units ----------------------------------------------------------------

const SYSTEMD = "org.freedesktop.systemd1";
const MANAGER = "org.freedesktop.systemd1.Manager";
const MANAGER_PATH = "/org/freedesktop/systemd1";
const UNIT = "org.freedesktop.systemd1.Unit";
const PROPERTIES = "org.freedesktop.DBus.Properties";

export interface FailedUnits {
    /** Ids of the failed units, sorted; null until the first list is in. */
    readonly units: readonly string[] | null;
    readonly error: string | null;
}

/*
 * The failed-unit count, computed here because the TUI has no hidden,
 * preloaded Services page to publish it (upstream's route, specs/overview.md
 * §2.4). Same calls and rule as upstream's services page:
 *
 *   Subscribe() (errors such as AlreadySubscribed are expected: the
 *   subscription is per bus connection, and the bridge shares one), then
 *   ListUnitsFiltered(["failed"]) for the initial set.
 *
 * Kept current per unit rather than by re-listing, because systemd emits
 * hundreds of PropertiesChanged in a fraction of a second when units are
 * garbage-collected (specs/services.md §3.4): a signal costs nothing unless
 * it moves a unit into or out of "failed".
 *
 *   PropertiesChanged on org.freedesktop.systemd1.Unit (matched by arg0, so
 *     no other interface's changes are even sent): a failed unit that is no
 *     longer failed leaves the set; any other unit entering "failed" is
 *     looked up with GetAll, for its Id and LoadState.
 *   UnitRemoved: the unit leaves the set.
 *   Reloading(true) ... Reloading(false): systemd frees and re-creates every
 *     unit, so signals are ignored in between and the set is listed afresh.
 *
 * Signals that arrive while a list is in flight could be older or newer than
 * the list's snapshot, so the units they name are looked up again once it
 * lands. Each signal matches exactly one rule, so none is delivered twice.
 */
export function useFailedUnits(): FailedUnits {
    const client = useDBusClient(SYSTEMD, { bus: "system", superuser: "try" });
    const [state, setState] = useState<FailedUnits>({ units: null, error: null });

    useEffect(() => {
        let live = true;
        const failed = new Map<string, string>(); // object path -> unit id
        const dirty = new Set<string>();
        let listing = false;
        let reloading = false;
        let generation = 0;

        const publish = () => {
            if (live)
                setState({ units: [...failed.values()].sort(), error: null });
        };
        const fail = (error: unknown) => {
            if (live)
                setState(previous => ({ units: previous.units, error: errorText(error) }));
        };

        const lookUp = (path: string) => {
            const mine = generation;
            client.call(path, PROPERTIES, "GetAll", [UNIT]).then(([props]) => {
                // A list started since: its snapshot is newer than this reply.
                if (!live || listing || mine !== generation)
                    return;
                const values = (props ?? {}) as Record<string, unknown>;
                const id = unvariant<unknown>(values.Id);
                const load = unvariant<unknown>(values.LoadState);
                const active = unvariant<unknown>(values.ActiveState);
                if (typeof id === "string" && countsAsFailed(id, String(load), String(active)))
                    failed.set(path, id);
                else
                    failed.delete(path);
                publish();
            }, () => {
                // The unit is gone (unloaded between the signal and the call).
                if (live && !listing && mine === generation && failed.delete(path))
                    publish();
            });
        };

        const list = () => {
            listing = true;
            dirty.clear();
            const mine = ++generation;
            client.call(MANAGER_PATH, MANAGER, "ListUnitsFiltered", [["failed"]]).then(([rows]) => {
                if (!live || mine !== generation)
                    return;
                failed.clear();
                for (const row of Array.isArray(rows) ? rows : []) {
                    if (!Array.isArray(row))
                        continue;
                    const [id, , load, active, , , path] = row as unknown[];
                    if (typeof id === "string" && typeof path === "string" && countsAsFailed(id, String(load), String(active)))
                        failed.set(path, id);
                }
                listing = false;
                publish();
                for (const path of dirty)
                    lookUp(path);
                dirty.clear();
            }, error => {
                if (!live || mine !== generation)
                    return;
                listing = false;
                fail(error);
            });
        };

        const subscriptions = [
            client.subscribe({ interface: PROPERTIES, member: "PropertiesChanged", arg0: UNIT }, (path, _iface, _member, args) => {
                if (!live || reloading)
                    return;
                const changed = (args[1] ?? {}) as Record<string, unknown>;
                const invalidated = Array.isArray(args[2]) ? args[2] as unknown[] : [];
                const touched = (name: string) => name in changed || invalidated.includes(name);
                if (!touched("ActiveState") && !touched("LoadState"))
                    return;
                if (listing) {
                    dirty.add(path);
                    return;
                }
                const active = "ActiveState" in changed ? unvariant<unknown>(changed.ActiveState) : undefined;
                if (failed.has(path)) {
                    if (active !== undefined && active !== "failed") {
                        failed.delete(path);
                        publish();
                    } else {
                        lookUp(path); // LoadState changed, or the state was only invalidated
                    }
                } else if (active === "failed" || (active === undefined && invalidated.includes("ActiveState"))) {
                    lookUp(path);
                }
            }),
            client.subscribe({ interface: MANAGER, member: "UnitRemoved" }, (_path, _iface, _member, args) => {
                if (!live || reloading)
                    return;
                const path = args[1];
                if (typeof path !== "string")
                    return;
                if (listing)
                    dirty.add(path);
                else if (failed.delete(path))
                    publish();
            }),
            client.subscribe({ interface: MANAGER, member: "Reloading" }, (_path, _iface, _member, args) => {
                if (!live)
                    return;
                if (args[0] === true) {
                    reloading = true;
                } else {
                    reloading = false;
                    list();
                }
            }),
        ];

        // The bus channel went away (no systemd on this host, or the
        // connection is ending): the library's words for the problem code.
        const onClose = (_event: unknown, options: Record<string, unknown>) => {
            if (typeof options?.problem === "string")
                fail(cockpit.message(options as cockpit.JsonObject));
        };
        client.addEventListener("close" as never, onClose as never);

        // The match rules above were sent first, so nothing between them and
        // the list is missed.
        client.call(MANAGER_PATH, MANAGER, "Subscribe", [])
            .catch((error: unknown) => {
                const name = (error as { name?: string } | null)?.name;
                // Leaving the page closes the client under a pending call: not a fault.
                if (live && name !== "org.freedesktop.systemd1.AlreadySubscribed" && name !== "org.freedesktop.DBus.Error.FileExists")
                    console.warn("overview: systemd Subscribe() failed:", errorText(error));
            })
            .finally(() => {
                if (live)
                    list();
            });

        return () => {
            live = false;
            for (const subscription of subscriptions)
                subscription.remove();
            client.removeEventListener("close" as never, onClose as never);
        };
    }, [client]);

    return state;
}

// ---- the host's clock ----------------------------------------------------------------

export interface HostClockState {
    readonly clock: HostClock | null;
    /** Host clock minus ours, in milliseconds. */
    readonly skew: number;
    readonly error: unknown;
    readonly reload: () => void;
}

/** How often the host's offset is re-read, so a DST change shows up. */
const CLOCK_REFRESH_MS = 10 * 60 * 1000;

/**
 * The host's time, offset and zone abbreviation from one `date` spawn: once
 * on mount, again when the time zone changes, after the time dialog
 * applies, and every ten minutes. Pass timedated's Timezone once it is
 * known, null until then: only a change from one known zone to another
 * re-reads, and a re-read keeps the previous reading on screen until the
 * new one lands (so neither the zone's first arrival nor a change makes
 * the rows flicker, and a visit spawns `date` once).
 */
export function useHostClock(timezone: string | null): HostClockState {
    const state = useAsync(async () => {
        const before = Date.now();
        // No abort signal: see the note on run() in index.tsx.
        const text = await run([...DATE_ARGV]);
        const after = Date.now();
        const clock = parseDate(text);
        if (!clock)
            throw new Error(`unexpected output from date: ${text.trim()}`);
        // `date +%s` truncates to the second; the midpoint of the round trip
        // is the best guess for when it ran.
        return { clock, skew: clock.epoch * 1000 - (before + after) / 2 + 500 };
    }, []);
    useInterval(state.reload, CLOCK_REFRESH_MS);
    const { reload } = state;
    const zone = useRef<string | null>(null);
    useEffect(() => {
        if (timezone === null)
            return;
        if (zone.current !== null && zone.current !== timezone)
            reload();
        zone.current = timezone;
    }, [timezone, reload]);
    return { clock: state.value?.clock ?? null, skew: state.value?.skew ?? 0, error: state.error, reload };
}

// ---- uptime ------------------------------------------------------------------------

export interface Uptime {
    /** Seconds since boot, now; null until read. */
    readonly seconds: number | null;
    /**
     * When the host booted, in milliseconds by OUR clock (add the host
     * clock's skew for the host's idea of it); null until read. Fixed per
     * read, so a boot time on a minute boundary cannot flicker.
     */
    readonly bootTime: number | null;
    readonly error: unknown;
}

/**
 * /proc/uptime, re-read every minute like upstream, and advanced between
 * reads with our own monotonic clock so the display can tick. Uptime from
 * the host itself avoids depending on the two clocks agreeing.
 */
export function useUptime(): Uptime {
    const read = useAsync(async () => {
        const file = cockpit.file("/proc/uptime");
        try {
            const seconds = parseUptime(await file.read());
            if (seconds === null)
                throw new Error("/proc/uptime is unreadable");
            return { seconds, at: performance.now(), bootTime: Date.now() - seconds * 1000 };
        } finally {
            file.close();
        }
    }, []);
    useInterval(read.reload, 60_000);
    const value = read.value;
    // Evaluated on every render; the page re-renders each second anyway.
    return {
        seconds: value ? value.seconds + (performance.now() - value.at) / 1000 : null,
        bootTime: value ? value.bootTime : null,
        error: read.error,
    };
}

// ---- one-shot reads ----------------------------------------------------------------

/** Read a whole file once, closing its channel; null if it does not exist. */
export async function readFile(path: string, options: { superuser?: "try" } = {}): Promise<string | null> {
    const file = cockpit.file(path, options);
    try {
        return await file.read();
    } finally {
        file.close();
    }
}

/** Read a file as bytes once; null if it does not exist. */
export async function readBinaryFile(path: string): Promise<Uint8Array | null> {
    const file = cockpit.file(path, { binary: true });
    try {
        return await file.read();
    } finally {
        file.close();
    }
}

/**
 * A property polled with Properties.Get, for those that change without a
 * signal: timedated computes NTPSynchronized on request, so upstream polls it
 * every 5 s. Undefined until the first poll; until then the caller uses the
 * value its property watch delivered.
 */
export function usePolledProperty(client: cockpit.DBusClient, path: string, iface: string, name: string,
                                  everyMs: number, enabled: boolean): unknown {
    const [value, setValue] = useState<unknown>(undefined);
    const live = useRef(true);
    useEffect(() => {
        live.current = true;
        return () => { live.current = false };
    }, []);
    const poll = () => {
        client.call(path, PROPERTIES, "Get", [iface, name]).then(
            ([variant]) => { if (live.current) setValue(unvariant(variant)) },
            () => { /* the property watch still has the last value */ });
    };
    useInterval(poll, enabled ? everyMs : null);
    return value;
}
