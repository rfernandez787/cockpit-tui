/*
 * The Services page against the mock bridge: the merged list, its filters,
 * the details, the navigation params, the actions -- asserted down to the
 * exact D-Bus calls they make -- and the page's discipline on the systemd
 * channel: two match rules, ever, however much the user moves around.
 *
 * The mock has no systemd. Each test scripts one: a manager object whose
 * ListUnits/ListUnitFiles replies are fixed, an object per unit with the
 * Unit (and Service/Socket/Timer) properties, and action methods whose
 * effects play out what systemd would emit (PropertiesChanged on the unit,
 * JobRemoved for the job, Reloading around a daemon-reload).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import ServicesPage from "../../src/pages/services/index.js";
import { UnitStore } from "../../src/pages/services/store.js";
import { renderPage, type RenderedPage } from "../helpers/page.js";
import { cleanup, keys } from "../helpers/ink.js";
import {
    startMock, type Effect, type JsonObject, type MethodSpec, type MockBridge, type MockScenario, type SpawnResult,
} from "../mock-bridge/harness.js";
import { initInfo } from "../../src/session.js";
import { glyphs } from "../../src/tui/theme.js";
import { expectDisconnect, expectedDisconnectReason, quitGuards } from "../../src/tui/page.js";
import { trackTimers } from "./services.timers.js";

// ---- a scripted systemd ------------------------------------------------------------

const M = "/org/freedesktop/systemd1";
const MANAGER = "org.freedesktop.systemd1.Manager";
const UNIT = "org.freedesktop.systemd1.Unit";

/** sd_bus_path_encode()'s label escaping: everything but [A-Za-z] (and digits after the first byte) as _xx. */
function escapeLabel(name: string): string {
    if (!name)
        return "_";
    return [...Buffer.from(name, "utf8")].map((byte, i) => {
        const c = String.fromCharCode(byte);
        return /[A-Za-z]/.test(c) || (i > 0 && /[0-9]/.test(c)) ? c : "_" + byte.toString(16).padStart(2, "0");
    }).join("");
}

function unitPath(id: string): string {
    return `${M}/unit/${escapeLabel(id)}`;
}

function v(t: string, value: unknown) {
    return { t, v: value };
}

interface FakeUnit {
    readonly id: string;
    readonly description?: string;
    /** LoadState; default "loaded". */
    readonly load?: string;
    /** ActiveState; default "inactive". */
    readonly active?: string;
    readonly sub?: string;
    /** The ListUnitFiles state; null or absent: no unit file of its own (template instance, not found). */
    readonly file?: string | null;
    /** Only a unit file: not in ListUnits (LoadUnit/GetAll still find it, as systemd loads it then). */
    readonly unloaded?: boolean;
    /** Further names: each is also an alias unit file, and LoadUnit resolves it to this unit. */
    readonly aliases?: readonly string[];
    /** Unit interface overrides. */
    readonly unit?: JsonObject;
    readonly service?: JsonObject;
    readonly socket?: JsonObject;
    readonly timer?: JsonObject;
}

function subState(u: FakeUnit): string {
    return u.sub ?? (u.active === "active" ? "running" : u.active === "failed" ? "failed" : "dead");
}

function unitProperties(u: FakeUnit): JsonObject {
    return {
        Id: u.id,
        Names: v("as", [u.id, ...u.aliases ?? []]),
        Description: u.description ?? u.id,
        LoadState: u.load ?? "loaded",
        ActiveState: u.active ?? "inactive",
        SubState: subState(u),
        UnitFileState: u.file ?? "",
        FragmentPath: u.load === "not-found" ? "" : `/usr/lib/systemd/system/${u.id}`,
        SourcePath: "",
        DropInPaths: v("as", []),
        CanReload: false,
        LoadError: v("(ss)", ["", ""]),
        Job: v("(uo)", [0, "/"]),
        ActiveEnterTimestamp: v("t", u.active === "active" ? 1_789_922_620_466_992 : 0),
        ActiveExitTimestamp: v("t", 0),
        InactiveEnterTimestamp: v("t", u.active === "active" ? 0 : 1_789_922_620_466_992),
        InactiveExitTimestamp: v("t", 0),
        Conditions: v("a(sbbsi)", []),
        Asserts: v("a(sbbsi)", []),
        Triggers: v("as", []),
        TriggeredBy: v("as", []),
        Requires: v("as", []),
        WantedBy: v("as", []),
        RequiredBy: v("as", []),
        BoundBy: v("as", []),
        ConsistsOf: v("as", []),
        ...u.unit,
    };
}

interface ManagerOptions {
    readonly units: readonly FakeUnit[];
    /** Extra ListUnitFiles rows: [path, state]. */
    readonly files?: readonly (readonly [string, string])[];
    /** Manager methods added or replaced: the actions. */
    readonly methods?: Record<string, MethodSpec>;
}

/** One systemd manager's object tree: the manager, plus an object per unit. */
function managerTree(options: ManagerOptions): Record<string, Record<string, unknown>> {
    const listed = options.units.filter(u => !u.unloaded);
    const listUnits = listed.map(u => [
        u.id, u.description ?? u.id, u.load ?? "loaded", u.active ?? "inactive", subState(u), "", unitPath(u.id), 0, "", "/",
    ]);
    const files = [
        ...options.units.filter(u => u.file).map(u => [`/usr/lib/systemd/system/${u.id}`, u.file!]),
        ...options.units.flatMap(u => (u.aliases ?? []).map(alias => [`/etc/systemd/system/${alias}`, "alias"])),
        ...options.files ?? [],
    ];
    const loadUnit = options.units.flatMap(u => [u.id, ...u.aliases ?? []].map(name => ({ args: [name], reply: [unitPath(u.id)] })));
    const tree: Record<string, Record<string, unknown>> = {
        [M]: {
            [MANAGER]: {
                properties: { Version: "252" },
                methods: {
                    Subscribe: { reply: [] },
                    ListUnits: { reply: [listUnits], out: ["a(ssssssouso)"] },
                    ListUnitFiles: { reply: [files], out: ["a(ss)"] },
                    LoadUnit: { error: ["org.freedesktop.DBus.Error.InvalidArgs", ["Unit name is not valid."]], byArgs: loadUnit },
                    ListUnitsByPatterns: { reply: [[]], out: ["a(ssssssouso)"] },
                    Reload: {
                        reply: [],
                        // systemd: Reloading(true), every unit re-created, Reloading(false), then the reply.
                        effects: [
                            { signal: [M, MANAGER, "Reloading", [true]], beforeReply: true },
                            { signal: [M, MANAGER, "Reloading", [false]], beforeReply: true, delayMs: 20 },
                        ],
                    },
                    ...options.methods,
                },
            },
        },
    };
    for (const u of options.units) {
        const object: Record<string, unknown> = { [UNIT]: { properties: unitProperties(u) } };
        if (u.service)
            object["org.freedesktop.systemd1.Service"] = { properties: u.service };
        if (u.socket)
            object["org.freedesktop.systemd1.Socket"] = { properties: u.socket };
        if (u.timer)
            object["org.freedesktop.systemd1.Timer"] = { properties: u.timer };
        tree[unitPath(u.id)] = object;
    }
    return tree;
}

/** A method that queues job `id` for `unitId`, which ends with `result`; `before` effects land first. */
function jobMethod(id: number, unitId: string, result = "done", options: {
    delayMs?: number, beforeReply?: boolean, before?: Effect[],
} = {}): MethodSpec {
    const job = `${M}/job/${id}`;
    return {
        reply: [job],
        out: ["o"],
        effects: [
            ...options.before ?? [],
            {
                signal: [M, MANAGER, "JobRemoved", [id, job, unitId, result]],
                delayMs: options.delayMs ?? 30,
                ...(options.beforeReply ? { beforeReply: true } : {}),
            },
        ],
    };
}

/** A unit's run state changing, as systemd announces it. */
function becomes(unitId: string, active: string, sub: string): Effect {
    return { properties: [unitPath(unitId), UNIT, { ActiveState: active, SubState: sub }], delayMs: 10 };
}

interface Setup {
    readonly system: ManagerOptions;
    /** The user's own manager; absent: no session bus at all. */
    readonly user?: ManagerOptions;
    /** Spawn patterns tried before the defaults (journal: nothing, follow stays open). */
    readonly spawn?: (SpawnResult & { match: string })[];
    readonly clocks?: string;
}

function scenario(setup: Setup): MockScenario {
    return {
        dbus: {
            system: managerTree(setup.system),
            ...(setup.user ? { session: managerTree(setup.user) } : {}),
        } as MockScenario["dbus"],
        ...(setup.user ? {} : { dbusOwners: { session: { "org.freedesktop.systemd1": null } } }),
        spawnPatterns: [
            ...setup.spawn ?? [],
            { match: "^sh -ec ", stdout: setup.clocks ?? "1790984275157465 1061671516166\n" },
            { match: "^journalctl .*--reverse", stdout: "" },
            { match: "^journalctl .*--follow", keepOpen: true },
        ],
    };
}

const BASIC: FakeUnit[] = [
    {
        id: "crond.service", description: "Command Scheduler", active: "active", file: "enabled",
        unit: {
            CanReload: true,
            WantedBy: v("as", ["multi-user.target"]),
            Requires: v("as", ["system.slice", "sysinit.target"]),
            RequiredBy: v("as", ["dependent.service"]),
        },
        service: {
            MainPID: v("u", 1775), MemoryCurrent: v("t", 1277952), Result: "success", NRestarts: v("u", 0),
            ExecMainCode: v("i", 0), ExecMainStatus: v("i", 0),
        },
    },
    { id: "sshd.service", description: "OpenSSH server daemon", active: "active", file: "enabled" },
    { id: "dbus-broker.service", description: "D-Bus System Message Bus", active: "active", file: "enabled", aliases: ["dbus.service"] },
    {
        id: "cups.service", load: "masked", active: "inactive", file: "masked",
        unit: { LoadError: v("(ss)", ["org.freedesktop.systemd1.UnitMasked", "Unit cups.service is masked."]) },
    },
    {
        id: "podman-restart.service", description: "Podman Start All Containers", active: "failed", file: "enabled",
        service: { Result: "exit-code", ExecMainCode: v("i", 1), ExecMainStatus: v("i", 125) },
    },
    // A template instance: loaded, but no unit file of its own (its template's is skipped).
    { id: "getty@tty1.service", description: "Getty on tty1", active: "active", unit: { UnitFileState: "enabled" } },
    { id: "foo.service", description: "Foo Daemon", unloaded: true, file: "disabled" },
    { id: "multi-user.target", description: "Multi-User System", active: "active", file: "static" },
    {
        id: "syslog.service", load: "not-found", active: "inactive",
        unit: { LoadError: v("(ss)", ["org.freedesktop.systemd1.NoSuchUnit", "Unit syslog.service not found."]) },
    },
];

const BASIC_FILES: [string, string][] = [["/usr/lib/systemd/system/getty@.service", "enabled"]];

/**
 * Timers as of now: dnf-makecache is monotonic only (OnUnitInactiveSec=,
 * OnBootSec=: no realtime next elapse), due in 23 minutes; fstrim is a
 * calendar timer due in 2 hours. `clocks` is what the host's clocks script prints.
 */
function timers(): { units: FakeUnit[], clocks: string } {
    const realtime = Date.now() * 1000;
    const monotonic = 5_000_000_000;
    return {
        clocks: `${realtime} ${monotonic}\n`,
        units: [
            {
                id: "dnf-makecache.timer", description: "dnf makecache --timer", active: "active", sub: "waiting", file: "enabled",
                unit: { Triggers: v("as", ["dnf-makecache.service"]) },
                timer: {
                    Unit: "dnf-makecache.service",
                    TimersMonotonic: v("a(stt)", [["OnUnitInactiveUSec", 3_600_000_000, 1], ["OnBootUSec", 600_000_000, 600_000_000]]),
                    TimersCalendar: v("a(sst)", []),
                    NextElapseUSecRealtime: v("t", 0),
                    NextElapseUSecMonotonic: v("t", monotonic + (23 * 60 + 30) * 1e6),
                    LastTriggerUSec: v("t", realtime - (3 * 3600 + 30) * 1e6),
                },
            },
            {
                id: "fstrim.timer", description: "Discard unused blocks once a week", active: "active", sub: "waiting", file: "enabled",
                timer: {
                    Unit: "fstrim.service",
                    TimersMonotonic: v("a(stt)", []),
                    TimersCalendar: v("a(sst)", [["OnCalendar", "weekly", 0]]),
                    NextElapseUSecRealtime: v("t", realtime + (2 * 3600 + 30) * 1e6),
                    NextElapseUSecMonotonic: v("t", 0),
                    LastTriggerUSec: v("t", 0),
                },
            },
            { id: "unloaded.timer", unloaded: true, file: "disabled" },
        ],
    };
}

function basic(methods: Record<string, MethodSpec> = {}, extra: Partial<Setup> = {}): MockScenario {
    return scenario({ system: { units: BASIC, files: BASIC_FILES, methods }, ...extra });
}

// ---- the harness -----------------------------------------------------------------------

let mock: MockBridge | null = null;

afterEach(() => {
    cleanup();
    mock?.close();
    mock = null;
    // Module state a test may have set: never carried into the next one.
    expectDisconnect(null);
});

interface StartOptions {
    readonly columns?: number;
    readonly rows?: number;
    readonly allowed?: boolean;
    readonly params?: object;
    /** Persistent state left by an earlier visit. */
    readonly seed?: Record<string, unknown>;
    /** Add a "hints: ..." line with the footer's key hints. */
    readonly showHints?: boolean;
    /** Frame the page in panels, as the shell does at this size. */
    readonly panels?: boolean;
}

async function start(s: MockScenario, options: StartOptions = {}): Promise<RenderedPage> {
    mock = await startMock(s);
    await initInfo();
    return renderPage(ServicesPage, {
        columns: options.columns ?? 120,
        rows: options.rows ?? 30,
        allowed: options.allowed ?? false,
        ...(options.params ? { params: { pageId: "services", value: options.params } } : {}),
        ...(options.seed ? { seed: options.seed } : {}),
        ...(options.showHints ? { showHints: true } : {}),
        ...(options.panels ? { panels: true } : {}),
    });
}

/** Search the list for a unit and open its details. */
async function openUnitFromList(r: RenderedPage, name: string): Promise<void> {
    await r.waitFor("podman-restart");
    await r.press("/", ...name.split(""), keys.enter);
    await r.waitFor(f => f.split("\n").some(line => line.startsWith(glyphs.pointer) && line.slice(4).startsWith(name + " ")));
    await r.press(keys.enter);
    await r.waitFor(f => f.includes("Actions") && f.includes(`${name}.service`));
}

/** The selected list row. */
function selectedRow(frame: string): string {
    return frame.split("\n").find(line => line.startsWith(glyphs.pointer)) ?? "";
}

/** The footer hints line (start with showHints). */
function hintsLine(frame: string): string {
    return frame.split("\n").find(line => line.startsWith("hints: ")) ?? "";
}

/** The list row of a unit (by its shown name), if it is on screen. */
function rowOf(frame: string, name: string): string | undefined {
    return frame.split("\n").find(line => line.slice(4).startsWith(name + " ") || line.slice(4) === name);
}

interface Call {
    readonly channel: string;
    readonly open: JsonObject;
    readonly path: string;
    readonly iface: string;
    readonly method: string;
    readonly args: unknown[];
    readonly type: string | undefined;
}

/** Every D-Bus method call the page sent, in order, with the options of the channel it went on. */
function calls(): Call[] {
    const opens = new Map<string, JsonObject>();
    const out: Call[] = [];
    for (const entry of mock!.received()) {
        if (entry.control?.command === "open" && entry.control.payload === "dbus-json3") {
            opens.set(String(entry.control.channel), entry.control);
            continue;
        }
        const open = entry.data !== undefined ? opens.get(entry.channel) : undefined;
        if (!open)
            continue;
        const message = JSON.parse(entry.data!) as JsonObject;
        if (!Array.isArray(message.call))
            continue;
        const [path, iface, method, args] = message.call as [string, string, string, unknown[]];
        out.push({ channel: entry.channel, open, path, iface, method, args, type: message.type as string | undefined });
    }
    return out;
}

const ACTION_METHODS = new Set([
    "StartUnit", "StopUnit", "RestartUnit", "ReloadUnit", "ResetFailedUnit",
    "EnableUnitFiles", "DisableUnitFiles", "MaskUnitFiles", "UnmaskUnitFiles", "Reload",
]);

/** The state-changing calls, in order: [method, args, signature]. */
function actionCalls(): [string, unknown[], string | undefined][] {
    return calls().filter(c => ACTION_METHODS.has(c.method)).map(c => [c.method, c.args, c.type]);
}

/** What the client sent on dbus channels other than calls: add-match rules and watches, per channel. */
function subscriptions(): { channel: string, open: JsonObject, kind: "add-match" | "watch", rule: unknown }[] {
    const opens = new Map<string, JsonObject>();
    const out: { channel: string, open: JsonObject, kind: "add-match" | "watch", rule: unknown }[] = [];
    for (const entry of mock!.received()) {
        if (entry.control?.command === "open" && entry.control.payload === "dbus-json3")
            opens.set(String(entry.control.channel), entry.control);
        const open = entry.data !== undefined ? opens.get(entry.channel) : undefined;
        if (!open)
            continue;
        const message = JSON.parse(entry.data!) as JsonObject;
        if (message["add-match"] !== undefined)
            out.push({ channel: entry.channel, open, kind: "add-match", rule: message["add-match"] });
        if (message.watch !== undefined)
            out.push({ channel: entry.channel, open, kind: "watch", rule: message.watch });
    }
    return out;
}

function journalOpens(): JsonObject[] {
    return mock!.opened("stream").filter(open => (open.spawn as string[])[0] === "journalctl");
}

function entry(cursor: string, usec: number, message: string, extra: JsonObject = {}): string {
    return JSON.stringify({
        __CURSOR: cursor, __REALTIME_TIMESTAMP: String(usec), _BOOT_ID: "b1", PRIORITY: "6",
        SYSLOG_IDENTIFIER: "crond", MESSAGE: message, ...extra,
    });
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text inside a dialog's border, its wrapped lines joined: what the user reads. */
function dialogText(frame: string): string {
    return frame.split("\n")
        .filter(line => /┤ .* ├/.test(line) || line.indexOf("│") !== line.lastIndexOf("│"))
        // The title is set into the top border: "┌───┤ Title ├───┐".
        .map(line => /┤ (.*) ├/.exec(line)?.[1] ?? line.slice(line.indexOf("│") + 1, line.lastIndexOf("│")).trim())
        .filter(Boolean)
        .join(" ");
}

const inDialog = (text: string) => (frame: string) => dialogText(frame).includes(text);
/** An action's question, once Enter answers it: Enter is offered only after it has been up a moment. */
const asking = (text: string) => (frame: string) => inDialog(text)(frame) && /< .+ > {3}< Cancel >/.test(dialogText(frame));

// ---- the list -----------------------------------------------------------------------------

describe("the unit list", () => {
    it("frames the tabs and the table in panels where there is room, and the details in one", async () => {
        const r = await start(basic(), { panels: true });
        const frame = await r.waitFor("podman-restart");
        const lines = frame.split("\n").slice(0, 29);
        expect(lines[0]).toMatch(/^.{2}. Units .+/);
        expect(lines[1]).toContain("[Services");
        // Each panel ends in its bottom border and the row of its shadow.
        expect(lines[3]!.trimEnd()).toMatch(/^[^ ]{119}$/);
        expect(lines[4]!.trim()).toBe("");
        expect(lines[5]).toMatch(/^.{2}. Services .+ System .{2}$/);
        expect(lines[6]).toMatch(/^. +Unit .*State +Startup +.$/);
        // The table fills its panel to the end of the page.
        expect(lines[27]!.trimEnd()).toMatch(/^[^ ]{119}$/);
        expect(lines[28]!.trim()).toBe("");
        // Nothing reaches the last column: it is the shadow's.
        expect(lines.every(line => line.trimEnd().length <= 119)).toBe(true);
        expect(lines.find(line => line.includes(" podman-restart "))).toMatch(/^.. . podman-restart .*Enabled +.$/);

        await r.press(keys.enter);
        const details = await r.waitFor("podman-restart.service");
        const shown = details.split("\n").slice(0, 29);
        expect(shown[0]).toMatch(/^.{2}. Unit .+/);
        expect(shown[1]).toMatch(/^.podman-restart\.service/);
        expect(shown[27]!.trimEnd()).toMatch(/^[^ ]{119}$/);
        await r.press(keys.escape);
        await r.waitFor("[Services");
    });

    it("merges loaded units and unit files the way upstream does", async () => {
        const r = await start(basic());
        const frame = await r.waitFor("podman-restart");
        const lines = frame.split("\n");

        // Failed first, then by name; not-found units and templates are not listed.
        const names = ["crond", "cups", "dbus", "dbus-broker", "foo", "getty@tty1", "sshd"]
            .sort((a, b) => `${a}.service`.localeCompare(`${b}.service`));
        const order = ["podman-restart", ...names].map(name => lines.findIndex(line => line === rowOf(frame, name)));
        expect(order.every(i => i >= 0)).toBe(true);
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(frame).not.toContain("syslog");
        expect(frame).not.toMatch(/getty@ /);

        expect(rowOf(frame, "podman-restart")).toMatch(new RegExp(`${glyphs.cross} podman-restart +Podman Start All Containers +Failed to start +Enabled`));
        expect(rowOf(frame, "crond")).toMatch(/crond +Command Scheduler +Running +Enabled/);
        // Masked: its description is its name, which upstream does not repeat.
        expect(rowOf(frame, "cups")).toMatch(/ cups +Not running +Masked/);
        // An alias has no run state of its own, just its file state.
        expect(rowOf(frame, "dbus")).toMatch(/^ {4}dbus +Alias *$/);
        // A unit file nothing loaded: not running, and no description to show.
        expect(rowOf(frame, "foo")).toMatch(/foo +Not running +Disabled/);
        expect(rowOf(frame, "foo")).not.toContain("Foo Daemon");
        // A template instance has no unit file, so no startup state.
        expect(rowOf(frame, "getty@tty1")).toMatch(/getty@tty1 +Getty on tty1 +Running *$/);

        expect(frame).toContain("[Services!]");
        expect(frame).toMatch(/8 services · 1 failed/);
    });

    it("switches unit types with the arrow keys", async () => {
        const r = await start(basic());
        await r.waitFor("podman-restart");
        await r.press(keys.right);
        let frame = await r.waitFor("[Targets]");
        expect(rowOf(frame, "multi-user")).toMatch(/multi-user +Multi-User System +Running +Static/);
        expect(frame).toMatch(/^1 target/m);
        await r.press(keys.left, keys.left);
        frame = await r.waitFor("[Paths]");
        expect(frame).toContain("No paths.");
        await r.press(keys.right);
        await r.waitFor("[Services!]");
    });

    it("filters by name and description as you type", async () => {
        const r = await start(basic());
        await r.waitFor("podman-restart");
        await r.press("/");
        await r.waitFor("Search:");
        await r.press("s", "s", "h");
        let frame = await r.waitFor(f => !f.includes("crond") && f.includes("sshd"));
        await r.press(keys.enter);
        frame = await r.waitFor("/ssh");
        expect(frame).toMatch(/1 of 8 services · 1 failed · \/ssh/);
        // Esc in the list clears the search.
        await r.press(keys.escape);
        frame = await r.waitFor(f => f.includes("crond") && !f.includes("/ssh"));

        await r.press("/", ..."SCHEDULER".split(""), keys.enter);
        frame = await r.waitFor("/SCHEDULER");
        expect(rowOf(frame, "crond")).toBeDefined();
        expect(rowOf(frame, "sshd")).toBeUndefined();

        await r.press("c");
        await r.waitFor(f => f.includes("sshd") && !f.includes("/SCHEDULER"));
        await r.press("/", "z", "z", "z", keys.enter);
        await r.waitFor("No matching units. Press c to clear the filters.");
    });

    it("shows only the failed units with F, and c clears every filter", async () => {
        const r = await start(basic());
        await r.waitFor("podman-restart");
        await r.press("F");
        let frame = await r.waitFor("failed only");
        expect(rowOf(frame, "podman-restart")).toBeDefined();
        expect(rowOf(frame, "crond")).toBeUndefined();
        expect(frame).toMatch(/1 of 8 services · 1 failed · failed only/);
        await r.press("c");
        frame = await r.waitFor(f => !f.includes("failed only") && f.includes("crond"));
    });

    it("filters by state labels, letting units with no such state through", async () => {
        const r = await start(basic());
        await r.waitFor("podman-restart");
        await r.press("f");
        let frame = await r.waitFor("Filter units");
        expect(frame).toContain("Failed units only");
        expect(frame).toContain("Failed to start"); // a state present on this host
        expect(frame).toContain("Alias");
        // Failed only, Running, Not running, Failed to start, Enabled, Disabled.
        await r.press(keys.down, keys.down, keys.down, keys.down, keys.down, " ", keys.enter);
        frame = await r.waitFor(f => !f.includes("Filter units") && f.includes("Disabled"));
        // foo is disabled; getty@tty1 has no unit file state at all, so it passes (upstream G8).
        expect(rowOf(frame, "foo")).toBeDefined();
        expect(rowOf(frame, "getty@tty1")).toBeDefined();
        expect(rowOf(frame, "crond")).toBeUndefined();
        expect(rowOf(frame, "dbus")).toBeUndefined();
        expect(frame).toMatch(/2 of 8 services · 1 failed · Disabled/);

        // Esc leaves the dialog without applying anything.
        await r.press("f");
        await r.waitFor("Filter units");
        await r.press(" ", keys.escape);
        frame = await r.waitFor(f => !f.includes("Filter units"));
        expect(frame).not.toContain("failed only");
    });

    it("offers the user's own units when the session bus answers", async () => {
        const r = await start(scenario({
            system: { units: BASIC.filter(u => u.id !== "podman-restart.service") },
            user: {
                units: [
                    { id: "podman-restart.service", description: "Podman Start All Containers", active: "failed", file: "enabled" },
                    { id: "pipewire.service", description: "PipeWire Multimedia Service", active: "active", file: "static" },
                ],
            },
        }));
        let frame = await r.waitFor(f => f.includes("[System]") && f.includes("crond"));
        expect(frame).toMatch(/\[System\] User\s*$/m);
        await r.press("o");
        frame = await r.waitFor(f => f.includes("[User]") && f.includes("pipewire"));
        expect(rowOf(frame, "podman-restart")).toMatch(/Failed to start/);
        expect(rowOf(frame, "crond")).toBeUndefined();
        // The user's manager: the session bus, as the login user, never superuser.
        const user = calls().find(c => c.method === "ListUnits" && c.open.bus === "session")!;
        expect(user.open).toMatchObject({ name: "org.freedesktop.systemd1", bus: "session" });
        expect(user.open.superuser).toBeUndefined();
        await r.press("o");
        await r.waitFor(f => f.includes("[System]") && f.includes("crond"));
    });

    it("has no owner toggle without a session bus", async () => {
        const r = await start(basic());
        const frame = await r.waitFor("podman-restart");
        expect(frame).not.toContain("[System]");
        // The probe of the session bus has been answered (refused) before o is pressed.
        await mock!.waitForReceived(e => e.control?.command === "open" && e.control.bus === "session");
        await new Promise(resolve => setTimeout(resolve, 50));
        await r.press("o");
        await r.waitFor("status: warning: Your user session's systemd is not reachable");
    });

    it("lists timers with their next and last run", async () => {
        const { units, clocks } = timers();
        const r = await start(scenario({ system: { units }, clocks }));
        await r.waitFor("[Services]");
        await r.press(keys.right, keys.right, keys.right);
        let frame = await r.waitFor(f => f.includes("[Timers]") && f.includes("in 23 minutes"));
        expect(rowOf(frame, "dnf-makecache")).toMatch(/in 23 minutes .*3 hours ago/);
        expect(rowOf(frame, "fstrim")).toMatch(/in 2 hours .*n\/a/);
        expect(rowOf(frame, "unloaded")).toMatch(/unloaded +Not running +Disabled *$/);
        // One GetAll per loaded timer, and only now that the tab is shown.
        const timerReads = calls().filter(c => c.method === "GetAll" && (c.args as string[])[0] === "org.freedesktop.systemd1.Timer");
        expect(timerReads.map(c => c.path).sort()).toEqual([unitPath("dnf-makecache.timer"), unitPath("fstrim.timer")].sort());

        // The details: when, how, and what it starts.
        await r.press(keys.enter);
        frame = await r.waitFor("Schedule");
        expect(frame).toMatch(/Next run +\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \(in 23 minutes\)/);
        expect(frame).toMatch(/Last trigger +\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \(3 hours ago\)/);
        expect(frame).toMatch(/Schedule +OnUnitInactiveSec=1h/);
        expect(frame).toContain("OnBootSec=10min");
        expect(frame).toMatch(/Triggers +dnf-makecache\.service/);
        expect(frame).not.toContain("Activates"); // the same unit, said once
    });

    it("works at the smallest page size", async () => {
        const r = await start(basic(), { columns: 50, rows: 11 });
        const frame = await r.waitFor("podman-restart");
        const lines = frame.split("\n");
        expect(lines.length).toBeLessThanOrEqual(11);
        for (const line of lines)
            expect(line.length).toBeLessThanOrEqual(50);
        expect(frame).toContain("[Services!]");
        await r.press(keys.down, keys.enter);
        await r.waitFor("crond.service");
    });

    it("keeps the next run on the Timers tab at the smallest page size", async () => {
        const { units, clocks } = timers();
        const long: FakeUnit = {
            id: "systemd-tmpfiles-clean.timer", description: "Daily Cleanup of Temporary Directories", active: "active",
            sub: "waiting", file: "static",
            timer: { NextElapseUSecRealtime: v("t", Date.now() * 1000 + 5 * 3600e6 + 30e6), NextElapseUSecMonotonic: v("t", 0), LastTriggerUSec: v("t", 0) },
        };
        let r = await start(scenario({ system: { units: [...units, long] }, clocks }), { columns: 50, rows: 11 });
        await r.waitFor("[Services]");
        await r.press(keys.right, keys.right, keys.right);
        let frame = await r.waitFor(f => f.includes("[Timers]") && f.includes("in 23 minutes"));
        expect(frame).toMatch(/Unit +State +Next run/);
        expect(frame.split("\n").find(line => line.includes("systemd-tmpfiles"))).toMatch(/in 5 hours/);

        // With room to spare, the name is not cut short for it.
        cleanup();
        mock?.close();
        r = await start(scenario({ system: { units: [...units, long] }, clocks }), { columns: 120, rows: 20 });
        await r.waitFor("[Services]");
        await r.press(keys.right, keys.right, keys.right);
        frame = await r.waitFor(f => f.includes("[Timers]") && f.includes("in 23 minutes"));
        expect(frame).toMatch(/systemd-tmpfiles-clean +.*in 5 hours/);
    });

    it("names the owner on the summary line when the tab bar has no room for it", async () => {
        const r = await start(scenario({
            system: { units: BASIC, files: BASIC_FILES },
            user: { units: [{ id: "pipewire.service", description: "PipeWire Multimedia Service", active: "active", file: "static" }] },
        }), { columns: 60, rows: 20 });
        // Once the user's manager has answered, the owner can change: say which one this is.
        let frame = await r.waitFor(/^System · 8 services · 1 failed/m);
        expect(frame).not.toMatch(/\[System\]/);
        await r.press("o");
        frame = await r.waitFor(/^User · 1 service$/m);
        expect(frame).toContain("pipewire");
    });

    it("moves through a long list with a held key without re-rendering the whole page per row", async () => {
        const units: FakeUnit[] = Array.from({ length: 150 }, (_, i) => ({
            id: `filler-${String(i).padStart(3, "0")}.service`, description: `Filler ${i}`, active: "active", file: "enabled",
        }));
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const r = await start(scenario({ system: { units } }));
            await r.waitFor(f => selectedRow(f).includes("filler-000"));
            // A held key: one burst, dispatched one key per render.
            r.stdin.write(keys.down.repeat(80));
            await r.waitFor(f => selectedRow(f).includes("filler-080"), 8000);
            const depth = errors.mock.calls.map(call => String(call[0])).filter(text => text.includes("Maximum update depth"));
            expect(depth).toEqual([]);
            // Where it ended up is still remembered, here and after another tab.
            await r.press(keys.right);
            await r.waitFor("[Targets]");
            await r.press(keys.left);
            const frame = await r.waitFor("[Services]");
            expect(selectedRow(frame)).toContain("filler-080");
        } finally {
            errors.mockRestore();
        }
    });

    it("fits a long error into the smallest page, keeping what to do about it", async () => {
        const reason = "Permission denied because the calling process lacks the polkit authorization required for this " +
            "action on this host, please contact your administrator or check the policy installed under " +
            "/usr/share/polkit-1/actions for the action named org.freedesktop.systemd1.manage-units again later.";
        const r = await start(scenario({
            system: { units: BASIC, methods: { ListUnits: { error: ["org.freedesktop.DBus.Error.AccessDenied", [reason]] } } },
        }), { columns: 50, rows: 11 });
        const frame = await r.waitFor("Press Ctrl+R to retry.");
        const lines = frame.split("\n");
        expect(lines.length).toBeLessThanOrEqual(11);
        // The notice starts where it should, with the beginning of the message.
        expect(lines.findIndex(line => line.trim().startsWith("Listing units failed: Permission denied"))).toBe(3);
    });

    it("ends an error that is already a sentence with one period, and offers only the way out", async () => {
        const r = await start(scenario({
            system: { units: BASIC, methods: { ListUnits: { error: ["org.freedesktop.DBus.Error.AccessDenied", ["Access denied."]] } } },
        }), { showHints: true });
        const frame = await r.waitFor("Press Ctrl+R to retry.");
        const flat = frame.replace(/\s+/g, " ");
        expect(flat).toContain("Listing units failed: Access denied. Press Ctrl+R to retry.");
        expect(flat).not.toContain("denied..");
        // Nothing to open, search or filter: the footer names what does work.
        const hints = hintsLine(frame);
        expect(hints).toContain("ctrl+r retry");
        for (const inert of ["enter open", "/ search", "f filter", "F failed only"])
            expect(hints).not.toContain(inert);
    });
});

// ---- the details ------------------------------------------------------------------------

describe("unit details", () => {
    const crondJournal = [
        { match: `^${escapeRegex("journalctl -q --lines=10 --output=json --reverse -- _SYSTEMD_UNIT=crond.service")}`,
          stdout: entry("c2", 1_790_984_000_000_000, "newer line") + "\n" + entry("c1", 1_790_983_000_000_000, "older line", { PRIORITY: "3" }) + "\n" },
        { match: `^${escapeRegex("journalctl -q --no-tail --output=json --after-cursor=c2 --follow")}`,
          chunks: [{ data: entry("c3", 1_790_985_000_000_000, "followed line") + "\n", delayMs: 200 }], keepOpen: true },
    ];

    it("shows the state, the files, the numbers and the recent logs of a unit", async () => {
        const r = await start(basic({}, { spawn: crondJournal }));
        await r.waitFor("podman-restart");
        await r.press(keys.down, keys.enter);
        let frame = await r.waitFor("Command Scheduler");
        frame = await r.waitFor("followed line");
        expect(frame).toMatch(/^crond\.service +Command Scheduler +system$/m);
        expect(frame).toMatch(/Status +! Read-only +Requires administrative access to edit \(press A\)/);
        expect(frame).toMatch(/● Running +active \(running\) since \d{4}-\d\d-\d\d/);
        expect(frame).toContain("● Automatically starts");
        expect(frame).toMatch(/Path +\/usr\/lib\/systemd\/system\/crond\.service/);
        expect(frame).toMatch(/Main PID +1775/);
        expect(frame).toMatch(/Memory +1\.28 MB/);
        expect(frame).toMatch(/Actions +none without administrative access/);

        // Newest first: the followed entry lands on top; an error is marked.
        const lines = frame.split("\n");
        const at = (text: string) => lines.findIndex(line => line.includes(text));
        expect(at("Recent logs")).toBeGreaterThan(at("Actions"));
        expect(at("followed line")).toBeLessThan(at("newer line"));
        expect(at("newer line")).toBeLessThan(at("older line"));
        expect(lines[at("older line")]).toContain(glyphs.warning);
        expect(lines[at("newer line")]).toContain("crond: newer line");

        // Exactly upstream's unit match, read at the current privilege ("try"),
        // then followed strictly after the newest entry shown.
        const matches = ["_SYSTEMD_UNIT=crond.service", "+", "COREDUMP_UNIT=crond.service", "+", "UNIT=crond.service"];
        const [page, follow] = journalOpens();
        expect(page!.spawn).toEqual(["journalctl", "-q", "--lines=10", "--output=json", "--reverse", "--", ...matches]);
        expect(follow!.spawn).toEqual(["journalctl", "-q", "--no-tail", "--output=json", "--after-cursor=c2", "--follow", "--", ...matches]);
        expect(page).toMatchObject({ superuser: "try", err: "message" });
        expect(follow).toMatchObject({ superuser: "try", err: "message" });
        expect(follow!.pty).toBeUndefined();

        // The follow ends with the view.
        await r.press(keys.escape);
        await r.waitFor("podman-restart");
        await mock!.waitForReceived(e => e.control?.command === "close" && e.control.channel === follow!.channel);
    });

    it("folds relationships, opens the unit's logs, and goes back to the same row", async () => {
        const r = await start(basic());
        await r.waitFor("podman-restart");
        await r.press(keys.down, keys.enter);
        let frame = await r.waitFor("Relationships");
        expect(frame).toMatch(/Relationships +3 kinds \(g to show\)/);
        expect(frame).not.toContain("Wanted by");
        await r.press("g");
        frame = await r.waitFor("Wanted by");
        expect(frame).toMatch(/Requires +system\.slice, sysinit\.target/);
        expect(frame).toMatch(/Required by +dependent\.service/);
        expect(frame).toMatch(/Wanted by +multi-user\.target/);

        await r.press("l");
        expect(r.navigations).toEqual([["logs", { unit: { name: "crond.service", user: false }, priority: "debug" }]]);

        await r.press(keys.escape);
        frame = await r.waitFor("podman-restart");
        expect(frame.split("\n").find(line => line.startsWith(glyphs.pointer))).toMatch(/crond +Command Scheduler/);
    });

    it("resolves an alias to the unit it names", async () => {
        const r = await start(basic());
        await r.waitFor("podman-restart");
        await r.press("/", "d", "b", "u", "s", keys.enter);
        await r.waitFor("/dbus");
        // dbus (the alias) sorts before or after dbus-broker; open the alias.
        let frame = r.lastFrame();
        const selected = frame.split("\n").find(line => line.startsWith(glyphs.pointer))!;
        if (!/ dbus +Alias/.test(selected))
            await r.press(keys.down);
        await r.press(keys.enter);
        frame = await r.waitFor("Opened as");
        expect(frame).toMatch(/^dbus-broker\.service +D-Bus System Message Bus/m);
        expect(frame).toMatch(/Opened as +dbus\.service \(an alias of dbus-broker\.service\)/);
        expect(frame).toMatch(/Aliases +dbus\.service/);
        const load = calls().filter(c => c.method === "LoadUnit");
        expect(load.at(-1)).toMatchObject({ args: ["dbus.service"], type: "s" });
    });

    it("ends a load failure that is already a sentence with one period", async () => {
        // basic()'s LoadUnit refuses unknown names as systemd does: "Unit name is not valid."
        const r = await start(basic(), { params: { unit: "ghost.service" } });
        const frame = await r.waitFor("Loading ghost.service failed");
        const flat = frame.replace(/\s+/g, " ");
        expect(flat).toContain("Loading ghost.service failed: Unit name is not valid. Press Esc to go back.");
        expect(flat).not.toContain("valid..");
    });

    it("explains a unit that does not exist", async () => {
        const r = await start(basic(), { params: { unit: "syslog.service" } });
        const frame = await r.waitFor("not found");
        expect(frame).toMatch(/Error +✗ Unit syslog\.service not found\./);
        expect(frame).toMatch(/Load state: not-found/);
        expect(frame).toMatch(/Actions +none without administrative access|Actions +none for a unit that does not exist/);
        expect(frame).not.toContain("Static");
    });

    it("follows the unit's state as systemd signals it", async () => {
        const r = await start(basic({
            // Not an action: something else stops crond, a moment after the page asked for the unit files.
            ListUnitFiles: {
                reply: [[["/usr/lib/systemd/system/crond.service", "enabled"]]], out: ["a(ss)"],
                effects: [{ properties: [unitPath("crond.service"), UNIT, { ActiveState: "inactive", SubState: "dead" }], delayMs: 600 }],
            },
        }));
        await r.waitFor("crond");
        await r.press(keys.down, keys.enter);
        await r.waitFor(f => /Status/.test(f) && f.includes("crond.service"));
        const frame = await r.waitFor(f => /○ Not running +inactive \(dead\)/.test(f), 4000);
        expect(frame).not.toMatch(/● Running/);
    });

    it("dates a monotonic timer opened straight from another page", async () => {
        const { units, clocks } = timers();
        const r = await start(scenario({ system: { units }, clocks }), { params: { unit: "dnf-makecache.timer" } });
        await r.waitFor("Schedule");
        await r.waitFor(/Next run +\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \(in 23 minutes\)/);
        // Only the host's clocks were read for it, not every timer's state.
        const clockReads = mock!.opened("stream").filter(open => (open.spawn as string[])[0] === "sh");
        expect(clockReads).toHaveLength(1);
        const timerReads = calls().filter(c => c.method === "GetAll" && (c.args as string[])[0] === "org.freedesktop.systemd1.Timer");
        expect(timerReads.map(c => c.path)).toEqual([unitPath("dnf-makecache.timer")]);
    });

    it("offers the logs key only once it knows the unit", async () => {
        const slow: MethodSpec = {
            error: ["org.freedesktop.DBus.Error.InvalidArgs", ["Unit name is not valid."]],
            byArgs: [{ args: ["slowpoke.service"], reply: [unitPath("slowpoke.service")], delayMs: 60_000 }],
        };
        let r = await start(basic({ LoadUnit: slow }), { params: { unit: "slowpoke.service" }, showHints: true });
        let frame = await r.waitFor("Loading slowpoke.service");
        expect(hintsLine(frame)).toContain("esc back");
        expect(hintsLine(frame)).not.toContain("l logs");
        await r.press("l");
        expect(r.navigations).toEqual([]);
        cleanup();
        mock?.close();

        r = await start(basic({ LoadUnit: slow }), { params: { unit: "ghost.service" }, showHints: true });
        frame = await r.waitFor("Loading ghost.service failed");
        expect(hintsLine(frame)).not.toContain("l logs");

        cleanup();
        mock?.close();
        r = await start(basic(), { params: { unit: "crond.service" }, showHints: true });
        frame = await r.waitFor(f => f.includes("Command Scheduler") && hintsLine(f).includes("l logs"));
    });

    it("leaves nothing running once it is closed: no poll, no journal read", async () => {
        const timers = trackTimers();
        try {
            const r = await start(basic({ RestartUnit: jobMethod(9, "crond.service") }, {
                // The newest entries are still being read when the details close.
                spawn: [{ match: "^journalctl .*--reverse", keepOpen: true }],
            }), { allowed: true });
            await openUnitFromList(r, "crond");
            // A running service: its memory is polled.
            await vi.waitFor(() => expect(timers.created("interval")).toBe(1));
            const reverse = journalOpens().find(open => (open.spawn as string[]).includes("--reverse"))!;
            expect(reverse).toBeDefined();

            // An action follows its job with a poll of its own, until the job is done.
            await r.press("r");
            await r.waitFor(asking("Restart crond.service now?"));
            await r.press(keys.enter);
            await r.waitFor("status: success: Restarted crond.service");
            expect(timers.created("interval")).toBe(2);

            await r.press(keys.escape);
            await r.waitFor("[Services!]");
            await vi.waitFor(() => expect(mock!.controls("close").map(c => c.channel)).toContain(reverse.channel));
            expect(timers.pending().filter(t => t.startsWith("interval"))).toEqual([]);
        } finally {
            timers.restore();
        }
    });

    it("lets go of its signal subscriptions when it closes", async () => {
        const live = new Set<object>();
        const original = UnitStore.prototype.onSignal;
        const spy = vi.spyOn(UnitStore.prototype, "onSignal").mockImplementation(function (this: UnitStore, match, handler) {
            const subscription = original.call(this, match, handler);
            const token = {};
            live.add(token);
            return { remove() { live.delete(token); subscription.remove(); } };
        });
        try {
            const r = await start(basic());
            await r.waitFor("podman-restart");
            for (let i = 0; i < 3; i++) {
                await r.press(keys.down, keys.enter);
                await r.waitFor(f => f.includes("Status") && f.includes("Recent logs"));
                // JobRemoved, Reloading, and the unit's own PropertiesChanged.
                await vi.waitFor(() => expect(live.size).toBe(3));
                await r.press(keys.escape);
                await r.waitFor("[Services!]");
                expect(live.size).toBe(0);
            }
        } finally {
            spy.mockRestore();
        }
    });
});

// ---- params from other pages ------------------------------------------------------------

describe("navigation params", () => {
    it("opens a unit's details, then returns to its tab", async () => {
        const r = await start(basic(), { params: { unit: "multi-user.target" } });
        await r.waitFor(/^multi-user\.target +Multi-User System/m);
        await r.press(keys.escape);
        const frame = await r.waitFor("[Targets]");
        expect(frame.split("\n").find(line => line.startsWith(glyphs.pointer))).toMatch(/multi-user/);
    });

    it("opens a user unit on the user's manager", async () => {
        const r = await start(scenario({
            system: { units: BASIC },
            user: { units: [{ id: "podman-restart.service", description: "Podman Start All Containers", active: "failed", file: "enabled" }] },
        }), { params: { unit: "podman-restart.service", user: true } });
        const frame = await r.waitFor(/^podman-restart\.service +Podman Start All Containers +user$/m);
        expect(frame).toContain("Failed to start");
        // User units need no administrative access.
        expect(frame).not.toContain("Read-only");
        const load = calls().find(c => c.method === "LoadUnit")!;
        expect(load.open.bus).toBe("session");
        await r.waitFor("No log entries");
        // This user's unit only (the mock's user is uid 1000): other users' managers run units of the same names.
        expect(journalOpens()[0]!.spawn).toEqual(["journalctl", "-q", "--lines=10", "--output=json", "--reverse", "--",
            "_SYSTEMD_USER_UNIT=podman-restart.service", "_UID=1000", "+",
            "COREDUMP_USER_UNIT=podman-restart.service", "COREDUMP_UID=1000", "+",
            "USER_UNIT=podman-restart.service", "_UID=1000"]);
    });

    it("takes a bare name for a service, as systemctl does", async () => {
        const r = await start(basic(), { params: { unit: "crond" } });
        await r.waitFor(/^crond\.service +Command Scheduler/m);
        expect(calls().find(c => c.method === "LoadUnit")!.args).toEqual(["crond.service"]);
    });

    it("explains an unreachable user manager, and reconnects on request", async () => {
        const r = await start(basic(), { params: { unit: "podman-restart.service", user: true }, showHints: true });
        // No session bus in this scenario: the details say so, and so does the list.
        let frame = await r.waitFor("Connecting to systemd failed");
        expect(frame.replace(/\s+/g, " ")).toContain("Connecting to systemd failed: your user session has no systemd " +
            "(no session bus, or no systemd --user). Press Esc to go back.");
        await r.press(keys.escape);
        frame = await r.waitFor(f => f.includes("Connecting to systemd failed") && f.includes("[Services]"));
        const flat = frame.replace(/\s+/g, " ");
        expect(flat).toContain("Connecting to systemd failed: your user session has no systemd (no session bus, or no systemd --user).");
        expect(flat).toContain("Press Ctrl+R to reconnect, or o for the system units.");
        expect(hintsLine(frame)).toMatch(/^hints: .*ctrl\+r reconnect.*o system units/);
        expect(hintsLine(frame)).not.toContain("enter open");
        const sessionOpens = () => mock!.opened("dbus-json3").filter(o => o.bus === "session" && o.name === "org.freedesktop.systemd1").length;
        const before = sessionOpens();
        await r.press(keys.ctrl("r"));
        await r.waitFor(() => sessionOpens() > before);
        await r.press("o");
        frame = await r.waitFor(f => f.includes("crond") && f.includes("[Services!]"));
    });

    it("shows the failed units, on a tab that has some", async () => {
        const r = await start(scenario({
            system: {
                units: [
                    { id: "crond.service", description: "Command Scheduler", active: "active", file: "enabled" },
                    { id: "broken.socket", description: "Broken Socket", active: "failed", file: "enabled" },
                ],
            },
        }), { params: { filter: "failed" } });
        const frame = await r.waitFor(f => f.includes("[Sockets!]") && f.includes("broken"));
        expect(frame).toContain("failed only");
        expect(frame).toMatch(/1 of 1 socket · 1 failed · failed only/);
    });

    it("shows the system's failed units when sent for them, even if the user's units were shown last", async () => {
        // Overview counts the system's failed units and sends { filter: "failed" }.
        const r = await start(scenario({
            system: {
                units: [
                    { id: "crond.service", description: "Command Scheduler", active: "active", file: "enabled" },
                    { id: "broken.service", description: "Broken Service", active: "failed", file: "enabled" },
                ],
            },
            user: { units: [{ id: "podman-restart.service", description: "Podman Start All Containers", active: "failed", file: "enabled" }] },
        }), { params: { filter: "failed" }, seed: { "services:owner": "user" } });
        const frame = await r.waitFor(f => f.includes("failed only") && f.includes("broken"));
        expect(frame).toMatch(/\[System\] User/);
        expect(rowOf(frame, "podman-restart")).toBeUndefined();
        expect(calls().filter(c => c.method === "ListUnits").map(c => c.open.bus)).toEqual(["system"]);
    });
});

// ---- actions --------------------------------------------------------------------------------

describe("actions", () => {
    /** Press an action's key: it asks first, and nothing is sent until Enter. */
    async function confirm(r: RenderedPage, key: string, question: string): Promise<string> {
        const sent = actionCalls().length;
        await r.press(key);
        const frame = await r.waitFor(asking(question));
        expect(actionCalls()).toHaveLength(sent);
        await r.press(keys.enter);
        return frame;
    }

    it("are refused without administrative access, and say why", async () => {
        const r = await start(basic());
        await openUnitFromList(r, "crond");
        await r.press("S");
        await r.waitFor("status: warning: To stop crond.service, turn on administrative access (press A)");
        await r.press("x");
        await r.waitFor("status: warning: To clear failed crond.service, turn on administrative access (press A)");
        expect(actionCalls()).toEqual([]);
    });

    it("explain an action that does not apply", async () => {
        const r = await start(basic(), { allowed: true });
        await openUnitFromList(r, "crond");
        await r.press("s");
        await r.waitFor("status: warning: Cannot start crond.service: it is already running");
        await r.press("u");
        await r.waitFor("status: warning: Cannot unmask crond.service: it is not masked");
        expect(actionCalls()).toEqual([]);
    });

    it.each([
        ["s", "foo.service", "Start foo.service now?", "Start"],
        ["R", "crond.service", "Reload crond.service now?", "Reload"],
        ["e", "foo.service", "Enable and start foo.service? It starts now, and from now on automatically.", "Enable and start"],
        ["u", "cups.service", "Unmask cups.service? It can be started again.", "Unmask"],
        ["x", "podman-restart.service", "Clear the failed state of podman-restart.service?", "Clear failed"],
        ["S", "crond.service", "Stop crond.service now?", "Stop"],
        ["r", "crond.service", "Restart crond.service now?", "Restart"],
        ["d", "crond.service", "Stop and disable crond.service?", "Stop and disable"],
        ["m", "crond.service", "Mask crond.service?", "Mask"],
    ])("ask before %s on %s, and do nothing when cancelled", async (key, unit, question, label) => {
        const r = await start(basic(), { allowed: true, params: { unit } });
        await r.waitFor(f => f.includes("Actions") && f.includes(unit));
        await r.press(key);
        const frame = await r.waitFor(asking(question));
        expect(frame).toContain(`< ${label} >   < Cancel >`);
        await r.press(keys.escape);
        await r.waitFor(f => !dialogText(f).includes(question));
        expect(actionCalls()).toEqual([]);
    });

    it("do not take keys typed ahead as the answer to their question", async () => {
        // "/sshd" and Enter, typed as a search: the details have none, "s" asks to start the
        // unit, and the rest arrives in the question the moment it is drawn.
        const r = await start(basic({ StartUnit: jobMethod(7, "foo.service") }), { allowed: true, params: { unit: "foo.service" } });
        await r.waitFor(/Actions +s start/);
        await r.press("/", "s", "h", "d", keys.enter);
        await r.waitFor(inDialog("Start foo.service now?"));
        // Enter is offered once the question has been up a moment; until then it is ignored.
        await r.waitFor(asking("Start foo.service now?"));
        expect(actionCalls()).toEqual([]);
        await r.press(keys.enter);
        await r.waitFor("status: success: Started foo.service");
        expect(actionCalls()).toEqual([["StartUnit", ["foo.service", "fail"], "ss"]]);
    });

    it("do not take a burst of keys as the answer, even in one read", async () => {
        const r = await start(basic({ RestartUnit: jobMethod(9, "crond.service") }), { allowed: true, params: { unit: "crond.service" } });
        await r.waitFor(/Actions +R reload/);
        await r.press("/restart\r");
        await r.waitFor(asking("Restart crond.service now?"));
        expect(actionCalls()).toEqual([]);
        await r.press(keys.escape);
        await r.waitFor(f => !dialogText(f).includes("Restart crond.service now?"));
        expect(actionCalls()).toEqual([]);
    });

    it("say that the file actions reload systemd's configuration", async () => {
        const r = await start(basic(), { allowed: true, params: { unit: "foo.service" } });
        await r.waitFor(/Actions +s start/);
        await r.press("e");
        const frame = await r.waitFor(asking("Enable and start foo.service?"));
        expect(dialogText(frame)).toContain("This also reloads systemd's configuration (daemon-reload).");
        await r.press(keys.escape);
    });

    describe("on systemd's special targets", () => {
        const TARGETS: FakeUnit[] = [
            ...BASIC,
            { id: "reboot.target", description: "System Reboot", file: "enabled", aliases: ["ctrl-alt-del.target"] },
            { id: "poweroff.target", description: "System Power Off", file: "disabled" },
        ];

        it("say that starting reboot.target restarts the machine, and expect the connection to drop", async () => {
            const r = await start(scenario({
                system: {
                    units: TARGETS,
                    methods: {
                        StartUnit: {
                            error: ["org.freedesktop.DBus.Error.InteractiveAuthorizationRequired", ["Interactive authentication required."]],
                            delayMs: 400,
                        },
                    },
                },
            }), { allowed: true, params: { unit: "ctrl-alt-del.target" } });
            await r.waitFor(/Actions +s start/);
            await r.press("s");
            const frame = await r.waitFor(asking("Start reboot.target now? This restarts localhost."));
            expect(frame).toContain("< Start >   < Cancel >");
            expect(actionCalls()).toEqual([]);
            expect(expectedDisconnectReason()).toBeNull();
            await r.press(keys.enter);
            await mock!.waitForReceived(e => e.data !== undefined && e.data.includes('"StartUnit"'));
            // Said before the call went out: the reboot takes the connection with it.
            expect(expectedDisconnectReason()).toBe("localhost is restarting.");
            // Refused: no reboot is coming, so a dropped connection would be a failure again.
            await r.waitFor(inDialog("Starting reboot.target failed: Interactive authentication required."));
            expect(expectedDisconnectReason()).toBeNull();
            expect(actionCalls()).toEqual([["StartUnit", ["reboot.target", "fail"], "ss"]]);
        });

        it("keep expecting the drop once the reboot is under way", async () => {
            const r = await start(scenario({
                system: { units: TARGETS, methods: { StartUnit: jobMethod(40, "reboot.target", "done") } },
            }), { allowed: true, params: { unit: "reboot.target" } });
            await r.waitFor(/Actions +s start/);
            await confirm(r, "s", "This restarts localhost.");
            await r.waitFor("status: success: Started reboot.target");
            expect(expectedDisconnectReason()).toBe("localhost is restarting.");
        });

        it("say that enabling and starting poweroff.target shuts the machine down", async () => {
            const r = await start(scenario({
                system: {
                    units: TARGETS,
                    methods: {
                        EnableUnitFiles: { reply: [true, []], out: ["b", "a(sss)"] },
                        StartUnit: jobMethod(41, "poweroff.target", "dependency"),
                    },
                },
            }), { allowed: true, params: { unit: "poweroff.target" } });
            await r.waitFor(/Actions +s start +e enable and start/);
            await r.press("e");
            const frame = await r.waitFor(asking("Enable and start poweroff.target? Starting it shuts down localhost."));
            expect(frame).toContain("< Enable and start >");
            await r.press(keys.enter);
            await r.waitFor(inDialog("Starting poweroff.target failed: a dependency failed"));
            expect(actionCalls().map(c => c[0])).toEqual(["EnableUnitFiles", "Reload", "StartUnit"]);
            // The job failed: nothing is going down.
            expect(expectedDisconnectReason()).toBeNull();
        });

        it("say that starting the user manager's exit.target ends it", async () => {
            const r = await start(scenario({
                system: { units: BASIC },
                user: { units: [{ id: "exit.target", description: "Exit the Session", file: "static" }] },
            }), { params: { unit: "exit.target", user: true } });
            await r.waitFor(/Actions +s start/);
            await r.press("s");
            const frame = await r.waitFor(asking("Start exit.target now?"));
            expect(dialogText(frame)).toContain("This stops all of your user units and ends your user service manager");
            await r.press(keys.escape);
            expect(actionCalls()).toEqual([]);
        });
    });

    it("start a unit after asking, follow its job, and report the result", async () => {
        const r = await start(basic({
            StartUnit: jobMethod(7, "foo.service", "done", { delayMs: 300, before: [becomes("foo.service", "active", "running")] }),
        }), { allowed: true });
        await openUnitFromList(r, "foo");
        let frame = r.lastFrame();
        expect(frame).toMatch(/Actions +s start +e enable and start +m mask/);
        await confirm(r, "s", "Start foo.service now?");
        frame = await r.waitFor("Starting foo.service…");
        await r.waitFor("status: success: Started foo.service");
        expect(actionCalls()).toEqual([["StartUnit", ["foo.service", "fail"], "ss"]]);
        // On its own client, at the current privilege level, subscribed before it called.
        const startCall = calls().find(c => c.method === "StartUnit")!;
        expect(startCall.open).toMatchObject({ name: "org.freedesktop.systemd1", bus: "system", superuser: "try" });
        const onChannel = calls().filter(c => c.channel === startCall.channel).map(c => c.method);
        expect(onChannel).toEqual(["Subscribe", "StartUnit"]);
        expect(subscriptions().filter(sub => sub.channel === startCall.channel).map(sub => sub.rule))
            .toEqual([{ interface: MANAGER, member: "JobRemoved" }]);
        // The details follow the signalled state.
        frame = await r.waitFor(/● Running +active \(running\)/);
        // The action's client is closed when it is done.
        await mock!.waitForReceived(e => e.control?.command === "close" && e.control.channel === startCall.channel);
    });

    it("ask before stopping, and do nothing when cancelled", async () => {
        const r = await start(basic({
            StopUnit: jobMethod(8, "crond.service", "done", { before: [becomes("crond.service", "inactive", "dead")] }),
        }), { allowed: true });
        await openUnitFromList(r, "crond");
        await r.press("S");
        let frame = await r.waitFor(asking("Stop crond.service now? Units that depend on it are stopped as well: dependent.service."));
        expect(frame).toContain("< Stop >   < Cancel >");
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Stop crond.service now?"));
        expect(actionCalls()).toEqual([]);

        await r.press("S");
        await r.waitFor(asking("Stop crond.service now?"));
        await r.press(keys.enter);
        await r.waitFor("status: success: Stopped crond.service");
        expect(actionCalls()).toEqual([["StopUnit", ["crond.service", "fail"], "ss"]]);
        frame = await r.waitFor(/○ Not running +inactive \(dead\)/);
    });

    it("restart and reload, each after asking", async () => {
        const r = await start(basic({
            RestartUnit: jobMethod(9, "crond.service"),
            ReloadUnit: jobMethod(10, "crond.service"),
        }), { allowed: true });
        await openUnitFromList(r, "crond");
        await r.press("r");
        await r.waitFor(asking("Restart crond.service now? It is stopped and started again."));
        await r.press(keys.enter);
        await r.waitFor("status: success: Restarted crond.service");
        await confirm(r, "R", "Reload crond.service now?");
        await r.waitFor("status: success: Reloaded crond.service");
        expect(actionCalls()).toEqual([
            ["RestartUnit", ["crond.service", "fail"], "ss"],
            ["ReloadUnit", ["crond.service", "fail"], "ss"],
        ]);
    });

    it("enable a stopped unit: enable, daemon-reload, then start", async () => {
        const r = await start(basic({
            EnableUnitFiles: {
                reply: [true, [["symlink", "/etc/systemd/system/multi-user.target.wants/foo.service", "/usr/lib/systemd/system/foo.service"]]],
                out: ["b", "a(sss)"],
                effects: [{ signal: [M, MANAGER, "UnitFilesChanged", []] }],
            },
            StartUnit: jobMethod(11, "foo.service"),
        }), { allowed: true });
        await openUnitFromList(r, "foo");
        const listsBefore = calls().filter(c => c.method === "ListUnits").length;
        await confirm(r, "e", "Enable and start foo.service?");
        await r.waitFor("status: success: Enabled and started foo.service");
        expect(actionCalls()).toEqual([
            ["EnableUnitFiles", [["foo.service"], false, false], "asbb"],
            ["Reload", [], undefined],
            ["StartUnit", ["foo.service", "fail"], "ss"],
        ]);
        // The daemon-reload made the list read everything again, once.
        await r.waitFor(() => calls().filter(c => c.method === "ListUnits").length === listsBefore + 1);
    });

    it("warn when a unit is not meant to be enabled", async () => {
        const r = await start(basic({
            EnableUnitFiles: { reply: [false, []], out: ["b", "a(sss)"] },
            StartUnit: jobMethod(12, "foo.service"),
        }), { allowed: true });
        await openUnitFromList(r, "foo");
        await confirm(r, "e", "Enable and start foo.service?");
        await r.waitFor("status: warning: Enabled and started foo.service. This unit is not designed to be enabled explicitly.");
    });

    it("disable a running unit: confirm, stop, disable, daemon-reload", async () => {
        const r = await start(basic({
            StopUnit: jobMethod(13, "crond.service"),
            DisableUnitFiles: { reply: [[["unlink", "/etc/systemd/system/multi-user.target.wants/crond.service", ""]]], out: ["a(sss)"] },
        }), { allowed: true });
        await openUnitFromList(r, "crond");
        await r.press("d");
        const frame = await r.waitFor(asking("Stop and disable crond.service? It is stopped now, and no longer starts automatically."));
        expect(frame).toContain("< Stop and disable >");
        await r.press(keys.enter);
        await r.waitFor("status: success: Stopped and disabled crond.service");
        expect(actionCalls()).toEqual([
            ["StopUnit", ["crond.service", "fail"], "ss"],
            ["DisableUnitFiles", [["crond.service"], false], "asb"],
            ["Reload", [], undefined],
        ]);
    });

    it("stop a chain at its first failure", async () => {
        const r = await start(basic({
            StopUnit: { error: ["org.freedesktop.systemd1.TransactionIsDestructive", ["Transaction for crond.service/stop is destructive."]] },
        }), { allowed: true });
        await openUnitFromList(r, "crond");
        await r.press("d");
        await r.waitFor(asking("Stop and disable crond.service?"));
        await r.press(keys.enter);
        await r.waitFor(inDialog("Stopping crond.service failed: Transaction for crond.service/stop is destructive."));
        expect(actionCalls()).toEqual([["StopUnit", ["crond.service", "fail"], "ss"]]);
        // The failure stays until dismissed.
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Stopping crond.service failed"));
    });

    it("mask a failed unit after upstream's warning: mask, clear the failure, daemon-reload", async () => {
        const r = await start(basic({
            MaskUnitFiles: { reply: [[["symlink", "/etc/systemd/system/podman-restart.service", "/dev/null"]]], out: ["a(sss)"] },
            ResetFailedUnit: { reply: [] },
        }), { allowed: true });
        await openUnitFromList(r, "podman-restart");
        await r.press("m");
        const frame = await r.waitFor(asking("Masking service prevents all dependent units from running."));
        expect(dialogText(frame)).toContain("Please confirm that you want to mask this unit.");
        await r.press(keys.enter);
        await r.waitFor("status: success: Masked podman-restart.service");
        expect(actionCalls()).toEqual([
            ["MaskUnitFiles", [["podman-restart.service"], false, false], "asbb"],
            ["ResetFailedUnit", ["podman-restart.service"], "s"],
            ["Reload", [], undefined],
        ]);
    });

    it("unmask a masked unit", async () => {
        const r = await start(basic({
            UnmaskUnitFiles: { reply: [[["unlink", "/etc/systemd/system/cups.service", ""]]], out: ["a(sss)"] },
        }), { allowed: true });
        await openUnitFromList(r, "cups");
        expect(r.lastFrame()).toMatch(/Actions +u unmask\s*$/m);
        await confirm(r, "u", "Unmask cups.service?");
        await r.waitFor("status: success: Unmasked cups.service");
        expect(actionCalls()).toEqual([
            ["UnmaskUnitFiles", [["cups.service"], false], "asb"],
            ["Reload", [], undefined],
        ]);
    });

    it("clear a failed state", async () => {
        const r = await start(basic({ ResetFailedUnit: { reply: [] } }), { allowed: true });
        await openUnitFromList(r, "podman-restart");
        await confirm(r, "x", "Clear the failed state of podman-restart.service?");
        await r.waitFor("status: success: Cleared the failed state of podman-restart.service");
        expect(actionCalls()).toEqual([["ResetFailedUnit", ["podman-restart.service"], "s"]]);
    });

    it("show a failed job's result and keep the dialog open", async () => {
        const r = await start(basic({ StartUnit: jobMethod(14, "foo.service", "failed") }), { allowed: true });
        await openUnitFromList(r, "foo");
        await confirm(r, "s", "Start foo.service now?");
        const frame = await r.waitFor("Starting foo.service failed: the unit failed");
        expect(frame).toContain("< Close >");
        expect(frame).not.toContain("status: success");
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("the unit failed"));
    });

    it("catch a job that ends before its reply arrives", async () => {
        const r = await start(basic({
            StartUnit: jobMethod(15, "foo.service", "done", { beforeReply: true, delayMs: 1 }),
        }), { allowed: true });
        await openUnitFromList(r, "foo");
        await confirm(r, "s", "Start foo.service now?");
        await r.waitFor("status: success: Started foo.service");
    });

    it("show systemd's refusal verbatim", async () => {
        const r = await start(basic({
            StartUnit: { error: ["org.freedesktop.DBus.Error.InteractiveAuthorizationRequired", ["Interactive authentication required."]] },
        }), { allowed: true });
        await openUnitFromList(r, "foo");
        await confirm(r, "s", "Start foo.service now?");
        await r.waitFor(inDialog("Starting foo.service failed: Interactive authentication required."));
    });

    it("keep running in the background, shown on the unit's row", async () => {
        const r = await start(basic({
            StartUnit: jobMethod(16, "foo.service", "done", { delayMs: 1500 }),
        }), { allowed: true });
        await openUnitFromList(r, "foo");
        await confirm(r, "s", "Start foo.service now?");
        await r.waitFor("Starting foo.service…");
        await r.press(keys.escape);
        await r.waitFor("status: info: Starting foo.service continues in the background");
        await r.waitFor(/Action +Starting foo\.service…/);
        // Quitting now would ask first.
        expect(quitGuards()).toEqual(["Starting foo.service is still running; quitting now may leave it half done."]);
        // A second action on the same unit waits for the first.
        await r.press("m");
        await r.waitFor("status: warning: Starting foo.service is still running");
        await r.press(keys.escape);
        await r.waitFor(f => (rowOf(f, "foo") ?? "").includes("Starting…") ||
                                     (f.split("\n").find(line => line.startsWith(glyphs.pointer)) ?? "").includes("Starting…"));
        await r.waitFor("status: success: Started foo.service", 4000);
        await r.waitFor(f => !f.includes("Starting…"));
        expect(quitGuards()).toEqual([]);
        expect(actionCalls()).toEqual([["StartUnit", ["foo.service", "fail"], "ss"]]);
    });

    it("act on the user's own units without administrative access", async () => {
        const r = await start(scenario({
            system: { units: BASIC },
            user: {
                units: [{ id: "podman-restart.service", description: "Podman Start All Containers", active: "failed", file: "enabled" }],
                methods: { ResetFailedUnit: { reply: [] } },
            },
        }), { params: { unit: "podman-restart.service", user: true }, allowed: false });
        await r.waitFor(/Actions +s start/);
        await confirm(r, "x", "Clear the failed state of podman-restart.service?");
        await r.waitFor("status: success: Cleared the failed state of podman-restart.service");
        const reset = calls().find(c => c.method === "ResetFailedUnit")!;
        expect(reset.args).toEqual(["podman-restart.service"]);
        expect(reset.open).toMatchObject({ name: "org.freedesktop.systemd1", bus: "session" });
        expect(reset.open.superuser).toBeUndefined();
    });

    describe("at the smallest page size", () => {
        // dbus-broker.service as on this host: three running units require it.
        const units = BASIC.map(u => (u.id === "dbus-broker.service"
            ? { ...u, unit: { RequiredBy: v("as", ["tuned.service", "firewalld.service", "NetworkManager.service"]) } }
            : u));

        /**
         * The dialog as the user reads it: its title, then the question from
         * its first word (nothing drawn over it), and the keys to answer.
         */
        async function question(r: RenderedPage, key: string, title: string, start: string, keyLine: string): Promise<string> {
            await r.press(key);
            const frame = await r.waitFor(f => f.includes(keyLine));
            expect(frame.split("\n").length).toBeLessThanOrEqual(11);
            const text = dialogText(frame);
            expect(text.startsWith(`${title} ${start}`)).toBe(true);
            await r.press(keys.escape);
            await r.waitFor(f => !f.includes(keyLine));
            return text;
        }

        it("fit their questions, naming fewer dependents rather than losing the question", async () => {
            const r = await start(scenario({ system: { units, files: BASIC_FILES } }),
                                  { allowed: true, columns: 50, rows: 11, params: { unit: "dbus-broker.service" } });
            // (Its action keys are scrolled out of sight at this size; they work all the same.)
            await r.waitFor(f => f.includes("Status") && f.includes("Running"));
            const restart = await question(r, "r", "Restart dbus-broker.service",
                                           "Restart dbus-broker.service now? It is stopped and started again.", "< Restart >");
            expect(restart).toMatch(/Units that depend on it are restarted as well: [^.]+\./);
            await question(r, "m", "Mask dbus-broker.service", "Mask dbus-broker.service? Masking service prevents", "< Mask >");
            await question(r, "d", "Stop and disable dbus-broker.service",
                           "Stop and disable dbus-broker.service? It is stopped now,", "< Stop and disable >");
            expect(actionCalls()).toEqual([]);
        });

        it("fit a long failure, keeping the way out", async () => {
            const reason = "Permission denied because the calling process lacks the polkit authorization required for this " +
                "action on this host, please contact your administrator or check the policy installed under " +
                "/usr/share/polkit-1/actions for the action named org.freedesktop.systemd1.manage-units.";
            const r = await start(basic({ ResetFailedUnit: { error: ["org.freedesktop.DBus.Error.AccessDenied", [reason]] } }),
                                  { allowed: true, columns: 50, rows: 11, params: { unit: "podman-restart.service" } });
            await r.waitFor(f => f.includes("Status") && f.includes("Failed to start"));
            await r.press("x");
            await r.waitFor(f => f.includes("< Clear failed >"));
            await r.press(keys.enter);
            const frame = await r.waitFor("< Close >");
            expect(frame.split("\n").length).toBeLessThanOrEqual(11);
            expect(dialogText(frame)).toMatch(/^Clear failed podman-restart\.service Clearing the failed state of podman-restart\.service failed: Permission denied/);
            await r.press(keys.escape);
            await r.waitFor(f => !f.includes("< Close >"));
        });
    });

    it("keep the list's columns while an action runs", async () => {
        const units: FakeUnit[] = [
            ...BASIC,
            { id: "NetworkManager-wait-online.service", description: "Network Manager Wait Online", file: "enabled" },
        ];
        const r = await start(scenario({
            system: {
                units, files: BASIC_FILES,
                methods: {
                    StopUnit: jobMethod(50, "crond.service", "done", { delayMs: 1500 }),
                    DisableUnitFiles: { reply: [[]], out: ["a(sss)"] },
                },
            },
        }), { allowed: true, columns: 65, params: { unit: "crond.service" } });
        await r.waitFor("Actions");
        await confirm(r, "d", "Stop and disable crond.service?");
        await r.waitFor("Stopping and disabling crond.service…");
        await r.press(keys.escape); // to the background
        await r.waitFor(/Action +Stopping and disabling crond\.service…/);
        await r.press(keys.escape); // to the list
        const frame = await r.waitFor(f => (rowOf(f, "crond") ?? "").includes(glyphs.ellipsis));
        const header = frame.split("\n").find(line => /^ +Unit /.test(line)) ?? "";
        expect(header).toContain("Description");
        expect(rowOf(frame, "crond")).toMatch(/crond +Command.* Disabling… +Enabled/);
        await r.waitFor("status: success: Stopped and disabled crond.service", 4000);
    });

    it("keep host text out of the quit question", async () => {
        const evil = "evil\x1b]8;;https://evil.example/\x07CLICK\x1b]8;;\x07\x1b[8mHIDDEN\x1b[28m\x07\rX.service";
        const r = await start(scenario({
            system: {
                units: [{ id: "evil.service", description: "Evil", file: "disabled", unit: { Names: v("as", [evil]) } }],
                methods: { StartUnit: jobMethod(51, evil, "done", { delayMs: 800 }) },
            },
        }), { allowed: true, params: { unit: "evil.service" } });
        await r.waitFor(/Actions +s start/);
        await confirm(r, "s", "Start evil");
        await r.waitFor("[Esc] continue in the background");
        // The progress line names the unit too.
        expect(r.lastFrame()).toContain("Starting evil^[]8;;https://evil.example/^GCLICK");
        // eslint-disable-next-line no-control-regex
        expect(r.lastRawFrame()).not.toMatch(/\x1b\]|\x07|\x1b\[8m|\r/);
        await r.press(keys.escape);
        await r.waitFor(/Action +Starting evil/);
        const reason = quitGuards().join(" ");
        expect(reason).toContain("Starting evil");
        // eslint-disable-next-line no-control-regex
        expect(reason).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
        await r.waitFor("status: success: Started evil", 3000);
        expect(quitGuards()).toEqual([]);
    });
});

// ---- the systemd channel ----------------------------------------------------------------

describe("the systemd channel", () => {
    it("carries two match rules however much the page is used, and no watches", async () => {
        const r = await start(basic());
        await r.waitFor("podman-restart");
        for (let i = 0; i < 10; i++) {
            await r.press(keys.enter);
            // The log panel has read its entries (none), so its follow is running.
            await r.waitFor(f => f.includes("No log entries") && f.includes("Status"));
            await r.press(keys.escape);
            await r.waitFor("[Services!]");
            await r.press(keys.right, keys.right, keys.left, keys.left, keys.down);
            await r.waitFor("[Services!]");
        }
        const subs = subscriptions();
        expect(subs.filter(s => s.kind === "watch")).toEqual([]);
        const store = calls().find(c => c.method === "ListUnits" && c.open.bus === "system")!;
        expect(subs.filter(s => s.channel === store.channel).map(s => s.rule)).toEqual([
            { interface: "org.freedesktop.DBus.Properties", member: "PropertiesChanged", path_namespace: "/org/freedesktop/systemd1/unit" },
            { interface: MANAGER },
        ]);
        // Subscribed once; listed once (the units are all known: nothing to probe).
        expect(calls().filter(c => c.channel === store.channel && c.method === "Subscribe")).toHaveLength(1);
        expect(calls().filter(c => c.method === "ListUnits")).toHaveLength(1);
        // Every details view opened a unit log follow, and closed it again.
        const follows = journalOpens().filter(open => (open.spawn as string[]).includes("--follow"));
        expect(follows.length).toBeGreaterThanOrEqual(9);
        const closed = new Set(mock!.controls("close").map(c => c.channel));
        expect(follows.filter(open => !closed.has(open.channel)).length).toBeLessThanOrEqual(1);
    });

    it("is closed with the page, and the old manager's when the owner changes", async () => {
        const r = await start(scenario({
            system: { units: BASIC, files: BASIC_FILES },
            user: { units: [{ id: "pipewire.service", description: "PipeWire Multimedia Service", active: "active", file: "static" }] },
        }));
        await r.waitFor(f => f.includes("[System]") && f.includes("crond"));
        const closedChannel = (channel: string) =>
            mock!.waitForReceived(e => e.control?.command === "close" && e.control.channel === channel);
        const system = calls().find(c => c.method === "ListUnits" && c.open.bus === "system")!;
        await r.press("o");
        await r.waitFor(f => f.includes("[User]") && f.includes("pipewire"));
        await closedChannel(system.channel);

        // Leave the page from a unit's details: the manager's channel and the log follow both go.
        await r.press(keys.enter);
        await r.waitFor("No log entries");
        const follow = await mock!.waitForReceived(e => e.control?.command === "open" &&
            Array.isArray(e.control.spawn) && (e.control.spawn as string[]).includes("--follow"));
        const user = calls().find(c => c.method === "ListUnits" && c.open.bus === "session")!;
        cleanup();
        await closedChannel(user.channel);
        await closedChannel(String(follow.control!.channel));
    });
});

// ---- host text ----------------------------------------------------------------------------

describe("host text", () => {
    /*
     * What would reach the terminal if host text were written as is: OSC
     * (title, hyperlink), CSI in its 7- and 8-bit forms, BEL, CR, conceal,
     * and bidirectional controls that make text read as something else.
     */
    const H = "\x1b]0;pwned\x07\x1b]8;;https://evil.example/\x07\x1b[2J\x9b31m\r\x1b[8m‮⁦";
    const FORBIDDEN: readonly [string, string][] = [
        ["OSC", "\x1b]"], ["C1 CSI", "\x9b"], ["BEL", "\x07"], ["CR", "\r"], ["erase", "\x1b[2J"], ["conceal", "\x1b[8m"],
        ["RLO", "‮"], ["LRI", "⁦"],
    ];
    const leaks = (raw: string) => FORBIDDEN.filter(([, text]) => raw.includes(text)).map(([name]) => name);

    it("has nothing these checks would find on a page of plain text", async () => {
        const r = await start(basic({ StartUnit: { error: ["org.example.Failed", ["It failed."]] } }),
                              { allowed: true, params: { unit: "crond.service" } });
        await r.waitFor("Recent logs");
        expect(leaks(r.lastRawFrame())).toEqual([]);
        await r.press(keys.escape);
        await r.waitFor("podman-restart");
        expect(leaks(r.lastRawFrame())).toEqual([]);
    });

    it("never writes host text to the terminal as is: list, details, logs and dialogs", async () => {
        const id = `evil${H}.service`;
        const journal = JSON.stringify({
            __CURSOR: "c1", __REALTIME_TIMESTAMP: "1790984000000000", _BOOT_ID: "b1", PRIORITY: "3",
            SYSLOG_IDENTIFIER: `ident${H}`, MESSAGE: `message${H}`,
        });
        const r = await start(scenario({
            system: {
                units: [
                    ...BASIC,
                    {
                        id, description: `Evil${H}`, active: `active${H}`, sub: `sub${H}`, file: `enabled${H}`,
                        unit: { RequiredBy: v("as", [`dep${H}.service`]), DropInPaths: v("as", [`/etc/drop${H}.conf`]) },
                    },
                ],
                files: BASIC_FILES,
                methods: { StartUnit: { error: ["org.example.Hostile", [`refused${H}`]] } },
            },
            spawn: [
                { match: "^journalctl .*--reverse", stdout: journal + "\n", stderr: `notice${H}` },
                { match: "^journalctl .*--follow", "exit-status": 1, stderr: `follow${H}` },
            ],
        }), { allowed: true });

        // The list: name, description, state and startup columns.
        await r.waitFor(f => f.includes("evil^[]0;pwned^G") && f.includes("Evil^[]0;pwned"));
        expect(leaks(r.lastRawFrame())).toEqual([]);

        // Its details: heading, status, path, drop-ins, relationships, the log panel.
        await r.press("/", "e", "v", "i", "l", keys.enter);
        await r.waitFor(f => selectedRow(f).includes("evil"));
        await r.press(keys.enter, "g");
        await r.waitFor(f => f.includes("Required by") && f.includes("message^[]0;pwned") && f.includes("Following the log stopped"));
        expect(r.lastFrame()).toContain("notice^[]0;pwned");
        expect(leaks(r.lastRawFrame())).toEqual([]);

        // An action on it: the question, then systemd's refusal.
        await r.press("s");
        await r.waitFor(asking("Start evil^[]0;pwned"));
        expect(leaks(r.lastRawFrame())).toEqual([]);
        await r.press(keys.enter);
        await r.waitFor(f => f.includes("< Close >") && dialogText(f).includes("failed: refused^[]0;pwned"));
        expect(leaks(r.lastRawFrame())).toEqual([]);
        await r.press(keys.escape);
    });

    it("keeps host text out of the reason an action does not apply", async () => {
        // The reason names the unit file state, which is host text: it reaches the footer.
        const r = await start(scenario({
            system: { units: [...BASIC, { id: "b.service", description: "B", active: "inactive", file: "st\u202eatic" }], files: BASIC_FILES },
        }), { allowed: true, params: { unit: "b.service" } });
        await r.waitFor("Recent logs");
        await r.press("e");
        await r.waitFor(/status: warning: Cannot enable and start b\.service: it is st.?atic, not disabled/);
        expect(leaks(r.lastRawFrame())).toEqual([]);
    });

    it("never writes host text to the terminal as is: errors, and a unit that failed to load", async () => {
        const r = await start(scenario({
            system: {
                units: [
                    ...BASIC,
                    {
                        id: "bad.service", description: "Bad", load: "bad-setting", active: "inactive", file: "enabled",
                        unit: { LoadError: v("(ss)", ["org.freedesktop.systemd1.BadSetting", `bad${H}`]) },
                    },
                ],
                methods: {
                    // No signals: the list cannot be trusted, and says why.
                    Subscribe: { error: ["org.example.Hostile", [`subscribe${H}`]] },
                },
            },
        }), { params: { unit: "bad.service" } });
        await r.waitFor(f => f.includes("bad^[]0;pwned") && f.includes("Not up to date: Subscribing to systemd signals failed") &&
                             f.includes("subscribe^[]0;pwned"));
        expect(leaks(r.lastRawFrame())).toEqual([]);
        await r.press(keys.escape);
        await r.waitFor(f => f.includes("[Services") && f.includes("Subscribing to systemd signals failed") && f.includes("subscribe^[]0;pwned"));
        expect(leaks(r.lastRawFrame())).toEqual([]);
        cleanup();
        mock?.close();

        const ghost = await start(basic({ LoadUnit: { error: ["org.example.Hostile", [`no such unit${H}`]] } }),
                                  { params: { unit: "ghost.service" } });
        await ghost.waitFor(f => f.includes("Loading ghost.service failed:") && f.includes("unit^[]0;pwned"));
        expect(leaks(ghost.lastRawFrame())).toEqual([]);
    });
});
