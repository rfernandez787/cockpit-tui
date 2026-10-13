/*
 * Rendering Ink components in tests.
 *
 * An in-tree stand-in for ink-testing-library. Ink renders into a fake TTY
 * with `debug: true`, which makes every frame one complete write, so the most
 * recent write is the current screen. `interactive: true` is forced because
 * Ink otherwise detects CI and renders only once, at unmount.
 *
 * Input goes through a real stream, so keystrokes take the same path as in
 * production: Ink's readable listener, its escape-sequence parser, and then
 * our keyboard dispatcher.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render, type Instance } from "ink";
import type { ReactElement } from "react";

// CSI and OSC sequences plus two-byte escapes: enough for everything Ink emits.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
    return text.replace(ANSI, "");
}

/** Raw byte sequences a terminal sends for the keys tests need. */
export const keys = {
    up: "\x1b[A",
    down: "\x1b[B",
    right: "\x1b[C",
    left: "\x1b[D",
    home: "\x1b[H",
    end: "\x1b[F",
    pageUp: "\x1b[5~",
    pageDown: "\x1b[6~",
    delete: "\x1b[3~",
    enter: "\r",
    escape: "\x1b",
    tab: "\t",
    shiftTab: "\x1b[Z",
    backspace: "\x7f",
    ctrl: (letter: string) => String.fromCharCode(letter.toLowerCase().charCodeAt(0) - 96),
    /** Text as a terminal in bracketed-paste mode delivers a paste. */
    paste: (text: string) => `\x1b[200~${text}\x1b[201~`,
} as const;

class FakeStdout extends EventEmitter {
    readonly isTTY = true;
    readonly frames: string[] = [];

    constructor(public columns: number, public rows: number) {
        super();
    }

    write = (data: string | Uint8Array, ...rest: unknown[]): boolean => {
        const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
        // Terminal mode switches (bracketed paste on/off) are not frames.
        // eslint-disable-next-line no-control-regex
        if (!/^(\x1b\[\?\d+[hl])+$/.test(text))
            this.frames.push(text);
        const callback = rest.find(arg => typeof arg === "function") as (() => void) | undefined;
        callback?.();
        return true;
    };

    resize(columns: number, rows: number): void {
        this.columns = columns;
        this.rows = rows;
        this.emit("resize");
    }
}

class FakeStdin extends PassThrough {
    readonly isTTY = true;
    isRaw = false;

    setRawMode(mode: boolean): this {
        this.isRaw = mode;
        return this;
    }

    ref(): this {
        return this;
    }

    unref(): this {
        return this;
    }
}

export interface Rendered {
    /** The current screen, without ANSI styling. */
    lastFrame(): string;
    /** The current screen with styling, for asserting on colour or inverse. */
    lastRawFrame(): string;
    /** Type into the app. Resolves after Ink has had a chance to react. */
    press(...input: string[]): Promise<void>;
    /** Poll until the screen matches; resolves with that screen, or throws with the last one. */
    waitFor(match: string | RegExp | ((frame: string) => boolean), timeoutMs?: number): Promise<string>;
    resize(columns: number, rows: number): void;
    rerender(node: ReactElement): void;
    unmount(): void;
    readonly instance: Instance;
    readonly stdin: FakeStdin;
}

const mounted = new Set<Rendered>();

/** Unmount everything rendered so far. Call from afterEach. */
export function cleanup(): void {
    for (const rendered of [...mounted])
        rendered.unmount();
}

const tick = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function renderInk(node: ReactElement, options: { columns?: number, rows?: number, realRender?: boolean } = {}): Rendered {
    const stdout = new FakeStdout(options.columns ?? 100, options.rows ?? 30);
    const stderr = new FakeStdout(options.columns ?? 100, options.rows ?? 30);
    const stdin = new FakeStdin();

    const instance = render(node, {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        debug: !options.realRender,
        interactive: true,
        ...(options.realRender ? { incrementalRendering: true } : {}),
        exitOnCtrlC: false,
        patchConsole: false,
    });

    const lastRawFrame = () => stdout.frames.at(-1) ?? "";
    const lastFrame = () => stripAnsi(lastRawFrame());

    const rendered: Rendered = {
        instance,
        stdin,
        lastFrame,
        lastRawFrame,
        async press(...input) {
            for (const chunk of input) {
                stdin.write(chunk);
                // A lone ESC is held back by Ink's parser until it is sure no
                // sequence follows; give that timer room to fire.
                await tick(chunk === keys.escape ? 60 : 5);
            }
            await tick(10);
        },
        async waitFor(match, timeoutMs = 3000) {
            const test = typeof match === "function"
                ? match
                : typeof match === "string"
                    ? (frame: string) => frame.includes(match)
                    : (frame: string) => match.test(frame);
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                const frame = lastFrame();
                if (test(frame))
                    return frame;
                if (Date.now() > deadline)
                    throw new Error(`timed out waiting for ${String(match)}; last frame:\n${frame}`);
                await tick(10);
            }
        },
        resize(columns, rows) {
            stdout.resize(columns, rows);
        },
        rerender(next) {
            instance.rerender(next);
        },
        unmount() {
            if (!mounted.delete(rendered))
                return;
            instance.unmount();
            instance.cleanup();
        },
    };
    mounted.add(rendered);
    return rendered;
}
