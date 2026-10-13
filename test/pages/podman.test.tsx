/*
 * The Podman page against the mock bridge's HTTP channel: the lists, their
 * filters and details, following podman's events, the system's containers
 * with administrative access, a service that is not running, and every
 * action -- asserting the exact requests each one sends, and that none is
 * sent before its question is answered.
 */
import { describe, it, expect, afterEach } from "vitest";
import PodmanPage, { CONFIRM_ARM_MS } from "../../src/pages/podman/index.js";
import { renderPage, type RenderedPage } from "../helpers/page.js";
import { cleanup, keys } from "../helpers/ink.js";
import { startMock, type HttpRoute, type MockBridge, type MockScenario } from "../mock-bridge/harness.js";
import { initInfo } from "../../src/session.js";
import {
    BUILDER, CACHE, container, CONTAINERS, DB, event, EVENTS, image, IMAGES, scenario, SYSTEM_SOCK, systemRoutes, USER_SOCK,
    userRoutes, V, WEB,
} from "./podman.fixture.js";

let mock: MockBridge | null = null;

afterEach(() => {
    cleanup();
    mock?.close();
    mock = null;
});

async function start(s: MockScenario, options: { allowed?: boolean, columns?: number, rows?: number, showHints?: boolean, panels?: boolean } = {}): Promise<RenderedPage> {
    mock = await startMock(s);
    await initInfo();
    return renderPage(PodmanPage, {
        columns: options.columns ?? 130, rows: options.rows ?? 30, allowed: options.allowed ?? false,
        ...(options.showHints ? { showHints: true } : {}), ...(options.panels ? { panels: true } : {}),
    });
}

/** Every HTTP request sent, in order: "METHOD path" (and which socket, when not the user's). */
function requests(): string[] {
    return mock!.opened("http-stream2").map(open =>
        `${open.unix === USER_SOCK ? "" : `${String(open.unix)} `}${String(open.method)} ${String(open.path)}`);
}

/** The requests that change something. */
function changes(): string[] {
    return requests().filter(request => !/^(\S+ )?GET /.test(request));
}

async function select(r: RenderedPage, name: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
        if (r.lastFrame().split("\n").find(l => l.startsWith("›"))?.includes(name))
            return;
        await r.press(keys.down);
    }
    throw new Error(`no row ${name}:\n${r.lastFrame()}`);
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const squash = (frame: string) => frame.split("\n").map(l => l.replace(/\s+/g, " ").trim());
const id = (c: Record<string, unknown>) => c.Id as string;

/** A route that answers 204 and then makes podman's lists and events say what happened. */
function acting(list: unknown[], action: string, name: string): HttpRoute {
    return {
        status: 204,
        effects: [
            { http: { [USER_SOCK]: { [CONTAINERS]: { body: list } } } },
            { httpData: [USER_SOCK, EVENTS, event("container", action, name)] },
        ],
    };
}

describe("the lists", () => {
    it("shows the user's containers with their state, usage and ports", async () => {
        const r = await start(scenario(), { showHints: true });
        const frame = await r.waitFor("1.3%");
        const lines = squash(frame);
        expect(lines[0]).toBe("[Containers] Images");
        expect(lines[1]).toBe("4 containers · 1 running · the system's need administrative access (A)");
        expect(lines).toContain("› ✗ builder registry.example/builder:latest Exited (1)");
        expect(lines).toContain("● db registry.example/db:latest Paused 127.0.0.1:5432:5432/tcp");
        expect(lines).toContain("● web registry.example/web:latest Running 1.3% 12.4 MB 8081:80/tcp, 8443:8443/tcp");
        expect(lines).toContain("○ apps/cache registry.example/cache:latest Created");
        expect(frame).toMatch(/hints: enter details \| ←→ images \| l logs \| s start \| d delete \| f only running \| \/ search/);
    });

    it("reads the lists once, and follows events and stats on streams of the same service", async () => {
        const r = await start(scenario());
        await r.waitFor("1.3%");
        expect(requests().sort()).toEqual([
            `GET ${V}/containers/json?all=true`,
            `GET ${V}/containers/stats?stream=true&interval=5`,
            `GET ${V}/events`,
            `GET ${V}/images/json`,
            `GET ${V}/info`,
        ]);
        const open = mock!.opened("http-stream2")[0]!;
        expect(open).toMatchObject({ unix: USER_SOCK, binary: "raw" });
        expect(open.superuser).toBeUndefined();
    });

    it("offers what the selected container's state allows", async () => {
        const r = await start(scenario(), { showHints: true });
        await r.waitFor("1.3%");
        await select(r, "db");
        expect(r.lastFrame()).toMatch(/l logs \| p resume \| S stop \| d delete/);
        await select(r, "web");
        expect(r.lastFrame()).toMatch(/l logs \| S stop \| r restart \| p pause \| d delete/);
    });

    it("filters to the running ones and searches by name or image", async () => {
        const r = await start(scenario());
        await r.waitFor("1.3%");
        await r.press("f");
        await r.waitFor("only running");
        expect(squash(r.lastFrame())[1]).toBe("1 of 4 containers · 1 running · only running · the system's need administrative access (A)");
        expect(r.lastFrame()).not.toContain("builder");
        await r.press("f", "/", "cach");
        await r.waitFor("Search: cach");
        await r.press(keys.enter);
        await r.waitFor("/cach");
        expect(r.lastFrame()).toContain("apps/cache");
        expect(r.lastFrame()).not.toContain("builder");
        await r.press(keys.escape);
        await r.waitFor("builder");
    });

    it("lists images, with what uses them", async () => {
        const r = await start(scenario());
        await r.waitFor("1.3%");
        await r.press(keys.right);
        const frame = await r.waitFor("3 images");
        const lines = squash(frame);
        expect(lines[0]).toBe("Containers [Images]");
        expect(lines).toContain("› <none> 0123456789ab 3 months ago 250 MB unused");
        expect(lines).toContain("registry.example/web:latest 3 months ago 62.4 MB 1 container");
    });

    it("follows podman's events: a container that stops, one that appears", async () => {
        // "What happened on the host", set off through a scripted command.
        const happened = [container("web", { state: "exited" }), DB, BUILDER, CACHE, container("fresh")];
        const r = await start(scenario({}, {
            spawn: {
                happen: {
                    effects: [
                        { http: { [USER_SOCK]: { [CONTAINERS]: { body: happened } } } },
                        { httpData: [USER_SOCK, EVENTS, event("container", "died") + event("container", "create", "fresh") + event("container", "start", "fresh")] },
                    ],
                },
            },
        }));
        await r.waitFor("1.3%");
        const cockpit = (await import("../../src/cockpit.js")).default;
        await cockpit.spawn(["happen"]);
        const frame = await r.waitFor("fresh");
        expect(squash(frame)[1]).toContain("5 containers · 1 running");
        expect(squash(frame)).toContain("○ web registry.example/web:latest Exited");
        // One burst of events, one re-read of each list it touched.
        expect(requests().filter(request => request === `GET ${V}/containers/json?all=true`)).toHaveLength(2);
        expect(requests().filter(request => request === `GET ${V}/images/json`)).toHaveLength(2);
    });

    it("shows the system's containers too with administrative access, on root's socket", async () => {
        const s = scenario({}, { superuser: true } as Partial<MockScenario>);
        s.http![SYSTEM_SOCK] = systemRoutes();
        const r = await start(s, { allowed: true });
        const frame = await r.waitFor(f => f.includes("router") && f.includes("1.3%"));
        const lines = squash(frame);
        expect(lines[1]).toBe("5 containers · 2 running");
        expect(lines).toContain("● router registry.example/router:latest Running system 53:53/udp");
        expect(lines).toContain("● web registry.example/web:latest Running 1.3% 12.4 MB user 8081:80/tcp, 8443:8443/tcp");
        const system = mock!.opened("http-stream2").find(open => open.unix === SYSTEM_SOCK)!;
        expect(system.superuser).toBe("require");
    });

    it("uses the system socket as it is for a root session, with nothing to escalate", async () => {
        // The bridge runs as root (--host root@server): root's own containers are the system's.
        const info = {
            channels: { "http-stream2": [], stream: [] },
            os_release: { NAME: "Mock Linux", ID: "mock" },
            user: { fullname: "root", gid: 0, group: "root", groups: ["root"], home: "/root", name: "root", shell: "/bin/bash", uid: 0 },
        };
        mock = await startMock({
            info, http: { [SYSTEM_SOCK]: systemRoutes() },
            spawn: { [`podman logs --tail 500 ${"router-id".padEnd(64, "0")}`]: { stdout: "listening\n" } },
        } as MockScenario);
        await initInfo();
        const r = renderPage(PodmanPage, { columns: 130, rows: 30, allowed: true });
        const frame = await r.waitFor("router");
        expect(squash(frame)[1]).toBe("1 container · 1 running");
        const opens = mock.opened("http-stream2");
        expect(opens.every(open => open.unix === SYSTEM_SOCK && open.superuser === undefined)).toBe(true);
        await r.press("l");
        await r.waitFor("listening");
        const logs = mock.opened("stream")[0]!;
        expect(logs.superuser).toBeUndefined();
        expect(logs.environ).toBeUndefined();
    });

    it("goes back to the row that was left on the other tab", async () => {
        const r = await start(scenario());
        await r.waitFor("1.3%");
        await select(r, "web");
        await r.press(keys.right);
        await r.waitFor("3 images");
        await r.press(keys.down, keys.left);
        const back = await r.waitFor("4 containers");
        expect(back.split("\n").find(l => l.startsWith("›"))).toContain("web");
        await r.press(keys.right);
        const images = await r.waitFor("3 images");
        expect(images.split("\n").find(l => l.startsWith("›"))).toContain("registry.example/db");
    });

    it("does not touch the system's socket without administrative access", async () => {
        const s = scenario();
        s.http![SYSTEM_SOCK] = systemRoutes();
        const r = await start(s);
        await r.waitFor("1.3%");
        expect(mock!.opened("http-stream2").some(open => open.unix === SYSTEM_SOCK)).toBe(false);
        expect(r.lastFrame()).not.toContain("router");
    });

    it("starts podman.socket once when nothing answers, and says so when that does not help", async () => {
        const r = await start({ spawn: { "systemctl --user start podman.socket": {} } });
        await r.waitFor("Podman is not available (user: the podman service is not active (podman.socket)). Press Ctrl+R to try again.");
        const spawned = mock!.opened("stream").map(open => (open.spawn as string[]).join(" "));
        expect(spawned).toEqual(["systemctl --user start podman.socket"]);
    });

    it("comes up after starting the service", async () => {
        const r = await start({
            spawn: { "systemctl --user start podman.socket": { effects: [{ http: { [USER_SOCK]: userRoutes() } }] } },
        });
        await r.waitFor("4 containers");
    });

    it("keeps names when the terminal is narrow", async () => {
        const r = await start(scenario(), { columns: 60, rows: 20 });
        const frame = await r.waitFor("builder");
        expect(frame).toContain("Exited (1)");
        for (const line of frame.split("\n"))
            expect(line.length).toBeLessThanOrEqual(60);
    });
});

describe("details and logs", () => {
    it("shows a container's details, with its inspection, and goes back to its row", async () => {
        const r = await start(scenario());
        await r.waitFor("1.3%");
        await select(r, "web");
        await r.press(keys.enter);
        const frame = await r.waitFor("Restart policy");
        expect(frame).toMatch(/Image\s+registry\.example\/web:latest/);
        expect(frame).toMatch(/Command\s+nginx -g daemon off;/);
        expect(frame).toMatch(/Network\s+podman \(10\.88\.0\.5\)/);
        expect(frame).toMatch(/Variables\s+PATH, SECRET_TOKEN/);
        expect(frame).not.toContain("hunter2");
        expect(requests()).toContain(`GET ${V}/containers/${id(WEB)}/json`);
        await r.press(keys.escape);
        const back = await r.waitFor("[Containers]");
        expect(back.split("\n").find(l => l.startsWith("›"))).toContain("web");
    });

    it("reads a container's log with podman logs, control characters made visible", async () => {
        const r = await start(scenario({}, {
            spawn: { [`podman logs --tail 500 ${id(WEB)}`]: { stdout: "started\nGET / 200\n\x1b[31mred\x1b[0m alert\n" } },
        }));
        await r.waitFor("1.3%");
        await select(r, "web");
        await r.press("l");
        const frame = await r.waitFor("GET / 200");
        expect(frame).toContain("^[[31mred^[[0m alert");
        expect(r.lastRawFrame()).not.toContain("\x1b[31mred");
        const open = mock!.opened("stream")[0]!;
        expect(open.spawn).toEqual(["podman", "logs", "--tail", "500", id(WEB)]);
        expect(open.err).toBe("out");
        expect(open.superuser).toBeUndefined();
        await r.press(keys.escape);
        await r.waitFor("[Containers]");
    });

    it("shows an image's details", async () => {
        const r = await start(scenario());
        await r.waitFor("1.3%");
        await r.press(keys.right);
        await r.waitFor("3 images");
        await select(r, "registry.example/web");
        await r.press(keys.enter);
        const frame = await r.waitFor("Used by");
        expect(frame).toMatch(/Size\s+62\.4 MB/);
        expect(frame).toMatch(/Used by\s+web/);
    });
});

describe("actions", () => {
    it("stops a container after asking, and the list follows podman's event", async () => {
        const stopped = [container("web", { state: "exited", ports: [[8081, 80], [8443, 8443]] }), DB, BUILDER, CACHE];
        const r = await start(scenario({ [`POST ${V}/containers/${id(WEB)}/stop`]: acting(stopped, "died", "web") }));
        await r.waitFor("1.3%");
        await select(r, "web");
        await r.press("S");
        await r.waitFor("Stop the container web?");
        // Asked, not done.
        expect(changes()).toEqual([]);
        await wait(CONFIRM_ARM_MS + 50);
        await r.press(keys.enter);
        await r.waitFor("status: success: Stopped web");
        expect(changes()).toEqual([`POST ${V}/containers/${id(WEB)}/stop`]);
        const frame = await r.waitFor("0 running");
        expect(squash(frame)).toContain("› ○ web registry.example/web:latest Exited 8081:80/tcp, 8443:8443/tcp");
    });

    it("does nothing when the question is cancelled, or answered by a key typed on", async () => {
        const r = await start(scenario());
        await r.waitFor("1.3%");
        await select(r, "web");
        // S and Enter in one burst: the Enter came before the question could be read.
        await r.press("S", keys.enter);
        await r.waitFor("Stop the container web?");
        await wait(100);
        expect(changes()).toEqual([]);
        await r.press(keys.escape);
        await r.waitFor(frame => !frame.includes("Stop the container web?"));
        expect(changes()).toEqual([]);
    });

    it("starts, restarts, pauses and resumes with podman's own calls", async () => {
        const r = await start(scenario({
            [`POST ${V}/containers/${id(BUILDER)}/start`]: { status: 204 },
            [`POST ${V}/containers/${id(WEB)}/restart`]: { status: 204 },
            [`POST ${V}/containers/${id(WEB)}/pause`]: { status: 204 },
            [`POST ${V}/containers/${id(DB)}/unpause`]: { status: 204 },
        }));
        await r.waitFor("1.3%");
        const act = async (name: string, key: string, question: string, done: string) => {
            await r.press(keys.home);
            await select(r, name);
            await r.press(key);
            await r.waitFor(question);
            await wait(CONFIRM_ARM_MS + 50);
            await r.press(keys.enter);
            await r.waitFor(`status: success: ${done}`);
        };
        await act("builder", "s", "Start the container builder?", "Started builder");
        await act("web", "r", "Restart the container web?", "Restarted web");
        await act("web", "p", "Pause the container web?", "Paused web");
        await act("db", "p", "Resume the container db?", "Resumed db");
        expect(changes()).toEqual([
            `POST ${V}/containers/${id(BUILDER)}/start`,
            `POST ${V}/containers/${id(WEB)}/restart`,
            `POST ${V}/containers/${id(WEB)}/pause`,
            `POST ${V}/containers/${id(DB)}/unpause`,
        ]);
    }, 15_000);

    it("deletes a stopped container plainly, a running one by force and says so first", async () => {
        const r = await start(scenario({
            [`DELETE ${V}/containers/${id(BUILDER)}`]: { status: 200, body: [] },
            [`DELETE ${V}/containers/${id(WEB)}`]: { status: 200, body: [] },
        }));
        await r.waitFor("1.3%");
        await select(r, "builder");
        await r.press("d");
        const plain = await r.waitFor("Delete the container builder?");
        expect(plain).not.toContain("by force");
        await wait(CONFIRM_ARM_MS + 50);
        await r.press(keys.enter);
        await r.waitFor("status: success: Deleted builder");

        await select(r, "web");
        await r.press("d");
        await r.waitFor("It is running: it will be");
        expect(r.lastFrame()).toContain("stopped by force and then deleted");
        await wait(CONFIRM_ARM_MS + 50);
        await r.press(keys.enter);
        await r.waitFor("status: success: Deleted web");
        expect(changes()).toEqual([
            `DELETE ${V}/containers/${id(BUILDER)}?force=false`,
            `DELETE ${V}/containers/${id(WEB)}?force=true`,
        ]);
    }, 10_000);

    it("keeps the question open with podman's own reason when an action fails", async () => {
        const r = await start(scenario({
            [`POST ${V}/containers/${id(BUILDER)}/start`]: {
                status: 500, body: { cause: "no such file", message: "crun: executable file `/run.sh` not found: no such file", response: 500 },
            },
        }));
        await r.waitFor("1.3%");
        await select(r, "builder");
        await r.press("s");
        await r.waitFor("Start the container builder?");
        await wait(CONFIRM_ARM_MS + 50);
        await r.press(keys.enter);
        await r.waitFor("crun: executable file `/run.sh` not found");
        expect(r.lastFrame()).toContain("Start builder");
    });

    it("deletes an image without force, warning when a container uses it", async () => {
        const r = await start(scenario({
            "DELETE /v3.4.0/libpod/images/0123456789abcdef0123": {
                status: 200, body: { Deleted: ["0123456789abcdef0123"] },
                effects: [
                    { http: { [USER_SOCK]: { [IMAGES]: { body: [image("web"), image("db")] } } } },
                    { httpData: [USER_SOCK, EVENTS, event("image", "remove")] },
                ],
            },
            "DELETE /v3.4.0/libpod/images/web-image": {
                status: 409, body: { cause: "image is in use by a container", message: "image used by web-id: image is in use by a container", response: 409 },
            },
        }));
        await r.waitFor("1.3%");
        await r.press(keys.right);
        await r.waitFor("3 images");
        await r.press("d");
        await r.waitFor("Delete the image <none> 0123456789ab?");
        await wait(CONFIRM_ARM_MS + 50);
        await r.press(keys.enter);
        await r.waitFor("status: success: Deleted <none> 0123456789ab");
        await r.waitFor("2 images");

        await select(r, "registry.example/web");
        await r.press("d");
        await r.waitFor("used by web: podman will refuse while it is.");
        await wait(CONFIRM_ARM_MS + 50);
        await r.press(keys.enter);
        await r.waitFor("image is in use by a container");
        expect(changes()).toEqual([
            "DELETE /v3.4.0/libpod/images/0123456789abcdef0123?force=false",
            "DELETE /v3.4.0/libpod/images/web-image?force=false",
        ]);
    }, 10_000);

    it("acts on a system container through root's socket", async () => {
        const s = scenario({}, { superuser: true } as Partial<MockScenario>);
        s.http![SYSTEM_SOCK] = systemRoutes({ [`POST ${V}/containers/${"router-id".padEnd(64, "0")}/restart`]: { status: 204 } });
        const r = await start(s, { allowed: true });
        await r.waitFor("router");
        await select(r, "router");
        await r.press("r");
        await r.waitFor("Restart the container router?");
        await wait(CONFIRM_ARM_MS + 50);
        await r.press(keys.enter);
        await r.waitFor("status: success: Restarted router");
        const post = mock!.opened("http-stream2").find(open => open.method === "POST")!;
        expect(post).toMatchObject({ unix: SYSTEM_SOCK, superuser: "require" });
    });
});
