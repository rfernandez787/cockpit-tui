/*
 * The shell session: one per connection, outliving the page that shows it.
 *
 * Upstream keeps a visited page's iframe alive when you navigate away, so a
 * terminal session survives a trip to another page. Here the session lives
 * in this module rather than in a component: the Terminal page mounts and
 * unmounts as the user moves around, is remounted when administrative access
 * changes, and is swapped out entirely when the connection drops. None of
 * that may touch the shell. The page only renders snapshots and calls the
 * methods below.
 *
 * The shell runs in a terminal emulator, as upstream's does: xterm.js, here
 * its headless build (no DOM, no renderer). The pty's bytes are written into
 * it and it keeps the screen -- a grid of cells with their colours -- and the
 * scrollback; the page draws that grid inside a panel (screen.ts). The
 * emulator lives here, with the session, so output is parsed and scrollback
 * kept while another page is shown.
 *
 * Two things flow back to the pty: what the user types (send()), and what
 * the emulator itself answers when a program asks the terminal something --
 * the cursor position, its device attributes (onData). Without the second,
 * programs that ask (vim, tmux, some prompts) wait or misdraw.
 *
 * TERM is xterm-256color whatever the user's own terminal is: the emulator
 * is what the shell's programs talk to, and the page translates its cells
 * for the real terminal.
 *
 * Resizes go only to this pty channel, only with sizes window.ts approved,
 * and only when the size changed: a bad one wedges the whole bridge (G1).
 */
import xterm from "@xterm/headless";
import type { Terminal as Emulator } from "@xterm/headless";
import cockpit from "../../cockpit.js";
import { run as runProcess } from "../../tui/hooks.js";
import { record } from "../../tui/log.js";
import { onShutdown, setQuitGuard } from "../../tui/page.js";
import { errorText } from "../../tui/status.js";
import { endingFromClose, type Ending } from "./describe.js";
import { sameWindow, windowSize, type WindowSize } from "./window.js";

/** Login shell when the user's record has none. */
export const DEFAULT_SHELL = "/bin/sh";
/** What the emulator is, to the programs in it. */
export const TERM = "xterm-256color";
/** The bridge never answers an open with a malformed window (G2); nor should anything else hang forever. */
export const OPEN_TIMEOUT_MS = 20_000;
const LOOKUP_TIMEOUT_MS = 10_000;
/** Resizes during a window drag come in bursts; the shell only needs the last. */
export const RESIZE_DEBOUNCE_MS = 30;
/** Repaint at most this often while output streams in. */
export const REPAINT_MS = 33;
/** Lines kept above the screen. */
export const SCROLLBACK = 2000;
/** Keys typed before the channel exists are kept, up to this much. */
const MAX_PENDING_INPUT = 64 * 1024;

const GUARD = "terminal";
const GUARD_REASON = "A shell is running in the Terminal page; quitting ends it.";

/** What runs: from the user's passwd entry. */
export interface Launch {
    readonly shell: string;
    readonly home: string | null;
}

export type Phase = "idle" | "starting" | "running" | "ended";

export interface TerminalSnapshot {
    readonly phase: Phase;
    /** What will run, or ran: known once the user lookup finished. Raw host text. */
    readonly launch: Launch | null;
    readonly pid: number | null;
    readonly startedAt: number | null;
    readonly endedAt: number | null;
    readonly ending: Ending | null;
    /** The pty's size, as last sent. */
    readonly window: WindowSize | null;
    /** The window title the shell's programs set (OSC 0/2). Raw host text. */
    readonly title: string | null;
    /** The connection is gone: nothing can be started any more. */
    readonly connectionLost: boolean;
    readonly error: string | null;
    /** Changes whenever the screen may have: what the page repaints on. */
    readonly version: number;
}

const IDLE: TerminalSnapshot = {
    phase: "idle", launch: null, pid: null, startedAt: null, endedAt: null, ending: null, window: null,
    title: null, connectionLost: false, error: null, version: 0,
};

/** One shell, from start to end. A restart is a new Run, so stale callbacks are easy to spot. */
interface Run {
    phase: "starting" | "running" | "ended";
    channel: cockpit.Channel<Uint8Array> | null;
    /** We closed the channel: its close event carries no exit status (G7). */
    closedByUs: boolean;
    /** Why we closed it, when that was not the user's doing (the open timeout). */
    forcedEnding: Ending | null;
    /** Typed before the channel was opened. */
    pending: Uint8Array[];
    pendingBytes: number;
    launch: Launch | null;
    pid: number | null;
    readonly startedAt: number;
    endedAt: number | null;
    ending: Ending | null;
    /** The screen: kept after the shell ends, so its last output can be read. */
    readonly emulator: Emulator;
    title: string | null;
    /** Last size sent to the pty (and given to the emulator). */
    window: WindowSize;
    openTimer: NodeJS.Timeout | null;
}

interface TransportLike {
    on(event: "close", handler: (problem?: string) => void): () => void;
    /** Why the connection closed, or null while it is open (BaseTransport). */
    readonly closedProblem?: string | null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
        timer.unref?.();
        promise.then(
            value => { clearTimeout(timer); resolve(value) },
            (error: unknown) => { clearTimeout(timer); reject(error) });
    });
}

export class TerminalStore {
    #run: Run | null = null;
    #snapshot: TerminalSnapshot = IDLE;
    #version = 0;
    #listeners = new Set<() => void>();
    #lookup: Promise<Launch> | null = null;
    #launch: Launch | null = null;
    #lost = false;
    #error: string | null = null;
    #transport: TransportLike | null = null;
    #unwatchTransport: (() => void) | null = null;
    #unhookShutdown: (() => void) | null = null;
    #resizeTimer: NodeJS.Timeout | null = null;
    #repaintTimer: NodeJS.Timeout | null = null;
    #wanted: WindowSize | null = null;

    readonly subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };

    readonly getSnapshot = (): TerminalSnapshot => this.#snapshot;

    /** The emulator holding the current (or last) shell's screen; null before the first one. */
    get emulator(): Emulator | null {
        return this.#run?.emulator ?? null;
    }

    #notify(): void {
        if (this.#repaintTimer) {
            clearTimeout(this.#repaintTimer);
            this.#repaintTimer = null;
        }
        this.#version++;
        const run = this.#run;
        this.#snapshot = {
            phase: run ? run.phase : "idle",
            launch: run?.launch ?? this.#launch,
            pid: run?.pid ?? null,
            startedAt: run?.startedAt ?? null,
            endedAt: run?.endedAt ?? null,
            ending: run?.ending ?? null,
            window: run?.window ?? null,
            title: run?.title ?? null,
            connectionLost: this.#lost,
            error: this.#error,
            version: this.#version,
        };
        for (const listener of [...this.#listeners]) {
            try {
                listener();
            } catch (error) {
                record("error", `terminal: listener failed: ${errorText(error)}`);
            }
        }
    }

    /** The screen changed: repaint, but not once per chunk of a long listing. */
    #screenChanged(): void {
        if (this.#repaintTimer)
            return;
        this.#repaintTimer = setTimeout(() => {
            this.#repaintTimer = null;
            this.#notify();
        }, REPAINT_MS);
        this.#repaintTimer.unref?.();
    }

    // ---- preparing: who the user is ---------------------------------------------------

    /**
     * Look up the shell and home directory ahead of time, so Enter starts
     * the shell at once; and watch the connection, so nothing is started on
     * a dead one (the library would build a browser transport).
     */
    prepare(transport: TransportLike | null = null): void {
        if (transport && transport !== this.#transport) {
            this.#unwatchTransport?.();
            this.#transport = transport;
            this.#unwatchTransport = transport.on("close", () => {
                this.#lost = true;
                this.#notify();
            });
        }
        void this.#lookupLaunch();
    }

    #lookupLaunch(): Promise<Launch> {
        if (!this.#lookup) {
            const lookup = lookupUser();
            this.#lookup = lookup;
            void lookup.then(launch => {
                if (this.#lookup !== lookup)
                    return; // shut down meanwhile
                this.#launch = launch;
                this.#notify();
            });
        }
        return this.#lookup;
    }

    // ---- starting ---------------------------------------------------------------------

    /** Start a new shell in a window of `size`. Does nothing while one is starting or running. */
    start(size: WindowSize): void {
        if (this.#run && this.#run.phase !== "ended")
            return;
        if (this.#lost) {
            this.#error = "The connection is gone; no shell can be started.";
            this.#notify();
            return;
        }
        const window = windowSize(size.rows, size.cols) ?? { rows: 24, cols: 80 };
        this.#error = null;
        this.#run?.emulator.dispose();

        const emulator = new xterm.Terminal({
            rows: window.rows, cols: window.cols, scrollback: SCROLLBACK, allowProposedApi: true,
        });
        const run: Run = {
            phase: "starting", channel: null, closedByUs: false, forcedEnding: null, pending: [], pendingBytes: 0,
            launch: null, pid: null, startedAt: Date.now(), endedAt: null, ending: null,
            emulator, title: null, window, openTimer: null,
        };
        // The emulator's own answers to the programs in it, and anything it turns into input.
        emulator.onData(data => {
            if (this.#run === run)
                this.send(Buffer.from(data, "utf8"));
        });
        emulator.onBinary(data => {
            if (this.#run === run)
                this.send(Buffer.from(data, "binary"));
        });
        emulator.onTitleChange(title => {
            run.title = title || null;
            if (this.#run === run)
                this.#screenChanged();
        });
        emulator.onWriteParsed(() => {
            if (this.#run === run)
                this.#screenChanged();
        });
        this.#run = run;
        this.#wanted = window;
        setQuitGuard(GUARD, GUARD_REASON);
        this.#unhookShutdown ??= onShutdown(() => this.shutdown());
        this.#notify();
        void this.#open(run);
    }

    async #open(run: Run): Promise<void> {
        const launch = await this.#lookupLaunch();
        if (this.#run !== run || run.phase === "ended")
            return; // closed or shut down while looking up
        if (this.#lost) {
            this.#end(run, { kind: "lost", problem: "disconnected", message: "" });
            return;
        }
        run.launch = launch;
        // The size may have changed during the lookup.
        if (this.#wanted && !sameWindow(this.#wanted, run.window)) {
            run.window = this.#wanted;
            run.emulator.resize(run.window.cols, run.window.rows);
        }

        let channel: cockpit.Channel<Uint8Array>;
        try {
            channel = cockpit.channel({
                payload: "stream",
                spawn: [launch.shell],
                environ: [`TERM=${TERM}`],
                ...(launch.home ? { directory: launch.home } : {}),
                pty: true,
                binary: true,
                window: { rows: run.window.rows, cols: run.window.cols },
                // Ignored with a pty, but stops channel.js console.warn-ing the close message (G23).
                err: "message",
            });
        } catch (error) {
            this.#end(run, { kind: "failed", problem: "internal-error", message: errorText(error) });
            return;
        }
        run.channel = channel;
        channel.addEventListener("ready", (_event, message) => this.#ready(run, message));
        channel.addEventListener("message", (_event, data) => this.#output(run, data));
        channel.addEventListener("close", (_event, message) => this.#closed(run, message));
        if (run.phase !== "starting")
            return; // closed synchronously (a dead transport fails channels at once)

        run.openTimer = setTimeout(() => {
            run.openTimer = null;
            if (this.#run === run && run.phase === "starting") {
                record("warn", "terminal: the shell channel never became ready");
                run.closedByUs = true;
                run.forcedEnding = {
                    kind: "failed", problem: "timeout",
                    message: `the shell did not start within ${OPEN_TIMEOUT_MS / 1000} seconds`,
                };
                channel.close(); // its close event ends the run, synchronously
            }
        }, OPEN_TIMEOUT_MS);
        run.openTimer.unref?.();

        // Keys typed while the channel was being set up. The bridge queues
        // input that arrives before the process is spawned.
        for (const bytes of run.pending)
            channel.send(bytes);
        run.pending = [];
        run.pendingBytes = 0;
        this.#notify();
    }

    #ready(run: Run, message: Record<string, unknown>): void {
        if (this.#run !== run || run.phase !== "starting")
            return;
        if (run.openTimer) {
            clearTimeout(run.openTimer);
            run.openTimer = null;
        }
        run.pid = typeof message.pid === "number" && Number.isInteger(message.pid) ? message.pid : null;
        run.phase = "running";
        this.#notify();
    }

    #output(run: Run, data: Uint8Array): void {
        if (this.#run !== run)
            return;
        // Parsed asynchronously, in order; onWriteParsed repaints.
        run.emulator.write(data);
    }

    #closed(run: Run, message: Record<string, unknown>): void {
        if (this.#run !== run || run.phase === "ended")
            return;
        let ending = run.forcedEnding ?? endingFromClose(message, run.closedByUs);
        if (ending.kind === "failed") {
            // The transport fails every channel with its own problem when the
            // connection breaks (a keep-alive timeout, a bad frame) before it
            // says it closed: that is the connection, not the shell.
            if (this.#transport?.closedProblem != null)
                ending = { kind: "lost", problem: ending.problem, message: ending.message };
            else if (run.phase === "running")
                ending = { kind: "aborted", problem: ending.problem, message: ending.message };
        }
        if (ending.kind === "lost")
            this.#lost = true;
        this.#end(run, ending);
    }

    #end(run: Run, ending: Ending): void {
        if (run.openTimer) {
            clearTimeout(run.openTimer);
            run.openTimer = null;
        }
        run.phase = "ended";
        run.ending = ending;
        run.endedAt = Date.now();
        run.channel = null;
        run.pending = [];
        run.pendingBytes = 0;
        setQuitGuard(GUARD, null);
        this.#notify();
    }

    // ---- input and actions ---------------------------------------------------------------

    /** Send bytes to the shell as if typed. */
    send(bytes: Uint8Array): void {
        const run = this.#run;
        if (!run || run.phase === "ended" || bytes.length === 0)
            return;
        if (run.channel) {
            run.channel.send(bytes);
        } else if (run.pendingBytes + bytes.length <= MAX_PENDING_INPUT) {
            run.pending.push(bytes);
            run.pendingBytes += bytes.length;
        }
    }

    /** Typing brings the screen back from the scrollback to where the shell is. */
    type(text: string): void {
        if (!text)
            return;
        this.scrollToBottom();
        this.send(Buffer.from(text, "utf8"));
    }

    /** The modes of the programs in the shell that change what keys must send. */
    get modes(): { readonly applicationCursor: boolean, readonly bracketedPaste: boolean } {
        const modes = this.#run?.emulator.modes;
        return {
            applicationCursor: modes?.applicationCursorKeysMode ?? false,
            bracketedPaste: modes?.bracketedPasteMode ?? false,
        };
    }

    /** Scroll the view into the scrollback (negative: back) by lines. */
    scroll(lines: number): void {
        const emulator = this.#run?.emulator;
        if (!emulator || lines === 0)
            return;
        const before = emulator.buffer.active.viewportY;
        emulator.scrollLines(lines);
        if (emulator.buffer.active.viewportY !== before)
            this.#notify();
    }

    scrollToBottom(): void {
        const emulator = this.#run?.emulator;
        if (!emulator)
            return;
        const buffer = emulator.buffer.active;
        if (buffer.viewportY !== buffer.baseY) {
            emulator.scrollToBottom();
            this.#notify();
        }
    }

    /**
     * The room the page has for the screen. The pty and the emulator follow,
     * once a burst of resizes is over.
     */
    resize(size: WindowSize): void {
        const safe = windowSize(size.rows, size.cols);
        if (!safe)
            return;
        this.#wanted = safe;
        const run = this.#run;
        if (!run || sameWindow(safe, run.window) || this.#resizeTimer)
            return;
        this.#resizeTimer = setTimeout(() => {
            this.#resizeTimer = null;
            const current = this.#run;
            const wanted = this.#wanted;
            if (!current || !wanted || sameWindow(wanted, current.window))
                return;
            current.window = wanted;
            current.emulator.resize(wanted.cols, wanted.rows);
            // Only ever to this pty channel, only with checked values (G1).
            if (current.phase !== "ended" && current.channel?.valid)
                current.channel.control({ command: "options", window: { rows: wanted.rows, cols: wanted.cols } });
            this.#notify();
        }, RESIZE_DEBOUNCE_MS);
        this.#resizeTimer.unref?.();
    }

    /**
     * Close the shell: the bridge closes the pty and sends SIGTERM, so the
     * session gets SIGHUP. Programs that ignore both survive (G9), as in any
     * terminal.
     */
    kill(): void {
        const run = this.#run;
        if (!run || run.phase === "ended")
            return;
        run.closedByUs = true;
        // Closing fires our close handler synchronously (channel.js), which ends the run.
        run.channel?.close();
        // Re-read: TypeScript cannot see that close() changed it.
        if ((run.phase as Run["phase"]) !== "ended")
            this.#end(run, { kind: "killed" }); // stopped before the channel even existed
    }

    /**
     * Does the shell have a child process? Upstream's check: true, false, or
     * null when it could not tell.
     */
    async busy(): Promise<boolean | null> {
        const pid = this.#run?.pid;
        if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
            return null;
        const script = `grep -qr '^PPid:[[:space:]]*${pid}$' /proc/*/status`;
        try {
            await runProcess(["/bin/sh", "-c", script, "--"], {}, AbortSignal.timeout(5000));
            return true;
        } catch (error) {
            // 1: no match. 2: errors, typically /proc entries of processes
            // that exited during the scan -- which are not running either.
            const status = (error as { exit_status?: unknown } | null)?.exit_status;
            return status === 1 || status === 2 ? false : null;
        }
    }

    // ---- the end of everything ---------------------------------------------------------

    /** App shutdown (onShutdown), and test teardown: close the shell, forget everything. */
    shutdown(): void {
        const run = this.#run;
        this.#unhookShutdown?.();
        this.#unhookShutdown = null;
        this.#run = null; // from here on, the old run's callbacks are ignored
        if (run) {
            if (run.phase !== "ended") {
                run.closedByUs = true;
                if (run.openTimer)
                    clearTimeout(run.openTimer);
                try {
                    run.channel?.close();
                } catch { /* the transport may be gone */ }
            }
            run.emulator.dispose();
        }
        setQuitGuard(GUARD, null);
        for (const timer of [this.#resizeTimer, this.#repaintTimer])
            if (timer)
                clearTimeout(timer);
        this.#resizeTimer = null;
        this.#repaintTimer = null;
        this.#unwatchTransport?.();
        this.#unwatchTransport = null;
        this.#transport = null;
        this.#lookup = null;
        this.#launch = null;
        this.#wanted = null;
        this.#lost = false;
        this.#error = null;
        this.#notify();
    }
}

/** The user's login shell and home: cockpit.user() as upstream, else cockpit.info, else defaults. */
async function lookupUser(): Promise<Launch> {
    const info = (cockpit.info as { user?: { shell?: string, home?: string } } | undefined)?.user;
    try {
        const user = await withTimeout(cockpit.user(), LOOKUP_TIMEOUT_MS, "cockpit.user()");
        return { shell: user.shell || info?.shell || DEFAULT_SHELL, home: user.home || info?.home || null };
    } catch (error) {
        record("warn", `terminal: looking up the user failed: ${errorText(error)}`);
        return { shell: info?.shell || DEFAULT_SHELL, home: info?.home || null };
    }
}

/** The session. One per process: there is one connection. */
export const terminal = new TerminalStore();
