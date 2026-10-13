import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import cockpit from "../src/cockpit.js";
import { StreamTransport } from "../src/transport/stream.js";

const MOCK = fileURLToPath(new URL("./mock-bridge/bridge.mjs", import.meta.url));

interface Scenario {
    version?: number;
    noInit?: boolean;
    initProblem?: string;
    superuser?: boolean;
    spawn?: Record<string, { "exit-status"?: number, stdout?: string, message?: string }>;
    dbus?: Record<string, unknown>;
}

let active: StreamTransport | null = null;

async function connect(scenario: Scenario = {}): Promise<StreamTransport> {
    const transport = new StreamTransport(["node", MOCK], {
        env: { COCKPIT_MOCK_SCENARIO: JSON.stringify(scenario) },
        onStderr: () => {}, // the mock is quiet; swallow anything stray
    });
    transport.install();
    active = transport;
    await transport.connect();
    return transport;
}

afterEach(() => {
    active?.close();
    active = null;
});

describe("stream transport against a mock bridge", () => {
    it("completes the init handshake and becomes ready", async () => {
        const transport = await connect();
        expect(transport.ready).toBe(true);
    });

    it("reports the bridge's host as the default host", async () => {
        await connect();
        // The library records this from our init reply for later `open`s.
        expect(cockpit.transport.host).toBeDefined();
    });

    it("rejects a bridge claiming an unsupported protocol version", async () => {
        await expect(connect({ version: 2 })).rejects.toThrow(/not-supported/);
    });

    it("fails cleanly when the bridge dies before init", async () => {
        const transport = new StreamTransport(["node", "-e", "process.exit(3)"], { onStderr: () => {} });
        transport.install();
        active = transport;
        await expect(transport.connect()).rejects.toThrow(/terminated|exited/);
    });

    it("surfaces a missing bridge binary as not-found", async () => {
        const transport = new StreamTransport(["definitely-not-a-real-bridge-xyz"], { onStderr: () => {} });
        transport.install();
        active = transport;
        await expect(transport.connect()).rejects.toThrow(/not-found/);
    });
});

describe("channels through the vendored library", () => {
    it("round-trips data on an echo channel", async () => {
        await connect();
        const channel = cockpit.channel({ payload: "echo" });
        const received = await new Promise<string>((resolve, reject) => {
            channel.addEventListener("message", (_ev: unknown, data: string) => resolve(data));
            channel.addEventListener("close", (_ev: unknown, options: { problem?: string }) => {
                if (options.problem) reject(new Error(options.problem));
            });
            channel.send("hello bridge");
        });
        expect(received).toBe("hello bridge");
        channel.close();
    });

    it("refuses a privileged channel when no root bridge is running", async () => {
        await connect({ superuser: false });
        const channel = cockpit.channel({ payload: "null", superuser: "require" });
        const problem = await new Promise<string | undefined>(resolve => {
            channel.addEventListener("close", (_ev: unknown, options: { problem?: string }) =>
                resolve(options.problem));
        });
        // Only "require" hard-fails; "try" would silently run unprivileged.
        expect(problem).toBe("access-denied");
    });
});

describe("cockpit.init()", () => {
    it("fills cockpit.info from the bridge's info channel", async () => {
        await connect();
        // Upstream's bootstrap: awaits the transport, then opens `info`. The
        // bridge leaves that channel open, so this hangs if the client waits
        // for a close instead of resolving on the first payload.
        await cockpit.init();
        expect(cockpit.info.os_release.ID).toBe("mock");
        expect(cockpit.info.user.name).toBe("mock");
        expect(cockpit.info.user.groups).toContain("wheel");
        expect(Object.keys(cockpit.info.channels)).toContain("dbus-json3");
    });
});

describe("cockpit.spawn()", () => {
    it("returns stdout for a successful command", async () => {
        await connect({ spawn: { "hostname -f": { "exit-status": 0, stdout: "mock.example.com\n" } } });
        await expect(cockpit.spawn(["hostname", "-f"])).resolves.toBe("mock.example.com\n");
    });

    it("rejects on a non-zero exit status", async () => {
        // Non-zero exit is NOT a protocol `problem` -- the library has to turn
        // the exit-status in the close message into a rejection itself.
        await connect({
            spawn: { "false": { "exit-status": 1, message: "it failed\n" } },
        });
        await expect(cockpit.spawn(["false"])).rejects.toMatchObject({ exit_status: 1 });
    });
});

describe("cockpit.dbus() proxies", () => {
    const systemd = {
        system: {
            "/org/freedesktop/systemd1": {
                "org.freedesktop.systemd1.Manager": {
                    properties: { Version: "255", Architecture: "x86-64", NFailedUnits: 2 },
                    methods: { Reload: { reply: [] }, GetUnit: { reply: ["/unit/sshd"] } },
                },
            },
        },
    };

    it("populates a proxy's cached properties from meta + notify", async () => {
        await connect({ dbus: systemd });
        const client = cockpit.dbus("org.freedesktop.systemd1", { bus: "system" });
        // Upstream's hand-written declarations do not describe the dynamic
        // property surface a proxy grows from `meta`, so read it structurally.
        const proxy = client.proxy(
            "org.freedesktop.systemd1.Manager", "/org/freedesktop/systemd1",
        ) as unknown as { wait(): Promise<void>, valid: boolean, Version: string, NFailedUnits: number };
        await proxy.wait();

        expect(proxy.valid).toBe(true);
        expect(proxy.Version).toBe("255");
        expect(proxy.NFailedUnits).toBe(2);
        client.close();
    });

    it("calls a method and resolves with its reply", async () => {
        await connect({ dbus: systemd });
        const client = cockpit.dbus("org.freedesktop.systemd1", { bus: "system" });
        await expect(
            client.call("/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "GetUnit", ["sshd.service"]),
        ).resolves.toEqual(["/unit/sshd"]);
        client.close();
    });

    it("turns a D-Bus error reply into a rejection carrying the error name", async () => {
        await connect({ dbus: systemd });
        const client = cockpit.dbus("org.freedesktop.systemd1", { bus: "system" });
        await expect(
            client.call("/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "NoSuchMethod", []),
        ).rejects.toMatchObject({ name: "org.freedesktop.DBus.Error.UnknownMethod" });
        client.close();
    });
});

describe("transport-level controls a bare bridge would reject", () => {
    it("are refused locally instead of killing the connection", async () => {
        const transport = await connect({ spawn: { "echo ok": { stdout: "ok\n" } } });
        const warn = console.warn;
        const warnings: string[] = [];
        console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")) };
        try {
            // Both would make the real Python bridge raise CockpitProtocolError
            // and drop the session (protocol.py transport_control_received).
            (cockpit as unknown as { hint(name: string, options: object): void }).hint("restart", {});
            cockpit.transport.inject("\n" + JSON.stringify({ command: "jump", location: "/" }));
        } finally {
            console.warn = warn;
        }
        expect(warnings.join("\n")).toMatch(/not sending 'hint'/);
        expect(warnings.join("\n")).toMatch(/not sending 'jump'/);
        // The session is still alive and usable.
        await expect(cockpit.spawn(["echo", "ok"])).resolves.toBe("ok\n");
        expect(transport.ready).toBe(true);
    });
});

describe("the bridge's stderr", () => {
    it("is a real pipe, not a socket, so the bridge logs to us rather than to journald", async () => {
        const lines: string[] = [];
        const probe = "const st = require('fs').fstatSync(2); process.stderr.write(`fifo=${st.isFIFO()} socket=${st.isSocket()}\\n`); process.exit(3)";
        const transport = new StreamTransport(["node", "-e", probe], { onStderr: line => lines.push(line) });
        transport.install();
        active = transport;
        await transport.connect().catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(lines).toEqual(["fifo=true socket=false"]);
    });
});
