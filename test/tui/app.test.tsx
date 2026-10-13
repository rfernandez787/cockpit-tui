/*
 * The shell, driven against the mock bridge: navigation, help, quitting,
 * administrative access, and losing the connection.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

// The shell is tested with stand-in pages: the real ones have their own tests
// and would open their own channels against the mock here.
vi.mock("../../src/tui/pages.js", async () => {
    const { Text } = await import("ink");
    const { useKeys } = await import("../../src/tui/keyboard.js");
    const stub = (title: string) => function StubPage() {
        // The Logs stand-in has far more hints than fit on one line, and
        // one more that only the help screen lists.
        const hints = Array.from({ length: 12 }, (_, i) => [`k${i}`, `long action number ${i}`] as const);
        useKeys(() => false, {
            active: title === "Logs",
            hints,
            help: [...hints, ["x", "a key only help lists"]],
        });
        return <Text>{title} is not implemented yet.</Text>;
    };
    const PAGES = [
        { id: "overview", title: "Overview", component: stub("Overview") },
        { id: "logs", title: "Logs", component: stub("Logs") },
        { id: "accounts", title: "Accounts", component: stub("Accounts") },
        { id: "services", title: "Services", component: stub("Services") },
        { id: "terminal", title: "Terminal", component: stub("Terminal") },
    ];
    return {
        PAGES,
        pageIndex: (id: string | undefined) => (id ? PAGES.findIndex(page => page.id === id) : 0),
    };
});
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Superuser } from "../../src/superuser.js";
import { DEFAULT_THEME, setTheme, themeName } from "../../src/tui/theme.js";
import { TuiRoot } from "../../src/tui/run.js";
import { setQuitGuard } from "../../src/tui/page.js";
import { glyphs } from "../../src/tui/theme.js";
import { renderInk, cleanup, keys, type Rendered } from "../helpers/ink.js";
import { mockSession, type MockSession } from "../helpers/session.js";

let session: MockSession | null = null;

afterEach(() => {
    cleanup();
    session?.close();
    session = null;
    setQuitGuard("test", null);
    setTheme(DEFAULT_THEME);
});

async function start(scenario: object = {}, options = {}): Promise<Rendered> {
    session = await mockSession(scenario);
    const superuser = await Superuser.open();
    const r = renderInk(<TuiRoot session={session} superuser={superuser} options={options} />, { columns: 100, rows: 24 });
    await r.waitFor("Limited access");
    return r;
}

describe("the shell", () => {
    it("shows the user, the access level, the page menu and the global keys", async () => {
        const r = await start();
        const frame = await r.waitFor("1-5 pages");
        const lines = frame.split("\n");
        expect(lines).toHaveLength(24);
        expect(lines[0]).toContain("mock · Limited access");
        expect(frame).toContain(`${glyphs.pointer}1 Overview`);
        expect(frame).toContain("5 Terminal");
        // The page menu is a panel of its own inside the window, its shadow on the last row.
        expect(lines[2]).toMatch(/^ .{3}. Pages .+/);
        expect(lines[3]!.slice(3, 17)).toBe(`${glyphs.pointer}1 Overview   `);
        expect(lines[19]!.slice(2, 18)).toMatch(/^[^ ]{16}$/);
        expect(lines[20]!.slice(2, 19)).toBe(" ".repeat(17));
        expect(lines[23]).toContain("1-5 pages");
        expect(lines[23]).toContain("q quit");
    });

    it("switches pages by number and with Tab / Shift+Tab", async () => {
        const r = await start();
        await r.press("4");
        await r.waitFor(`${glyphs.pointer}4 Services`);
        await r.press(keys.tab);
        await r.waitFor(`${glyphs.pointer}5 Terminal`);
        await r.press(keys.tab);
        await r.waitFor(`${glyphs.pointer}1 Overview`);
        await r.press(keys.shiftTab);
        await r.waitFor(`${glyphs.pointer}5 Terminal`);
        await r.press("9"); // no ninth page: ignored
        await r.waitFor(`${glyphs.pointer}5 Terminal`);
    });

    it("opens on the page given with --page", async () => {
        session = await mockSession();
        const superuser = await Superuser.open();
        const r = renderInk(<TuiRoot session={session} superuser={superuser} options={{ initialPage: 2 }} />, { columns: 100, rows: 24 });
        await r.waitFor(`${glyphs.pointer}3 Accounts`);
    });

    it("folds the menu away on a narrow terminal and names the page in the header", async () => {
        session = await mockSession();
        const superuser = await Superuser.open();
        const r = renderInk(<TuiRoot session={session} superuser={superuser} options={{}} />, { columns: 60, rows: 20 });
        const frame = await r.waitFor("Limited access");
        expect(frame).not.toContain("1 Overview");
        expect(frame.split("\n")[0]).toContain("Overview");
    });

    it("asks for a bigger terminal when it is too small", async () => {
        session = await mockSession();
        const r = renderInk(<TuiRoot session={session} superuser={null} options={{}} />, { columns: 40, rows: 10 });
        await r.waitFor(frame => frame.replace(/\s+/g, " ").includes("needs at least 50x12"));
    });

    it("shows help over the page and closes it with Esc", async () => {
        const r = await start();
        await r.press("?");
        await r.waitFor("next / previous page");
        expect(r.lastFrame().split("\n")[23]).toContain("esc close");
        await r.press(keys.escape);
        await r.waitFor(frame => !frame.includes("next / previous page"));
    });

    it("shows the diagnostic log from the help dialog", async () => {
        const { record } = await import("../../src/tui/log.js");
        record("warn", "a warning from the bridge \x1b[31mwith an escape\x1b[0m");
        const r = await start();
        await r.press("?");
        await r.waitFor("l log");
        await r.press("l");
        const frame = await r.waitFor("a warning from the bridge");
        expect(frame).not.toMatch(/\x1b\[31m/);
        expect(frame).toContain("^[[31m");
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("a warning from the bridge"));
    });

    it("picks a colour scheme from the help dialog: tried as the list is walked, kept and saved on Enter", async () => {
        const dir = mkdtempSync(join(tmpdir(), "cockpit-tui-app-"));
        const file = join(dir, "config.json");
        process.env.COCKPIT_TUI_CONFIG = file;
        try {
            const r = await start();
            await r.press("?");
            await r.waitFor("next / previous page");
            expect(r.lastFrame().split("\n")[23]).toContain("t colours");
            await r.press("t");
            const frame = await r.waitFor("Colour scheme");
            expect(frame).toMatch(/Dark\s+\S/);
            expect(frame).toContain("Light");
            expect(frame).toContain("Midnight");
            expect(frame).toContain("nmtui's own");
            expect(themeName()).toBe("dark");

            // Walking the list shows each scheme; Esc puts the old one back and saves nothing.
            await r.press(keys.down);
            expect(themeName()).toBe("light");
            await r.press(keys.escape);
            await r.waitFor(f => !f.includes("Colour scheme"));
            expect(themeName()).toBe("dark");
            expect(existsSync(file)).toBe(false);

            await r.press("?", "t");
            await r.waitFor("Colour scheme");
            await r.press(keys.end, keys.enter);
            await r.waitFor("Colour scheme: Newt");
            expect(themeName()).toBe("newt");
            expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ theme: "newt" });
            // The page is still there, and the shell's keys work.
            expect(r.lastFrame()).toContain("Overview is not implemented yet.");
            await r.press("2");
            await r.waitFor("Logs is not implemented yet.");
        } finally {
            process.env.COCKPIT_TUI_CONFIG = "";
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("keeps the chosen scheme for the run when it cannot be saved, and says so", async () => {
        const dir = mkdtempSync(join(tmpdir(), "cockpit-tui-app-"));
        writeFileSync(join(dir, "file"), "");
        process.env.COCKPIT_TUI_CONFIG = join(dir, "file", "below", "config.json");
        try {
            const r = await start();
            await r.press("?", "t");
            await r.waitFor("Colour scheme");
            await r.press(keys.down, keys.enter);
            await r.waitFor("Colour scheme: Light, for this run only");
            expect(themeName()).toBe("light");
        } finally {
            process.env.COCKPIT_TUI_CONFIG = "";
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("quits with q, exiting cleanly", async () => {
        const r = await start();
        const exited = r.instance.waitUntilExit();
        await r.press("q");
        await expect(exited).resolves.toEqual({ code: 0 });
    });

    it("quits with Ctrl+C even from inside a dialog", async () => {
        const r = await start();
        await r.press("?");
        await r.waitFor("next / previous page");
        const exited = r.instance.waitUntilExit();
        await r.press(keys.ctrl("c"));
        await expect(exited).resolves.toEqual({ code: 0 });
    });

    it("asks before quitting while a quit guard is set", async () => {
        const r = await start();
        setQuitGuard("test", "A shell session is still running.");
        await r.press("q");
        await r.waitFor("A shell session is still running.");
        await r.press(keys.escape);
        await r.waitFor(frame => !frame.includes("A shell session is still running."));
        const exited = r.instance.waitUntilExit();
        let done = false;
        void exited.then(() => { done = true });
        // "q" and Enter typed together (":wq" into a shell that turned out to
        // be detached): that Enter came too soon to be an answer.
        await r.press("q" + "\r");
        await r.waitFor("Quit cockpit-tui?");
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(done).toBe(false);
        await new Promise(resolve => setTimeout(resolve, 600));
        await r.press(keys.enter);
        await expect(exited).resolves.toEqual({ code: 0 });
    });

    it("asks before Ctrl+C quits while a quit guard is set; a second Ctrl+C quits", async () => {
        const r = await start();
        setQuitGuard("test", "A shell session is still running.");
        await r.press(keys.ctrl("c"));
        await r.waitFor("A shell session is still running.");
        const exited = r.instance.waitUntilExit();
        await r.press(keys.ctrl("c"));
        await expect(exited).resolves.toEqual({ code: 0 });
    });

    it("notices a connection that was lost before the shell mounted", async () => {
        session = await mockSession();
        const superuser = await Superuser.open();
        session.transport.close({ problem: "terminated" });
        const r = renderInk(<TuiRoot session={session} superuser={superuser} options={{}} />, { columns: 100, rows: 24 });
        await r.waitFor("Disconnected from");
        const exited = r.instance.waitUntilExit();
        await r.press("q");
        await expect(exited).resolves.toMatchObject({ code: 1 });
    });

    it("keeps the shell's own hints when a page has many", async () => {
        const r = await start();
        await r.press("2");
        const frame = await r.waitFor(f => f.split("\n")[23]!.includes("k0"));
        const footer = frame.split("\n")[23]!;
        expect(footer).toContain("k0 long action number 0");
        expect(footer).toContain("? help");
        expect(footer).toContain("q quit");
        expect(footer).not.toContain("k11");
        expect(footer.length).toBeLessThanOrEqual(100);
    });

    it("lists the current page's keys in the help dialog", async () => {
        const r = await start();
        await r.press("2");
        await r.waitFor(f => f.split("\n")[23]!.includes("k0"));
        await r.press("?");
        const frame = await r.waitFor("Logs page");
        expect(frame).toContain("long action number 11");
        expect(frame).toContain("a key only help lists");
    });

    it("keeps the footer clear of a help dialog that has to scroll", async () => {
        const r = await start();
        await r.press("2");
        await r.waitFor(f => f.split("\n")[23]!.includes("k0"));
        await r.press("?");
        const frame = await r.waitFor("Logs page");
        const rows = frame.split("\n");
        expect(rows[23]).toMatch(/scroll.*l log.*esc close/);
        expect(rows[0]).toContain("mock");
        // The dialog's bottom border is above the footer, and its top below the header.
        expect(rows[22]).toMatch(/[└+]/);
        expect(rows[1]).toMatch(/[┌+]/);
    });

    it("reports a lost connection in place of the page, and quits with a failure status", async () => {
        const r = await start();
        session!.transport.close({ problem: "terminated", message: "bridge exited" });
        await r.waitFor("Disconnected from");
        expect(r.lastFrame()).toContain("terminated");
        const exited = r.instance.waitUntilExit();
        await r.press("q");
        await expect(exited).resolves.toMatchObject({ code: 1 });
    });
});

describe("administrative access", () => {
    const flow = {
        superuserFlow: {
            bridges: ["sudo"],
            password: "s3cr3t",
            prompts: [
                { prompt: "[sudo] password for mock: ", error: "We trust you have received the usual lecture." },
                { prompt: "[sudo] password for mock: " },
            ],
        },
    };

    it("escalates through the dialog, retrying after a wrong password", async () => {
        const r = await start(flow);
        await r.press("A");
        let frame = await r.waitFor("Password for mock:");
        expect(frame).toContain("usual lecture");
        await r.press("wrong", keys.enter);
        frame = await r.waitFor("Sorry, try again.");
        // The answer is never echoed.
        expect(frame).not.toContain("wrong");
        await r.press("s3cr3t");
        frame = await r.waitFor("••••••");
        expect(frame).not.toContain("s3cr3t");
        await r.press(keys.enter);
        // The header changes as soon as the bridge reports it; the dialog
        // closes when Start() returns, with a confirmation in the footer.
        frame = await r.waitFor("Administrative access is on");
        expect(frame.split("\n")[0]).toContain("Administrative access");
        expect(frame).not.toContain("Password for mock:");
    });

    it("takes the page down while access is changing, and brings it back after", async () => {
        const r = await start(flow);
        await r.waitFor("Overview is not implemented yet.");
        await r.press("A");
        // Current is "init" while sudo asks: no page, so no page channels
        // can be routed to the privileged bridge that is still starting.
        const prompting = await r.waitFor("Password for mock:");
        expect(prompting).toContain("Switching access");
        expect(prompting).not.toContain("Overview is not implemented yet.");
        await r.press(keys.escape);
        await r.waitFor("Overview is not implemented yet.");
    });

    it("cancels with Esc and stays limited", async () => {
        const r = await start(flow);
        await r.press("A");
        await r.waitFor("Password for mock:");
        await r.press(keys.escape);
        await r.waitFor(frame => !frame.includes("Password for mock:"));
        expect(r.lastFrame().split("\n")[0]).toContain("Limited access");
    });

    it("drops back to limited access after confirming", async () => {
        const r = await start({ superuserFlow: { bridges: ["sudo"], prompts: [] } });
        await r.press("A");
        // The header changes before Start() returns; the dialog closes after.
        await r.waitFor("Administrative access is on");
        await r.press("A");
        await r.waitFor("Switch to limited access");
        await r.press(keys.enter);
        await r.waitFor(frame => frame.split("\n")[0]!.includes("Limited access"));
    });

    it("survives the terminal shrinking below the minimum mid-prompt, without restarting sudo", async () => {
        const r = await start(flow);
        // Count escalation attempts: transitions into "init".
        let starts = 0;
        const superuser = await Superuser.open();
        let previous = superuser.current;
        superuser.onChanged(() => {
            if (superuser.current === "init" && previous !== "init")
                starts++;
            previous = superuser.current;
        });
        await r.press("A");
        await r.waitFor("Password for mock:");
        await r.press("s3");
        r.resize(40, 10);
        await r.waitFor(frame => frame.replace(/\s+/g, " ").includes("needs at least 50x12"));
        // Keys typed blind while too small reach nothing.
        await r.press("x", keys.enter);
        r.resize(100, 24);
        const frame = await r.waitFor("Password for mock:");
        // The same attempt, with what was typed before: no second Start.
        expect(frame).toContain("••");
        expect(frame).not.toContain("•••");
        expect(starts).toBe(1);
        await r.press("cr3t", keys.enter);
        await r.waitFor("Administrative access is on");
    });

    it("closes 'limit access' quietly when access already ended, without wedging the page", async () => {
        const r = await start({ superuserFlow: { bridges: ["sudo"], prompts: [] } });
        await r.press("A");
        await r.waitFor("Administrative access is on");
        await r.press("A");
        await r.waitFor("Switch to limited access");
        // Access ends behind the dialog's back (the privileged bridge died).
        const other = await Superuser.open();
        await other.stop();
        await r.waitFor(frame => frame.split("\n")[0]!.includes("Limited access"));
        await r.press(keys.enter);
        await r.waitFor("Overview is not implemented yet.");
        expect(r.lastFrame()).not.toContain("Switching access");
    });

    it("says so when administrative access ends without being asked to", async () => {
        const r = await start({ superuserFlow: { bridges: ["sudo"], prompts: [], peerExitAfterMs: 400 } });
        await r.press("A");
        await r.waitFor("Administrative access is on");
        const frame = await r.waitFor("Administrative access ended");
        expect(frame.split("\n")[0]).toContain("Limited access");
        await r.waitFor("Overview is not implemented yet.");
    });

    it("explains when no escalation method is configured", async () => {
        const r = await start({ superuserFlow: { bridges: [] } });
        await r.press("A");
        await r.waitFor("No methods to gain administrative access");
        await r.press(keys.escape);
        await r.waitFor(frame => !frame.includes("No methods to gain"));
    });

    it("opens the dialog at startup with --admin", async () => {
        session = await mockSession(flow);
        const superuser = await Superuser.open();
        const r = renderInk(<TuiRoot session={session} superuser={superuser} options={{ requestAdmin: true }} />, { columns: 100, rows: 24 });
        await r.waitFor("Password for mock:");
    });
});

describe("privilege generations", () => {
    it("change only when privilege settles into a different state", async () => {
        const { PrivilegeProvider, usePrivilege } = await import("../../src/tui/privilege.js");
        const { StatusProvider } = await import("../../src/tui/status.js");
        const { Text } = await import("ink");
        function Show() {
            const p = usePrivilege();
            return <Text>gen={p.generation} current={p.current} allowed={String(p.allowed)}</Text>;
        }
        session = await mockSession({
            superuserFlow: { bridges: ["sudo"], password: "pw", prompts: [{ prompt: "Password: " }, { prompt: "Password: " }] },
        });
        const superuser = await Superuser.open();
        const r = renderInk(<StatusProvider><PrivilegeProvider superuser={superuser}><Show /></PrivilegeProvider></StatusProvider>);
        await r.waitFor("gen=0 current=none allowed=false");

        // A failed attempt passes through "init" and back to "none": no change.
        await expect(superuser.start(async () => "wrong")).rejects.toThrow();
        await r.waitFor("gen=0 current=none allowed=false");

        await superuser.start(async () => "pw");
        await r.waitFor("gen=1 current=sudo allowed=true");

        await superuser.stop();
        await r.waitFor("gen=2 current=none allowed=false");
    });
});
