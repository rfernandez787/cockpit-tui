/*
 * The Storage page's reads against a real cockpit-bridge and UDisks2.
 *
 * Strictly read-only: GetManagedObjects, one match rule, the bridge's mount
 * metrics, and CanFormat (which only asks whether a mkfs tool is installed).
 * Nothing is mounted, unmounted, unlocked, locked or formatted; the page is
 * rendered with limited access and is never sent an action key. The lvm2
 * module is only asked for by the store when UDisks2 has not loaded it,
 * which is what opening the page in Cockpit does as well.
 *
 * Skips without a bridge or without UDisks2 on the system bus.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { localTransport, type StreamTransport } from "../../src/transport/stream.js";
import { initInfo } from "../../src/session.js";
import { buildRows, decodeFilename, detailSections, formatCandidates, I, MANAGER_PATH, rowActions } from "../../src/pages/storage/model.js";
import { StorageStore } from "../../src/pages/storage/store.js";
import { usableFormats } from "../../src/pages/storage/actions.js";
import StoragePage from "../../src/pages/storage/index.js";
import { renderPage } from "../helpers/page.js";
import { cleanup } from "../helpers/ink.js";

const haveBridge = spawnSync("cockpit-bridge", ["--version"], { stdio: "ignore" }).status === 0;
const haveUdisks = spawnSync("busctl", ["--system", "status", "org.freedesktop.UDisks2"], { stdio: "ignore" }).status === 0;

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

async function openStore(): Promise<StorageStore> {
    const store = new StorageStore();
    closers.push(() => store.close());
    store.start();
    const deadline = Date.now() + 15_000;
    while (store.status === "loading") {
        if (Date.now() > deadline)
            throw new Error("the storage devices did not load");
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    return store;
}

describe.skipIf(!haveBridge || !haveUdisks)("storage against a real bridge", () => {
    it("reads UDisks2's objects in the shapes the model expects", async () => {
        await connect();
        const store = await openStore();
        expect(store.status).toBe("ready");
        expect(store.udisksVersion).toMatch(/^\d+\.\d+/);
        expect(store.objects.get(MANAGER_PATH)?.[I.manager]).toBeDefined();

        const blocks = [...store.objects.values()].map(interfaces => interfaces[I.block]).filter(Boolean);
        for (const block of blocks) {
            // 'ay' arrives as base64 with a trailing NUL: decoded, it is a device node.
            expect(decodeFilename(block!.Device)).toMatch(/^\/dev\/[\x21-\x7e]+$/);
            expect(typeof block!.Size).toBe("number");
            expect(Array.isArray(block!.Configuration)).toBe(true);
        }
    }, 30_000);

    it("builds a tree in which every block device has one row at most, and details for each", async () => {
        await connect();
        const store = await openStore();
        const rows = buildRows(store.objects);
        const ids = rows.map(row => row.id);
        expect(new Set(ids).size).toBe(ids.length);
        const withBlock = rows.filter(row => row.block).map(row => row.block);
        expect(new Set(withBlock).size).toBe(withBlock.length);
        for (const row of rows) {
            expect(row.name).not.toBe("");
            expect(row.contentText).not.toBe("");
            expect(row.lasts.length).toBe(row.depth);
            expect(detailSections(store.objects, row, null).length).toBeGreaterThan(0);
            // Computed, never run.
            expect(Array.isArray(rowActions(store.objects, row))).toBe(true);
        }
        // Whatever is mounted is on some row.
        const mounted = rows.flatMap(row => row.mountPoints);
        for (const dir of mounted)
            expect(dir.startsWith("/")).toBe(true);
    }, 30_000);

    it("gets usage for mounted filesystems from the bridge's metrics", async () => {
        await connect();
        const store = await openStore();
        const mounted = buildRows(store.objects).flatMap(row => row.mountPoints);
        if (!mounted.length)
            return;
        const deadline = Date.now() + 10_000;
        while (store.usage.size === 0 && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 50));
        expect(store.usage.size).toBeGreaterThan(0);
        for (const { used, total } of store.usage.values())
            expect(used).toBeLessThanOrEqual(total);
    }, 30_000);

    it("asks which filesystems can be made", async () => {
        await connect();
        const store = await openStore();
        const candidates = formatCandidates(store.objects).map(type => type.value);
        const usable = await usableFormats(candidates);
        for (const type of usable)
            expect(candidates).toContain(type);
    }, 30_000);

    it("renders the page with limited access", async () => {
        await connect();
        const r = renderPage(StoragePage, { columns: 120, rows: 40, allowed: false });
        const frame = await r.waitFor(/Name\s+Device\s+Content/, 15_000);
        expect(frame).not.toContain("failed");
    }, 30_000);
});
