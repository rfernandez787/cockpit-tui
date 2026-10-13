/*
 * Stream transports: a cockpit-bridge subprocess, locally or over ssh.
 *
 * Both are the same thing -- a child process with the protocol on stdin and
 * stdout -- so they differ only in the argv used to start it. Frames carry the
 * decimal length prefix here, because a pipe has no message boundaries.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { BaseTransport, type TransportOptions } from "./base.js";
import { StreamFrameParser, ProtocolError } from "./framing.js";

export interface StreamTransportOptions extends TransportOptions {
    /** Where the bridge's stderr goes. Defaults to this process's stderr. */
    onStderr?: (line: string) => void;
    /** Extra environment for the child, merged over the inherited environment. */
    env?: NodeJS.ProcessEnv;
}

export class StreamTransport extends BaseTransport {
    #child: ChildProcess | null = null;
    #parser = new StreamFrameParser();
    #stderr = "";
    readonly #argv: string[];
    readonly #onStderr: (line: string) => void;
    readonly #env: NodeJS.ProcessEnv;

    constructor(argv: string[], options: StreamTransportOptions = {}) {
        super(options);
        this.#argv = argv;
        this.#onStderr = options.onStderr ?? (line => console.error(line));
        this.#env = options.env ?? {};
    }

    /** Start the child and resolve once the init handshake completes. */
    async connect(): Promise<this> {
        const [command, ...args] = this.#argv;
        // The bridge sends its logging to journald whenever fd 2 is a socket,
        // and Node's "pipe" is a socketpair: its warnings would land in the
        // host's journal instead of our log. A FIFO is a real pipe.
        const fifo = stderrFifo();
        const child = spawn(command!, args, {
            stdio: ["pipe", "pipe", fifo ? fifo.writeFd : "pipe"],
            env: {
                ...process.env,
                // Unset, and not --privileged, makes the bridge fork its own
                // ssh-agent. We have no use for one; point it at a dead path.
                SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? "/nonexistent/cockpit-tui-no-agent",
                ...this.#env,
            },
        });
        if (fifo)
            closeSync(fifo.writeFd); // the child has its own copy; EOF follows its exit
        this.#child = child;
        const stderr: Readable = fifo ? fifo.stream : child.stderr!;

        child.stdout!.on("data", (chunk: Buffer) => {
            let frames;
            try {
                frames = this.#parser.push(chunk);
            } catch (error) {
                this.fail("protocol-error", error instanceof ProtocolError ? error.message : String(error));
                return;
            }
            for (const frame of frames) {
                // Re-join: dispatch_data takes the wire form so that filters
                // installed via cockpit.transport.filter() see what they expect.
                this.receiveFrame(Buffer.concat([
                    Buffer.from(`${frame.channel}\n`, "utf8"), frame.payload,
                ]));
            }
        });

        stderr.on("error", () => { /* nothing more to read */ });
        stderr.on("data", (chunk: Buffer) => {
            this.#stderr += chunk.toString("utf8");
            const lines = this.#stderr.split("\n");
            this.#stderr = lines.pop() ?? "";
            for (const line of lines)
                this.#onStderr(line);
        });

        child.on("error", (error: NodeJS.ErrnoException) => {
            this.fail(error.code === "ENOENT" ? "not-found" : "internal-error",
                      `${this.#argv[0]}: ${error.message}`);
        });

        child.on("exit", (code, signal) => {
            this.fail("terminated",
                      signal ? `bridge killed by ${signal}` : `bridge exited with status ${code}`);
        });

        try {
            await this.whenConnected();
        } catch (error) {
            throw new Error(`could not start ${this.#argv[0]}: ${(error as Error).message}`);
        }
        return this;
    }

    protected writeFrame(frame: Buffer): void {
        const child = this.#child;
        if (!child?.stdin?.writable)
            return;
        // Length counts the joined `<channel>\n<payload>`, not this prefix.
        child.stdin.write(`${frame.length}\n`);
        child.stdin.write(frame);
    }

    protected disconnect(): void {
        const child = this.#child;
        this.#child = null;
        if (!child)
            return;
        child.removeAllListeners("exit");
        // Closing stdin is the bridge's documented clean shutdown; it drains
        // its endpoints and exits. SIGTERM only if it ignores that.
        child.stdin?.end();
        const kill = setTimeout(() => child.kill("SIGTERM"), 2000);
        child.once("exit", () => clearTimeout(kill));
        kill.unref?.();
    }
}

/** Talk to a cockpit-bridge on this machine. */
export function localTransport(options: StreamTransportOptions & { command?: string } = {}): StreamTransport {
    return new StreamTransport([options.command ?? "cockpit-bridge"], options);
}

/**
 * Talk to a cockpit-bridge on another machine over ssh.
 *
 * This is the same mechanism Cockpit itself uses to reach remote hosts, so the
 * target needs cockpit-bridge installed but not cockpit-ws.
 */
export function sshTransport(
    host: string,
    options: StreamTransportOptions & { user?: string, sshCommand?: string, sshArgs?: string[] } = {},
): StreamTransport {
    const target = options.user ? `${options.user}@${host}` : host;
    const argv = [
        options.sshCommand ?? "ssh",
        ...(options.sshArgs ?? []),
        target,
        "cockpit-bridge",
    ];
    return new StreamTransport(argv, options);
}

/**
 * A FIFO for the child's stderr: its write end for the child, a socket on its
 * read end for us. Null where that cannot be made (no mkfifo); the caller
 * then falls back to a plain pipe.
 */
function stderrFifo(): { writeFd: number, stream: Readable } | null {
    let dir: string | null = null;
    try {
        dir = mkdtempSync(join(tmpdir(), "cockpit-tui-"));
        const path = join(dir, "stderr");
        if (spawnSync("mkfifo", ["-m", "600", path], { stdio: "ignore" }).status !== 0)
            return null;
        // Read end first and non-blocking, so opening the write end cannot block.
        const readFd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
        const writeFd = openSync(path, constants.O_WRONLY);
        return { writeFd, stream: new Socket({ fd: readFd, readable: true, writable: false }) };
    } catch {
        return null;
    } finally {
        if (dir)
            rmSync(dir, { recursive: true, force: true });
    }
}
