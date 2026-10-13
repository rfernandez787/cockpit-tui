/*
 * Line-mode prompts, for everything that happens before the TUI takes over
 * the terminal: the cockpit-ws password, its multi-step login conversation,
 * certificate trust, and the probe's escalation test.
 */
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";

export type Ask = (question: string, secret?: boolean) => Promise<string>;

/**
 * A reader for both visible answers and passwords.
 *
 * Masking goes through a mutable pass-through rather than raw mode because
 * readline owns `stdin` here; iterating the stream directly alongside it makes
 * the two fight over the same keystrokes. Muting readline's *output* leaves it
 * in sole charge of the input.
 *
 * close() must run before Ink starts: a live readline interface keeps
 * consuming stdin and would steal the TUI's keystrokes.
 */
export function createPrompter(): { ask: Ask, close: () => void } {
    // Only a terminal echoes what is typed, so only a terminal needs muting --
    // and forcing `terminal: true` on a pipe makes readline echo the input it
    // consumes, which would print a piped password.
    const isTty = stdin.isTTY === true;
    let muted = false;
    let rl: ReturnType<typeof createInterface> | null = null;
    let closed = false;
    // Aborted when the input ends or close() is called, so a question still
    // waiting for an answer fails instead of hanging the process forever.
    let ended = new AbortController();

    const output = new Writable({
        write(chunk: Buffer | string, encoding, callback) {
            if (!muted)
                stdout.write(chunk as Buffer, encoding as BufferEncoding);
            callback();
        },
    });

    // Created on first use: readline starts consuming stdin as soon as it
    // exists, and most runs never prompt at all.
    function ensure() {
        if (closed)
            throw new Error("no more input available (stdin closed)");
        if (!rl) {
            rl = createInterface({ input: stdin, output, terminal: isTty });
            rl.on("SIGINT", () => {
                muted = false;
                stdout.write("\n");
                process.exit(130);
            });
            rl.on("close", () => {
                closed = true;
                ended.abort();
            });
        }
        return rl;
    }

    const question = async (iface: ReturnType<typeof createInterface>, text: string): Promise<string> => {
        try {
            return await iface.question(text, { signal: ended.signal });
        } catch (error) {
            if ((error as Error).name === "AbortError")
                throw new Error("no more input available (stdin closed)");
            throw error;
        }
    };

    const ask: Ask = async (prompt, secret = false) => {
        const iface = ensure();
        if (!secret || !isTty) {
            const answer = (await question(iface, prompt)).trim();
            if (secret)
                stdout.write("\n"); // piped input echoes nothing, including the newline
            return answer;
        }
        // The question itself must be written before muting, or it vanishes too.
        stdout.write(prompt);
        muted = true;
        try {
            return await question(iface, "");
        } finally {
            muted = false;
            stdout.write("\n");
        }
    };

    return {
        ask,
        close: () => {
            closed = true;
            ended.abort();
            ended = new AbortController();
            if (rl) {
                rl.close();
                rl = null;
            }
        },
    };
}
