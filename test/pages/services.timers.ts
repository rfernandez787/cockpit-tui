/*
 * Timers the Services page's own code starts, tracked so a test can say none
 * is left running: an interval nobody clears polls forever, a timeout left
 * behind fires into a closed store or an unmounted view.
 *
 * Only timers created from src/pages/services/ count (the creating call's
 * stack says where): Ink, the shell and the test helpers keep their own.
 */
import { vi } from "vitest";

const OURS = /[/\\]src[/\\]pages[/\\]services[/\\]/;

interface Tracked {
    readonly kind: "timeout" | "interval";
    readonly site: string;
    done: boolean;
}

export interface TimerTracker {
    /** Our timers still pending (a timeout neither fired nor cleared, an interval not cleared), by creation site. */
    pending(): string[];
    /** How many of our timers of this kind were created. */
    created(kind: "timeout" | "interval"): number;
    restore(): void;
}

function site(): string | null {
    const frames = (new Error().stack ?? "").split("\n").slice(3);
    const ours = frames.find(frame => OURS.test(frame));
    return ours ? ours.trim() : null;
}

export function trackTimers(): TimerTracker {
    const tracked = new Map<unknown, Tracked>();
    const all: Tracked[] = [];
    const setTimeoutOriginal = globalThis.setTimeout;
    const setIntervalOriginal = globalThis.setInterval;
    const clearTimeoutOriginal = globalThis.clearTimeout;
    const clearIntervalOriginal = globalThis.clearInterval;

    const spies = [
        vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
            const where = site();
            const entry: Tracked | null = where ? { kind: "timeout", site: where, done: false } : null;
            const handle = setTimeoutOriginal((...a: unknown[]) => {
                if (entry)
                    entry.done = true;
                fn(...a);
            }, ms, ...args);
            if (entry) {
                tracked.set(handle, entry);
                all.push(entry);
            }
            return handle;
        }) as typeof setTimeout),
        vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
            const where = site();
            const handle = setIntervalOriginal(fn, ms, ...args);
            if (where) {
                const entry: Tracked = { kind: "interval", site: where, done: false };
                tracked.set(handle, entry);
                all.push(entry);
            }
            return handle;
        }) as typeof setInterval),
        vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle?: Parameters<typeof clearTimeout>[0]) => {
            const entry = tracked.get(handle);
            if (entry)
                entry.done = true;
            clearTimeoutOriginal(handle);
        }) as typeof clearTimeout),
        vi.spyOn(globalThis, "clearInterval").mockImplementation(((handle?: Parameters<typeof clearInterval>[0]) => {
            const entry = tracked.get(handle);
            if (entry)
                entry.done = true;
            clearIntervalOriginal(handle);
        }) as typeof clearInterval),
    ];

    return {
        pending: () => all.filter(entry => !entry.done).map(entry => `${entry.kind} ${entry.site}`),
        created: kind => all.filter(entry => entry.kind === kind).length,
        restore: () => spies.forEach(spy => spy.mockRestore()),
    };
}
