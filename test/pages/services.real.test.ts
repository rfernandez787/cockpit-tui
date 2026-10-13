/*
 * The Services page's calls against a real cockpit-bridge and systemd.
 *
 * Strictly read-only: listing, Properties.Get/GetAll, LoadUnit (which only
 * loads a unit's configuration into systemd's memory, as opening a unit in
 * Cockpit does; systemd unloads it again by itself), Subscribe (which asks
 * for signals on our own bus connection), the clocks script and journal
 * reads. Nothing here starts, stops, enables, masks or reloads anything, and
 * the page is never sent an action key.
 *
 * Skips without a bridge or without systemd, and avoids assuming any
 * particular unit exists: the subjects are found in the host's own lists.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import cockpit from "../../src/cockpit.js";
import { localTransport, type StreamTransport } from "../../src/transport/stream.js";
import { runFull } from "../../src/tui/hooks.js";
import { journalArgs, streamJournal, type JournalEntry, type Outcome } from "../../src/lib/journal.js";
import {
    alreadySubscribed, callManager, CLOCKS_ARGV, getAll, parseFileRows, parseUnitRows, UnitStore,
    MANAGER, PROPERTIES, SYSTEMD, TIMER, UNIT,
} from "../../src/pages/services/store.js";
import { buildRows, exactPattern, idFromPath, isTemplate, nextRun, parseUnitDetails, unitType } from "../../src/pages/services/model.js";
import ServicesPage from "../../src/pages/services/index.js";
import { unitJournalArgs } from "../../src/pages/services/logs.js";
import { initInfo } from "../../src/session.js";
import { renderPage } from "../helpers/page.js";
import { cleanup, keys } from "../helpers/ink.js";

const haveBridge = spawnSync("cockpit-bridge", ["--version"], { stdio: "ignore" }).status === 0;
const haveSystemd = spawnSync("systemctl", ["--version"], { stdio: "ignore" }).status === 0;

let active: StreamTransport | null = null;
const closers: (() => void)[] = [];

async function connect(): Promise<void> {
    const transport = localTransport({ onStderr: () => {} });
    transport.install();
    active = transport;
    await transport.connect();
    await initInfo();
}

afterEach(() => {
    cleanup();
    for (const close of closers.splice(0))
        close();
    active?.close();
    active = null;
});

function systemClient(): cockpit.DBusClient {
    const client = cockpit.dbus(SYSTEMD, { bus: "system", superuser: "try" });
    closers.push(() => client.close());
    return client;
}

async function openStore(owner: "system" | "user"): Promise<UnitStore> {
    const store = new UnitStore(owner);
    closers.push(() => store.close());
    store.start();
    const deadline = Date.now() + 15_000;
    while (store.status === "loading") {
        if (Date.now() > deadline)
            throw new Error("the unit list did not load");
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    return store;
}

/** A call's out-args and the reply's signature (the library hands it to then() as a second argument). */
function callTyped(client: cockpit.DBusClient, method: string, args: unknown[] = [], type?: string): Promise<{ reply: unknown[], type: string }> {
    return new Promise((resolve, reject) => {
        (client.call(MANAGER_PATH, MANAGER, method, args, type ? { type } : undefined) as unknown as {
            then(ok: (reply: unknown[], options: { type?: string }) => void, fail: (error: unknown) => void): void,
        }).then((reply, options) => resolve({ reply, type: options?.type ?? "" }), reject);
    });
}

const MANAGER_PATH = "/org/freedesktop/systemd1";

describe.skipIf(!haveBridge || !haveSystemd)("the Services page against a real bridge and systemd", () => {
    it("lists units and unit files in the shapes it parses", async () => {
        await connect();
        const client = systemClient();
        const units = await callTyped(client, "ListUnits");
        const files = await callTyped(client, "ListUnitFiles");
        expect(units.type).toBe("a(ssssssouso)");
        expect(files.type).toBe("a(ss)");

        const rows = parseUnitRows(units.reply[0]);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBe((units.reply[0] as unknown[]).length);
        for (const unit of rows) {
            // The object path is the unit's escaped name: what the store relies on to probe unknown paths.
            expect(idFromPath(unit.path)).toBe(unit.id);
        }
        const fileRows = parseFileRows(files.reply[0]);
        expect(fileRows.length).toBe((files.reply[0] as unknown[]).length);
        expect(fileRows.every(([path]) => path.startsWith("/"))).toBe(true);
    });

    it("keeps a store of the handled types, merged the way upstream does", async () => {
        await connect();
        const store = await openStore("system");
        expect(store.status).toBe("ready");
        expect(store.units.size).toBeGreaterThan(0);
        for (const unit of store.units.values())
            expect(unitType(unit.id)).not.toBeNull();
        for (const id of store.files!.keys()) {
            expect(unitType(id)).not.toBeNull();
            expect(isTemplate(id)).toBe(false);
        }
        const services = buildRows({ units: store.units.values(), files: store.files, type: "service" });
        expect(services.length).toBeGreaterThan(0);
        expect(new Set(services.map(r => r.id)).size).toBe(services.length);
        expect(services.some(r => r.loadState === "not-found")).toBe(false);
        // Failed rows sort first.
        const firstOk = services.findIndex(r => !r.hasFailed);
        expect(services.slice(firstOk).some(r => r.hasFailed)).toBe(false);
    });

    it("probes loaded units by exact pattern, which loads nothing", async () => {
        await connect();
        const client = systemClient();
        const [listed] = await callManager(client, "ListUnits", []);
        const loaded = parseUnitRows(listed).filter(u => unitType(u.id) && u.loadState === "loaded").slice(0, 3);
        expect(loaded.length).toBeGreaterThan(0);
        const absent = "cockpit-tui-no-such-unit-[x].service";
        const [rows] = await callManager(client, "ListUnitsByPatterns",
            [[], [...loaded.map(u => exactPattern(u.id)), exactPattern(absent)]], "asas");
        const found = parseUnitRows(rows);
        expect(found.map(u => u.id).sort()).toEqual(loaded.map(u => u.id).sort());
        for (const unit of found)
            expect(unit.path).toBe(loaded.find(u => u.id === unit.id)!.path);
    });

    it("tolerates a second Subscribe on the same connection", async () => {
        await connect();
        const client = systemClient();
        for (let i = 0; i < 2; i++) {
            try {
                await callManager(client, "Subscribe", []);
            } catch (error) {
                expect(alreadySubscribed(error)).toBe(true);
            }
        }
    });

    it("reads a unit's details, and opens an alias as its unit", async () => {
        await connect();
        const client = systemClient();
        const [listed] = await callManager(client, "ListUnits", []);
        const service = parseUnitRows(listed).find(u => u.id.endsWith(".service") && u.loadState === "loaded" && u.activeState === "active");
        expect(service).toBeDefined();
        const [path] = await callManager(client, "LoadUnit", [service!.id], "s");
        expect(path).toBe(service!.path);
        const unit = parseUnitDetails(await getAll(client, service!.path, UNIT),
                                      await getAll(client, service!.path, "org.freedesktop.systemd1.Service"), "service");
        expect(unit.id).toBe(service!.id);
        expect(unit.names[0]).toBe(service!.id);
        expect(unit.loadState).toBe("loaded");
        expect(unit.activeEnter).toBeGreaterThan(0);
        expect(unit.loadError).toBeNull();
        expect(unit.mainPid === null || unit.mainPid >= 0).toBe(true);
        // MemoryCurrent: a number of bytes, or hidden (UINT64_MAX when accounting is off).
        expect(unit.memory === null || unit.memory > 0).toBe(true);
        const [memory] = await Promise.resolve(client.call(service!.path, PROPERTIES, "Get",
            ["org.freedesktop.systemd1.Service", "MemoryCurrent"], { type: "ss" }));
        expect((memory as { t: string }).t).toBe("t");

        // An alias (only in ListUnitFiles) resolves to its unit: Names[0] is the primary name.
        const [fileRows] = await callManager(client, "ListUnitFiles", []);
        // Not a template's alias (autovt@.service): LoadUnit refuses a name without its instance.
        const alias = parseFileRows(fileRows).find(([p, state]) =>
            state === "alias" && p.endsWith(".service") && !isTemplate(p.slice(p.lastIndexOf("/") + 1)));
        if (alias) {
            const name = alias[0].slice(alias[0].lastIndexOf("/") + 1);
            const [aliasPath] = await callManager(client, "LoadUnit", [name], "s");
            const props = parseUnitDetails(await getAll(client, aliasPath as string, UNIT), null, "service");
            if (props.loadState === "loaded") {
                expect(props.names[0]).toBe(props.id);
                expect(props.names).toContain(name);
            }
        }
    });

    it("reads a timer's schedule, and dates monotonic timers from the host's clocks", async () => {
        await connect();
        const client = systemClient();
        const [listed] = await callManager(client, "ListUnits", []);
        const timer = parseUnitRows(listed).find(u => u.id.endsWith(".timer") && u.loadState === "loaded" && u.activeState === "active");
        if (!timer)
            return;
        const { stdout } = await runFull(CLOCKS_ARGV, { err: "message" });
        const [realtime, monotonic] = stdout.trim().split(/\s+/).map(Number);
        expect(Number.isSafeInteger(realtime)).toBe(true);
        expect(Number.isSafeInteger(monotonic)).toBe(true);
        expect(Math.abs(realtime! / 1000 - Date.now())).toBeLessThan(60_000);

        const unit = parseUnitDetails(await getAll(client, timer.path, UNIT), await getAll(client, timer.path, TIMER), "timer");
        expect(unit.timer).not.toBeNull();
        expect(unit.timer!.unit).toMatch(/\./);
        expect(unit.timer!.schedule.length).toBeGreaterThan(0);
        const next = nextRun(unit.timer!, realtime! - monotonic!);
        // A waiting timer has a next run, within a year of now; while elapsing it may briefly have none.
        if (next !== null)
            expect(Math.abs(next - Date.now())).toBeLessThan(366 * 86400_000);
    });

    it("reads a unit that does not exist as not-found, with systemd's reason", async () => {
        await connect();
        const client = systemClient();
        const name = "cockpit-tui-test-no-such-unit.service";
        const [path] = await callManager(client, "LoadUnit", [name], "s");
        const unit = parseUnitDetails(await getAll(client, path as string, UNIT), null, "service");
        expect(unit.loadState).toBe("not-found");
        expect(unit.loadError?.[0]).toBe("org.freedesktop.systemd1.NoSuchUnit");
        expect(unit.loadError?.[1]).toContain(name);
    });

    it("refuses superuser \"require\" without administrative access", async () => {
        await connect();
        if (cockpit.info.user?.uid === 0)
            return;
        const client = cockpit.dbus(SYSTEMD, { bus: "system", superuser: "require" });
        closers.push(() => client.close());
        await expect(Promise.resolve(client.call(MANAGER_PATH, PROPERTIES, "Get", [MANAGER, "Version"], { type: "ss" })))
            .rejects.toMatchObject({ problem: "access-denied" });
    });

    it("reads the user's own manager on the session bus, when there is one", async () => {
        await connect();
        const probe = cockpit.dbus(SYSTEMD, { bus: "session" });
        closers.push(() => probe.close());
        try {
            await Promise.resolve(probe.call(MANAGER_PATH, PROPERTIES, "Get", [MANAGER, "Version"], { type: "ss" }));
        } catch {
            return; // no session bus here (a login without a user session)
        }
        const store = await openStore("user");
        expect(store.status).toBe("ready");
        expect(store.units.size).toBeGreaterThan(0);
    });

    it("reads a unit's journal with upstream's match, newest first", async () => {
        await connect();
        const entries = await new Promise<{ entries: JournalEntry[], outcome: Outcome }>(resolve => {
            const got: JournalEntry[] = [];
            streamJournal(journalArgs({ unit: { name: "systemd-journald.service" } }, { kind: "page", lines: 10 }),
                          batch => got.push(...batch), outcome => resolve({ entries: got, outcome }), { batchMs: 10 });
        });
        expect(["ok", "empty"]).toContain(entries.outcome.kind);
        expect(entries.entries.length).toBeLessThanOrEqual(10);
        for (let i = 1; i < entries.entries.length; i++)
            expect(entries.entries[i]!.time).toBeLessThanOrEqual(entries.entries[i - 1]!.time);
    });

    it("reads a user unit's journal for this user only, though other users run units of that name", async () => {
        await connect();
        const uid = cockpit.info.user!.uid;
        // dbus-broker.service runs in every user manager, gdm's included, where there is one.
        const entries = await new Promise<JournalEntry[]>(resolve => {
            const got: JournalEntry[] = [];
            streamJournal(unitJournalArgs({ name: "dbus-broker.service", user: true }, { kind: "page", lines: 50 }, uid),
                          batch => got.push(...batch), () => resolve(got), { batchMs: 10 });
        });
        for (const entry of entries)
            expect([entry.fields._UID, entry.fields.COREDUMP_UID]).toContain(String(uid));
    });

    it("renders the real list and a unit's details (view only)", async () => {
        await connect();
        const r = renderPage(ServicesPage, { columns: 120, rows: 36, allowed: false });
        let frame = await r.waitFor(/\d+ services/, 15_000);
        expect(frame).toContain("[Services");
        await r.press(keys.enter);
        frame = await r.waitFor(f => f.includes("Status") && f.includes("Recent logs"), 10_000);
        expect(frame).toMatch(/Actions +none without administrative access|Status +! Read-only/);
        await r.press(keys.escape);
        await r.waitFor(/\d+ services/);
        // The Timers tab, with its schedule columns.
        await r.press(keys.right, keys.right, keys.right);
        frame = await r.waitFor(f => f.includes("[Timers") && /\d+ timers?/.test(f), 10_000);
        expect(frame).toContain("Next run");
    });
});
