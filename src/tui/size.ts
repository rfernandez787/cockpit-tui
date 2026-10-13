/*
 * The terminal's size, as React state that is current before Ink redraws.
 *
 * Ink redraws on "resize" straight away, with whatever the React tree last
 * rendered -- laid out for the old size. Narrowed, those lines wrap, the
 * screen scrolls, and every later incremental update lands a line off: rows
 * vanish, the footer appears twice. run.tsx therefore listens first and, via
 * resizeNow(), commits the new size into React synchronously before Ink's
 * own handler runs, so Ink's redraw is already the right layout.
 */
import { useEffect, useState } from "react";
import { useStdout } from "ink";
import reconciler from "ink-reconciler";

const listeners = new Set<() => void>();

/** Commit the current size to every useTerminalSize() now. */
export function resizeNow(): void {
    reconciler.discreteUpdates(() => {
        for (const listener of [...listeners])
            listener();
    });
    reconciler.flushSyncWork();
}

export interface TerminalSize {
    readonly columns: number;
    readonly rows: number;
}

export function useTerminalSize(): TerminalSize {
    const { stdout } = useStdout();
    const read = () => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    const [size, setSize] = useState<TerminalSize>(read);
    useEffect(() => {
        const update = () => setSize(previous => {
            const next = read();
            return next.columns === previous.columns && next.rows === previous.rows ? previous : next;
        });
        listeners.add(update);
        // Also on our own: in tests nobody calls resizeNow().
        stdout.on("resize", update);
        update();
        return () => {
            listeners.delete(update);
            stdout.off("resize", update);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stdout]);
    return size;
}
