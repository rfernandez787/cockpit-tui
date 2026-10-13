/*
 * The journal library against a real cockpit-bridge and journalctl.
 * Read-only: nothing is written to the journal. Skips without a bridge,
 * and tolerates an empty journal.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { localTransport, type StreamTransport } from "../../src/transport/stream.js";
import {
    capabilities, journalArgs, listBoots, listIdentifiers, streamJournal, type JournalEntry, type Outcome,
} from "../../src/lib/journal.js";

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
    active?.close();
    active = null;
});

function collect(argv: string[]): Promise<{ entries: JournalEntry[], outcome: Outcome }> {
    return new Promise(resolve => {
        const entries: JournalEntry[] = [];
        streamJournal(argv, batch => entries.push(...batch), outcome => resolve({ entries, outcome }), { batchMs: 10 });
    });
}

describe.skipIf(!haveBridge || !haveJournal)("journal library against a real bridge", () => {
    it("reads the capabilities", async () => {
        await connect();
        const caps = await capabilities();
        expect(caps.systemd).toBeGreaterThan(200);
    });

    it("pages entries newest-first with cursors that page without overlap", async () => {
        await connect();
        const first = await collect(journalArgs({ priority: "debug" }, { kind: "page", lines: 50 }));
        expect(first.outcome.kind === "ok" || first.outcome.kind === "empty").toBe(true);
        if (first.entries.length < 2)
            return; // an empty journal (container): nothing more to check
        for (const entry of first.entries) {
            expect(entry.cursor).toBeTruthy();
            expect(entry.time).toBeGreaterThan(0);
        }
        for (let i = 1; i < first.entries.length; i++)
            expect(first.entries[i]!.time).toBeLessThanOrEqual(first.entries[i - 1]!.time);

        const oldest = first.entries.at(-1)!;
        const next = await collect(journalArgs({ priority: "debug" }, { kind: "page", lines: 20, before: oldest.cursor }));
        const seen = new Set(first.entries.map(e => e.cursor));
        for (const entry of next.entries) {
            expect(seen.has(entry.cursor)).toBe(false);
            expect(entry.time).toBeLessThanOrEqual(oldest.time);
        }
    });

    it("fetches a single entry back by its cursor", async () => {
        await connect();
        const page = await collect(journalArgs({}, { kind: "page", lines: 1 }));
        if (!page.entries.length)
            return;
        const cursor = page.entries[0]!.cursor;
        const one = await collect(journalArgs({}, { kind: "entry", cursor, all: true }));
        expect(one.entries[0]?.cursor).toBe(cursor);
    });

    it("reports a bad timestamp as an error, not as an empty result", async () => {
        await connect();
        const result = await collect(journalArgs({ since: "garbage" }, { kind: "page", lines: 10 }));
        expect(result.outcome).toMatchObject({ kind: "error" });
        expect((result.outcome as { message: string }).message).toMatch(/timestamp/i);
    });

    it("reports a grep that matches nothing as empty", async () => {
        await connect();
        const caps = await capabilities();
        if (!caps.grep)
            return;
        const result = await collect(journalArgs({ grep: "zz-no-such-text-0f9a8b7c-zz" }, { kind: "page", lines: 10 }));
        expect(result.outcome).toEqual({ kind: "empty" });
    });

    it("lists boots and identifiers", async () => {
        await connect();
        const caps = await capabilities();
        const boots = await listBoots(caps);
        if (caps.bootsJson && boots.length)
            expect(boots[0]!.index).toBe(0);
        const identifiers = await listIdentifiers({ since: "-1hours" }, caps);
        for (const id of identifiers)
            expect(id).not.toMatch(/\n|^\s|\s$/);
    });

    it("follows from now on and stops cleanly when closed", async () => {
        await connect();
        let done: Outcome | null = null;
        const stream = streamJournal(journalArgs({}, { kind: "follow" }), () => {}, outcome => { done = outcome });
        await new Promise(resolve => setTimeout(resolve, 300));
        stream.close();
        await new Promise(resolve => setTimeout(resolve, 100));
        // Closing is our doing: no outcome is reported after close().
        expect(done).toBeNull();
    });
});
