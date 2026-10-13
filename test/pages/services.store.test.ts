/*
 * The Services page's unit store against the mock bridge, without the UI:
 * how it keeps a list of hundreds of units current through systemd's signal
 * storms without doing per-signal work.
 *
 * Signals are injected by calling a scripted helper method ("/inject",
 * test.Inject.Fire) whose effects emit them as systemd would, from systemd's
 * bus name, to every channel whose match rules let them through.
 */
import { describe, it, expect, afterEach } from "vitest";
import cockpit from "../../src/cockpit.js";
import { UnitStore, type StoreTimings } from "../../src/pages/services/store.js";
import { buildRows } from "../../src/pages/services/model.js";
import { startMock, type Effect, type JsonObject, type MethodSpec, type MockBridge } from "../mock-bridge/harness.js";
import { trackTimers } from "./services.timers.js";

const M = "/org/freedesktop/systemd1";
const MANAGER = "org.freedesktop.systemd1.Manager";
const PROPS = "org.freedesktop.DBus.Properties";
const UNIT = "org.freedesktop.systemd1.Unit";
const TIMER = "org.freedesktop.systemd1.Timer";
const SYSTEMD = "org.freedesktop.systemd1";

function escapeLabel(name: string): string {
    return [...Buffer.from(name, "utf8")].map((byte, i) => {
        const c = String.fromCharCode(byte);
        return /[A-Za-z]/.test(c) || (i > 0 && /[0-9]/.test(c)) ? c : "_" + byte.toString(16).padStart(2, "0");
    }).join("");
}

const path = (id: string) => `${M}/unit/${escapeLabel(id)}`;

function row(id: string, active = "active", load = "loaded"): unknown[] {
    return [id, `${id} description`, load, active, active === "active" ? "running" : "dead", "", path(id), 0, "", "/"];
}

/** A PropertiesChanged on a unit, as systemd sends it: the type's interface first, then Unit. */
function unitChanged(id: string, active: string, sub: string, delayMs = 0): Effect[] {
    const changed = { ActiveState: { t: "s", v: active }, SubState: { t: "s", v: sub } };
    return [
        { signal: [path(id), PROPS, "PropertiesChanged", ["org.freedesktop.systemd1.Service", { Result: { t: "s", v: "success" } }, []]], delayMs },
        { signal: [path(id), PROPS, "PropertiesChanged", [UNIT, changed, ["Conditions", "Asserts"]]], delayMs },
    ];
}

const managerSignal = (member: string, args: unknown[], delayMs = 0): Effect =>
    ({ signal: [M, MANAGER, member, args], delayMs });

const LOADED = ["crond.service", "sshd.service", "gone.service", "dnf-makecache.timer", "multi-user.target"];

function scenario(options: { methods?: Record<string, MethodSpec>, inject?: Record<string, Effect[]> } = {}) {
    return {
        dbus: {
            system: {
                [M]: {
                    [MANAGER]: {
                        methods: {
                            Subscribe: { reply: [] },
                            ListUnits: { reply: [[...LOADED.map(id => row(id)), row("dev-sda.device"), row("var-tmp.mount")]], out: ["a(ssssssouso)"] },
                            ListUnitFiles: {
                                reply: [[["/usr/lib/systemd/system/crond.service", "enabled"], ["/usr/lib/systemd/system/gone.service", "disabled"]]],
                                out: ["a(ss)"],
                            },
                            ListUnitsByPatterns: { reply: [[]], out: ["a(ssssssouso)"] },
                            ...options.methods,
                        },
                    },
                },
                [path("dnf-makecache.timer")]: {
                    [UNIT]: { properties: { Id: "dnf-makecache.timer" } },
                    [TIMER]: {
                        properties: {
                            LastTriggerUSec: { t: "t", v: 1_790_979_796_239_992 },
                            NextElapseUSecRealtime: { t: "t", v: 0 },
                            NextElapseUSecMonotonic: { t: "t", v: 1_063_093_795_740 },
                        },
                    },
                },
                "/inject": {
                    "test.Inject": {
                        methods: {
                            Fire: {
                                reply: [],
                                byArgs: Object.entries(options.inject ?? {}).map(([name, effects]) => ({ args: [name], reply: [], effects })),
                            },
                        },
                    },
                },
            },
        } as never,
        spawnPatterns: [{ match: "^sh -ec ", stdout: "1790984275157465 1061671516166\n" }],
    };
}

let mock: MockBridge | null = null;
let store: UnitStore | null = null;

afterEach(() => {
    store?.close();
    store = null;
    mock?.close();
    mock = null;
});

const FAST: Partial<StoreTimings> = { probeQuietMs: 50, probeMaxWaitMs: 300, repaintMs: 20, filesQuietMs: 50, reloadTimeoutMs: 2000 };

async function open(s: ReturnType<typeof scenario>, timings: Partial<StoreTimings> = FAST): Promise<UnitStore> {
    mock = await startMock(s);
    store = new UnitStore("system", timings);
    store.start();
    await until(() => store!.status === "ready");
    return store;
}

async function until(test: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!test()) {
        if (Date.now() > deadline)
            throw new Error(`timed out waiting for ${test.toString()}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Emit the named batch of signals (see scenario()), from systemd's own name. */
async function fire(name: string): Promise<void> {
    const injector = cockpit.dbus(SYSTEMD, { bus: "system" });
    try {
        await injector.call("/inject", "test.Inject", "Fire", [name]);
    } finally {
        injector.close();
    }
}

/** Method calls the store made (the injector's own calls left out), in order. */
function storeCalls(): { method: string, args: unknown[], type?: string }[] {
    const out: { method: string, args: unknown[], type?: string }[] = [];
    for (const entry of mock!.received()) {
        if (entry.data === undefined || !entry.data.startsWith("{"))
            continue;
        const message = JSON.parse(entry.data) as JsonObject;
        if (!Array.isArray(message.call))
            continue;
        const [, iface, method, args] = message.call as [string, string, string, unknown[]];
        if (iface !== "test.Inject")
            out.push({ method, args, ...(message.type ? { type: message.type as string } : {}) });
    }
    return out;
}

const count = (method: string) => storeCalls().filter(c => c.method === method).length;

/** Repaints from now on. */
function repaints(s: UnitStore): { readonly count: number } {
    const counter = { count: 0 };
    s.subscribe(() => { counter.count += 1 });
    return counter;
}

describe("the unit store", () => {
    it("lists the handled unit types once, after subscribing", async () => {
        const s = await open(scenario());
        expect(storeCalls().map(c => c.method)).toEqual(["Subscribe", "ListUnits", "ListUnitFiles"]);
        expect([...s.units.values()].map(u => u.id).sort()).toEqual([...LOADED].sort());
        expect([...s.files!.keys()].sort()).toEqual(["crond.service", "gone.service"]);
        // The rules went out before the calls, so nothing after the list can be missed.
        const sent = mock!.received().filter(e => e.data !== undefined).map(e => JSON.parse(e.data!) as JsonObject);
        const firstCall = sent.findIndex(m => m.call);
        expect(sent.slice(0, firstCall).map(m => m["add-match"])).toEqual([
            { interface: PROPS, member: "PropertiesChanged", path_namespace: "/org/freedesktop/systemd1/unit" },
            { interface: MANAGER },
        ]);
    });

    it("patches a known unit's run state in place, with no call to systemd", async () => {
        const s = await open(scenario({ inject: { stop: unitChanged("crond.service", "inactive", "dead") } }));
        const painted = repaints(s);
        await fire("stop");
        await until(() => s.units.get(path("crond.service"))!.activeState === "inactive");
        expect(s.units.get(path("crond.service"))!.subState).toBe("dead");
        await until(() => painted.count > 0);
        expect(storeCalls().map(c => c.method)).toEqual(["Subscribe", "ListUnits", "ListUnitFiles"]);
    });

    it("collapses a storm into one probe and a handful of repaints", async () => {
        // Like the measured idle-exit storms: the same few units loaded and
        // unloaded over and over, every referencing unit re-announced each
        // time. (Fired as six bursts: a scenario must fit in one environment
        // variable, 128 KiB.)
        const storm: Effect[] = [];
        for (let i = 0; i < 10; i++) {
            const at = Math.floor(i * 45 / 10);
            storm.push(
                ...unitChanged("new.service", "activating", "start", at),
                managerSignal("UnitNew", ["new.service", path("new.service")], at),
                managerSignal("UnitRemoved", ["gone.service", path("gone.service")], at),
                managerSignal("UnitNew", ["var-tmp.mount", path("var-tmp.mount")], at),
                ...unitChanged("crond.service", i % 2 ? "active" : "reloading", "running", at),
                ...unitChanged("multi-user.target", "active", "active", at),
                // Jobs and other types: never the list's business.
                { signal: [`${M}/job/${i}`, PROPS, "PropertiesChanged", ["org.freedesktop.systemd1.Job", { State: { t: "s", v: "running" } }, []]], delayMs: at },
                ...unitChanged("var-tmp.mount", "active", "mounted", at),
            );
        }
        const s = await open(scenario({
            inject: { storm },
            methods: {
                ListUnitsByPatterns: {
                    reply: [[]], out: ["a(ssssssouso)"],
                    byArgs: [{ args: [[], ["new.service", "gone.service"]], reply: [[row("new.service")]] }],
                },
            },
        }), { ...FAST, repaintMs: 100, probeQuietMs: 250, probeMaxWaitMs: 1000 });
        const painted = repaints(s);
        const started = Date.now();
        for (let burst = 0; burst < 6; burst++) {
            void fire("storm");
            await sleep(48);
        }
        await until(() => s.units.has(path("new.service")), 3000);
        await sleep(400);
        const elapsed = Date.now() - started;

        expect(storeCalls().filter(c => c.method === "ListUnitsByPatterns"))
            .toEqual([{ method: "ListUnitsByPatterns", args: [[], ["new.service", "gone.service"]], type: "asas" }]);
        // Nothing that loads a unit (LoadUnit, GetAll on its path, ListUnitsByNames), and no re-list.
        expect(storeCalls().map(c => c.method).filter(m => m !== "ListUnitsByPatterns"))
            .toEqual(["Subscribe", "ListUnits", "ListUnitFiles"]);
        // 660 signals in about 290 ms; at most one repaint per 100 ms.
        expect(painted.count).toBeLessThanOrEqual(Math.ceil(elapsed / 100) + 1);
        expect(painted.count).toBeLessThan(15);

        // gone.service was not loaded any more: its row is its unit file again.
        expect(s.pathById.has("gone.service")).toBe(false);
        const rows = buildRows({ units: s.units.values(), files: s.files, type: "service" });
        expect(rows.find(r => r.id === "gone.service")).toMatchObject({ loaded: false, activeState: "inactive", fileState: "disabled" });
        // new.service is listed with the state the probe returned, then patched by later signals.
        expect(rows.find(r => r.id === "new.service")).toMatchObject({ loaded: true });
        expect(s.units.has(path("var-tmp.mount"))).toBe(false);
    });

    it("mutes every signal while systemd reloads, then lists once", async () => {
        const reload: Effect[] = [
            managerSignal("Reloading", [true]),
            ...LOADED.flatMap(id => [
                managerSignal("UnitRemoved", [id, path(id)], 10),
                managerSignal("UnitNew", [id, path(id)], 20),
            ]),
            ...unitChanged("crond.service", "inactive", "dead", 30),
            ...unitChanged("brand-new.service", "active", "running", 30),
            managerSignal("UnitFilesChanged", [], 40),
            managerSignal("Reloading", [false], 150),
        ];
        const s = await open(scenario({ inject: { reload } }));
        await fire("reload");
        await until(() => s.reloading);
        await sleep(100);
        // Frozen: nothing was patched or probed meanwhile.
        expect(s.units.get(path("crond.service"))!.activeState).toBe("active");
        await until(() => !s.reloading && count("ListUnits") === 2);
        await until(() => !s.listing);
        await sleep(200);
        expect(count("ListUnits")).toBe(2);
        expect(count("ListUnitFiles")).toBe(2);
        expect(count("ListUnitsByPatterns")).toBe(0);
    });

    it("does not stay frozen when Reloading(false) never comes", async () => {
        const s = await open(scenario({ inject: { lost: [managerSignal("Reloading", [true])] } }), { ...FAST, reloadTimeoutMs: 200 });
        await fire("lost");
        await until(() => s.reloading);
        await until(() => !s.reloading && count("ListUnits") === 2, 2000);
    });

    it("re-reads only the unit files after UnitFilesChanged, once per burst", async () => {
        const changed = Array.from({ length: 5 }, (_, i) => managerSignal("UnitFilesChanged", [], i * 10));
        const s = await open(scenario({ inject: { changed } }));
        await fire("changed");
        await until(() => count("ListUnitFiles") === 2);
        await sleep(200);
        expect(count("ListUnitFiles")).toBe(2);
        expect(count("ListUnits")).toBe(1);
        expect(s.status).toBe("ready");
    });

    it("keeps a run state signalled right after the list's reply", async () => {
        // The reply says active; systemd stopped the unit just after answering.
        const s = await open(scenario({
            methods: {
                ListUnits: {
                    reply: [LOADED.map(id => row(id))], out: ["a(ssssssouso)"],
                    effects: unitChanged("crond.service", "inactive", "dead"),
                },
            },
        }));
        expect(s.units.get(path("crond.service"))!.activeState).toBe("inactive");
    });

    it("drops a unit that is gone and was not a unit file", async () => {
        const s = await open(scenario({
            inject: { gc: [managerSignal("UnitRemoved", ["sshd.service", path("sshd.service")])] },
        }));
        await fire("gc");
        await until(() => !s.pathById.has("sshd.service"));
        expect(buildRows({ units: s.units.values(), files: s.files, type: "service" }).map(r => r.id))
            .not.toContain("sshd.service");
        expect(storeCalls().filter(c => c.method === "ListUnitsByPatterns").map(c => c.args))
            .toEqual([[[], ["sshd.service"]]]);
    });

    it("reads timers only once asked, then follows their signals", async () => {
        const next = 1_790_990_000_000_000;
        const s = await open(scenario({
            inject: {
                elapse: [{ signal: [path("dnf-makecache.timer"), PROPS, "PropertiesChanged", [TIMER, {
                    NextElapseUSecRealtime: { t: "t", v: next }, NextElapseUSecMonotonic: { t: "t", v: 0 },
                }, ["TimersMonotonic"]]] }],
            },
        }));
        expect(count("GetAll")).toBe(0);
        s.wantTimers();
        await until(() => s.timers.has(path("dnf-makecache.timer")) && s.monotonicBase !== null);
        expect(s.monotonicBase).toBe(1790984275157465 - 1061671516166);
        expect(storeCalls().filter(c => c.method === "GetAll")).toEqual([{ method: "GetAll", args: [TIMER], type: "s" }]);
        expect(mock!.opened("stream").map(o => (o.spawn as string[]).slice(0, 2))).toEqual([["sh", "-ec"]]);
        await fire("elapse");
        await until(() => s.timers.get(path("dnf-makecache.timer"))!.nextRealtime === next);
        expect(s.timers.get(path("dnf-makecache.timer"))!.lastTrigger).toBe(1_790_979_796_239_992);
        s.wantTimers();
        await sleep(50);
        expect(count("GetAll")).toBe(1);
    });

    it("reads the timers again after a daemon-reload, which changes schedules without telling", async () => {
        const timer = path("dnf-makecache.timer");
        const next = 1_791_000_000_000_000;
        const s = await open(scenario({
            inject: {
                reload: [
                    managerSignal("Reloading", [true]),
                    // An edited OnCalendar=: the new schedule, but no signal the store may act on.
                    { properties: [timer, TIMER, { NextElapseUSecRealtime: { t: "t", v: next } }], delayMs: 10 },
                    managerSignal("UnitRemoved", ["dnf-makecache.timer", timer], 20),
                    managerSignal("UnitNew", ["dnf-makecache.timer", timer], 30),
                    managerSignal("Reloading", [false], 60),
                ],
            },
        }));
        s.wantTimers();
        await until(() => s.timers.has(timer));
        expect(s.timers.get(timer)!.nextRealtime).toBe(0);
        await fire("reload");
        await until(() => s.timers.get(timer)!.nextRealtime === next);
        expect(count("GetAll")).toBe(2);
        expect(s.timers.get(timer)!.lastTrigger).toBe(1_790_979_796_239_992);
        // Nothing more: a probe or a signal does not read it again.
        await sleep(100);
        expect(count("GetAll")).toBe(2);
    });

    it("forgets a timer that is unloaded, and reads one loaded later in full", async () => {
        const timer = path("dnf-makecache.timer");
        const fstrim = path("fstrim.timer");
        const sc = scenario({
            methods: {
                ListUnitsByPatterns: {
                    reply: [[]], out: ["a(ssssssouso)"],
                    byArgs: [{ args: [[], ["fstrim.timer"]], reply: [[row("fstrim.timer")]] }],
                },
            },
            inject: {
                gc: [managerSignal("UnitRemoved", ["dnf-makecache.timer", timer])],
                // Started while not loaded: UnitNew, then a Timer change with only the next elapse.
                start: [
                    managerSignal("UnitNew", ["fstrim.timer", fstrim]),
                    { signal: [fstrim, PROPS, "PropertiesChanged", [TIMER, {
                        NextElapseUSecRealtime: { t: "t", v: 1_791_000_000_000_000 }, NextElapseUSecMonotonic: { t: "t", v: 0 },
                    }, []]] },
                ],
            },
        });
        (sc.dbus as Record<string, Record<string, unknown>>).system![fstrim] = {
            [UNIT]: { properties: { Id: "fstrim.timer" } },
            [TIMER]: {
                properties: {
                    LastTriggerUSec: { t: "t", v: 1_790_000_000_000_000 },
                    NextElapseUSecRealtime: { t: "t", v: 1_791_000_000_000_000 },
                    NextElapseUSecMonotonic: { t: "t", v: 0 },
                },
            },
        };
        const s = await open(sc);
        s.wantTimers();
        await until(() => s.timers.has(timer));
        await fire("gc");
        await until(() => !s.pathById.has("dnf-makecache.timer"));
        expect(s.timers.has(timer)).toBe(false);

        await fire("start");
        // Read in full once loaded: not left with what the signal carried.
        await until(() => s.timers.get(fstrim)?.lastTrigger === 1_790_000_000_000_000);
        expect(s.timers.get(fstrim)).toMatchObject({ nextRealtime: 1_791_000_000_000_000 });
        expect(count("GetAll")).toBe(2);
    });

    it("reads only the host's clocks for a view that dates one timer, once, and again on a re-list", async () => {
        const s = await open(scenario());
        const clockReads = () => mock!.opened("stream").filter(o => (o.spawn as string[])[0] === "sh").length;
        s.wantClocks();
        s.wantClocks();
        await until(() => s.monotonicBase !== null);
        expect(s.monotonicBase).toBe(1790984275157465 - 1061671516166);
        expect(clockReads()).toBe(1);
        expect(count("GetAll")).toBe(0);
        s.relist();
        await until(() => clockReads() === 2);
        expect(count("GetAll")).toBe(0);
    });

    it("delivers client-side subscriptions without adding a match rule", async () => {
        const s = await open(scenario({ inject: { job: [managerSignal("JobRemoved", [5, `${M}/job/5`, "crond.service", "done"])] } }));
        const seen: unknown[][] = [];
        const subscriptions = Array.from({ length: 20 }, () =>
            s.onSignal({ interface: MANAGER, member: "JobRemoved" }, (_p, _i, _m, args) => { seen.push(args) }));
        subscriptions.slice(1).forEach(sub => sub.remove());
        await fire("job");
        await until(() => seen.length > 0);
        await sleep(50);
        expect(seen).toEqual([[5, `${M}/job/5`, "crond.service", "done"]]);
        const sent = mock!.received().filter(e => e.data !== undefined).map(e => JSON.parse(e.data!) as JsonObject);
        expect(sent.filter(m => m["add-match"])).toHaveLength(2);
        expect(sent.filter(m => m["remove-match"] || m.watch)).toEqual([]);
        // A handler that throws is contained.
        s.onSignal({ interface: MANAGER, member: "JobRemoved" }, () => { throw new Error("boom") });
        await fire("job");
        await until(() => seen.length === 2);
    });

    it("tolerates an earlier Subscribe on the same connection", async () => {
        const s = await open(scenario({
            methods: { Subscribe: { error: ["org.freedesktop.systemd1.AlreadySubscribed", ["Client is already subscribed."]] } },
        }));
        expect(s.status).toBe("ready");
        expect(s.error).toBeNull();
    });

    it("fails visibly when it cannot have signals", async () => {
        mock = await startMock(scenario({
            methods: { Subscribe: { error: ["org.freedesktop.DBus.Error.AccessDenied", ["Sender is not authorized to send message"]] } },
        }));
        store = new UnitStore("system", FAST);
        store.start();
        await until(() => store!.status === "error");
        expect(store.error).toBe("Subscribing to systemd signals failed: Sender is not authorized to send message");
        expect(store.fatal).toBe(true);
    });

    it("reports a failed list", async () => {
        mock = await startMock(scenario({
            methods: { ListUnits: { error: ["org.freedesktop.DBus.Error.NoReply", ["Did not receive a reply."]] } },
        }));
        store = new UnitStore("system", FAST);
        store.start();
        await until(() => store!.status === "error");
        expect(store.error).toBe("Listing units failed: Did not receive a reply.");
        expect(store.fatal).toBe(false);
    });

    it("leaves no timer behind when closed with work queued", async () => {
        const timers = trackTimers();
        try {
            // Slow timings: everything is still waiting when the store closes.
            const s = await open(scenario({
                inject: {
                    queue: [
                        managerSignal("UnitNew", ["late.service", path("late.service")]),
                        managerSignal("UnitFilesChanged", []),
                        ...unitChanged("crond.service", "failed", "failed"),
                    ],
                    reload: [managerSignal("Reloading", [true])],
                },
            }), { probeQuietMs: 5000, probeMaxWaitMs: 10_000, repaintMs: 5000, filesQuietMs: 5000, reloadTimeoutMs: 10_000 });
            // A probe, a unit file re-read and a repaint, all waiting.
            await fire("queue");
            await until(() => timers.pending().length === 3);
            // Then a reload: its own timeout (what was queued waits for the re-list instead).
            await fire("reload");
            await until(() => s.reloading);
            expect(timers.pending().length).toBeGreaterThanOrEqual(2);
            s.close();
            expect(timers.pending()).toEqual([]);
        } finally {
            timers.restore();
        }
    });

    it("has nothing in flight after close", async () => {
        const s = await open(scenario({ inject: { late: unitChanged("crond.service", "failed", "failed", 100) } }));
        const painted = repaints(s);
        await fire("late");
        s.close();
        await sleep(250);
        expect(painted.count).toBe(0);
        expect(s.units.get(path("crond.service"))!.activeState).toBe("active");
    });
});
