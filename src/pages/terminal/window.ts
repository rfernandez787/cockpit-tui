/*
 * Terminal window sizes, validated before they reach the bridge.
 *
 * cockpit-bridge 356 applies a size with struct.pack('2H4x', rows, cols)
 * and asserts that the channel has a pty. Neither failure is caught by its
 * frame handler, so the offending frame is never consumed: it is re-raised on
 * every later read and the bridge stops processing anything the client sends,
 * on every channel, for the rest of the connection (spec G1). An invalid
 * `window` in an open message hangs that channel instead, with no ready and
 * no close (G2). So no size reaches the wire unless both values are integers
 * in 1..65535, and resizes go only to the pty channel that asked for one.
 *
 * Serial consoles often report a 0x0 window, because nothing ever set one.
 * Ink then lays itself out for COLUMNS/LINES or 80x24; the shell gets the
 * same assumption, so what it draws matches what the user is looking at.
 */

export interface WindowSize {
    readonly rows: number;
    readonly cols: number;
}

export const MAX_DIMENSION = 65535;

const FALLBACK: WindowSize = { rows: 24, cols: 80 };

/** An integer in 1..MAX_DIMENSION, or null for anything that is not a finite number. */
export function clampDimension(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value))
        return null;
    return Math.min(MAX_DIMENSION, Math.max(1, Math.trunc(value)));
}

/** A size that is safe to send, or null when either value is unusable. */
export function windowSize(rows: unknown, cols: unknown): WindowSize | null {
    const r = clampDimension(rows);
    const c = clampDimension(cols);
    return r === null || c === null ? null : { rows: r, cols: c };
}

export function sameWindow(a: WindowSize | null, b: WindowSize | null): boolean {
    return a !== null && b !== null && a.rows === b.rows && a.cols === b.cols;
}

/** A positive integer from the environment (COLUMNS, LINES), or null. */
function fromEnvironment(value: string | undefined): number | null {
    if (!value || !/^\d+$/.test(value))
        return null;
    const n = Number(value);
    return n > 0 ? n : null;
}

export interface MeasuredWindow extends WindowSize {
    /** The terminal reported no size; this is the 80x24 (or COLUMNS/LINES) guess. */
    readonly assumed: boolean;
}

/**
 * The size of the user's terminal as a pty window: what the stream reports,
 * else COLUMNS/LINES, else 80x24 -- the order Ink itself falls back in.
 */
export function measureWindow(stream: { rows?: number, columns?: number }, env: NodeJS.ProcessEnv = process.env): MeasuredWindow {
    const reportedRows = typeof stream.rows === "number" && stream.rows > 0 ? stream.rows : null;
    const reportedCols = typeof stream.columns === "number" && stream.columns > 0 ? stream.columns : null;
    const rows = reportedRows ?? fromEnvironment(env.LINES) ?? FALLBACK.rows;
    const cols = reportedCols ?? fromEnvironment(env.COLUMNS) ?? FALLBACK.cols;
    // measureWindow's inputs are never null here, so neither is the result.
    const size = windowSize(rows, cols)!;
    return { ...size, assumed: reportedRows === null || reportedCols === null };
}
