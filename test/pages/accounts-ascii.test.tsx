/*
 * The Accounts page without a UTF-8 locale (a serial console, LANG=C, or
 * COCKPIT_TUI_ASCII=1): whatever it writes of its own is ASCII, so nothing
 * turns into mojibake or into C1 control bytes on such a terminal.
 *
 * theme.ts decides on Unicode when it is first imported, so the switch is
 * set before any import (vi.hoisted) in a file of its own.
 */
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";

const saved = vi.hoisted(() => {
    const previous = process.env.COCKPIT_TUI_ASCII;
    process.env.COCKPIT_TUI_ASCII = "1";
    return previous;
});

import AccountsPage from "../../src/pages/accounts/index.js";
import { SHADOW_LOCK_SCRIPT } from "../../src/pages/accounts/scripts.js";
import { initInfo } from "../../src/session.js";
import { unicode } from "../../src/tui/theme.js";
import { renderPage, type RenderedPage } from "../helpers/page.js";
import { cleanup, keys } from "../helpers/ink.js";
import { startMock, type MockBridge, type MockScenario } from "../mock-bridge/harness.js";

const LOGIN1 = "/org/freedesktop/login1";

function scenario(): MockScenario {
    return {
        superuser: true,
        files: {
            "/etc/passwd": {
                content: "root:x:0:0:root:/root:/bin/bash\nbin:x:1:1:bin:/bin:/sbin/nologin\n" +
                    "mock:x:1000:1000:Mock User:/home/mock:/bin/bash\nbob:x:1002:1002::/home/bob:/bin/zsh\n",
                mode: 0o644, uid: 0, gid: 0,
            },
            "/etc/group": { content: "root:x:0:\nwheel:x:10:mock\nmock:x:1000:\nbob:x:1002:\n", mode: 0o644, uid: 0, gid: 0 },
            "/etc/login.defs": "UID_MIN 1000\nUID_MAX 60000\nGID_MIN 1000\nGID_MAX 60000\n",
            "/home/mock/.ssh/authorized_keys": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMock mock@laptop\n",
        },
        dbus: {
            system: {
                [LOGIN1]: {
                    "org.freedesktop.login1.Manager": {
                        methods: {
                            ListUsers: { reply: [[[1000, "mock", `${LOGIN1}/user/_1000`]]], type: "a(uso)" },
                            ListSessions: { reply: [[["3", 1000, "mock", "", `${LOGIN1}/session/_33`]]], type: "a(susso)" },
                        },
                    },
                },
                [`${LOGIN1}/user/_1000`]: { "org.freedesktop.login1.User": { properties: { State: "active" } } },
                [`${LOGIN1}/session/_33`]: {
                    "org.freedesktop.login1.Session": {
                        properties: {
                            Id: "3", Name: "mock", TTY: "pts/0", Service: "sshd", RemoteHost: "10.0.0.5", State: "active",
                            Type: "tty", Class: "user", Display: "", IdleHint: false, Timestamp: { t: "t", v: 1790982722439460 },
                        },
                    },
                },
            },
        },
        spawn: {
            "lastlog": { stdout: "Username         Port     From             Latest\nroot                                       **Never logged in**\n" },
            "passwd -S --all": { "exit-status": 1, stderr: "passwd: bad argument --all: unknown option\n" },
            [`sh -c ${SHADOW_LOCK_SCRIPT}`]: { stdout: "root $\nmock $\nbob !\n" },
        },
        spawnPatterns: [
            { match: "lastlog2", "exit-status": 1, stderr: "no lastlog2\n" },
            {
                match: "ssh-keygen -l -f authorized_keys",
                stdout: "256 SHA256:mockFingerprint mock@laptop (ED25519)\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMock mock@laptop\n",
            },
            { match: "^chage -l ", stdout: "Last password change\t: Jan 05, 2026\nPassword expires\t: never\nAccount expires\t: never\n" },
            { match: "^last ", stdout: "\nwtmp begins 2025-09-06T19:42:29-06:00\n" },
        ],
    };
}

let mock: MockBridge | null = null;

afterEach(() => {
    cleanup();
    mock?.close();
    mock = null;
});

afterAll(() => {
    if (saved === undefined)
        delete process.env.COCKPIT_TUI_ASCII;
    else
        process.env.COCKPIT_TUI_ASCII = saved;
});

/** Every character on screen (and in the key hints) that is not ASCII. */
function nonAscii(r: RenderedPage): string[] {
    return [...r.lastFrame().matchAll(/[^\x00-\x7f]/g)].map(match => match[0]);
}

describe("without a UTF-8 locale", () => {
    it("writes only ASCII of its own: list, details, groups, dialogs and key hints", async () => {
        expect(unicode).toBe(false);
        mock = await startMock(scenario());
        await initInfo();
        const r = renderPage(AccountsPage, { columns: 120, rows: 30, allowed: true, showHints: true });
        await r.waitFor(f => f.includes("locked") && f.includes("1 system hidden"));
        expect(r.lastFrame()).toContain("<-/-> groups");
        expect(nonAscii(r)).toEqual([]);
        await r.press("h");
        await r.waitFor("system accounts shown");
        expect(nonAscii(r)).toEqual([]);
        // Details: the account (rows that scroll), sessions, keys, history.
        await r.press(keys.enter);
        await r.waitFor(f => /Password expires\s+never/.test(f));
        expect(r.lastFrame()).toContain("<-/-> tabs");
        expect(nonAscii(r)).toEqual([]);
        for (const tab of ["[Sessions (1)]", "mockFingerprint", "[History]"]) {
            await r.press(keys.right);
            await r.waitFor(tab);
            expect(nonAscii(r)).toEqual([]);
        }
        await r.press(keys.right, keys.right, keys.right);
        await r.waitFor("[SSH keys (1)]");
        await r.press("n");
        await r.waitFor("Add SSH key for mock");
        expect(nonAscii(r)).toEqual([]);
        await r.press(keys.escape, keys.escape);
        await r.waitFor("system accounts shown");
        // A confirmation, then the groups.
        await r.press(keys.home, keys.down, "D");
        await r.waitFor("Delete bin");
        expect(nonAscii(r)).toEqual([]);
        await r.press(keys.escape, keys.right);
        await r.waitFor("[Groups]");
        expect(r.lastFrame()).toContain("<-/-> accounts");
        expect(nonAscii(r)).toEqual([]);
    });
});
