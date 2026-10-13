/*
 * podman's REST service, through the bridge.
 * Upstream: cockpit-podman 121, src/rest.ts and src/client.ts.
 *
 * podman serves its API on a unix socket: the user's own
 * ($XDG_RUNTIME_DIR/podman/podman.sock, the rootless containers) and the
 * system's (/run/podman/podman.sock, root's containers, which needs
 * administrative access). The bridge relays HTTP to either as http-stream2
 * channels; cockpit.http() is the client.
 *
 * Upstream reads streams (events, stats) off a raw socket channel with a
 * hand-written HTTP request, to work around a text-decoding problem in the
 * browser's channel code. http-stream2 streams the same responses, as long
 * as they are read as bytes and split on line ends here -- so one kind of
 * channel serves both, and that is what this does.
 *
 * Errors: podman answers a failed call with a JSON body, {"cause",
 * "message", "response"}. The library keeps that body away from a promise's
 * rejection (it is a second argument to the failure callback), so calls are
 * made with the callbacks and the message is taken from the body.
 */
import cockpit from "../../cockpit.js";

/** podman API version; the oldest one supported, as upstream. */
export const VERSION = "/v3.4.0/";

export const SYSTEM_SOCKET = "/run/podman/podman.sock";

/** Whose containers: the login user's (rootless) or the system's (root's). */
export type Owner = "user" | "system";

/** The login user is root: its own containers are the system's (upstream's getAddress: uid 0). */
export function userIsRoot(): boolean {
    return cockpit.info?.user?.uid === 0;
}

/** This owner's containers are root's: reached on the system socket, by the system's `systemctl` and `podman`. */
export function isSystem(owner: Owner): boolean {
    return owner === "system" || userIsRoot();
}

export function socketPath(owner: Owner): string {
    if (isSystem(owner))
        return SYSTEM_SOCKET;
    const uid = cockpit.info?.user?.uid;
    return `/run/user/${typeof uid === "number" ? uid : 0}/podman/podman.sock`;
}

/** What a channel for this owner must ask for: root's socket needs privileges, unless the session is root's own. */
export function privileges(owner: Owner): { superuser?: "require" } {
    return owner === "system" && !userIsRoot() ? { superuser: "require" } : {};
}

/** A failed call: the HTTP status, podman's own words for it, or the channel's problem. */
export class PodmanError extends Error {
    readonly status: number | null;
    readonly problem: string | null;
    /** podman's short reason ("no such container"), beside its message. */
    readonly podmanCause: string;

    constructor(message: string, options: { status?: number | null, problem?: string | null, cause?: string } = {}) {
        super(message);
        this.name = "PodmanError";
        this.status = options.status ?? null;
        this.problem = options.problem ?? null;
        this.podmanCause = options.cause ?? "";
    }
}

function toError(error: unknown, content: unknown): PodmanError {
    const e = (error ?? {}) as { status?: unknown, reason?: unknown, message?: unknown, problem?: unknown };
    let message = typeof e.message === "string" && e.message ? e.message : typeof e.reason === "string" ? e.reason : "";
    let cause = "";
    const text = content instanceof Uint8Array ? Buffer.from(content).toString("utf8") : typeof content === "string" ? content : "";
    if (text.trim()) {
        try {
            const body = JSON.parse(text) as { message?: unknown, cause?: unknown };
            if (typeof body.message === "string" && body.message)
                message = body.message;
            if (typeof body.cause === "string")
                cause = body.cause;
        } catch {
            message = text.trim();
        }
    }
    const problem = typeof e.problem === "string" && e.problem ? e.problem : null;
    return new PodmanError(message || problem || "the request failed", {
        status: typeof e.status === "number" ? e.status : null, problem, cause,
    });
}

export type Params = Readonly<Record<string, string | number | boolean>>;

/** The request's path and query: no `params` at all when there are none (the library would append a bare "?"). */
function target(name: string, params: Params): { path: string, params?: Record<string, string> } {
    const entries = Object.entries(params).map(([key, value]) => [key, String(value)] as const);
    return { path: VERSION + name, ...(entries.length ? { params: Object.fromEntries(entries) } : {}) };
}

export interface Stream {
    close(): void;
}

export interface Connection {
    readonly owner: Owner;
    /** One call; resolves with the response body. */
    call(method: string, name: string, params?: Params, body?: string): Promise<string>;
    /** One call whose answer is JSON. */
    json(method: string, name: string, params?: Params, body?: string): Promise<unknown>;
    /**
     * A response that does not end (events, stats): one JSON value per line,
     * each handed to `onValue`. `onEnd` gets null when the server ended it,
     * the error when it failed; neither is called after close().
     */
    stream(name: string, params: Params, onValue: (value: unknown) => void, onEnd: (error: PodmanError | null) => void): Stream;
    close(): void;
}

export function connect(owner: Owner): Connection {
    const http = cockpit.http(socketPath(owner), { binary: true, ...privileges(owner) });
    const streams = new Set<Stream>();

    const call = (method: string, name: string, params: Params = {}, body = ""): Promise<string> =>
        new Promise<string>((resolve, reject) => {
            const request = http.request({ method, ...target(name, params), body }) as unknown as {
                then(done: (data: Uint8Array) => void): { catch(fail: (error: unknown, content: unknown) => void): void },
            };
            request
                    .then(data => resolve(Buffer.from(data).toString("utf8")))
                    .catch((error, content) => reject(toError(error, content)));
        });

    return {
        owner,
        call,
        json: async (method, name, params, body) => {
            const text = await call(method, name, params, body);
            return text.trim() ? JSON.parse(text) as unknown : null;
        },
        stream(name, params, onValue, onEnd) {
            let closed = false;
            let pending = Buffer.alloc(0);
            const request = http.request({ method: "GET", ...target(name, params), body: "" }) as unknown as {
                stream(callback: (data: Uint8Array) => number | void): unknown,
                then(done: () => void): { catch(fail: (error: unknown, content: unknown) => void): void },
                close(problem?: string): void,
            };
            request.stream(data => {
                if (closed)
                    return data.length;
                pending = Buffer.concat([pending, Buffer.from(data)]);
                for (;;) {
                    const end = pending.indexOf(0x0a);
                    if (end < 0)
                        break;
                    const line = pending.subarray(0, end).toString("utf8").trim();
                    pending = pending.subarray(end + 1);
                    if (!line)
                        continue;
                    try {
                        onValue(JSON.parse(line));
                    } catch (error) {
                        console.error("podman: stream consumer failed:", error);
                    }
                }
                return data.length;
            });
            request
                    .then(() => { if (!closed) { closed = true; streams.delete(handle); onEnd(null) } })
                    .catch((error, content) => { if (!closed) { closed = true; streams.delete(handle); onEnd(toError(error, content)) } });
            const handle: Stream = {
                close() {
                    if (closed)
                        return;
                    closed = true;
                    streams.delete(handle);
                    request.close("cancelled");
                },
            };
            streams.add(handle);
            return handle;
        },
        close() {
            for (const stream of [...streams])
                stream.close();
            http.close();
        },
    };
}
