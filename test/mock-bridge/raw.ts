/*
 * The mock bridge on raw stdio, without the vendored library in between.
 *
 * For tests of protocol mistakes the library would never make (or refuses to
 * send), and of how the bridge process itself behaves: exit status, frames
 * after the client's EOF, frames a wedged bridge no longer answers.
 *
 *   const raw = await startRaw({ spawn: { cat: { readInput: true } } });
 *   raw.control({ command: "open", channel: "a", payload: "stream", spawn: ["cat"] });
 *   await raw.next(f => f.control?.command === "ready");
 *   raw.close();
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOCK_BRIDGE, type JsonObject, type MockScenario } from "./harness.js";

export interface RawFrame {
    channel: string;
    /** Control messages, parsed. */
    control?: JsonObject;
    /** Channel data, as received. */
    data?: Buffer;
}

export interface RawBridge {
    /** Every frame received so far (the bridge's init included). */
    frames: RawFrame[];
    /** What the mock wrote to stderr so far. */
    stderr(): string;
    control(message: JsonObject): void;
    send(channel: string, data: string | Uint8Array): void;
    /** Resolve with the first frame (received so far or later) matching, or null after timeoutMs. */
    next(predicate: (frame: RawFrame) => boolean, timeoutMs?: number): Promise<RawFrame | null>;
    /** Frames of one channel. */
    of(channel: string): RawFrame[];
    /** Close the mock's stdin. */
    end(): void;
    exited: Promise<{ code: number | null, signal: NodeJS.Signals | null }>;
    close(): void;
}

export async function startRaw(scenario: MockScenario = {}, init: JsonObject = {}): Promise<RawBridge> {
    const dir = mkdtempSync(join(tmpdir(), "cockpit-tui-raw-"));
    const scenarioPath = join(dir, "scenario.json");
    writeFileSync(scenarioPath, JSON.stringify(scenario));
    const child = spawn(process.execPath, [MOCK_BRIDGE], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, COCKPIT_MOCK_SCENARIO_FILE: scenarioPath, COCKPIT_MOCK_LOG: "" },
    });
    child.stdin.on("error", () => {});

    const frames: RawFrame[] = [];
    const waiters = new Set<() => void>();
    let buffer = Buffer.alloc(0);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
            const nl = buffer.indexOf(0x0a);
            if (nl < 0)
                break;
            const length = Number(buffer.subarray(0, nl).toString("ascii"));
            if (buffer.length < nl + 1 + length)
                break;
            const frame = buffer.subarray(nl + 1, nl + 1 + length);
            buffer = Buffer.from(buffer.subarray(nl + 1 + length));
            const split = frame.indexOf(0x0a);
            const channel = frame.subarray(0, split).toString("utf8");
            const payload = Buffer.from(frame.subarray(split + 1));
            if (channel === "") {
                const control = JSON.parse(payload.toString("utf8")) as JsonObject;
                frames.push({ channel: typeof control.channel === "string" ? control.channel : "", control });
            } else {
                frames.push({ channel, data: payload });
            }
        }
        for (const waiter of [...waiters])
            waiter();
    });
    const exited = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>(resolve => {
        child.on("exit", (code, signal) => {
            resolve({ code, signal });
            for (const waiter of [...waiters])
                waiter();
        });
    });

    const write = (channel: string, payload: Buffer) => {
        const frame = Buffer.concat([Buffer.from(`${channel}\n`, "utf8"), payload]);
        child.stdin.write(`${frame.length}\n`);
        child.stdin.write(frame);
    };

    const next = (predicate: (frame: RawFrame) => boolean, timeoutMs = 2000): Promise<RawFrame | null> =>
        new Promise(resolve => {
            const check = () => {
                const hit = frames.find(predicate);
                if (hit || child.exitCode !== null || child.signalCode !== null) {
                    waiters.delete(check);
                    clearTimeout(timer);
                    resolve(hit ?? null);
                }
            };
            const timer = setTimeout(() => {
                waiters.delete(check);
                resolve(frames.find(predicate) ?? null);
            }, timeoutMs);
            waiters.add(check);
            check();
        });

    const raw: RawBridge = {
        frames,
        stderr: () => stderr,
        control: message => write("", Buffer.from(JSON.stringify(message), "utf8")),
        send: (channel, data) => write(channel, typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)),
        next,
        of: channel => frames.filter(frame => frame.channel === channel),
        end: () => child.stdin.end(),
        exited,
        close: () => {
            child.kill("SIGTERM");
            rmSync(dir, { recursive: true, force: true });
        },
    };

    if (!await next(frame => frame.control?.command === "init", 5000)) {
        raw.close();
        throw new Error(`the mock sent no init; stderr: ${stderr}`);
    }
    raw.control({ command: "init", version: 1, host: "localhost", ...init });
    return raw;
}
