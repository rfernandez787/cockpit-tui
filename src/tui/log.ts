/*
 * Where console output goes while the TUI owns the terminal.
 *
 * The vendored library reports through console.warn/error/debug ("sending
 * message on closed channel", failed metrics channels, ...), the transport
 * debug log uses console.error, and the bridge's stderr is forwarded here as
 * well. Written to the terminal, any of it would tear through the frame
 * Ink is drawing. While the TUI runs, console output lands in an in-memory
 * ring instead, and in the file named by COCKPIT_TUI_LOG if set.
 */
import { appendFileSync } from "node:fs";
import { format } from "node:util";

const MAX_LINES = 2000;

export interface LogEntry {
    readonly time: number;
    readonly level: string;
    readonly text: string;
}

const entries: LogEntry[] = [];
const listeners = new Set<() => void>();
let logFile: string | null = null;

export function record(level: string, text: string): void {
    const entry = { time: Date.now(), level, text };
    entries.push(entry);
    if (entries.length > MAX_LINES)
        entries.splice(0, entries.length - MAX_LINES);
    if (logFile) {
        try {
            appendFileSync(logFile, `${new Date(entry.time).toISOString()} ${level}: ${text}\n`);
        } catch {
            logFile = null; // unwritable: stop trying rather than fail every call
        }
    }
    for (const listener of [...listeners])
        listener();
}

export function logEntries(): readonly LogEntry[] {
    return entries;
}

export function onLog(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

const LEVELS = ["log", "info", "warn", "error", "debug", "trace"] as const;

/**
 * Route console.* into the log until the returned function is called.
 * `file` (usually process.env.COCKPIT_TUI_LOG) also receives every line.
 */
export function captureConsole(file?: string): () => void {
    logFile = file || null;
    const saved = new Map(LEVELS.map(level => [level, console[level]] as const));
    for (const level of LEVELS) {
        console[level] = (...args: unknown[]) => record(level, format(...args));
    }
    return () => {
        for (const [level, fn] of saved)
            console[level] = fn as never;
        logFile = null;
    };
}

/*
 * Internal errors: exceptions that escaped a handler or a timer. They are
 * bugs, but one broken page must not end the session, so they are logged
 * and surfaced on the status line (the shell subscribes) instead.
 */
const errorListeners = new Set<(error: unknown) => void>();

export function reportInternalError(error: unknown): void {
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    record("error", `internal error: ${text}`);
    for (const listener of [...errorListeners]) {
        try {
            listener(error);
        } catch {
            /* a broken listener must not recurse into here */
        }
    }
}

export function onInternalError(listener: (error: unknown) => void): () => void {
    errorListeners.add(listener);
    return () => errorListeners.delete(listener);
}
