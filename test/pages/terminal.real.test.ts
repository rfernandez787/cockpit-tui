/*
 * The Terminal page's session store against a real cockpit-bridge: the real
 * user lookup, the real shell on a real pty at the size we asked for, its
 * output on the emulator's screen, a resize the shell sees, the emulator
 * answering what programs ask the terminal, a real exit status, the busy
 * probe, and a closed shell really gone.
 *
 * Harmless by construction. The shell is the user's own login shell, as the
 * page would start it, and it is only ever given `unset HISTFILE` first (so
 * nothing lands in ~/.bash_history), then `stty size`, `tty`, `echo`,
 * `printf`, `read` and `exit`. Every shell is closed in afterEach; closing
 * sends it SIGHUP, as closing any terminal window does. Skips without a bridge.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import cockpit from "../../src/cockpit.js";
import { localTransport, type StreamTransport } from "../../src/transport/stream.js";
import { TerminalStore } from "../../src/pages/terminal/store.js";
import { screenRows } from "../../src/pages/terminal/screen.js";

const haveBridge = spawnSync("cockpit-bridge", ["--version"], { stdio: "ignore" }).status === 0;

let transport: StreamTransport | null = null;
let store: TerminalStore | null = null;

afterEach(() => {
    store?.shutdown();
    store = null;
    transport?.close();
    transport = null;
});

async function connect(): Promise<TerminalStore> {
    transport = localTransport({ onStderr: () => {} });
    transport.install();
    await transport.connect();
    store = new TerminalStore();
    store.prepare(transport);
    return store;
}

async function waitFor<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = check();
        if (value)
            return value;
        if (Date.now() > deadline)
            throw new Error(`timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

/** Everything on the emulator's screen and in its scrollback, as text. */
function screenText(s: TerminalStore): string {
    const emulator = s.emulator!;
    const buffer = emulator.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y++)
        lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
    return lines.join("\n");
}

/** Type a line into the shell and wait for `expected` on its screen. */
async function command(s: TerminalStore, line: string, expected: RegExp): Promise<string> {
    s.send(Buffer.from(`${line}\r`));
    return (await waitFor(`${JSON.stringify(line)} to print ${String(expected)}; got ${JSON.stringify(screenText(s).slice(-300))}`,
        () => expected.exec(screenText(s))))[0];
}

/** Start the shell, and stop it from writing history. */
async function shell(s: TerminalStore, cols = 100, rows = 30): Promise<void> {
    s.start({ rows, cols });
    await waitFor("the shell to start", () => s.getSnapshot().phase === "running");
    await waitFor("the shell's first output", () => screenText(s).trim().length > 0);
    await command(s, "unset HISTFILE; echo hist-$((6*7))", /hist-42/);
}

describe.skipIf(!haveBridge)("the Terminal page against a real cockpit-bridge", () => {
    it("finds the user's login shell and home directory", async () => {
        await connect();
        const user = await cockpit.user();
        const me = userInfo();
        expect(user.shell).toBe(me.shell);
        expect(user.home).toBe(me.homedir);
    });

    it("runs the shell on a pty of the requested size, which follows a resize", async () => {
        const s = await connect();
        await shell(s, 100, 30);
        expect(await command(s, "stty size", /^30 100$/m)).toBeTruthy();
        expect(await command(s, "tty", /^\/dev\/pts\/\d+$/m)).toMatch(/^\/dev\/pts\/\d+$/);

        s.resize({ rows: 25, cols: 90 });
        await waitFor("the resize", () => s.getSnapshot().window?.cols === 90);
        expect(s.getSnapshot().window).toEqual({ rows: 25, cols: 90 });
        expect(await command(s, "stty size", /^25 90$/m)).toBeTruthy();
    });

    it("tells the shell it is an xterm, and starts in the home directory", async () => {
        const s = await connect();
        await shell(s);
        // The patterns cannot match the echo of the command line itself.
        expect(await command(s, "echo \"term=${TERM}=end\"", /term=[\w.+-]+=end/)).toBe("term=xterm-256color=end");
        expect(await command(s, "echo \"pwd=$PWD\"", /pwd=\/[^\s"]*/)).toBe(`pwd=${userInfo().homedir}`);
    });

    it("draws what the shell prints in its colours", async () => {
        const s = await connect();
        await shell(s);
        await command(s, "printf '\\033[31mcol%s\\033[0m\\n' ored", /^colored$/m);
        const runs = screenRows(s.emulator!, { cursor: false, ascii: false }).flat();
        expect(runs.find(run => run.text.startsWith("colored"))).toMatchObject({ fg: "red" });
    });

    it("answers a program that asks the terminal where the cursor is", async () => {
        const s = await connect();
        await shell(s);
        // CSI 6n: the emulator's answer (ESC [ row ; col R) goes back down the pty, where read gets it.
        const answer = await command(s, "printf '\\033[6n'; read -s -d R -t 5 pos; echo \"cursor=${pos#*[}=end\"", /cursor=\d+;\d+=end/);
        expect(answer).toMatch(/^cursor=\d+;1=end$/);
    });

    it("reports the shell's exit status", async () => {
        const s = await connect();
        await shell(s);
        s.send(Buffer.from("exit 3\r"));
        await waitFor("the shell to exit", () => s.getSnapshot().phase === "ended");
        expect(s.getSnapshot().ending).toEqual({ kind: "exited", status: 3 });
        // Its last output stays on the screen.
        expect(screenText(s)).toContain("hist-42");
    });

    it("answers the busy probe at the prompt", async () => {
        const s = await connect();
        await shell(s);
        expect(typeof await s.busy()).toBe("boolean");
    });

    it("really ends the shell when it is killed", async () => {
        const s = await connect();
        s.start({ rows: 30, cols: 100 });
        // Nothing is typed into this one, so it has no history to write.
        await waitFor("the shell to start", () => s.getSnapshot().phase === "running");
        const pid = s.getSnapshot().pid!;
        expect(pid).toBeGreaterThan(0);
        expect(existsSync(`/proc/${pid}`)).toBe(true);
        s.kill();
        expect(s.getSnapshot().ending).toEqual({ kind: "killed" });
        await waitFor(`pid ${pid} to go`, () => !existsSync(`/proc/${pid}`), 5000);
    });
});
