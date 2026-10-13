/*
 * The transport seam.
 *
 * Cockpit's client library reaches the outside world through exactly one
 * object, `transport_globals.default_transport`. Assigning our own instance
 * there before the first `ensure_transport()` call means the library's own
 * `Transport` -- and with it its WebSocket, URL derivation, health-check timer
 * and iframe ParentWebSocket path -- is never constructed.
 *
 * This base implements the contract the library actually calls, mirroring
 * `vendor/cockpit/_internal/transport.ts` so behaviour matches exactly.
 * Subclasses supply only the wire.
 */
// Must precede every vendored import below: those modules read `document` and
// `window` at evaluation time. ES modules evaluate dependencies depth-first in
// declaration order, so this line is what makes the rest safe. Any module that
// imports from "cockpit/..." directly needs the same first line.
import "../shim/dom.js";

import { EventEmitter } from "cockpit/event";
import { transport_globals } from "cockpit/_internal/transport";
import { splitFrame } from "./framing.js";

const LF = 0x0a;

export type ControlCallback = (message: JsonObject) => void;
export type MessageCallback = (payload: string | Uint8Array) => void;
export type JsonObject = Record<string, unknown>;

const debug = process.env.COCKPIT_TUI_DEBUG
    ? (...args: unknown[]) => console.error("transport:", ...args)
    : () => {};

export interface TransportOptions {
    /**
     * Value for the mandatory `host` field of our `init` reply.
     *
     * The bare bridge reads this with no default and tears down the transport
     * if it is missing. It must also match the host on any `open`, or the
     * bridge's host routing rule will try to ssh somewhere.
     */
    host?: string;
    /**
     * Request privilege escalation during the init handshake.
     *
     * Left off by default: we escalate interactively through the
     * `cockpit.Superuser` D-Bus object instead, which yields real prompt text
     * and supports retries. See src/superuser.ts.
     */
    superuser?: { id: string } | false;
}

export abstract class BaseTransport extends EventEmitter<{ ready(): void, close(problem?: string): void }> {
    /** Read by `cockpit.transport.application()`. */
    application = "cockpit";
    ready = false;

    #control_cbs: Record<string, ControlCallback> = {};
    #message_cbs: Record<string, MessageCallback> = {};
    #last_channel = 0;
    #channel_seed = "";
    #waiting_for_init = true;
    #closed = false;
    #closeProblem = "disconnected";
    readonly #options: TransportOptions;

    /**
     * Channels opened with `binary: "raw"`.
     *
     * A stream transport has no per-frame text/binary distinction the way a
     * WebSocket does, so we recover it from the `open` messages passing
     * through. The library hands text channels a string and binary channels a
     * Uint8Array, and gets confused if given the wrong one.
     */
    #binary_channels = new Set<string>();

    /**
     * Settled by the handshake, independent of the "ready" event.
     *
     * close() deliberately marks the transport ready so pending channels fail
     * rather than hang, which means "ready" alone cannot tell success from
     * failure. This can.
     */
    #connected: Promise<void>;
    #resolveConnected!: () => void;
    #rejectConnected!: (error: Error) => void;
    #connectSettled = false;

    constructor(options: TransportOptions = {}) {
        super();
        this.#options = options;
        this.#connected = new Promise<void>((resolve, reject) => {
            this.#resolveConnected = resolve;
            this.#rejectConnected = reject;
        });
        // Nothing may await this before connect(); avoid an unhandled rejection.
        this.#connected.catch(() => {});
    }

    /** Resolves once the init handshake completes; rejects if it never does. */
    protected whenConnected(): Promise<void> {
        return this.#connected;
    }

    // ---- supplied by subclasses -------------------------------------------

    /** Put one already-joined `<channel>\n<payload>` frame on the wire. */
    protected abstract writeFrame(frame: Buffer): void;

    /** Tear down the underlying connection. Must be idempotent. */
    protected abstract disconnect(): void;

    // ---- called by subclasses ---------------------------------------------

    /** Feed one received `<channel>\n<payload>` frame in. */
    protected receiveFrame(frame: Buffer): void {
        this.dispatch_data({ data: frame });
    }

    /** Report an unrecoverable transport failure. */
    protected fail(problem: string, message?: string): void {
        debug("failed:", problem, message ?? "");
        this.close({ problem, ...(message ? { message } : {}) });
    }

    // ---- the contract the vendored library calls ---------------------------

    next_channel(): string {
        this.#last_channel++;
        return this.#channel_seed + String(this.#last_channel);
    }

    register(channel: string, control_cb: ControlCallback, message_cb: MessageCallback): void {
        if (this.#closed) {
            // A channel opened after the connection is gone fails at once, the
            // way every channel open at the time failed (see close()).
            const problem = this.#closeProblem;
            queueMicrotask(() => control_cb({ command: "close", channel, problem }));
            return;
        }
        this.#control_cbs[channel] = control_cb;
        this.#message_cbs[channel] = message_cb;
    }

    /** Why the connection closed, or null while it is open. */
    get closedProblem(): string | null {
        return this.#closed ? this.#closeProblem : null;
    }

    unregister(channel: string): void {
        delete this.#control_cbs[channel];
        delete this.#message_cbs[channel];
    }

    send_data(data: string | ArrayBuffer | Uint8Array): boolean {
        if (this.#closed)
            return false;
        const frame = toBuffer(data);
        // A leading LF is an empty channel id: a control frame. This is the
        // one choke point both send_control() and cockpit.transport.inject()
        // pass through.
        if (frame[0] === LF && !this.#controlAllowed(frame)) {
            return false;
        }
        this.writeFrame(frame);
        return true;
    }

    /**
     * Channel-less ("transport-level") control commands the peer accepts.
     *
     * A bare bridge accepts only init, kill and authorize, and treats
     * anything else as a protocol error that drops the whole connection
     * (protocol.py transport_control_received). The library can produce
     * others -- cockpit.hint(), cockpit.logout(), cockpit.jump() -- so
     * they are refused here. cockpit-ws accepts more; WsTransport widens it.
     */
    protected acceptsTransportControl(command: string): boolean {
        return command === "init" || command === "kill" || command === "authorize";
    }

    #controlAllowed(frame: Buffer): boolean {
        let message: JsonObject;
        try {
            message = JSON.parse(frame.subarray(1).toString("utf8")) as JsonObject;
        } catch {
            console.warn("refusing to send a malformed control message");
            return false;
        }
        if (typeof message.channel === "string" && message.channel !== "")
            return true;
        const command = String(message.command);
        if (this.acceptsTransportControl(command))
            return true;
        debug("refusing transport-level control the peer would reject:", message);
        console.warn(`not sending '${command}' control: the bridge would drop the connection`);
        return false;
    }

    send_message(payload: string | ArrayBuffer | Uint8Array, channel: string): boolean {
        const header = Buffer.from(`${channel}\n`, "utf8");
        return this.send_data(Buffer.concat([header, toBuffer(payload)]));
    }

    send_control(data: JsonObject): boolean {
        if (this.#closed && (data.command === "close" || data.command === "kill"))
            return false; /* don't complain if closed and closing */

        // Remember channel binary-ness as it goes past; see #binary_channels.
        if (typeof data.channel === "string") {
            if (data.command === "open" && data.binary === "raw")
                this.#binary_channels.add(data.channel);
            else if (data.command === "close")
                this.#binary_channels.delete(data.channel);
        }

        debug("send control:", data);
        return this.send_message(JSON.stringify(data), "");
    }

    dispatch_data(arg: { data: string | ArrayBuffer | Uint8Array }): boolean {
        const buffer = toBuffer(arg.data);
        let frame;
        try {
            frame = splitFrame(buffer);
        } catch {
            console.warn("received invalid message without a channel");
            return false;
        }
        const { channel, payload } = frame;

        let control: JsonObject | null = null;
        if (channel === "") {
            try {
                control = JSON.parse(payload.toString("utf8")) as JsonObject;
            } catch {
                this.fail("protocol-error", "received invalid control JSON");
                return false;
            }
            debug("recv control:", control);
        }

        // Honour filters installed via cockpit.transport.filter().
        for (const filter of transport_globals.incoming_filters ?? [])
            if (filter(buffer.toString("binary"), channel, control) === false)
                return false;

        if (control)
            this.#processControl(control);
        else if (channel)
            this.#message_cbs[channel]?.(
                // A plain Uint8Array view, not the Buffer: Buffer is a subclass
                // whose toString() decodes UTF-8 rather than listing bytes, and
                // the library is written against Uint8Array semantics. The view
                // shares the same memory, so this costs nothing.
                this.#binary_channels.has(channel)
                    ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
                    : payload.toString("utf8"));

        return true;
    }

    close(options?: JsonObject): void {
        if (this.#closed)
            return;
        this.#closed = true;

        const message: JsonObject = { ...(options ?? { problem: "disconnected" }), command: "close" };
        this.disconnect();

        // Deliberately left installed as the library's transport. Removing it
        // would make the next cockpit.* call construct the browser Transport,
        // which opens a WebSocket to ws://localhost/cockpit/socket. Closed, it
        // fails new channels at once instead (register()). install() replaces it.

        const problem = options?.problem as string | undefined;
        this.#closeProblem = typeof problem === "string" && problem ? problem : "disconnected";
        if (!this.#connectSettled) {
            this.#connectSettled = true;
            const detail = [problem, options?.message].filter(Boolean).join(": ");
            this.#rejectConnected(new Error(detail || "disconnected"));
        }

        // Let every open channel fail rather than hang.
        this.#readyForChannels();
        for (const channel of Object.keys(this.#control_cbs))
            this.#control_cbs[channel]?.(message);

        this.emit("close", problem);
    }

    // ---- handshake ---------------------------------------------------------

    #readyForChannels(): void {
        if (!this.ready) {
            this.ready = true;
            this.emit("ready");
        }
    }

    #processControl(data: JsonObject): void {
        const channel = data.channel;

        if (data.command === "init") {
            this.#processInit(data);
        } else if (this.#waiting_for_init) {
            this.#waiting_for_init = false;
            if (data.command !== "close" || channel) {
                console.error("received message before init:", data.command);
                this.close({ problem: "protocol-error" });
            } else {
                this.close(data);
            }
        } else if (data.command === "ping") {
            this.send_control({ ...data, command: "pong" });
        } else if (data.command === "pong") {
            /* ignored */
        } else if (data.command === "hint") {
            transport_globals.process_hints?.(data);
        } else if (typeof channel === "string") {
            this.#control_cbs[channel]?.(data);
        }
    }

    #processInit(options: JsonObject): void {
        if (options.problem) {
            this.close({ problem: options.problem });
            return;
        }
        if (options.version !== 1) {
            this.fail("not-supported", `unsupported protocol version: ${String(options.version)}`);
            return;
        }

        // cockpit-ws issues one seed per socket so ids stay unique across the
        // several sockets that may share a session. A bare bridge sends none.
        if (options["channel-seed"])
            this.#channel_seed = String(options["channel-seed"]);
        if (typeof options.host === "string")
            transport_globals.default_host = options.host;
        transport_globals.init_callback?.(options);

        if (this.#waiting_for_init) {
            this.#waiting_for_init = false;
            this.send_control(this.buildInit());
            this.#readyForChannels();
            if (!this.#connectSettled) {
                this.#connectSettled = true;
                this.#resolveConnected();
            }
        }
    }

    /** Our half of the handshake. Overridable for transport-specific fields. */
    protected buildInit(): JsonObject {
        const init: JsonObject = {
            command: "init",
            version: 1,
            host: this.#options.host ?? "localhost",
        };
        if (this.#options.superuser)
            init.superuser = this.#options.superuser;
        return init;
    }

    /** Install as the library's transport. Call before any cockpit API use. */
    install(): this {
        transport_globals.default_transport = this as unknown as never;
        return this;
    }
}

function toBuffer(data: string | ArrayBuffer | Uint8Array): Buffer {
    if (typeof data === "string")
        return Buffer.from(data, "utf8");
    if (Buffer.isBuffer(data))
        return data;
    if (data instanceof ArrayBuffer)
        return Buffer.from(data);
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
