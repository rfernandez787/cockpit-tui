/*
 * The Networking page's reads against a real cockpit-bridge and
 * NetworkManager.
 *
 * Strictly read-only: GetManagedObjects, each connection's GetSettings
 * (which never includes secrets), the match rules, the traffic metrics,
 * systemd's view of firewalld's unit and firewalld's zone queries. No
 * interface is switched, no connection updated, no checkpoint created (an
 * expired one would roll the device back and reconnect it), and the firewall
 * is not touched. The page is rendered with limited access and never sent an
 * action key.
 *
 * Skips without a bridge or without NetworkManager on the system bus.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { localTransport, type StreamTransport } from "../../src/transport/stream.js";
import { initInfo } from "../../src/session.js";
import { buildInterfaces, ifaceActions, ifaceSections, mainConnection } from "../../src/pages/networking/model.js";
import { NetworkStore } from "../../src/pages/networking/store.js";
import NetworkingPage from "../../src/pages/networking/index.js";
import { renderPage } from "../helpers/page.js";
import { cleanup } from "../helpers/ink.js";

const haveBridge = spawnSync("cockpit-bridge", ["--version"], { stdio: "ignore" }).status === 0;
const haveNm = spawnSync("busctl", ["--system", "status", "org.freedesktop.NetworkManager"], { stdio: "ignore" }).status === 0;

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

async function openStore(): Promise<NetworkStore> {
    const store = new NetworkStore({ trafficMs: 1000 });
    closers.push(() => store.close());
    store.start();
    const deadline = Date.now() + 15_000;
    while (store.status === "loading") {
        if (Date.now() > deadline)
            throw new Error("the network interfaces did not load");
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    return store;
}

describe.skipIf(!haveBridge || !haveNm)("networking against a real bridge", () => {
    it("reads NetworkManager's objects in the shapes the model expects", async () => {
        await connect();
        const store = await openStore();
        expect(store.status).toBe("ready");
        expect(store.nmVersion).toMatch(/^\d+\.\d+/);
        const lists = buildInterfaces(store.objects);
        const all = [...lists.managed, ...lists.unmanaged];
        expect(new Set(all.map(i => i.name)).size).toBe(all.length);
        for (const iface of all) {
            expect(iface.name).not.toBe("lo");
            expect(iface.typeLabel).not.toBe("");
            for (const address of [...iface.addresses4, ...iface.addresses6, ...iface.linkLocal6])
                expect(address).toMatch(/^[0-9a-f.:]+\/\d+$/i);
            for (const dns of iface.dns)
                expect(dns).toMatch(/^[0-9a-f.:]+$/i);
            expect(ifaceSections(iface, store.settings).length).toBeGreaterThan(0);
        }
    }, 30_000);

    it("reads each connection's settings, and finds the one an interface uses", async () => {
        await connect();
        const store = await openStore();
        const lists = buildInterfaces(store.objects);
        const withConnection = lists.managed.filter(iface => iface.connection?.settings);
        if (!withConnection.length)
            return;
        const deadline = Date.now() + 10_000;
        while (!withConnection.every(iface => store.settings.has(iface.connection!.settings!)) && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 50));
        for (const iface of withConnection) {
            const main = mainConnection(iface, store.settings);
            expect(main).toBe(iface.connection!.settings);
            expect(store.settings.get(main!)?.connection).toBeDefined();
            // Computed, never run.
            expect(Array.isArray(ifaceActions(iface, store.settings))).toBe(true);
        }
    }, 30_000);

    it("gets traffic per interface from the bridge's metrics, and the firewall's state from systemd", async () => {
        await connect();
        const store = await openStore();
        const deadline = Date.now() + 10_000;
        while (store.throughput.rx === null && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 50));
        expect(store.throughput.rx).not.toBeNull();
        expect(store.traffic.size).toBeGreaterThan(0);
        expect(store.throughput.times).toHaveLength(store.throughput.rxHistory.length);
        // Whatever it is, it was read: a host without firewalld says not installed.
        expect(typeof store.firewall.installed).toBe("boolean");
        if (store.firewall.active)
            expect(Array.isArray(store.firewall.zones)).toBe(true);
    }, 30_000);

    it("renders the page with limited access", async () => {
        await connect();
        const r = renderPage(NetworkingPage, { columns: 120, rows: 40, allowed: false });
        const frame = await r.waitFor(/Name\s+Type\s+IP address/, 15_000);
        expect(frame).toContain("Firewall");
    }, 30_000);
});
