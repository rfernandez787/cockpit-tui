/*
 * End to end: the built program, in a real pseudo-terminal, against the mock
 * bridge.
 *
 * Everything else renders Ink into fake streams. Only here do raw mode, the
 * alternate screen, real escape-sequence input, terminal resizes and process
 * exit happen the way a user meets them. tmux provides the terminal: a
 * private server (-L, -f /dev/null) so the user's own tmux and its config are
 * never touched, with the window sized explicitly, because tmux 3.2 ignores
 * new-session -x/-y for detached sessions.
 *
 * Skips without tmux. The non-terminal checks (exit codes, probe) always run.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockWs } from "./mock-ws/server.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MOCK = join(ROOT, "test/mock-bridge/bridge.mjs");
const haveTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const SOCKET = `cockpit-tui-e2e-${process.pid}`;

let dir = "";
let cli = "";
let socketPath = "";

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cockpit-tui-e2e-"));
    cli = join(dir, "cli.js");
    execFileSync(process.execPath, [join(ROOT, "build.js"), "--outfile", cli], { stdio: "ignore" });
    // tmux exits when its last session ends, and a new-session that reaches
    // a server on its way out fails ("server exited unexpectedly"). A session
    // that outlives every test keeps the one server up until afterAll.
    if (haveTmux) {
        execFileSync("tmux", ["-L", SOCKET, "-f", "/dev/null", "new-session", "-d", "-s", "keepalive", "sleep 86400"]);
        socketPath = tmux("display-message", "-p", "#{socket_path}").trim();
    }
}, 60_000);

afterAll(() => {
    if (haveTmux)
        spawnSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
    // tmux 3.2 leaves its socket file behind.
    if (socketPath)
        rmSync(socketPath, { force: true });
    if (dir)
        rmSync(dir, { recursive: true, force: true });
});

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function tmux(...args: string[]): string {
    return execFileSync("tmux", ["-L", SOCKET, "-f", "/dev/null", ...args], { encoding: "utf8" });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let counter = 0;
const terms: Term[] = [];

class Term {
    private constructor(readonly name: string) {}

    /** Run cockpit-tui against the mock bridge in a fresh window of the given size. */
    static start(args: string[], scenario: object, columns = 100, rows = 30): Term {
        return Term.run(["--bridge", MOCK, ...args], { COCKPIT_MOCK_SCENARIO: JSON.stringify(scenario) }, columns, rows);
    }

    /** Run cockpit-tui with exactly these arguments and extra environment. */
    static run(args: string[], env: Record<string, string>, columns = 100, rows = 30): Term {
        const name = `t${++counter}`;
        const script = join(dir, `${name}.sh`);
        const vars = Object.entries({ LANG: "C.UTF-8", ...env }).map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ");
        writeFileSync(script, [
            "#!/bin/sh",
            "sleep 0.3", // let resize-window land before the program reads the size
            `${vars} ${shellQuote(process.execPath)} ${shellQuote(cli)} ` + args.map(shellQuote).join(" "),
            'echo "EXIT=$?"',
            "sleep 120",
        ].join("\n"));
        tmux("new-session", "-d", "-s", name, `sh ${shellQuote(script)}`,
             ";", "set", "-t", name, "status", "off",
             ";", "resize-window", "-t", name, "-x", String(columns), "-y", String(rows));
        const term = new Term(name);
        terms.push(term);
        return term;
    }

    screen(): string {
        return tmux("capture-pane", "-p", "-t", this.name);
    }

    async waitFor(match: string | RegExp | ((screen: string) => boolean), timeoutMs = 8000): Promise<string> {
        const test = typeof match === "function" ? match
            : typeof match === "string" ? (s: string) => s.includes(match) : (s: string) => match.test(s);
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const screen = this.screen();
            if (test(screen))
                return screen;
            if (Date.now() > deadline)
                throw new Error(`timed out waiting for ${String(match)}; screen:\n${screen}`);
            await sleep(50);
        }
    }

    /** Literal text, exactly as typed. */
    async type(text: string): Promise<void> {
        tmux("send-keys", "-t", this.name, "-l", text);
        await sleep(80);
    }

    /** Text and then Enter, in one write, as a fast typist or a paste delivers them. */
    async typeAndEnter(text: string): Promise<void> {
        tmux("send-keys", "-t", this.name, "-l", text, ";", "send-keys", "-t", this.name, "Enter");
        await sleep(80);
    }

    /** tmux key names: Enter, Escape, Tab, BTab, Up, Down, C-c, ... */
    async key(...names: string[]): Promise<void> {
        for (const name of names) {
            tmux("send-keys", "-t", this.name, name);
            await sleep(name === "Escape" ? 150 : 80);
        }
    }

    resize(columns: number, rows: number): void {
        tmux("resize-window", "-t", this.name, "-x", String(columns), "-y", String(rows));
    }

    kill(): void {
        spawnSync("tmux", ["-L", SOCKET, "kill-session", "-t", this.name], { stdio: "ignore" });
    }
}

afterEach(() => {
    while (terms.length)
        terms.pop()!.kill();
});

const scenario = {
    files: { "/proc/sys/kernel/hostname": "e2e-host\n" },
    superuserFlow: { bridges: ["sudo"], password: "s3cr3t", prompts: [{ prompt: "[sudo] password for mock: " }] },
};

describe.skipIf(!haveTmux)("in a real terminal", () => {
    it("draws the shell at the window's size and quits cleanly with q", async () => {
        const term = Term.start([], scenario, 100, 30);
        // The host's own name arrives a moment after the first frame.
        const screen = await term.waitFor(s => s.split("\n")[0]!.includes("e2e-host"));
        const lines = screen.split("\n");
        expect(lines[0]).toContain("mock · Limited access");
        expect(screen).toContain("1 Overview");
        expect(screen).toMatch(/1-9 pages/);
        await term.type("q");
        const after = await term.waitFor("EXIT=0");
        // Back on the primary screen: none of the TUI is left behind.
        expect(after).not.toContain("Limited access");
    });

    it("switches pages from the keyboard", async () => {
        const term = Term.start([], scenario);
        await term.waitFor("Limited access");
        await term.type("7");
        await term.waitFor(/›7 Services|>7 Services/);
        await term.key("Tab");
        await term.waitFor(/›8 Terminal|>8 Terminal/);
        await term.key("BTab", "BTab");
        await term.waitFor(/›6 Accounts|>6 Accounts/);
    });

    it("opens on the page named by --page", async () => {
        const term = Term.start(["--page", "logs"], scenario);
        await term.waitFor(/›2 Logs|>2 Logs/);
    });

    it("takes a password without echoing it and gains administrative access", async () => {
        const term = Term.start([], scenario);
        await term.waitFor("Limited access");
        await term.type("A");
        await term.waitFor("Password for mock:");
        await term.type("s3cr3t");
        const typing = term.screen();
        expect(typing).not.toContain("s3cr3t");
        await term.key("Enter");
        await term.waitFor("Administrative access is on");
        expect(term.screen().split("\n")[0]).toContain("Administrative access");
    });

    it("takes a password and Enter that arrive in the same read", async () => {
        const term = Term.start([], scenario);
        await term.waitFor("Limited access");
        await term.type("A");
        await term.waitFor("Password for mock:");
        await term.typeAndEnter("s3cr3t");
        await term.waitFor("Administrative access is on");
    });

    it("acts on shortcuts typed faster than they are read", async () => {
        const term = Term.start([], scenario);
        await term.waitFor("Limited access");
        await term.type("7?");
        await term.waitFor("next / previous page");
        expect(term.screen()).toMatch(/›7 Services|>7 Services/);
    });

    it("quits with Ctrl+C", async () => {
        const term = Term.start([], scenario);
        await term.waitFor("Limited access");
        await term.key("C-c");
        await term.waitFor("EXIT=0");
    });

    it("re-lays out when the terminal is resized", async () => {
        const term = Term.start([], scenario, 100, 30);
        await term.waitFor("1 Overview");
        term.resize(64, 20);
        // Below 72 columns the page menu folds away and the header names the page.
        const narrow = await term.waitFor(screen => !screen.includes("2 Logs") && screen.split("\n")[0]!.includes("Overview"));
        for (const line of narrow.split("\n"))
            expect(line.length).toBeLessThanOrEqual(64);
        term.resize(30, 8);
        await term.waitFor("needs at least");
        term.resize(100, 30);
        await term.waitFor("2 Logs");
    });
});

describe.skipIf(!haveTmux)("over cockpit-ws", () => {
    it("asks for the password in line mode, then hands the terminal to the TUI", async () => {
        const server = await startMockWs({
            bridge: { argv: [process.execPath, MOCK], env: { COCKPIT_MOCK_SCENARIO: JSON.stringify(scenario) } },
        });
        try {
            const term = Term.run(["--ws", server.url, "--user", "admin"], {});
            await term.waitFor("password for admin:");
            await term.typeAndEnter("hunter2");
            // Header: the host, the transport, the user and access level.
            const screen = await term.waitFor(s => s.split("\n")[0]!.includes("e2e-host (ws)"));
            expect(screen.split("\n")[0]).toContain("mock · Limited access");
            expect(screen).not.toContain("hunter2");
            // The keyboard belongs to Ink now, not to the line-mode prompt.
            await term.type("2");
            await term.waitFor(/›2 Logs|>2 Logs/);
            await term.type("q");
            await term.waitFor("EXIT=0");
        } finally {
            await server.close();
        }
    });

    it("rejects a wrong password without starting the TUI", async () => {
        const server = await startMockWs();
        try {
            const term = Term.run(["--ws", server.url, "--user", "admin"], {});
            await term.waitFor("password for admin:");
            await term.typeAndEnter("wrong");
            const screen = await term.waitFor("EXIT=1");
            expect(screen).toMatch(/could not connect: authentication failed/);
        } finally {
            await server.close();
        }
    });
});

describe("without a terminal", () => {
    const run = (args: string[], input = "") => spawnSync(process.execPath, [cli, ...args], {
        input, encoding: "utf8", env: { ...process.env, COCKPIT_MOCK_SCENARIO: JSON.stringify(scenario) },
    });

    it("refuses to start the TUI, pointing at the probe", () => {
        const result = run(["--bridge", MOCK]);
        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(/needs an interactive terminal/);
        expect(result.stderr).toMatch(/cockpit-tui probe/);
    });

    it("prints help and version, and rejects bad options with status 2", () => {
        const help = run(["--help"]);
        expect(help.status).toBe(0);
        expect(help.stdout).toMatch(/cockpit-tui probe/);
        expect(run(["--version"]).stdout).toMatch(/^cockpit-tui \d+\.\d+\.\d+/);
        const bad = run(["--hots", "x"]);
        expect(bad.status).toBe(2);
        expect(bad.stderr).toMatch(/Unknown option '--hots'/);
        expect(run(["--page", "nowhere", "--bridge", MOCK]).status).toBe(2);
    });

    it("fails promptly, not hanging, when a prompt meets the end of its input", () => {
        const started = Date.now();
        const result = run(["probe", "--ws", "http://127.0.0.1:9"], "");
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/no more input available/);
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    it("still runs the probe", () => {
        const result = run(["probe", "--bridge", MOCK]);
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/connecting \(local\) \.\.\. ok/);
        expect(result.stdout).toMatch(/foundation looks healthy/);
    });
});
