/*
 * A mock cockpit-ws: enough of the login endpoint and socket handshake to
 * exercise the real client path, including the parts that are easy to get
 * wrong and are not in the user-facing docs (GET-with-header login, the
 * X-Conversation loop, the mandatory Origin header, and ws speaking init first).
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";

export interface MockWsOptions {
    user?: string;
    password?: string;
    /** Prompts to demand before accepting the login, in order. */
    conversation?: { prompt: string, expect: string, echo?: boolean }[];
    /** Reject the socket upgrade if Origin is absent or wrong. Real ws does. */
    enforceOrigin?: boolean;
    /**
     * Relay each socket to a bridge process, the way real cockpit-ws relays to
     * cockpit-bridge: ws and bridge exchange their own init, and every other
     * frame is passed through, re-framed between the socket (no length prefix)
     * and the pipe (length-prefixed). Without this only echo channels open.
     */
    bridge?: { argv: string[], env?: Record<string, string> };
}

export interface MockWs {
    url: string;
    close: () => Promise<void>;
    /** Control frames the server received from the client, in order. */
    received: Record<string, unknown>[];
    /** Headers seen on the most recent socket upgrade attempt. */
    upgradeHeaders: Record<string, string | undefined>;
    /** Resolves once a control message satisfying the predicate arrives. */
    waitFor: (match: (message: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
}

const COOKIE = "cockpit=dj0yO2s9bW9jaw";

export async function startMockWs(options: MockWsOptions = {}): Promise<MockWs> {
    const user = options.user ?? "admin";
    const password = options.password ?? "hunter2";
    const conversation = options.conversation ?? [];
    const enforceOrigin = options.enforceOrigin ?? true;
    const received: Record<string, unknown>[] = [];
    const upgradeHeaders: Record<string, string | undefined> = {};
    const waiters: { match: (m: Record<string, unknown>) => boolean, resolve: (m: Record<string, unknown>) => void }[] = [];

    function record(message: Record<string, unknown>) {
        received.push(message);
        for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i]!.match(message)) {
                waiters[i]!.resolve(message);
                waiters.splice(i, 1);
            }
        }
    }

    // Tracks how far through the conversation each challenge id has got.
    const rounds = new Map<string, number>();

    const server: Server = createServer((req, res) => {
        if (!req.url?.endsWith("/login")) {
            res.writeHead(404).end();
            return;
        }

        const auth = req.headers.authorization ?? "";

        if (auth.startsWith("Basic ")) {
            const [gotUser, gotPassword] = Buffer.from(auth.slice(6), "base64")
                .toString("utf8").split(":");
            if (gotUser !== user || gotPassword !== password) {
                res.writeHead(401, "authentication-failed").end();
                return;
            }
            if (conversation.length > 0) {
                challenge(res, "c1", 0);
                return;
            }
            succeed(res);
            return;
        }

        if (auth.startsWith("X-Conversation ")) {
            const [, id, answerB64] = auth.split(" ");
            const round = rounds.get(id!) ?? 0;
            const step = conversation[round];
            const answer = Buffer.from(answerB64!, "base64").toString("utf8");
            if (!step || answer !== step.expect) {
                res.writeHead(401, "authentication-failed").end();
                return;
            }
            if (round + 1 < conversation.length) {
                rounds.set(id!, round + 1);
                challenge(res, id!, round + 1);
                return;
            }
            succeed(res);
            return;
        }

        res.writeHead(401, "authentication-failed").end();
    });

    function challenge(res: ServerResponse, id: string, round: number) {
        const step = conversation[round]!;
        rounds.set(id, round);
        res.writeHead(401, {
            "WWW-Authenticate": `X-Conversation ${id} ${Buffer.from(step.prompt).toString("base64")}`,
            "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ echo: step.echo ?? false }));
    }

    function succeed(res: ServerResponse) {
        res.writeHead(200, {
            "Set-Cookie": `${COOKIE}; Path=/; SameSite=Strict; HttpOnly`,
            "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ "csrf-token": "mock-csrf" }));
    }

    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
        Object.assign(upgradeHeaders, req.headers);
        const origin = req.headers.origin;
        const expectedOrigin = `http://${req.headers.host}`;
        if (enforceOrigin && origin !== expectedOrigin) {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
        }
        if (!req.headers.cookie?.includes("cockpit=")) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => handleSocket(ws));
    });

    function relay(ws: WebSocket, bridge: { argv: string[], env?: Record<string, string> }) {
        const [command, ...args] = bridge.argv;
        const child = spawn(command!, args, {
            stdio: ["pipe", "pipe", "ignore"],
            env: { ...process.env, ...bridge.env },
        });
        let buffer = Buffer.alloc(0);
        let sawBridgeInit = false;
        const toBridge = (frame: Buffer) => {
            if (child.stdin.writable) {
                child.stdin.write(`${frame.length}\n`);
                child.stdin.write(frame);
            }
        };
        child.stdout.on("data", (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
                const nl = buffer.indexOf(0x0a);
                if (nl < 0)
                    return;
                const length = Number(buffer.subarray(0, nl).toString("ascii"));
                if (buffer.length < nl + 1 + length)
                    return;
                const frame = buffer.subarray(nl + 1, nl + 1 + length);
                buffer = Buffer.from(buffer.subarray(nl + 1 + length));
                // The bridge's init is for ws, not for the client: ws answers it.
                if (!sawBridgeInit && frame[0] === 0x0a) {
                    const control = JSON.parse(frame.subarray(1).toString("utf8")) as Record<string, unknown>;
                    if (control.command === "init") {
                        sawBridgeInit = true;
                        toBridge(Buffer.from(`\n${JSON.stringify({ command: "init", version: 1, host: "localhost" })}`));
                        continue;
                    }
                }
                if (ws.readyState === ws.OPEN)
                    ws.send(Buffer.from(frame));
            }
        });
        child.on("exit", () => ws.close());
        ws.on("close", () => child.stdin.end());
        return toBridge;
    }

    function handleSocket(ws: WebSocket) {
        const send = (channel: string, payload: string) => ws.send(`${channel}\n${payload}`);
        const toBridge = options.bridge ? relay(ws, options.bridge) : null;

        // cockpit-ws speaks first, and unlike a bare bridge it supplies a
        // channel-seed and a csrf-token.
        send("", JSON.stringify({
            command: "init",
            version: 1,
            "channel-seed": "1:2!",
            host: "localhost",
            "csrf-token": "mock-csrf",
            capabilities: ["multi", "credentials", "binary", "websocket-channel-close-fix"],
            system: { version: "334" },
        }));

        ws.on("message", (raw: Buffer) => {
            const nl = raw.indexOf(0x0a);
            const channel = raw.subarray(0, nl).toString("utf8");
            if (channel !== "") {
                toBridge?.(raw);
                return;
            }
            const message = JSON.parse(raw.subarray(nl + 1).toString("utf8")) as Record<string, unknown>;
            record(message);
            if (message.command === "ping" && !message.channel) {
                send("", JSON.stringify({ ...message, command: "pong" }));
                return;
            }
            // The client's init is ws's business; everything else is the bridge's.
            if (message.command === "init")
                return;
            if (toBridge) {
                toBridge(raw);
                return;
            }
            if (message.command === "open" && message.payload === "echo")
                send("", JSON.stringify({ command: "ready", channel: message.channel }));
        });
    }

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        received,
        upgradeHeaders,
        waitFor: match => new Promise(resolve => {
            const existing = received.find(match);
            if (existing)
                resolve(existing);
            else
                waiters.push({ match, resolve });
        }),
        close: () => new Promise<void>(resolve => {
            wss.close();
            server.close(() => resolve());
        }),
    };
}
