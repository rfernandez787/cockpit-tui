/*
 * The contract between the shell and a page.
 *
 * A page is a component that fills a `width` x `height` area. It is mounted
 * when shown and unmounted when the user switches away, and remounted when
 * administrative access changes -- so it may open channels freely in hooks
 * and rely on unmount to close them. State that should survive belongs in
 * usePersistentState.
 *
 * Keys: register with useKeys() at Layer.page (the default). Digits, Tab,
 * Shift+Tab, `A`, `?` and `q` belong to the shell; a page must not consume
 * them. Hints passed to useKeys appear in the footer.
 */
import type { ComponentType } from "react";

export interface PageProps {
    readonly width: number;
    readonly height: number;
}

export interface PageDefinition {
    /** Stable id, used by --page. */
    readonly id: string;
    readonly title: string;
    readonly component: ComponentType<PageProps>;
}

/*
 * Quit guards: something long-lived (a detached shell session) can ask the
 * shell to confirm before quitting. Module state rather than context because
 * the thing being guarded outlives the page component that created it.
 */
const guards = new Map<string, string>();

/** Set (or with null, clear) the reason quitting should be confirmed. */
export function setQuitGuard(id: string, reason: string | null): void {
    if (reason === null)
        guards.delete(id);
    else
        guards.set(id, reason);
}

export function quitGuards(): string[] {
    return [...guards.values()];
}

/*
 * Cleanup hooks for app shutdown: run after the TUI unmounts and before the
 * transport closes, e.g. to end a detached shell session cleanly.
 */
const shutdownHooks = new Set<() => void>();

export function onShutdown(hook: () => void): () => void {
    shutdownHooks.add(hook);
    return () => shutdownHooks.delete(hook);
}

export function runShutdownHooks(): void {
    for (const hook of [...shutdownHooks]) {
        try {
            hook();
        } catch {
            /* shutting down regardless */
        }
    }
    shutdownHooks.clear();
}

/*
 * Expected disconnects: after asking the host to reboot or power off, the
 * connection dropping is the success case. Set the reason first; the shell
 * then reports the closed connection as that, and quits with status 0.
 */
let expectedDisconnect: string | null = null;

export function expectDisconnect(reason: string | null): void {
    expectedDisconnect = reason;
}

export function expectedDisconnectReason(): string | null {
    return expectedDisconnect;
}

/*
 * Keyboard capture: a page that hosts something with a keyboard of its own
 * (the shell in the Terminal page) takes every key while that has the focus
 * -- Ctrl+C included, which otherwise quits from anywhere. The page traps
 * the keys itself (useKeys with `trap`); this is how it tells the shell's
 * Ctrl+C handler, which outranks every page, to stand down.
 */
let captured = false;

export function captureKeyboard(on: boolean): void {
    captured = on;
}

export function keyboardCaptured(): boolean {
    return captured;
}
