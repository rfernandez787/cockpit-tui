/*
 * The Logs page's pure logic: filters, rows, text safety, entry details,
 * commands, user input and list navigation. No bridge, no rendering.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Times are shown in the terminal's zone: pin it. Restored afterwards so
// other test files sharing this worker see the zone they expect.
const savedTZ = process.env.TZ;
process.env.TZ = "UTC";
afterAll(() => {
    if (savedTZ === undefined)
        delete process.env.TZ;
    else
        process.env.TZ = savedTZ;
});

import { parseEntry, type JournalEntry } from "../../src/lib/journal.js";
import {
    DEFAULT_FILTER, CURRENT_BOOT, buildRows, dayLabel, detailLines, displayCommand, displayLine, displayLines, displayText,
    earlierFilter, earlierQuery, entryText, exactTime, fieldNote, fieldValue, filterFromParams, filterKey, filterSummary,
    fitHints, followBlocked, formatMatches, hasMissing, journalFilter, moreText, normalizeUnit, parseMatches, preciseTime,
    shellQuote, timeLabel, timeName, wrapIndented,
    type EntryRow, type LogsFilter, type Row,
} from "../../src/pages/logs/model.js";
import { TOP, moveTo, navKey, navModel, resolve, type NavState } from "../../src/pages/logs/nav.js";
import { bannerLines, entryOrdinals, listHints, positionText } from "../../src/pages/logs/index.js";
import { detailHints } from "../../src/pages/logs/detail.js";
import { SCAN_SCRIPT, SCAN_SCRIPT_VERBOSE, identifierScanArgv } from "../../src/pages/logs/identifiers.js";

/** Microseconds since the epoch, as journalctl sends __REALTIME_TIMESTAMP. */
const us = (iso: string) => String(Date.parse(iso) * 1000);

let nextCursor = 1;
function entry(fields: Record<string, unknown>): JournalEntry {
    const parsed = parseEntry(JSON.stringify({
        __CURSOR: `s=x;i=${nextCursor++}`,
        __REALTIME_TIMESTAMP: us("2026-10-02T18:13:44Z"),
        _BOOT_ID: "b1",
        PRIORITY: "3",
        SYSLOG_IDENTIFIER: "sshd",
        MESSAGE: "hello",
        ...fields,
    }));
    if (!parsed)
        throw new Error("bad entry");
    return parsed;
}

describe("filters", () => {
    it("map onto journalctl options", () => {
        expect(journalFilter(DEFAULT_FILTER)).toEqual({ priority: "err", since: "-24hours" });
        expect(journalFilter({ ...DEFAULT_FILTER, time: CURRENT_BOOT })).toEqual({ priority: "err", boot: "0" });
        expect(journalFilter({
            priority: "debug",
            time: { kind: "custom", since: "yesterday", until: "today" },
            identifier: "sshd",
            unit: { name: "sshd.service" },
            grep: "fail",
            matches: ["_PID=1"],
        })).toEqual({
            priority: "debug", since: "yesterday", until: "today", identifier: "sshd",
            unit: { name: "sshd.service" }, grep: "fail", matches: ["_PID=1"],
        });
        expect(journalFilter({ ...DEFAULT_FILTER, time: { kind: "custom" } })).toEqual({ priority: "err" });
    });

    it("continue past the time range for earlier entries, keeping every other filter", () => {
        const f = { priority: "err" as const, since: "-24hours", identifier: "sshd", unit: { name: "a.service" } };
        // Anchored on the oldest entry shown: the cursor is the only bound.
        expect(earlierFilter(f, true)).toEqual({ priority: "err", identifier: "sshd", unit: { name: "a.service" } });
        expect(earlierFilter({ priority: "err", boot: "abc", until: "today" }, true)).toEqual({ priority: "err" });
        // Nothing shown: everything before the window.
        expect(earlierFilter(f, false)).toEqual({ priority: "err", identifier: "sshd", unit: { name: "a.service" }, until: "-24hours" });
        expect(earlierFilter({ priority: "err", since: "yesterday", until: "today" }, false)).toEqual({ priority: "err", until: "yesterday" });
        // A boot or an until-only range has nothing to anchor on.
        expect(earlierFilter({ priority: "err", boot: "0" }, false)).toBeNull();
        expect(earlierFilter({ priority: "err", until: "today" }, false)).toBeNull();
    });

    it("page within the time range without combining --since and a cursor, then continue past it", () => {
        const oldest = entry({ __CURSOR: "s=o;i=1", __REALTIME_TIMESTAMP: "1790988476314286" });
        expect(exactTime(oldest)).toBe("@1790988476.314286");
        expect(exactTime(entry({ __REALTIME_TIMESTAMP: "12" }))).toBeNull();
        const since = { priority: "err" as const, since: "-24hours", identifier: "sshd" };
        // journalctl refuses --since with --after-cursor: the range continues with an exact --until.
        expect(earlierQuery(since, oldest, false, 5)).toEqual({
            within: true,
            argv: ["journalctl", "-q", "--lines=5", "--output=json", "--since=-24hours", "--until=@1790988476.314286",
                   "--priority=err", "--identifier=sshd", "--reverse", "--"],
        });
        // A custom end is replaced by the (earlier) exact time.
        expect(earlierQuery({ ...since, until: "today" }, oldest, false, 5)!.argv).toContain("--until=@1790988476.314286");
        expect(earlierQuery({ ...since, until: "today" }, oldest, false, 5)!.argv).not.toContain("--until=today");
        // A boot, or no start, combines with the cursor directly.
        expect(earlierQuery({ priority: "err", boot: "0" }, oldest, false, 5)).toEqual({
            within: true,
            argv: ["journalctl", "-q", "--lines=5", "--output=json", "--boot=0", "--after-cursor=s=o;i=1", "--priority=err", "--reverse", "--"],
        });
        // Past the range: from the cursor, without boot, since or until.
        expect(earlierQuery({ ...since, boot: "0", until: "today" }, oldest, true, 5)).toEqual({
            within: false,
            argv: ["journalctl", "-q", "--lines=5", "--output=json", "--after-cursor=s=o;i=1", "--priority=err", "--identifier=sshd", "--reverse", "--"],
        });
        // Nothing shown: everything before a since-based range; nothing to anchor a boot on.
        expect(earlierQuery(since, undefined, true, 5)!.argv).toEqual(
            ["journalctl", "-q", "--lines=5", "--output=json", "--until=-24hours", "--priority=err", "--identifier=sshd", "--reverse", "--"]);
        expect(earlierQuery({ priority: "err", boot: "0" }, undefined, true, 5)).toBeNull();
        // No time on the entry: straight past the range rather than guess.
        const timeless = entry({ __REALTIME_TIMESTAMP: undefined });
        expect(earlierQuery(since, timeless, false, 5)!.within).toBe(false);
        for (const query of [earlierQuery(since, oldest, false, 5), earlierQuery(since, oldest, true, 5)]) {
            const argv = query!.argv;
            expect(argv.some(a => a.startsWith("--since=")) && argv.some(a => a.startsWith("--after-cursor="))).toBe(false);
        }
    });

    it("say when following is impossible", () => {
        expect(followBlocked(DEFAULT_FILTER)).toBeNull();
        expect(followBlocked({ ...DEFAULT_FILTER, time: CURRENT_BOOT })).toBeNull();
        expect(followBlocked({ ...DEFAULT_FILTER, time: { kind: "boot", id: "abc", index: -1 } })).toBe("a past boot is shown");
        expect(followBlocked({ ...DEFAULT_FILTER, time: { kind: "custom", since: "yesterday" } })).toBeNull();
        expect(followBlocked({ ...DEFAULT_FILTER, time: { kind: "custom", until: "today" } })).toBe("the time range has an end");
    });

    it("take params from other pages, checking every field", () => {
        expect(filterFromParams({ unit: { name: "sshd.service" }, priority: "debug" }))
            .toEqual({ ...DEFAULT_FILTER, time: { kind: "custom" }, priority: "debug", unit: { name: "sshd.service" } });
        expect(filterFromParams({ unit: { name: "podman.service", user: true } }))
            .toEqual({ ...DEFAULT_FILTER, time: { kind: "custom" }, unit: { name: "podman.service", user: true } });
        expect(filterFromParams({ unit: "cron.service", identifier: " crond " }))
            .toEqual({ ...DEFAULT_FILTER, time: { kind: "custom" }, unit: { name: "cron.service" }, identifier: "crond" });
        // Unknown priorities and empty names are ignored; nothing usable is null.
        expect(filterFromParams({ priority: "loud", unit: { name: "" } })).toBeNull();
        expect(filterFromParams(null)).toBeNull();
        expect(filterFromParams("sshd")).toBeNull();
        expect(filterFromParams({ unit: { name: "x.service", user: "yes" } })).toEqual({ ...DEFAULT_FILTER, time: { kind: "custom" }, unit: { name: "x.service" } });
    });

    it("label the time range and summarise the filters", () => {
        expect(timeLabel(DEFAULT_FILTER.time)).toBe("Last 24 hours");
        expect(timeLabel({ kind: "recent", since: "-7days" })).toBe("Last 7 days");
        expect(timeLabel(CURRENT_BOOT)).toBe("Current boot");
        expect(timeLabel({ kind: "boot", id: "abc", index: -2, first: Date.parse("2026-09-20T10:43:00Z") })).toBe("Boot -2 (2026-09-20 10:43)");
        expect(timeLabel({ kind: "custom", since: "yesterday", until: "today" })).toBe("yesterday to today");
        expect(timeLabel({ kind: "custom", until: "today" })).toBe("Until today");
        expect(timeLabel({ kind: "custom" })).toBe("Entire journal");
        expect(timeName(DEFAULT_FILTER.time)).toBe("the last 24 hours");
        expect(timeName(CURRENT_BOOT)).toBe("the current boot");
        expect(timeName({ kind: "boot", id: "abc", index: -1 })).toBe("boot -1");

        const f: LogsFilter = {
            priority: "warning", time: CURRENT_BOOT, identifier: "sshd", unit: { name: "podman.service", user: true },
            grep: "fail", matches: ["_PID=1", "MESSAGE_ID=a b"],
        };
        expect(filterSummary(f)).toEqual([
            "Warning and above", "Current boot", "user unit podman.service", "identifier sshd", 'matching "fail"', "_PID=1 MESSAGE_ID=a\\ b",
        ]);
        expect(filterKey(f)).not.toBe(filterKey(DEFAULT_FILTER));
        expect(filterKey({ ...DEFAULT_FILTER })).toBe(filterKey(DEFAULT_FILTER));
    });
});

describe("text safety", () => {
    it("removes escape sequences whole and shows other controls visibly", () => {
        // Coloured container output, as found 302 times on the development host.
        expect(displayLines("\x1b[37mDEBU\x1b[0m[0000] Using /data to match uid and gid\r\n"))
            .toEqual(["DEBU[0000] Using /data to match uid and gid"]);
        expect(displayText("a\x1b]0;pwned\x07b")).toBe("ab");          // window title (OSC)
        expect(displayText("a\x1b]52;c;ZXZpbA==\x1b\\b")).toBe("ab");  // clipboard write (OSC 52)
        expect(displayText("a\x1b[2Jb\x1bcc")).toBe("abc");            // clear screen, reset
        expect(displayText("a\u009b31mb")).toBe("ab");                 // 8-bit CSI
        expect(displayText("x\x07y\x00z")).toBe("x^Gy^@z");             // bell, NUL
        expect(displayText("tab\there")).toBe("tab here");
        expect(displayText("left\u202Ereversed")).toBe("leftreversed"); // bidi override
        expect(displayText("a\u061Cb\u200Fc\u2067d")).toBe("abcd");       // every Bidi_Control, ALM included
        expect(displayText("lone \x1b")).toBe("lone ^[");
        expect(displayText("caf\u00e9 \u6f22\u5b57")).toBe("caf\u00e9 \u6f22\u5b57");
    });

    it("splits messages into lines without the trailing line break", () => {
        expect(displayLines("one\ntwo\r\nthree\n")).toEqual(["one", "two", "three"]);
        expect(displayLines("")).toEqual([""]);
    });
});

describe("rows", () => {
    it("show what a list line needs, computed once per entry", () => {
        const e = entry({ MESSAGE: "first\nsecond\nthird", PRIORITY: "4" });
        const text = entryText(e);
        expect(text).toEqual({ day: "2026-10-02", time: "18:13:44", badge: "WARN", identifier: "sshd", message: "first", more: 2 });
        expect(entryText(e)).toBe(text);
        expect(entryText(entry({ SYSLOG_IDENTIFIER: undefined, _COMM: "conmon", PRIORITY: undefined })))
            .toMatchObject({ identifier: "conmon", badge: "-" });
    });

    it("put a day header above each day, a separator at each reboot, and collapse repeats", () => {
        const newest = entry({ __REALTIME_TIMESTAMP: us("2026-10-02T09:00:03Z"), MESSAGE: "again" });
        const entries = [
            newest,
            entry({ __REALTIME_TIMESTAMP: us("2026-10-02T09:00:02Z"), MESSAGE: "again" }),
            entry({ __REALTIME_TIMESTAMP: us("2026-10-02T09:00:01Z"), MESSAGE: "again" }),
            entry({ __REALTIME_TIMESTAMP: us("2026-10-02T08:00:00Z"), MESSAGE: "other" }),
            // Same text, but another boot and day: never collapsed into the above.
            entry({ __REALTIME_TIMESTAMP: us("2026-10-01T23:00:00Z"), MESSAGE: "other", _BOOT_ID: "b0" }),
            entry({ __REALTIME_TIMESTAMP: us("2026-10-01T22:00:00Z"), MESSAGE: "older", _BOOT_ID: "b0" }),
        ];
        const rows = buildRows(entries);
        const shape = rows.map(row => row.kind === "entry" ? `${entryText(row.entry).message}x${row.count}` : row.kind === "day" ? `day ${row.text}` : row.kind);
        expect(shape).toEqual([
            `day ${dayLabel(Date.parse("2026-10-02T09:00:00Z"))}`, "againx3", "otherx1",
            `day ${dayLabel(Date.parse("2026-10-01T23:00:00Z"))}`, "reboot", "otherx1", "olderx1",
        ]);
        const repeated = rows[1] as EntryRow;
        expect(repeated.entry).toBe(newest);
        expect(repeated.oldest).toBe(entries[2]);
        expect(repeated.key).toBe(newest.cursor);
        expect(new Set(rows.map(row => row.key)).size).toBe(rows.length);
        expect(dayLabel(Date.parse("2026-10-02T09:00:00Z"))).toMatch(/2026/);
    });

    it("mark where entries from before the time range begin, never folding repeats across it", () => {
        const at = (iso: string, message: string) => entry({ __REALTIME_TIMESTAMP: us(iso), MESSAGE: message });
        const entries = [
            at("2026-10-02T09:00:02Z", "same"),
            at("2026-10-02T09:00:01Z", "same"),
            // The first entry "load earlier" brought from before the range: same text, same day.
            at("2026-10-02T09:00:00Z", "same"),
            at("2026-10-02T08:00:00Z", "older"),
        ];
        const rows = buildRows(entries, { cursor: entries[2]!.cursor, text: "Before the last 24 hours" });
        const shape = rows.map(row => row.kind === "entry" ? `${entryText(row.entry).message}x${row.count}` : row.kind === "range" ? `range ${row.text}` : row.kind);
        // The day is repeated under the separator, so the older entries' day is always in view.
        expect(shape).toEqual(["day", "samex2", "range Before the last 24 hours", "day", "samex1", "olderx1"]);
        expect(new Set(rows.map(row => row.key)).size).toBe(rows.length);
        // Without a range (or with one not among the entries) nothing changes.
        expect(buildRows(entries).map(row => row.kind)).toEqual(["day", "entry", "entry"]);
        expect(buildRows(entries, { cursor: "gone", text: "x" }).map(row => row.kind)).toEqual(["day", "entry", "entry"]);
    });

    it("keep their keys when entries arrive above", () => {
        const a = entry({ MESSAGE: "a" });
        const b = entry({ MESSAGE: "b" });
        const before = buildRows([a, b]).map(row => row.key);
        const after = buildRows([entry({ MESSAGE: "new" }), a, b]).map(row => row.key);
        expect(after).toEqual(expect.arrayContaining(before.filter(key => !key.startsWith("day:"))));
    });

    it("never mark a reboot for an entry without a boot id", () => {
        const rows = buildRows([entry({ _BOOT_ID: undefined, MESSAGE: "x" }), entry({ MESSAGE: "y" })]);
        expect(rows.some(row => row.kind === "reboot")).toBe(false);
    });
});

describe("entry details", () => {
    it("render strings, binary values, repeated fields and left-out values", () => {
        expect(fieldValue("A", "x\ny")).toEqual({ lines: ["x", "y"], note: null, missing: false });
        expect(fieldValue("A", [...Buffer.from("\x1b[1mbold\x1b[0m\r\n")])).toEqual({ lines: ["bold"], note: "binary, 14 bytes", missing: false });
        expect(fieldValue("_UDEV_DEVLINK", ["/dev/a", "/dev/b"])).toEqual({ lines: ["/dev/a", "/dev/b"], note: "2 values", missing: false });
        expect(fieldValue("A", null)).toEqual({ lines: ["[no data]"], note: "too long to print by default", missing: true });
        expect(fieldValue("A", ["x", null]).missing).toBe(true);
        expect(fieldValue("A", 5)).toEqual({ lines: ["5"], note: null, missing: false });
        expect(hasMissing({ A: "x", B: null })).toBe(true);
        expect(hasMissing({ A: "x" })).toBe(false);
    });

    it("explain numeric fields", () => {
        expect(fieldNote("__REALTIME_TIMESTAMP", "1790983795733197")).toBe(preciseTime(1790983795733197));
        expect(preciseTime(1790983795733197)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.733197$/);
        expect(fieldNote("__MONOTONIC_TIMESTAMP", "1061192091896")).toBe("1061192.091896 s after boot");
        expect(fieldNote("PRIORITY", "3")).toBe("err");
        expect(fieldNote("SYSLOG_FACILITY", "10")).toBe("authpriv");
        expect(fieldNote("PRIORITY", "x")).toBeNull();
        expect(fieldNote("_PID", "42")).toBeNull();
    });

    it("lay out the message, a summary and every other field sorted by name", () => {
        const e = entry({
            MESSAGE: "line one\nline two",
            _SYSTEMD_UNIT: "sshd.service",
            ZZZ: "last",
            AAA: "first\nsecond",
            VERY_LONG_FIELD_NAME_THAT_DOES_NOT_FIT: "v",
            BIG: null,
        });
        const row: EntryRow = { kind: "entry", key: e.cursor, entry: e, count: 2, oldest: e, cursors: [e.cursor] };
        const lines = detailLines(row, 60, { unit: { name: "sshd.service" } }).map(line => line.text);
        expect(lines.slice(0, 3)).toEqual(["line one", "line two", ""]);
        expect(lines).toContain(`Repeated   2 times, first at 2026-10-02 18:13:44`);
        expect(lines).toContain("Unit       sshd.service  (o opens it in Services)");
        const fields = lines.slice(lines.findIndex(line => line.startsWith("Fields (")) + 1);
        expect(lines.find(line => line.startsWith("Fields ("))).toBe("Fields (10)");
        // Sorted, MESSAGE left out (it is shown above), continuation lines indented.
        const names = fields.filter(line => /^\S/.test(line)).map(line => line.split(/\s+/)[0]);
        expect(names).toEqual([...names].sort());
        expect(names).not.toContain("MESSAGE");
        const aaa = fields.findIndex(line => line.startsWith("AAA"));
        expect(fields[aaa]).toMatch(/^AAA\s+first$/);
        expect(fields[aaa + 1]).toMatch(/^\s+second$/);
        // A name too long for the label column gets its own line.
        const long = fields.indexOf("VERY_LONG_FIELD_NAME_THAT_DOES_NOT_FIT");
        expect(long).toBeGreaterThan(-1);
        expect(fields[long + 1]).toMatch(/^\s+v$/);
        expect(fields.some(line => /^BIG\s+\[no data\]/.test(line))).toBe(true);
    });

    it("clean the unit name, which is host text like any other field", () => {
        // UNIT=, USER_UNIT= and COREDUMP_UNIT= are fields any process may log.
        const e = entry({ UNIT: "x" });
        const row: EntryRow = { kind: "entry", key: e.cursor, entry: e, count: 1, oldest: e, cursors: [e.cursor] };
        const unit = { name: "a\x0e\r\x07\x1b[8m\x1b]8;;https://evil.example/\x07\u202Eb.service" };
        const lines = detailLines(row, 80, { unit }).map(line => line.text);
        expect(lines).toContain("Unit       a^N^Gb.service  (o opens it in Services)");
        expect(lines.join("\n")).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f\u202e]/);
    });
});

describe("commands", () => {
    it("quote only what the shell would misread", () => {
        expect(shellQuote("--priority=err")).toBe("--priority=err");
        expect(shellQuote("--cursor=s=1;i=2")).toBe("'--cursor=s=1;i=2'");
        expect(shellQuote("--grep=it's bad")).toBe("'--grep=it'\\''s bad'");
        expect(shellQuote("")).toBe("''");
    });

    it("show the page query without its plumbing", () => {
        expect(displayCommand(["journalctl", "-q", "--lines=1000", "--output=json", "--since=-24hours", "--priority=err", "--reverse", "--"]))
            .toBe("journalctl --since=-24hours --priority=err --reverse");
        expect(displayCommand(["journalctl", "-q", "--lines=1000", "--output=json", "--grep=a b", "--reverse", "--", "_SYSTEMD_UNIT=x.service", "+", "UNIT=x.service"]))
            .toBe("journalctl '--grep=a b' --reverse -- _SYSTEMD_UNIT=x.service + UNIT=x.service");
    });
});

describe("user input", () => {
    it("completes unit names the way journalctl -u does", () => {
        expect(normalizeUnit("sshd")).toEqual({ name: "sshd.service" });
        expect(normalizeUnit(" fstrim.timer ")).toEqual({ name: "fstrim.timer" });
        expect(normalizeUnit("user@1000.service")).toEqual({ name: "user@1000.service" });
        expect(normalizeUnit("")).toEqual({ name: "" });
        expect(normalizeUnit("ssh d")).toHaveProperty("error");
        expect(normalizeUnit("ssh*")).toHaveProperty("error");
        expect(normalizeUnit("a/b")).toHaveProperty("error");
    });

    it("reads FIELD=VALUE matches, with escaped spaces", () => {
        expect(parseMatches("  _PID=1   _COMM=a\\ b  ")).toEqual({ matches: ["_PID=1", "_COMM=a b"] });
        expect(parseMatches("")).toEqual({ matches: [] });
        expect(parseMatches("MESSAGE=")).toEqual({ matches: ["MESSAGE="] });
        expect(parseMatches("pid=1")).toHaveProperty("error");
        expect(parseMatches("1ABC=x")).toHaveProperty("error");
        expect(parseMatches("=x")).toHaveProperty("error");
        expect(parseMatches("A=1 + B=2")).toHaveProperty("error");
        for (const matches of [["_PID=1"], ["A=a b", "B=c\\d"], ["X=trailing\\"]])
            expect(parseMatches(formatMatches(matches))).toEqual({ matches });
    });
});

describe("list navigation", () => {
    /** An entry row keyed `key`, holding `members` (cursors) besides the key itself. */
    const row = (key: string, e: JournalEntry, members: string[] = []): Row =>
        ({ kind: "entry", key, entry: e, count: 1 + members.length, oldest: e, cursors: [key, ...members] });
    // day, e1, e2, day, reboot, e3, e4, (trailer)
    const e = [1, 2, 3, 4].map(n => entry({ MESSAGE: `m${n}` }));
    const rows: Row[] = [
        { kind: "day", key: "day:1", text: "d1" },
        row("e1", e[0]!),
        row("e2", e[1]!),
        { kind: "day", key: "day:3", text: "d0" },
        { kind: "reboot", key: "boot:3" },
        row("e3", e[2]!),
        row("e4", e[3]!),
    ];
    const model = navModel(rows, true);

    it("starts on the newest entry and steps over separators", () => {
        expect(model).toMatchObject({ count: 8, first: 1, last: 6 });
        let current = resolve(model, TOP, 4);
        expect(current).toEqual({ index: 1, offset: 0 });
        let state = navKey(model, current, 4, "down")!;
        expect(state).toMatchObject({ key: "e2", index: 2, top: false });
        current = resolve(model, state, 4);
        state = navKey(model, current, 4, "down")!;
        // e3, with its day header and reboot separator still in view.
        expect(state).toMatchObject({ key: "e3", index: 5 });
        expect(resolve(model, state, 4).offset).toBeLessThanOrEqual(3);
        current = resolve(model, state, 4);
        state = navKey(model, current, 4, "up")!;
        expect(state.key).toBe("e2");
        state = navKey(model, resolve(model, state, 4), 4, "up")!;
        expect(state).toMatchObject({ key: "e1", top: true });
    });

    it("shows the trailer at the last entry, and jumps with Home and End", () => {
        const end = navKey(model, resolve(model, TOP, 3), 3, "end")!;
        expect(end).toMatchObject({ key: "e4", index: 6, offset: 5 });
        const home = navKey(model, resolve(model, end, 3), 3, "home")!;
        expect(home).toMatchObject({ key: "e1", offset: 0, top: true });
        const pageDown = navKey(model, resolve(model, TOP, 3), 3, "pageDown")!;
        expect(pageDown.key).toBe("e3");
    });

    it("stays on the newest entry while new ones arrive at the top", () => {
        const grown: Row[] = [{ kind: "day", key: "day:0", text: "d1" }, row("e0", e[0]!), ...rows.slice(1)];
        expect(resolve(navModel(grown, true), TOP, 4).index).toBe(1);
    });

    it("keeps a selection elsewhere on its entry, moving the view with it", () => {
        const state: NavState = { key: "e3", index: 5, offset: 3, top: false };
        const grown: Row[] = [
            { kind: "day", key: "day:new", text: "d1" },
            row("n1", e[0]!),
            row("n2", e[0]!),
            ...rows.slice(1),
        ];
        // Two rows were inserted above e3: it is at 7 now, and still on the same screen line.
        expect(resolve(navModel(grown, true), state, 4)).toEqual({ index: 7, offset: 5 });
    });

    it("finds an entry that a repeat arriving above folded into its run", () => {
        // e1 was selected (not pinned to the top); a repeat of it arrived and
        // now leads the run, which is keyed by the newcomer.
        const state: NavState = { key: "e1", index: 1, offset: 0, top: false };
        const folded: Row[] = [rows[0]!, row("e0", e[0]!, ["e1"]), ...rows.slice(2)];
        const model2 = navModel(folded, true);
        expect(model2.indexOf("e1")).toBe(1);
        expect(model2.indexOf("e0")).toBe(1);
        expect(resolve(model2, state, 4)).toEqual({ index: 1, offset: 0 });
        expect(model2.keyAt(1)).toBe("e0");
    });

    it("falls back to the nearest entry when the selected one is gone", () => {
        const state: NavState = { key: "gone", index: 3, offset: 0, top: false };
        expect(resolve(model, state, 4).index).toBe(5);
        expect(resolve(navModel([], false), TOP, 4)).toEqual({ index: -1, offset: 0 });
    });

    it("moves the view with the selection on page keys", () => {
        const current = resolve(model, { key: "e2", index: 2, offset: 0, top: false }, 3);
        const next = moveTo(model, current, 5, 3, 2);
        expect(next.index).toBe(5);
        expect(next.offset).toBeGreaterThanOrEqual(3);
    });
});

describe("footer hints", () => {
    const cost = (hints: readonly (readonly [string, string])[]) =>
        hints.reduce((sum, [key, label], i) => sum + key.length + 1 + label.length + (i ? 2 : 0), 0);
    /**
     * Whether the footer (app.tsx Footer) shows all of `hints`: it lays out
     * the shell's own hints first, then takes whole page hints from the
     * start while they fit what is left, and drops the rest.
     */
    function shownWhole(hints: readonly (readonly [string, string])[], columns: number): boolean {
        const shell = cost([["1-9", "pages"], ["A", "admin"], ["?", "help"], ["q", "quit"]]);
        const room = columns - 2 - shell - 3;
        return hints.every((_, i) => cost(hints.slice(0, i + 1)) <= room);
    }
    const states = [
        { following: true, blocked: false }, { following: false, blocked: false }, { following: false, blocked: true },
        { following: true, blocked: false, failed: true }, { following: true, blocked: false, empty: true },
        { following: true, blocked: false, failed: true, empty: true }, { following: true, blocked: false, noEarlier: true },
    ];
    const keysOf = (hints: readonly (readonly [string, string])[]) => hints.map(([key]) => key);

    it("fit beside the shell's hints in the list, so the footer never drops one", () => {
        for (const columns of [50, 56, 80, 100, 120, 160]) {
            for (const state of states)
                expect(shownWhole(listHints(columns, state), columns), `${columns} ${JSON.stringify(state)}`).toBe(true);
        }
        expect(listHints(120, { following: false, blocked: false }).some(([key, label]) => key === "f" && label === "follow")).toBe(true);
        expect(keysOf(listHints(120, { following: true, blocked: true }))).not.toContain("f");
        expect(keysOf(listHints(160, { following: true, blocked: false }))).toContain("r");
        expect(keysOf(listHints(120, { following: true, blocked: false }))).toEqual(["enter", "f", "p t i u / m", "c", "L", "!"]);
        expect(keysOf(listHints(80, { following: true, blocked: false }))).toEqual(["enter", "f", "ptiu/", "L"]);
        // Paused, "f follow" is a column longer: L goes (the list's last line says "L loads ..." anyway).
        expect(keysOf(listHints(80, { following: false, blocked: false }))).toEqual(["enter", "f", "ptiu/"]);
    });

    it("offer only keys that do something: no f or L after a failed read, no enter without entries", () => {
        for (const columns of [80, 120, 160]) {
            const failed = keysOf(listHints(columns, { following: true, blocked: false, failed: true }));
            expect(failed).toContain("r");
            expect(failed).not.toContain("f");
            expect(failed).not.toContain("L");
            expect(keysOf(listHints(columns, { following: true, blocked: false, empty: true }))).not.toContain("enter");
        }
        expect(keysOf(listHints(80, { following: true, blocked: false, failed: true }))).toEqual(["enter", "r", "ptiu/"]);
        expect(keysOf(listHints(80, { following: true, blocked: false, empty: true }))).toEqual(["f", "ptiu/", "L"]);
        // Nothing earlier to load (the start was reached, or the list is full): no L.
        for (const columns of [80, 120, 160])
            expect(keysOf(listHints(columns, { following: true, blocked: false, noEarlier: true }))).not.toContain("L");
        expect(keysOf(listHints(120, { following: true, blocked: false, noEarlier: true }))).toEqual(["enter", "f", "p t i u / m", "c", "!", "r"]);
    });

    it("fit beside them in the entry detail too, keeping o and a when they apply", () => {
        for (const columns of [50, 56, 80, 100, 120, 160]) {
            for (const unit of [false, true]) {
                for (const missing of [false, true])
                    expect(shownWhole(detailHints(columns, unit, missing), columns), `${columns} ${unit} ${missing}`).toBe(true);
            }
        }
        // At 80 columns, with a unit and a value left out (a coredump, say), "a" is still offered.
        expect(keysOf(detailHints(80, true, true))).toEqual(["esc", "←→", "o", "a"]);
        expect(keysOf(detailHints(120, true, true))).toEqual(["esc", "↑↓", "←→", "o", "a", "!"]);
        expect(keysOf(detailHints(120, false, false))).toEqual(["esc", "↑↓", "←→", "!"]);
        expect(fitHints(20, [[["x", "a very long hint"]], [["y", "short"]]])).toEqual([["y", "short"]]);
    });
});

describe("indentation in the entry detail", () => {
    it("keeps a wrapped line under its own indentation", () => {
        expect(wrapIndented("  File \"/usr/lib/python3.9/site-packages/cockpit/transports.py\", line 98", 40)).toEqual([
            "  File",
            "  \"/usr/lib/python3.9/site-packages/cock",
            "  pit/transports.py\", line 98",
        ]);
        expect(wrapIndented("no indent here at all", 10)).toEqual(["no indent", "here at", "all"]);
        expect(wrapIndented("    ", 10)).toEqual([""]);
        expect(wrapIndented("", 10)).toEqual([""]);
        // Deeper than half the width: cut to half, so the text still has room.
        expect(wrapIndented(" ".repeat(30) + "deep", 20)).toEqual([" ".repeat(10) + "deep"]);
    });

    it("expands tabs to 8-column stops, as a terminal would", () => {
        expect(displayLine("\tat java.lang.Thread.run(Thread.java:829)")).toBe("        at java.lang.Thread.run(Thread.java:829)");
        expect(displayLine("ab\tc")).toBe("ab      c");
        expect(displayLine("\x1b[31mred\x1b[0m\there")).toBe("red     here");
        expect(displayLine("bell\x07\tx")).toBe("bell^G  x");
    });

    it("shows a traceback as a traceback", () => {
        const e = entry({
            MESSAGE: "Traceback (most recent call last):\n  File \"/usr/lib64/python3.9/asyncio/events.py\", line 80, in _run\n" +
                "    self._context.run(self._callback, *self._args)\nAssertionError\n",
        });
        const row: EntryRow = { kind: "entry", key: e.cursor, entry: e, count: 1, oldest: e, cursors: [e.cursor] };
        expect(detailLines(row, 80, { unit: null }).slice(0, 4).map(line => line.text)).toEqual([
            "Traceback (most recent call last):",
            "  File \"/usr/lib64/python3.9/asyncio/events.py\", line 80, in _run",
            "    self._context.run(self._callback, *self._args)",
            "AssertionError",
        ]);
    });
});

describe("banners", () => {
    it("take at most two lines, cutting the text short rather than the way out", () => {
        expect(bannerLines({ text: "Following stopped: Bad message", action: "(f tries again)" }, 60))
            .toEqual(["Following stopped: Bad message (f tries again)"]);
        const text = "Following stopped: Failed to get journal fd: Too many open files, and a message long enough to need three lines";
        const lines = bannerLines({ text, action: "(f tries again)" }, 40);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toBe("Following stopped: Failed to get journal");
        expect(lines[1]).toMatch(/^fd: Too many open f.*\u2026 \(f tries again\)$/);
        expect(lines.every(line => line.length <= 40)).toBe(true);
        // An action too long for a line of its own: the cut shows, at least.
        const long = bannerLines({ text: "No journal files were opened due to insufficient permissions.",
                                   action: "Members of the adm, wheel and systemd-journal groups can read the whole journal." }, 40);
        expect(long).toHaveLength(2);
        expect(long[1]!.endsWith("\u2026")).toBe(true);
        expect(bannerLines({ text: "short", action: null }, 40)).toEqual(["short"]);
    });
});

describe("list text", () => {
    it("marks further lines compactly where the message column is narrow", () => {
        expect(moreText(3)).toBe("[+3 lines]");
        expect(moreText(1)).toBe("[+1 line]");
        expect(moreText(25, true)).toBe("[+25]");
        expect(moreText(0, true)).toBe("");
    });

    it("counts the position in entries, repeats included", () => {
        const rows = buildRows([
            entry({ MESSAGE: "same" }), entry({ MESSAGE: "same" }), entry({ MESSAGE: "same" }), entry({ MESSAGE: "other" }),
        ]);
        expect(rows.map(r => r.kind)).toEqual(["day", "entry", "entry"]);
        const { before, total } = entryOrdinals(rows);
        expect(total).toBe(4);
        expect([...before]).toEqual([0, 0, 3]);
        expect((rows[1] as EntryRow).cursors).toHaveLength(3);
    });

    it("writes the position and the total alike, with thousands separators", () => {
        const n = (value: number) => value.toLocaleString();
        expect(positionText(20000, 20000)).toBe(`${n(20000)}/${n(20000)}`);
        expect(positionText(12, 279)).toBe("12/279");
    });
});

describe("without a UTF-8 locale", () => {
    it("writes only ASCII of its own: separators, rules, repeats and key hints", async () => {
        const saved = process.env.COCKPIT_TUI_ASCII;
        process.env.COCKPIT_TUI_ASCII = "1";
        vi.resetModules();
        try {
            // Fresh modules, so theme.ts reads the locale again.
            const model = await import("../../src/pages/logs/model.js");
            const { detailHints: hints } = await import("../../src/pages/logs/detail.js");
            const { listHints: list } = await import("../../src/pages/logs/index.js");
            const ascii = (text: string) => /^[\x20-\x7e]*$/.test(text);
            expect(Object.values(model.sym).every(ascii)).toBe(true);
            expect(model.repeatText(3)).toBe("x3");
            expect(model.ruleText("Reboot", 16)).toBe("-- Reboot ------");
            for (const columns of [80, 120, 160]) {
                for (const [key, label] of [...hints(columns, true, true), ...list(columns, { following: true, blocked: false })])
                    expect(ascii(key) && ascii(label)).toBe(true);
            }
        } finally {
            if (saved === undefined)
                delete process.env.COCKPIT_TUI_ASCII;
            else
                process.env.COCKPIT_TUI_ASCII = saved;
            vi.resetModules();
        }
    });
});

describe("the identifier scan", () => {
    it("passes the filter's arguments positionally, without the identifier, in a stoppable script", () => {
        const filter = { priority: "err" as const, since: "-24hours", identifier: "sshd", unit: { name: "a b.service" }, grep: "it's" };
        expect(identifierScanArgv(filter, { outputFields: true })).toEqual([
            "/bin/sh", "-c", SCAN_SCRIPT, "--",
            "-q", "--since=-24hours", "--priority=err", "--grep=it's", "--no-tail", "--output=cat", "--output-fields=SYSLOG_IDENTIFIER",
            "--", "_SYSTEMD_UNIT=a b.service", "+", "COREDUMP_UNIT=a b.service", "+", "UNIT=a b.service",
        ]);
        expect(identifierScanArgv({ priority: "debug", boot: "0" }, { outputFields: false })).toEqual([
            "/bin/sh", "-c", SCAN_SCRIPT_VERBOSE, "--", "-q", "--boot=0", "--priority=debug", "--no-tail", "--output=verbose", "--",
        ]);
        // The pipeline runs in the background so a TERM reaches it; no pipefail (dash has none).
        expect(SCAN_SCRIPT).toBe("trap 'kill $! 2>/dev/null; pkill -P $$ 2>/dev/null; exit 143' TERM\njournalctl \"$@\" | sort -u &\nwait $!");
        expect(SCAN_SCRIPT_VERBOSE).not.toContain("pipefail");
        expect(SCAN_SCRIPT_VERBOSE).toContain('sed -n "s/^    SYSLOG_IDENTIFIER=//p"');
    });

    // The bridge SIGTERMs only the shell it spawned. A journalctl whose --grep
    // matches nothing never writes, so it never meets the SIGPIPE that ends a
    // writing one once sort is gone: the script itself must stop it.
    const tools = ["/bin/sh", "/proc/self/stat"].every(path => existsSync(path)) &&
        spawnSync("/bin/sh", ["-c", "command -v pkill && command -v sort"], { stdio: "ignore" }).status === 0;
    it.skipIf(!tools)("stops every process of the pipeline on TERM, even a journalctl that writes nothing", async () => {
        const dir = mkdtempSync(join(tmpdir(), "logs-scan-"));
        const pidFile = join(dir, "pid");
        // A journalctl that reads for a long time and writes nothing.
        writeFileSync(join(dir, "journalctl"), `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`, { mode: 0o755 });
        /** Running, rather than gone or a zombie waiting to be reaped. */
        const running = (pid: number) => {
            try {
                return !/^[ZX]/.test(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!);
            } catch {
                return false;
            }
        };
        const until = async <T>(check: () => T | null, what: string): Promise<T> => {
            const deadline = Date.now() + 3000;
            for (;;) {
                const value = check();
                if (value !== null)
                    return value;
                if (Date.now() > deadline)
                    throw new Error(`timed out waiting for ${what}`);
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        };
        const shell = spawn("/bin/sh", ["-c", SCAN_SCRIPT, "--", "-q", "--grep=matches-nothing"], {
            env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}` },
            stdio: "ignore",
        });
        let pid = 0;
        try {
            pid = await until(() => {
                try {
                    return Number(readFileSync(pidFile, "utf8")) || null;
                } catch {
                    return null;
                }
            }, "the stand-in journalctl to start");
            expect(running(pid)).toBe(true);
            shell.kill("SIGTERM");
            await until(() => (running(pid) ? null : true), "the stand-in journalctl to be stopped");
        } finally {
            if (pid && running(pid))
                process.kill(pid, "SIGKILL");
            shell.kill("SIGKILL");
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
