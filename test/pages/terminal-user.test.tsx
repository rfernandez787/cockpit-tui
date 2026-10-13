/*
 * The Terminal page with a hostile user record: the login shell and home
 * directory are host text, shown on the page and in the kill question.
 *
 * A file of its own, because cockpit.user() caches the first record it reads
 * for the life of the module: in a file with other tests, this one would see
 * theirs. Vitest gives every file a fresh module registry.
 */
import { afterEach, describe, expect, it } from "vitest";
import TerminalPage from "../../src/pages/terminal/index.js";
import { terminal } from "../../src/pages/terminal/store.js";
import { initInfo } from "../../src/session.js";
import { renderPage } from "../helpers/page.js";
import { cleanup, keys } from "../helpers/ink.js";
import { startMock, type MockBridge } from "../mock-bridge/harness.js";

const SHELL = "/bin/\x1b]0;PWN\x07sh‮";
const HOME = "/home/\x1b[2Jm\u009bx⁦";

let mock: MockBridge | null = null;

afterEach(() => {
    terminal.shutdown();
    cleanup();
    mock?.close();
    mock = null;
});

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

function noHostControls(raw: string): void {
    expect(raw).not.toContain("\x1b]0;PWN");
    expect(raw).not.toContain("\x1b[2Jm");
    expect(raw).not.toContain("\u009b");
    expect(raw).not.toMatch(/[‪-‮⁦-⁩]/);
}

describe("Terminal page, with control characters in the user's record", () => {
    it("shows the shell and home directory with them made visible, in the view and in the kill question", async () => {
        mock = await startMock({
            dbus: {
                internal: {
                    "/user": {
                        "cockpit.User": {
                            properties: {
                                Id: { t: "i", v: 1000 },
                                Gid: { t: "i", v: 1000 },
                                Name: { t: "s", v: "mock" },
                                Full: { t: "s", v: "Mock User" },
                                Groups: { t: "as", v: ["mock"] },
                                Home: { t: "s", v: HOME },
                                Shell: { t: "s", v: SHELL },
                            },
                        },
                    },
                },
            },
            files: { [`${HOME}/`]: {} }, // the shell starts there
            spawn: { [SHELL]: { stdout: "$ ", exitOn: "exit\r" } },
            spawnPatterns: [{ match: "^/bin/sh -c grep -qr", "exit-status": 1 }],
        });
        await initInfo();
        const r = renderPage(TerminalPage, {
            columns: 100, rows: 30, hostname: "box",
            session: { mode: "local", target: "localhost", transport: mock.transport },
        });
        await r.waitFor(/Shell\s+\/bin\/\^\[\]0;PWN\^Gsh/);
        expect(r.lastFrame()).toMatch(/Directory\s+\/home\/\^\[\[2Jm\\x9bx/);
        expect(r.lastFrame()).toMatch(/Enter\s+start \/bin\/\^\[\]0;PWN\^Gsh/);
        noHostControls(r.lastRawFrame());

        // The kill question names the shell too.
        await r.press(keys.enter);
        await waitFor("the shell", () => terminal.getSnapshot().phase === "running");
        await r.waitFor("Ctrl+] back to the page");
        await r.press("\x1d");
        await r.waitFor("Enter to type here");
        await r.press("k");
        await r.waitFor("Killing it ends the session");
        expect(r.lastFrame()).toContain("/bin/^[]0;PWN^Gsh");
        noHostControls(r.lastRawFrame());
        await r.press(keys.escape);
    });
});
