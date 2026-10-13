/*
 * The Logs page's queries against a real cockpit-bridge and journalctl.
 *
 * Read-only: nothing here writes to the journal or changes the system. It
 * skips without a bridge, and tolerates an empty journal (a container), so
 * every check that needs entries returns early when there are none. The
 * argv shapes covered are the ones lib/journal.real.test.ts does not:
 * load-earlier within and past the range, --until=<since> for an empty
 * range, --boot=0, the unit and identifier filters together, the
 * identifier picker's stoppable scan (it only kills its own processes),
 * and the journalctl argument checks the dialogs rely on.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import cockpit from "../../src/cockpit.js";
import { localTransport, type StreamTransport } from "../../src/transport/stream.js";
import {
    capabilities, entryUnit, journalArgs, listBoots, listIdentifiers, streamJournal,
    type JournalEntry, type JournalFilter, type Outcome,
} from "../../src/lib/journal.js";
import { DEFAULT_FILTER, earlierFilter, earlierQuery, journalFilter } from "../../src/pages/logs/model.js";
import { SINCE_AFTER_UNTIL, checkArguments } from "../../src/pages/logs/journal-view.js";
import { scanIdentifiers, type ScanResult } from "../../src/pages/logs/identifiers.js";
import LogsPage from "../../src/pages/logs/index.js";
import { renderPage } from "../helpers/page.js";
import { cleanup, keys } from "../helpers/ink.js";

const haveBridge = spawnSync("cockpit-bridge", ["--version"], { stdio: "ignore" }).status === 0;
const haveJournal = spawnSync("journalctl", ["--version"], { stdio: "ignore" }).status === 0;

let active: StreamTransport | null = null;

async function connect(): Promise<void> {
    const transport = localTransport({ onStderr: () => {} });
    transport.install();
    active = transport;
    await transport.connect();
}

afterEach(() => {
    cleanup();
    active?.close();
    active = null;
});

function collect(argv: string[]): Promise<{ entries: JournalEntry[], outcome: Outcome }> {
    return new Promise(resolve => {
        const entries: JournalEntry[] = [];
        streamJournal(argv, batch => entries.push(...batch), outcome => resolve({ entries, outcome }), { batchMs: 10 });
    });
}

const usable = (outcome: Outcome) => outcome.kind === "ok" || outcome.kind === "empty";

describe.skipIf(!haveBridge || !haveJournal)("the Logs page's queries against a real bridge", () => {
    const filter: JournalFilter = { ...journalFilter(DEFAULT_FILTER), priority: "debug" };

    it("pages within the time range, then past it, without overlap", async () => {
        await connect();
        const first = await collect(journalArgs(filter, { kind: "page", lines: 30 }));
        expect(usable(first.outcome)).toBe(true);
        if (first.entries.length === 0)
            return;
        const oldest = first.entries.at(-1)!;
        const withinQuery = earlierQuery(filter, oldest, false, 31)!;
        const pastQuery = earlierQuery(filter, oldest, true, 30)!;
        expect(withinQuery.within).toBe(true);
        expect(pastQuery.within).toBe(false);
        const within = await collect(withinQuery.argv);
        const past = await collect(pastQuery.argv);
        expect(within.outcome).not.toMatchObject({ kind: "error" });
        expect(usable(within.outcome)).toBe(true);
        expect(usable(past.outcome)).toBe(true);
        // The exact --until is inclusive: the oldest entry comes back first, once.
        expect(within.entries[0]?.cursor).toBe(oldest.cursor);
        within.entries.shift();
        const seen = new Set(first.entries.map(e => e.cursor));
        for (const entry of [...within.entries, ...past.entries]) {
            expect(seen.has(entry.cursor)).toBe(false);
            expect(entry.time).toBeLessThanOrEqual(oldest.time);
        }
        // Past the range continues where the range stops: it starts with the same entries.
        const n = Math.min(within.entries.length, past.entries.length);
        expect(past.entries.slice(0, n).map(e => e.cursor)).toEqual(within.entries.slice(0, n).map(e => e.cursor));
    });

    it("reads entries from before a range with --until=<its since>", async () => {
        await connect();
        const before = earlierFilter(journalFilter(DEFAULT_FILTER), false)!;
        expect(before.until).toBe("-24hours");
        const result = await collect(journalArgs({ ...before, priority: "debug" }, { kind: "page", lines: 20 }));
        expect(usable(result.outcome)).toBe(true);
        const limit = Date.now() - 24 * 3600 * 1000 + 60_000; // a minute of slack for the clock
        for (const entry of result.entries)
            expect(entry.time).toBeLessThan(limit);
    });

    it("limits the current boot with --boot=0", async () => {
        await connect();
        const caps = await capabilities();
        const boots = await listBoots(caps);
        const result = await collect(journalArgs({ priority: "debug", boot: "0" }, { kind: "page", lines: 20 }));
        expect(usable(result.outcome)).toBe(true);
        const current = boots.find(boot => boot.index === 0);
        if (!current)
            return; // no --list-boots JSON here (systemd < 251)
        for (const entry of result.entries)
            expect(entry.bootId).toBe(current.id);
    });

    it("follows only entries newer than the newest shown", async () => {
        await connect();
        const page = await collect(journalArgs(filter, { kind: "page", lines: 1 }));
        const newest = page.entries[0];
        if (!newest)
            return;
        const got: JournalEntry[] = [];
        let done: Outcome | null = null;
        const stream = streamJournal(journalArgs(filter, { kind: "follow", after: newest.cursor }),
                                     batch => got.push(...batch), outcome => { done = outcome }, { batchMs: 10 });
        await new Promise(resolve => setTimeout(resolve, 400));
        stream.close();
        expect(done).toBeNull();
        for (const entry of got) {
            expect(entry.cursor).not.toBe(newest.cursor);
            expect(entry.time).toBeGreaterThanOrEqual(newest.time);
        }
    });

    it("filters by a unit and an identifier together", async () => {
        await connect();
        const page = await collect(journalArgs({ priority: "debug", since: "-24hours" }, { kind: "page", lines: 200 }));
        const sample = page.entries.find(e => entryUnit(e) && !entryUnit(e)!.user && typeof e.fields.SYSLOG_IDENTIFIER === "string");
        if (!sample)
            return;
        const unit = entryUnit(sample)!;
        const identifier = sample.fields.SYSLOG_IDENTIFIER as string;
        const result = await collect(journalArgs({ priority: "debug", since: "-24hours", unit, identifier }, { kind: "page", lines: 50 }));
        expect(usable(result.outcome)).toBe(true);
        expect(result.entries.map(e => e.cursor)).toContain(sample.cursor);
        for (const entry of result.entries) {
            expect(entry.fields.SYSLOG_IDENTIFIER).toBe(identifier);
            const f = entry.fields;
            expect([f._SYSTEMD_UNIT, f.UNIT, f.COREDUMP_UNIT]).toContain(unit.name);
        }
    });

    it("lists the identifiers of the entries the page shows", async () => {
        await connect();
        const caps = await capabilities();
        const page = await collect(journalArgs(filter, { kind: "page", lines: 20 }));
        if (page.entries.length === 0)
            return;
        const names = new Set(await listIdentifiers(filter, caps));
        for (const entry of page.entries) {
            if (typeof entry.fields.SYSLOG_IDENTIFIER === "string")
                expect(names.has(entry.fields.SYSLOG_IDENTIFIER)).toBe(true);
        }
    });

    it("scans identifiers with the stoppable script, finding what listIdentifiers() finds", async () => {
        await connect();
        const caps = await capabilities();
        const expected = await listIdentifiers(filter, caps);
        const result = await new Promise<ScanResult>(resolve => scanIdentifiers(filter, caps, "host", resolve));
        expect(result.error).toBeNull();
        expect(result.names).toEqual(expected);
    });

    // Also with a --grep that matches nothing: that journalctl reads the whole
    // range and never writes, so no SIGPIPE would ever stop it.
    it.each([
        ["", false],
        [" that writes nothing", true],
    ])("stops a scan%s, journalctl included, when it is closed", async (_what, grep) => {
        await connect();
        const caps = await capabilities();
        if (grep && !caps.grep)
            return;
        // A since that reads the whole journal and marks our processes: "@1.NNNNNN" is 1970.
        const marker = `--since=@1.${String((process.pid + (grep ? 1 : 0)) % 1_000_000).padStart(6, "0")}`;
        const scanFilter: JournalFilter = {
            priority: "debug", since: marker.slice("--since=".length), ...(grep ? { grep: "zzzz-matches-nothing-q7x" } : {}),
        };
        const alive = () => spawnSync("pgrep", ["-f", "--", marker], { stdio: "ignore" }).status === 0;

        // How long an uninterrupted scan takes here.
        const started = Date.now();
        await new Promise<void>(resolve => scanIdentifiers(scanFilter, caps, "host", () => resolve()));
        const full = Date.now() - started;
        if (full < 300)
            return; // too small a journal to tell a stopped scan from a finished one

        const scan = scanIdentifiers(scanFilter, caps, "host", () => { throw new Error("a closed scan reported") });
        const deadline = Date.now() + full / 2;
        while (!alive() && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 10));
        expect(alive()).toBe(true);
        scan.close();
        const closed = Date.now();
        while (alive() && Date.now() - closed < 2 * full)
            await new Promise(resolve => setTimeout(resolve, 20));
        expect(alive()).toBe(false);
        // Gone well before a scan left running would have finished.
        expect(Date.now() - closed).toBeLessThan(full / 2);
    });

    it("has journalctl check times and patterns without reading anything", async () => {
        await connect();
        const caps = await capabilities();
        expect(await checkArguments(["--since=yesterday", "--until=today"], "host")).toBeNull();
        expect(await checkArguments(["--since=-24hours"], "host")).toBeNull();
        expect(await checkArguments(["--since=garbage"], "host")).toMatch(/Failed to parse timestamp: garbage/);
        expect(await checkArguments(["--since=today", "--until=yesterday"], "host")).toMatch(/--since= must be before --until=/);
        // What "load earlier" meets once a relative start has moved past the oldest entry shown.
        expect(await checkArguments(["--since=-1hours", "--until=-2hours"], "host")).toMatch(SINCE_AFTER_UNTIL);
        if (!caps.grep)
            return;
        expect(await checkArguments(["--grep=fail(ed|ure)"], "host")).toBeNull();
        expect(await checkArguments(["--grep=("], "host")).toMatch(/pattern/i);
    });

    it("renders the page and an entry from the real journal", async () => {
        await connect();
        await cockpit.init();
        const r = renderPage(LogsPage, { columns: 120, rows: 30, hostname: "real" });
        const frame = await r.waitFor(f => /TIME\s+PRIO|No entries match|journalctl/.test(f), 10_000);
        if (!frame.includes("TIME"))
            return;
        expect(frame.split("\n")[0]).toContain("Error and above · Last 24 hours");
        await r.press(keys.enter);
        await r.waitFor("Entry at ");
        await r.waitFor(/Fields \(\d+\)/);
        await r.press(keys.escape);
        await r.waitFor("TIME");
    });
});
