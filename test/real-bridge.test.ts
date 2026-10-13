/*
 * Validation against a real cockpit-bridge.
 *
 * Everything else in this directory tests against mocks we wrote, which can
 * only ever confirm that our code agrees with our own understanding of the
 * protocol. This file talks to the actual Python bridge, so it is the only
 * place that can catch a misunderstanding.
 *
 * It skips itself when cockpit-bridge is not installed, so the suite still
 * passes on a machine without one. Install it with:
 *
 *     apt install cockpit-bridge      # or: dnf install cockpit-bridge
 *
 * Note what this does *not* cover: systemd, NetworkManager, UDisks2 and friends
 * are not reachable in a container, so the pages built on them still need a
 * real machine.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cockpit from "../src/cockpit.js";
import { localTransport, type StreamTransport } from "../src/transport/stream.js";

const haveBridge = spawnSync("cockpit-bridge", ["--version"], { stdio: "ignore" }).status === 0;

let active: StreamTransport | null = null;

async function connect(): Promise<StreamTransport> {
    const transport = localTransport({ onStderr: () => {} });
    transport.install();
    active = transport;
    await transport.connect();
    return transport;
}

afterEach(() => {
    active?.close();
    active = null;
});

type Control = Record<string, unknown>;

/** Collect a channel's messages until it closes. */
function drain(channel: unknown): Promise<{ data: (string | Uint8Array)[], options: Control }> {
    const ch = channel as {
        addEventListener(event: string, handler: (...args: never[]) => void): void;
    };
    return new Promise(resolve => {
        const data: (string | Uint8Array)[] = [];
        ch.addEventListener("message", ((_event: unknown, payload: string | Uint8Array) => {
            data.push(payload);
        }) as never);
        ch.addEventListener("close", ((_event: unknown, options: Control) => {
            resolve({ data, options });
        }) as never);
    });
}

describe.skipIf(!haveBridge)("against a real cockpit-bridge", () => {
    it("completes the init handshake", async () => {
        const transport = await connect();
        expect(transport.ready).toBe(true);
    });

    it("reports the payload types our pages depend on", async () => {
        await connect();
        await cockpit.init();
        const channels = Object.keys(cockpit.info.channels);
        // The set the core tier is built on. A bridge missing any of these
        // would break pages in ways that are hard to diagnose later.
        for (const required of ["dbus-json3", "stream", "fsread1", "fsreplace1", "fsinfo", "metrics1", "null", "echo"])
            expect(channels, required).toContain(required);
    });

    it("fills cockpit.info with real host details", async () => {
        await connect();
        await cockpit.init();
        expect(cockpit.info.os_release.ID).toBeTruthy();
        expect(cockpit.info.user.name).toBe(process.env.USER ?? cockpit.info.user.name);
        expect(cockpit.info.user.uid).toBe(process.getuid?.());
    });

    it("round-trips an echo channel", async () => {
        await connect();
        const channel = cockpit.channel({ payload: "echo" });
        const received = new Promise<string>(resolve => {
            channel.addEventListener("message", ((_event: unknown, data: string) => resolve(data)) as never);
        });
        channel.send("hello real bridge");
        expect(await received).toBe("hello real bridge");
        channel.close();
    });
});

describe.skipIf(!haveBridge)("cockpit.spawn() against a real bridge", () => {
    it("returns stdout", async () => {
        await connect();
        await expect(cockpit.spawn(["echo", "hello"])).resolves.toBe("hello\n");
    });

    it("rejects with the exit status, which is not a protocol problem", async () => {
        await connect();
        // The bridge reports this in the close message's `exit-status`, with no
        // `problem` set; turning that into a rejection is the library's job.
        const error = await cockpit.spawn(["sh", "-c", "exit 3"]).catch((e: unknown) => e) as
            { exit_status?: number, problem?: string | null };
        expect(error.exit_status).toBe(3);
        expect(error.problem).toBeFalsy();
    });

    it("reports a negative exit status when the process is signal-killed", async () => {
        await connect();
        const error = await cockpit.spawn(["sh", "-c", "kill -TERM $$"]).catch((e: unknown) => e) as
            { exit_status?: number };
        expect(error.exit_status).toBeLessThan(0);
    });

    it("surfaces a missing binary as not-found", async () => {
        await connect();
        const error = await cockpit.spawn(["definitely-not-a-real-command-xyz"]).catch((e: unknown) => e) as
            { problem?: string };
        expect(error.problem).toBe("not-found");
    });

    it("captures stderr when asked to", async () => {
        await connect();
        const error = await cockpit
            .spawn(["sh", "-c", "echo trouble >&2; exit 1"], { err: "message" } as never)
            .catch((e: unknown) => e) as { message?: string };
        expect(error.message).toContain("trouble");
    });
});

describe.skipIf(!haveBridge)("files against a real bridge", () => {
    let dir = "";

    afterEach(() => {
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
            dir = "";
        }
    });

    it("reads a file through fsread1", async () => {
        dir = mkdtempSync(join(tmpdir(), "cockpit-tui-"));
        const path = join(dir, "read.txt");
        writeFileSync(path, "from disk\n");

        await connect();
        await expect(cockpit.file(path).read()).resolves.toBe("from disk\n");
    });

    it("reports a missing file as null rather than an error", async () => {
        dir = mkdtempSync(join(tmpdir(), "cockpit-tui-"));
        await connect();
        await expect(cockpit.file(join(dir, "absent")).read()).resolves.toBeNull();
    });

    it("writes a file through fsreplace1", async () => {
        dir = mkdtempSync(join(tmpdir(), "cockpit-tui-"));
        const path = join(dir, "write.txt");

        await connect();
        const file = cockpit.file(path);
        await file.replace("written by cockpit-tui\n");
        // Read it back off the filesystem, not through the bridge, so this
        // proves the bytes actually landed.
        expect(readFileSync(path, "utf8")).toBe("written by cockpit-tui\n");
    });

    it("hands binary channels a Uint8Array, not a Buffer", async () => {
        dir = mkdtempSync(join(tmpdir(), "cockpit-tui-"));
        const path = join(dir, "bytes.bin");
        writeFileSync(path, Buffer.from([0, 1, 2, 253, 254, 255]));

        await connect();
        // `binary: true` in the JS API becomes `binary: "raw"` on the wire; the
        // transport tracks that so the payload arrives as bytes. Buffer would
        // pass an instanceof check but decodes differently under toString().
        const channel = cockpit.channel({ payload: "fsread1", path, binary: true } as never);
        const { data } = await drain(channel);
        const bytes = data[0] as Uint8Array;
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(Buffer.isBuffer(bytes)).toBe(false);
        expect(Array.from(bytes)).toEqual([0, 1, 2, 253, 254, 255]);
    });

    it("describes a path through fsinfo", async () => {
        dir = mkdtempSync(join(tmpdir(), "cockpit-tui-"));
        await connect();
        const channel = cockpit.channel(
            { payload: "fsinfo", path: dir, attrs: ["type"], watch: false } as never);
        const { data } = await drain(channel);
        const state = JSON.parse((data[0] as string)) as { info?: { type?: string } };
        expect(state.info?.type).toBe("dir");
    });
});

describe.skipIf(!haveBridge)("metrics against a real bridge", () => {
    it("delivers samples from the internal source", async () => {
        await connect();
        const channel = cockpit.channel({
            payload: "metrics1",
            source: "internal",
            interval: 200,
            metrics: [{ name: "memory.used" }],
        } as never);

        const samples = await new Promise<unknown[]>(resolve => {
            const collected: unknown[] = [];
            channel.addEventListener("message", ((_event: unknown, payload: string) => {
                collected.push(JSON.parse(payload));
                // The first message is the metadata envelope; the rest are data.
                if (collected.length === 2)
                    resolve(collected);
            }) as never);
        });

        const meta = samples[0] as { metrics?: unknown[], interval?: number };
        expect(meta.interval).toBe(200);
        expect(meta.metrics).toHaveLength(1);
        // Samples are arrays of arrays: one row per instant, one value per metric.
        expect(Array.isArray(samples[1])).toBe(true);
        channel.close();
    });
});

describe.skipIf(!haveBridge)("the internal D-Bus bus against a real bridge", () => {
    it("exposes cockpit.Superuser with the properties the escalation flow reads", async () => {
        await connect();
        const dbus = cockpit.dbus(null as never, { bus: "internal" } as never);
        const proxy = dbus.proxy("cockpit.Superuser", "/superuser") as unknown as {
            wait(): Promise<void>, valid: boolean,
            Bridges: string[], Current: string, Methods: Record<string, unknown>,
        };
        await proxy.wait();

        expect(proxy.valid).toBe(true);
        expect(Array.isArray(proxy.Bridges)).toBe(true);
        // "none" until something escalates. Bridges is empty unless a package
        // manifest declares a privileged bridge, which cockpit-bridge alone
        // does not -- so assert the shape, not the contents.
        expect(typeof proxy.Current).toBe("string");
        expect(typeof proxy.Methods).toBe("object");
        dbus.close();
    });

    it("rejects a privileged channel when nothing has escalated", async () => {
        await connect();
        const channel = cockpit.channel({ payload: "null", superuser: "require" } as never);
        const { options } = await drain(channel);
        // Only "require" hard-fails; "try" would silently run unprivileged.
        expect(options.problem).toBe("access-denied");
    });
});
