import { describe, it, expect, afterEach } from "vitest";
import { WebSocket as RawWebSocket } from "ws";
import cockpit from "../src/cockpit.js";
import { WsTransport, normalizeUrl, parseConversation, extractCookie } from "../src/transport/ws.js";
import { startMockWs, type MockWs } from "./mock-ws/server.js";

let server: MockWs | null = null;
let transport: WsTransport | null = null;

afterEach(async () => {
    transport?.close();
    transport = null;
    await server?.close();
    server = null;
});

describe("url and header helpers", () => {
    it("defaults a bare hostname to https on cockpit's port", () => {
        const url = normalizeUrl("server.example.com");
        expect(url.protocol).toBe("https:");
        expect(url.port).toBe("9090");
    });

    it("keeps an explicit scheme and port", () => {
        expect(normalizeUrl("http://box:8080").host).toBe("box:8080");
    });

    it("parses an X-Conversation challenge", () => {
        const header = `X-Conversation abc123 ${Buffer.from("One-time password: ").toString("base64")}`;
        expect(parseConversation(header)).toEqual({ id: "abc123", prompt: "One-time password: " });
    });

    it("ignores a challenge that is not a conversation", () => {
        expect(parseConversation("Basic realm=cockpit")).toBeNull();
        expect(parseConversation(undefined)).toBeNull();
    });

    it("picks the session cookie out of Set-Cookie", () => {
        const cookies = ["other=1; Path=/", "cockpit=abc123; Path=/; Secure; HttpOnly"];
        expect(extractCookie(cookies, "cockpit")).toBe("cockpit=abc123");
    });

    it("uses the machine-scoped cookie name when addressing a host directly", () => {
        const cookies = ["machine-cockpit+box=xyz; Path=/"];
        expect(extractCookie(cookies, "cockpit+=box")).toBe("machine-cockpit+box=xyz");
    });
});

describe("attaching to cockpit-ws", () => {
    it("logs in and completes the init handshake", async () => {
        server = await startMockWs();
        transport = new WsTransport({ url: server.url, user: "admin", password: "hunter2" });
        transport.install();
        await transport.connect();

        expect(transport.ready).toBe(true);
        // Our half of the handshake reaches the server.
        await expect(server.waitFor(m => m.command === "init"))
            .resolves.toMatchObject({ command: "init", version: 1 });
    });

    it("negotiates the cockpit1 subprotocol and sends a matching Origin", async () => {
        server = await startMockWs();
        transport = new WsTransport({ url: server.url, user: "admin", password: "hunter2" });
        transport.install();
        await transport.connect();

        const headers = server.upgradeHeaders;
        expect(headers["sec-websocket-protocol"]).toBe("cockpit1");
        expect(headers.cookie).toContain("cockpit=");
        // Must match Host and scheme exactly, or cockpit-ws answers 403.
        expect(headers.origin).toBe(`http://${headers.host}`);
    });

    it("adopts the channel-seed so ids stay unique across sockets", async () => {
        server = await startMockWs();
        transport = new WsTransport({ url: server.url, user: "admin", password: "hunter2" });
        transport.install();
        await transport.connect();

        // The mock sends "1:2!" as its seed.
        expect(transport.next_channel()).toMatch(/^1:2!\d+$/);
    });

    it("rejects a wrong password", async () => {
        server = await startMockWs();
        transport = new WsTransport({ url: server.url, user: "admin", password: "wrong" });
        transport.install();
        await expect(transport.connect()).rejects.toThrow(/authentication failed/i);
    });

    it("walks a multi-round X-Conversation challenge", async () => {
        server = await startMockWs({
            conversation: [
                { prompt: "One-time password: ", expect: "123456" },
                { prompt: "Confirm: ", expect: "yes", echo: true },
            ],
        });
        const seen: string[] = [];
        transport = new WsTransport({
            url: server.url, user: "admin", password: "hunter2",
            onPrompt: async prompt => {
                seen.push(prompt.prompt);
                return prompt.prompt.startsWith("One-time") ? "123456" : "yes";
            },
        });
        transport.install();
        await transport.connect();

        expect(seen).toEqual(["One-time password: ", "Confirm: "]);
        expect(transport.ready).toBe(true);
    });

    it("reports the echo flag so secrets can be masked", async () => {
        server = await startMockWs({
            conversation: [{ prompt: "Password: ", expect: "s3cret", echo: false }],
        });
        let sawEcho: boolean | null = null;
        transport = new WsTransport({
            url: server.url, user: "admin", password: "hunter2",
            onPrompt: async prompt => { sawEcho = prompt.echo; return "s3cret" },
        });
        transport.install();
        await transport.connect();
        expect(sawEcho).toBe(false);
    });

    it("fails usefully when a challenge arrives with no prompt handler", async () => {
        server = await startMockWs({
            conversation: [{ prompt: "One-time password: ", expect: "123456" }],
        });
        transport = new WsTransport({ url: server.url, user: "admin", password: "hunter2" });
        transport.install();
        await expect(transport.connect()).rejects.toThrow(/no onPrompt handler/);
    });

    it("is refused when the Origin header is missing", async () => {
        // The classic non-browser client failure, and the reason the transport
        // sets Origin explicitly: cockpit-ws derives its allowed origin from the
        // request host and rejects anything else. Proven here with a raw client.
        server = await startMockWs({ enforceOrigin: true });
        const raw = new RawWebSocket(`${server.url.replace("http", "ws")}/cockpit/socket`, ["cockpit1"], {
            headers: { Cookie: "cockpit=anything" }, // no Origin
        });
        const error = await new Promise<Error>(resolve => {
            raw.on("error", resolve);
            raw.on("open", () => resolve(new Error("unexpectedly accepted")));
        });
        expect(error.message).toMatch(/403|Unexpected server response/);
        raw.close();
    });

    it("opens channels over the socket using ws framing", async () => {
        server = await startMockWs();
        transport = new WsTransport({ url: server.url, user: "admin", password: "hunter2" });
        transport.install();
        await transport.connect();

        const channel = cockpit.channel({ payload: "echo" });
        await new Promise<void>(resolve => channel.addEventListener("ready", () => resolve()));

        const open = server.received.find(m => m.command === "open");
        expect(open).toMatchObject({ command: "open", payload: "echo" });
        channel.close();
    });
});
