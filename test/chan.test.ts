/*
 * Upstream's channel conformance suite, ported.
 *
 * Source: cockpit-project/cockpit pkg/base1/test-chan.js (LGPL-2.1-or-later),
 * a QUnit suite that drives the client library through a mocked WebSocket. It
 * is the cheapest real confidence available on this project: if our transport
 * makes the library behave the way upstream asserts it behaves, every page
 * built on top inherits that.
 *
 * The port is deliberately literal -- same names, same assertions, same order.
 * QUnit's `assert.async()` becomes a promise the test awaits. Where a test
 * cannot cross over, it says so and why rather than being quietly dropped.
 */
import { describe, it, expect, afterEach } from "vitest";
import cockpit from "../src/cockpit.js";
import { transport_globals } from "cockpit/_internal/transport";
import { MockPeer, MOCK_INIT, type MockPeerOptions } from "./mock-peer.js";

let active: MockPeer | null = null;

function start(options: MockPeerOptions = {}): MockPeer {
    const peer = new MockPeer(options);
    peer.install();
    active = peer;
    return peer;
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej });
    return { promise, resolve, reject };
}

/** QUnit's assert.async(n): resolves once it has been called n times. */
function counted(times: number): { done: () => void, promise: Promise<void> } {
    const gate = deferred();
    let remaining = times;
    return { promise: gate.promise, done: () => { if (--remaining === 0) gate.resolve() } };
}

const tick = (ms = 50) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Open a channel without a `payload`.
 *
 * Upstream's hand-written cockpit.d.ts marks `payload` as required, but the
 * library does not require it and these ported tests deliberately omit it to
 * exercise the bare open path.
 */
const openChannel = (options: Record<string, unknown> = {}) => cockpit.channel(options as never);

type Control = Record<string, unknown>;

afterEach(() => {
    active?.detachAll();
    active = null;
    cockpit.transport.close();
    // Both live in the vendored library as process-wide state with no removal
    // API, so leaking them would make these tests order-dependent.
    transport_globals.incoming_filters.length = 0;
    transport_globals.default_host = null;
});

describe("public api", () => {
    it("exposes the documented channel and transport surface", () => {
        start();
        const channel = openChannel({ host: "host.example.com" });
        expect(typeof channel).toBe("object");
        expect(channel.options.host).toBe("host.example.com");
        expect(channel.id).toBeDefined();
        expect(channel.toString().indexOf("host.example.com")).toBeGreaterThan(0);
        expect(typeof channel.send).toBe("function");
        expect(typeof channel.close).toBe("function");
        expect(channel.valid).toBe(true);
        expect(typeof cockpit.logout).toBe("function");
        expect(typeof cockpit.transport).toBe("object");
        expect(typeof cockpit.transport.close).toBe("function");
        expect(typeof cockpit.transport.options).toBe("object");
        channel.close();
    });

    // Upstream follows this with check_transport(), which asserts how the
    // browser Transport derives a socket URL from window.location. We never
    // construct that Transport -- URL derivation is replaced by an explicit
    // target -- so there is nothing here to conform to.
});

describe("opening channels", () => {
    it("open channel", async () => {
        const peer = start();
        const gate = deferred();
        const channel = openChannel({ host: "scruffy" });
        let isInited = false;

        peer.onrecv((chan, payload) => {
            const command = JSON.parse(payload) as Control;
            if (!isInited) {
                expect(typeof command).toBe("object");
                expect(chan).toBe("");
                expect(command.command).toBe("init");
                expect(command.version).toBe(1);
                isInited = true;
            } else {
                expect(command.command).toBe("open");
                expect(command.channel).toBe(channel.id);
                expect(command.host).toBe("scruffy");
                gate.resolve();
            }
        });

        await gate.promise;
        channel.close();
    });

    it("multiple", async () => {
        const peer = start();
        const gate = deferred();
        const channel = openChannel({ host: "scruffy" });
        const channelb = openChannel({ host: "amy" });

        const off = peer.onrecv(() => {
            off();
            expect(channel.id).not.toBe(channelb.id);
            gate.resolve();
        });

        await gate.promise;
        channel.close();
        channelb.close();
    });

    it("open no host", async () => {
        const peer = start();
        const gate = deferred();
        const channel = openChannel({});
        expect(channel).toBeTruthy();

        peer.onrecv((_chan, payload) => {
            const command = JSON.parse(payload) as Control;
            if (command.command === "open") {
                expect(command.host).toBeUndefined();
                gate.resolve();
            }
        });

        await gate.promise;
        channel.close();
    });

    it("open auto host", async () => {
        // The host from init becomes the default for channels that name none.
        const peer = start({ defaultHost: "planetexpress" });
        const gate = deferred();
        const channel = openChannel({});
        expect(channel).toBeTruthy();

        peer.onrecv((_chan, payload) => {
            const command = JSON.parse(payload) as Control;
            if (command.command === "open") {
                expect(command.host).toBe("planetexpress");
                gate.resolve();
            }
        });

        await gate.promise;
        channel.close();
    });
});

describe("messages", () => {
    it("send message", async () => {
        const peer = start();
        const gate = deferred();
        const channel = openChannel({});

        peer.onrecv((chan, payload) => {
            if (!chan)
                return; /* ignore the init and open messages */
            expect(chan).toBe(channel.id);
            expect(payload).toBe("Scruffy gonna die the way he lived");
            gate.resolve();
        });
        channel.send("Scruffy gonna die the way he lived");

        await gate.promise;
        channel.close();
    });

    it("queue messages", async () => {
        const peer = start();
        const gate = deferred();
        const sentence: string[] = [];
        // Sent before the transport is ready: the library must queue them.
        const channel = openChannel({});
        channel.send("Scruffy");
        channel.send("knows");
        channel.send("he");
        channel.send("rules");

        peer.onrecv((chan, payload) => {
            if (!chan)
                return; /* ignore control messages */
            sentence.push(payload);
            if (sentence.length === 4) {
                expect(sentence.join(" ")).toBe("Scruffy knows he rules");
                gate.resolve();
            }
        });

        await gate.promise;
        channel.close();
    });

    it("receive message", async () => {
        const peer = start();
        const gate = deferred();
        const off = peer.onrecv((_chan, payload) => {
            const cmd = JSON.parse(payload) as Control;
            if (cmd.command === "open") {
                off();
                peer.send(channel.id, "Oh, marrrrmalade!");
            }
        });

        const channel = openChannel({});
        channel.addEventListener("message", ((_event: unknown, message: string) => {
            expect(message).toBe("Oh, marrrrmalade!");
            gate.resolve();
        }) as never);

        await gate.promise;
        channel.close();
    });

    it("send after close", async () => {
        const peer = start();
        let receivedMessage = false;
        const channel = openChannel({});
        peer.onrecv(chan => { if (chan) receivedMessage = true });

        channel.close();
        channel.send("Dern it.");

        await tick();
        expect(receivedMessage).toBe(false);
    });

    it("ignore other commands", async () => {
        const peer = start();
        const channel = openChannel({ payload: "echo" });

        peer.send(0, JSON.stringify({ command: "ping" }));
        peer.send(0, JSON.stringify({ command: "unexpected" }));

        await tick();
        expect(channel.valid).toBe(true);
        channel.close();
    });
});

describe("closing", () => {
    it("close channel", async () => {
        const peer = start();
        const gate = counted(2);
        peer.onrecv((_chan, payload) => {
            const cmd = JSON.parse(payload) as Control;
            if (cmd.command === "init") {
                return;
            } else if (cmd.command === "open") {
                channel.close();
                return;
            }
            expect(cmd.command).toBe("close");
            expect(cmd.channel).toBe(channel.id);
            peer.send("", payload);
            gate.done();
        });

        const channel = openChannel({});
        channel.addEventListener("close", ((_event: unknown, options: Control) => {
            expect(options.problem).toBeFalsy();
            gate.done();
        }) as never);

        await gate.promise;
    });

    it("close early", async () => {
        start();
        const gate = deferred();
        const channel = openChannel({});
        channel.addEventListener("close", ((_event: unknown, options: Control) => {
            expect(options.problem).toBe("yo");
            gate.resolve();
        }) as never);
        channel.close("yo");
        expect(channel.valid).toBe(false);
        await gate.promise;
    });

    it("close problem", async () => {
        const peer = start();
        const gate = deferred();
        peer.onrecv((_chan, payload) => {
            const cmd = JSON.parse(payload) as Control;
            if (cmd.command === "init") {
                return;
            } else if (cmd.command === "open") {
                channel.close({ problem: "problem" });
                expect(channel.valid).toBe(false);
                return;
            }
            expect(cmd.command).toBe("close");
            expect(cmd.problem).toBe("problem");
            gate.resolve();
        });

        const channel = openChannel({});
        channel.addEventListener("close", ((_event: unknown, options: Control) => {
            expect(options.problem).toBe("problem");
        }) as never);

        await gate.promise;
    });

    it("close problem string", async () => {
        const peer = start();
        const gate = deferred();
        const channel = openChannel({});
        peer.onrecv((_chan, payload) => {
            const cmd = JSON.parse(payload) as Control;
            if (cmd.command === "init") {
                return;
            } else if (cmd.command === "open") {
                channel.close("testo");
                expect(channel.valid).toBe(false);
                return;
            }
            expect(cmd.command).toBe("close");
            expect(cmd.problem).toBe("testo");
            gate.resolve();
        });
        channel.addEventListener("close", ((_event: unknown, options: Control) => {
            expect(options.problem).toBe("testo");
        }) as never);

        await gate.promise;
    });

    it("close peer", async () => {
        const peer = start();
        const gate = deferred();
        peer.onrecv((_chan, payload) => {
            const msg = JSON.parse(payload) as Control;
            if (msg.command === "init")
                return;
            peer.send("", JSON.stringify({
                command: "close",
                channel: channel.id,
                problem: "marmalade",
                extra: 5,
            }));
        });

        const channel = openChannel({});
        const channelb = openChannel({});

        channel.addEventListener("close", ((_event: unknown, options: Control) => {
            expect(options.problem).toBe("marmalade");
            expect(options.extra).toBe(5);
            expect(channel.valid).toBe(false);
            // Only the named channel dies, not every channel on the transport.
            expect(channelb.valid).toBe(true);
            gate.resolve();
        }) as never);

        await gate.promise;
        channelb.close();
    });

    it("close socket", async () => {
        const peer = start();
        const gate = counted(2);
        const channel = openChannel({});
        const channelb = openChannel({});

        channel.addEventListener("close", ((_event: unknown, options: Control) => {
            expect(options.problem).toBe("disconnected");
            expect(channel.valid).toBe(false);
            gate.done();
        }) as never);
        channelb.addEventListener("close", ((_event: unknown, options: Control) => {
            expect(options.problem).toBe("disconnected");
            expect(channelb.valid).toBe(false);
            gate.done();
        }) as never);

        peer.closePeer();
        await gate.promise;
    });
});

describe("wait()", () => {
    it("wait ready", async () => {
        start();
        const channel = openChannel({ payload: "echo" });
        // wait() resolves with the `ready` control message, not channel data,
        // which upstream's d.ts does not express.
        const options = await channel.wait() as unknown as Control;
        expect(typeof options).toBe("object");
        expect(options).toBeTruthy();
        expect(options.command).toBe("ready");
        expect(channel.valid).toBe(true);
        channel.close();
    });

    it("wait close", async () => {
        start();
        const channel = openChannel({ payload: "unsupported" });
        // A payload the peer does not implement is a close, not a throw at the
        // call site: wait() rejects with the close message itself.
        const options = await channel.wait().then(
            () => { throw new Error("should not succeed") },
            (error: Control) => error,
        ) as Control;
        expect(typeof options).toBe("object");
        expect(options).toBeTruthy();
        expect(options.command).toBe("close");
        expect(options.problem).toBe("not-supported");
        expect(channel.valid).toBe(false);
    });

    it("wait callback", async () => {
        start();
        const gate = deferred();
        const channel = openChannel({ payload: "unsupported" });
        channel.wait(((options: Control) => {
            expect(typeof options).toBe("object");
            expect(options).toBeTruthy();
            expect(options.command).toBe("close");
            expect(options.problem).toBe("not-supported");
            expect(channel.valid).toBe(false);
            gate.resolve();
        }) as never).catch(() => {});
        await gate.promise;
    });
});

describe("session control", () => {
    it("logout", async () => {
        const peer = start();
        const gate = counted(2);
        peer.onrecv((_chan, payload) => {
            const cmd = JSON.parse(payload) as Control;
            if (cmd.command === "logout") {
                expect(cmd.disconnect).toBe(true);
                peer.closePeer("disconnected");
            }
        });

        const channel = openChannel({ payload: "echo" });
        const channelb = openChannel({ payload: "echo" });

        channel.addEventListener("close", ((_event: unknown, options: Control) => {
            expect(options.problem).toBe("disconnected");
            expect(channel.valid).toBe(false);
            gate.done();
        }) as never);
        channelb.addEventListener("close", ((_event: unknown, options: Control) => {
            expect(options.problem).toBe("disconnected");
            expect(channelb.valid).toBe(false);
            gate.done();
        }) as never);

        cockpit.logout(false);
        await gate.promise;
    });

    it("droppriv", async () => {
        const peer = start();
        const gate = deferred();
        peer.onrecv((_chan, payload) => {
            const cmd = JSON.parse(payload) as Control;
            if (cmd.command === "logout") {
                // The same command as logout, distinguished only by this flag.
                expect(cmd.disconnect).toBe(false);
                gate.resolve();
            }
        });

        cockpit.drop_privileges();
        await gate.promise;
    });

    it("info", async () => {
        const peer = start();
        const gate = deferred();
        let infoChanged = false;

        const onchanged = () => {
            const info = cockpit.info as unknown as Record<string, unknown>;
            expect(info.version).toBe("zero.point.zero");
            expect(info.build).toBe("nasty stuff");
            infoChanged = true;
        };
        cockpit.info.addEventListener("changed", onchanged);

        const off = peer.onrecv((_chan, payload) => {
            const cmd = JSON.parse(payload) as Control;
            if (cmd.command === "open") {
                off();
                cockpit.info.removeEventListener("changed", onchanged);
                expect(infoChanged).toBe(true);
                gate.resolve();
            }
        });

        const channel = openChannel({ host: "scruffy" });
        expect(channel).toBeTruthy();
        await gate.promise;
        channel.close();
    });

    it("transport options", async () => {
        const peer = start();
        const gate = deferred();
        peer.onrecv(chan => {
            if (chan) {
                expect(typeof cockpit.transport.options).toBe("object");
                expect(cockpit.transport.options).toEqual(MOCK_INIT);
                expect(cockpit.transport.csrf_token).toBe("the-csrf-token");
                gate.resolve();
            }
        });

        const channel = openChannel({});
        channel.send("blah");
        await gate.promise;
        channel.close();
    });
});

describe("filters and injection", () => {
    it("filter message in", async () => {
        start();
        const gate = deferred();
        let filtered = 0;
        let filtering = true;

        cockpit.transport.filter(((message: string, channelid: string, control: Control | null) => {
            if (!filtering)
                return true;
            if (message[0] === "\n") {
                // A control frame: empty channel, so the frame starts with the
                // separator, and the parsed control object is handed over.
                expect(channelid).toBe("");
                expect(typeof control).toBe("object");
                expect(typeof control!.command).toBe("string");
                return true;
            }
            expect(channelid).toBe(channel.id);
            expect(control).toBeNull();
            filtered += 1;
            return filtered !== 1; /* drop the first data frame */
        }) as never);

        let received = 0;
        const channel = openChannel({ payload: "echo" });
        channel.addEventListener("message", (() => {
            received += 1;
            if (received === 2) {
                expect(filtered).toBe(3);
                expect(received).toBe(2);
                channel.close();
                filtering = false;
                gate.resolve();
            }
        }) as never);

        channel.send("one");
        channel.send("two");
        channel.send("three");
        await gate.promise;
    });

    it("inject message out", async () => {
        // Nothing to inject into before a transport exists. Upstream can assert
        // this after opening a channel because its transport is created lazily;
        // ours is installed explicitly, so the check belongs before that.
        expect(cockpit.transport.inject("bree\nyellow")).toBe(false);

        const peer = start();
        const gate = deferred();
        let first = true;
        peer.onrecv((chan, payload) => {
            if (first) {
                expect(cockpit.transport.inject("bree\nyellow")).toBe(true);
                first = false;
                return;
            }
            if (chan) {
                expect(chan).toBe("bree");
                expect(payload).toBe("yellow");
                channel.close();
                gate.resolve();
            }
        });

        const channel = openChannel({});
        await gate.promise;
    });

    it("inject message in", async () => {
        start();
        const gate = deferred();
        const channel = openChannel({ payload: "null" });
        channel.addEventListener("control", ((_event: unknown, control: Control) => {
            if (control.command === "ready") {
                const payload = JSON.stringify({ command: "blah", blah: "marmalade", channel: channel.id });
                expect(cockpit.transport.inject(`\n${payload}`, false)).toBe(true);
            } else {
                expect(control.command).toBe("blah");
                expect(control.blah).toBe("marmalade");
                channel.close();
                gate.resolve();
            }
        }) as never);
        await gate.promise;
    });
});

describe("message()", () => {
    it("maps problems, objects and junk to strings", () => {
        expect(cockpit.message("terminated")).toBe("Your session has been terminated.");
        expect(cockpit.message({ problem: "timeout" })).toBe("Connection has timed out.");
        expect(cockpit.message({ message: "The message", problem: "blah" })).toBe("The message");
        expect(cockpit.message(55 as never)).toBe("55");
    });
});
