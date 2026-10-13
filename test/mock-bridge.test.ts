/*
 * The mock cockpit-bridge, exercised through the vendored library.
 *
 * Pages are tested against test/mock-bridge/bridge.mjs, so the mock has to
 * behave like the real bridge or those tests prove nothing. Where these tests
 * assert an exact message shape, ordering or wording, it is one captured from
 * the real (Python) cockpit-bridge 356 -- see the headers of the mock's
 * modules for the captures and the few deliberate differences. Tests that need
 * to make protocol mistakes the library never makes use the raw stdio helper.
 */
import { describe, it, expect, afterEach } from "vitest";
import cockpit from "../src/cockpit.js";
import { Superuser } from "../src/superuser.js";
import { startMock, type JsonObject, type MockBridge, type MockScenario } from "./mock-bridge/harness.js";
import { startRaw, type RawBridge, type RawFrame } from "./mock-bridge/raw.js";

let mock: MockBridge | null = null;
let raws: RawBridge[] = [];

async function start(scenario: MockScenario = {}): Promise<MockBridge> {
    mock = await startMock(scenario);
    return mock;
}

async function raw(scenario: MockScenario = {}, init: JsonObject = {}): Promise<RawBridge> {
    const bridge = await startRaw(scenario, init);
    raws.push(bridge);
    return bridge;
}

afterEach(() => {
    mock?.close();
    mock = null;
    for (const bridge of raws)
        bridge.close();
    raws = [];
});

// ---- helpers ---------------------------------------------------------------

/** Poll until probe() returns something truthy. */
async function until<T>(probe: () => T | null | undefined | false, timeoutMs = 2000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = probe();
        if (value)
            return value;
        if (Date.now() > deadline)
            throw new Error(`condition not met within ${timeoutMs}ms`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Every argument a cockpit Deferred resolved with, e.g. read()'s (content, tag). */
function settle<T extends unknown[]>(promise: PromiseLike<unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const then = promise.then as unknown as (ok: (...args: unknown[]) => void, fail: (e: unknown) => void) => void;
        then.call(promise, (...args: unknown[]) => resolve(args as T), reject);
    });
}

interface Recorded {
    kind: "control" | "message" | "close";
    value: unknown;
}

/** Record a channel's events in arrival order. */
function record(channel: unknown) {
    const events: Recorded[] = [];
    const target = channel as { addEventListener(event: string, handler: (...args: never[]) => void): void };
    for (const kind of ["control", "message", "close"] as const)
        target.addEventListener(kind, ((_event: unknown, value: unknown) => events.push({ kind, value })) as never);
    const messages = () => events.filter(e => e.kind === "message").map(e => e.value);
    return {
        events,
        messages,
        json: () => messages().map(m => JSON.parse(m as string) as JsonObject),
        controls: () => events.filter(e => e.kind === "control").map(e => e.value as JsonObject),
        closed: () => until(() => events.find(e => e.kind === "close")?.value as JsonObject | undefined),
        /** e.g. ["ready", "message", "done", "close"] */
        trace: () => events.map(e => (e.kind === "control" ? String((e.value as JsonObject).command) : e.kind)),
    };
}

interface Channel {
    send(data: string | Uint8Array): void;
    control(options: JsonObject): void;
    close(options?: string | JsonObject): void;
    id: string | null;
}

function open(options: JsonObject): Channel {
    return cockpit.channel(options as never) as unknown as Channel;
}

/** A raw frame, summarised: "ready", "close {...}", or data as text. */
function summary(frame: RawFrame): string {
    if (frame.control) {
        const { channel: _channel, command, ...rest } = frame.control;
        return Object.keys(rest).length ? `${String(command)} ${JSON.stringify(rest)}` : String(command);
    }
    return JSON.stringify(frame.data!.toString("utf8"));
}

/** "1:<ino>-..." -> the inode part, to tell a replaced file from one written in place. */
const inode = (tag: string) => tag.split("-")[0];

// ---- the call log ------------------------------------------------------------

describe("the mock's call log", () => {
    it("records the frames the client sends, in order", async () => {
        const bridge = await start({ spawn: { chpasswd: { readInput: true } } });
        await cockpit.spawn(["chpasswd"]).input("alice:s3cr3t\n");

        const opened = bridge.opened("stream");
        expect(opened).toHaveLength(1);
        expect(opened[0]).toMatchObject({ command: "open", payload: "stream", spawn: ["chpasswd"] });
        const channel = opened[0]!.channel as string;
        expect(bridge.sent(channel)).toBe("alice:s3cr3t\n");

        const forChannel = bridge.received().filter(entry => entry.channel === channel);
        expect(forChannel.map(entry => entry.control?.command ?? "data")).toEqual(["open", "data", "done"]);
    });

    it("logs data that is not UTF-8 as base64", async () => {
        const bridge = await start();
        const echo = open({ payload: "echo", binary: true });
        const rec = record(echo);
        echo.send(new Uint8Array([0xff, 0x00, 0x41]));
        await until(() => rec.messages().length);
        const entry = await bridge.waitForReceived(e => e.base64 !== undefined);
        expect(entry).toEqual({ channel: echo.id, base64: Buffer.from([0xff, 0x00, 0x41]).toString("base64") });
    });

    it("answers a client's close with its own, like the real bridge", async () => {
        await start();
        const transportFrames: JsonObject[] = [];
        cockpit.transport.filter((_message, _channel, control) => {
            if (control?.command === "close")
                transportFrames.push(control);
            return true;
        });
        const nul = open({ payload: "null" });
        await until(() => nul.id);
        nul.close();
        await until(() => transportFrames.find(c => c.channel === nul.id));
    });
});

// ---- files -----------------------------------------------------------------

describe("files", () => {
    // "1:<ino>-<mtime>-<octal mode>-<uid>-<gid>", as filesystem.py's tag_from_stat()
    const TAG = /^1:\d+-\d+(\.\d+)?-100644-1000-1000$/;      // the user's own, in its home
    const ROOT_TAG = /^1:\d+-\d+(\.\d+)?-100644-0-0$/;       // root's, everywhere else

    it("reads content and a real-looking tag through fsread1", async () => {
        await start({ files: { "/etc/motd": "Welcome\n" } });
        const [content, tag] = await settle<[string, string]>(cockpit.file("/etc/motd").read());
        expect(content).toBe("Welcome\n");
        // Outside the user's home, files belong to root unless the scenario says otherwise.
        expect(tag).toMatch(ROOT_TAG);

        const rec = record(open({ payload: "fsread1", path: "/etc/motd" }));
        expect(await rec.closed()).toMatchObject({ tag });
        expect(rec.trace()).toEqual(["ready", "message", "done", "close"]);
    });

    it("reports a missing file as null and tag '-', with no ready on the wire", async () => {
        await start();
        const [content, tag] = await settle<[string | null, string]>(cockpit.file("/etc/nothing").read());
        expect(content).toBeNull();
        expect(tag).toBe("-");

        const rec = record(open({ payload: "fsread1", path: "/etc/nothing" }));
        expect(await rec.closed()).toMatchObject({ tag: "-" });
        expect(rec.trace()).toEqual(["done", "close"]);
    });

    it("drops NULs and invalid UTF-8 in text mode; binary mode gets the bytes and a size-hint", async () => {
        const bytes = [0x61, 0x00, 0x62, 0xff, 0x63, 0x0a];
        await start({ files: { "/srv/mixed": { base64: Buffer.from(bytes).toString("base64") } } });

        await expect(cockpit.file("/srv/mixed").read()).resolves.toBe("abc\n");

        const binary = await cockpit.file("/srv/mixed", { binary: true }).read();
        expect(Array.from(binary)).toEqual(bytes);

        const rec = record(open({ payload: "fsread1", path: "/srv/mixed", binary: true }));
        await rec.closed();
        expect(rec.controls()[0]).toMatchObject({ command: "ready", "size-hint": 6 });
    });

    it("decodes text block by block, losing a character split across 16 KiB blocks like the real one", async () => {
        await start({ files: { "/srv/boundary": `${"a".repeat(16383)}étail\n` } });
        const rec = record(open({ payload: "fsread1", path: "/srv/boundary" }));
        await rec.closed();
        // read1(16384) ends inside "é": each block is decoded on its own with errors="ignore".
        expect(rec.messages()).toEqual(["a".repeat(16383), "tail\n"]);
    });

    it("refuses a file larger than max_read_size", async () => {
        await start({ files: { "/var/log/big": "0123456789" } });
        await expect(cockpit.file("/var/log/big", { max_read_size: 5 }).read())
            .rejects.toMatchObject({ problem: "too-large" });
        await expect(cockpit.file("/var/log/big", { max_read_size: 10 }).read()).resolves.toBe("0123456789");
    });

    it("reports reading a directory as internal-error, with the traceback as cause", async () => {
        await start({ files: { "/srv/sub/": {} } });
        const rec = record(open({ payload: "fsread1", path: "/srv/sub" }));
        const close = await rec.closed();
        expect(close).toMatchObject({ problem: "internal-error", message: "[Errno 21] Is a directory: '/srv/sub'" });
        expect((close.cause as string[]).at(-1)).toBe("IsADirectoryError: [Errno 21] Is a directory: '/srv/sub'\n");
    });

    it("replaces with the expected tag, and refuses stale or wrong preconditions", async () => {
        const bridge = await start({ files: { "/home/mock/hostname": "old\n" } });
        const file = cockpit.file("/home/mock/hostname");
        const [, oldTag] = await settle<[string, string]>(file.read());

        const newTag = await file.replace("new\n", oldTag);
        expect(newTag).toMatch(TAG);
        expect(newTag).not.toBe(oldTag);
        await expect(file.read()).resolves.toBe("new\n");

        await expect(file.replace("x\n", oldTag)).rejects.toMatchObject({ problem: "change-conflict" });
        // "-" means "must not exist yet".
        await expect(file.replace("x\n", "-")).rejects.toMatchObject({ problem: "change-conflict" });
        // A real tag for a file that is not there is "not-found", not a conflict.
        await expect(cockpit.file("/home/mock/absent").replace("x\n", oldTag)).rejects.toMatchObject({ problem: "not-found" });
        await expect(file.read()).resolves.toBe("new\n");

        // The log shows exactly what was written, and with which precondition.
        const first = bridge.opened("fsreplace1")[0]!;
        expect(first).toMatchObject({ path: "/home/mock/hostname", tag: oldTag });
        expect(bridge.sent(first.channel as string)).toBe("new\n");
    });

    it("creates with tag '-', deletes on null, and writes empty files", async () => {
        await start({ files: { "/home/mock/notes": "x" } });
        await expect(cockpit.file("/home/mock/new").replace("made\n", "-")).resolves.toMatch(TAG);
        await expect(cockpit.file("/home/mock/new").read()).resolves.toBe("made\n");

        // Deleting answers tag "-" and is idempotent; a wrong tag still conflicts.
        await expect(cockpit.file("/home/mock/notes").replace(null, "1:1-2-3-4-5"))
            .rejects.toMatchObject({ problem: "change-conflict" });
        await expect(cockpit.file("/home/mock/notes").replace(null)).resolves.toBe("-");
        await expect(cockpit.file("/home/mock/notes").read()).resolves.toBeNull();
        await expect(cockpit.file("/home/mock/notes").replace(null, "-")).resolves.toBe("-");

        // "" is an empty file, not a deletion: the library sends one empty frame.
        await cockpit.file("/home/mock/empty").replace("");
        await expect(cockpit.file("/home/mock/empty").read()).resolves.toBe("");

        // Writing into a directory that does not exist fails like the real one.
        await expect(cockpit.file("/no/such/dir/file").replace("x")).rejects.toMatchObject({ problem: "not-found" });
    });

    it("lets modify() recover from a change-conflict by re-reading", async () => {
        const bridge = await start({ files: { "/home/mock/counter": "1" } });
        const file = cockpit.file("/home/mock/counter");
        // Start from stale content and a stale tag, as if someone else wrote meanwhile.
        const result = await file.modify(old => String(Number(old) + 1), "0", "1:0-0.0-100644-0-0");
        expect(result).toBe("2");
        await expect(file.read()).resolves.toBe("2");

        const writes = bridge.opened("fsreplace1");
        expect(writes).toHaveLength(2);
        expect(bridge.sent(writes[0]!.channel as string)).toBe("1");
        expect(bridge.sent(writes[1]!.channel as string)).toBe("2");
    });

    it("tells a watch() when another handle replaces or deletes the file", async () => {
        const bridge = await start({ files: { "/home/mock/motd": "one\n" } });
        const seen: [string | null, string | null][] = [];
        const handle = cockpit.file("/home/mock/motd").watch((content, tag) => {
            seen.push([content, tag]);
        });

        await until(() => seen.length >= 1);
        expect(seen[0]![0]).toBe("one\n");
        // The library watches through fsinfo, the way it does with a real bridge.
        expect(bridge.opened("fsinfo")[0]).toMatchObject({ path: "/home/mock/motd", attrs: ["tag"], watch: true });

        const tag = await cockpit.file("/home/mock/motd").replace("two\n");
        await until(() => seen.length >= 2);
        expect(seen[1]).toEqual(["two\n", tag]);

        await cockpit.file("/home/mock/motd").replace(null);
        await until(() => seen.length >= 3);
        expect(seen[2]).toEqual([null, "-"]);
        handle.remove();
    });

    it("enforces declared permissions, and superuser channels act as root", async () => {
        await start({
            superuser: true,
            files: { "/etc/shadow": { content: "root:*:19000::::::\n", mode: 0, user: "root", group: "root" } },
        });
        await expect(cockpit.file("/etc/shadow").read()).rejects.toMatchObject({ problem: "access-denied" });
        await expect(cockpit.file("/etc/shadow").replace("x")).rejects.toMatchObject({ problem: "access-denied" });
        await expect(cockpit.file("/etc/shadow", { superuser: "require" }).read()).resolves.toBe("root:*:19000::::::\n");
    });

    it("refuses unprivileged writes where the kernel would: the directory decides", async () => {
        await start({
            superuser: true,
            files: {
                "/etc/motd": "Welcome\n",
                "/home/mock/ro/": { mode: 0o555 },
                "/home/mock/ro/existing": "e",
                "/home/mock/rootfile": { content: "r", user: "root", group: "root" },
                "/tmp/theirs": { content: "t", user: "root", group: "root" },
            },
        });
        /** An fsreplace1 by hand: its trace and close, as the real bridge sends them. */
        async function replace(path: string, content: string | null, options: JsonObject = {}) {
            const channel = open({ payload: "fsreplace1", path, ...options });
            const rec = record(channel);
            if (content !== null)
                channel.send(content);
            channel.control({ command: "done" });
            const close = await rec.closed();
            return { trace: rec.trace(), close };
        }

        // Reading root's 0644 file is fine; writing next to it is not: no done, just the close.
        await expect(cockpit.file("/etc/motd").read()).resolves.toBe("Welcome\n");
        expect(await replace("/etc/motd", "hacked\n")).toEqual({
            trace: ["ready", "close"], close: expect.objectContaining({ problem: "access-denied" }),
        });
        expect((await replace("/etc/new.conf", "x\n")).close).toMatchObject({ problem: "access-denied" });
        expect((await replace("/etc/motd", null)).close).toMatchObject({ problem: "access-denied" });
        await expect(cockpit.file("/etc/motd").read()).resolves.toBe("Welcome\n");

        // A read-only directory of the user's own: create, replace and delete all refused.
        for (const [path, content] of [["/home/mock/ro/new", "x"], ["/home/mock/ro/existing", "y"], ["/home/mock/ro/existing", null]] as const)
            expect((await replace(path, content)).close).toMatchObject({ problem: "access-denied" });

        // A root file in the user's home: a plain replace makes a new file of the
        // user's; a tagged one must chown to root, which only root may do.
        const [, rootTag] = await settle<[string, string]>(cockpit.file("/home/mock/rootfile").read());
        await expect(cockpit.file("/home/mock/rootfile").replace("r2", rootTag)).rejects.toMatchObject({ problem: "access-denied" });
        await expect(cockpit.file("/home/mock/rootfile").replace("r3")).resolves.toMatch(TAG);

        // /tmp is sticky: anyone may create, nobody replaces another user's file.
        await expect(cockpit.file("/tmp/mine").replace("m")).resolves.toMatch(/^1:\d+-[\d.]+-100644-1000-1000$/);
        await expect(cockpit.file("/tmp/theirs").replace("x")).rejects.toMatchObject({ problem: "access-denied" });

        // With "size" the temp file is made before ready: a bad directory closes without one.
        expect(await replace("/no/such/dir/x", null, { size: 1 })).toEqual({
            trace: ["close"], close: expect.objectContaining({ problem: "not-found" }),
        });

        // The root bridge may do it all; root's new files are root's.
        await expect(cockpit.file("/etc/new.conf", { superuser: "try" }).replace("x\n")).resolves.toMatch(ROOT_TAG);
        await expect(cockpit.file("/etc/new.conf").read()).resolves.toBe("x\n");
    });

    it("sends fswatch1 events with the real bridge's fields, temp file included", async () => {
        await start({ files: { "/home/mock/w.txt": "one\n" } });
        const file = record(open({ payload: "fswatch1", path: "/home/mock/w.txt" }));
        const dir = record(open({ payload: "fswatch1", path: "/home/mock" }));
        await until(() => file.trace().includes("ready") && dir.trace().includes("ready"));

        const tag = await cockpit.file("/home/mock/w.txt").replace("two\n");
        await until(() => file.json().length >= 1 && dir.json().length >= 6);
        // The watched path itself: an identity change, which carries no "type".
        expect(file.json()).toEqual([{ event: "created", path: "/home/mock/w.txt", tag }]);
        // The directory sees the temp file fsreplace1 renames into place.
        const temp = dir.json()[0]!.path as string;
        expect(temp).toMatch(/^\/home\/mock\/\.w\.txt-[a-z0-9_]{8}$/);
        const tempTag = dir.json()[0]!.tag as string;
        expect(tempTag).toMatch(/-100600-1000-1000$/);
        expect(inode(tempTag)).toBe(inode(tag));
        expect(dir.json()).toEqual([
            { event: "created", path: temp, tag: tempTag, type: "file" },
            { event: "changed", path: temp, tag: tempTag, type: null },
            { event: "attribute-changed", path: temp, tag: "-", type: null },
            { event: "deleted", path: temp, tag: "-", type: null },
            { event: "changed", path: "/home/mock/w.txt", tag, type: null },
            { event: "done-hint", path: "/home/mock/w.txt", tag, type: null },
        ]);

        await cockpit.file("/home/mock/w.txt").replace(null);
        await until(() => file.json().length >= 3 && dir.json().length >= 7);
        expect(file.json().slice(1)).toEqual([
            { event: "attribute-changed", path: "/home/mock/w.txt", tag: "-", type: null },
            { event: "deleted", path: "/home/mock/w.txt", tag: "-" },
        ]);
        expect(dir.json()[6]).toEqual({ event: "deleted", path: "/home/mock/w.txt", tag: "-", type: null });
    });

    it("answers fsinfo with JSON merge patches, resets included", async () => {
        await start({ files: { "/home/mock/i.txt": "hello\n" } });

        const attrs = ["type", "size", "mode", "user", "group", "tag", "target"];
        const once = record(open({ payload: "fsinfo", path: "/home/mock/i.txt", attrs }));
        await once.closed();
        expect(once.trace()).toEqual(["ready", "message", "done", "close"]);
        const info = once.json()[0]!.info as JsonObject;
        // Attributes without a value ("target" on a regular file) are left out.
        expect(info).toEqual({ type: "reg", size: 6, mode: 420, user: "mock", group: "mock", tag: info.tag });

        const missing = record(open({ payload: "fsinfo", path: "/home/mock/nope", attrs: ["type"] }));
        await missing.closed();
        expect(missing.json()).toEqual([
            { error: { problem: "not-found", message: "No such file or directory", errno: "ENOENT" } },
        ]);

        const listing = record(open({ payload: "fsinfo", path: "/home/mock", attrs: ["type", "entries"] }));
        await listing.closed();
        expect(listing.json()).toEqual([{ info: { type: "dir", entries: { "i.txt": { type: "reg" } } } }]);

        const watch = record(open({ payload: "fsinfo", path: "/home/mock/i.txt", attrs: ["tag"], watch: true }));
        await until(() => watch.json().length >= 1);
        const tag1 = await cockpit.file("/home/mock/i.txt").replace("bye\n");
        await until(() => watch.json().length >= 3);
        await cockpit.file("/home/mock/i.txt").replace(null);
        await until(() => watch.json().length >= 4);
        const tag2 = await cockpit.file("/home/mock/i.txt").replace("again\n");
        await until(() => watch.json().length >= 5);
        expect(watch.json()).toEqual([
            { info: { tag: info.tag } },
            // replaced: retract everything (partial), then the new state
            { info: null, partial: true },
            { info: { tag: tag1 }, partial: null },
            // deleted, then created again
            { error: { problem: "not-found", message: "No such file or directory", errno: "ENOENT" }, info: null },
            { info: { tag: tag2 }, error: null },
        ]);
    });

    it("lets a command change files behind the client's back", async () => {
        await start({
            files: { "/etc/passwd": "root:x:0:0::/root:/bin/bash\n" },
            spawnPatterns: [{
                match: "^useradd ",
                effects: [{ files: { "/etc/passwd": "root:x:0:0::/root:/bin/bash\nbob:x:1001:1001::/home/bob:/bin/bash\n" } }],
            }],
        });
        const seen: (string | null)[] = [];
        cockpit.file("/etc/passwd").watch(content => {
            seen.push(content);
        });
        await until(() => seen.length >= 1);
        await cockpit.spawn(["useradd", "-m", "bob"]);
        await until(() => seen.length >= 2);
        expect(seen[1]).toContain("bob:x:1001");
    });

    it("tells watchers about files others write in place, as inotify reports them", async () => {
        await start({
            files: { "/home/mock/log.txt": "one\n", "/home/mock/d/": {} },
            spawn: {
                append: { effects: [{ files: { "/home/mock/log.txt": "one\ntwo\n" }, inPlace: true }] },
                create: { effects: [{ files: { "/home/mock/d/n.txt": "x\n" }, inPlace: true }] },
            },
        });
        const file = record(open({ payload: "fswatch1", path: "/home/mock/log.txt" }));
        const dir = record(open({ payload: "fswatch1", path: "/home/mock/d" }));
        const info = record(open({ payload: "fsinfo", path: "/home/mock/log.txt", attrs: ["tag", "size"], watch: true }));
        await until(() => file.trace().includes("ready") && dir.trace().includes("ready") && info.json().length);
        const before = (info.json()[0]!.info as JsonObject).tag as string;

        await cockpit.spawn(["append"]);
        await until(() => file.json().length && info.json().length >= 2);
        // The same inode, written: "changed", and an incremental fsinfo update 100 ms later.
        const tag = file.json()[0]!.tag as string;
        expect(file.json()).toEqual([{ event: "changed", path: "/home/mock/log.txt", tag, type: null }]);
        expect(inode(tag)).toBe(inode(before));
        expect(info.json()[1]).toEqual({ info: { tag, size: 8 } });

        await cockpit.spawn(["create"]);
        await until(() => dir.json().length >= 3);
        const created = dir.json()[0]!.tag;
        expect(dir.json()).toEqual([
            { event: "created", path: "/home/mock/d/n.txt", tag: created, type: "file" },
            { event: "changed", path: "/home/mock/d/n.txt", tag: created, type: null },
            { event: "done-hint", path: "/home/mock/d/n.txt", tag: created, type: null },
        ]);
    });
});

// ---- flow control --------------------------------------------------------------

describe("flow control", () => {
    const BIG = 3 * 1024 * 1024;

    it("pings every 16 KiB and holds fsread1 at the 2 MiB window until the pong", async () => {
        const bridge = await raw({ files: { "/home/mock/3m": "a".repeat(BIG) } });
        bridge.control({ command: "open", channel: "r", payload: "fsread1", path: "/home/mock/3m", "flow-control": true });
        await bridge.next(f => f.control?.command === "ping" && f.control.sequence === 2 * 1024 * 1024, 10000);
        await sleep(200);
        const bytes = () => bridge.of("r").reduce((n, f) => n + (f.data?.length ?? 0), 0);
        const pings = () => bridge.of("r").filter(f => f.control?.command === "ping");
        expect(bytes()).toBe(2 * 1024 * 1024);
        expect(pings()).toHaveLength(128);
        expect(pings()[0]!.control).toEqual({ channel: "r", command: "ping", sequence: 16384 });
        expect(bridge.of("r").some(f => f.control?.command === "close")).toBe(false);

        bridge.control({ command: "pong", channel: "r", sequence: 2 * 1024 * 1024 });
        await bridge.next(f => f.channel === "r" && f.control?.command === "close", 10000);
        expect(bytes()).toBe(BIG);
    });

    it("reads past the window through the library, which answers the pings", async () => {
        await start({ files: { "/home/mock/3m": "b".repeat(BIG) } });
        const content = await cockpit.file("/home/mock/3m", { max_read_size: -1 }).read();
        expect(content.length).toBe(BIG);
    });

    it("delivers a process's output the way a pipe does: in 8 KiB frames", async () => {
        const bridge = await raw({ spawn: { big: { stdout: "x".repeat(20000) } } });
        bridge.control({ command: "open", channel: "s", payload: "stream", spawn: ["big"], "flow-control": true });
        await bridge.next(f => f.channel === "s" && f.control?.command === "close");
        expect(bridge.of("s").map(f => (f.data ? f.data.length : f.control!.command))).toEqual(
            ["ready", 8192, 8192, "ping", 3616, "done", "close"]);
    });
});

// ---- metrics ---------------------------------------------------------------

describe("metrics1", () => {
    async function collect(options: JsonObject, count: number) {
        const channel = open({ payload: "metrics1", source: "internal", ...options });
        const rec = record(channel);
        await until(() => rec.messages().length >= count || rec.events.some(e => e.kind === "close"));
        channel.close();
        return rec;
    }

    it("sends the real meta envelope, then uncompressed rows with derived rates", async () => {
        await start({
            metrics: {
                "memory.used": { samples: [1000, 2000, 3000] },
                "cpu.basic.user": { samples: [0, 50, 150] },
                "network.interface.rx": { instances: ["lo", "eth0"], samples: [[0, 0], [10, 100]] },
            },
        });
        const rec = await collect({
            interval: 50,
            metrics: [{ name: "memory.used" }, { name: "cpu.basic.user", derive: "rate" },
                { name: "network.interface.rx", derive: "rate" }],
        }, 5);

        const [meta, ...rows] = rec.json() as unknown as [JsonObject, ...unknown[]];
        expect(Object.keys(meta)).toEqual(["source", "interval", "timestamp", "now", "metrics"]);
        expect(meta).toMatchObject({ source: "internal", interval: 50 });
        expect(meta.timestamp).toEqual(expect.any(Number));
        expect((meta.now as number) % 1000).toBe(0);
        expect(meta.metrics).toEqual([
            { name: "memory.used", derive: null, units: "bytes", semantics: "instant" },
            { name: "cpu.basic.user", derive: "rate", units: "millisec", semantics: "counter" },
            { name: "network.interface.rx", units: "bytes", instances: ["lo", "eth0"], semantics: "counter" },
        ]);

        // A rate has no first value: false. Then (value - previous) per second
        // of the 50ms interval. Samples that run out repeat the last one.
        expect(rows.slice(0, 4)).toEqual([
            [[1000, false, [false, false]]],
            [[2000, 1000, [200, 2000]]],
            [[3000, 2000, [0, 0]]],
            [[3000, 0, [0, 0]]],
        ]);
        // Rows are formatted like Python's json.dumps(), not pretty-printed.
        expect(rec.messages()[1]).toBe("[[1000, false, [false, false]]]");
    });

    it("stops sampling when the client closes the channel", async () => {
        await start({ metrics: { "memory.used": { samples: [1, 2, 3] } } });
        const channel = open({ payload: "metrics1", source: "internal", interval: 10, metrics: [{ name: "memory.used" }] });
        const rec = record(channel);
        await until(() => rec.messages().length >= 3);
        // Count what the bridge still sends on this channel after our close.
        let after = 0;
        cockpit.transport.filter((_message, frameChannel) => {
            if (frameChannel === channel.id)
                after += 1;
            return true;
        });
        channel.close();
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(after).toBe(0);
    });

    it("re-sends meta when an instanced metric's instances change", async () => {
        await start({ metrics: { "disk.dev.read": { samples: [{ sda: 1 }, { sda: 2, sdb: 5 }] } } });
        const rec = await collect({ interval: 20, metrics: [{ name: "disk.dev.read" }] }, 4);
        const messages = rec.json() as unknown[];
        expect((messages[0] as JsonObject).metrics).toEqual([
            { name: "disk.dev.read", units: "bytes", instances: ["sda"], semantics: "counter" },
        ]);
        expect(messages[1]).toEqual([[[1]]]);
        expect((messages[2] as JsonObject).metrics).toEqual([
            { name: "disk.dev.read", units: "bytes", instances: ["sda", "sdb"], semantics: "counter" },
        ]);
        expect(messages[3]).toEqual([[[2, 5]]]);
    });

    it("refuses what the real bridge refuses", async () => {
        await start();
        const unknown = record(open({ payload: "metrics1", source: "internal", metrics: [{ name: "no.such" }] }));
        expect(await unknown.closed()).toMatchObject({ problem: "not-supported", message: "unsupported metric: no.such" });
        expect(unknown.trace()).toEqual(["close"]);

        const nameless = record(open({ payload: "metrics1", source: "internal", metrics: [{ derive: "rate" }] }));
        expect(await nameless.closed()).toMatchObject({ problem: "not-supported", message: "unsupported metric: None" });

        const units = record(open({ payload: "metrics1", source: "internal", metrics: [{ name: "memory.used", units: "millisec" }] }));
        expect(await units.closed()).toMatchObject({
            problem: "not-supported", message: "memory.used has units bytes, not millisec",
        });

        const empty = record(open({ payload: "metrics1", source: "internal", metrics: [] }));
        expect(await empty.closed()).toMatchObject({
            problem: "protocol-error", message: 'invalid "metrics" option was specified (not an array)',
        });

        const pcp = record(open({ payload: "metrics1", source: "pmcd", metrics: [{ name: "kernel.all.load" }] }));
        expect(await pcp.closed()).toMatchObject({ problem: "not-supported" });
    });

    it("emulates the C bridge's compression, which cockpit.metrics() undoes", async () => {
        await start({
            metricsCompress: true,
            metrics: {
                "disk.dev.read": { instances: ["sda", "sdb"], samples: [[1, 1], [1, 2], [3, 2]] },
                "memory.used": { samples: [5, 5, 7] },
                "memory.free": { samples: [1, 2, 2] },
            },
        });
        const names = [{ name: "disk.dev.read" }, { name: "memory.used" }, { name: "memory.free" }];

        // On the wire: unchanged values are null, trailing unchanged ones are
        // dropped, instanced metrics are always present.
        const rawRows = await collect({ interval: 20, metrics: names }, 5);
        expect(rawRows.json().slice(1, 5)).toEqual([
            [[[1, 1], 5, 1]],
            [[[null, 2], null, 2]],
            [[[3], 7]],
            [[[]]],
        ]);

        // The library's decompression restores full rows.
        const rows: unknown[] = [];
        const metrics = (cockpit as unknown as {
            metrics(interval: number, options: JsonObject): {
                series: { input(beg: number, items: unknown[]): void },
                follow(): void,
                close(): void,
            },
        }).metrics(20, { source: "internal", metrics: names });
        metrics.series.input = (_beg, items) => {
            rows.push(...items);
        };
        metrics.follow();
        await until(() => rows.length >= 4);
        metrics.close();
        expect(rows.slice(0, 4)).toEqual([
            [[1, 1], 5, 1],
            [[1, 2], 5, 2],
            [[3, 2], 7, 2],
            [[3, 2], 7, 2],
        ]);
    });
});

// ---- D-Bus -------------------------------------------------------------------

const SYSTEMD = "org.freedesktop.systemd1";
const MANAGER = "org.freedesktop.systemd1.Manager";
const UNIT = "org.freedesktop.systemd1.Unit";
const SYSTEMD_PATH = "/org/freedesktop/systemd1";
const SSHD_PATH = "/org/freedesktop/systemd1/unit/sshd_2eservice";
const PROPERTIES = "org.freedesktop.DBus.Properties";

const systemdScenario: MockScenario = {
    dbus: {
        system: {
            [SYSTEMD_PATH]: {
                "org.freedesktop.DBus.ObjectManager": {},
                [MANAGER]: {
                    properties: { Version: "255", NFailedUnits: { t: "u", v: 0 }, LogLevel: "info" },
                    writable: ["LogLevel"],
                    methods: {
                        Reload: null,
                        GetUnit: { in: ["s"], out: ["o"], reply: [SSHD_PATH] },
                        StartUnit: {
                            reply: ["/org/freedesktop/systemd1/job/1"],
                            out: ["o"],
                            effects: [
                                { signal: [SYSTEMD_PATH, MANAGER, "JobRemoved", [1, "/org/freedesktop/systemd1/job/1", "sshd.service", "done"]] },
                                { signal: [SYSTEMD_PATH, MANAGER, "UnitNew", ["sshd.service", SSHD_PATH]] },
                                { properties: [SSHD_PATH, UNIT, { ActiveState: "active" }], delayMs: 20 },
                            ],
                            byArgs: [{
                                args: ["broken.service", "replace"],
                                error: ["org.freedesktop.systemd1.NoSuchUnit", ["Unit broken.service not found."]],
                            }],
                        },
                        StopUnit: {
                            reply: ["/org/freedesktop/systemd1/job/2"],
                            effects: [{ properties: [SSHD_PATH, UNIT, { ActiveState: "inactive" }], beforeReply: true }],
                        },
                        Announce: {
                            effects: [
                                { signal: [SYSTEMD_PATH, MANAGER, "Changed", ["a"]] },
                                { signal: [SYSTEMD_PATH, MANAGER, "Changed", ["b"]] },
                            ],
                        },
                        AddUnit: {
                            effects: [{ added: ["/org/freedesktop/systemd1/unit/new_2eservice", { [UNIT]: { Id: "new.service" } }] }],
                        },
                        RemoveUnit: { effects: [{ removed: [SSHD_PATH] }] },
                        Restart: { effects: [{ owner: [SYSTEMD, ":1.99"] }] },
                        Slow: { in: [], delayMs: 400 },
                    },
                    signals: { JobRemoved: { in: ["u", "o", "s", "s"] } },
                },
            },
            [SSHD_PATH]: {
                [UNIT]: { properties: { Id: "sshd.service", ActiveState: "inactive" } },
            },
        },
    },
};

/** The standard interfaces every sd-bus object has, as introspection reports them. */
const STANDARD_META = {
    "org.freedesktop.DBus.Peer": {
        methods: { Ping: { in: [], out: [] }, GetMachineId: { in: [], out: ["s"] } }, properties: {}, signals: {},
    },
    "org.freedesktop.DBus.Introspectable": {
        methods: { Introspect: { in: [], out: ["s"] } }, properties: {}, signals: {},
    },
    [PROPERTIES]: {
        methods: {
            Get: { in: ["s", "s"], out: ["v"] }, GetAll: { in: ["s"], out: ["a{sv}"] }, Set: { in: ["s", "s", "v"], out: [] },
        },
        properties: {},
        signals: { PropertiesChanged: { in: ["s", "a{sv}", "as"] } },
    },
};

interface DBusClient {
    call(path: string, iface: string, method: string, args?: unknown[], options?: JsonObject): PromiseLike<unknown[]>;
    subscribe(match: JsonObject, callback?: (path: string, iface: string, signal: string, args: unknown[]) => void,
              rule?: boolean): { remove(): void };
    proxy(iface: string, path: string): DBusProxy;
    proxies(iface: string, path_namespace: string): DBusProxies;
    addEventListener(event: string, handler: (...args: never[]) => void): void;
    close(): void;
}

interface DBusProxy {
    valid: boolean;
    wait(): PromiseLike<void>;
    addEventListener(event: string, handler: (...args: never[]) => void): void;
    [property: string]: unknown;
}

interface DBusProxies {
    wait(): PromiseLike<void>;
    addEventListener(event: string, handler: (...args: never[]) => void): void;
    [path: string]: unknown;
}

function systemd(options: JsonObject = {}): DBusClient {
    return cockpit.dbus(SYSTEMD, { bus: "system", ...options }) as unknown as DBusClient;
}

describe("dbus-json3", () => {
    it("sends the owner before ready, and replies with flags and type like the real bridge", async () => {
        await start(systemdScenario);
        const channel = open({ payload: "dbus-json3", bus: "system", name: SYSTEMD });
        const rec = record(channel);
        await until(() => rec.trace().includes("ready"));
        expect(rec.trace()).toEqual(["message", "ready"]);
        expect(rec.json()[0]).toEqual({ owner: ":1.42" });
        expect(rec.controls()[0]).toMatchObject({ "unique-name": ":1.42" });

        channel.send(JSON.stringify({ call: [SYSTEMD_PATH, MANAGER, "GetUnit", ["sshd.service"]], id: "7" }));
        channel.send(JSON.stringify({ call: [SYSTEMD_PATH, MANAGER, "GetUnit", ["sshd.service"]], id: "8", flags: "" }));
        channel.send(JSON.stringify({ call: [SYSTEMD_PATH, MANAGER, "Nope", ["x"]], id: "9" }));
        channel.send(JSON.stringify({ watch: { path: SSHD_PATH } }));
        await until(() => rec.json().length >= 6);
        expect(rec.json().slice(1)).toEqual([
            { reply: [[SSHD_PATH]], id: "7", flags: null, type: "o" },
            { reply: [[SSHD_PATH]], id: "8", flags: "<", type: "o" },
            { error: ["org.freedesktop.DBus.Error.UnknownMethod",
                ["Introspection data for method org.freedesktop.systemd1.Manager Nope not available"]], id: "9" },
            // A watch without an id gets an error and an empty reply.
            { error: ["x.y.z", ["Not Implemented"]], id: null },
            { reply: [], id: null },
        ]);
    });

    it("checks call arguments the way the bridge marshals them and an sd-bus service checks them", async () => {
        await start(systemdScenario);
        const client = systemd();
        const call = (args: unknown[], options: JsonObject = {}) =>
            client.call(SYSTEMD_PATH, MANAGER, "GetUnit", args, options);
        await expect(call(["sshd.service"])).resolves.toEqual([SSHD_PATH]);
        // The service expects 's': no arguments at all, or an 'i' the client asked for.
        await expect(call([])).rejects.toMatchObject({
            name: "org.freedesktop.DBus.Error.InvalidArgs",
            message: "Invalid arguments '' to call org.freedesktop.systemd1.Manager.GetUnit(), expecting 's'.",
        });
        await expect(call([5], { type: "i" })).rejects.toMatchObject({
            name: "org.freedesktop.DBus.Error.InvalidArgs",
            message: "Invalid arguments 'i' to call org.freedesktop.systemd1.Manager.GetUnit(), expecting 's'.",
        });
        // The bridge itself cannot marshal these against the introspected 's'.
        const wrongType = await settle(call([5])).catch((error: { name: string, message: string }) => error);
        expect(wrongType).toMatchObject({ name: "python.error" });
        expect((wrongType as { message: string }).message)
            .toMatch(/TypeError: descriptor 'encode' for 'str' objects doesn't apply to a 'int' object\n$/);
        const tooMany = await settle(call(["a", "b"])).catch((error: { message: string }) => error);
        expect((tooMany as { message: string }).message)
            .toMatch(/AssertionError: call args \('a', 'b'\) have different length than signature s\n$/);
        client.close();
    });

    it("introspects per channel: once an interface is known, a call reaches the service", async () => {
        await start({
            dbus: { system: { [SSHD_PATH]: { [UNIT]: { properties: { Id: "sshd.service" }, methods: { Start: { in: ["s"], reply: ["/job/3"] } } } } } },
        });
        const channel = open({ payload: "dbus-json3", bus: "system", name: SYSTEMD });
        const rec = record(channel);
        const NOPE = "/org/freedesktop/systemd1/unit/nope";
        channel.send(JSON.stringify({ call: [NOPE, UNIT, "Start", ["replace"]], id: "1" }));
        channel.send(JSON.stringify({ watch: { path: SSHD_PATH, interface: UNIT }, id: "w" }));
        channel.send(JSON.stringify({ call: [NOPE, UNIT, "Start", ["replace"]], id: "2" }));
        await until(() => rec.json().some(m => m.id === "2"));
        const answers = rec.json().filter(m => m.error);
        expect(answers).toEqual([
            { error: ["org.freedesktop.DBus.Error.UnknownMethod",
                ["Introspection data for method org.freedesktop.systemd1.Unit Start not available"]], id: "1" },
            { error: ["org.freedesktop.DBus.Error.UnknownObject", [`Unknown object '${NOPE}'.`]], id: "2" },
        ]);
    });

    it("delivers signals only through matching add-match rules", async () => {
        const bridge = await start(systemdScenario);
        const client = systemd();
        const jobs: unknown[][] = [];
        const created: unknown[][] = [];
        const changedA: unknown[] = [];
        const changedB: unknown[] = [];
        client.subscribe({ interface: MANAGER, member: "JobRemoved" }, (_p, _i, _s, args) => jobs.push(args));
        client.subscribe({ interface: MANAGER, member: "Changed", arg0: "a" }, (_p, _i, _s, args) => changedA.push(args[0]));
        // These two only register callbacks: no add-match reaches the bridge,
        // so it must not deliver what they would match. The library filters
        // locally too, so only the bridge can be responsible for an absence.
        client.subscribe({ interface: MANAGER, member: "UnitNew" }, (_p, _i, _s, args) => created.push(args), false);
        client.subscribe({ interface: MANAGER, member: "Changed", arg0: "b" }, (_p, _i, _s, args) => changedB.push(args[0]), false);

        await client.call(SYSTEMD_PATH, MANAGER, "StartUnit", ["sshd.service", "replace"]);
        await client.call(SYSTEMD_PATH, MANAGER, "Announce", []);
        // A final round trip: anything the bridge sent before it has arrived.
        await client.call(SYSTEMD_PATH, MANAGER, "Reload", []);
        await until(() => jobs.length);

        expect(jobs).toEqual([[1, "/org/freedesktop/systemd1/job/1", "sshd.service", "done"]]);
        expect(created).toEqual([]);
        expect(changedA).toEqual(["a"]);
        expect(changedB).toEqual([]);

        const matches = bridge.received().flatMap(entry => (entry.data?.includes("add-match") ? [JSON.parse(entry.data)] : []));
        expect(matches).toEqual([
            { "add-match": { interface: MANAGER, member: "JobRemoved" } },
            { "add-match": { interface: MANAGER, member: "Changed", arg0: "a" } },
        ]);
        client.close();
    });

    it("routes the call, its arguments, and argument-specific errors", async () => {
        const bridge = await start(systemdScenario);
        const client = systemd();
        await expect(client.call(SYSTEMD_PATH, MANAGER, "StartUnit", ["sshd.service", "replace"]))
            .resolves.toEqual(["/org/freedesktop/systemd1/job/1"]);
        await expect(client.call(SYSTEMD_PATH, MANAGER, "StartUnit", ["broken.service", "replace"]))
            .rejects.toMatchObject({ name: "org.freedesktop.systemd1.NoSuchUnit", message: "Unit broken.service not found." });

        const calls = bridge.received().flatMap(entry => {
            const message = entry.data ? JSON.parse(entry.data) as JsonObject : null;
            return message?.call ? [message.call] : [];
        });
        expect(calls).toEqual([
            [SYSTEMD_PATH, MANAGER, "StartUnit", ["sshd.service", "replace"]],
            [SYSTEMD_PATH, MANAGER, "StartUnit", ["broken.service", "replace"]],
        ]);
        client.close();
    });

    it("gives up on a call after its timeout with NoReply", async () => {
        await start(systemdScenario);
        const client = systemd();
        await expect(client.call(SYSTEMD_PATH, MANAGER, "Slow", [], { timeout: 50 }))
            .rejects.toMatchObject({ name: "org.freedesktop.DBus.Error.NoReply", message: "Method call timed out" });
        await expect(client.call(SYSTEMD_PATH, MANAGER, "Slow", [], { timeout: 2000 })).resolves.toEqual([]);
        client.close();
    });

    it("updates proxies from property effects, after the reply unless asked otherwise", async () => {
        await start(systemdScenario);
        const client = systemd();
        const unit = client.proxy(UNIT, SSHD_PATH);
        await unit.wait();
        expect(unit.ActiveState).toBe("inactive");

        const active = new Promise<void>(resolve => {
            unit.addEventListener("changed", (() => {
                if (unit.ActiveState === "active")
                    resolve();
            }) as never);
        });
        await client.call(SYSTEMD_PATH, MANAGER, "StartUnit", ["sshd.service", "replace"]);
        expect(unit.ActiveState).toBe("inactive"); // the effect has a 20ms delay
        await active;
        expect(unit.ActiveState).toBe("active");

        // beforeReply: the change is visible by the time the call resolves.
        await client.call(SYSTEMD_PATH, MANAGER, "StopUnit", ["sshd.service", "replace"]);
        expect(unit.ActiveState).toBe("inactive");

        // Properties.Get sees the tree as the effects left it.
        await expect(client.call(SSHD_PATH, PROPERTIES, "Get", [UNIT, "ActiveState"]))
            .resolves.toEqual([{ t: "s", v: "inactive" }]);
        client.close();
    });

    it("implements Properties Get, GetAll and Set against the tree, with sd-bus's errors", async () => {
        await start(systemdScenario);
        const client = systemd();
        await expect(client.call(SYSTEMD_PATH, PROPERTIES, "GetAll", [MANAGER])).resolves.toEqual([{
            Version: { t: "s", v: "255" }, NFailedUnits: { t: "u", v: 0 }, LogLevel: { t: "s", v: "info" },
        }]);

        const manager = client.proxy(MANAGER, SYSTEMD_PATH);
        await manager.wait();
        const changed = new Promise<void>(resolve => {
            manager.addEventListener("changed", (() => {
                if (manager.LogLevel === "debug")
                    resolve();
            }) as never);
        });
        await client.call(SYSTEMD_PATH, PROPERTIES, "Set", [MANAGER, "LogLevel", { t: "s", v: "debug" }]);
        await changed;
        await expect(client.call(SYSTEMD_PATH, PROPERTIES, "Get", [MANAGER, "LogLevel"]))
            .resolves.toEqual([{ t: "s", v: "debug" }]);

        // Only "writable" properties may be set, and only with their own type.
        await expect(client.call(SYSTEMD_PATH, PROPERTIES, "Set", [MANAGER, "NFailedUnits", { t: "u", v: 3 }]))
            .rejects.toMatchObject({ name: "org.freedesktop.DBus.Error.PropertyReadOnly", message: "Property 'NFailedUnits' is not writable." });
        await expect(client.call(SYSTEMD_PATH, PROPERTIES, "Set", [MANAGER, "LogLevel", { t: "u", v: 3 }]))
            .rejects.toMatchObject({
                name: "org.freedesktop.DBus.Error.InvalidArgs",
                message: "Incorrect parameters for property 'LogLevel', expected 's', got 'u'.",
            });
        await expect(client.call(SYSTEMD_PATH, PROPERTIES, "Get", [MANAGER, "Nope"])).rejects.toMatchObject({
            name: "org.freedesktop.DBus.Error.UnknownProperty",
            message: "Unknown interface org.freedesktop.systemd1.Manager or property Nope.",
        });
        await expect(client.call(SYSTEMD_PATH, PROPERTIES, "Get", ["org.example.Nope", "X"])).rejects.toMatchObject({
            name: "org.freedesktop.DBus.Error.UnknownProperty", message: "Unknown interface org.example.Nope or property X.",
        });
        await expect(client.call(SYSTEMD_PATH, PROPERTIES, "GetAll", ["org.example.Nope"])).rejects.toMatchObject({
            name: "org.freedesktop.DBus.Error.UnknownInterface", message: "Unknown interface 'org.example.Nope'.",
        });
        client.close();

        // The bridge's own objects (systemd_ctypes) leave such a Set unhandled.
        const internal = cockpit.dbus(null, { bus: "internal" }) as unknown as DBusClient;
        await expect(internal.call("/superuser", PROPERTIES, "Set", ["cockpit.Superuser", "Current", { t: "s", v: "x" }]))
            .rejects.toMatchObject({
                name: "org.freedesktop.DBus.Error.UnknownProperty", message: "Unknown interface cockpit.Superuser or property Current.",
            });
        internal.close();
    });

    it("sends PropertiesChanged as notify to watchers and as a signal to matching rules", async () => {
        await start(systemdScenario);
        const channel = open({ payload: "dbus-json3", bus: "system", name: SYSTEMD });
        const rec = record(channel);
        channel.send(JSON.stringify({ "add-match": { path: SSHD_PATH, interface: PROPERTIES } }));
        channel.send(JSON.stringify({ watch: { path: SSHD_PATH }, id: "w" }));
        channel.send(JSON.stringify({ call: [SYSTEMD_PATH, MANAGER, "StopUnit", ["sshd.service", "replace"]], id: "c" }));
        await until(() => rec.json().some(m => m.id === "c"));

        expect(rec.json().slice(1)).toEqual([
            // Meta comes from introspection: the standard interfaces are in it.
            { meta: {
                ...STANDARD_META,
                [UNIT]: {
                    methods: {},
                    properties: { Id: { flags: "r", type: "s" }, ActiveState: { flags: "r", type: "s" } },
                    signals: {},
                },
            } },
            { notify: { [SSHD_PATH]: { [UNIT]: { Id: "sshd.service", ActiveState: "inactive" } } } },
            { reply: [], id: "w" },
            // beforeReply effect: plain values to the watch, variants in the signal
            { notify: { [SSHD_PATH]: { [UNIT]: { ActiveState: "inactive" } } } },
            { signal: [SSHD_PATH, PROPERTIES, "PropertiesChanged", [UNIT, { ActiveState: { t: "s", v: "inactive" } }, []]] },
            { reply: [["/org/freedesktop/systemd1/job/2"]], id: "c", flags: null, type: "s" },
        ]);
        channel.close();
    });

    it("answers a watch on a missing object with only UnknownObject, as sd-bus services do", async () => {
        await start(systemdScenario);
        const NOPE = "/org/freedesktop/systemd1/unit/nope";
        const channel = open({ payload: "dbus-json3", bus: "system", name: SYSTEMD });
        const rec = record(channel);
        channel.send(JSON.stringify({ watch: { path: NOPE }, id: "m1" }));
        channel.send(JSON.stringify({ call: [SYSTEMD_PATH, MANAGER, "Reload", []], id: "after" }));
        await until(() => rec.json().some(m => m.id === "after"));
        expect(rec.json().slice(1, -1)).toEqual([
            { error: ["org.freedesktop.DBus.Error.UnknownObject", [`Unknown object '${NOPE}'.`]], id: "m1" },
        ]);

        const client = systemd();
        await expect(client.proxy(UNIT, NOPE).wait()).rejects.toMatchObject({ name: "org.freedesktop.DBus.Error.UnknownObject" });
        client.close();
    });

    it("watches a namespace through its ObjectManager, including added and removed objects", async () => {
        await start(systemdScenario);
        const client = systemd();
        const units = client.proxies(UNIT, SYSTEMD_PATH);
        await units.wait();
        expect(Object.keys(units).filter(key => key.startsWith("/"))).toEqual([SSHD_PATH]);

        const events: string[] = [];
        units.addEventListener("added", ((_ev: unknown, proxy: DBusProxy) => events.push(`added ${String(proxy.Id)}`)) as never);
        units.addEventListener("removed", ((_ev: unknown, proxy: DBusProxy) => events.push(`removed ${String(proxy.Id)}`)) as never);
        await client.call(SYSTEMD_PATH, MANAGER, "AddUnit", []);
        await until(() => events.length >= 1);
        await client.call(SYSTEMD_PATH, MANAGER, "RemoveUnit", []);
        await until(() => events.length >= 2);
        expect(events).toEqual(["added new.service", "removed sshd.service"]);
        client.close();
    });

    it("announces added and removed objects in the real bridge's shapes", async () => {
        await start(systemdScenario);
        const channel = open({ payload: "dbus-json3", bus: "system", name: SYSTEMD });
        const rec = record(channel);
        const NEW_PATH = "/org/freedesktop/systemd1/unit/new_2eservice";
        channel.send(JSON.stringify({ "add-match": { path: SYSTEMD_PATH, interface: "org.freedesktop.DBus.ObjectManager" } }));
        channel.send(JSON.stringify({ watch: { path_namespace: SYSTEMD_PATH, interface: UNIT }, id: "w" }));
        channel.send(JSON.stringify({ call: [SYSTEMD_PATH, MANAGER, "AddUnit", []], id: "a" }));
        channel.send(JSON.stringify({ call: [SYSTEMD_PATH, MANAGER, "RemoveUnit", []], id: "r" }));
        await until(() => rec.json().length >= 11); // the owner, then the ten below

        const unitMeta = {
            methods: {},
            properties: { Id: { flags: "r", type: "s" }, ActiveState: { flags: "r", type: "s" } },
            signals: {},
        };
        expect(rec.json().slice(1)).toEqual([
            // The watched root has no Unit interface itself: null. The managed
            // objects bring the real meta.
            { meta: { [UNIT]: unitMeta } },
            { notify: { [SSHD_PATH]: { [UNIT]: { Id: "sshd.service", ActiveState: "inactive" } } } },
            { reply: [], id: "w" },
            { reply: [[]], id: "a", flags: null, type: "" },
            // The interface is not new to this channel, so the meta is empty.
            { meta: {} },
            { notify: { [NEW_PATH]: { [UNIT]: { Id: "new.service" } } } },
            { signal: [SYSTEMD_PATH, "org.freedesktop.DBus.ObjectManager", "InterfacesAdded",
                [NEW_PATH, { [UNIT]: { Id: { t: "s", v: "new.service" } } }]] },
            { reply: [[]], id: "r", flags: null, type: "" },
            { notify: { [SSHD_PATH]: { [UNIT]: null } } },
            { signal: [SYSTEMD_PATH, "org.freedesktop.DBus.ObjectManager", "InterfacesRemoved", [SSHD_PATH, [UNIT]]] },
        ]);
        channel.close();
    });

    it("fails a namespace watch where there is no ObjectManager, as the real bridge does", async () => {
        await start(systemdScenario);
        const client = systemd();
        await expect(client.proxies(UNIT, "/org/freedesktop/systemd1/unit").wait())
            .rejects.toMatchObject({ name: "org.freedesktop.DBus.Error.UnknownObject" });
        client.close();
    });

    it("never answers a malformed call, and closes on options", async () => {
        await start(systemdScenario);
        const channel = open({ payload: "dbus-json3", bus: "system", name: SYSTEMD });
        const rec = record(channel);
        channel.send(JSON.stringify({ call: [SYSTEMD_PATH, MANAGER, "Reload"], id: "short" }));
        channel.send(JSON.stringify({ call: [SYSTEMD_PATH, MANAGER, "Reload", null], id: "null" }));
        channel.send(JSON.stringify({ call: [SYSTEMD_PATH, MANAGER, "Reload", []], id: "ok" }));
        await until(() => rec.json().some(m => m.id === "ok"));
        expect(rec.json().filter(m => m.id === "short" || m.id === "null")).toEqual([]);

        channel.control({ command: "options", window: { rows: 1, cols: 1 } });
        expect(await rec.closed()).toMatchObject({ problem: "not-supported", message: 'This channel does not implement "options"' });
    });

    it("reports owner changes, and a name nobody owns", async () => {
        await start({ ...systemdScenario, dbusOwners: { system: { "org.example.Gone": null } } });
        const client = systemd({ track: true });
        const owners: unknown[] = [];
        client.addEventListener("owner", ((_ev: unknown, owner: unknown) => owners.push(owner)) as never);
        const closed = new Promise<void>(resolve => client.addEventListener("close", (() => resolve()) as never));
        await client.call(SYSTEMD_PATH, MANAGER, "Restart", []);
        // With track: true the library closes the client when the owner changes.
        await closed;
        expect(owners).toEqual([":1.42", ":1.99"]);

        const gone = cockpit.dbus("org.example.Gone", { bus: "system" }) as unknown as DBusClient;
        await expect(gone.call("/", "org.example.Gone", "Ping", [])).rejects.toMatchObject({ problem: "not-found" });
    });

    it("refuses superuser channels until the cockpit.Superuser flow escalates", async () => {
        await start({ superuserFlow: { prompts: [], bridges: ["sudo"] } });
        const before = record(open({ payload: "null", superuser: "require" }));
        expect(await before.closed()).toMatchObject({ problem: "access-denied" });

        const superuser = await Superuser.open();
        await superuser.start(async () => null);
        expect(superuser.allowed).toBe(true);

        const after = record(open({ payload: "null", superuser: "require" }));
        await until(() => after.trace().includes("ready"));
    });

    it("keys Methods by label, leaving unlabelled bridges out, when bridges say so", async () => {
        await start({ superuserFlow: { bridges: [{ name: "sudo", label: null }, { name: "pkexec", label: "Polkit" }] } });
        const superuser = await Superuser.open();
        expect(superuser.bridges).toEqual(["sudo", "pkexec"]);
        expect(superuser.methods).toEqual({ Polkit: "Polkit" });
    });

    it("escalates at startup when the init asks, through one authorize challenge", async () => {
        const flow = { prompts: [{ prompt: "Password: " }], password: "s3cr3t", bridges: ["sudo"] };
        const good = await raw({ superuserFlow: flow }, { superuser: { id: "sudo" } });
        const challenge = await good.next(f => f.control?.command === "authorize");
        expect(challenge!.control).toEqual({ command: "authorize", challenge: "plain1:6d6f636b", cookie: "0" });
        good.control({ command: "authorize", cookie: "0", response: "s3cr3t" });
        await good.next(f => f.control?.command === "superuser-init-done");
        good.control({ command: "open", channel: "n", payload: "null", superuser: "require" });
        expect(summary((await good.next(f => f.channel === "n"))!)).toBe("ready");

        const bad = await raw({ superuserFlow: flow }, { superuser: { id: "any" } });
        await bad.next(f => f.control?.command === "authorize");
        bad.control({ command: "authorize", cookie: "0", response: "wrong" });
        await bad.next(f => f.control?.command === "superuser-init-done");
        bad.control({ command: "open", channel: "n", payload: "null", superuser: "require" });
        expect(summary((await bad.next(f => f.channel === "n"))!)).toBe('close {"problem":"access-denied"}');
    });
});

// ---- processes ---------------------------------------------------------------

describe("cockpit.spawn()", () => {
    it("streams chunks as they come, and stays open until closed", async () => {
        const bridge = await start({
            spawn: {
                "journalctl -f": {
                    chunks: [{ data: "one\n" }, { data: "two\n", delayMs: 30 }],
                    keepOpen: true,
                },
            },
        });
        const chunks: string[] = [];
        const proc = cockpit.spawn(["journalctl", "-f"]).stream(data => {
            chunks.push(data);
        });
        await until(() => chunks.length >= 2);
        expect(chunks).toEqual(["one\n", "two\n"]);
        expect(proc.state()).toBe("pending");

        proc.close();
        await proc;
        const channel = bridge.opened("stream")[0]!.channel;
        expect(bridge.controls("close").some(c => c.channel === channel)).toBe(true);
    });

    it("finishes a keepOpen process when the client sends done", async () => {
        await start({ spawn: { "tail -f /var/log/messages": { stdout: "line\n", keepOpen: true, "exit-status": 0 } } });
        await expect(cockpit.spawn(["tail", "-f", "/var/log/messages"]).input()).resolves.toBe("line\n");
    });

    it("handles stderr per the err option, like the real bridge", async () => {
        const result = { stdout: "out\n", stderr: "err\n", "exit-status": 0 };
        const failing = { stdout: "out\n", stderr: "trouble\n", "exit-status": 3 };
        await start({ spawn: { "cmd ok": result, "cmd fail": failing } });

        // default and "message": stderr ends up in the close message
        await expect(settle(cockpit.spawn(["cmd", "ok"]))).resolves.toEqual(["out\n", "err\n"]);
        await expect(settle(cockpit.spawn(["cmd", "ok"], { err: "message" }))).resolves.toEqual(["out\n", "err\n"]);
        await expect(cockpit.spawn(["cmd", "fail"], { err: "message" }))
            .rejects.toMatchObject({ exit_status: 3, message: "trouble", problem: null });
        // "out": merged into the output; the close message is empty
        await expect(settle(cockpit.spawn(["cmd", "ok"], { err: "out" }))).resolves.toEqual(["out\nerr\n", ""]);
        // "ignore": gone
        await expect(settle(cockpit.spawn(["cmd", "ok"], { err: "ignore" }))).resolves.toEqual(["out\n", ""]);
    });

    it("waits for stdin with readInput, and logs what it was fed", async () => {
        const bridge = await start({ superuser: true, spawn: { chpasswd: { readInput: true, stdout: "done\n" } } });
        const proc = cockpit.spawn(["chpasswd"], { superuser: "require" });
        const chunks: string[] = [];
        proc.stream(data => {
            chunks.push(data);
        });
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(chunks).toEqual([]); // nothing until the client says done
        proc.input("alice:s3cr3t\n");
        await proc;
        expect(chunks).toEqual(["done\n"]);
        const opened = bridge.opened("stream")[0]!;
        expect(opened.superuser).toBe("require");
        expect(bridge.sent(opened.channel as string)).toBe("alice:s3cr3t\n");
    });

    it("reports signals as a negative exit status, and spawn failures as problems", async () => {
        await start({
            spawn: {
                "sleep 100": { "exit-signal": "TERM" },
                "nonexistent-tool": { problem: "not-found" },
            },
        });
        await expect(cockpit.spawn(["sleep", "100"])).rejects.toMatchObject({ exit_status: -15, exit_signal: null });
        await expect(cockpit.spawn(["nonexistent-tool"])).rejects.toMatchObject({ problem: "not-found" });
        // Not scripted at all: also not-found, and like a missing command, without a message.
        const channel = record(open({ payload: "stream", spawn: ["unscripted"] }));
        expect(await channel.closed()).toEqual({ problem: "not-found", command: "close", channel: expect.any(String) });
    });

    it("matches spawnPatterns after exact matches", async () => {
        await start({
            spawn: { "systemctl is-active sshd": { stdout: "exact\n" } },
            spawnPatterns: [{ match: "^systemctl is-active ", stdout: "pattern\n" }],
        });
        await expect(cockpit.spawn(["systemctl", "is-active", "sshd"])).resolves.toBe("exact\n");
        await expect(cockpit.spawn(["systemctl", "is-active", "cron"])).resolves.toBe("pattern\n");
    });

    it("passes bytes through on binary channels, and fails text channels on bad UTF-8", async () => {
        await start({
            spawn: {
                "cat blob": { stdout: { base64: Buffer.from([0, 1, 0xff]).toString("base64") } },
                "cat bad": { stdout: { base64: Buffer.from([0x61, 0xff, 0x62]).toString("base64") } },
                "cat split": {
                    chunks: [{ base64: Buffer.from([0xc3]).toString("base64") }, { base64: Buffer.from([0xa9]).toString("base64") }],
                },
            },
        });
        const bytes = await cockpit.spawn(["cat", "blob"], { binary: true });
        expect(Array.from(bytes)).toEqual([0, 1, 0xff]);

        await expect(cockpit.spawn(["cat", "bad"])).rejects.toMatchObject({
            problem: "protocol-error",
            message: "'utf-8' codec can't decode byte 0xff in position 1: invalid start byte",
        });
        // A character split across chunks waits for its tail, as the bridge's
        // incremental decoder does.
        await expect(cockpit.spawn(["cat", "split"])).resolves.toBe("é");
    });

    it("sends what the real decoder sends at the edges of UTF-8", async () => {
        const bytes = (...b: number[]) => ({ base64: Buffer.from(b).toString("base64") });
        const bridge = await raw({
            spawn: {
                truncated: { stdout: bytes(0x61, 0x62, 0xc3) },
                invalid: { stdout: bytes(0x61, 0x62, 0xff) },
                split: { chunks: [{ ...bytes(0xc3) }, { ...bytes(0xa9, 0x0a), delayMs: 50 }] },
            },
        });
        const run = async (name: string) => {
            bridge.control({ command: "open", channel: name, payload: "stream", spawn: [name] });
            await bridge.next(f => f.channel === name && f.control?.command === "close");
            await sleep(50);
            return bridge.of(name).map(f => summary(f).replace(/"pid":\d+/, '"pid":0'));
        };
        // Output ending inside a character: no "done", the close is normal.
        expect(await run("truncated")).toEqual(['ready {"pid":0}', '"ab"', 'close {"exit-status":0,"message":""}']);
        // Invalid bytes close the channel; the process's EOF still sends a stray "done".
        expect(await run("invalid")).toEqual(['ready {"pid":0}',
            `close {"message":"'utf-8' codec can't decode byte 0xff in position 2: invalid start byte","problem":"protocol-error"}`,
            "done"]);
        // The first half of a character is sent as an empty frame.
        expect(await run("split")).toEqual(['ready {"pid":0}', '""', '"é\\n"', "done", 'close {"exit-status":0,"message":""}']);
    });

    it("closes a running process with the stderr it wrote so far", async () => {
        const bridge = await raw({ spawn: { worker: { stderr: "err\n", keepOpen: true } } });
        bridge.control({ command: "open", channel: "w", payload: "stream", spawn: ["worker"] });
        await bridge.next(f => f.channel === "w" && f.control?.command === "ready");
        await sleep(20);
        bridge.control({ command: "close", channel: "w" });
        const close = await bridge.next(f => f.channel === "w" && f.control?.command === "close");
        expect(close!.control).toEqual({ "exit-status": null, message: "err\n", command: "close", channel: "w" });
    });

    it("checks directory and environ the way the real create_transport() does", async () => {
        await start({ files: { "/srv/app/": {} }, spawn: { pwd: { stdout: "ok\n" } } });
        await expect(cockpit.spawn(["pwd"], { directory: "/nonexistent-dir" })).rejects.toMatchObject({ problem: "not-found" });
        await expect(cockpit.spawn(["pwd"], { environ: ["NOEQUALS"] })).rejects.toMatchObject({
            problem: "protocol-error", message: 'invalid "environ" option for stream channel',
        });
        // Directories that exist: declared ones, the usual ones, the user's home.
        for (const directory of ["/srv/app", "/tmp", "/home/mock"])
            await expect(cockpit.spawn(["pwd"], { directory, environ: ["A=1"] })).resolves.toBe("ok\n");
    });

    it("never answers an open whose options fail inside create_transport()", async () => {
        const bridge = await raw({ spawn: { ls: { stdout: "x\n" } } });
        bridge.control({ command: "open", channel: "x", payload: "stream", spawn: ["ls"], err: "bogus" });
        bridge.control({ command: "open", channel: "y", payload: "stream", spawn: ["ls"] });
        await bridge.next(f => f.channel === "y" && f.control?.command === "close");
        await sleep(100);
        expect(bridge.of("x")).toEqual([]);
        expect(bridge.stderr()).toContain("attribute 'err': invalid value \"bogus\"");
    });

    it("closes channels on a kill, by group", async () => {
        const bridge = await raw({ spawn: { "sleep 5": { keepOpen: true } } });
        bridge.control({ command: "open", channel: "g", payload: "stream", spawn: ["sleep", "5"], group: "g1" });
        bridge.control({ command: "open", channel: "n", payload: "null" });
        await bridge.next(f => f.channel === "n" && f.control?.command === "ready");
        bridge.control({ command: "kill", host: "otherhost" }); // channels ignore a kill for a host
        bridge.control({ command: "kill", group: "g1" });
        const killed = await bridge.next(f => f.channel === "g" && f.control?.command === "close");
        expect(killed!.control).toEqual({ "exit-status": null, message: "", command: "close", channel: "g" });
        await sleep(50);
        expect(bridge.of("n").map(summary)).toEqual(["ready"]);
        bridge.control({ command: "kill" });
        expect(summary((await bridge.next(f => f.channel === "n" && f.control?.command === "close"))!)).toBe("close");
    });
});

// ---- protocol mistakes ---------------------------------------------------------

describe("protocol mistakes, punished like the real bridge does", () => {
    /**
     * Is the bridge still processing frames? An echo channel gets ready, or
     * not. Expecting "alive", wait longer: a busy machine must not look wedged.
     */
    async function alive(bridge: RawBridge, id: string, timeoutMs = 300) {
        bridge.control({ command: "open", channel: id, payload: "echo" });
        return Boolean(await bridge.next(f => f.channel === id && f.control?.command === "ready", timeoutMs));
    }

    it("wedges on data after the client's done on a pipe, but the process still finishes", async () => {
        const bridge = await raw({ spawn: { slow: { readInput: true, chunks: [{ data: "x", delayMs: 300 }] } } });
        bridge.control({ command: "open", channel: "s", payload: "stream", spawn: ["slow"] });
        await bridge.next(f => f.channel === "s" && f.control?.command === "ready");
        // What cockpit.spawn().input() does when called twice.
        bridge.send("s", "one");
        bridge.control({ command: "done", channel: "s" });
        bridge.send("s", "two");
        expect(await alive(bridge, "e")).toBe(false);
        expect(bridge.stderr()).toMatch(/WEDGED: a data frame on stream channel s after the client's "done"/);
        expect((await bridge.next(f => f.channel === "s" && f.control?.command === "close"))!.control)
            .toMatchObject({ "exit-status": 0 });
    });

    it("wedges on a second done on a pipe", async () => {
        const bridge = await raw({ spawn: { slow: { readInput: true, chunks: [{ data: "x", delayMs: 300 }] } } });
        bridge.control({ command: "open", channel: "s", payload: "stream", spawn: ["slow"] });
        bridge.control({ command: "done", channel: "s" });
        bridge.control({ command: "done", channel: "s" });
        expect(await alive(bridge, "e")).toBe(false);
    });

    it("wedges on a window resize for a stream without a pty", async () => {
        const bridge = await raw({ spawn: { sh: { keepOpen: true } } });
        bridge.control({ command: "open", channel: "s", payload: "stream", spawn: ["sh"] });
        expect(await alive(bridge, "e1", 1500)).toBe(true);
        bridge.control({ command: "options", channel: "s", window: { rows: 30, cols: 100 } });
        expect(await alive(bridge, "e2")).toBe(false);
        expect(bridge.stderr()).toMatch(/WEDGED: .*which has no pty/);
    });

    it("wedges on a dbus-json3 frame that is not exactly one JSON document", async () => {
        const bridge = await raw();
        bridge.control({ command: "open", channel: "d", payload: "dbus-json3", bus: "internal" });
        await bridge.next(f => f.channel === "d" && f.control?.command === "ready");
        const get = (id: string) => JSON.stringify({
            call: ["/superuser", PROPERTIES, "Get", ["cockpit.Superuser", "Current"]], id, type: "ss",
        });
        bridge.send("d", `${get("a")}\n${get("b")}`);
        expect(await alive(bridge, "e")).toBe(false);
        bridge.send("d", get("c"));
        await sleep(100);
        expect(bridge.of("d").filter(f => f.data)).toEqual([]);
    });

    it("exits with status 1 on a transport-level ping, sending nothing", async () => {
        const bridge = await raw();
        bridge.control({ command: "open", channel: "n", payload: "null" });
        await bridge.next(f => f.channel === "n" && f.control?.command === "ready");
        const count = bridge.frames.length;
        bridge.control({ command: "ping" });
        expect(await bridge.exited).toEqual({ code: 1, signal: null });
        expect(bridge.frames).toHaveLength(count);
        expect(bridge.stderr()).toContain("unexpected control message ping received");
    });

    it("closes every open channel on stdin EOF before it exits", async () => {
        const bridge = await raw({ spawn: { job: { stderr: "e\n", keepOpen: true } } });
        bridge.control({ command: "open", channel: "n", payload: "null" });
        bridge.control({ command: "open", channel: "j", payload: "stream", spawn: ["job"] });
        await bridge.next(f => f.channel === "j" && f.control?.command === "ready");
        await sleep(20); // let the process write its stderr
        bridge.end();
        expect(await bridge.exited).toEqual({ code: 0, signal: null });
        expect(bridge.of("n").map(summary)).toEqual(["ready", "close"]);
        expect(bridge.of("j").map(f => summary(f).replace(/"pid":\d+/, '"pid":0')))
            .toEqual(['ready {"pid":0}', 'close {"exit-status":null,"message":"e\\n"}']);
    });

    it("answers info with ready, one pretty JSON message, done and close", async () => {
        const bridge = await raw();
        bridge.control({ command: "open", channel: "i", payload: "info" });
        await bridge.next(f => f.channel === "i" && f.control?.command === "close");
        const frames = bridge.of("i");
        expect(frames.map(f => (f.data ? "data" : f.control!.command))).toEqual(["ready", "data", "done", "close"]);
        const text = frames[1]!.data!.toString("utf8");
        expect(text).toMatch(/^\{\n {2}"channels": \{\n/);
        expect(text.endsWith("}\n")).toBe(true);
        const info = JSON.parse(text) as { channels: JsonObject, user: JsonObject };
        expect(Object.keys(info)).toEqual(["channels", "os_release", "user"]);
        expect(info.channels.fsreplace1).toEqual(["attrs"]);
        expect(Object.keys(info.user)).toEqual(["fullname", "gid", "group", "groups", "home", "name", "shell", "uid"]);
    });

    it("closes an unknown payload with a bare not-supported", async () => {
        const bridge = await raw();
        bridge.control({ command: "open", channel: "u", payload: "no-such-payload" });
        expect((await bridge.next(f => f.channel === "u"))!.control).toEqual({ problem: "not-supported", command: "close", channel: "u" });
    });
});

describe("a pty stream", () => {
    it("echoes like a terminal, records resizes, and exits on the scripted input", async () => {
        const bridge = await start({ spawn: { "/bin/bash -i": { stdout: "Welcome\n$ ", exitOn: "exit\r" } } });
        const terminal = open({
            payload: "stream", spawn: ["/bin/bash", "-i"], pty: true, window: { rows: 24, cols: 80 },
        });
        const rec = record(terminal);
        const output = () => (rec.messages() as string[]).join("");

        // Program output goes through ONLCR.
        await until(() => output() === "Welcome\r\n$ ");

        terminal.send("ls\r");
        await until(() => output().endsWith("ls\r\n"));
        terminal.send("\x03");
        await until(() => output().endsWith("^C"));

        terminal.control({ window: { rows: 40, cols: 100 } });
        const resize = await bridge.waitForReceived(entry => entry.control?.command === "options");
        expect(resize.control).toEqual({ window: { rows: 40, cols: 100 }, command: "options", channel: terminal.id });
        expect(bridge.opened("stream")[0]).toMatchObject({ pty: true, window: { rows: 24, cols: 80 } });

        // done means nothing to a pty (the library itself refuses to send
        // data after done, so go around the channel); the exit command does.
        cockpit.transport.control("done", { channel: terminal.id });
        await bridge.waitForReceived(entry => entry.control?.command === "done");
        terminal.send("exit\r");
        expect(await rec.closed()).toEqual({ "exit-status": 0, message: "", command: "close", channel: terminal.id });
        expect(output()).toBe("Welcome\r\n$ ls\r\n^Cexit\r\n");
    });

    it("edits the line like the tty's line discipline, and answers scripted lines", async () => {
        await start({
            spawn: { sh: { keepOpen: true, replies: [{ line: "^hi$", stdout: "got:hi\n" }] } },
        });
        const terminal = open({ payload: "stream", spawn: ["sh"], pty: true });
        const rec = record(terminal);
        const typed: [string, string][] = [
            ["abc\x15", "abc\b \b\b \b\b \b"],        // ^U erases the line
            ["foo bar\x17", "foo bar\b \b\b \b\b \b"], // ^W erases a word
            ["xy\x12", "xy^R\r\nfoo xy"],             // ^R reprints the line
            ["\x16\x01", "^\b^A"],                     // ^V quotes the next character
            ["\r", "\r\n"],
            ["\x7f", ""],                              // nothing to erase
            ["\x04", ""],                              // ^D on an empty line: EOF, not echoed
            ["q\x08", "q^H"],                          // ^H is not the erase character
        ];
        for (const [input, echo] of typed) {
            const before = rec.messages().join("");
            terminal.send(input);
            if (echo)
                await until(() => rec.messages().join("").length >= before.length + echo.length);
            else
                await sleep(30);
            expect(rec.messages().join("").slice(before.length)).toBe(echo);
        }
        terminal.send("\x15hi\r");
        await until(() => rec.messages().join("").endsWith("got:hi\r\n"));
        terminal.close();
    });
});

describe("http-stream2", () => {
    const SOCK = "/run/user/1000/podman/podman.sock";

    /** A raw http-stream2 request: every control message and data frame it gets back, in order. */
    function request(method: string, path: string, body?: string): Promise<[string, unknown][]> {
        return new Promise(resolve => {
            const frames: [string, unknown][] = [];
            const channel = cockpit.channel({ payload: "http-stream2", unix: SOCK, method, path });
            channel.addEventListener("message", (_event, data) => { frames.push(["data", data]) });
            channel.addEventListener("control", ((_event: unknown, message: JsonObject) => {
                const { channel: _channel, ...rest } = message;
                frames.push(["control", rest]);
            }) as never);
            channel.addEventListener("close", ((_event: unknown, message: JsonObject) => {
                const { channel: _channel, command: _command, ...rest } = message;
                frames.push(["close", rest]);
                resolve(frames);
            }) as never);
            if (body)
                channel.send(body);
            channel.control({ command: "done" });
        });
    }

    it("answers like the real bridge: ready, response, the body, done, a clean close", async () => {
        await start({ http: { [SOCK]: { "GET /v3.4.0/libpod/_ping": { body: "OK", headers: { "Content-Type": "text/plain; charset=utf-8" } } } } });
        expect(await request("GET", "/v3.4.0/libpod/_ping")).toEqual([
            ["control", { command: "ready" }],
            ["control", {
                command: "response", status: 200, reason: "OK",
                headers: { Server: "Libpod/5.8.2 (linux)", "Content-Type": "text/plain; charset=utf-8" },
            }],
            ["data", "OK"],
            ["control", { command: "done" }],
            ["close", {}],
        ]);
    });

    it("sends a JSON body as JSON, and an error status with its body and a clean close", async () => {
        await start({
            http: {
                [SOCK]: {
                    "GET /v3.4.0/libpod/containers/json?all=true": { body: [{ Id: "abc" }] },
                    "GET /v3.4.0/libpod/containers/x/json": { status: 404, body: { cause: "no such container", message: "no container", response: 404 } },
                },
            },
        });
        const http = cockpit.http(SOCK);
        expect(JSON.parse(await http.request({ method: "GET", path: "/v3.4.0/libpod/containers/json", params: { all: "true" }, body: "" })))
                .toEqual([{ Id: "abc" }]);
        const frames = await request("GET", "/v3.4.0/libpod/containers/x/json");
        expect(frames[1]).toEqual(["control", {
            command: "response", status: 404, reason: "Not Found",
            headers: { "Content-Type": "application/json", Server: "Libpod/5.8.2 (linux)" },
        }]);
        expect(JSON.parse(frames[2]![1] as string)).toMatchObject({ cause: "no such container" });
        expect(frames.at(-1)).toEqual(["close", {}]);
        // The library turns that into a rejection carrying the status.
        await expect(http.request({ method: "GET", path: "/v3.4.0/libpod/containers/x/json", body: "" }))
                .rejects.toMatchObject({ status: 404, reason: "Not Found" });
        http.close();
    });

    it("falls back to the route without its query, and words an unknown route as a 404", async () => {
        await start({ http: { [SOCK]: { "DELETE /v3.4.0/libpod/containers/abc": { status: 204 } } } });
        const ok = await request("DELETE", "/v3.4.0/libpod/containers/abc?force=true");
        expect(ok[1]).toMatchObject(["control", { status: 204, reason: "No Content" }]);
        const missing = await request("GET", "/nowhere");
        expect(missing[1]).toMatchObject(["control", { status: 404 }]);
    });

    it("closes not-found when nothing listens on the socket, and with a scripted problem", async () => {
        await start({ http: { "/other.sock": { "GET /": { problem: "access-denied" } } } });
        expect((await request("GET", "/v3.4.0/libpod/info")).at(-1)).toMatchObject(["close", { problem: "not-found" }]);
        const http = cockpit.http("/other.sock");
        await expect(http.request({ method: "GET", path: "/", body: "" })).rejects.toMatchObject({ problem: "access-denied" });
        http.close();
    });

    it("logs the request and its body, and applies effects: routes that change, data on an open stream", async () => {
        const bridge = await start({
            http: {
                [SOCK]: {
                    "GET /v3.4.0/libpod/containers/json?all=true": { body: [{ Id: "abc", State: "running" }] },
                    "GET /v3.4.0/libpod/events": { keepOpen: true },
                    "POST /v3.4.0/libpod/containers/abc/stop": {
                        status: 204,
                        effects: [
                            { http: { [SOCK]: { "GET /v3.4.0/libpod/containers/json?all=true": { body: [{ Id: "abc", State: "exited" }] } } } },
                            { httpData: [SOCK, "GET /v3.4.0/libpod/events", '{"Action":"died"}\n'] },
                        ],
                    },
                },
            },
        });
        const http = cockpit.http(SOCK);
        const events: string[] = [];
        const stream = http.request({ method: "GET", path: "/v3.4.0/libpod/events", body: "" });
        (stream as unknown as { stream(callback: (data: string) => void): unknown }).stream(data => { events.push(data) });
        await sleep(50);

        await http.request({ method: "POST", path: "/v3.4.0/libpod/containers/abc/stop", body: '{"t":1}' });
        await until(() => events.length > 0);
        expect(events).toEqual(['{"Action":"died"}\n']);
        expect(JSON.parse(await http.request({ method: "GET", path: "/v3.4.0/libpod/containers/json", params: { all: "true" }, body: "" })))
                .toEqual([{ Id: "abc", State: "exited" }]);

        const post = bridge.opened("http-stream2").find(open => open.method === "POST")!;
        expect(post).toMatchObject({ unix: SOCK, method: "POST", path: "/v3.4.0/libpod/containers/abc/stop" });
        expect(bridge.sent(post.channel as string)).toBe('{"t":1}');
        http.close();
    });
});
