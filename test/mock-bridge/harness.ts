/*
 * Start the mock cockpit-bridge for a test.
 *
 *   const mock = await startMock({ spawn: { "hostname": { stdout: "box\n" } } });
 *   await cockpit.spawn(["hostname"]);              // through the vendored library
 *   expect(mock.opened("stream")[0]?.spawn).toEqual(["hostname"]);
 *   mock.close();                                   // in afterEach
 *
 * The mock appends one JSON line per frame it receives to a log file (see
 * bridge.mjs), so a test can assert exactly what the client sent: D-Bus
 * calls, argv, file contents, stdin, window resizes. The log is written
 * synchronously, so it is complete as soon as the library has sent a frame;
 * waitForReceived() covers the cases where a test cannot await that.
 *
 * Like the real bridge, the mock stops processing frames ("wedged") after
 * some client mistakes; it says so on stderr ("mock-bridge: WEDGED: ..."),
 * which is in `stderr` unless onStderr was given.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamTransport } from "../../src/transport/stream.js";

export const MOCK_BRIDGE = fileURLToPath(new URL("./bridge.mjs", import.meta.url));

export type JsonObject = Record<string, unknown>;

/** One frame the mock received from the client. */
export type LogEntry =
    | { channel: string, control: JsonObject, data?: never, base64?: never }
    | { channel: string, data: string, control?: never, base64?: never }
    | { channel: string, base64: string, control?: never, data?: never };

// ---- the scenario (documented in bridge.mjs) --------------------------------

/** Scripted bytes: UTF-8 text, or raw bytes as base64. */
export type Bytes = string | { base64: string };

export interface FileSpec {
    content?: string;
    base64?: string;
    /**
     * Permission bits as a number (420 is 0644). Without these, files and
     * directories belong to the user inside its home and to root elsewhere
     * (files 0644, directories 0755); unprivileged channels are always checked.
     */
    mode?: number;
    uid?: number;
    gid?: number;
    user?: string | number;
    group?: string | number;
}

export interface MetricSpec {
    units?: string;
    semantics?: string;
    instances?: string[];
    samples?: (number | boolean | null | (number | boolean | null)[] | Record<string, number | boolean | null>)[];
}

export interface Effect {
    signal?: [path: string, iface: string, member: string, args?: unknown[]];
    properties?: [path: string, iface: string, values: JsonObject];
    invalidated?: string[];
    added?: [path: string, interfaces: Record<string, JsonObject>];
    removed?: [path: string, interfaces?: string[]];
    owner?: [name: string, owner: string | null];
    /** HTTP routes change: endpoint -> "METHOD path" -> response, or null to remove it. */
    http?: Record<string, Record<string, HttpRoute | null>>;
    /** Text written to every open keepOpen stream of a route: [endpoint, "METHOD path", text]. */
    httpData?: [endpoint: string, route: string, text: string];
    files?: Record<string, string | null | FileSpec>;
    /** files: write the existing inode in place (watchers see "changed"), instead of replacing it. */
    inPlace?: boolean;
    delayMs?: number;
    /** D-Bus: apply before the method reply instead of after it. */
    beforeReply?: boolean;
    bus?: string;
    sender?: string;
}

export interface HttpRoute {
    status?: number;
    reason?: string;
    headers?: Record<string, string>;
    /** A string is sent as is; anything else as JSON. */
    body?: unknown;
    chunks?: { data?: string, delayMs?: number }[];
    delayMs?: number;
    /** A stream only the client ends (events, stats). */
    keepOpen?: boolean;
    problem?: string;
    message?: string;
    effects?: Effect[];
}

export interface MethodOutcome {
    reply?: unknown[];
    error?: [name: string, message: string[] | string];
    effects?: Effect[];
    delayMs?: number;
    /** The reply's "type" signature, if inference is not good enough. */
    type?: string;
}

export interface MethodSpec extends MethodOutcome {
    byArgs?: (MethodOutcome & { args: unknown[] })[];
    in?: string[];
    out?: string[];
}

export interface InterfaceSpec {
    properties?: JsonObject;
    /** Properties that Properties.Set may change; every other one is read-only. */
    writable?: string[];
    methods?: Record<string, MethodSpec | null>;
    signals?: Record<string, { in?: string[] }>;
    meta?: JsonObject;
}

export interface SpawnResult {
    stdout?: Bytes;
    chunks?: { data?: string, base64?: string, stderr?: string, delayMs?: number }[];
    stderr?: string;
    /** Older spelling of stderr. */
    message?: string;
    "exit-status"?: number;
    "exit-signal"?: string | number;
    problem?: string;
    keepOpen?: boolean;
    readInput?: boolean;
    exitOn?: string;
    /** pty: output written when the client enters a line matching the regex. */
    replies?: { line: string, stdout: Bytes }[];
    effects?: Effect[];
}

export interface MockScenario {
    initDelayMs?: number;
    noInit?: boolean;
    initProblem?: string;
    version?: number;
    info?: JsonObject;
    superuser?: boolean;
    superuserFlow?: {
        prompts?: { prompt?: string, message?: string, default?: string, echo?: boolean, error?: string }[],
        password?: string,
        /** Names; or {name, label} for the real Methods shape (keyed by label, unlabelled ones left out). */
        bridges?: (string | { name: string, label?: string | null })[],
    };
    files?: Record<string, string | null | FileSpec>;
    /** endpoint (unix socket path or port) -> "METHOD path" -> response; see http.mjs */
    http?: Record<string, Record<string, HttpRoute>>;
    metrics?: Record<string, MetricSpec>;
    metricsCompress?: boolean;
    /** bus -> object path -> interface -> definition */
    dbus?: Record<string, Record<string, Record<string, InterfaceSpec | null>>>;
    /** bus -> well-known name -> unique name, or null for "no owner" */
    dbusOwners?: Record<string, Record<string, string | null>>;
    spawn?: Record<string, SpawnResult>;
    spawnPatterns?: (SpawnResult & { match: string })[];
}

// ---- the harness -----------------------------------------------------------

export interface MockOptions {
    /** Where the mock's stderr lines go. Default: collected in `stderr`. */
    onStderr?: (line: string) => void;
    /** Extra environment for the mock process. */
    env?: NodeJS.ProcessEnv;
    /** Install as the vendored library's transport. Default true. */
    install?: boolean;
}

export interface MockBridge {
    transport: StreamTransport;
    logPath: string;
    /** The mock's stderr lines, unless MockOptions.onStderr took them. */
    stderr: string[];
    /** Every frame received so far, in order. */
    received(): LogEntry[];
    /** Resolve with the first received frame matching, polling the log. */
    waitForReceived(predicate: (entry: LogEntry) => boolean, timeoutMs?: number): Promise<LogEntry>;
    /** Control messages received, optionally only those with this command. */
    controls(command?: string): JsonObject[];
    /** The "open" messages received, optionally only for one payload type. */
    opened(payload?: string): JsonObject[];
    /** Everything the client sent as data on one channel, concatenated as text. */
    sent(channel: string): string;
    close(): void;
}

export async function startMock(scenario: MockScenario = {}, options: MockOptions = {}): Promise<MockBridge> {
    const dir = mkdtempSync(join(tmpdir(), "cockpit-tui-mock-"));
    const logPath = join(dir, "received.jsonl");
    writeFileSync(logPath, "");
    // A file rather than the environment: an environment variable cannot
    // hold more than 128 KiB, too little for outputs that reach the bridge's
    // flow-control window.
    const scenarioPath = join(dir, "scenario.json");
    writeFileSync(scenarioPath, JSON.stringify(scenario));

    const stderr: string[] = [];
    const transport = new StreamTransport(["node", MOCK_BRIDGE], {
        env: { ...options.env, COCKPIT_MOCK_SCENARIO_FILE: scenarioPath, COCKPIT_MOCK_LOG: logPath },
        onStderr: options.onStderr ?? (line => stderr.push(line)),
    });

    let closed = false;
    const close = () => {
        if (closed)
            return;
        closed = true;
        transport.close();
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    };

    if (options.install !== false)
        transport.install();
    try {
        await transport.connect();
    } catch (error) {
        close();
        throw error;
    }

    const received = (): LogEntry[] => {
        let text;
        try {
            text = readFileSync(logPath, "utf8");
        } catch {
            return []; // closed already
        }
        return text.split("\n").filter(line => line).map(line => JSON.parse(line) as LogEntry);
    };

    const controls = (command?: string): JsonObject[] =>
        received().flatMap(entry => (entry.control && (command === undefined || entry.control.command === command)
            ? [entry.control] : []));

    return {
        transport,
        logPath,
        stderr,
        received,
        controls,

        opened(payload?: string): JsonObject[] {
            return controls("open").filter(open => payload === undefined || open.payload === payload);
        },

        sent(channel: string): string {
            return received()
                .filter(entry => entry.channel === channel && entry.control === undefined)
                .map(entry => entry.data ?? Buffer.from(entry.base64 ?? "", "base64").toString("utf8"))
                .join("");
        },

        async waitForReceived(predicate, timeoutMs = 2000): Promise<LogEntry> {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                const entries = received();
                const hit = entries.find(predicate);
                if (hit)
                    return hit;
                if (Date.now() > deadline) {
                    const tail = entries.slice(-5).map(entry => JSON.stringify(entry)).join("\n  ");
                    throw new Error(`no matching frame received within ${timeoutMs}ms; last frames:\n  ${tail}`);
                }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        },

        close,
    };
}
