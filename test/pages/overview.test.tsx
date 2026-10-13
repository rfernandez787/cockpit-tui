/*
 * The overview page against the mock bridge: what it shows, how it keeps it
 * current, and the exact calls its actions make (argv, D-Bus methods and
 * arguments, superuser options).
 *
 * The scenario mirrors the RHEL 9.8 host the specs were captured on
 * (specs/overview.md §5, specs/metrics.md §5), at a 100 ms metrics interval.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { useState } from "react";
import { Box, Text } from "ink";
import cockpit from "../../src/cockpit.js";
import { initInfo } from "../../src/session.js";
import OverviewPage from "../../src/pages/overview/index.js";
import { usageSettings } from "../../src/pages/overview/data.js";
import { forgetExpectedDisconnect, powerSettings, timeSettings } from "../../src/pages/overview/dialogs.js";
import { formatInOffset, formatInZone } from "../../src/pages/overview/system.js";
import { expectDisconnect, expectedDisconnectReason, type PageProps } from "../../src/tui/page.js";
import { Layer, useHints, useKeys } from "../../src/tui/keyboard.js";
import { frame, glyphs, unicode } from "../../src/tui/theme.js";
import { renderPage, type RenderedPage } from "../helpers/page.js";
import { cleanup, keys } from "../helpers/ink.js";
import { startMock, type MockBridge, type MockScenario, type JsonObject } from "../mock-bridge/harness.js";

// ---- fixtures ----------------------------------------------------------------------

const HOSTNAME1 = "/org/freedesktop/hostname1";
const TIMEDATE1 = "/org/freedesktop/timedate1";
const SYSTEMD = "/org/freedesktop/systemd1";
const UNIT = "org.freedesktop.systemd1.Unit";
const SCHEDULE = "/run/systemd/shutdown/scheduled";
const LOGIN1 = "/org/freedesktop/login1";
const LOGIN1_MANAGER = "org.freedesktop.login1.Manager";

const MEMINFO = "MemTotal:       61336584 kB\nMemFree:         1768148 kB\nMemAvailable:   45842120 kB\n" +
    "SwapTotal:       4194300 kB\nSwapFree:        4186364 kB\n";
const CPUINFO = Array.from({ length: 16 }, (_, i) => `processor\t: ${i}\nmodel name\t: AMD Ryzen 7 5700G\n`).join("\n");
const DMI_OUT = "/sys/class/dmi/id/sys_vendor:Micro-Star International Co., Ltd.\n" +
    "/sys/class/dmi/id/product_name:MS-7C95\n/sys/class/dmi/id/chassis_asset_tag:To be filled by O.E.M.\n";
const DMI_DENIED = "grep: /sys/class/dmi/id/product_serial: Permission denied\n" +
    "grep: /sys/class/dmi/id/chassis_serial: Permission denied\n";

const unitPath = (id: string) => `${SYSTEMD}/unit/${id.replace(/[^a-zA-Z0-9]/g, c => `_${c.charCodeAt(0).toString(16)}`)}`;
const unitRow = (id: string, active: string, load = "loaded") =>
    [id, id, load, active, active, "", unitPath(id), 0, "", "/"];
const unitObject = (id: string, active: string, load = "loaded") =>
    ({ [UNIT]: { properties: { Id: id, LoadState: load, ActiveState: active, SubState: active } } });

/** Steady counters: n samples, each `step` more than the last. */
const counter = (step: number, n = 200) => Array.from({ length: n }, (_, i) => i * step);

/** Everything the page reads, as the real host answered it. */
function scenario(extra: Partial<MockScenario> = {}): MockScenario {
    const base: MockScenario = {
        dbus: {
            system: {
                [HOSTNAME1]: {
                    "org.freedesktop.hostname1": {
                        properties: {
                            Hostname: "server-box", StaticHostname: "server-box", PrettyHostname: "Server Box",
                            OperatingSystemPrettyName: "Red Hat Enterprise Linux 9.8 (Plow)",
                            KernelRelease: "5.14.0-687.49.1.el9_8.x86_64",
                            HardwareVendor: "Micro-Star International Co., Ltd.", HardwareModel: "MS-7C95",
                        },
                        methods: {
                            SetStaticHostname: {
                                in: ["s", "b"], reply: [],
                                byArgs: [{ args: ["web-server-1", true], reply: [],
                                           effects: [{ properties: [HOSTNAME1, "org.freedesktop.hostname1",
                                                                    { StaticHostname: "web-server-1", Hostname: "web-server-1" }] }] }],
                            },
                            SetPrettyHostname: {
                                in: ["s", "b"], reply: [],
                                byArgs: [{ args: ["Web Server 1", true], reply: [],
                                           effects: [{ properties: [HOSTNAME1, "org.freedesktop.hostname1",
                                                                    { PrettyHostname: "Web Server 1" }] }] }],
                            },
                        },
                    },
                },
                [TIMEDATE1]: {
                    "org.freedesktop.timedate1": {
                        properties: { Timezone: "America/Denver", LocalRTC: false, CanNTP: true, NTP: true, NTPSynchronized: true },
                        methods: {
                            ListTimezones: { reply: [["America/Denver", "America/New_York", "Europe/Berlin", "Europe/Paris", "UTC"]], out: ["as"] },
                            SetTimezone: {
                                in: ["s", "b"], reply: [],
                                byArgs: [{ args: ["Europe/Berlin", true], reply: [],
                                           effects: [{ properties: [TIMEDATE1, "org.freedesktop.timedate1", { Timezone: "Europe/Berlin" }] }] }],
                            },
                            SetNTP: {
                                in: ["b", "b"], reply: [],
                                byArgs: [{ args: [false, true], reply: [],
                                           effects: [{ properties: [TIMEDATE1, "org.freedesktop.timedate1", { NTP: false }], delayMs: 50 }] }],
                            },
                            SetTime: { in: ["x", "b", "b"], reply: [] },
                        },
                    },
                },
                [SYSTEMD]: {
                    "org.freedesktop.systemd1.Manager": {
                        methods: {
                            Subscribe: { reply: [] },
                            ListUnitsFiltered: {
                                in: ["as"], out: ["a(ssssssouso)"],
                                reply: [[
                                    unitRow("foo.service", "failed"),
                                    unitRow("bar.timer", "failed"),
                                    unitRow("dev-sdb.mount", "failed"),            // not a listed type
                                    unitRow("gone.service", "failed", "not-found"), // no unit file
                                ]],
                            },
                        },
                        signals: { UnitRemoved: { in: ["s", "o"] }, Reloading: { in: ["b"] } },
                    },
                },
                [unitPath("foo.service")]: unitObject("foo.service", "failed"),
                [unitPath("bar.timer")]: unitObject("bar.timer", "failed"),
                [unitPath("baz.service")]: unitObject("baz.service", "active"),
                // logind: cancelling removes the schedule file before the reply,
                // as reset_scheduled_shutdown() does.
                [LOGIN1]: {
                    [LOGIN1_MANAGER]: {
                        methods: {
                            CancelScheduledShutdown: { reply: [true], out: ["b"],
                                                       effects: [{ files: { [SCHEDULE]: null }, beforeReply: true }] },
                        },
                    },
                },
                // A control object the tests call to make "systemd" emit signals.
                "/test": {
                    "test.Control": {
                        methods: {
                            FailBaz: { reply: [], effects: [{ properties: [unitPath("baz.service"), UNIT, { ActiveState: "failed" }] }] },
                            RecoverFoo: { reply: [], effects: [{ properties: [unitPath("foo.service"), UNIT, { ActiveState: "active" }] }] },
                            RemoveBar: { reply: [], effects: [{ signal: [SYSTEMD, "org.freedesktop.systemd1.Manager", "UnitRemoved", ["bar.timer", unitPath("bar.timer")]] }] },
                            Reload: { reply: [], effects: [
                                { signal: [SYSTEMD, "org.freedesktop.systemd1.Manager", "Reloading", [true]] },
                                { properties: [unitPath("baz.service"), UNIT, { ActiveState: "failed" }] },
                                { signal: [SYSTEMD, "org.freedesktop.systemd1.Manager", "Reloading", [false]], delayMs: 50 },
                            ] },
                        },
                    },
                },
            },
        },
        files: {
            "/etc/machine-id": "a263b903410b43be864258e732080e5b\n",
            "/proc/uptime": "1061506.61 16887714.04\n",
            "/etc/motd": "",
        },
        spawn: {
            "cat /proc/meminfo /proc/cpuinfo": { stdout: MEMINFO + CPUINFO },
            "ls -1 /sys/devices/virtual/net": { stdout: "lo\nvirbr0\nvnet0\n" },
            "uname -r -m": { stdout: "5.14.0-687.49.1.el9_8.x86_64 x86_64\n" },
            "env -u TZ date +%s %z %Z": { stdout: `${Math.floor(Date.now() / 1000)} -0600 MDT\n` },
            "/bin/sh -c grep -r . /sys/class/dmi/id || true --": { stdout: DMI_OUT, stderr: DMI_DENIED },
        },
        metrics: {
            // 100 ms apart: 300 + 100 ms of CPU per sample is 4000 ms/s = 25% of 16 CPUs.
            "cpu.basic.user": { samples: counter(300) },
            "cpu.basic.system": { samples: counter(100) },
            "cpu.basic.nice": { samples: counter(0) },
            "memory.used": { samples: [16 * 2 ** 30] },
            "memory.swap-used": { samples: [8126464] },
            "disk.all.read": { samples: counter(8999.78) },    // 89997.8 B/s: "90.0 kB/s"
            "disk.all.written": { samples: counter(0) },
            "network.interface.rx": { instances: ["lo", "enp42s0", "virbr0"],
                                      samples: counter(1).map(i => [i * 100, i * 3386, i * 50]) },
            "network.interface.tx": { instances: ["lo", "enp42s0", "virbr0"],
                                      samples: counter(1).map(i => [i * 100, i * 18280, i * 50]) },
        },
    };
    return {
        ...base,
        ...extra,
        files: { ...base.files, ...extra.files },
        spawn: { ...base.spawn, ...extra.spawn },
        dbus: extra.dbus ?? base.dbus,
    };
}

// ---- harness -------------------------------------------------------------------------

let mock: MockBridge | null = null;

/*
 * The page as the shell shows it, minus the shell: the overview in all but
 * the last line, and that line showing the footer's hints, which the page
 * harness does not draw. A global-layer handler below the page records every
 * key the page let through, the way the shell's own keys (digits, Tab, A, ?,
 * q) would receive them. `remount()` unmounts and remounts the page inside
 * the same providers, as leaving it and coming back does.
 */
const passedThrough: string[] = [];
let remount: () => void = () => {};

function ShellLike({ width, height }: PageProps) {
    const hints = useHints();
    const [visit, setVisit] = useState(0);
    remount = () => setVisit(n => n + 1);
    useKeys((input, key) => {
        passedThrough.push(key.tab ? (key.shift ? "shift+tab" : "tab") : input);
        return false;
    }, { layer: Layer.global });
    return (
        <Box flexDirection="column" width={width} height={height}>
            <OverviewPage key={visit} width={width} height={height - 1} />
            <Text wrap="truncate">{`hints: ${hints.map(([k, label]) => `${k} ${label}`).join(" | ")}`}</Text>
        </Box>
    );
}

beforeEach(() => {
    usageSettings.interval = 100;
    passedThrough.length = 0;
});

afterEach(() => {
    cleanup();
    mock?.close();
    mock = null;
    forgetExpectedDisconnect();
    expectDisconnect(null);
    timeSettings.ntpTimeoutMs = 10_000;
    powerSettings.dueMarginMs = 15_000;
    usageSettings.interval = 100;
});

/**
 * Start the mock and render. `rows` is the whole frame: the page gets all
 * but the harness's status line and our hints line, so rows 24 gives the
 * 22-line page an 80x24 terminal leaves it (65 columns beside the menu).
 */
async function start(extra: Partial<MockScenario> = {}, options: { columns?: number, rows?: number, allowed?: boolean, panels?: boolean } = {}):
    Promise<RenderedPage> {
    mock = await startMock(scenario(extra));
    await initInfo();
    return renderPage(ShellLike, { columns: options.columns ?? 120, rows: options.rows ?? 36, allowed: options.allowed ?? false,
                                   ...(options.panels ? { panels: true } : {}) });
}

/** The page's own lines: the frame without the hints and status lines. */
const pageLines = (frame: string) => frame.split("\n").slice(0, -2);
const hintsLine = (frame: string) => frame.split("\n").at(-2) ?? "";

/** The open message of every channel, by channel id. */
function opens(): Map<string, JsonObject> {
    return new Map(mock!.opened().map(open => [String(open.channel), open]));
}

/** Every D-Bus call the page made: [path, iface, method, args] plus its channel's open options. */
function dbusCalls(): { call: unknown[], open: JsonObject }[] {
    const channels = opens();
    const out: { call: unknown[], open: JsonObject }[] = [];
    for (const entry of mock!.received()) {
        if (entry.data === undefined)
            continue;
        const open = channels.get(entry.channel);
        if (open?.payload !== "dbus-json3")
            continue;
        for (const line of entry.data.split("\n").filter(Boolean)) {
            const message = JSON.parse(line) as { call?: unknown[] };
            if (message.call)
                out.push({ call: message.call, open });
        }
    }
    return out;
}

function callsTo(method: string) {
    return dbusCalls().filter(c => c.call[2] === method);
}

function spawned(): JsonObject[] {
    return mock!.opened("stream");
}

/** Make "systemd" emit signals by calling the scenario's control object. */
async function trigger(method: string): Promise<void> {
    const client = cockpit.dbus("org.freedesktop.systemd1", { bus: "system" });
    try {
        await client.call("/test", "test.Control", method, []);
    } finally {
        client.close();
    }
}

const lineCount = (frame: string) => frame.split("\n").length;

/** The page with the harness's own hints line: the page and the dialogs' area both exactly rows - 2. */
async function startBare(extra: Partial<MockScenario> = {}, options: { columns: number, rows: number, allowed?: boolean }):
    Promise<RenderedPage> {
    mock = await startMock(scenario(extra));
    await initInfo();
    return renderPage(OverviewPage, { ...options, allowed: options.allowed ?? false, showHints: true });
}

/** The line on screen marked as selected, if any. */
const selectedRow = (frame: string) => frame.split("\n").find(line => line.includes(`${glyphs.pointer} `) &&
                                                                  !line.startsWith("hints:")) ?? null;

/** Each text appears on its own line, whole, in this order (nothing drawn over anything). */
function inOrder(frame: string, texts: string[]): void {
    const lines = frame.split("\n");
    let from = 0;
    for (const text of texts) {
        const at = lines.findIndex((line, i) => i >= from && line.includes(text));
        expect(at, `"${text}" after line ${from} in\n${frame}`).toBeGreaterThanOrEqual(0);
        from = at + 1;
    }
}

/** Make "logind" add or drop its schedule file, as another admin's shutdown would. */
const scheduleControl = (when: () => string) => ({
    "/test2": {
        "test.Schedule": {
            methods: {
                Schedule: { reply: [], effects: [{ files: { [SCHEDULE]: when() } }] },
                Unschedule: { reply: [], effects: [{ files: { [SCHEDULE]: null } }] },
            },
        },
    },
});

async function control(method: string): Promise<void> {
    const client = cockpit.dbus(null, { bus: "system" });
    try {
        await client.call("/test2", "test.Schedule", method, []);
    } finally {
        client.close();
    }
}


// ---- tests ---------------------------------------------------------------------------

describe("the overview page", () => {
    it("shows the host, its health, usage, system information and configuration", async () => {
        const r = await start();
        // Each section loads on its own: wait for the last of them.
        const frame = await r.waitFor(f => f.includes("25% of 16 CPUs") && f.includes("in   33.9 kB/s") &&
                                          f.includes("x86_64") && f.includes("MDT") && f.includes("2 failed units") &&
                                          f.includes("synchronized") && f.includes("58.5 GiB") && f.includes("4.00 GiB") &&
                                          f.includes("MS-7C95") && f.includes("America/Denver") && f.includes("up 12 days"));
        expect(frame).toContain("Server Box (server-box)");
        expect(frame).toContain("Mock Linux 1"); // PRETTY_NAME from the bridge's info
        expect(frame).toContain("up 12 days, 6:51");
        expect(frame).toMatch(/since \d{4}-\d\d-\d\d \d\d:\d\d/);
        // Two failed units: the mount and the not-found unit do not count.
        expect(frame).toContain(`${glyphs.cross} 2 failed units: bar.timer, foo.service`);
        expect(frame).toContain("16.0 / 58.5 GiB");
        expect(frame).toContain("7.75 MiB / 4.00 GiB");
        expect(frame).toMatch(/Disk\s+read 90\.0 kB\/s {2}write {5}0 B\/s/);
        // Physical interfaces only: lo and virbr0 are virtual.
        expect(frame).toContain("in   33.9 kB/s  out    183 kB/s");
        expect(frame).toContain("Micro-Star International Co., Ltd.");
        expect(frame).toContain("MS-7C95");
        expect(frame).toMatch(/Asset tag\s+requires administrative access/);
        expect(frame).toContain("a263b903410b43be864258e732080e5b");
        expect(frame).toContain("5.14.0-687.49.1.el9_8.x86_64");
        expect(frame).toMatch(/Architecture\s+x86_64/);
        expect(frame).toMatch(/System time\s+\d{4}-\d\d-\d\d \d\d:\d\d MDT/);
        expect(frame).toContain("America/Denver (UTC-06:00)");
        expect(frame).toContain(`${glyphs.check} on, synchronized`);
        expect(frame).toContain(`${glyphs.warning} Limited access: press A to turn on administrative access.`);
        expect(frame).not.toContain("Message of the day");
        // Without administrative access there is nothing to restart with.
        expect(hintsLine(frame)).toBe(`hints: ${glyphs.up}${glyphs.down} select | enter show failed`);
        expect(lineCount(frame)).toBe(36);
    });

    it("opens its channels with upstream's options", async () => {
        const r = await start();
        await r.waitFor("25% of 16 CPUs");
        const metrics = mock!.opened("metrics1");
        expect(metrics).toHaveLength(1);
        expect(metrics[0]).toMatchObject({
            source: "internal",
            interval: 100,
            metrics: [
                { name: "cpu.basic.user", derive: "rate" },
                { name: "cpu.basic.system", derive: "rate" },
                { name: "cpu.basic.nice", derive: "rate" },
                { name: "memory.used" },
                { name: "memory.swap-used" },
                { name: "disk.all.read", units: "bytes", derive: "rate" },
                { name: "disk.all.written", units: "bytes", derive: "rate" },
                { name: "network.interface.rx", units: "bytes", derive: "rate" },
                { name: "network.interface.tx", units: "bytes", derive: "rate" },
            ],
        });
        const argv = spawned().map(open => (open.spawn as string[]).join(" "));
        expect(argv).toEqual(expect.arrayContaining([
            "cat /proc/meminfo /proc/cpuinfo", "uname -r -m", "env -u TZ date +%s %z %Z", "ls -1 /sys/devices/virtual/net",
            "/bin/sh -c grep -r . /sys/class/dmi/id || true --",
        ]));
        const dmi = spawned().find(open => (open.spawn as string[])[0] === "/bin/sh");
        expect(dmi).toMatchObject({ superuser: "try", err: "message", environ: ["LC_ALL=C"] });
        // Nothing else asks for privileges: reads are plain.
        for (const open of spawned().filter(o => (o.spawn as string[])[0] !== "/bin/sh"))
            expect(open.superuser).toBeUndefined();

        // The failed-unit client: system bus, superuser "try", the three
        // match rules (PropertiesChanged narrowed by arg0), then Subscribe
        // and the list.
        const systemd = mock!.opened("dbus-json3").find(open => open.name === "org.freedesktop.systemd1");
        expect(systemd).toMatchObject({ bus: "system", superuser: "try" });
        const sent = mock!.sent(String(systemd!.channel));
        expect(sent).toContain('"add-match":{"interface":"org.freedesktop.DBus.Properties","member":"PropertiesChanged","arg0":"org.freedesktop.systemd1.Unit"}');
        expect(sent).toContain('"add-match":{"interface":"org.freedesktop.systemd1.Manager","member":"UnitRemoved"}');
        expect(sent).toContain('"add-match":{"interface":"org.freedesktop.systemd1.Manager","member":"Reloading"}');
        expect(callsTo("Subscribe").map(c => c.call)).toEqual([[SYSTEMD, "org.freedesktop.systemd1.Manager", "Subscribe", []]]);
        expect(callsTo("ListUnitsFiltered").map(c => c.call)).toEqual([
            [SYSTEMD, "org.freedesktop.systemd1.Manager", "ListUnitsFiltered", [["failed"]]],
        ]);
        expect(sent.indexOf("add-match")).toBeLessThan(sent.indexOf("Subscribe"));
        // hostname1 and timedate1 are read unprivileged; only actions escalate.
        for (const name of ["org.freedesktop.hostname1", "org.freedesktop.timedate1"]) {
            const open = mock!.opened("dbus-json3").find(o => o.name === name);
            expect(open).toMatchObject({ bus: "system" });
            expect(open!.superuser).toBeUndefined();
        }
        // The schedule file and the motd are watched (fsinfo), the rest read once.
        const watched = mock!.opened("fsinfo").map(open => open.path);
        expect(watched).toEqual(expect.arrayContaining([SCHEDULE, "/etc/motd"]));
        const read = mock!.opened("fsread1").map(open => open.path);
        expect(read).toEqual(expect.arrayContaining(["/etc/machine-id", "/proc/uptime"]));
    });

    it("keeps the failed-unit count current from systemd's signals", async () => {
        const r = await start();
        await r.waitFor("2 failed units: bar.timer, foo.service");

        await trigger("FailBaz");
        await r.waitFor("3 failed units: bar.timer, baz.service, foo.service");
        // Only the unit that entered "failed" was looked up.
        expect(callsTo("GetAll").map(c => c.call)).toEqual([[unitPath("baz.service"), "org.freedesktop.DBus.Properties", "GetAll", [UNIT]]]);

        await trigger("RecoverFoo");
        await r.waitFor("2 failed units: bar.timer, baz.service");

        await trigger("RemoveBar");
        await r.waitFor("1 failed unit: baz.service");

        // A daemon reload: signals in between are ignored, then a fresh list.
        await trigger("Reload");
        await r.waitFor("2 failed units: bar.timer, foo.service");
        expect(callsTo("ListUnitsFiltered")).toHaveLength(2);
    });

    it("opens the failed units on the Services page", async () => {
        const r = await start();
        const frame = await r.waitFor("2 failed units");
        expect(hintsLine(frame)).toContain("enter show failed");
        await r.press(keys.enter);
        expect(r.navigations).toEqual([["services", { filter: "failed", user: false }]]);
    });

    it("says so when there are no failed units, and when it cannot tell", async () => {
        const ok = scenario();
        (ok.dbus!.system![SYSTEMD]!["org.freedesktop.systemd1.Manager"]!.methods!.ListUnitsFiltered as JsonObject).reply = [[]];
        let r = await start(ok);
        let frame = await r.waitFor(`${glyphs.check} No failed services`);
        // Nothing to select there: Enter acts on the host name.
        expect(frame).toContain(`${glyphs.pointer} Host name`);
        cleanup();
        mock!.close();

        const broken = scenario();
        (broken.dbus!.system![SYSTEMD]!["org.freedesktop.systemd1.Manager"]!.methods!.ListUnitsFiltered as JsonObject).error =
            ["org.freedesktop.DBus.Error.AccessDenied", ["Sender is not authorized"]];
        delete (broken.dbus!.system![SYSTEMD]!["org.freedesktop.systemd1.Manager"]!.methods!.ListUnitsFiltered as JsonObject).reply;
        r = await start(broken);
        frame = await r.waitFor("Could not check for failed units");
        // The reason on its own line, so a half-width column does not cut it.
        const lines = pageLines(frame);
        const at = lines.findIndex(line => line.includes("Could not check for failed units"));
        expect(lines[at + 1]).toContain("Sender is not authorized");
    });

    it("does not claim that no unit failed when only units it does not count did", async () => {
        // A mount or swap that failed at boot: not one of the Services page's
        // types, so not counted -- and then not "no failed units" either.
        const other = scenario();
        (other.dbus!.system![SYSTEMD]!["org.freedesktop.systemd1.Manager"]!.methods!.ListUnitsFiltered as JsonObject).reply =
            [[unitRow("mnt-disk2.mount", "failed"), unitRow("dev-sdb2.swap", "failed")]];
        const r = await start(other);
        const frame = await r.waitFor(`${glyphs.check} No failed services`);
        expect(frame).not.toContain("No failed units");
    });

    it("uses two columns only where the usage rows keep their units", async () => {
        // The usage column is the right one, ceil((width - 3) / 2) wide; a
        // rate row needs 42 with its indent.
        for (const columns of [84, 85, 86]) {
            const r = await start({}, { columns, rows: 36 });
            const frame = await r.waitFor(f => f.includes("33.9 kB") && f.includes("90.0 kB"));
            expect(frame, `${columns} columns`).toContain("in   33.9 kB/s  out    183 kB/s");
            expect(frame, `${columns} columns`).toMatch(/read 90\.0 kB\/s {2}write {5}0 B\/s/);
            const twoColumns = /^Health\s+Usage/m.test(frame);
            expect(twoColumns, `${columns} columns`).toBe(columns >= 86);
            cleanup();
            mock!.close();
            mock = null;
        }
    });

    it("reads the host's clock once per visit", async () => {
        const dates = () => spawned().filter(open => (open.spawn as string[]).join(" ") === "env -u TZ date +%s %z %Z").length;
        const r = await start();
        // The CPU figure needs two metrics samples: it lands well after
        // timedated's properties, which used to start a second `date`.
        await r.waitFor(f => f.includes("25% of 16 CPUs") && f.includes("America/Denver (UTC-06:00)"));
        expect(dates()).toBe(1);
        remount();
        await mock!.waitForReceived(entry => entry.control?.command === "open" && entry.control.payload === "metrics1" &&
                                           mock!.opened("metrics1").length === 2);
        await r.waitFor(f => !f.includes(`updating${glyphs.ellipsis}`) && f.includes("25% of 16 CPUs") &&
                             f.includes("America/Denver (UTC-06:00)"));
        expect(dates()).toBe(2);
    });

    it("frames each section in a panel where the page has the room: side by side, or one above the other", async () => {
        const top = (title: string) => `${frame.topLeft}${frame.horizontal}${frame.titleLeft} ${title} ${frame.titleRight}`;
        const r = await start({}, { columns: 120, rows: 36, panels: true });
        // Usage and the failed units arrive on channels of their own: the page is laid out as
        // asserted below, selection included, once both are in (until then the first row is selected).
        const wide = await r.waitFor(f => f.includes("25% of 16 CPUs") && (selectedRow(f) ?? "").includes("failed units"));
        const lines = pageLines(wide);
        // The host, then two bands of two panels, each line as wide as the page.
        expect(lines[0]!.startsWith(top("Host"))).toBe(true);
        expect(lines[1]).toMatch(/^.Server Box \(server-box\) +up .*.$/);
        const band = lines.findIndex(line => line.includes(top("Health")));
        expect(lines[band]!.indexOf(top("Health"))).toBe(0);
        expect(lines[band]!.indexOf(top("Usage"))).toBe(60);
        // Less the column of the right panel's shadow.
        expect(lines[band]!.trimEnd()).toHaveLength(119);
        const second = lines.findIndex(line => line.includes(top("System information")));
        expect(lines[second]).toContain(top("Configuration"));
        expect(lines[second]).toContain(" h host name, t time ");
        // The shorter panel of a band is padded to the taller one's height.
        const bottoms = lines.flatMap((line, i) => (line.startsWith(frame.bottomLeft) ? [i] : []));
        // Under each bottom border, the row of the shadow.
        expect(bottoms).toEqual([band - 2, second - 2, bottoms[2]!]);
        expect(lines[band - 1]!.trim()).toBe("");
        for (const i of bottoms.slice(1))
            expect(lines[i]!.split(frame.bottomLeft)).toHaveLength(3);
        // The selection is drawn inside its panel, and still moves.
        expect(selectedRow(wide)).toContain("failed units");
        await r.press(keys.down);
        await r.waitFor(f => (selectedRow(f) ?? "").includes("Host name"));
        cleanup();
        mock!.close();

        // Too narrow for two: one panel above the other, scrolling as plain lines do.
        const narrow = await start({}, { columns: 80, rows: 24, panels: true });
        const frameText = await narrow.waitFor("25% of 16 CPUs");
        const rows = pageLines(frameText);
        expect(rows).toHaveLength(22);
        expect(rows.find(line => line.startsWith(top("Usage")))).toBeDefined();
        expect(rows.some(line => line.includes(top("Health")) && line.includes(top("Usage")))).toBe(false);
        expect(rows[21]!.trimEnd().endsWith(glyphs.down)).toBe(true);
        await narrow.press(keys.end);
        await narrow.waitFor(f => f.includes(top("Configuration")) && /NTP/.test(f));
    });

    it("fits an 80x24 terminal: one column, no blank lines, scrolling with a marker", async () => {
        // 80x24 leaves the page 65x22 beside the menu, above the footer.
        const r = await start({}, { columns: 65, rows: 24 });
        const frame = await r.waitFor("25% of 16 CPUs");
        const lines = pageLines(frame);
        expect(lines).toHaveLength(22);
        expect(lines.every(line => line.length <= 65)).toBe(true);
        expect(lines[21]!.trimEnd().endsWith(glyphs.down)).toBe(true);
        expect(frame).toMatch(/^Health/m);
        expect(frame).toMatch(/^Usage/m);
        // Compact: no blank lines, the header's included; with the limited
        // access line the last row is one too many.
        expect(lines[3]).toMatch(/^Health/);
        expect(frame).toMatch(/^ {2}Time zone/m);
        expect(frame).not.toMatch(/^ {2}NTP/m);
        // End shows the bottom, with the marker pointing back up.
        await r.press(keys.end);
        const bottom = await r.waitFor(/^ {2}NTP/m);
        expect(pageLines(bottom)[0]!.trimEnd().endsWith(glyphs.up)).toBe(true);
        await r.press(keys.home);
        await r.waitFor(f => f.split("\n")[0]!.startsWith("Server Box (server-box)"));
    });

    it("fits an 80x24 terminal without scrolling when administrative access is on", async () => {
        const r = await start({ superuser: true }, { columns: 65, rows: 24, allowed: true });
        const frame = await r.waitFor(f => f.includes("25% of 16 CPUs") && /^ {2}NTP/m.test(f));
        const lines = pageLines(frame);
        expect(lines).toHaveLength(22);
        expect(lines[21]).toMatch(/^ {2}NTP/);
        // No scroll marker: it would be the last column, after a blank.
        expect(lines.some(line => line.endsWith(` ${glyphs.down}`) || line.endsWith(` ${glyphs.up}`))).toBe(false);
        expect(frame).not.toContain("Limited access");
    });

    it("stays within a 50x10 area", async () => {
        const r = await start({}, { columns: 50, rows: 12 });
        const frame = await r.waitFor(f => f.includes("Server Box") && f.includes("25% of 16 CPUs"));
        const lines = pageLines(frame);
        expect(lines).toHaveLength(10);
        expect(lines.every(line => line.length <= 50)).toBe(true);
        // Rows below may still be arriving and growing the page: End again
        // until the last one is in view.
        for (let i = 0; i < 20 && !/^ {2}NTP/m.test(r.lastFrame()); i++) {
            await r.press(keys.end);
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        const bottom = await r.waitFor(/^ {2}NTP/m);
        expect(pageLines(bottom)).toHaveLength(10);
    });

    it("moves the selection with the arrows and scrolls it into view", async () => {
        const r = await start({}, { columns: 65, rows: 24 });
        await r.waitFor(f => f.includes("2 failed units") && f.includes("Server Box (server-box)"));
        expect(r.lastFrame()).toContain(`${glyphs.pointer} ${glyphs.cross} 2 failed units`);
        await r.press(keys.down);
        // From the failed units to the host name, far below: the page scrolls.
        const frame = await r.waitFor(`${glyphs.pointer} Host name`);
        expect(hintsLine(frame)).toContain("enter host name");
        await r.press(keys.down);
        await r.waitFor(`${glyphs.pointer} System time`);
        expect(hintsLine(r.lastFrame())).toContain("enter time");
        await r.press(keys.up, keys.up);
        await r.waitFor(`${glyphs.pointer} ${glyphs.cross} 2 failed units`);
    });

    it("lets the shell's keys through", async () => {
        const r = await start();
        await r.waitFor("Server Box (server-box)");
        await r.press("q", "1", "5", "A", "?", keys.tab, keys.shiftTab);
        expect(passedThrough).toEqual(["q", "1", "5", "A", "?", "tab", "shift+tab"]);
        // Lower-case r and s are not the power keys; they reach the shell too.
        await r.press("r", "s");
        expect(passedThrough.slice(-2)).toEqual(["r", "s"]);
        expect(r.lastFrame()).not.toMatch(/Restart server-box|Shut down server-box/);
    });

    it("works in an empty scenario without crashing", async () => {
        mock = await startMock({});
        await initInfo();
        const r = renderPage(ShellLike, { columns: 100, rows: 30 });
        const frame = await r.waitFor(f => f.includes("Could not check for failed units") && f.includes("unknown"));
        expect(frame).toContain("Health");
        expect(frame).toContain("localhost"); // the shell's host name stands in for hostnamed
        expect(frame).not.toContain("Internal error");
        expect(lineCount(frame)).toBe(30);
        // hostnamed and timedated are missing: say so instead of opening dialogs.
        await r.press("h");
        await r.waitFor("status: error: The host name cannot be changed: hostnamed is not available");
        await r.press("t");
        await r.waitFor("status: error: The time cannot be changed: timedated is not available");
    });

    it("decodes a compressing (C) bridge's metrics", async () => {
        const r = await start({ metricsCompress: true });
        const frame = await r.waitFor(f => f.includes("25% of 16 CPUs") && f.includes("in   33.9 kB/s"));
        expect(frame).toContain("16.0 / 58.5 GiB");
        // After a few compressed rows the values still stand.
        await new Promise(resolve => setTimeout(resolve, 400));
        expect(r.lastFrame()).toContain("25% of 16 CPUs");
        expect(r.lastFrame()).toContain("in   33.9 kB/s");
    });

    it("hides swap on a host without it", async () => {
        const r = await start({ spawn: { "cat /proc/meminfo /proc/cpuinfo": { stdout: MEMINFO.replace(/SwapTotal:.*\n/, "SwapTotal: 0 kB\n") + CPUINFO } } });
        await r.waitFor("25% of 16 CPUs");
        expect(r.lastFrame()).not.toMatch(/^\s*Swap/m);
        expect(r.lastFrame()).toContain("16.0 / 58.5 GiB");
    });

    it("reports a metrics channel the bridge refused", async () => {
        // The bridge closes the open with protocol-error and a message, as it
        // does for any option it rejects.
        usageSettings.interval = 0;
        const r = await start();
        const frame = await r.waitFor(f => f.includes("Usage is unavailable") && f.includes("2 failed units"));
        const lines = pageLines(frame);
        const at = lines.findIndex(line => line.includes("Usage is unavailable"));
        expect(lines[at + 1]).toContain('protocol-error: invalid "interval" value: 0');
        expect(frame).not.toContain("CPU ");
    });

    it("works without the totals: memory used, no CPU percentage", async () => {
        const r = await start({ spawn: { "cat /proc/meminfo /proc/cpuinfo": { "exit-status": 1, stderr: "cat: no\n" } } });
        const frame = await r.waitFor(f => f.includes("16 GiB used") && f.includes("in   33.9 kB/s"));
        // No CPU count, so no percentage and no "of N CPUs" either.
        expect(frame).toMatch(new RegExp(`CPU\\s+\\[[^\\]]*\\]\\s+${unicode ? "\u2014" : "-"} *\n`));
        expect(frame).not.toMatch(/^\s*Swap/m);
    });

    it("shows the last figures, dimmed, while a revisit waits for fresh ones", async () => {
        const r = await start();
        await r.waitFor("25% of 16 CPUs");
        // Come back with a channel that will not have a second sample (and
        // so no CPU figure) for a long while.
        usageSettings.interval = 60_000;
        remount();
        const frame = await r.waitFor(`updating${glyphs.ellipsis}`);
        expect(frame).toContain("25% of 16 CPUs");
        expect(mock!.opened("metrics1")).toHaveLength(2);
    });

    it("shows the message of the day, made safe for the terminal", async () => {
        const r = await start({ files: { "/etc/motd": "\n\n  Welcome to \x1b[31mthe box\x1b[0m\n\tLine two\n\n" } });
        const frame = await r.waitFor("Message of the day");
        expect(frame).toContain("Welcome to ^[[31mthe box^[[0m");
        expect(frame).toContain("        Line two");
        expect(frame).not.toContain("\x1b[31m");
    });

    it("cleans host names and hardware strings", async () => {
        const nasty = scenario();
        nasty.dbus!.system![HOSTNAME1]!["org.freedesktop.hostname1"]!.properties!.PrettyHostname = "Evil\x1b]0;pwned\x07Box";
        nasty.spawn!["/bin/sh -c grep -r . /sys/class/dmi/id || true --"] = {
            stdout: "/sys/class/dmi/id/sys_vendor:Bad\x1b[2JVendor\n/sys/class/dmi/id/product_name:Model\n",
        };
        const r = await start(nasty);
        const frame = await r.waitFor("Bad^[[2JVendor");
        expect(frame).toContain("Evil^[]0;pwned^GBox (server-box)");
        expect(r.lastRawFrame()).not.toContain("\x1b]0;");
        expect(r.lastRawFrame()).not.toContain("\x1b[2J");
    });
});

/*
 * Everything in a raw frame that would drive the terminal: control
 * characters and escape sequences other than the SGR styling Ink emits
 * itself (C0 but the newlines between rows, DEL, C1).
 */
function strayControls(raw: string): string[] {
    // eslint-disable-next-line no-control-regex
    const unstyled = raw.replace(/\x1b\[[0-9;]*m/g, "");
    // eslint-disable-next-line no-control-regex
    return [...new Set(unstyled.match(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g) ?? [])]
        .map(c => `U+${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Wait for a condition that is not about the screen. */
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline)
            throw new Error("timed out waiting for a condition");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

describe("host text", () => {
    // A link (OSC 8), a screen clear, a C1 CSI, BEL, CR and BS in one.
    const NASTY = "\x1b]8;;http://evil.example/\x07L\x1b]8;;\x07\x1b[2J\u009b31m\x07\r\x08";
    const tagged = (tag: string) => `${tag}${NASTY}`;

    it("never reaches the terminal raw, on the page or in its dialogs", async () => {
        const nasty = scenario({
            superuser: true,
            info: {
                channels: { "dbus-json3": [], fsinfo: [], fsread1: [], fsreplace1: ["attrs"], fswatch1: [], info: [],
                            metrics1: [], null: [], stream: [] },
                os_release: { NAME: "Mock", ID: "mock", PRETTY_NAME: tagged("os") },
                user: { fullname: "Mock", gid: 1000, group: "mock", groups: ["mock", "wheel"], home: "/home/mock",
                        name: "mock", shell: "/bin/bash", uid: 1000 },
            },
            files: {
                "/etc/machine-id": `${tagged("mid")}\n`,
                "/etc/motd": `${tagged("motd")}\n`,
                [SCHEDULE]: `USEC=${(Date.now() + 4 * 60_000) * 1000}\nWARN_WALL=1\nMODE=${tagged("mode")}\nUID=0\n` +
                    `WALL_MESSAGE=${tagged("wall")}\n`,
            },
            spawn: {
                "uname -r -m": { stdout: `${tagged("kernel")} ${tagged("arch")}\n` },
                "env -u TZ date +%s %z %Z": { stdout: `${Math.floor(Date.now() / 1000)} -0600 ${tagged("abbr")}\n` },
                "/bin/sh -c grep -r . /sys/class/dmi/id || true --": {
                    stdout: `/sys/class/dmi/id/sys_vendor:${tagged("vendor")}\n/sys/class/dmi/id/product_name:${tagged("model")}\n`,
                },
            },
        });
        const system = nasty.dbus!.system!;
        Object.assign(system[HOSTNAME1]!["org.freedesktop.hostname1"]!.properties!, {
            PrettyHostname: tagged("pretty"), StaticHostname: tagged("static"),
        });
        const timedate = system[TIMEDATE1]!["org.freedesktop.timedate1"]!;
        timedate.properties!.Timezone = tagged("tz");
        timedate.methods!.ListTimezones = { reply: [[tagged("zone"), "UTC"]], out: ["as"] };
        (system[SYSTEMD]!["org.freedesktop.systemd1.Manager"]!.methods!.ListUnitsFiltered as JsonObject).reply =
            [[unitRow(`${tagged("unit")}.service`, "failed")]];
        system[LOGIN1]![LOGIN1_MANAGER]!.methods!.CancelScheduledShutdown = {
            error: ["org.freedesktop.DBus.Error.Failed", [tagged("error")]],
        };

        const r = await start(nasty, { columns: 160, rows: 44, allowed: true });
        const page = await r.waitFor(f => ["os", "pretty", "static", "unit", "mode", "wall", "tz", "abbr", "kernel", "mid",
                                           "vendor", "model", "motd"].every(tag => f.includes(`${tag}^[`)));
        expect(page).toContain("Shutdown (mode^[]8;;http://evil.example/^GL");
        expect(strayControls(r.lastRawFrame())).toEqual([]);

        // The cancel dialog: its title, text, buttons and hints name the mode.
        await r.press("c");
        await r.waitFor("Cancel the scheduled shutdown (mode^[");
        expect(hintsLine(r.lastFrame())).toContain("cancel the shutdown (mode^[");
        expect(strayControls(r.lastRawFrame())).toEqual([]);
        // A failure's text is the host's too.
        await r.press(keys.enter);
        await r.waitFor("error^[");
        expect(strayControls(r.lastRawFrame())).toEqual([]);
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Cancel the scheduled"));

        // The time dialog and its zone list.
        await r.press("t");
        await r.waitFor("Change system time");
        expect(strayControls(r.lastRawFrame())).toEqual([]);
        await r.press(" ");
        await r.waitFor("zone^[");
        expect(strayControls(r.lastRawFrame())).toEqual([]);
        await r.press(keys.escape);
        await r.waitFor(f => f.includes("Change system time") && !f.includes("zone^["));

        // The power and host name dialogs, titled with the host's name.
        await r.press(keys.escape, "R");
        await r.waitFor("Restart static^[");
        expect(strayControls(r.lastRawFrame())).toEqual([]);
        await r.press(keys.escape, "h");
        await r.waitFor("Change host name");
        expect(strayControls(r.lastRawFrame())).toEqual([]);
    });
});

describe("leaving the page", () => {
    it("closes every channel it kept open", async () => {
        const longLived = () => mock!.opened().filter(open => ["dbus-json3", "metrics1", "fsinfo"].includes(String(open.payload)))
            .map(open => String(open.channel));
        const closed = () => new Set(mock!.controls("close").map(close => String(close.channel)));
        const r = await start();
        await r.waitFor(f => f.includes("25% of 16 CPUs") && f.includes("MDT") && f.includes("x86_64"));
        const first = longLived();
        // hostname1, timedate1 and systemd1 clients, the metrics, two file watches.
        expect(first.length).toBeGreaterThanOrEqual(6);
        expect(mock!.opened("metrics1")).toHaveLength(1);
        expect(mock!.opened("fsinfo")).toHaveLength(2);

        // Coming back: every channel of the first visit is closed...
        remount();
        await until(() => first.every(id => closed().has(id)));
        await r.waitFor(f => f.includes("25% of 16 CPUs") && !f.includes(`updating${glyphs.ellipsis}`));
        const second = longLived().filter(id => !first.includes(id));
        expect(second.length).toBeGreaterThanOrEqual(6);
        // ...and leaving closes the second's.
        cleanup();
        await until(() => second.every(id => closed().has(id)));
    });
});

describe("a scheduled shutdown", () => {
    const file = (minutes: number, mode = "reboot") =>
        `USEC=${(Date.now() + minutes * 60_000) * 1000}\nWARN_WALL=1\nMODE=${mode}\nUID=0\nWALL_MESSAGE=Kernel update\\, back soon\n`;

    it("is shown with its time and message, and only an admin may cancel it", async () => {
        const r = await start({ files: { [SCHEDULE]: file(4) } });
        const frame = await r.waitFor("Restart scheduled in");
        // The countdown on the row itself, the time and message beneath.
        expect(frame).toMatch(/! Restart scheduled in [45] min\s/);
        expect(frame).toMatch(/ {4}at \d{4}-\d\d-\d\d \d\d:\d\d {2}"Kernel update, back soon"/);
        await r.press("c");
        await r.waitFor("status: warning: Cancelling a scheduled shutdown needs administrative access: press A to turn it on");
        expect(r.lastFrame()).not.toContain("Cancel the scheduled restart?");
    });

    it("appears and disappears as logind writes and removes its file", async () => {
        const r = await start({
            dbus: {
                ...scenario().dbus,
                system: {
                    ...scenario().dbus!.system,
                    "/test2": {
                        "test.Schedule": {
                            methods: {
                                Schedule: { reply: [], effects: [{ files: { [SCHEDULE]: file(30, "poweroff") } }] },
                                Unschedule: { reply: [], effects: [{ files: { [SCHEDULE]: null } }] },
                            },
                        },
                    },
                },
            },
        });
        await r.waitFor("2 failed units");
        expect(r.lastFrame()).not.toContain("scheduled");
        const control = async (method: string) => {
            const client = cockpit.dbus(null, { bus: "system" });
            try {
                await client.call("/test2", "test.Schedule", method, []);
            } finally {
                client.close();
            }
        };
        await control("Schedule");
        await r.waitFor(/Shutdown scheduled in (29|30) min/);
        await control("Unschedule");
        await r.waitFor(f => !f.includes("Shutdown scheduled"));
    });

    it("says when it cannot tell, rather than showing nothing", async () => {
        // Readable to root only: the watch sees it, the read is refused.
        const r = await start({ files: { [SCHEDULE]: { content: file(4), mode: 0o600, user: "root", group: "root" } } });
        const frame = await r.waitFor("Cannot see scheduled shutdowns");
        const lines = pageLines(frame);
        const at = lines.findIndex(line => line.includes("Cannot see scheduled shutdowns"));
        // The bridge's words for EACCES ("Permission denied"; older mocks: the problem code's text).
        expect(lines[at + 1]).toMatch(/^ {4}(Permission denied|Not permitted)/);
        expect(frame).not.toContain("Restart scheduled");
    });

    it("is cancelled through logind after confirming", async () => {
        const r = await start({ superuser: true, files: { [SCHEDULE]: file(4) } }, { allowed: true });
        await r.waitFor("Restart scheduled in");
        await r.press("c");
        await r.waitFor("Cancel the scheduled restart?");
        expect(r.lastFrame()).toContain("[Enter] Cancel the restart   [Esc] Keep it");
        await r.press(keys.enter);
        await r.waitFor("status: success: Scheduled restart cancelled");
        await r.waitFor(f => !f.includes("Restart scheduled in") && !f.includes("Cancel the scheduled restart?"));
        // upstream's call (shutdownStatus.tsx), not `shutdown -c`, which would
        // first reset logind's wall-message settings.
        const cancels = callsTo("CancelScheduledShutdown");
        expect(cancels.map(c => c.call)).toEqual([[LOGIN1, LOGIN1_MANAGER, "CancelScheduledShutdown", []]]);
        expect(cancels[0]!.open).toMatchObject({ name: "org.freedesktop.login1", superuser: "try" });
        expect(spawned().some(open => (open.spawn as string[])[0] === "shutdown")).toBe(false);
        // logind removed its file before it replied, taking the schedule
        // away under the open dialog: the page must still be usable.
        await r.waitFor(f => hintsLine(f).includes("enter show failed"));
        await r.press("h");
        await r.waitFor("Change host name");
    });

    it("stays usable when logind drops the schedule before its cancel has returned", async () => {
        // The order a real host produces: the file goes, then the call
        // returns. A dialog rendered only while a schedule exists would vanish
        // before reporting back, leaving the page's keys switched off.
        const r = await start({
            superuser: true,
            files: { [SCHEDULE]: file(4) },
            dbus: {
                ...scenario().dbus,
                system: {
                    ...scenario().dbus!.system,
                    [LOGIN1]: { [LOGIN1_MANAGER]: { methods: { CancelScheduledShutdown: { reply: [true], out: ["b"], delayMs: 300 } } } },
                    "/test2": { "test.Schedule": { methods: { Unschedule: { reply: [], effects: [{ files: { [SCHEDULE]: null } }] } } } },
                },
            },
        }, { allowed: true });
        await r.waitFor("Restart scheduled in");
        await r.press("c");
        await r.waitFor("Cancel the scheduled restart?");
        await r.press(keys.enter);
        await r.waitFor("Cancelling");
        const client = cockpit.dbus(null, { bus: "system" });
        try {
            await client.call("/test2", "test.Schedule", "Unschedule", []);
        } finally {
            client.close();
        }
        await r.waitFor(f => !f.includes("Restart scheduled in"));
        // Still the dialog's, busy, until the command reports.
        expect(r.lastFrame()).toContain("Cancelling");
        await r.waitFor("status: success: Scheduled restart cancelled");
        await r.waitFor(f => !f.includes("Cancel the scheduled restart?") && hintsLine(f).includes("enter show failed"));
        await r.press("h");
        await r.waitFor("Change host name");
    });

    it("says so when the schedule goes away by other means while the dialog is open", async () => {
        const r = await start({
            superuser: true,
            files: { [SCHEDULE]: file(4) },
            dbus: {
                ...scenario().dbus,
                system: {
                    ...scenario().dbus!.system,
                    "/test2": { "test.Schedule": { methods: { Unschedule: { reply: [], effects: [{ files: { [SCHEDULE]: null } }] } } } },
                },
            },
        }, { allowed: true });
        await r.waitFor("Restart scheduled in");
        await r.press("c");
        await r.waitFor("Cancel the scheduled restart?");
        const client = cockpit.dbus(null, { bus: "system" });
        try {
            await client.call("/test2", "test.Schedule", "Unschedule", []);
        } finally {
            client.close();
        }
        const frame = await r.waitFor("is no longer scheduled");
        expect(frame).toContain("[Esc] Close");
        await r.press(keys.enter);
        await r.waitFor(f => !f.includes("Cancel the scheduled restart?"));
        expect(callsTo("CancelScheduledShutdown")).toHaveLength(0);
        await r.waitFor(f => hintsLine(f).includes("enter show failed"));
    });

    it("says so when logind had nothing left to cancel", async () => {
        const nothing = scenario({ superuser: true, files: { [SCHEDULE]: file(4) } });
        nothing.dbus!.system![LOGIN1]![LOGIN1_MANAGER]!.methods!.CancelScheduledShutdown = { reply: [false], out: ["b"] };
        const r = await start(nothing, { allowed: true });
        await r.waitFor("Restart scheduled in");
        await r.press("c");
        await r.waitFor("Cancel the scheduled restart?");
        await r.press(keys.enter);
        await r.waitFor("status: info: The restart was no longer scheduled");
        expect(r.lastFrame()).not.toContain("success");
    });

    it("lists its keys in the Health heading and the footer", async () => {
        const r = await start({ superuser: true, files: { [SCHEDULE]: file(4) } }, { allowed: true });
        const frame = await r.waitFor(f => f.includes("Restart scheduled in") && f.includes("2 failed units"));
        expect(frame).toMatch(/^Health {2}c cancel, R restart, S shut down/m);
        // The selection is on the failed units: c is the way to the schedule.
        expect(hintsLine(frame)).toContain("enter show failed | c cancel restart | R restart | S shut down");
        await r.press(keys.down);
        // On the schedule's row Enter says it, and c is not repeated.
        const onRow = await r.waitFor(f => hintsLine(f).includes("enter cancel it"));
        expect(hintsLine(onRow)).not.toContain("c cancel");
    });

    it("keeps the dialog open with the error when cancelling fails", async () => {
        const refused = scenario({ superuser: true, files: { [SCHEDULE]: file(4) } });
        refused.dbus!.system![LOGIN1]![LOGIN1_MANAGER]!.methods!.CancelScheduledShutdown = {
            error: ["org.freedesktop.DBus.Error.AccessDenied", ["Failed to talk to logind, shutdown hasn't been cancelled"]],
        };
        const r = await start(refused, { allowed: true });
        // Both rows first: the selection order depends on what is there.
        await r.waitFor(f => f.includes("Restart scheduled in") && f.includes("2 failed units"));
        await r.press(keys.down); // from the failed units to the schedule
        await r.waitFor(f => hintsLine(f).includes("enter cancel it"));
        await r.press(keys.enter);
        await r.waitFor("Cancel the scheduled restart?");
        await r.press(keys.enter);
        await r.waitFor("Failed to talk to logind, shutdown hasn't been cancelled");
        expect(r.lastFrame()).toContain("Cancel the scheduled restart?");
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Cancel the scheduled restart?"));
        expect(r.lastFrame()).toContain("Restart scheduled in");
    });
});

describe("restart and shut down", () => {
    it("need administrative access", async () => {
        const r = await start();
        const frame = await r.waitFor("Server Box (server-box)");
        expect(hintsLine(frame)).not.toContain("restart");
        await r.press("R");
        await r.waitFor("status: warning: Restarting needs administrative access: press A to turn it on");
        await r.press("S");
        await r.waitFor("status: warning: Shutting down needs administrative access");
        expect(spawned().some(open => (open.spawn as string[])[0] === "shutdown")).toBe(false);
    });

    it("schedule a restart with upstream's exact command", async () => {
        const later = `USEC=${(Date.now() + 5 * 60_000) * 1000}\nWARN_WALL=1\nMODE=reboot\nUID=0\nWALL_MESSAGE=bye now\n`;
        const r = await start({
            superuser: true,
            spawnPatterns: [{ match: "^shutdown --reboot ", stdout: "", stderr: "Reboot scheduled for ..., use 'shutdown -c' to cancel.\n",
                              effects: [{ files: { [SCHEDULE]: later } }] }],
        }, { allowed: true });
        const ready = await r.waitFor("Server Box (server-box)");
        expect(hintsLine(ready)).toContain("R restart | S shut down");
        expect(ready).not.toContain("Limited access");
        await r.press("R");
        let frame = await r.waitFor("Restart server-box");
        expect(frame).toContain("In 1 minute"); // upstream's default
        await r.press(keys.right); // 1 -> 5 minutes
        frame = await r.waitFor("In 5 minutes");
        expect(frame).toContain("restarts in 5 minutes");
        await r.press(keys.down, "bye now");
        await r.waitFor("bye now");
        await r.press(keys.enter);
        await r.waitFor("status: success: Restart scheduled in 5 minutes");
        // The page's own row, from logind's file appearing.
        await r.waitFor(/! Restart scheduled in [45] min/);
        const shutdown = spawned().filter(open => (open.spawn as string[])[0] === "shutdown");
        expect(shutdown).toHaveLength(1);
        expect(shutdown[0]).toMatchObject({ spawn: ["shutdown", "--reboot", "--", "+5", "bye now"], superuser: "require", err: "message" });
        // Not immediate: the connection is expected to stay.
        expect(expectedDisconnectReason()).toBeNull();
    });

    it("expect the connection to drop once a delayed one is due, and not after it is cancelled", async () => {
        // A margin past the delay makes "In 1 minute" due at once.
        powerSettings.dueMarginMs = 120_000;
        const later = `USEC=${(Date.now() + 60_000) * 1000}\nWARN_WALL=1\nMODE=reboot\nUID=0\n`;
        const r = await start({
            superuser: true,
            spawnPatterns: [{ match: "^shutdown --reboot ", stdout: "", effects: [{ files: { [SCHEDULE]: later } }] }],
        }, { allowed: true });
        await r.waitFor("Server Box (server-box)");
        await r.press("R");
        await r.waitFor("Restart server-box");
        await r.press(keys.enter);
        await r.waitFor("status: success: Restart scheduled in 1 minute");
        expect(expectedDisconnectReason()).toBe("server-box is restarting.");
        // Cancelled here: a dropped connection is a failure again.
        await r.waitFor(/! Restart scheduled in/);
        await r.press("c");
        await r.waitFor("Cancel the scheduled restart?");
        await r.press(keys.enter);
        await r.waitFor("status: success: Scheduled restart cancelled");
        expect(expectedDisconnectReason()).toBeNull();
    });

    it("keep expecting the drop when logind removes a due schedule to carry it out", async () => {
        powerSettings.dueMarginMs = 120_000;
        const later = `USEC=${(Date.now() + 60_000) * 1000}\nWARN_WALL=1\nMODE=poweroff\nUID=0\n`;
        const r = await start({
            superuser: true,
            spawnPatterns: [{ match: "^shutdown --poweroff ", stdout: "", effects: [{ files: { [SCHEDULE]: later } }] }],
            dbus: { ...scenario().dbus, system: { ...scenario().dbus!.system, ...scheduleControl(() => later) } },
        }, { allowed: true });
        await r.waitFor("Server Box (server-box)");
        await r.press("S");
        await r.waitFor("Shut down server-box");
        await r.press(keys.enter);
        await r.waitFor(/! Shutdown scheduled in/);
        expect(expectedDisconnectReason()).toBe("server-box is shutting down.");
        await control("Unschedule");
        await r.waitFor(f => !/! Shutdown scheduled in/.test(f));
        expect(expectedDisconnectReason()).toBe("server-box is shutting down.");
    });

    it("pass the message after \"--\", where shutdown cannot take it for an option", async () => {
        const r = await start({ superuser: true, spawnPatterns: [{ match: "^shutdown ", stdout: "" }] }, { allowed: true });
        await r.waitFor("Server Box (server-box)");
        await r.press("R");
        await r.waitFor("Restart server-box");
        await r.press(keys.down, "-h");
        await r.waitFor(f => /Message\s+-h/.test(f));
        await r.press(keys.enter);
        await r.waitFor("status: success: Restart scheduled in 1 minute");
        const shutdown = spawned().find(open => (open.spawn as string[])[0] === "shutdown");
        expect(shutdown).toMatchObject({ spawn: ["shutdown", "--reboot", "--", "+1", "-h"], superuser: "require" });
    });

    it("offer every upstream delay, stopping at both ends", async () => {
        const r = await start({ superuser: true }, { allowed: true });
        await r.waitFor("Server Box (server-box)");
        await r.press("S");
        await r.waitFor("Shut down server-box");
        const shown = () => /< (Now|In \d+ minutes?) >/.exec(r.lastFrame())?.[1] ?? "?";
        const seen: string[] = [];
        for (let i = 0; i < 6; i++) {
            seen.push(shown());
            await r.press(keys.right);
        }
        // Past "In 60 minutes" it stays there: never round to "Now".
        expect(seen).toEqual(["In 1 minute", "In 5 minutes", "In 20 minutes", "In 40 minutes", "In 60 minutes", "In 60 minutes"]);
        // Space does not change it either (FormDialog's select would step on).
        await r.press(" ", " ", " ");
        expect(shown()).toBe("In 60 minutes");
        for (let i = 0; i < 6; i++)
            await r.press(keys.left);
        await r.waitFor("< Now >");
        await r.press(keys.left);
        expect(shown()).toBe("Now");
    });

    it("shut down now: the dropped connection is expected", async () => {
        const r = await start({ superuser: true, spawnPatterns: [{ match: "^shutdown --poweroff ", stdout: "" }] }, { allowed: true });
        await r.waitFor("Server Box (server-box)");
        await r.press("S");
        await r.waitFor("Shut down server-box");
        await r.press(keys.left); // 1 minute -> now
        const frame = await r.waitFor("powers off right away");
        expect(frame).toContain("stays off until someone powers it on again");
        await r.press(keys.enter);
        await r.waitFor("status: info: Shutting down server-box");
        const shutdown = spawned().find(open => (open.spawn as string[])[0] === "shutdown");
        // The message is passed even when empty, as upstream does.
        expect(shutdown).toMatchObject({ spawn: ["shutdown", "--poweroff", "--", "+0", ""], superuser: "require", err: "message" });
        expect(expectedDisconnectReason()).toBe("server-box is shutting down.");
    });

    it("show a failure in the dialog and forget the expected disconnect", async () => {
        // Administrative access as far as the page knows, but the bridge
        // refuses "require" channels.
        const r = await start({}, { allowed: true });
        await r.waitFor("Server Box (server-box)");
        await r.press("R");
        await r.waitFor("Restart server-box");
        await r.press(keys.left); // now
        await r.waitFor("restarts right away");
        await r.press(keys.enter);
        const frame = await r.waitFor(/not permitted|access-denied/i);
        expect(frame).toContain("Restart server-box");
        expect(expectedDisconnectReason()).toBeNull();
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Restart server-box"));
    });
});

describe("changing the host name", () => {
    it("follows the pretty name and sets both names", async () => {
        const r = await start();
        await r.waitFor("Server Box (server-box)");
        await r.press("h");
        let frame = await r.waitFor("Change host name");
        expect(frame).toContain("Pretty name");
        await r.press(keys.ctrl("u"), "Web Server 1");
        frame = await r.waitFor("web-server-1");
        await r.press(keys.enter);
        await r.waitFor("status: success: Host name changed to web-server-1");
        await r.waitFor("Web Server 1 (web-server-1)");
        const calls = [...callsTo("SetStaticHostname"), ...callsTo("SetPrettyHostname")];
        expect(calls.map(c => c.call)).toEqual([
            [HOSTNAME1, "org.freedesktop.hostname1", "SetStaticHostname", ["web-server-1", true]],
            [HOSTNAME1, "org.freedesktop.hostname1", "SetPrettyHostname", ["Web Server 1", true]],
        ]);
        for (const { open } of calls)
            expect(open).toMatchObject({ name: "org.freedesktop.hostname1", superuser: "try" });
        // Static first: it is the one that can be refused.
        const order = dbusCalls().map(c => c.call[2]);
        expect(order.indexOf("SetStaticHostname")).toBeLessThan(order.indexOf("SetPrettyHostname"));
    });

    it("validates the real name before sending anything", async () => {
        const r = await start();
        await r.waitFor("Server Box (server-box)");
        await r.press("h");
        await r.waitFor("Change host name");
        await r.press(keys.down, keys.ctrl("u"), "Bad_Name");
        await r.waitFor("Use only lower-case letters"); // the rest wraps onto the next line
        await r.press(keys.enter);
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(callsTo("SetStaticHostname")).toHaveLength(0);
        expect(r.lastFrame()).toContain("Change host name");
    });

    it("shows polkit's refusal and keeps the dialog open", async () => {
        const refused = scenario();
        const methods = refused.dbus!.system![HOSTNAME1]!["org.freedesktop.hostname1"]!.methods!;
        methods.SetStaticHostname = {
            in: ["s", "b"],
            error: ["org.freedesktop.DBus.Error.InteractiveAuthorizationRequired", ["Interactive authentication required."]],
        };
        const r = await start(refused);
        await r.waitFor("Server Box (server-box)");
        await r.press("h");
        await r.waitFor("Change host name");
        await r.press(keys.down, keys.ctrl("u"), "new-name");
        await r.press(keys.enter);
        // Wrapped in the dialog: "...: Interactive authentication" / "required. ..."
        const frame = await r.waitFor("Could not change the host name: Interactive authentication");
        expect(frame).toContain("Administrative access (A) may be needed.");
        expect(frame).toContain("Change host name");
        expect(callsTo("SetPrettyHostname")).toHaveLength(0);
    });

    it("just closes when nothing changed", async () => {
        const r = await start();
        await r.waitFor("Server Box (server-box)");
        await r.press("h");
        await r.waitFor("Change host name");
        await r.press(keys.enter);
        await r.waitFor(f => !f.includes("Change host name"));
        expect(callsTo("SetStaticHostname")).toHaveLength(0);
        expect(callsTo("SetPrettyHostname")).toHaveLength(0);
    });

    it("opens from the selected row with Enter", async () => {
        const ok = scenario();
        (ok.dbus!.system![SYSTEMD]!["org.freedesktop.systemd1.Manager"]!.methods!.ListUnitsFiltered as JsonObject).reply = [[]];
        const r = await start(ok);
        await r.waitFor(f => f.includes("No failed services") && f.includes("Server Box (server-box)"));
        await r.press(keys.enter);
        await r.waitFor("Change host name");
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Change host name"));
    });
});

describe("changing the system time", () => {
    it("picks a zone, turns NTP off and sets the time, in upstream's order", async () => {
        const target = "2026-10-03 09:30";
        const r = await start({
            spawn: { [`env -u TZ date --date=${target}:00 +%s`]: { stdout: "1791048600\n" } },
        });
        await r.waitFor("America/Denver (UTC-06:00)");
        await r.press("t");
        let frame = await r.waitFor("Change system time");
        expect(frame).toContain("[x] Synchronize automatically");
        expect(frame).toContain("set automatically while NTP is on");

        // The picker: type to filter, Enter to choose.
        await r.press("ber");
        frame = await r.waitFor("Europe/Berlin");
        expect(frame).toContain("1 of 5 zones");
        await r.press(keys.enter);
        await r.waitFor(f => f.includes("Change system time") && f.includes("Europe/Berlin"));

        await r.press(keys.down, " ");
        await r.waitFor("[ ] Synchronize automatically");
        await r.press(keys.down, keys.ctrl("u"), target);
        await r.waitFor(target);
        await r.press(keys.enter);
        await r.waitFor("status: success: System time settings changed");
        await r.waitFor("Europe/Berlin");

        const sets = dbusCalls().filter(c => /^Set(Timezone|NTP|Time)$/.test(String(c.call[2])));
        expect(sets.map(c => c.call)).toEqual([
            [TIMEDATE1, "org.freedesktop.timedate1", "SetTimezone", ["Europe/Berlin", true]],
            [TIMEDATE1, "org.freedesktop.timedate1", "SetNTP", [false, true]],
            [TIMEDATE1, "org.freedesktop.timedate1", "SetTime", [1791048600 * 1_000_000, false, true]],
        ]);
        for (const { open } of sets)
            expect(open).toMatchObject({ name: "org.freedesktop.timedate1", superuser: "try" });
        // The time was parsed by the host's date, after the zone change.
        expect(spawned().some(open => (open.spawn as string[]).join(" ") === `env -u TZ date --date=${target}:00 +%s`)).toBe(true);
        // NTP was confirmed off (polled) before the time was set.
        expect(callsTo("Get").some(c => (c.call[3] as unknown[])[1] === "NTP")).toBe(true);
        // The zone list came from timedated itself.
        expect(callsTo("ListTimezones")).toHaveLength(1);
    });

    it("suggests the time in a newly picked zone until one is typed", async () => {
        const r = await start();
        await r.waitFor("America/Denver (UTC-06:00)");
        await r.press("t");
        await r.waitFor("Change system time");
        await r.press(keys.down, " ");
        await r.waitFor("[ ] Synchronize automatically");
        // Denver time from the host's own `date` offset (-0600).
        const denver = (frame: string) => [0, 60_000].some(d => frame.includes(formatInOffset(Date.now() - d, -360)));
        await r.waitFor(denver);
        await r.press(keys.up, " ");
        await r.waitFor("5 of 5 zones");
        await r.press("berl");
        await r.waitFor("1 of 5 zones");
        await r.press(keys.enter);
        const berlin = (frame: string) => frame.includes("Change system time") &&
            [0, 60_000].some(d => frame.includes(`Time       ${formatInZone(Date.now() - d, "Europe/Berlin")}`));
        await r.waitFor(berlin);
        // Once typed in, the time is left alone.
        await r.press(keys.down, keys.down, keys.ctrl("u"), "2030-01-01 00:00", keys.up, keys.up, " ");
        await r.waitFor("Search");
        await r.press("paris", keys.enter);
        const frame = await r.waitFor(f => f.includes("Change system time") && f.includes("Europe/Paris"));
        expect(frame).toContain("2030-01-01 00:00");
    });

    it("turns NTP on and waits for timedated to confirm it", async () => {
        const off = scenario();
        const timedate = off.dbus!.system![TIMEDATE1]!["org.freedesktop.timedate1"]!;
        timedate.properties!.NTP = false;
        timedate.properties!.NTPSynchronized = false;
        timedate.methods!.SetNTP = {
            in: ["b", "b"], reply: [],
            byArgs: [{ args: [true, true], reply: [],
                       effects: [{ properties: [TIMEDATE1, "org.freedesktop.timedate1", { NTP: true }], delayMs: 150 }] }],
        };
        const r = await start(off);
        await r.waitFor(/NTP\s+off/);
        await r.press("t");
        await r.waitFor("[ ] Synchronize automatically");
        await r.press(keys.down, " ", keys.enter);
        await r.waitFor("status: success: System time settings changed");
        await r.waitFor(`${glyphs.warning} on, not synchronized yet`);
        expect(callsTo("SetNTP").map(c => c.call[3])).toEqual([[true, true]]);
        expect(callsTo("SetTimezone")).toHaveLength(0);
        expect(callsTo("SetTime")).toHaveLength(0);
    });

    it("does not set the time when NTP does not turn off in time", async () => {
        const stuck = scenario();
        const methods = stuck.dbus!.system![TIMEDATE1]!["org.freedesktop.timedate1"]!.methods!;
        methods.SetNTP = { in: ["b", "b"], reply: [] }; // replies, but NTP stays on
        const r = await start(stuck);
        timeSettings.ntpTimeoutMs = 500;
        await r.waitFor("America/Denver");
        await r.press("t");
        await r.waitFor("Change system time");
        await r.press(keys.down, " ", keys.down, keys.ctrl("u"), "2026-10-03 09:30", keys.enter);
        const frame = await r.waitFor("NTP was still on after 1 seconds");
        expect(frame).toContain("Could not turn off NTP");
        expect(callsTo("SetTime")).toHaveLength(0);
    });

    it("shows timedated's refusal and keeps the dialog open", async () => {
        const refused = scenario();
        refused.dbus!.system![TIMEDATE1]!["org.freedesktop.timedate1"]!.methods!.SetTimezone = {
            in: ["s", "b"],
            error: ["org.freedesktop.DBus.Error.InteractiveAuthorizationRequired", ["Interactive authentication required."]],
        };
        const r = await start(refused);
        await r.waitFor("America/Denver");
        await r.press("t");
        await r.waitFor("Change system time");
        await r.press("paris");
        await r.waitFor("Europe/Paris");
        await r.press(keys.enter);
        await r.waitFor(f => f.includes("Change system time") && f.includes("Europe/Paris"));
        await r.press(keys.enter);
        const frame = await r.waitFor("Could not set the time zone: Interactive authentication");
        expect(frame).toContain("Change system time");
        expect(callsTo("SetNTP")).toHaveLength(0);
    });

    it("checks the typed time before changing anything", async () => {
        const r = await start();
        await r.waitFor("America/Denver");
        await r.press("t");
        await r.waitFor("Change system time");
        await r.press(keys.down, " ", keys.down, keys.ctrl("u"), "2026-02-30 10:00", keys.enter);
        await r.waitFor("No such date");
        expect(dbusCalls().filter(c => /^Set/.test(String(c.call[2])))).toHaveLength(0);
    });

    it("closes without calls when nothing changed, and Esc leaves the picker", async () => {
        const r = await start();
        await r.waitFor("America/Denver");
        await r.press("t");
        await r.waitFor("Change system time");
        await r.press(" ");
        const picker = await r.waitFor("5 of 5 zones");
        expect(picker).toContain("America/Denver  (current)");
        await r.press(keys.escape);
        await r.waitFor(f => f.includes("Change system time") && !f.includes("5 of 5 zones"));
        await r.press(keys.enter);
        await r.waitFor(f => !f.includes("Change system time"));
        expect(dbusCalls().filter(c => /^Set/.test(String(c.call[2])))).toHaveLength(0);
    });

    it("shows a long zone name whole, without squeezing its label, at 50x10", async () => {
        const odd = scenario();
        odd.dbus!.system![TIMEDATE1]!["org.freedesktop.timedate1"]!.properties!.Timezone = "America/Argentina/ComodRivadavia";
        const r = await start(odd, { columns: 50, rows: 12 });
        await r.waitFor("Server Box");
        await r.press("t");
        const frame = await r.waitFor("Change system time");
        const lines = pageLines(frame);
        const at = lines.findIndex(line => line.includes("Time zone"));
        expect(lines[at]).toMatch(/Time zone {2}America\/Argentina\/ComodRivadavia [\u2502|]/);
        expect(lines[at]!.length).toBeLessThanOrEqual(50);
        // The label did not wrap into a line of its own.
        expect(lines[at + 1]).toMatch(/NTP/);
    });

    it("lets NTP be changed when the host's zone is not in the list", async () => {
        const odd = scenario();
        const timedate = odd.dbus!.system![TIMEDATE1]!["org.freedesktop.timedate1"]!;
        timedate.properties!.Timezone = "US/Mountain"; // a link, not listed by ListTimezones
        const r = await start(odd);
        await r.waitFor("US/Mountain");
        await r.press("t");
        await r.waitFor("Change system time");
        await r.press(keys.down, " ", keys.enter);
        await r.waitFor("status: success: System time settings changed");
        expect(callsTo("SetNTP").map(c => c.call[3])).toEqual([[false, true]]);
        expect(callsTo("SetTimezone")).toHaveLength(0);
    });
});

describe("the selection", () => {
    const noFailures = (extra: Partial<MockScenario> = {}) => {
        const ok = scenario(extra);
        (ok.dbus!.system![SYSTEMD]!["org.freedesktop.systemd1.Manager"]!.methods!.ListUnitsFiltered as JsonObject).reply = [[]];
        return ok;
    };

    it("stays put while rows come and go, and so does what Enter does", async () => {
        const later = () => `USEC=${(Date.now() + 42 * 60_000) * 1000}\nWARN_WALL=1\nMODE=reboot\nUID=0\n`;
        const live = noFailures();
        live.dbus!.system = { ...live.dbus!.system, ...scheduleControl(later) };
        const r = await start(live);
        let frame = await r.waitFor(f => f.includes("No failed services") && f.includes("Server Box (server-box)"));
        expect(selectedRow(frame)).toContain("Host name");
        await trigger("FailBaz");
        frame = await r.waitFor("1 failed unit: baz.service");
        expect(selectedRow(frame)).toContain("Host name");
        expect(hintsLine(frame)).toContain("enter host name");
        await control("Schedule");
        frame = await r.waitFor("Restart scheduled in");
        expect(selectedRow(frame)).toContain("Host name");
        await r.press(keys.enter);
        await r.waitFor("Change host name");
        expect(r.navigations).toEqual([]);
    });

    it("moves to the nearest row when its own goes away, and does not jump back", async () => {
        const r = await start();
        await r.waitFor(f => f.includes("2 failed units") && f.includes("Server Box (server-box)"));
        expect(selectedRow(r.lastFrame())).toContain("2 failed units");
        // All failed units recover: their row goes, the host name's is next.
        await trigger("RecoverFoo");
        await trigger("RemoveBar");
        let frame = await r.waitFor("No failed services");
        expect(selectedRow(frame)).toContain("Host name");
        // A unit failing again does not take the selection back.
        await trigger("FailBaz");
        frame = await r.waitFor("1 failed unit: baz.service");
        expect(selectedRow(frame)).toContain("Host name");
    });

    it("is shown before Enter acts on it, where the page has to scroll", async () => {
        // 50x10: the host name's row is below the fold when the page opens.
        const r = await startBare(noFailures(), { columns: 50, rows: 12 });
        let frame = await r.waitFor(f => f.includes("No failed services") && f.includes("Server Box"));
        expect(selectedRow(frame)).toBeNull();
        expect(hintsLine(frame)).not.toContain("enter");
        await r.press(keys.enter);
        frame = await r.waitFor(f => selectedRow(f)?.includes("Host name") ?? false);
        expect(frame).not.toContain("Change host name");
        expect(hintsLine(frame)).toContain("enter host name");
        await r.press(keys.enter);
        await r.waitFor("Change host name");
    });

    it("stays in view when rows arrive above it", async () => {
        const later = () => `USEC=${(Date.now() + 42 * 60_000) * 1000}\nWARN_WALL=1\nMODE=reboot\nUID=0\nWALL_MESSAGE=soon\n`;
        const live = noFailures();
        live.dbus!.system = { ...live.dbus!.system, ...scheduleControl(later) };
        const r = await startBare(live, { columns: 50, rows: 12 });
        await r.waitFor(f => f.includes("No failed services") && f.includes("Server Box"));
        // The first arrow shows the selection, the next moves it.
        await r.press(keys.down);
        await r.waitFor(f => selectedRow(f)?.includes("Host name") ?? false);
        await r.press(keys.down);
        await r.waitFor(f => selectedRow(f)?.includes("System time") ?? false);
        await trigger("FailBaz");
        await r.waitFor(f => f.includes("1 failed unit") || !f.includes("No failed services"));
        await r.waitFor(f => selectedRow(f)?.includes("System time") ?? false);
        await control("Schedule");
        await mock!.waitForReceived(entry => entry.control?.command === "close" && false, 1).catch(() => undefined);
        const frame = await r.waitFor(f => (selectedRow(f)?.includes("System time") ?? false) &&
                                           f.split("\n").length === 12 && !/No failed services/.test(f));
        expect(selectedRow(frame)).toContain("System time");
    });

    it("keeps where the page was scrolled to across visits", async () => {
        const r = await start({}, { columns: 65, rows: 24 });
        await r.waitFor("25% of 16 CPUs");
        await r.press(keys.end);
        await r.waitFor(/^ {2}NTP/m);
        remount();
        await mock!.waitForReceived(() => mock!.opened("metrics1").length === 2);
        // Everything in again (the page only scrolls once it all is).
        const frame = await r.waitFor(f => /^ {2}NTP/m.test(f) && f.includes("MDT") && f.includes("x86_64") &&
                                           !f.includes(`updating${glyphs.ellipsis}`));
        expect(pageLines(frame)[0]!.trimEnd().endsWith(glyphs.up)).toBe(true);
    });
});

describe("pasted text", () => {
    it("never opens and confirms the power dialog", async () => {
        const r = await start({ superuser: true, spawnPatterns: [{ match: "^shutdown ", stdout: "" }] }, { allowed: true });
        await r.waitFor(f => f.includes("2 failed units") && f.includes("Server Box (server-box)"));
        // One write, as a terminal delivers a paste: S, spaces, and a newline.
        await r.press("Server is down for maintenance now\r");
        await r.waitFor("status: info: Ignored 34 characters typed or pasted at once");
        // The newline is Enter on the selected row (the failed units).
        await r.waitFor(() => r.navigations.length === 1);
        expect(r.navigations).toEqual([["services", { filter: "failed", user: false }]]);
        expect(r.lastFrame()).not.toContain("Shut down server-box");
        expect(spawned().some(open => (open.spawn as string[])[0] === "shutdown")).toBe(false);
        expect(expectedDisconnectReason()).toBeNull();
    });

    it("never renames the host", async () => {
        const r = await start({}, { allowed: true });
        await r.waitFor(f => f.includes("2 failed units") && f.includes("Server Box (server-box)"));
        await r.press("hello world\n");
        await r.waitFor("status: info: Ignored 11 characters typed or pasted at once");
        await r.waitFor(() => r.navigations.length === 1);
        expect(r.lastFrame()).not.toContain("Change host name");
        expect(callsTo("SetStaticHostname")).toHaveLength(0);
        expect(callsTo("SetPrettyHostname")).toHaveLength(0);
    });

    it("still reaches a text field in a dialog", async () => {
        const r = await start({ superuser: true, spawnPatterns: [{ match: "^shutdown ", stdout: "" }] }, { allowed: true });
        await r.waitFor("Server Box (server-box)");
        await r.press("R");
        await r.waitFor("Restart server-box");
        await r.press(keys.down, "Back at 10, sorry");
        await r.waitFor("Back at 10, sorry");
        expect(r.lastFrame()).not.toContain("Ignored");
    });
});

describe("dialogs in a 50x10 area", () => {
    it("draw the power dialog's lines in order, the buttons included", async () => {
        const r = await startBare({ superuser: true }, { columns: 50, rows: 12, allowed: true });
        await r.waitFor("Server Box");
        await r.press("R");
        let frame = await r.waitFor("Restart server-box");
        inOrder(frame, ["Restart server-box", "Restarts in 1 min; can be cancelled here.", "When    < In 1 minute >",
                        "Message optional, for logged-in users", "< Restart >   < Cancel >"]);
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Restart server-box"));
        await r.press("S");
        await r.waitFor("Shut down server-box");
        await r.press(keys.left);
        frame = await r.waitFor("< Now >");
        inOrder(frame, ["Shut down server-box", "Powers off now; this connection closes.", "When    < Now >",
                        "Message optional, for logged-in users", "< Shut down >   < Cancel >"]);
    });

    it("show the power dialog's error without losing the buttons", async () => {
        // The page thinks it may, the bridge refuses "require".
        const r = await startBare({}, { columns: 50, rows: 12, allowed: true });
        await r.waitFor("Server Box");
        await r.press("R");
        await r.waitFor("Restart server-box");
        await r.press(keys.enter);
        const frame = await r.waitFor(f => /not permitted|access-denied/i.test(f));
        inOrder(frame, ["Restart server-box", "Restarts in 1 min", "< In 1 minute >", "Message",
                        "< Restart >   < Cancel >"]);
    });

    it("draw the host name dialog's refusal on a line of its own", async () => {
        const refused = scenario();
        refused.dbus!.system![HOSTNAME1]!["org.freedesktop.hostname1"]!.methods!.SetStaticHostname = {
            in: ["s", "b"],
            error: ["org.freedesktop.DBus.Error.InteractiveAuthorizationRequired", ["Interactive authentication required."]],
        };
        const r = await startBare(refused, { columns: 50, rows: 12 });
        await r.waitFor("Server Box");
        await r.press("h");
        await r.waitFor("Change host name");
        await r.press(keys.down, keys.ctrl("u"), "new-name", keys.enter);
        const frame = await r.waitFor("Interactive authentication required.");
        inOrder(frame, ["Change host name", "Pretty name Server Box", "Host name   new-name",
                        "Interactive authentication required.", "< Change >   < Cancel >"]);
    });

    it("draw the time dialog's refusal on a line of its own", async () => {
        const refused = scenario();
        refused.dbus!.system![TIMEDATE1]!["org.freedesktop.timedate1"]!.methods!.SetNTP = {
            in: ["b", "b"],
            error: ["org.freedesktop.DBus.Error.InteractiveAuthorizationRequired", ["Interactive authentication required."]],
        };
        const r = await startBare(refused, { columns: 50, rows: 12 });
        await r.waitFor("Server Box");
        await r.press("t");
        await r.waitFor("Change system time");
        await r.press(keys.down, " ", keys.enter);
        const frame = await r.waitFor("Could not turn off NTP");
        inOrder(frame, ["Change system time", "Time zone", "NTP", "Time", "Could not turn off NTP",
                        "< Change >   < Cancel >"]);
    });

    it("draw the cancel dialog's error on a line of its own", async () => {
        const later = `USEC=${(Date.now() + 4 * 60_000) * 1000}\nWARN_WALL=1\nMODE=reboot\nUID=0\n`;
        const refused = scenario({ superuser: true, files: { [SCHEDULE]: later } });
        refused.dbus!.system![LOGIN1]![LOGIN1_MANAGER]!.methods!.CancelScheduledShutdown = {
            error: ["org.freedesktop.DBus.Error.AccessDenied", ["Permission denied"]],
        };
        const r = await startBare(refused, { columns: 50, rows: 12, allowed: true });
        await r.waitFor("Server Box");
        await r.press("c");
        await r.waitFor("Cancel the scheduled restart?");
        await r.press(keys.enter);
        const frame = await r.waitFor("Permission denied");
        inOrder(frame, ["Cancel the scheduled restart?", "will not happen", "Permission denied",
                        "[Enter] Cancel the restart   [Esc] Keep it"]);
    });
});
