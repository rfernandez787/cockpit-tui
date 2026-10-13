/*
 * The Logs page against the mock bridge: what it shows, and exactly what it
 * asks journalctl for (argv and spawn options, from the mock's call log).
 */
import { describe, it, expect, afterEach, beforeEach, afterAll } from "vitest";

// Times show in the terminal's zone: pin it, and restore it for other files.
const savedTZ = process.env.TZ;
process.env.TZ = "UTC";
afterAll(() => {
    if (savedTZ === undefined)
        delete process.env.TZ;
    else
        process.env.TZ = savedTZ;
});

import { Box } from "ink";
import cockpit from "../../src/cockpit.js";
import LogsPage from "../../src/pages/logs/index.js";
import { limits } from "../../src/pages/logs/model.js";
import { SCAN_SCRIPT } from "../../src/pages/logs/identifiers.js";
import { glyphs } from "../../src/tui/theme.js";
import { KeyboardProvider } from "../../src/tui/keyboard.js";
import { StatusProvider } from "../../src/tui/status.js";
import { StaticPrivilege } from "../../src/tui/privilege.js";
import { PersistentStateProvider, SessionProvider, usePersistentStore } from "../../src/tui/session-context.js";
import { paramsKey } from "../../src/tui/navigation.js";
import { AreaProvider } from "../../src/tui/components/Dialog.js";
import type { Session } from "../../src/session.js";
import { renderPage, type PageHarnessOptions, type RenderedPage } from "../helpers/page.js";
import { cleanup, keys, renderInk, type Rendered } from "../helpers/ink.js";
import { startMock, type JsonObject, type MockBridge, type MockScenario } from "../mock-bridge/harness.js";

let mock: MockBridge | null = null;

beforeEach(() => {
    // Real pages are 1000 entries; a handful keeps scenarios readable.
    limits.page = 5;
    limits.max = 50;
});

afterEach(() => {
    cleanup();
    mock?.close();
    mock = null;
    limits.page = 1000;
    limits.max = 20000;
});

const VERSION = "systemd 252 (252-67.el9_8.4)\n+PAM +AUDIT +SELINUX +PCRE2 -PWQUALITY default-hierarchy=unified\n";

/** Microseconds since the epoch, as journalctl sends __REALTIME_TIMESTAMP. */
const us = (iso: string) => String(Date.parse(iso) * 1000);

/** One journal entry as a line of journalctl --output=json. */
function entry(cursor: string, iso: string, fields: Record<string, unknown> = {}): string {
    return JSON.stringify({
        __CURSOR: cursor,
        __REALTIME_TIMESTAMP: us(iso),
        __MONOTONIC_TIMESTAMP: "1061192091896",
        _BOOT_ID: "b2",
        PRIORITY: "3",
        SYSLOG_IDENTIFIER: "sshd",
        _PID: "4242",
        MESSAGE: `message ${cursor}`,
        ...fields,
    }) + "\n";
}

const out = (...lines: string[]) => ({ stdout: lines.join("") });

/** The journalctl argv the page runs, with the default filter. */
const page = (lines: number, ...extra: string[]) =>
    ["journalctl", "-q", `--lines=${lines}`, "--output=json", "--since=-24hours", ...extra, "--priority=err", "--reverse", "--"];
const follow = (after?: string) => after
    ? ["journalctl", "-q", "--no-tail", "--output=json", `--after-cursor=${after}`, "--priority=err", "--follow", "--"]
    : ["journalctl", "-q", "--lines=0", "--output=json", "--priority=err", "--follow", "--"];
const key = (argv: string[]) => argv.join(" ");

async function start(scenario: MockScenario, options: PageHarnessOptions = {}): Promise<RenderedPage> {
    mock = await startMock({
        ...scenario,
        spawn: { "journalctl --version": { stdout: VERSION }, ...scenario.spawn },
    });
    await cockpit.init(); // cockpit.info: the user's groups decide the limited-access hint
    return renderPage(LogsPage, { columns: 100, rows: 30, hostname: "testhost", ...options });
}

/**
 * The page with the providers renderPage() gives it, over a persistent store
 * that already holds `seed`: the state an earlier visit left behind, or
 * params from another page.
 */
function renderSeeded(seed: Record<string, unknown>, columns = 100, rows = 30): Rendered {
    function Seed() {
        const store = usePersistentStore();
        // Rendered before the page, so the store is filled when the page first reads it.
        if (store && !store.has("test:seeded")) {
            for (const [name, value] of Object.entries(seed))
                store.set(name, value);
            store.set("test:seeded", true);
        }
        return null;
    }
    return renderInk(
        <SessionProvider value={{ session: null, hostname: "testhost" }}>
            <KeyboardProvider>
                <StatusProvider>
                    <PersistentStateProvider>
                        <Seed />
                        <StaticPrivilege allowed={false}>
                            <AreaProvider area={{ width: columns, height: rows }}>
                                <Box flexDirection="column" width={columns} height={rows}>
                                    <LogsPage width={columns} height={rows} />
                                </Box>
                            </AreaProvider>
                        </StaticPrivilege>
                    </PersistentStateProvider>
                </StatusProvider>
            </KeyboardProvider>
        </SessionProvider>,
        { columns, rows });
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Wait until the page has opened a process with exactly this argv; returns the open message. */
async function opened(argv: string[], nth = 1): Promise<JsonObject> {
    const deadline = Date.now() + 3000;
    for (;;) {
        const hits = mock!.opened("stream").filter(open => same(open.spawn, argv));
        if (hits.length >= nth)
            return hits[nth - 1]!;
        if (Date.now() > deadline) {
            const seen = mock!.opened("stream").map(open => (open.spawn as string[]).join(" ")).join("\n  ");
            throw new Error(`never opened: ${argv.join(" ")}\nopened:\n  ${seen}`);
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

/** Page queries (journalctl ... --reverse) opened so far. */
const pageQueries = () => mock!.opened("stream").filter(open => (open.spawn as string[]).includes("--reverse"));

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const day = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(new Date(iso));

describe("the list", () => {
    it("frames the filter and the entries in panels where there is room, and an entry in one", async () => {
        limits.page = 10;
        const r = await start({
            spawn: {
                [key(page(10))]: out(entry("c1", "2026-10-02T18:13:44Z", { MESSAGE: "kex_exchange_identification" })),
                [key(follow("c1"))]: { keepOpen: true },
            },
        }, { panels: true });
        const frame = await r.waitFor("kex_exchange_identification");
        const lines = frame.split("\n").slice(0, 29);
        expect(lines[0]).toMatch(/^.{2}. Filter .+/);
        expect(lines[2]).toContain("Following");
        // Each panel ends in its bottom border and the row of its shadow.
        expect(lines[3]!.trimEnd()).toMatch(/^[^ ]{99}$/);
        expect(lines[4]!.trim()).toBe("");
        expect(lines[5]).toMatch(/^.{2}. Journal .+/);
        expect(lines[6]).toMatch(/^. +TIME +PRIO .*.$/);
        expect(lines[27]!.trimEnd()).toMatch(/^[^ ]{99}$/);
        expect(lines[28]!.trim()).toBe("");
        // Nothing reaches the last column: it is the shadow's.
        expect(lines.every(line => line.trimEnd().length <= 99)).toBe(true);

        await r.press(keys.enter);
        const detail = await r.waitFor("Fields (");
        expect(detail.split("\n")[0]).toMatch(/^.{2}. Entry .+/);
        expect(detail.split("\n")[27]!.trimEnd()).toMatch(/^[^ ]{99}$/);
    });

    it("shows entries newest first, with day headers, reboots, repeats and safe text", async () => {
        limits.page = 10;
        // A coloured message that would also retitle the terminal, as a byte array.
        const hostile = [...Buffer.from("\x1b[37mDEBU\x1b[0m\x1b]0;pwned\x07 Using /data\x1b[2J\r\n")];
        const r = await start({
            spawn: {
                [key(page(10))]: out(
                    entry("c6", "2026-10-02T18:13:44Z", { MESSAGE: "kex_exchange_identification", _SYSTEMD_UNIT: "sshd.service" }),
                    entry("c5", "2026-10-02T18:13:40Z", { MESSAGE: "kex_exchange_identification", _SYSTEMD_UNIT: "sshd.service" }),
                    entry("c4", "2026-10-02T18:13:30Z", { MESSAGE: "kex_exchange_identification", _SYSTEMD_UNIT: "sshd.service" }),
                    entry("c3", "2026-10-02T18:00:00Z", { MESSAGE: hostile, SYSLOG_IDENTIFIER: undefined, _COMM: "conmon" }),
                    entry("c2", "2026-10-02T01:00:00Z", { MESSAGE: "SELinux is preventing x\nmore\ndetail", PRIORITY: "2", SYSLOG_IDENTIFIER: "setroubleshoot" }),
                    entry("c1", "2026-10-01T23:00:00Z", { MESSAGE: "Linux version 5.14", PRIORITY: undefined, SYSLOG_IDENTIFIER: "kernel", _BOOT_ID: "b1" }),
                ),
                [key(follow("c6"))]: { keepOpen: true },
            },
        });
        const frame = await r.waitFor("Linux version 5.14");
        const lines = frame.split("\n");
        expect(lines[0]).toContain("Error and above · Last 24 hours");
        await r.waitFor(`${glyphs.bullet} Following`);
        expect(r.lastFrame()).toContain("6 entries");

        const body = lines.slice(lines.findIndex(line => line.includes("TIME")) + 1);
        expect(body[0]).toContain(`── ${day("2026-10-02T12:00:00Z")} ──`);
        expect(body[1]).toMatch(new RegExp(`^${glyphs.pointer} 18:13:44 ERR\\s+sshd\\s+kex_exchange_identification\\s+×3\\s*$`));
        expect(body[2]).toMatch(/^ {2}18:00:00 ERR\s+conmon\s+DEBU Using \/data\s*$/);
        expect(body[3]).toMatch(/^ {2}01:00:00 CRIT\s+setroubleshoot\s+SELinux is preventing x\s+\[\+2 lines\]\s*$/);
        expect(body[4]).toContain(`── ${day("2026-10-01T12:00:00Z")} ──`);
        expect(body[5]).toContain("── Reboot ──");
        expect(body[6]).toMatch(/^ {2}23:00:00 -\s+kernel\s+Linux version 5.14/);
        expect(body[7]).toContain("Start of the last 24 hours · L loads earlier entries");
        // The escape sequences never reach the terminal.
        expect(r.lastRawFrame()).not.toContain("pwned");
        expect(r.lastRawFrame()).not.toContain("\x1b]0;");
        expect(r.lastRawFrame()).not.toContain("\x1b[2J");

        // Exactly these processes, each a plain pipe reading at the current privilege.
        const pageOpen = await opened(page(10));
        const followOpen = await opened(follow("c6"));
        for (const open of [pageOpen, followOpen]) {
            expect(open.superuser).toBe("try");
            expect(open.err).toBe("message");
            expect(open.pty).toBeUndefined();
        }
        expect(mock!.opened("stream").map(open => (open.spawn as string[]).join(" "))).toEqual([
            "journalctl --version", key(page(10)), key(follow("c6")),
        ]);
    });

    it("follows new entries at the top, keeps the newest selected, and pauses and resumes", async () => {
        const r = await start({
            spawn: {
                [key(page(5))]: out(entry("a2", "2026-10-02T10:00:02Z"), entry("a1", "2026-10-02T10:00:01Z")),
                [key(follow("a2"))]: { chunks: [{ data: entry("a3", "2026-10-02T10:00:03Z", { MESSAGE: "fresh from follow" }), delayMs: 200 }], keepOpen: true },
                [key(follow("a3"))]: { keepOpen: true },
            },
        });
        await r.waitFor("message a1");
        const frame = await r.waitFor("fresh from follow");
        expect(frame).toMatch(new RegExp(`${glyphs.pointer} 10:00:03 ERR\\s+sshd\\s+fresh from follow`));
        expect(frame).toContain("3 entries");

        const first = await opened(follow("a2"));
        await r.press("f");
        await r.waitFor(`${glyphs.hollow} Paused`);
        // Pausing closes the follow channel...
        await mock!.waitForReceived(e => e.control?.command === "close" && e.control.channel === first.channel);
        // ...and resuming starts again after the newest entry shown, so nothing is lost or repeated.
        await r.press(" ");
        await opened(follow("a3"));
        await r.waitFor(`${glyphs.bullet} Following`);
    });

    it("keeps the columns where they are when a followed entry has a longer identifier", async () => {
        const r = await start({
            spawn: {
                [key(page(5))]: out(
                    entry("a3", "2026-10-02T10:00:03Z", { MESSAGE: "page entry 3" }),
                    entry("a2", "2026-10-02T10:00:02Z", { MESSAGE: "page entry 2" }),
                    entry("a1", "2026-10-02T10:00:01Z", { MESSAGE: "page entry 1" }),
                ),
                [key(follow("a3"))]: {
                    chunks: [{ data: entry("a4", "2026-10-02T10:00:04Z", { SYSLOG_IDENTIFIER: "NetworkManager-dispatcher", MESSAGE: "dispatcher" }), delayMs: 300 }],
                    keepOpen: true,
                },
            },
        });
        const column = (frame: string, text: string) => frame.split("\n").find(line => line.includes(text))!.indexOf(text);
        let frame = await r.waitFor("page entry 1");
        await r.press(keys.down);
        frame = await r.waitFor(new RegExp(`${glyphs.pointer} 10:00:02`));
        const before = [column(frame, "page entry 2"), column(frame, "MESSAGE")];
        frame = await r.waitFor("dispatcher");
        expect([column(frame, "page entry 2"), column(frame, "MESSAGE")]).toEqual(before);
        // The newcomer is cut to the column instead.
        expect(frame).toMatch(new RegExp(`10:00:04 ERR\\s+Netwo${glyphs.ellipsis}\\s+dispatcher`));
    });

    it("sizes the identifier column for a new filter's entries, not the previous filter's", async () => {
        const debugPage = ["journalctl", "-q", "--lines=5", "--output=json", "--since=-24hours", "--priority=debug", "--reverse", "--"];
        const r = await start({
            spawn: {
                [key(page(5))]: out(entry("n1", "2026-10-02T10:00:00Z", { SYSLOG_IDENTIFIER: "a", MESSAGE: "narrow one" })),
                [key(follow("n1"))]: { keepOpen: true },
                [key(debugPage)]: out(entry("w1", "2026-10-02T11:00:00Z", { SYSLOG_IDENTIFIER: "/usr/bin/cockpit-bridge", MESSAGE: "wide one" })),
            },
            spawnPatterns: [{ match: "--follow", keepOpen: true }],
        }, { columns: 120 });
        await r.waitFor("narrow one");
        await r.press("p");
        await r.waitFor("Debug and above");
        await r.press(keys.end, keys.enter);
        // Measured from the debug entries once they are in: the whole name fits under the cap.
        const frame = await r.waitFor(f => f.includes("wide one") && f.includes(`${glyphs.bullet} Following`));
        expect(frame).toMatch(/11:00:00 ERR\s+\/usr\/bin\/cockpit-bridge\s+wide one/);
    });

    it("keeps a selection below the top on its entry while new ones arrive", async () => {
        const r = await start({
            spawn: {
                [key(page(5))]: out(entry("a2", "2026-10-02T10:00:02Z"), entry("a1", "2026-10-02T10:00:01Z")),
                [key(follow("a2"))]: { chunks: [{ data: entry("a3", "2026-10-02T10:00:03Z", { MESSAGE: "late" }), delayMs: 300 }], keepOpen: true },
            },
        });
        await r.waitFor("message a1");
        await r.press(keys.down);
        await r.waitFor(new RegExp(`${glyphs.pointer} 10:00:01`));
        const frame = await r.waitFor("late");
        expect(frame).toMatch(new RegExp(`${glyphs.pointer} 10:00:01 ERR\\s+sshd\\s+message a1`));
    });

    it("loads earlier entries: the rest of the time range, then past it", async () => {
        const five = ["p5", "p4", "p3", "p2", "p1"].map((c, i) => entry(c, `2026-10-02T10:00:0${5 - i}Z`));
        // journalctl refuses --since with a cursor: the range continues up to
        // the oldest entry's exact time, which is inclusive, so p1 comes back.
        const p1 = us("2026-10-02T10:00:01Z");
        const within = ["journalctl", "-q", "--lines=5", "--output=json", "--since=-24hours",
                        `--until=@${p1.slice(0, -6)}.${p1.slice(-6)}`, "--priority=err", "--reverse", "--"];
        const beyond = ["journalctl", "-q", "--lines=5", "--output=json", "--after-cursor=q1", "--priority=err", "--reverse", "--"];
        const r = await start({
            spawn: {
                [key(page(5))]: out(...five),
                [key(follow("p5"))]: { keepOpen: true },
                [key(within)]: out(five[4]!, entry("q2", "2026-10-02T09:00:02Z"), entry("q1", "2026-10-02T09:00:01Z")),
                [key(beyond)]: out(entry("r1", "2026-09-30T08:00:00Z", { MESSAGE: "from days ago" })),
            },
        });
        await r.waitFor("L loads more");
        await r.press("L");
        await opened(within);
        await r.waitFor("Start of the last 24 hours · L loads earlier entries");
        expect(r.lastFrame()).toContain("7 entries");
        await r.press("L");
        await opened(beyond);
        await r.press("G");
        const frame = await r.waitFor("No earlier entries");
        expect(frame).toContain("from days ago");
        expect(frame).toContain("8 entries  ·  includes entries before the last 24 hours");
        // In the list, a separator shows where the time range ends, with the older entries' day under it.
        const lines = frame.split("\n");
        const separator = lines.findIndex(line => line.includes("── Before the last 24 hours ──"));
        expect(separator).toBeGreaterThan(lines.findIndex(line => line.includes("message q1")));
        expect(lines[separator + 1]).toContain(`── ${day("2026-09-30T08:00:00Z")} ──`);
        expect(lines[separator + 2]).toContain("from days ago");
        await r.press("L");
        await r.waitFor("status: info: No earlier entries match the filters.");
    });

    it("writes the position like the total, with thousands separators", async () => {
        limits.page = 1001;
        const many = Array.from({ length: 1001 }, (_, i) => entry(`m${1001 - i}`, new Date(Date.parse("2026-10-02T10:00:00Z") - i * 1000).toISOString()));
        const r = await start({
            spawn: { [key(page(1001))]: out(...many), [key(follow("m1001"))]: { keepOpen: true } },
        });
        await r.waitFor(`${(1001).toLocaleString()} entries`);
        await r.press("G");
        await r.waitFor(`${(1001).toLocaleString()}/${(1001).toLocaleString()}`);
    });

    it("takes a start that has moved past the oldest entry as the end of the range, not an error", async () => {
        // "-24hours" is read again by every query: a page loaded long ago can
        // hold an oldest entry from before the range's start as it is now.
        const five = ["p5", "p4", "p3", "p2", "p1"].map((c, i) => entry(c, `2026-10-02T10:00:0${5 - i}Z`));
        const p1 = us("2026-10-02T10:00:01Z");
        const within = ["journalctl", "-q", "--lines=5", "--output=json", "--since=-24hours",
                        `--until=@${p1.slice(0, -6)}.${p1.slice(-6)}`, "--priority=err", "--reverse", "--"];
        const beyond = ["journalctl", "-q", "--lines=5", "--output=json", "--after-cursor=p1", "--priority=err", "--reverse", "--"];
        const r = await start({
            spawn: {
                [key(page(5))]: out(...five),
                [key(follow("p5"))]: { keepOpen: true },
                [key(within)]: { "exit-status": 1, stderr: "--since= must be before --until=.\n" },
                [key(beyond)]: out(entry("o1", "2026-09-30T08:00:00Z", { MESSAGE: "from before the range" })),
            },
        });
        await r.waitFor("L loads more");
        await r.press("L");
        await opened(within);
        let frame = await r.waitFor("Start of the last 24 hours · L loads earlier entries");
        expect(frame).not.toContain("Could not load earlier entries");
        await r.press("L");
        await opened(beyond);
        frame = await r.waitFor("from before the range");
        expect(frame).not.toContain("Could not load earlier entries");
        expect(mock!.opened("stream").filter(open => same(open.spawn, within))).toHaveLength(1);
    });

    it("drops the oldest past the most it holds, and still says when some predate the range", async () => {
        limits.page = 2;
        limits.max = 4;
        const p1 = us("2026-10-02T10:00:01Z");
        const within = ["journalctl", "-q", "--lines=2", "--output=json", "--since=-24hours",
                        `--until=@${p1.slice(0, -6)}.${p1.slice(-6)}`, "--priority=err", "--reverse", "--"];
        const beyond = ["journalctl", "-q", "--lines=2", "--output=json", "--after-cursor=p1", "--priority=err", "--reverse", "--"];
        const r = await start({
            spawn: {
                [key(page(2))]: out(entry("p2", "2026-10-02T10:00:02Z"), entry("p1", "2026-10-02T10:00:01Z")),
                // The range holds nothing older; then two entries from days before it.
                [key(within)]: out(entry("p1", "2026-10-02T10:00:01Z")),
                [key(beyond)]: out(entry("b2", "2026-09-28T08:00:02Z"), entry("b1", "2026-09-28T08:00:01Z")),
                // Following brings one entry, then another, after the loading is done.
                [key(follow("p2"))]: {
                    chunks: [
                        { data: entry("f1", "2026-10-02T10:00:03Z"), delayMs: 1500 },
                        { data: entry("f2", "2026-10-02T10:00:04Z"), delayMs: 1200 },
                    ],
                    keepOpen: true,
                },
            },
        });
        await r.waitFor("L loads more");
        await r.press("L");
        await r.waitFor("Start of the last 24 hours");
        await r.press("L");
        await r.waitFor("4 entries  ·  includes entries before the last 24 hours");
        // f1 makes five: the oldest (b1) goes, but b2, from before the range, is still shown.
        let frame = await r.waitFor("message f1", 4000);
        expect(frame).toContain("4 entries  ·  includes entries before the last 24 hours");
        expect(frame).not.toContain("message b1");
        expect(frame).toContain("4 entries is the most the list holds");
        // f2 pushes out b2 too: everything shown is within the range again.
        frame = await r.waitFor("message f2", 4000);
        expect(frame).not.toContain("includes entries before");
        expect(frame).not.toContain("message b2");
        await r.press("L");
        await r.waitFor("status: warning: The list holds at most 4 entries; narrow the filters to see older ones.");
    });

    it("says when nothing matches, follows from now on, and can look before the range", async () => {
        const before = ["journalctl", "-q", "--lines=5", "--output=json", "--until=-24hours", "--priority=err", "--reverse", "--"];
        const r = await start({
            spawn: {
                // Exit 1 with nothing on stderr is "no entries", not an error.
                [key(page(5))]: { "exit-status": 1 },
                [key(follow())]: { keepOpen: true },
                [key(before)]: out(entry("o1", "2026-09-29T08:00:00Z", { MESSAGE: "old news" })),
            },
        });
        const frame = await r.waitFor("No entries match the filters in the last 24 hours.");
        expect(frame).toContain("L loads earlier entries");
        expect(frame).not.toContain(glyphs.cross);
        // --lines=0: following an empty result must not replay history (spec G11).
        await opened(follow());
        await r.waitFor("New entries appear here as they are logged.");
        await r.press("L");
        await opened(before);
        await r.waitFor("old news");
        await r.waitFor("includes entries before the last 24 hours");
    });
});

describe("errors and notices", () => {
    it("shows journalctl's complaint, with what to do, and does not follow", async () => {
        const r = await start({
            spawn: { [key(page(5))]: { "exit-status": 1, stderr: "Failed to parse timestamp: garbage\n" } },
        });
        const frame = await r.waitFor("Failed to parse timestamp: garbage");
        expect(frame).toContain(`${glyphs.cross} Failed to parse timestamp: garbage`);
        expect(frame).toContain("Press t to choose another time range.");
        expect(frame).toContain(`${glyphs.cross} Failed`);
        await sleep(300);
        expect(mock!.opened("stream").some(open => (open.spawn as string[]).includes("--follow"))).toBe(false);
    });

    it("keeps what was read when journalctl fails part way, with the error above it", async () => {
        const r = await start({
            spawn: {
                [key(page(5))]: {
                    ...out(entry("k2", "2026-10-02T10:00:02Z"), entry("k1", "2026-10-02T10:00:01Z")),
                    "exit-status": 1, stderr: "Failed to iterate through journal: Bad message\n",
                },
            },
        });
        const frame = await r.waitFor("Bad message");
        expect(frame).toContain(`${glyphs.cross} Failed to iterate through journal: Bad message. Press r to try again.`);
        expect(frame).toContain(`${glyphs.cross} Failed  ·  2 entries`);
        expect(frame).toContain("message k1");
        // A failed read is not a complete one: no trailer claiming the start of the range.
        expect(frame).not.toContain("Start of the last 24 hours");
        await sleep(200);
        expect(mock!.opened("stream").some(open => (open.spawn as string[]).includes("--follow"))).toBe(false);
        // Esc puts the banner away.
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Bad message"));
    });

    it("says journalctl is missing rather than 'not-found', and that L cannot help", async () => {
        const r = await start({ spawn: { [key(page(5))]: { problem: "not-found" } } });
        await r.waitFor("journalctl is not installed on testhost");
        await r.press("L");
        await r.waitFor("status: warning: The journal could not be read: r tries again.");
    });

    it("offers only keys that help after a failed read: r, not f or L", async () => {
        const r = await start({
            spawn: { [key(page(5))]: { ...out(entry("k1", "2026-10-02T10:00:00Z")), "exit-status": 1, stderr: "Failed to iterate through journal: Bad message\n" } },
        }, { showHints: true });
        const frame = await r.waitFor("Bad message");
        const hints = frame.split("\n").find(line => line.startsWith("hints: "))!;
        expect(hints).toContain("r reload");
        expect(hints).not.toMatch(/\bf (pause|follow)\b/);
        expect(hints).not.toMatch(/\bL (more|earlier)\b/);
        // f says why it does nothing, rather than quietly flipping to "paused".
        await r.press("f");
        await r.waitFor("status: warning: The journal could not be read: r tries again.");
        expect(r.lastFrame()).not.toContain("Paused");
    });

    it("reports a signal death by its exit code", async () => {
        const r = await start({ spawn: { [key(page(5))]: { "exit-signal": "TERM" } } });
        await r.waitFor("journalctl exited with code -15");
    });

    it("suggests administrative access when the journal is unreadable", async () => {
        const r = await start({
            spawn: { [key(page(5))]: { "exit-status": 1, stderr: "No journal files were opened due to insufficient permissions.\n" } },
        }, { allowed: false });
        const frame = await r.waitFor("insufficient permissions");
        expect(frame).toContain("Press A to turn on administrative access.");
    });

    it("shows a notice from a successful run over the entries, until dismissed", async () => {
        const notice = "Specifying boot ID or boot offset has no effect, no persistent journal was found.";
        const r = await start({
            spawn: {
                [key(page(5))]: { ...out(entry("n1", "2026-10-02T10:00:00Z")), stderr: `${notice}\n` },
                [key(follow("n1"))]: { keepOpen: true },
            },
        });
        const frame = await r.waitFor(notice);
        expect(frame).toContain(`${glyphs.warning} ${notice}`);
        expect(frame).toContain("message n1");
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes(notice));
    });

    it("puts several banners away one by one with Esc, and shows one again when a retry fails again", async () => {
        const notice = "Journal file /var/log/journal/x/system@0005.journal~ is truncated, ignoring file.";
        const r = await start({
            spawn: {
                [key(page(5))]: { ...out(entry("y1", "2026-10-02T10:00:00Z")), stderr: `${notice}\n` },
                [key(follow("y1"))]: { "exit-status": 1, stderr: "Failed to get journal fd: Too many open files\n" },
            },
        });
        await r.waitFor("Following stopped: Failed to get journal fd");
        await r.press(keys.escape);
        let frame = await r.waitFor(notice);
        expect(frame).not.toContain("Following stopped: Failed");
        await r.press(keys.escape);
        frame = await r.waitFor(f => !f.includes(notice));
        expect(frame).not.toContain("Following stopped: Failed");
        // f tries again; failing the same way again is news.
        await r.press("f");
        await opened(follow("y1"), 2);
        await r.waitFor("Following stopped: Failed to get journal fd");
    });

    it("keeps a banner's way out in view when its text is cut short", async () => {
        const long = "Failed to get journal fd: Too many open files, and this message is long enough to wrap at sixty columns twice";
        const r = await start({
            spawn: {
                [key(page(5))]: out(entry("x1", "2026-10-02T10:00:00Z")),
                [key(follow("x1"))]: { "exit-status": 1, stderr: `${long}\n` },
            },
        }, { columns: 60 });
        const frame = await r.waitFor("Following stopped");
        const lines = frame.split("\n");
        const at = lines.findIndex(line => line.startsWith(`${glyphs.cross} Following stopped: Failed to get journal fd`));
        expect(at).toBeGreaterThan(-1);
        expect(lines[at + 1]).toMatch(new RegExp(`${glyphs.ellipsis} \\(f tries again\\)\\s*$`));
    });

    it("stops following on a follow error, and f tries again", async () => {
        const r = await start({
            spawn: {
                [key(page(5))]: out(entry("x1", "2026-10-02T10:00:00Z")),
                [key(follow("x1"))]: { "exit-status": 1, stderr: "Failed to iterate through journal: Bad message\n" },
            },
        });
        const frame = await r.waitFor("Following stopped: Failed to iterate through journal: Bad message");
        expect(frame).toContain(`${glyphs.cross} Following stopped`);
        await r.press("f");
        await opened(follow("x1"), 2);
    });

    it("tells readers outside the journal groups that they see only part of it", async () => {
        const info = {
            channels: { stream: [], info: [] },
            os_release: { ID: "mock" },
            user: { name: "eve", uid: 1001, gid: 1001, group: "eve", fullname: "", groups: ["eve"], home: "/home/eve", shell: "/bin/sh" },
            ws: { version: "356" },
        };
        const r = await start({
            info,
            spawn: { [key(page(5))]: out(entry("h1", "2026-10-02T10:00:00Z")), [key(follow("h1"))]: { keepOpen: true } },
        }, { allowed: false });
        await r.waitFor("Only entries you may read are shown. Press A for administrative access to see all.");
    });
});

describe("host text", () => {
    /*
     * Control bytes and sequences that Ink 7 writes through unchanged (it drops
     * other CSI and OSC sequences itself), so only the page's own cleaning
     * keeps them off the terminal: CR and BS overwrite the line, BEL rings, SO
     * switches a VT to its graphics set, SGR 8 hides text, OSC 8 makes a link,
     * and RLO and ALM reorder text. Each payload has visible text after it:
     * Ink clips a line to its visible width, which drops trailing zero-width
     * controls, so a payload at the end of a line would prove nothing.
     */
    const SURVIVORS = ["\r", "\b", "\x07", "\x0e", "\x1b[8m", "\x1b]8;;", "\u202e", "\u061c"];
    const HOSTILE = "\r\b\x07\x0e\x1b[8m\x1b]8;;https://evil.example/\x07\u202e\u061c";
    /** A value journalctl sends as a byte array, as it does for anything with controls in it. */
    const bytes = (text: string) => [...Buffer.from(text)];

    function expectClean(frame: string) {
        expect(SURVIVORS.filter(bad => frame.includes(bad)).map(bad => JSON.stringify(bad))).toEqual([]);
    }

    it("never reaches the terminal raw: list, notice, entry detail, unit, fields and command", async () => {
        const r = await start({
            spawn: {
                [key(page(5))]: {
                    ...out(
                        entry("h2", "2026-10-02T10:00:02Z", {
                            MESSAGE: bytes(`msg ${HOSTILE} end\nline2 ${HOSTILE} end`),
                            SYSLOG_IDENTIFIER: bytes(`id${HOSTILE}x`),
                            UNIT: bytes(`u${HOSTILE}.service`),
                            OTHER: bytes(`v ${HOSTILE}\tz`),
                            MULTI: [bytes(`a${HOSTILE}a`), `b${HOSTILE}b`],
                            [`K${HOSTILE}`]: "a field name",
                        }),
                        // The cursor reaches the "!" command.
                        entry(`c${HOSTILE}`, "2026-10-02T10:00:01Z", { MESSAGE: "the older one" }),
                    ),
                    stderr: `notice ${HOSTILE} end\n`,
                },
                [key(follow("h2"))]: { keepOpen: true },
            },
        });
        await r.waitFor("the older one");
        await r.waitFor("notice");
        expectClean(r.lastRawFrame());

        await r.press(keys.enter);
        let frame = await r.waitFor("MULTI");
        expect(frame).toContain("Unit       u^H^G^N.service  (o opens it in Services)");
        expectClean(r.lastRawFrame());

        await r.press(keys.escape, keys.down, keys.enter);
        await r.waitFor("Entry at 2026-10-02 10:00:01");
        await r.press("!");
        frame = await r.waitFor("Equivalent command");
        expect(frame).toContain("--cursor=c^H^G^N");
        expectClean(r.lastRawFrame());
    });

    it("never reaches the terminal raw in errors: the page query, over entries and without", async () => {
        let r = await start({
            spawn: { [key(page(5))]: { ...out(entry("e1", "2026-10-02T10:00:00Z")), "exit-status": 1, stderr: `boom ${HOSTILE} end\n` } },
        });
        await r.waitFor("Press r to try again.");
        expectClean(r.lastRawFrame());
        cleanup();
        mock?.close();

        r = await start({ spawn: { [key(page(5))]: { "exit-status": 1, stderr: `empty boom ${HOSTILE} end\n` } } });
        await r.waitFor("empty boom");
        expectClean(r.lastRawFrame());
    });

    it("never reaches the terminal raw in errors: following, loading earlier and fetching full values", async () => {
        const five = ["p5", "p4", "p3", "p2", "p1"].map((c, i) => entry(c, `2026-10-02T10:00:0${5 - i}Z`, i === 0 ? { BIG: null } : {}));
        const r = await start({
            spawn: {
                [key(page(5))]: out(...five),
                [key(follow("p5"))]: { "exit-status": 1, stderr: `follow boom ${HOSTILE} end\n` },
                [key(["journalctl", "-q", "--lines=1", "--output=json", "--all", "--cursor=p5", "--"])]:
                    { "exit-status": 1, stderr: `fetch boom ${HOSTILE} end\n` },
            },
            spawnPatterns: [{ match: "--until=@", "exit-status": 1, stderr: `earlier boom ${HOSTILE} end\n` }],
        });
        await r.waitFor("follow boom");
        expectClean(r.lastRawFrame());
        await r.press(keys.escape, "L");
        await r.waitFor("earlier boom");
        expectClean(r.lastRawFrame());
        await r.press(keys.enter);
        await r.waitFor("Entry at");
        await r.press("a");
        await r.waitFor("fetch boom");
        expectClean(r.lastRawFrame());
    });

    it("never reaches the terminal raw in the identifier picker", async () => {
        const r = await start({
            spawn: { [key(page(5))]: out(entry("i1", "2026-10-02T10:00:00Z")), [key(follow("i1"))]: { keepOpen: true } },
            spawnPatterns: [
                { match: "^/bin/sh -c ", stdout: `cron\nid${HOSTILE}x\nsshd\n`, stderr: `scan ${HOSTILE} end\n` },
                { match: "--reverse", stdout: entry("i2", "2026-10-02T10:00:01Z") },
                { match: "--follow", keepOpen: true },
            ],
        });
        await r.waitFor("message i1");
        await r.press("i");
        await r.waitFor("Could not list");
        await r.waitFor("cron");
        expectClean(r.lastRawFrame());
        // Picked, the name heads the page, in the filter summary.
        await r.press("id");
        await r.waitFor('Use "id"');
        await r.press(keys.enter);
        await r.waitFor(f => f.split("\n")[0]!.includes("identifier id") && f.includes("message i2"));
        expectClean(r.lastRawFrame());
        expect(mock!.opened("stream").some(open => (open.spawn as string[]).includes(`--identifier=id${HOSTILE}x`))).toBe(true);
    });

    it("never reaches the terminal raw in a notice over an empty list", async () => {
        const r = await start({
            spawn: {
                [key(page(5))]: { "exit-status": 0, stderr: `notice ${HOSTILE} end\n` },
                [key(follow())]: { keepOpen: true },
            },
        });
        await r.waitFor("No entries match");
        await r.waitFor("notice");
        expectClean(r.lastRawFrame());
    });

    it("never reaches the terminal raw in a form's complaint from journalctl", async () => {
        const r = await start({
            spawn: { [key(page(5))]: out(entry("t1", "2026-10-02T10:00:00Z")), [key(follow("t1"))]: { keepOpen: true } },
            spawnPatterns: [{ match: "^journalctl -q --lines=0 ", "exit-status": 1, stderr: `Failed to parse timestamp: ${HOSTILE} end\n` }],
        });
        await r.waitFor("message t1");
        await r.press("t");
        await r.waitFor("Custom range");
        await r.press(keys.down, keys.down, keys.down, keys.enter);
        await r.waitFor("Custom time range");
        await r.press(keys.ctrl("u"), "x", keys.enter);
        await r.waitFor("Failed to parse timestamp");
        expectClean(r.lastRawFrame());
    });
});

describe("the entry detail", () => {
    it("shows every field, fetches left-out values, steps between entries and opens the unit", async () => {
        const full = ["journalctl", "-q", "--lines=1", "--output=json", "--all", "--cursor=s=1;i=6", "--"];
        const newest = { MESSAGE: "Accepted publickey for ric", _SYSTEMD_UNIT: "sshd.service", BIG: null, _UDEV_DEVLINK: ["/dev/a", "/dev/b"] };
        const r = await start({
            spawn: {
                [key(page(5))]: out(
                    entry("s=1;i=6", "2026-10-02T18:13:44Z", newest),
                    entry("s=1;i=5", "2026-10-02T18:13:40Z", { MESSAGE: "an older one" }),
                ),
                [key(follow("s=1;i=6"))]: { keepOpen: true },
                [key(full)]: out(entry("s=1;i=6", "2026-10-02T18:13:44Z", { ...newest, BIG: "the whole long value" })),
            },
        });
        await r.waitFor("an older one");
        await r.press(keys.enter);
        let frame = await r.waitFor("Entry at 2026-10-02 18:13:44");
        expect(frame).toContain("sshd  ·  priority err (3)");
        expect(frame).toContain("Accepted publickey for ric");
        expect(frame).toContain("Unit       sshd.service  (o opens it in Services)");
        expect(frame).toMatch(/BIG\s+\[no data\]/);
        expect(frame).toMatch(/_UDEV_DEVLINK\s+\/dev\/a\n\s+\/dev\/b\n\s+\(2 values\)/);
        expect(frame).toMatch(/__REALTIME_TIMESTAMP\s+1790964824000000\n\s+\(2026-10-02 18:13:44\.000000\)/);

        await r.press("a");
        const fetch = await opened(full);
        expect(fetch.superuser).toBe("try");
        expect(fetch.err).toBe("message");
        frame = await r.waitFor("the whole long value");
        expect(frame).not.toContain("[no data]");
        await r.waitFor("status: success: Fetched the values journalctl left out.");

        await r.press(keys.right);
        await r.waitFor("Entry at 2026-10-02 18:13:40");
        await r.press(keys.left);
        await r.waitFor("Entry at 2026-10-02 18:13:44");

        await r.press("!");
        await r.waitFor("journalctl --all --output=verbose --lines=1 '--cursor=s=1;i=6'");
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Equivalent command"));

        await r.press("o");
        expect(r.navigations).toEqual([["services", { unit: "sshd.service", user: false }]]);

        await r.press(keys.escape);
        await r.waitFor("TIME");
        expect(r.lastFrame()).toMatch(new RegExp(`${glyphs.pointer} 18:13:44`));
    });

    it("keeps the entry it opened while following folds a repeat into its row", async () => {
        const r = await start({
            spawn: {
                [key(page(5))]: out(
                    entry("d2", "2026-10-02T10:00:02Z", { MESSAGE: "disk full", _PID: "100" }),
                    entry("d1", "2026-10-02T10:00:01Z", { MESSAGE: "an older one" }),
                ),
                [key(follow("d2"))]: {
                    chunks: [{ data: entry("d3", "2026-10-02T10:00:03Z", { MESSAGE: "disk full", _PID: "200" }), delayMs: 400 }],
                    keepOpen: true,
                },
            },
        });
        await r.waitFor("an older one");
        await r.press(keys.enter);
        await r.waitFor("Entry at 2026-10-02 10:00:02");
        // The repeat arrives (and joins this entry's row in the list) while it is open.
        await mock!.waitForReceived(e => e.control?.command === "open" && Array.isArray(e.control.spawn) &&
                                    (e.control.spawn as string[]).includes("--follow"));
        await sleep(900);
        let frame = r.lastFrame();
        expect(frame).toContain("Entry at 2026-10-02 10:00:02");
        expect(frame).toMatch(/_PID\s+100/);
        // Back in the list, the run is selected, newest first.
        await r.press(keys.escape);
        frame = await r.waitFor("×2");
        expect(frame).toMatch(new RegExp(`${glyphs.pointer} 10:00:03 ERR\\s+sshd\\s+disk full\\s+×2`));
        // Stepping from the run reaches the next older row.
        await r.press(keys.enter);
        await r.waitFor("Entry at 2026-10-02 10:00:03");
        await r.press(keys.right);
        await r.waitFor("Entry at 2026-10-02 10:00:01");
        await r.press(keys.right);
        await r.waitFor("status: info: This is the oldest entry loaded.");
    });

    it("refuses a different entry in place of the one asked for", async () => {
        // --cursor seeks to the nearest entry when the exact one is gone.
        const full = ["journalctl", "-q", "--lines=1", "--output=json", "--all", "--cursor=gone", "--"];
        const r = await start({
            spawn: {
                [key(page(5))]: out(entry("gone", "2026-10-02T10:00:00Z", { BIG: null })),
                [key(follow("gone"))]: { keepOpen: true },
                [key(full)]: out(entry("next", "2026-10-02T10:00:01Z", { BIG: "not this one" })),
            },
        });
        await r.waitFor("message gone");
        await r.press(keys.enter);
        await r.waitFor("Entry at");
        await r.press("a");
        const frame = await r.waitFor("Journal entry not found");
        expect(frame).toContain(`${glyphs.cross} Journal entry not found: it may have been rotated out of the journal.`);
        expect(frame).not.toContain("not this one");
        expect(frame).toMatch(/BIG\s+\[no data\]/);
    });

    it("says why o and a do nothing for an entry without a unit or missing values", async () => {
        const r = await start({
            spawn: { [key(page(5))]: out(entry("z1", "2026-10-02T10:00:00Z")), [key(follow("z1"))]: { keepOpen: true } },
        });
        await r.waitFor("message z1");
        await r.press(keys.enter);
        await r.waitFor("Entry at");
        await r.press("o");
        await r.waitFor("status: info: This entry belongs to no service, socket, timer, path or target unit.");
        await r.press("a");
        await r.waitFor("status: info: Every value of this entry is already shown in full.");
        expect(r.navigations).toEqual([]);
    });

    it("opens user units as user units", async () => {
        const r = await start({
            spawn: {
                [key(page(5))]: out(entry("u1", "2026-10-02T10:00:00Z", { _SYSTEMD_UNIT: "user@1000.service", _SYSTEMD_USER_UNIT: "podman.service" })),
                [key(follow("u1"))]: { keepOpen: true },
            },
        });
        await r.waitFor("message u1");
        await r.press(keys.enter);
        await r.waitFor("User unit  podman.service");
        await r.press("o");
        expect(r.navigations).toEqual([["services", { unit: "podman.service", user: true }]]);
    });
});

describe("filters", () => {
    // Any page query: two entries; any follow: held open.
    const generic: MockScenario["spawnPatterns"] = [
        { match: "^journalctl -q --lines=\\d+ .*--reverse", stdout: entry("g2", "2026-10-02T10:00:02Z") + entry("g1", "2026-10-02T10:00:01Z") },
        { match: "--follow", keepOpen: true },
    ];
    /**
     * Wait until the newest page query (journalctl ... --reverse) passes `check`.
     * The mock logs what it receives from its own process, so the log can lag
     * the screen by a moment: poll rather than read it once.
     */
    async function lastPage(check: string[] | ((argv: string[]) => boolean)): Promise<void> {
        const test = typeof check === "function" ? check : (argv: string[]) => same(argv, check);
        const deadline = Date.now() + 3000;
        for (;;) {
            const argv = pageQueries().at(-1)?.spawn as string[] | undefined;
            if (argv && test(argv))
                return;
            if (Date.now() > deadline)
                throw new Error(`last page query never matched; it was: ${argv?.join(" ")}`);
            await sleep(10);
        }
    }

    it("change the priority", async () => {
        const r = await start({ spawnPatterns: generic });
        await r.waitFor("message g1");
        await r.press("p");
        await r.waitFor("Debug and above");
        await r.press(keys.down, keys.enter);
        await r.waitFor("Warning and above · Last 24 hours");
        await lastPage(["journalctl", "-q", "--lines=5", "--output=json", "--since=-24hours", "--priority=warning", "--reverse", "--"]);
    });

    it("change the time range, including earlier boots, which cannot be followed", async () => {
        const boots = JSON.stringify([
            { index: -1, boot_id: "0ld", first_entry: Date.parse("2026-09-01T00:00:00Z") * 1000, last_entry: Date.parse("2026-09-20T10:00:00Z") * 1000 },
            { index: 0, boot_id: "n0w", first_entry: Date.parse("2026-09-20T10:43:24Z") * 1000, last_entry: Date.parse("2026-10-02T17:30:26Z") * 1000 },
        ]);
        const r = await start({
            spawn: { "journalctl -q --list-boots --output=json": { stdout: boots } },
            spawnPatterns: generic,
        });
        await r.waitFor("message g1");
        await r.press("t");
        let frame = await r.waitFor("Boot -1");
        expect(frame).toContain("since 2026-09-20 10:43");
        expect(frame).toContain("2026-09-01 00:00 – 2026-09-20 10:00");
        await r.press(keys.down, keys.enter);
        await r.waitFor("Error and above · Last 7 days");
        await lastPage(["journalctl", "-q", "--lines=5", "--output=json", "--since=-7days", "--priority=err", "--reverse", "--"]);

        await r.press("t");
        await r.waitFor("Boot -1");
        await r.press(keys.home, keys.enter);
        await r.waitFor("Error and above · Current boot");
        await lastPage(["journalctl", "-q", "--lines=5", "--output=json", "--boot=0", "--priority=err", "--reverse", "--"]);
        await r.waitFor(`${glyphs.bullet} Following`);

        await r.press("t");
        await r.waitFor("Boot -1");
        await r.press(keys.end, keys.enter);
        frame = await r.waitFor("Not following: a past boot is shown");
        expect(frame).toContain("Boot -1 (2026-09-01 00:00)");
        await lastPage(["journalctl", "-q", "--lines=5", "--output=json", "--boot=0ld", "--priority=err", "--reverse", "--"]);
        const follows = mock!.opened("stream").filter(open => (open.spawn as string[]).includes("--follow")).length;
        await r.press("f");
        await r.waitFor("status: info: Not following: a past boot is shown.");
        await sleep(200);
        expect(mock!.opened("stream").filter(open => (open.spawn as string[]).includes("--follow")).length).toBe(follows);
    });

    it("check a custom range with journalctl before applying it", async () => {
        const r = await start({
            spawn: {
                "journalctl -q --lines=0 --since=garbage": { "exit-status": 1, stderr: "Failed to parse timestamp: garbage\n" },
                "journalctl -q --lines=0 --since=yesterday --until=today": {},
            },
            spawnPatterns: generic,
        });
        await r.waitFor("message g1");
        await r.press("t");
        await r.waitFor("Custom range");
        await r.press(keys.down, keys.down, keys.down, keys.enter);
        await r.waitFor("Custom time range");
        await r.press(keys.ctrl("u"), "garbage", keys.enter);
        await r.waitFor("Failed to parse timestamp: garbage");
        expect(r.lastFrame()).toContain("Custom time range");
        await r.press(keys.ctrl("u"), "yesterday", keys.down, "today", keys.enter);
        await r.waitFor("Error and above · yesterday to today");
        await lastPage(["journalctl", "-q", "--lines=5", "--output=json", "--since=yesterday", "--until=today",
                                    "--priority=err", "--reverse", "--"]);
        await r.waitFor("Not following: the time range has an end");
    });

    it("pick an identifier from those in the time range, narrowing as you type", async () => {
        const r = await start({
            spawnPatterns: [{ match: "^/bin/sh -c ", stdout: "cron\nsshd\nsystemd\n" }, ...generic!],
        });
        await r.waitFor("message g1");
        await r.press("i");
        await r.waitFor("systemd");
        const scan = mock!.opened("stream").find(open => (open.spawn as string[])[0] === "/bin/sh")!;
        expect(scan.spawn).toEqual([
            "/bin/sh", "-c", SCAN_SCRIPT, "--",
            "-q", "--since=-24hours", "--priority=err", "--no-tail", "--output=cat", "--output-fields=SYSLOG_IDENTIFIER", "--",
        ]);
        expect(scan.superuser).toBe("try");
        expect(scan.err).toBe("message");
        await r.press("ss");
        await r.waitFor('Use "ss"');
        expect(r.lastFrame()).not.toContain("cron");
        await r.press(keys.enter);
        await r.waitFor("identifier sshd");
        await lastPage(argv => argv.includes("--identifier=sshd"));
    });

    it("report an identifier list that failed, and stop a scan when the picker closes", async () => {
        const r = await start({
            spawnPatterns: [
                { match: "--priority=err --no-tail", stdout: "cron\n", stderr: "Failed to iterate through journal: Bad message\n" },
                { match: "--priority=debug --no-tail", keepOpen: true },
                ...generic!,
            ],
        });
        await r.waitFor("message g1");
        await r.press("i");
        let frame = await r.waitFor("Could not list every identifier");
        expect(frame).toContain("Bad message");
        // What could be read, and what is loaded, are still on offer.
        expect(frame).toContain("cron");
        expect(frame).toContain("sshd");
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Identifier (SYSLOG_IDENTIFIER)"));

        // A scan still running when the picker closes is stopped, not left to finish.
        await r.press("p");
        await r.waitFor("Debug and above");
        await r.press(keys.end, keys.enter);
        await r.waitFor("Debug and above · Last 24 hours");
        await r.press("i");
        frame = await r.waitFor("Reading identifiers in the time range");
        const scan = mock!.opened("stream").filter(open => (open.spawn as string[])[0] === "/bin/sh").at(-1)!;
        expect(scan.spawn).toContain("--priority=debug");
        await r.press(keys.escape);
        await mock!.waitForReceived(e => e.control?.command === "close" && e.control.channel === scan.channel);
    });

    it("with only an end, show that the list reaches the start of the journal", async () => {
        const r = await start({
            spawn: { "journalctl -q --lines=0 --until=today": {} },
            spawnPatterns: generic,
        }, { showHints: true });
        await r.waitFor("message g1");
        await r.press("t");
        await r.waitFor("Custom range");
        await r.press(keys.down, keys.down, keys.down, keys.enter);
        await r.waitFor("Custom time range");
        await r.press(keys.ctrl("u"), keys.down, "today", keys.enter);
        await r.waitFor("Error and above · Until today");
        await lastPage(["journalctl", "-q", "--lines=5", "--output=json", "--until=today", "--priority=err", "--reverse", "--"]);
        // Fewer than a page, and no start to the range: that is the whole journal.
        const frame = await r.waitFor("No earlier entries");
        expect(frame).not.toContain("L loads");
        expect(frame).toContain("Not following: the time range has an end");
        // Nor does the footer offer L, which can only say there is nothing.
        const hints = frame.split("\n").find(line => line.startsWith("hints: "))!;
        expect(hints).toContain("enter details");
        expect(hints).not.toMatch(/\bL (more|earlier)\b/);
    });

    it("filter by a system or user unit", async () => {
        const r = await start({ spawnPatterns: generic });
        await r.waitFor("message g1");
        await r.press("u");
        await r.waitFor("User unit");
        await r.press("sshd", keys.enter);
        await r.waitFor("unit sshd.service");
        await lastPage(argv => same(argv.slice(-6), ["--", "_SYSTEMD_UNIT=sshd.service", "+", "COREDUMP_UNIT=sshd.service", "+", "UNIT=sshd.service"]));
        await r.press("u");
        await r.waitFor("User unit");
        await r.press(keys.down, " ", keys.enter);
        await r.waitFor("user unit sshd.service");
        // A user unit is the session user's own (the mock's user is uid 1000).
        await lastPage(argv => same(argv.slice(-9), ["--", "_SYSTEMD_USER_UNIT=sshd.service", "_UID=1000", "+",
            "COREDUMP_USER_UNIT=sshd.service", "COREDUMP_UID=1000", "+", "USER_UNIT=sshd.service", "_UID=1000"]));
    });

    it("search messages, checking the pattern first", async () => {
        const r = await start({
            spawn: {
                "journalctl -q --lines=0 --grep=(": { "exit-status": 1, stderr: 'Bad pattern "(": missing closing parenthesis\n' },
                // A good pattern that matches nothing in zero lines: exit 1, silent.
                "journalctl -q --lines=0 --grep=fail": { "exit-status": 1 },
            },
            spawnPatterns: generic,
        });
        await r.waitFor("message g1");
        await r.press("/");
        await r.waitFor("Search messages");
        await r.press("(", keys.enter);
        await r.waitFor("missing closing parenthesis");
        await r.press(keys.backspace, "fail", keys.enter);
        await r.waitFor('matching "fail"');
        await lastPage(["journalctl", "-q", "--lines=5", "--output=json", "--since=-24hours", "--priority=err", "--grep=fail", "--reverse", "--"]);
    });

    it("add raw field matches, and clear everything with c", async () => {
        const r = await start({ spawnPatterns: generic });
        await r.waitFor("message g1");
        await r.press("m");
        await r.waitFor("Field matches");
        await r.press("pid=1", keys.enter);
        await r.waitFor("is not FIELD=VALUE");
        await r.press(keys.ctrl("u"), "_PID=1 _COMM=a\\ b", keys.enter);
        await r.waitFor("_PID=1 _COMM=a\\ b");
        await lastPage(argv => same(argv.slice(-3), ["--", "_PID=1", "_COMM=a b"]));
        await r.press("c");
        await r.waitFor(f => f.split("\n")[0]!.trim() === "Error and above · Last 24 hours");
        await lastPage(page(5));
    });

    it("explain why search is missing without PCRE2", async () => {
        const r = await start({ spawn: { "journalctl --version": { stdout: "systemd 239\n+PAM -PCRE2\n" } }, spawnPatterns: generic });
        await r.waitFor("message g1");
        await sleep(100);
        await r.press("/");
        await r.waitFor("status: warning: This journalctl cannot search messages (it was built without PCRE2).");
    });
});

describe("channels", () => {
    /** Wait until the client has closed the channel of this open. */
    const closed = (open: JsonObject) =>
        mock!.waitForReceived(e => e.control?.command === "close" && e.control.channel === open.channel, 3000);
    // Loading earlier within the range, before the oldest entry (10:00:01) of a full page.
    const p1 = us("2026-10-02T10:00:01Z");
    const within = ["journalctl", "-q", "--lines=5", "--output=json", "--since=-24hours", `--until=@${p1.slice(0, -6)}.${p1.slice(-6)}`,
                    "--priority=err", "--reverse", "--"];
    const debugPage = ["journalctl", "-q", "--lines=5", "--output=json", "--since=-24hours", "--priority=debug", "--reverse", "--"];
    const fetch = (cursor: string) => ["journalctl", "-q", "--lines=1", "--output=json", "--all", `--cursor=${cursor}`, "--"];

    it("closes a load still running, and the follow, when the filter changes; and a page query still running on leaving", async () => {
        const r = await start({
            spawn: {
                [key(page(5))]: out(...["p5", "p4", "p3", "p2", "p1"].map((c, i) => entry(c, `2026-10-02T10:00:0${5 - i}Z`))),
                [key(follow("p5"))]: { keepOpen: true },
                [key(within)]: { keepOpen: true },
                [key(debugPage)]: { chunks: [{ data: entry("d1", "2026-10-02T10:00:09Z", { MESSAGE: "debug one" }) }], keepOpen: true },
            },
        });
        await r.waitFor("L loads more");
        const following = await opened(follow("p5"));
        await r.press("L");
        await r.waitFor("Loading earlier entries");
        const earlier = await opened(within);
        await r.press("p");
        await r.waitFor("Debug and above");
        await r.press(keys.end, keys.enter);
        await r.waitFor("debug one");
        await closed(earlier);
        await closed(following);
        // The new page query is still reading when the page goes.
        const reading = await opened(debugPage);
        r.unmount();
        await closed(reading);
    });

    it("closes a fetch of full values when the entry is left, stepped from, or the page goes", async () => {
        const r = await start({
            spawn: {
                [key(page(5))]: out(entry("f2", "2026-10-02T10:00:02Z", { BIG: null }), entry("f1", "2026-10-02T10:00:01Z", { BIG: null })),
                [key(follow("f2"))]: { keepOpen: true },
                [key(fetch("f2"))]: { keepOpen: true },
                [key(fetch("f1"))]: { keepOpen: true },
            },
        });
        await r.waitFor("message f1");
        await r.press(keys.enter);
        await r.waitFor("Entry at 2026-10-02 10:00:02");
        await r.press("a");
        await r.waitFor("Fetching full values");
        // Asking again while it runs starts nothing more.
        await r.press("a", keys.escape);
        await closed(await opened(fetch("f2")));
        expect(mock!.opened("stream").filter(open => same(open.spawn, fetch("f2")))).toHaveLength(1);

        await r.press(keys.enter);
        await r.waitFor("Entry at 2026-10-02 10:00:02");
        await r.press("a");
        await r.waitFor("Fetching full values");
        await r.press(keys.right);
        await r.waitFor("Entry at 2026-10-02 10:00:01");
        await closed(await opened(fetch("f2"), 2));

        await r.press("a");
        await r.waitFor("Fetching full values");
        const last = await opened(fetch("f1"));
        r.unmount();
        await closed(last);
    });

    it("stops listing boots when the time dialog closes, and checking a range when the page goes", async () => {
        const r = await start({
            spawn: {
                [key(page(5))]: out(entry("b1", "2026-10-02T10:00:00Z")),
                [key(follow("b1"))]: { keepOpen: true },
                "journalctl -q --list-boots --output=json": { keepOpen: true },
                "journalctl -q --lines=0 --since=yesterday": { keepOpen: true },
            },
        });
        await r.waitFor("message b1");
        await r.press("t");
        await r.waitFor("Reading the list of boots");
        const boots = await opened(["journalctl", "-q", "--list-boots", "--output=json"]);
        await r.press(keys.escape);
        await closed(boots);

        await r.press("t");
        await r.waitFor("Custom range");
        await r.press(keys.down, keys.down, keys.down, keys.enter);
        await r.waitFor("Custom time range");
        await r.press(keys.ctrl("u"), "yesterday", keys.enter);
        await r.waitFor("Checking with journalctl");
        const check = await opened(["journalctl", "-q", "--lines=0", "--since=yesterday"]);
        r.unmount();
        await closed(check);
    });
});

describe("the page", () => {
    it("takes a unit and priority from Services with a single query", async () => {
        // A unit's log is asked for over the whole journal: no --since.
        const argv = ["journalctl", "-q", "--lines=5", "--output=json", "--priority=debug", "--reverse", "--",
                      "_SYSTEMD_UNIT=sshd.service", "+", "COREDUMP_UNIT=sshd.service", "+", "UNIT=sshd.service"];
        const r = await start({
            spawn: { [key(argv)]: out(entry("v1", "2026-10-02T10:00:00Z")) },
            spawnPatterns: [{ match: "--follow", keepOpen: true }],
        }, { params: { pageId: "logs", value: { unit: { name: "sshd.service" }, priority: "debug" } } });
        await r.waitFor("Debug and above · Entire journal · unit sshd.service");
        await r.waitFor(`${glyphs.bullet} Following`);
        expect(pageQueries().map(open => open.spawn)).toEqual([argv]);
    });

    it("remembers a pause, but follows again when another page sends it here", async () => {
        const scenario: MockScenario = {
            spawnPatterns: [
                { match: "--reverse", stdout: entry("w1", "2026-10-02T10:00:00Z") },
                { match: "--follow", keepOpen: true },
            ],
        };
        // Coming back on its own, the page is still paused.
        await start(scenario, { columns: 1, rows: 1 }); // the mock and cockpit.info; this render is not used
        cleanup();
        let r = renderSeeded({ "logs:follow": false });
        await r.waitFor("message w1");
        await r.waitFor(`${glyphs.hollow} Paused`);
        expect(mock!.opened("stream").some(open => (open.spawn as string[]).includes("--follow"))).toBe(false);
        cleanup();
        // "View all logs" from Services: the live log.
        r = renderSeeded({ "logs:follow": false, [paramsKey("logs")]: { unit: { name: "sshd.service" }, priority: "debug" } });
        await r.waitFor("Debug and above · Entire journal · unit sshd.service");
        await r.waitFor(`${glyphs.bullet} Following`);
    });

    it("names the time zone of the times shown when the terminal may not be on the host", async () => {
        // Over ssh or ws, this terminal's zone (UTC here) may differ from the host's.
        const session = { mode: "ssh" } as unknown as Session;
        const r = await start({
            spawn: { [key(page(5))]: out(entry("t1", "2026-10-02T10:00:00Z")), [key(follow("t1"))]: { keepOpen: true } },
        }, { session });
        await r.waitFor(f => /Following .* times in UTC\s*$/m.test(f.split("\n")[1] ?? ""));
        await r.press(keys.enter);
        await r.waitFor("Entry at 2026-10-02 10:00:00 UTC");
    });

    it("shows the equivalent journalctl command", async () => {
        const r = await start({ spawnPatterns: [{ match: "--reverse", stdout: "" }, { match: "--follow", keepOpen: true }] });
        await r.waitFor("No entries match");
        await r.press("!");
        await r.waitFor("journalctl --since=-24hours --priority=err --reverse");
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Equivalent command"));
    });

    it("fits every dialog into the smallest page, without drawing lines over each other", async () => {
        const cursor = "s=ae7155f9e5f145d780e29c6c8b884a4d;i=1fa6a;b=6941496e92cc47d5ae80f80472bc1198;m=e86942c4dc;t=65cd53e39eeb0;x=d61479c6ee1bbd5c";
        const r = await start({
            spawnPatterns: [
                { match: "^/bin/sh -c ", stdout: "cron\nkernel\nsshd\nsudo\nsystemd\n", stderr: "Failed to iterate through journal: Bad message\n" },
                { match: "--reverse", stdout: entry(cursor, "2026-10-02T10:00:00Z") },
                { match: "--follow", keepOpen: true },
            ],
        }, { columns: 50, rows: 11 });
        await r.waitFor("message s=ae71");
        /** The dialog's lines, inside its border. */
        const inside = (frame: string) => frame.split("\n").map(line => /│ (.*?) *│/.exec(line)?.[1]).filter(line => line !== undefined);
        const forms: [string[], string, string, string[]][] = [
            [["u"], "Unit", "< Apply >   < Cancel >", ["›Unit", "User unit [ ]"]],
            [["/"], "Search messages", "< Search >   < Cancel >", ["›Pattern"]],
            [["m"], "Field matches", "< Apply >   < Cancel >", ["›Matches"]],
            [["t", keys.down, keys.down, keys.down, keys.enter], "Custom time range", "< Apply >   < Cancel >", ["›Since", "Until"]],
        ];
        for (const [press, title, buttons, fields] of forms) {
            await r.press(...press);
            const lines = inside(await r.waitFor(title));
            // The fields and the buttons line are all there, whole, in their order.
            const at = [...fields, buttons].map(text => lines.findIndex(line => line.trimStart().startsWith(text)));
            expect(at.every(i => i >= 0), `${title}: ${JSON.stringify(lines)}`).toBe(true);
            expect(at).toEqual([...at].sort((a, b) => a - b));
            await r.press(keys.escape);
            await r.waitFor(f => !f.includes(title));
        }

        // The identifier picker: the field, the problem (cut short), and the list with its position.
        await r.press("i");
        let lines = inside(await r.waitFor("Could not list every identifier"));
        expect(lines.some(line => line.startsWith("Filter "))).toBe(true);
        expect(lines.some(line => line.startsWith(`${glyphs.warning} Could not list every identifier`) && line.endsWith(glyphs.ellipsis))).toBe(true);
        expect(lines.some(line => /^\d+\/6$/.test(line))).toBe(true);
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Identifier (SYSLOG_IDENTIFIER)"));

        // The command, which is there to be copied, whole.
        await r.press(keys.enter);
        await r.waitFor("Entry at");
        await r.press("!");
        lines = inside(await r.waitFor("Equivalent command"));
        expect(lines.join("").replace(/\s/g, "")).toContain(`journalctl--all--output=verbose--lines=1'--cursor=${cursor}'`);
    });

    it("cuts journalctl's complaint short in a form at the smallest page, rather than drawing it over itself", async () => {
        const r = await start({
            spawnPatterns: [
                { match: "^journalctl -q --lines=0 --since=", "exit-status": 1, stderr: "Failed to parse timestamp: garbage stuff here\n" },
                { match: "--reverse", stdout: entry("x1", "2026-10-02T10:00:00Z") },
                { match: "--follow", keepOpen: true },
            ],
        }, { columns: 50, rows: 11 });
        await r.waitFor("message x1");
        await r.press("t");
        await r.waitFor("Time range");
        await r.press(keys.down, keys.down, keys.down, keys.enter);
        await r.waitFor("Custom time range");
        await r.press(keys.ctrl("u"), "garbage stuff here", keys.enter);
        const frame = await r.waitFor(f => f.includes("Failed to parse") && !f.includes("Checking with journalctl"));
        const lines = frame.split("\n").map(line => /│ (.*?) *│/.exec(line)?.[1]).filter(line => line !== undefined);
        const at = ["›Since", "Until", "Failed to parse timestamp: garbage", "< Apply >   < Cancel >"]
            .map(text => lines.findIndex(line => line.trimStart().startsWith(text)));
        expect(at.every(i => i >= 0), JSON.stringify(lines)).toBe(true);
        expect(at).toEqual([...at].sort((a, b) => a - b));
        expect(frame).not.toContain("hereed");
    });

    it("fits a small area", async () => {
        const r = await start({
            spawn: {
                [key(page(5))]: out(...["e5", "e4", "e3", "e2", "e1"].map((c, i) => entry(c, `2026-10-02T10:00:0${5 - i}Z`, {
                    SYSLOG_IDENTIFIER: "a-rather-long-identifier", MESSAGE: "a message long enough to be cut at fifty columns",
                }))),
                [key(follow("e5"))]: { keepOpen: true },
            },
        }, { columns: 50, rows: 11 });
        const frame = await r.waitFor("L loads more");
        const lines = frame.split("\n");
        expect(lines.length).toBeLessThanOrEqual(11);
        for (const line of lines)
            expect(line.length).toBeLessThanOrEqual(50);
        expect(frame).toContain("TIME");
        expect(frame).toContain("MESSAGE");
        expect(frame).toMatch(/10:00:05 ERR\s+a-rather-l…\s+a message/);
    });
});
