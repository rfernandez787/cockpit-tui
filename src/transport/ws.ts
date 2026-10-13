/*
 * WebSocket transport: attach to an already-running cockpit-ws.
 *
 * This makes the TUI a peer of the browser rather than a replacement for the
 * whole stack -- it inherits cockpit-ws's PAM authentication, TLS, and remote
 * host routing. The target needs cockpit-ws running; nothing extra is needed
 * on this machine.
 *
 * Frames carry no length prefix here: a WebSocket already has message
 * boundaries, so the wire form is just `<channel>\n<payload>`.
 */
import { WebSocket } from "ws";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { PeerCertificate, TLSSocket } from "node:tls";
import { BaseTransport, type TransportOptions } from "./base.js";

/** A prompt from cockpit-ws's multi-step auth (2FA, expired password, ...). */
export interface AuthPrompt {
    prompt: string;
    message?: string;
    error?: string;
    /** False means the answer is a secret and must not be shown as typed. */
    echo: boolean;
    default?: string;
}

export interface WsTransportOptions extends TransportOptions {
    /** e.g. "https://server.example.com:9090". Bare hostnames get https + :9090. */
    url: string;
    user: string;
    password: string;
    /** Answer a conversation prompt, or return null to abort the login. */
    onPrompt?: (prompt: AuthPrompt) => Promise<string | null>;
    /**
     * Decide whether to trust a TLS certificate.
     *
     * Self-signed certificates are the norm on :9090, so this is the normal
     * path, not an error path. Returning false aborts. Omitting it rejects
     * anything not signed by a known CA.
     */
    onCertificate?: (info: { fingerprint256: string, subject: string, issuer: string }) => Promise<boolean>;
    /** Accept any certificate without asking. Convenient; not for production. */
    insecure?: boolean;
    /** Cockpit application name; "cockpit" unless addressing a machine directly. */
    application?: string;
}

interface LoginResult {
    cookie: string;
    csrfToken?: string;
}

export class WsTransport extends BaseTransport {
    #socket: WebSocket | null = null;
    #ping: NodeJS.Timeout | null = null;
    #sawTraffic = false;
    readonly #options: WsTransportOptions;
    readonly #base: URL;
    readonly #app: string;

    constructor(options: WsTransportOptions) {
        super(options);
        this.#options = options;
        this.#app = options.application ?? "cockpit";
        this.#base = normalizeUrl(options.url);
        this.application = this.#app;
    }

    async connect(): Promise<this> {
        const login = await this.#login();
        // cockpit-ws destroys an unattached session after ~15s
        // (cockpit_ws_service_idle), so do not dawdle between these two steps.
        await this.#openSocket(login);
        await this.whenConnected();
        this.#startPing();
        return this;
    }

    // ---- authentication ----------------------------------------------------

    /**
     * GET (not POST) /cockpit/login with an Authorization header, following
     * any X-Conversation challenges until the session is established.
     */
    async #login(): Promise<LoginResult> {
        const path = `/${this.#app}/login`;
        let authorization = "Basic " + Buffer.from(
            `${this.#options.user}:${this.#options.password}`, "utf8").toString("base64");

        for (let attempt = 0; attempt < 16; attempt++) {
            const response = await this.#httpGet(path, {
                Authorization: authorization,
                // Decline startup escalation: we escalate interactively through
                // the cockpit.Superuser D-Bus object instead, which survives a
                // wrong password. ws caches (and poisons) the login password.
                "X-Superuser": "none",
            });

            if (response.status === 200) {
                const cookie = extractCookie(response.headers["set-cookie"], this.#app);
                if (!cookie)
                    throw new Error("cockpit-ws accepted the login but set no session cookie");
                let csrfToken: string | undefined;
                try {
                    csrfToken = (JSON.parse(response.body) as { "csrf-token"?: string })["csrf-token"];
                } catch { /* body shape is advisory */ }
                return { cookie, csrfToken };
            }

            const challenge = response.headers["www-authenticate"];
            const conversation = parseConversation(Array.isArray(challenge) ? challenge[0] : challenge);
            if (!conversation)
                throw new Error(loginFailureMessage(response));

            if (!this.#options.onPrompt)
                throw new Error(`cockpit-ws requires additional authentication ("${conversation.prompt}") ` +
                                `but no onPrompt handler was supplied`);

            let detail: Partial<AuthPrompt> = {};
            try {
                detail = JSON.parse(response.body) as Partial<AuthPrompt>;
            } catch { /* body is optional */ }

            const answer = await this.#options.onPrompt({
                prompt: conversation.prompt,
                message: detail.message,
                error: detail.error,
                echo: detail.echo ?? false,
                default: detail.default,
            });
            if (answer === null)
                throw new Error("authentication cancelled");

            authorization = `X-Conversation ${conversation.id} ` +
                Buffer.from(answer, "utf8").toString("base64");
        }
        throw new Error("too many authentication rounds");
    }

    #httpGet(path: string, headers: Record<string, string>): Promise<{
        status: number, statusText: string, headers: IncomingMessage["headers"], body: string,
    }> {
        return new Promise((resolve, reject) => {
            const secure = this.#base.protocol === "https:";
            const doRequest = secure ? httpsRequest : httpRequest;
            const req = doRequest({
                protocol: this.#base.protocol,
                hostname: this.#base.hostname,
                port: this.#base.port,
                path,
                method: "GET",
                headers: { Host: this.#base.host, ...headers },
                // Certificate acceptance is decided in the checkServerIdentity
                // hook below so we can prompt rather than blanket-trust.
                ...(secure ? { rejectUnauthorized: false } : {}),
            }, response => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", chunk => { body += chunk });
                response.on("end", () => resolve({
                    status: response.statusCode ?? 0,
                    statusText: response.statusMessage ?? "",
                    headers: response.headers,
                    body,
                }));
            });

            if (secure) {
                req.on("socket", socket => {
                    socket.on("secureConnect", () => {
                        this.#checkCertificate(socket as TLSSocket)
                            .catch(error => { req.destroy(error as Error) });
                    });
                });
            }
            req.on("error", reject);
            req.end();
        });
    }

    async #checkCertificate(socket: TLSSocket): Promise<void> {
        if (this.#options.insecure)
            return;
        if (socket.authorized)
            return;
        const cert = socket.getPeerCertificate() as PeerCertificate;
        if (!this.#options.onCertificate)
            throw new Error(
                `TLS certificate for ${this.#base.host} is not trusted ` +
                `(${socket.authorizationError}). Cockpit generates a self-signed ` +
                `certificate by default -- supply onCertificate to confirm it.`);

        const accepted = await this.#options.onCertificate({
            fingerprint256: cert.fingerprint256 ?? fingerprintOf(cert),
            subject: describeName(cert.subject),
            issuer: describeName(cert.issuer),
        });
        if (!accepted)
            throw new Error("TLS certificate rejected");
    }

    // ---- socket ------------------------------------------------------------

    #openSocket(login: LoginResult): Promise<void> {
        const scheme = this.#base.protocol === "https:" ? "wss:" : "ws:";
        const url = `${scheme}//${this.#base.host}/${this.#app}/socket`;

        return new Promise((resolve, reject) => {
            const socket = new WebSocket(url, ["cockpit1"], {
                headers: {
                    Cookie: login.cookie,
                    // Mandatory, and the classic non-browser failure: cockpit-ws
                    // computes its allowed origin from the request host, so this
                    // must match Host and scheme exactly or the upgrade is 403.
                    Origin: `${this.#base.protocol}//${this.#base.host}`,
                    Host: this.#base.host,
                },
                rejectUnauthorized: false,
            });
            this.#socket = socket;

            socket.binaryType = "nodebuffer";
            socket.on("open", () => resolve());
            socket.on("message", (data: Buffer) => {
                this.#sawTraffic = true;
                this.receiveFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
            });
            socket.on("error", error => {
                reject(error);
                this.fail("disconnected", (error as Error).message);
            });
            socket.on("close", (code, reasonBuffer) => {
                const reason = reasonBuffer?.toString() || `code ${code}`;
                reject(new Error(`websocket closed: ${reason}`));
                this.fail("disconnected", reason);
            });
        });
    }

    /**
     * cockpit's own liveness check: ping every 30s, and treat 30s of total
     * silence as a dead connection.
     */
    #startPing(): void {
        this.#ping = setInterval(() => {
            if (!this.#sawTraffic) {
                this.fail("timeout", "no traffic from cockpit-ws for 30s");
                return;
            }
            this.#sawTraffic = false;
            this.send_control({ command: "ping" });
        }, 30_000);
        this.#ping.unref?.();
    }

    /** cockpit-ws handles hint, logout, ping and the rest itself. */
    protected override acceptsTransportControl(): boolean {
        return true;
    }

    protected buildInit(): Record<string, unknown> {
        // cockpit-ws builds its own init for the bridge; ours needs only the
        // version. It supplies `host` itself.
        return { command: "init", version: 1 };
    }

    protected writeFrame(frame: Buffer): void {
        if (this.#socket?.readyState === WebSocket.OPEN)
            this.#socket.send(frame);
    }

    protected disconnect(): void {
        if (this.#ping) {
            clearInterval(this.#ping);
            this.#ping = null;
        }
        const socket = this.#socket;
        this.#socket = null;
        if (socket) {
            socket.removeAllListeners("close");
            socket.removeAllListeners("error");
            socket.close();
        }
    }
}

// ---- helpers ---------------------------------------------------------------

/** Accept "host", "host:9090" or a full URL; default to https on :9090. */
export function normalizeUrl(input: string): URL {
    const url = new URL(/^https?:\/\//.test(input) ? input : `https://${input}`);
    if (!url.port)
        url.port = "9090";
    return url;
}

/** `WWW-Authenticate: X-Conversation <id> <base64 prompt>` */
export function parseConversation(header: string | undefined): { id: string, prompt: string } | null {
    if (!header)
        return null;
    const parts = header.split(" ");
    if (parts.length !== 3 || parts[0]!.toLowerCase() !== "x-conversation")
        return null;
    return { id: parts[1]!, prompt: Buffer.from(parts[2]!, "base64").toString("utf8") };
}

/**
 * The cookie name depends on the application: "cockpit" normally, or
 * "machine-cockpit+<host>" when addressing a machine directly.
 */
export function extractCookie(setCookie: string[] | undefined, application: string): string | null {
    const name = application.startsWith("cockpit+=")
        ? `machine-cockpit+${application.slice("cockpit+=".length)}`
        : application;
    for (const entry of setCookie ?? []) {
        const pair = entry.split(";")[0];
        if (pair && pair.startsWith(`${name}=`))
            return pair;
    }
    return null;
}

function loginFailureMessage(response: { status: number, statusText: string }): string {
    if (response.status === 401)
        return `authentication failed: ${response.statusText || "unauthorized"}`;
    if (response.status === 403)
        return `access denied: ${response.statusText || "forbidden"}`;
    return `cockpit-ws login failed with HTTP ${response.status} ${response.statusText}`;
}

/** Render a certificate subject/issuer for a trust prompt. */
function describeName(name: Record<string, string | string[] | undefined> | undefined): string {
    if (!name)
        return "unknown";
    const cn = name.CN;
    if (typeof cn === "string")
        return cn;
    return Object.entries(name)
        .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("/") : value ?? ""}`)
        .join(", ");
}

function fingerprintOf(cert: PeerCertificate): string {
    if (!cert.raw)
        return "unknown";
    const hex = createHash("sha256").update(cert.raw).digest("hex").toUpperCase();
    return hex.match(/../g)!.join(":");
}
