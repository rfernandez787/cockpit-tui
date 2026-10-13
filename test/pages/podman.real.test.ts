/*
 * The Podman page's reads against a real cockpit-bridge and the user's own
 * podman service.
 *
 * Strictly read-only: GET info, the container and image lists, one
 * container's inspection, and the events and stats streams (opened, then
 * closed). Nothing is started, stopped, paused or deleted; the page is
 * rendered and never sent an action key. The system's service is not
 * touched (it needs administrative access, which these tests never ask for).
 *
 * Skips without a bridge, without podman, or when the user's podman.socket
 * is not already active -- the store would start it, and a test should not.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { localTransport, type StreamTransport } from "../../src/transport/stream.js";
import { initInfo } from "../../src/session.js";
import { connect, PodmanError, socketPath } from "../../src/pages/podman/rest.js";
import { containerActions, containerRows, containerSections, parseContainers, parseImages, stateText } from "../../src/pages/podman/model.js";
import { PodmanStore } from "../../src/pages/podman/store.js";
import PodmanPage from "../../src/pages/podman/index.js";
import { renderPage } from "../helpers/page.js";
import { cleanup } from "../helpers/ink.js";

const haveBridge = spawnSync("cockpit-bridge", ["--version"], { stdio: "ignore" }).status === 0;
const havePodman = spawnSync("podman", ["--version"], { stdio: "ignore" }).status === 0;
const socketActive = existsSync(`/run/user/${process.getuid?.() ?? 0}/podman/podman.sock`);

let active: StreamTransport | null = null;
const closers: (() => void)[] = [];

async function open(): Promise<void> {
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

async function openStore(): Promise<PodmanStore> {
    const store = new PodmanStore("user");
    closers.push(() => store.close());
    store.start();
    const deadline = Date.now() + 15_000;
    while (store.status === "loading") {
        if (Date.now() > deadline)
            throw new Error("podman did not answer");
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    return store;
}

describe.skipIf(!haveBridge || !havePodman || !socketActive)("podman against a real bridge", () => {
    it("finds the user's socket and reads podman's lists in the shapes the model expects", async () => {
        await open();
        expect(socketPath("user")).toBe(`/run/user/${process.getuid!()}/podman/podman.sock`);
        const connection = connect("user");
        closers.push(() => connection.close());
        const info = await connection.json("GET", "libpod/info") as { version?: { Version?: string } };
        expect(info.version?.Version).toMatch(/^\d+\.\d+/);

        const raw = await connection.json("GET", "libpod/containers/json", { all: true });
        const containers = parseContainers("user", raw);
        expect(containers).toHaveLength((raw as unknown[]).length);
        for (const container of containers) {
            expect(container.id).toMatch(/^[0-9a-f]{64}$/);
            expect(container.name).not.toBe("");
            expect(stateText(container)).not.toBe("Unknown");
            // Computed, never run.
            expect(containerActions(container).length).toBeGreaterThan(0);
        }
        const images = parseImages("user", await connection.json("GET", "libpod/images/json"));
        for (const image of images)
            expect(image.size).toBeGreaterThan(0);
        expect(containerRows(containers, "all", "").length).toBe(containers.length);
    }, 30_000);

    it("gets podman's own words for a failed call", async () => {
        await open();
        const connection = connect("user");
        closers.push(() => connection.close());
        const failure = await connection.json("GET", "libpod/containers/no-such-container-here/json").then(() => null, (error: unknown) => error);
        expect(failure).toBeInstanceOf(PodmanError);
        expect(failure).toMatchObject({ status: 404 });
        expect((failure as PodmanError).message).toMatch(/no container with name or ID/);
    }, 30_000);

    it("loads the store, inspects a container, and gets usage for running ones", async () => {
        await open();
        const store = await openStore();
        expect(store.status).toBe("ready");
        expect(store.podmanVersion).toMatch(/^\d+\.\d+/);
        const first = store.containers[0];
        if (!first)
            return;
        const inspect = await store.inspect(first.id);
        expect(containerSections(first, inspect, null, Date.now() / 1000).length).toBeGreaterThanOrEqual(2);
        if (!store.containers.some(c => c.state === "running"))
            return;
        const deadline = Date.now() + 15_000;
        while (store.stats.size === 0 && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 50));
        expect(store.stats.size).toBeGreaterThan(0);
    }, 40_000);

    it("renders the page", async () => {
        await open();
        const r = renderPage(PodmanPage, { columns: 120, rows: 40, allowed: false });
        const frame = await r.waitFor(/\[Containers\]\s+Images/, 15_000);
        expect(frame).toMatch(/\d+ containers?/);
    }, 30_000);
});
