/*
 * An in-process peer, standing in for upstream's MockPeer/MockWebSocket.
 *
 * Upstream's pkg/base1/test-chan.js drives the library by replacing the global
 * WebSocket, because in a browser that is the only seam available. We replace
 * the transport instead, so the equivalent here is a BaseTransport whose wire
 * is a pair of callbacks. That keeps the ported assertions near-literal while
 * putting *our* transport base under test rather than upstream's.
 *
 * Semantics are copied deliberately, including the details that look
 * incidental: replies are delivered on a later tick (upstream uses two nested
 * setTimeouts), and the built-in echo/null handling stays active even when a
 * test adds its own listener, because upstream's tests rely on both running.
 */
import { BaseTransport } from "../src/transport/base.js";
import { splitFrame } from "../src/transport/framing.js";

export type RecvListener = (channel: string, payload: string) => void;

/** The init upstream's MockWebSocket sends. Ported field for field. */
export const MOCK_INIT = {
    command: "init",
    version: 1,
    "channel-seed": "test",
    "csrf-token": "the-csrf-token",
    user: {
        user: "scruffy",
        name: "Scruffy the Janitor",
    },
    system: {
        version: "zero.point.zero",
        build: "nasty stuff",
    },
};

export interface MockPeerOptions {
    /** Sent as `host` in init, so the library adopts it as the default host. */
    defaultHost?: string;
    /** Suppress the automatic init, for tests that drive the handshake by hand. */
    noInit?: boolean;
}

export class MockPeer extends BaseTransport {
    #listeners: RecvListener[] = [];
    #echos = new Set<string>();
    #nulls = new Set<string>();
    #queue: [string, string][] = [];
    #pending = false;
    #open = true;

    constructor(options: MockPeerOptions = {}) {
        super();
        if (!options.noInit) {
            // A later tick, so a test body can register listeners and open
            // channels first -- exactly the ordering upstream's tests assume.
            setTimeout(() => {
                if (!this.#open)
                    return;
                const init = options.defaultHost
                    ? { ...MOCK_INIT, host: options.defaultHost }
                    : MOCK_INIT;
                this.receiveFrame(Buffer.from(`\n${JSON.stringify(init)}`, "utf8"));
            }, 0);
        }
    }

    // ---- the test-facing API (upstream's MockPeer) -------------------------

    /** Observe frames the client sends. Returns an unsubscribe function. */
    onrecv(listener: RecvListener): () => void {
        this.#listeners.push(listener);
        return () => {
            const index = this.#listeners.indexOf(listener);
            if (index >= 0)
                this.#listeners.splice(index, 1);
        };
    }

    /**
     * Drop every observer.
     *
     * Frames are delivered on a timer, so a listener left registered at the end
     * of a test can still fire during the next one and assert against state
     * that has moved on. Teardown calls this.
     */
    detachAll(): void {
        this.#listeners.length = 0;
    }

    /** Inject a frame towards the client. */
    send(channel: string | null | 0, payload: string): void {
        this.#queue.push([channel ? String(channel) : "", payload]);
        this.#flush();
    }

    /** Simulate the connection dropping, the way a socket close does. */
    closePeer(problem = "disconnected"): void {
        setTimeout(() => this.fail(problem), 0);
    }

    // ---- the wire ----------------------------------------------------------

    /**
     * Upstream's MockWebSocket stands in for cockpit-ws, which accepts every
     * transport-level control (logout, hint, ...). Only a bare bridge rejects
     * them, so the conformance tests keep the ws behaviour.
     */
    protected override acceptsTransportControl(): boolean {
        return true;
    }

    protected writeFrame(frame: Buffer): void {
        const { channel, payload } = splitFrame(frame);
        const text = payload.toString("utf8");

        // Deferred, like upstream's MockWebSocket.send. Not cosmetic: it means
        // observers see a frame only after the library has finished reacting to
        // whatever prompted it, so e.g. channel ids are assigned by the time
        // the init frame is observed.
        setTimeout(() => {
            for (const listener of [...this.#listeners])
                listener(channel, text);
            this.#defaultHandling(channel, text);
        }, 0);
    }

    protected disconnect(): void {
        this.#open = false;
    }

    /** Upstream's rudimentary echo/null channel implementation. */
    #defaultHandling(channel: string, payload: string): void {
        if (channel) {
            if (this.#echos.has(channel) || this.#nulls.has(channel))
                this.#queue.push([channel, payload]);
            this.#flush();
            return;
        }

        const command = JSON.parse(payload) as Record<string, unknown>;
        const id = command.channel as string;
        if (command.command === "open") {
            let reply: Record<string, unknown>;
            if (command.payload === "echo") {
                this.#echos.add(id);
                reply = { command: "ready", channel: id };
            } else if (command.payload === "null") {
                this.#nulls.add(id);
                reply = { command: "ready", channel: id };
            } else {
                reply = { command: "close", channel: id, problem: "not-supported" };
            }
            this.#queue.push(["", JSON.stringify(reply)]);
        } else if (command.command === "close") {
            this.#echos.delete(id);
            this.#nulls.delete(id);
        }
        this.#flush();
    }

    #flush(): void {
        if (!this.#queue.length || this.#pending)
            return;
        this.#pending = true;
        setTimeout(() => {
            this.#pending = false;
            while (this.#queue.length) {
                const [channel, payload] = this.#queue.shift()!;
                if (!this.#open)
                    return;
                this.receiveFrame(Buffer.from(`${channel}\n${payload}`, "utf8"));
            }
        }, 0);
    }
}
