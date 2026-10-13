/*
 * The Terminal page against the mock bridge's pty mode: the exact channel
 * it opens, the shell's output drawn inside the page, every key going to the
 * shell while it has the keyboard (and none of them to the TUI), Ctrl+] to
 * get out, scrolling back, resizes, the end of a shell, kill and restart.
 */
import { afterEach, describe, expect, it } from "vitest";
import TerminalPage, { KILL_ARM_MS } from "../../src/pages/terminal/index.js";
import { terminal } from "../../src/pages/terminal/store.js";
import { keyboardCaptured, quitGuards } from "../../src/tui/page.js";
import { initInfo, type Session } from "../../src/session.js";
import { renderPage, type RenderedPage } from "../helpers/page.js";
import { cleanup, keys } from "../helpers/ink.js";
import { startMock, type JsonObject, type MockBridge, type MockScenario, type SpawnResult } from "../mock-bridge/harness.js";

const CTRL_RIGHT_BRACKET = "\x1d";
const BUSY_PROBE = "^/bin/sh -c grep -qr";

function userRecord(shell: string, home: string) {
    return {
        "/user": {
            "cockpit.User": {
                properties: {
                    Id: { t: "i", v: 1000 },
                    Gid: { t: "i", v: 1000 },
                    Name: { t: "s", v: "mock" },
                    Full: { t: "s", v: "Mock User" },
                    Groups: { t: "as", v: ["mock", "wheel"] },
                    Home: { t: "s", v: home },
                    Shell: { t: "s", v: shell },
                },
            },
        },
    };
}

const USER = userRecord("/bin/bash", "/home/mock");

function scenario(shell: SpawnResult = { stdout: "$ ", exitOn: "exit\r" }, extra: MockScenario = {}): MockScenario {
    return { dbus: { internal: USER }, spawn: { "/bin/bash": shell }, ...extra };
}

let mock: MockBridge | null = null;

afterEach(() => {
    terminal.shutdown();
    cleanup();
    mock?.close();
    mock = null;
});

/** The mock bridge, with cockpit.info filled in as openSession() does. */
async function begin(shell?: SpawnResult, extra?: MockScenario): Promise<MockBridge> {
    mock = await startMock(scenario(shell, extra));
    await initInfo();
    return mock;
}

function sessionOf(bridge: MockBridge): Session {
    return { mode: "local", target: "localhost", transport: bridge.transport };
}

async function waitFor<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 3000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = check();
        if (value)
            return value;
        if (Date.now() > deadline)
            throw new Error(`timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function shellOpens(bridge: MockBridge): JsonObject[] {
    return bridge.opened("stream").filter(open => (open.spawn as string[] | undefined)?.[0] === "/bin/bash");
}

async function render(bridge: MockBridge, options: { columns?: number, rows?: number, panels?: boolean, showHints?: boolean } = {}): Promise<RenderedPage> {
    const r = renderPage(TerminalPage, {
        columns: options.columns ?? 100, rows: options.rows ?? 30, session: sessionOf(bridge), hostname: "box",
        ...(options.panels ? { panels: true } : {}), ...(options.showHints ? { showHints: true } : {}),
    });
    await r.waitFor("/bin/bash"); // the user lookup is done
    return r;
}

/** Enter: start the shell with the keyboard in it; resolves with its channel once its prompt is drawn. */
async function startShell(r: RenderedPage, bridge: MockBridge, count = 1): Promise<string> {
    await r.press(keys.enter);
    const open = await waitFor("the shell channel", () => shellOpens(bridge)[count - 1]);
    await waitFor("the shell", () => terminal.getSnapshot().phase === "running");
    await r.waitFor(/^│?\$/m); // the frame's lines come without their trailing blanks
    return open.channel as string;
}

/** Ctrl+]: the keyboard comes back to the page. */
async function leave(r: RenderedPage): Promise<void> {
    await r.press(CTRL_RIGHT_BRACKET);
    await r.waitFor("Enter to type here");
}

describe("Terminal page", () => {
    it("starts nothing by being shown", async () => {
        mock = await begin();
        const r = await render(mock);
        const idle = r.lastFrame();
        expect(idle).toMatch(/State\s+Not started/);
        expect(idle).toMatch(/Shell\s+\/bin\/bash/);
        expect(idle).toMatch(/Directory\s+\/home\/mock/);
        expect(idle).toMatch(/Enter\s+start \/bin\/bash here/);
        expect(idle).toMatch(/Ctrl\+]\s+come back to the page from the shell/);
        expect(shellOpens(mock)).toEqual([]);
        expect(quitGuards()).toEqual([]);
        expect(keyboardCaptured()).toBe(false);
    });

    it("starts the login shell on Enter, in a pty the size of its window, and draws its output in the page", async () => {
        mock = await begin();
        const r = await render(mock);
        const id = await startShell(r, mock);
        expect(shellOpens(mock)[0]).toMatchObject({
            payload: "stream",
            spawn: ["/bin/bash"],
            // The emulator is xterm, whatever the user's own terminal is.
            environ: ["TERM=xterm-256color"],
            directory: "/home/mock",
            pty: true,
            binary: "raw",
            // Plain lines: the page's 29 rows less its status line.
            window: { rows: 28, cols: 100 },
        });
        expect(shellOpens(mock)[0]!.superuser).toBeUndefined();

        const lines = r.lastFrame().split("\n");
        expect(lines[0]).toContain("mock@box");
        expect(lines[0]).toContain("Ctrl+] back to the page");
        expect(lines[1]).toMatch(/^\$/);

        await r.press("echo hi", keys.enter);
        // The pty echoes what was typed; it is drawn on the prompt's line.
        await r.waitFor("$ echo hi");
        expect(mock.sent(id)).toBe("echo hi\r");
        expect(quitGuards()).toHaveLength(1);
    });

    it("fits the pty to the panel when the page draws panels", async () => {
        mock = await begin();
        const r = await render(mock, { panels: true });
        await startShell(r, mock);
        // 100x29 of page, less the panel's border and shadow.
        expect(shellOpens(mock)[0]!.window).toEqual({ rows: 26, cols: 97 });
        const lines = r.lastFrame().split("\n");
        expect(lines[0]).toMatch(/^┌─┤ mock@box ├─+ Ctrl\+] back to the page ─┐/);
        expect(lines[1]).toMatch(/^│\$ /);
    });

    it("gives the shell every key while it has the keyboard, the TUI's own included", async () => {
        mock = await begin();
        const r = await render(mock, { showHints: true });
        const id = await startShell(r, mock);
        expect(keyboardCaptured()).toBe(true);
        expect(r.lastFrame()).toMatch(/hints: ctrl\+] back to the page$/m);

        // Digits and Tab switch pages, q quits, ? is help, A is admin, k kills, Ctrl+C quits: not here.
        await r.press("1", "q", "?", "A", "k", keys.tab, keys.ctrl("c"), keys.escape, keys.up, keys.backspace);
        await waitFor("the keys at the shell", () => mock!.sent(id).endsWith("\x7f"));
        expect(mock.sent(id)).toBe("1q?Ak\t\x03\x1b\x1b[A\x7f");
        expect(r.navigations).toEqual([]);
        expect(r.lastFrame()).not.toContain("Kill the shell?");
        expect(terminal.getSnapshot().phase).toBe("running");
    });

    it("comes back to the page on Ctrl+], which the shell never sees", async () => {
        mock = await begin();
        const r = await render(mock, { showHints: true });
        const id = await startShell(r, mock);
        await r.press("a");
        await leave(r);
        expect(keyboardCaptured()).toBe(false);
        expect(r.lastFrame()).toMatch(/hints: enter type in the shell \| k kill \| PgUp PgDn scroll \| ] send \^]$/m);
        // Keys are the page's again: this one is not typed into the shell.
        await r.press("x");
        terminal.send(Buffer.from("|"));
        await waitFor("the next frame at the bridge", () => mock!.sent(id).endsWith("|"));
        expect(mock.sent(id)).toBe("a|");
        // And Enter goes back in.
        await r.press(keys.enter);
        await r.waitFor("Ctrl+] back to the page");
        await r.press("b");
        await waitFor("the key at the shell", () => mock!.sent(id).endsWith("b"));
        expect(keyboardCaptured()).toBe(true);
    });

    it("sends a literal Ctrl+] with ] from the page, and goes into the shell", async () => {
        mock = await begin();
        const r = await render(mock);
        const id = await startShell(r, mock);
        await leave(r);
        await r.press("]");
        await waitFor("the byte at the shell", () => mock!.sent(id) === CTRL_RIGHT_BRACKET);
        await r.waitFor("Ctrl+] back to the page");
    });

    it("draws colours and cursor movement as the program meant them, and none of its escape sequences", async () => {
        mock = await begin({ stdout: "plain \x1b[31mred\x1b[0m\r\n\x1b[5;10Hthere\x1b]52;c;QUJD\x07\x1b[1;1H$ ", exitOn: "exit\r" });
        const r = await render(mock);
        await r.press(keys.enter);
        await r.waitFor("there");
        const lines = r.lastFrame().split("\n");
        expect(lines[1]!.trimEnd()).toBe("$ ain red");
        expect(lines[5]).toMatch(/^ {9}there/);
        const raw = r.lastRawFrame();
        expect(raw).not.toContain("\x1b]52");
        expect(raw).not.toContain("\x1b[5;10H");
        expect(raw).not.toContain("\x07");
    });

    it("shows the title the shell's programs set, made safe", async () => {
        // An OSC title can carry C0 and C1 controls: only BEL or ST end it.
        mock = await begin({ stdout: "\x1b]0;T1‮X\x1b\\$ ", exitOn: "exit\r" });
        const r = await render(mock);
        await r.press(keys.enter);
        await r.waitFor("T1 X");
        expect(r.lastFrame().split("\n")[0]).toMatch(/^T1 X\s+Ctrl\+] back to the page/);
        expect(r.lastRawFrame()).not.toContain("‮");
    });

    it("scrolls back through output that has left the screen, and returns when something is typed", async () => {
        const lines = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join("\r\n");
        mock = await begin({ stdout: `${lines}\r\n$ `, exitOn: "exit\r" });
        const r = await render(mock, { rows: 12 });
        const id = await startShell(r, mock);
        await r.waitFor("line-60");
        expect(r.lastFrame()).not.toContain("line-40");
        await leave(r);
        await r.press(keys.pageUp, keys.pageUp);
        const back = await r.waitFor("lines up");
        expect(back).toContain("18 lines up");
        expect(back).toContain("line-40");
        expect(back).not.toContain("line-60");
        await r.press(keys.end);
        await r.waitFor("line-60");
        await r.press(keys.home);
        await r.waitFor(frame => frame.split("\n")[1] === "line-1");
        // Going back in and typing shows where the shell is.
        await r.press(keys.enter, "x");
        await waitFor("the key at the shell", () => mock!.sent(id) === "x");
        await r.waitFor("line-60");
    });

    it("tells the pty when its window changes size, once per burst and never with a size that would wedge the bridge", async () => {
        mock = await begin();
        const r = await render(mock);
        const id = await startShell(r, mock);
        const resizes = () => mock!.received()
                .filter(entry => entry.control?.command === "options" && entry.control.channel === id)
                .map(entry => entry.control!.window);

        // What the page does when its area changes (the harness cannot change it): a burst of sizes.
        terminal.resize({ rows: 20, cols: 70 });
        terminal.resize({ rows: 18, cols: 64 });
        terminal.resize({ rows: 16, cols: 60 });
        await waitFor("the resize at the bridge", () => resizes().length > 0);
        await sleep(100);
        expect(resizes()).toEqual([{ rows: 16, cols: 60 }]);
        expect(terminal.getSnapshot().window).toEqual({ rows: 16, cols: 60 });
        expect(terminal.emulator).toMatchObject({ rows: 16, cols: 60 });

        // Sizes the bridge cannot take are clamped or refused before they reach it (G1).
        terminal.resize({ rows: 0, cols: 70000 });
        terminal.resize({ rows: Number.NaN, cols: 80 });
        await waitFor("the clamped resize", () => resizes().length > 1);
        await sleep(100);
        expect(resizes()).toEqual([{ rows: 16, cols: 60 }, { rows: 1, cols: 65535 }]);
        // The same size again says nothing.
        terminal.resize({ rows: 1, cols: 65535 });
        await sleep(100);
        expect(resizes()).toHaveLength(2);
        r.unmount();
    });

    it("keeps the shell running, and reading its output, when the page goes away and comes back", async () => {
        mock = await begin({ stdout: "$ ", exitOn: "exit\r", replies: [{ line: "^date$", stdout: "Sat Oct  3\r\n$ " }] });
        const r = await render(mock);
        const id = await startShell(r, mock);
        r.unmount();
        expect(keyboardCaptured()).toBe(false);
        expect(terminal.getSnapshot().phase).toBe("running");
        // Output while nobody looks is still parsed into the screen.
        terminal.send(Buffer.from("date\r"));
        await waitFor("the command at the bridge", () => mock!.sent(id) === "date\r");
        await sleep(100);

        const again = renderPage(TerminalPage, { columns: 100, rows: 30, session: sessionOf(mock), hostname: "box" });
        await again.waitFor("Sat Oct  3");
        // Back on the page, not in the shell: the page's keys work.
        expect(again.lastFrame()).toContain("Enter to type here");
        expect(shellOpens(mock)).toHaveLength(1);
    });

    it("kills the shell after asking, saying whether a program is running in it", async () => {
        mock = await begin(undefined, { spawnPatterns: [{ match: BUSY_PROBE, "exit-status": 0 }] });
        const r = await render(mock);
        const id = await startShell(r, mock);
        await leave(r);
        const pid = terminal.getSnapshot().pid!;

        await r.press("k");
        await r.waitFor("Kill the shell?");
        await r.waitFor(`A program is still running in /bin/bash (pid ${pid})`);
        const probe = mock.opened("stream").find(open => (open.spawn as string[])[0] === "/bin/sh")!;
        expect(probe.spawn).toEqual(["/bin/sh", "-c", `grep -qr '^PPid:[[:space:]]*${pid}$' /proc/*/status`, "--"]);

        // An Enter on the heels of k is not the answer.
        await r.press(keys.enter);
        expect(terminal.getSnapshot().phase).toBe("running");
        await sleep(KILL_ARM_MS);
        await r.press(keys.enter);
        await r.waitFor(`status: success: Closed the shell (pid ${pid})`);
        await mock.waitForReceived(entry => entry.control?.command === "close" && entry.control.channel === id);
        expect(quitGuards()).toEqual([]);
        await r.waitFor("Closed from cockpit-tui");

        // Only r starts another: the Enter that confirmed the kill may come twice.
        await r.press(keys.enter, keys.enter);
        await sleep(100);
        expect(shellOpens(mock)).toHaveLength(1);
        expect(terminal.getSnapshot().phase).toBe("ended");
        await r.press("r");
        await waitFor("a second shell", () => shellOpens(mock!)[1]);
    });

    it("marks a pasted line break as a paste for programs that ask, and sends fast typing as typed", async () => {
        // bash's readline turns bracketed paste on at its prompt.
        mock = await begin({ stdout: "\x1b[?2004h$ ", exitOn: "exit\r" });
        const r = await render(mock);
        const id = await startShell(r, mock);
        await r.press("ls");
        await waitFor("the typed run", () => mock!.sent(id) === "ls");
        await r.press(keys.paste("echo a\necho b"));
        await waitFor("the paste", () => mock!.sent(id).endsWith("\x1b[201~"));
        expect(mock.sent(id)).toBe("ls\x1b[200~echo a\recho b\x1b[201~");
    });

    it("says when the shell is idle before killing it", async () => {
        mock = await begin(undefined, { spawnPatterns: [{ match: BUSY_PROBE, "exit-status": 1 }] });
        const r = await render(mock);
        await startShell(r, mock);
        await leave(r);
        await r.press("k");
        await r.waitFor("is waiting at its prompt");
        await r.press(keys.escape);
        await r.waitFor(frame => !frame.includes("Kill the shell?"));
        expect(terminal.getSnapshot().phase).toBe("running");
    });

    it("says how a shell ended, gives the keyboard back, keeps its last output, and starts a new one with r", async () => {
        mock = await begin({ stdout: "$ ", exitOn: "exit\r", "exit-status": 3 });
        const r = await render(mock, { showHints: true });
        await startShell(r, mock);
        await r.press("exit", keys.enter);
        await r.waitFor("Exited with status 3");
        expect(keyboardCaptured()).toBe(false);
        expect(quitGuards()).toEqual([]);
        expect(r.lastFrame()).toContain("$ exit");
        expect(r.lastFrame()).toMatch(/hints: enter r new shell \| PgUp PgDn scroll$/m);

        await r.press("r");
        await waitFor("a second shell", () => shellOpens(mock!)[1]);
        await r.waitFor("Ctrl+] back to the page");
        // A new screen: the old shell's output is gone with it.
        expect(r.lastFrame()).not.toContain("$ exit");
    });

    it("reports a shell that cannot be started", async () => {
        mock = await begin({ problem: "not-found" });
        const r = await render(mock);
        await r.press(keys.enter);
        await r.waitFor("Could not start: not found: /bin/bash or /home/mock does not exist");
        expect(quitGuards()).toEqual([]);
        expect(keyboardCaptured()).toBe(false);
    });

    it("shows a failure's message with its control characters made visible", async () => {
        mock = await begin({ problem: "internal-error", message: "\x1b]52;c;QQ==\x07\u009b2J" });
        const r = await render(mock);
        await r.press(keys.enter);
        await r.waitFor("Could not start");
        const raw = r.lastRawFrame();
        expect(raw).not.toContain("\x1b]52");
        expect(raw).not.toContain("\x07");
        expect(raw).not.toContain("\u009b");
        expect(r.lastFrame()).toContain("Could not start: ^[]52;c;QQ==^G\\x9b2J");
    });

    it("says when the connection is gone, and offers nothing but quitting", async () => {
        mock = await begin();
        const r = await render(mock, { showHints: true });
        mock.close();
        await r.waitFor("The connection is gone");
        expect(r.lastFrame()).toMatch(/q\s+quit/);
        expect(r.lastFrame()).toMatch(/hints: *$/m);
        await r.press(keys.enter);
        expect(shellOpens(mock)).toEqual([]);
    });

    for (const [columns, rows] of [[50, 12], [60, 16], [80, 24]] as const) {
        it(`keeps the shell's screen inside ${columns}x${rows}`, async () => {
            mock = await begin({ stdout: `${"x".repeat(200)}\r\n$ `, exitOn: "exit\r" });
            const r = await render(mock, { columns, rows });
            await startShell(r, mock);
            const lines = r.lastFrame().split("\n");
            expect(lines.length).toBeLessThanOrEqual(rows);
            for (const line of lines)
                expect(line.length).toBeLessThanOrEqual(columns);
            // The long line wrapped at the pty's width, which is the page's.
            expect(shellOpens(mock)[0]!.window).toEqual({ rows: rows - 2, cols: columns });
            expect(lines[1]).toBe("x".repeat(columns));
        });
    }
});
