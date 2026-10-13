/*
 * The Accounts page against the mock bridge: what it shows, and the exact
 * commands, D-Bus calls and file writes its actions make.
 *
 * The scenario below is a small machine: root, the session user "mock"
 * (an administrator, logged in), alice (logged in, locked), bob, and two
 * hidden system accounts. Tests that need administrative access run with
 * scenario "superuser": true AND renderPage({ allowed: true }); without the
 * first, every "require" channel would be refused.
 */
import { describe, it, expect, afterEach } from "vitest";
import AccountsPage from "../../src/pages/accounts/index.js";
import { SHADOW_LOCK_SCRIPT } from "../../src/pages/accounts/scripts.js";
import { initInfo } from "../../src/session.js";
import { width as textWidth } from "../../src/tui/text.js";
import { renderPage, type RenderedPage } from "../helpers/page.js";
import { cleanup, keys } from "../helpers/ink.js";
import { startMock, type MockBridge, type MockScenario, type JsonObject } from "../mock-bridge/harness.js";

// ---- the machine -----------------------------------------------------------------

const PASSWD = [
    "root:x:0:0:root:/root:/bin/bash",
    "bin:x:1:1:bin:/bin:/sbin/nologin",
    "mock:x:1000:1000:Mock User:/home/mock:/bin/bash",
    "alice:x:1001:1001:Alice Arbitrary:/home/alice:/bin/bash",
    "bob:x:1002:1002::/home/bob:/bin/zsh",
    "svc:x:1500:1500:Service:/var/svc:/usr/sbin/nologin",
    "",
].join("\n");

const GROUP = [
    "root:x:0:",
    "wheel:x:10:mock",
    "users:x:100:",
    "mock:x:1000:",
    "alice:x:1001:",
    "bob:x:1002:",
    "libvirt:x:981:alice",
    "docker:x:982:",
    "",
].join("\n");

const ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyMockKeyMockKeyMockKeyMockKey mock@laptop";
const RSA = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDpMockRsaMockRsaMockRsa alice@desk";

const LASTLOG = [
    "Username         Port     From                                       Latest",
    "root                                                                **Never logged in**",
    "mock             pts/0    10.0.0.5                                  Fri Oct  2 17:12:02 -0600 2026",
    "bob              pts/1    10.0.0.7                                  Sun Sep 20 10:43:42 -0600 2026",
    "",
].join("\n");

const LOGIN1 = "/org/freedesktop/login1";
const t = (v: number) => ({ t: "t", v });

function session(id: string, user: string, tty: string, host: string, state = "active") {
    return {
        "org.freedesktop.login1.Session": {
            properties: {
                Id: id, Name: user, TTY: tty, Service: tty === "web console" ? "cockpit" : "sshd", RemoteHost: host,
                State: state, Type: "tty", Class: "user", Display: "", IdleHint: false, Timestamp: t(1790982722439460),
            },
        },
    };
}

function scenario(overrides: Partial<MockScenario> = {}, extraSpawn: MockScenario["spawn"] = {}): MockScenario {
    return {
        files: {
            "/etc/passwd": { content: PASSWD, mode: 0o644, uid: 0, gid: 0 },
            "/etc/group": { content: GROUP, mode: 0o644, uid: 0, gid: 0 },
            "/etc/shells": "/bin/sh\n/bin/bash\n/bin/zsh\n",
            "/etc/login.defs": "UID_MIN 1000\nUID_MAX 60000\nGID_MIN 1000\nGID_MAX 60000\nUSERGROUPS_ENAB yes\n",
            "/etc/shadow": { content: "root:$6$r:1::::::\nmock:$6$m:1::::::\nalice:!$6$a:1::::::\nbob:$6$b:1::::::\n", mode: 0, uid: 0, gid: 0 },
            "/home/mock/.ssh/authorized_keys": `${ED25519}\n`,
            "/home/alice/.ssh/authorized_keys": { content: `${RSA}\n`, mode: 0o600, uid: 1001, gid: 1001 },
        },
        dbus: {
            system: {
                [LOGIN1]: {
                    "org.freedesktop.login1.Manager": {
                        methods: {
                            ListUsers: {
                                reply: [[[1000, "mock", `${LOGIN1}/user/_1000`], [1001, "alice", `${LOGIN1}/user/_1001`]]],
                                type: "a(uso)",
                            },
                            ListSessions: {
                                reply: [[
                                    ["3", 1000, "mock", "", `${LOGIN1}/session/_33`],
                                    ["7", 1001, "alice", "", `${LOGIN1}/session/_37`],
                                ]],
                                type: "a(susso)",
                            },
                        },
                        signals: { SessionRemoved: { in: ["s", "o"] } },
                    },
                },
                [`${LOGIN1}/user/_1000`]: { "org.freedesktop.login1.User": { properties: { State: "active" } } },
                [`${LOGIN1}/user/_1001`]: { "org.freedesktop.login1.User": { properties: { State: "online" } } },
                [`${LOGIN1}/session/_33`]: session("3", "mock", "pts/0", "10.0.0.5"),
                [`${LOGIN1}/session/_37`]: session("7", "alice", "web console", "::ffff:10.0.0.9"),
            },
        },
        spawn: {
            "lastlog": { stdout: LASTLOG },
            // Where the key files really are, checked before one is rewritten.
            ...Object.fromEntries(["mock", "alice", "bob"].map(name => [
                `realpath -e -- /home/${name} /home/${name}/.ssh/authorized_keys`,
                { stdout: `/home/${name}\n/home/${name}/.ssh/authorized_keys\n` },
            ])),
            "passwd -S --all": { "exit-status": 1, stderr: "passwd: bad argument --all: unknown option\n" },
            [`sh -c ${SHADOW_LOCK_SCRIPT}`]: { stdout: "root $\nmock $\nalice !\nbob $\n" },
            "chage -l mock": {
                stdout: "Last password change\t\t\t\t\t: Jan 05, 2026\nPassword expires\t\t\t\t\t: never\n" +
                    "Password inactive\t\t\t\t\t: never\nAccount expires\t\t\t\t\t\t: never\n" +
                    "Maximum number of days between password change\t\t: 99999\n",
            },
            "last --time-format iso -n25 --fullnames mock": {
                stdout: "mock     pts/0        10.0.0.5         2026-10-02T17:12:02-06:00   still logged in\n" +
                    "mock     pts/1        10.0.0.5         2026-10-01T09:00:00-06:00 - 2026-10-01T09:30:00-06:00  (00:30)\n\n" +
                    "wtmp begins 2025-09-06T19:42:29-06:00\n",
            },
            ...extraSpawn,
        },
        spawnPatterns: [
            ...(overrides.spawnPatterns ?? []),
            { match: "lastlog2", "exit-status": 1, stderr: "/var/lib/lastlog/lastlog2.db does not exist\n" },
            { match: "ssh-keygen -l -f authorized_keys", stdout: `256 SHA256:mockFingerprint mock@laptop (ED25519)\n${ED25519}\n` },
            { match: "^chage -l ", "exit-status": 1, stderr: "chage: Permission denied.\n" },
            { match: "^last ", stdout: "\nwtmp begins 2025-09-06T19:42:29-06:00\n" },
        ],
        ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "spawnPatterns")),
    };
}

// ---- harness ---------------------------------------------------------------------

let mock: MockBridge | null = null;

afterEach(() => {
    cleanup();
    mock?.close();
    mock = null;
});

async function open(s: MockScenario, options: {
    allowed?: boolean, columns?: number, rows?: number, showHints?: boolean, seed?: Record<string, unknown>,
} = {}): Promise<RenderedPage> {
    mock = await startMock(s);
    await initInfo();
    return renderPage(AccountsPage, {
        columns: options.columns ?? 110, rows: options.rows ?? 30, allowed: options.allowed ?? false,
        ...(options.showHints ? { showHints: true } : {}),
        ...(options.seed ? { seed: options.seed } : {}),
    });
}

/*
 * The text inside the dialog box on screen, its wrapped lines joined and
 * whitespace collapsed, so assertions do not depend on where lines break.
 */
function dialogText(frame: string): string {
    return frame.split("\n").flatMap(line => {
        // The title is set into the top border: "┌───┤ Title ├───┐".
        const title = /┤ (.*) ├/.exec(line);
        if (title)
            return [title[1]!];
        const first = line.indexOf("│");
        const last = line.lastIndexOf("│");
        return first >= 0 && last > first ? [line.slice(first + 1, last).trim()] : [];
    }).join(" ").replace(/\s+/g, " ");
}

async function waitForDialog(r: RenderedPage, text: string): Promise<string> {
    const frame = await r.waitFor(f => dialogText(f).includes(text));
    return dialogText(frame);
}

/** Every process the page spawned, as [argv, open options]. */
function spawned(): [string[], JsonObject][] {
    return mock!.opened("stream").map(open => [open.spawn as string[], open]);
}

function spawnedWith(first: string): [string[], JsonObject][] {
    return spawned().filter(([argv]) => argv[0] === first);
}

// ---- tests -----------------------------------------------------------------------

/** The rows of the list, top to bottom: the first word of each table line. */
function listed(frame: string): string[] {
    const lines = frame.split("\n");
    const header = lines.findIndex(line => /^\s+User\s/.test(line));
    return lines.slice(header + 1).map(line => line.slice(2).trim().split(/\s+/)[0] ?? "").filter(Boolean)
        .filter(word => !word.startsWith("status:"));
}

describe("accounts list", () => {
    it("lists people, not system accounts, with their login facts", async () => {
        const r = await open(scenario());
        const frame = await r.waitFor(f => f.includes("logged in") && f.includes("2026-09-20"));
        expect(listed(frame)).toEqual(["mock", "alice", "bob", "root"]);
        expect(frame).toContain("mock (you)");
        expect(frame).toContain("2 system hidden");
        expect(frame).toMatch(/mock \(you\)\s+Mock User\s+1000 admin \?\s+logged in\s+wheel/);
        expect(frame).toMatch(/alice\s+Alice Arbitrary\s+1001\s+\?\s+logged in\s+libvirt/);
        expect(frame).toMatch(/bob\s+1002\s+\?\s+2026-09-20 10:43/);
        expect(frame).toMatch(/root\s+root\s+0 admin \?\s+never/);
        expect(frame).toContain("Limited access: press A");
    });

    it("reads nothing privileged without administrative access, and says the lock state is unknown", async () => {
        const r = await open(scenario());
        const frame = await r.waitFor("2026-09-20");
        expect(frame).toMatch(/UID Role\s+Lock\s+Last active/);
        const rows = frame.split("\n").filter(line => /^[› ] (mock|alice|bob|root)\b/.test(line));
        expect(rows).toHaveLength(4);
        for (const row of rows)
            expect(row).toMatch(/ \?\s/);
        expect(spawnedWith("passwd")).toEqual([]);
        expect(spawned().filter(([argv]) => argv[0] === "sh" && argv[1] === "-c")).toEqual([]);
        // lastlog2 first (absent here), then lastlog, both unprivileged.
        const [python] = spawned().find(([argv]) => argv.includes("--"))!;
        expect(python.slice(0, 4)).toEqual(["sh", "-ec", "exec $(command -v /usr/libexec/platform-python || command -v python3) -c \"$@\"", "--"]);
        expect(python[4]).toContain("/var/lib/lastlog/lastlog2.db");
        expect(spawnedWith("lastlog")[0]).toEqual([["lastlog"], expect.objectContaining({ environ: ["LC_ALL=C"] })]);
        expect(spawnedWith("lastlog")[0]![1].superuser).toBeUndefined();
    });

    it("asks logind who is logged in, the way upstream does", async () => {
        const r = await open(scenario());
        await r.waitFor("logged in");
        const calls = mock!.received().flatMap(entry => {
            if (entry.data === undefined)
                return [];
            try {
                const message = JSON.parse(entry.data) as { call?: unknown[], type?: string, flags?: string, timeout?: number };
                return message.call ? [message] : [];
            } catch {
                return [];
            }
        });
        expect(calls).toContainEqual(expect.objectContaining({
            call: [LOGIN1, "org.freedesktop.login1.Manager", "ListUsers", []], type: "", flags: "", timeout: 5000,
        }));
        expect(calls).toContainEqual(expect.objectContaining({
            call: [`${LOGIN1}/user/_1001`, "org.freedesktop.DBus.Properties", "Get", ["org.freedesktop.login1.User", "State"]],
            type: "ss",
        }));
        const match = mock!.received().find(entry => entry.data?.includes("add-match"));
        expect(JSON.parse(match!.data!)).toEqual({ "add-match": { interface: "org.freedesktop.login1.Manager", path: LOGIN1 } });
    });

    it("does not count a lingering user as logged in", async () => {
        const s = scenario();
        (s.dbus!.system![`${LOGIN1}/user/_1001`]!["org.freedesktop.login1.User"]!.properties as JsonObject).State = "lingering";
        const r = await open(s);
        const frame = await r.waitFor("2026-09-20");
        expect(frame).toMatch(/alice\s+Alice Arbitrary\s+1001\s+\?\s+never/);
    });

    it("says so when logind cannot be asked, instead of showing nobody logged in", async () => {
        const s = scenario();
        s.dbus = { system: {} };
        s.dbusOwners = { system: { "org.freedesktop.login1": null } };
        const r = await open(s, { columns: 130 });
        let frame = await r.waitFor("logind unavailable: login state unknown");
        frame = await r.waitFor("2026-09-20");
        expect(frame).toMatch(/mock \(you\)\s+Mock User\s+1000 admin \?\s+2026-10-02 17:12/);
        await r.press(keys.enter, keys.right);
        frame = await r.waitFor("Sessions are not available:");
        expect(frame).not.toContain("Loading sessions");
    });

    it("keeps the logind explanation on an 80-column tab line", async () => {
        const s = scenario();
        s.dbus = { system: {} };
        s.dbusOwners = { system: { "org.freedesktop.login1": null } };
        const r = await open(s, { columns: 80 });
        const frame = await r.waitFor("2026-09-20");
        expect(frame.split("\n")[0]).toContain("logind unavailable: login state unknown");
    });

    it("shows system accounts on request, and hides them again", async () => {
        const r = await open(scenario());
        await r.waitFor("2 system hidden");
        await r.press("h");
        let frame = await r.waitFor("system accounts shown");
        expect(listed(frame)).toEqual(["mock", "alice", "bin", "bob", "root", "svc"]);
        await r.press("h");
        frame = await r.waitFor("2 system hidden");
        expect(listed(frame)).toEqual(["mock", "alice", "bob", "root"]);
    });

    it("filters by name, full name, UID and group; Esc clears", async () => {
        const r = await open(scenario());
        await r.waitFor("2 system hidden");
        await r.press("/", "libv");
        let frame = await r.waitFor("1 of 4 accounts");
        expect(listed(frame)).toEqual(["alice"]);
        await r.press(keys.enter); // keep the filter, back to the list
        await r.press("/", keys.ctrl("u"), "1002", keys.enter);
        frame = await r.waitFor(f => f.includes("1 of 4") && f.includes("bob"));
        expect(listed(frame)).toEqual(["bob"]);
        await r.press(keys.escape);
        frame = await r.waitFor("4 accounts ·");
        expect(listed(frame)).toHaveLength(4);
        await r.press("/", "zzz");
        await r.waitFor('No accounts match "zzz"');
    });

    it("sorts by UID and by last activity, the current user staying first", async () => {
        const r = await open(scenario());
        await r.waitFor("2026-09-20");
        await r.press("s");
        let frame = await r.waitFor("by UID");
        expect(listed(frame)).toEqual(["mock", "root", "alice", "bob"]);
        await r.press("s");
        frame = await r.waitFor("by last active");
        expect(listed(frame)).toEqual(["mock", "alice", "bob", "root"]);
        await r.press("S");
        frame = await r.waitFor("(reversed)");
        expect(listed(frame)).toEqual(["mock", "root", "bob", "alice"]);
    });

    it("explains instead of acting when access is missing", async () => {
        const r = await open(scenario());
        await r.waitFor("2 system hidden");
        await r.press("n");
        await r.waitFor("status: warning: Creating accounts needs administrative access (press A)");
        await r.press(keys.down, "D");
        await r.waitFor("status: warning: Delete: needs administrative access (press A)");
        expect(spawnedWith("/usr/sbin/userdel")).toEqual([]);
    });

    it("shows the lock state with administrative access, read without exposing any hash", async () => {
        const r = await open(scenario({ superuser: true }), { allowed: true });
        const frame = await r.waitFor(f => f.includes("locked") && f.includes("logged in"));
        expect(frame).toMatch(/\bLock\b/);
        expect(frame).toMatch(/alice\s+Alice Arbitrary\s+1001\s+locked logged in/);
        expect(frame).not.toContain("Limited access");
        const [all] = spawnedWith("passwd");
        expect(all![0]).toEqual(["passwd", "-S", "--all"]);
        expect(all![1]).toMatchObject({ superuser: "require", err: "message", environ: ["LC_ALL=C"] });
        // libuser's passwd has no --all: the fallback prints one character per account.
        const fallback = spawned().find(([argv]) => argv[0] === "sh" && argv[1] === "-c")!;
        expect(fallback[0]).toEqual(["sh", "-c", SHADOW_LOCK_SCRIPT]);
        expect(fallback[1]).toMatchObject({ superuser: "require", err: "message" });
        expect(mock!.opened("fsread1").filter(o => o.path === "/etc/shadow")).toEqual([]);
    });

    it("uses passwd -S --all where it exists", async () => {
        const r = await open(scenario({ superuser: true }, {
            "passwd -S --all": { stdout: "root P 2026-01-01 0 99999 7 -1\nmock P 2026-01-01 0 99999 7 -1\nbob L 2026-01-01 0 99999 7 -1\n" },
        }), { allowed: true });
        const frame = await r.waitFor(f => f.includes("locked") && f.includes("2026-09-20"));
        expect(frame).toMatch(/bob\s+1002\s+locked 2026-09-20/);
        expect(frame).not.toMatch(/alice.*locked/);
        expect(spawned().filter(([argv]) => argv[0] === "sh" && argv[1] === "-c")).toEqual([]);
    });

    it("follows logind: a terminated user is no longer logged in", async () => {
        const r = await open(scenario({ superuser: true }, {
            "loginctl terminate-user alice": {
                effects: [
                    { properties: [`${LOGIN1}/user/_1001`, "org.freedesktop.login1.User", { State: "closing" }] },
                    { signal: [LOGIN1, "org.freedesktop.login1.Manager", "SessionRemoved", ["7", `${LOGIN1}/session/_37`]] },
                ],
            },
        }), { allowed: true });
        await r.waitFor(f => /alice.*logged in/.test(f));
        await r.press(keys.down, "t");
        const dialog = await r.waitFor("Terminate sessions of alice");
        expect(dialog).toContain("loginctl terminate-user");
        await r.press(keys.enter);
        await r.waitFor("status: success: Terminated the sessions of alice");
        await r.waitFor(f => /alice\s+Alice Arbitrary\s+1001\s+locked never/.test(f));
        const [argv, options] = spawnedWith("loginctl")[0]!;
        expect(argv).toEqual(["loginctl", "terminate-user", "alice"]);
        expect(options).toMatchObject({ superuser: "try", err: "message" });
    });
});

describe("leaving the page", () => {
    it("stops the per-line `date` runs for lastlog dates it cannot read", async () => {
        const lastlog = ["Username         Port     From             Latest",
            ...["mock", "alice", "bob", "svc"].map(name => `${name.padEnd(17)}pts/0    10.0.0.5         Fri Okt  2 17:12:02 -0600 2026`),
            ""].join("\n");
        const r = await open(scenario({
            spawnPatterns: [{ match: "^date ", chunks: [{ data: "1790982722\n", delayMs: 400 }] }],
        }, { "lastlog": { stdout: lastlog } }));
        const first = await mock!.waitForReceived(e => e.control?.command === "open" && Array.isArray(e.control.spawn) &&
                                                      e.control.spawn[0] === "date");
        expect(r.lastFrame()).toContain("mock");
        cleanup();
        // The running one is closed, and no other starts.
        await mock!.waitForReceived(e => e.control?.command === "close" && e.control.channel === first.control!.channel);
        expect(spawnedWith("date")).toHaveLength(1);
    });
});

describe("account details", () => {
    it("shows the account, its password facts and its actions", async () => {
        const r = await open(scenario());
        await r.waitFor("logged in");
        await r.press(keys.enter);
        const frame = await r.waitFor(f => f.includes("2026-01-05") && f.includes("1 session"));
        expect(frame).toContain("Mock User  mock · UID 1000 · your account");
        expect(frame).toMatch(/\[Account\]\s+Sessions \(1\)/);
        expect(frame).toMatch(/Groups\s+wheel/);
        expect(frame).toMatch(/Administrator\s+yes \(wheel\)/);
        expect(frame).toMatch(/Password login\s+unknown \(needs administrative access\)/);
        expect(frame).toMatch(/Password expires\s+never/);
        expect(frame).toMatch(/Last login\s+logged in now \(1 session\)/);
        expect(frame).toMatch(/D\s+delete\s+you cannot delete your own account/);
        const [argv, options] = spawnedWith("chage")[0]!;
        expect(argv).toEqual(["chage", "-l", "mock"]);
        expect(options).toMatchObject({ superuser: "try", err: "message", environ: ["LC_ALL=C"] });
        expect(spawnedWith("last")[0]![0]).toEqual(["last", "--time-format", "iso", "-n25", "--fullnames", "mock"]);
    });

    it("says what is unknown without access, for someone else's account", async () => {
        const r = await open(scenario());
        await r.waitFor("logged in");
        await r.press(keys.down, keys.enter);
        const frame = await r.waitFor(f => f.includes("Alice Arbitrary  alice") && f.includes("Password expires"));
        await r.waitFor(f => /Password expires\s+unknown \(needs administrative access\)/.test(f));
        expect(frame).toMatch(/Groups\s+libvirt/);
        expect(frame).toMatch(/Administrator\s+no/);
        // chage -l would only fail (and leave an audit record): not even started.
        expect(spawnedWith("chage")).toEqual([]);
    });

    it("switches tabs: sessions, SSH keys, login history; Esc goes back", async () => {
        const r = await open(scenario());
        await r.waitFor("logged in");
        await r.press(keys.enter);
        await r.waitFor("[Account]");
        await r.press(keys.right);
        let frame = await r.waitFor("[Sessions (1)]");
        expect(frame).toMatch(/3\s+pts\/0\s+sshd\s+10\.0\.0\.5\s+active\s+2026-10-02 17:12/);
        await r.press(keys.right);
        frame = await r.waitFor("mockFingerprint");
        expect(frame).toContain("/home/mock/.ssh/authorized_keys");
        expect(frame).toMatch(/mock@laptop\s+ED25519 256\s+SHA256:mockFingerprint/);
        // The key file went through the lister, unprivileged, as upstream.
        const lister = spawned().find(([argv]) => argv[0] === "/bin/sh")!;
        expect(lister[0].slice(0, 2)).toEqual(["/bin/sh", "-c"]);
        expect(lister[0][2]).toContain("ssh-keygen -l -f authorized_keys");
        expect(lister[0].slice(3)).toEqual(["--"]);
        expect(lister[1].superuser).toBeUndefined();
        expect(mock!.sent(lister[1].channel as string)).toBe(`${ED25519}\n\n`);
        await r.press(keys.right);
        frame = await r.waitFor("[History]");
        expect(frame).toMatch(/2026-10-02 17:12 still logged in\s+10\.0\.0\.5\s+pts\/0/);
        expect(frame).toMatch(/2026-10-01 09:00 2026-10-01 09:30 30m\s+10\.0\.0\.5/);
        await r.press(keys.right);
        await r.waitFor("[Account]");
        await r.press(keys.escape);
        frame = await r.waitFor("2 system hidden");
        expect(frame).toContain("› mock (you)");
    });

    it("cannot read another account's keys without access, and says so", async () => {
        const r = await open(scenario(), { columns: 70 });
        await r.waitFor("logged in");
        await r.press(keys.down, keys.enter, keys.right, keys.right);
        const frame = await r.waitFor("You do not have permission to view");
        expect(frame).toContain("/home/alice/.ssh/authorized_keys (read-only)");
        // Wrapped under the rows' indent, not run back to the left edge.
        const lines = frame.split("\n");
        const at = lines.findIndex(line => line.includes("You do not have permission"));
        expect(lines.slice(at, at + 3).join(" ").replace(/\s+/g, " "))
            .toContain("You do not have permission to view the authorized public keys for this account. Press A for administrative access.");
        for (const line of lines.slice(at, at + 3).filter(l => l.trim()))
            expect(line.startsWith("  ")).toBe(true);
        await r.press("n");
        // (The status line is cut to the 70 columns.)
        await r.waitFor("status: warning: Changing alice's keys needs administrative access");
    });

    it("counts closing sessions apart, so the numbers add up", async () => {
        const s = scenario();
        const manager = s.dbus!.system![LOGIN1]!["org.freedesktop.login1.Manager"]!;
        (manager.methods!.ListSessions!.reply as unknown[][])[0]!.push(["5", 1000, "mock", "", `${LOGIN1}/session/_35`]);
        s.dbus!.system![`${LOGIN1}/session/_35`] = session("5", "mock", "pts/4", "10.0.0.5", "closing");
        const r = await open(s);
        await r.waitFor("logged in");
        await r.press(keys.enter);
        const frame = await r.waitFor(f => f.includes("Sessions (2)") && /Last login\s+logged in now/.test(f));
        expect(frame).toMatch(/Last login\s+logged in now \(1 session, 1 closing\)/);
        await r.press(keys.right);
        expect(await r.waitFor("[Sessions (2)]")).toMatch(/5\s+pts\/4\s+sshd\s+10\.0\.0\.5\s+closing/);
    });

    it("shows the full name, and the whole GECOS field only when it holds more", async () => {
        const s = scenario();
        s.files!["/etc/passwd"] = withPasswd(PASSWD.replace("Alice Arbitrary:", "Alice Arbitrary,Room 4,555-0100,:"));
        const r = await open(s);
        await r.waitFor("logged in");
        await r.press(keys.enter);
        let frame = await r.waitFor(f => /Full name\s+Mock User/.test(f));
        expect(frame).not.toMatch(/GECOS/);
        await r.press(keys.escape, keys.down, keys.enter);
        // Only what the Full name row does not already show.
        frame = await r.waitFor(f => /GECOS \(rest\)\s+Room 4, 555-0100\s*$/m.test(f));
        expect(frame).toMatch(/Full name\s+Alice Arbitrary\s*$/m);
        expect(frame).not.toMatch(/GECOS.*Alice/);
    });

    it("shows a whole IPv4 address in the login history at 80 columns (a 65-column page)", async () => {
        const r = await open(scenario({}, {
            "last --time-format iso -n25 --fullnames mock": {
                stdout: "mock     pts/0        192.168.50.205   2026-10-02T17:12:02-06:00   still logged in\n" +
                    "mock     pts/1        192.168.50.205   2026-10-01T09:00:00-06:00 - 2026-10-01T09:30:00-06:00  (00:30)\n\n" +
                    "wtmp begins 2025-09-06T19:42:29-06:00\n",
            },
        }), { columns: 65 });
        await r.waitFor("logged in");
        await r.press(keys.enter);
        await r.waitFor("[Account]");
        await r.press(keys.right, keys.right, keys.right);
        const frame = await r.waitFor("[History]");
        expect(frame).toMatch(/2026-10-02 17:12 still logged in\s+192\.168\.50\.205/);
        expect(frame).toMatch(/2026-10-01 09:30\s+192\.168\.50\.205/);
    });

    it("opens hidden system accounts too, and survives an account that vanished", async () => {
        const r = await open(scenario());
        await r.waitFor("2 system hidden");
        await r.press("h", keys.down, keys.down, keys.enter);
        const frame = await r.waitFor("bin  bin · UID 1 · system account");
        expect(frame).toMatch(/Shell\s+\/sbin\/nologin \(cannot log in\)/);
    });
});

// ---- actions (administrative access on) ------------------------------------------------

const ADMIN = { superuser: true } as const;

/** The data the client sent a channel, frame by frame (an empty frame is ""). */
function frames(channel: unknown): string[] {
    return mock!.received().filter(entry => entry.channel === channel && entry.control === undefined)
        .map(entry => entry.data ?? "");
}

function stdinOf(argv0: string, index = 0): string {
    const [, options] = spawnedWith(argv0)[index]!;
    return mock!.sent(options.channel as string);
}

function withPasswd(lines: string): { content: string, mode: number, uid: number, gid: number } {
    return { content: lines, mode: 0o644, uid: 0, gid: 0 };
}

async function openAdmin(extraSpawn: MockScenario["spawn"] = {}, patterns: MockScenario["spawnPatterns"] = [], options = {}) {
    const r = await open(scenario({ ...ADMIN, spawnPatterns: patterns }, extraSpawn), { allowed: true, ...options });
    await r.waitFor(f => f.includes("locked") && f.includes("2026-09-20"));
    return r;
}

/** Select a row of the list by its user name. */
async function select(r: RenderedPage, name: string): Promise<void> {
    await r.press(keys.home);
    for (let i = 0; i < 8; i++) {
        if (r.lastFrame().split("\n").some(line => line.startsWith(`› ${name} `) || line === `› ${name}`))
            return;
        await r.press(keys.down);
    }
    throw new Error(`could not select ${name}:\n${r.lastFrame()}`);
}

describe("creating accounts", () => {
    const CAROL = "cexample:x:1003:1003:Carol Example:/home/cexample:/bin/bash\n";
    const created = [{
        match: "^useradd ",
        effects: [{ files: { "/etc/passwd": withPasswd(PASSWD + CAROL), "/etc/group": withPasswd(GROUP.replace("wheel:x:10:mock", "wheel:x:10:mock,cexample") + "cexample:x:1003:\n") } }],
    }];

    it("runs pwscore, useradd and chpasswd exactly as upstream, then selects the account", async () => {
        const r = await openAdmin({ "/usr/bin/pwscore": { readInput: true, stdout: "80\n" }, chpasswd: { readInput: true } }, created);
        await r.press("n");
        await r.waitFor("Create new account");
        await r.press("Carol Example");
        await r.waitFor(f => /User name\s+cexample/.test(f));
        await r.press(keys.down, keys.down, "s3cret-Pass!", keys.down, "s3cret-Pass!", keys.down, " ");
        await r.waitFor("[x]");
        await r.press(keys.enter);
        const frame = await r.waitFor("status: success: Created account cexample");
        await r.waitFor(f => f.includes("› cexample"));
        expect(frame).not.toContain("Create new account");

        const order = spawned().map(([argv]) => argv[0]).filter(a => ["/usr/bin/pwscore", "useradd", "chpasswd"].includes(a!));
        expect(order).toEqual(["/usr/bin/pwscore", "useradd", "chpasswd"]);
        expect(stdinOf("/usr/bin/pwscore")).toBe("s3cret-Pass!");
        expect(spawnedWith("/usr/bin/pwscore")[0]![1]).toMatchObject({ err: "message" });
        expect(spawnedWith("/usr/bin/pwscore")[0]![1].superuser).toBeUndefined();
        const [useradd, useraddOptions] = spawnedWith("useradd")[0]!;
        expect(useradd).toEqual(["useradd", "--create-home", "-c", "Carol Example", "-G", "wheel", "cexample"]);
        expect(useraddOptions).toMatchObject({ superuser: "require", err: "message" });
        expect(spawnedWith("chpasswd")[0]![1]).toMatchObject({ superuser: "require", err: "out" });
        expect(stdinOf("chpasswd")).toBe("cexample:s3cret-Pass!");
        expect(spawnedWith("usermod")).toEqual([]);
        expect(spawnedWith("passwd").filter(([argv]) => argv[1] === "-e")).toEqual([]);
    });

    it("validates against every account and group before running anything", async () => {
        const r = await openAdmin();
        await r.press("n");
        await r.waitFor("Create new account");
        await r.press(keys.down, "svc", keys.enter);
        await waitForDialog(r, "This user name already exists");
        await r.press(keys.ctrl("u"), "docker", keys.enter);
        await waitForDialog(r, "A group named docker already exists");
        await r.press(keys.ctrl("u"), "-x", keys.enter);
        await waitForDialog(r, "must not start with a dash");
        await r.press(keys.ctrl("u"), "carol", keys.down, "abc", keys.down, "abd", keys.enter);
        await waitForDialog(r, "The passwords do not match");
        await r.press(keys.up, keys.up, keys.ctrl("u"), keys.enter);
        await waitForDialog(r, "No user name specified");
        // A comma in the full name is allowed, but explained.
        await r.press(keys.up, "Smith, John");
        await waitForDialog(r, "The name ends at the first comma.");
        expect(spawnedWith("useradd")).toEqual([]);
        expect(spawnedWith("/usr/bin/pwscore")).toEqual([]);
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Create new account"));
    });

    it("lets a weak password through only on a second Enter", async () => {
        const r = await openAdmin({
            "/usr/bin/pwscore": { readInput: true, "exit-status": 1, stderr: "Password quality check failed:\n The password is shorter than 8 characters\n" },
            chpasswd: { readInput: true },
        }, created);
        await r.press("n");
        await r.waitFor("Create new account");
        await r.press("Carol Example", keys.down, keys.down, "abc", keys.down, "abc", keys.enter);
        await waitForDialog(r, "Password quality check failed: The password is shorter than 8 characters. Press Enter again to use it anyway.");
        expect(spawnedWith("useradd")).toEqual([]);
        await r.press(keys.enter);
        await r.waitFor("status: success: Created account cexample");
        expect(spawnedWith("/usr/bin/pwscore")).toHaveLength(1);
        expect(stdinOf("chpasswd")).toBe("cexample:abc");
    });

    it("says exactly what was left behind when a step after useradd fails", async () => {
        const r = await openAdmin({
            "/usr/bin/pwscore": { readInput: true, stdout: "80\n" },
            // err "out": the text is the output, which a plain await would lose.
            chpasswd: { readInput: true, "exit-status": 1, stdout: "chpasswd: (user cexample) pam_chauthtok() failed, error:\nAuthentication token manipulation error\n" },
        }, created);
        await r.press("n");
        await r.waitFor("Create new account");
        await r.press("Carol Example", keys.down, keys.down, "s3cret-Pass!", keys.down, "s3cret-Pass!", keys.enter);
        const text = await waitForDialog(r, "Account created with problems");
        expect(text).toContain("The account cexample was created, but setting the password failed: chpasswd: (user cexample) pam_chauthtok() failed, error: Authentication token manipulation error");
        expect(text).toContain("cexample has no usable password yet: open the account and set one (p).");
        await r.press(keys.enter);
        await r.waitFor(f => !f.includes("Account created with problems") && f.includes("› cexample"));
    });

    it("creates a locked account without a password: no chpasswd, no usermod", async () => {
        const r = await openAdmin({}, created);
        await r.press("n");
        await r.waitFor("Create new account");
        await r.press("Carol Example", keys.down, keys.down, keys.down, keys.down, keys.down, keys.down, " ");
        await waitForDialog(r, "optional: password login is off");
        await r.press(keys.enter);
        await r.waitFor("status: success: Created account cexample");
        expect(spawnedWith("useradd")[0]![0]).toEqual(["useradd", "--create-home", "-c", "Carol Example", "cexample"]);
        expect(spawnedWith("chpasswd")).toEqual([]);
        expect(spawnedWith("usermod")).toEqual([]);
        expect(spawnedWith("/usr/bin/pwscore")).toEqual([]);
    });

    it("locks or expires after setting the password, as asked", async () => {
        const r = await openAdmin({
            "/usr/bin/pwscore": { readInput: true, stdout: "80\n" }, chpasswd: { readInput: true },
            "passwd -e cexample": {}, "usermod cexample --lock": {},
        }, created);
        await r.press("n");
        await r.waitFor("Create new account");
        // "Must change password", then "Disallow password login": the second unticks the first.
        await r.press("Carol Example", keys.down, keys.down, "s3cret-Pass!", keys.down, "s3cret-Pass!", keys.down, keys.down, " ");
        await r.waitFor(f => /Must change password\s+\[x\]/.test(f));
        await r.press(keys.down, " ");
        await r.waitFor(f => /Must change password\s+\[ \]/.test(f) && /Disallow password login\s+\[x\]/.test(f));
        await r.press(keys.enter);
        await r.waitFor("status: success: Created account cexample");
        expect(spawnedWith("usermod")[0]).toEqual([["usermod", "cexample", "--lock"], expect.objectContaining({ superuser: "require", err: "message" })]);
        expect(spawnedWith("passwd").filter(([argv]) => argv[1] === "-e")).toEqual([]);
    });

    it("expires the password when it must be changed at first login", async () => {
        const r = await openAdmin({
            "/usr/bin/pwscore": { readInput: true, stdout: "80\n" }, chpasswd: { readInput: true }, "passwd -e cexample": {},
        }, created);
        await r.press("n");
        await r.waitFor("Create new account");
        await r.press("Carol Example", keys.down, keys.down, "s3cret-Pass!", keys.down, "s3cret-Pass!", keys.down, keys.down, " ", keys.enter);
        await r.waitFor("status: success: Created account cexample");
        const expire = spawnedWith("passwd").find(([argv]) => argv[1] === "-e")!;
        expect(expire[0]).toEqual(["passwd", "-e", "cexample"]);
        expect(expire[1]).toMatchObject({ superuser: "require", err: "message" });
        const order = spawned().map(([argv]) => argv[0]);
        expect(order.indexOf("chpasswd")).toBeLessThan(order.lastIndexOf("passwd"));
    });

    it("shows useradd's refusal in the dialog and keeps it open", async () => {
        const r = await openAdmin({ "/usr/bin/pwscore": { readInput: true, stdout: "80\n" } },
                                  [{ match: "^useradd ", "exit-status": 9, stderr: "useradd: user 'cexample' already exists\n" }]);
        await r.press("n");
        await r.waitFor("Create new account");
        await r.press("Carol Example", keys.down, keys.down, "s3cret-Pass!", keys.down, "s3cret-Pass!", keys.enter);
        await waitForDialog(r, "useradd: user 'cexample' already exists");
        expect(r.lastFrame()).toContain("Create new account");
        expect(spawnedWith("chpasswd")).toEqual([]);
    });
});

describe("changing accounts", () => {
    it("deletes an account, with its files when asked", async () => {
        const r = await openAdmin({ "/usr/sbin/userdel -r bob": { effects: [{ files: { "/etc/passwd": withPasswd(PASSWD.replace(/^bob:.*\n/m, "")) } }] } });
        await select(r, "bob");
        await r.press("D");
        let frame = await r.waitFor("Delete bob");
        expect(dialogText(frame)).toContain("The account bob, UID 1002, will be deleted. This cannot be undone.");
        await r.press(" ");
        await r.waitFor(f => /Delete files\s+\[x\]/.test(f));
        await r.press(keys.enter);
        frame = await r.waitFor("status: success: Deleted account bob");
        await r.waitFor(f => !/\bbob\b/.test(f.split("status:")[0]!));
        const [argv, options] = spawnedWith("/usr/sbin/userdel")[0]!;
        expect(argv).toEqual(["/usr/sbin/userdel", "-r", "bob"]);
        expect(options).toMatchObject({ superuser: "require", err: "message" });
    });

    it("still reports the deletion when /etc/passwd changes before userdel exits", async () => {
        // userdel -r rewrites /etc/passwd first and exits only after removing
        // the home directory. Here the passwd change lands (a delayed effect
        // of the page's first lastlog run) while userdel is still running.
        const gone = withPasswd(PASSWD.replace(/^bob:.*\n/m, ""));
        const r = await open(scenario({ ...ADMIN }, {
            // Wide margins: the dialog is up well before 2 s, userdel ends well after.
            "lastlog": { stdout: LASTLOG, effects: [{ files: { "/etc/passwd": gone }, delayMs: 2000 }] },
            "/usr/sbin/userdel -r bob": { chunks: [{ data: "", delayMs: 4000 }] },
        }), { allowed: true });
        await r.waitFor(f => f.includes("locked") && f.includes("2026-09-20"));
        await select(r, "bob");
        await r.press("D", " ", keys.enter);
        await r.waitFor("Deleting bob");
        // bob has left the list, userdel is still busy, and the dialog with it.
        let frame = await r.waitFor("3 accounts ·", 4000);
        expect(frame).toContain("Deleting bob");
        frame = await r.waitFor("status: success: Deleted account bob", 5000);
        expect(frame).not.toContain("Delete bob");
        expect(frame).not.toContain("not found");
    }, 15_000);

    it("refuses to delete root or yourself, and warns about a logged-in account", async () => {
        const r = await openAdmin();
        await select(r, "root");
        await r.press("D");
        await r.waitFor("status: warning: Delete: root cannot be deleted");
        await select(r, "mock");
        await r.press("D");
        await r.waitFor("status: warning: Delete: you cannot delete your own account");
        await select(r, "alice");
        await r.press("D");
        const frame = await r.waitFor("Delete alice");
        expect(dialogText(frame)).toContain("alice is logged in, and userdel refuses while their processes run");
        expect(dialogText(frame)).not.toContain("system account");
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Delete alice"));
        // A system account, listed on request: deletable, with a warning.
        await r.press("h");
        await r.waitFor("system accounts shown");
        await select(r, "svc");
        await r.press("D");
        expect(await waitForDialog(r, "Delete svc")).toContain("svc is a system account: packages and services may depend on it.");
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Delete svc"));
        expect(spawnedWith("/usr/sbin/userdel")).toEqual([]);
    });

    it("sets a password through chpasswd, and shows its error text inline", async () => {
        const r = await openAdmin({
            "/usr/bin/pwscore": { readInput: true, stdout: "80\n" },
            chpasswd: { readInput: true, "exit-status": 1, stdout: "chpasswd: line 1: user 'bob' does not exist\n" },
        });
        await select(r, "bob");
        await r.press("p");
        await r.waitFor("Set password for bob");
        await r.press("n3w-Secret", keys.down, "n3w-Secret", keys.enter);
        const text = await waitForDialog(r, "chpasswd: line 1: user 'bob' does not exist");
        expect(text).toContain("Set password for bob");
        expect(stdinOf("chpasswd")).toBe("bob:n3w-Secret");
        expect(spawnedWith("chpasswd")[0]![1]).toMatchObject({ superuser: "require", err: "out" });
    });

    it("sets a password", async () => {
        const r = await openAdmin({ "/usr/bin/pwscore": { readInput: true, stdout: "80\n" }, chpasswd: { readInput: true } });
        await select(r, "bob");
        await r.press("p");
        await r.waitFor("Set password for bob");
        await r.press("n3w-Secret", keys.down, "n3w-Secret", keys.enter);
        await r.waitFor("status: success: Password of bob changed");
        expect(stdinOf("chpasswd")).toBe("bob:n3w-Secret");
    });

    it("says up front that a new password unlocks a locked account", async () => {
        const r = await openAdmin({ "/usr/bin/pwscore": { readInput: true, stdout: "80\n" }, chpasswd: { readInput: true } });
        await select(r, "alice");
        await r.press("p");
        const text = await waitForDialog(r, "Set password for alice");
        expect(text).toContain("Password login is disallowed for alice (locked). A new password replaces the locked one, " +
            "which normally allows password login again.");
        await r.press(keys.escape);
        await select(r, "bob");
        await r.press("p");
        expect(await waitForDialog(r, "Set password for bob")).not.toContain("locked");
    });

    it("locks an account and checks the result with passwd -S", async () => {
        const r = await openAdmin({
            "/usr/sbin/usermod bob --lock": {},
            "passwd -S bob": { stdout: "bob LK 2026-10-02 0 99999 7 -1 (Password locked.)\n" },
        });
        await select(r, "bob");
        await r.press("l");
        const frame = await r.waitFor("Lock bob");
        expect(dialogText(frame)).toContain("other ways to log in, such as SSH keys, still work");
        await r.press(keys.enter);
        await r.waitFor("status: success: Locked bob");
        expect(spawnedWith("/usr/sbin/usermod")).toEqual([
            [["/usr/sbin/usermod", "bob", "--lock"], expect.objectContaining({ superuser: "require", err: "message" })],
        ]);
        const check = spawnedWith("passwd").find(([argv]) => argv[1] === "-S" && argv[2] === "bob")!;
        expect(check[1]).toMatchObject({ superuser: "require", environ: ["LC_ALL=C"] });
    });

    it("tries once more when the lock did not take, and says so if it still did not", async () => {
        const r = await openAdmin({
            "/usr/sbin/usermod bob --lock": {},
            "passwd -S bob": { stdout: "bob PS 2026-10-02 0 99999 7 -1 (Password set, SHA512 crypt.)\n" },
        });
        await select(r, "bob");
        await r.press("l");
        await r.waitFor("Lock bob");
        await r.press(keys.enter);
        await r.waitFor("status: warning: usermod succeeded, but passwd -S still reports bob as unlocked");
        expect(spawnedWith("/usr/sbin/usermod")).toHaveLength(2);
    });

    it("unlocks, and explains a refused unlock of an account without a password", async () => {
        const r = await openAdmin({
            "/usr/sbin/usermod alice --unlock": {
                "exit-status": 1,
                stderr: "usermod: unlocking the user's password would result in a passwordless account.\n" +
                    "You should set a password with usermod -p to unlock this user's password.\n",
            },
        });
        await select(r, "alice");
        await r.press("l");
        await r.waitFor("Unlock alice");
        await r.press(keys.enter);
        const text = await waitForDialog(r, "Set a password instead (p)");
        expect(text).toContain("usermod: unlocking the user's password would result in a passwordless account. " +
            "You should set a password with usermod -p to unlock this user's password. Set a password instead (p)");
        expect(text).toContain("Unlock alice");
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Unlock alice"));
    });

    it("forces a password change", async () => {
        const r = await openAdmin({ "passwd -e bob": {} });
        await select(r, "bob");
        await r.press("f");
        await r.waitFor("Force password change");
        await r.press(keys.enter);
        await r.waitFor("status: success: bob must change the password at the next login");
        expect(spawnedWith("passwd").find(([argv]) => argv[1] === "-e")).toEqual(
            [["passwd", "-e", "bob"], expect.objectContaining({ superuser: "require", err: "message" })]);
    });

    it("grants and removes the administrator role through the admin group", async () => {
        const r = await openAdmin({ "gpasswd -a bob wheel": {}, "gpasswd -d mock wheel": {} });
        await select(r, "bob");
        await r.press("r");
        let frame = await r.waitFor("Make administrator");
        expect(dialogText(frame)).toContain("Add bob to the wheel group, which grants administrative access (sudo)?");
        await r.press(keys.enter);
        await r.waitFor("status: success: bob is now an administrator");
        await select(r, "mock");
        await r.press("r");
        frame = await r.waitFor("Remove administrator role");
        expect(dialogText(frame)).toContain("This is your own account");
        await r.press(keys.enter);
        await r.waitFor("status: success: mock is no longer an administrator");
        expect(spawnedWith("gpasswd").map(([argv, options]) => [argv, options.superuser, options.err])).toEqual([
            [["gpasswd", "-a", "bob", "wheel"], "require", "message"],
            [["gpasswd", "-d", "mock", "wheel"], "require", "message"],
        ]);
    });

    it("edits supplementary groups: marks first, applies together", async () => {
        const r = await openAdmin({ "gpasswd -a bob docker": {}, "gpasswd -a bob libvirt": {} });
        await select(r, "bob");
        await r.press("g");
        await r.waitFor("Groups of bob");
        await r.press("bo", " ");
        await waitForDialog(r, "bob is the primary group of bob and cannot be removed here.");
        await r.press(keys.escape, "doc", " ");
        await r.waitFor(f => /\[x\] docker\s+will add/.test(f));
        await r.press(keys.escape, "libv", " ");
        let frame = await r.waitFor("Will add to docker, libvirt.");
        expect(spawnedWith("gpasswd")).toEqual([]);
        // The first Enter only says what the second will do.
        await r.press(keys.enter);
        await waitForDialog(r, "Press Enter again to apply, or Esc to cancel.");
        expect(spawnedWith("gpasswd")).toEqual([]);
        await r.press(keys.enter);
        frame = await r.waitFor("status: success: Groups of bob changed: +docker +libvirt");
        expect(frame).not.toContain("Groups of bob\n");
        expect(spawnedWith("gpasswd").map(([argv]) => argv)).toEqual([["gpasswd", "-a", "bob", "docker"], ["gpasswd", "-a", "bob", "libvirt"]]);
    });

    it("stops at a failed group change and keeps the rest pending", async () => {
        const r = await openAdmin({ "gpasswd -d alice libvirt": { "exit-status": 3, stderr: "gpasswd: cannot lock /etc/group; try again later.\n" } });
        await select(r, "alice");
        await r.press("g");
        await r.waitFor("Groups of alice");
        await r.press("libv", " ");
        await r.waitFor("Will remove from libvirt.");
        await r.press(keys.enter);
        await waitForDialog(r, "Press Enter again to apply");
        await r.press(keys.enter);
        const text = await waitForDialog(r, "Removing from libvirt failed: gpasswd: cannot lock /etc/group; try again later.");
        expect(text).toContain("Will remove from libvirt.");
    });
});

describe("SSH keys", () => {
    /** The adder script's run: the spawn whose argv carries it. */
    function adderRun(): [string[], JsonObject] {
        return spawned().find(([argv]) => argv.some(arg => arg.includes("cat >> authorized_keys")))!;
    }

    it("adds a key to another account through the lister and the adder, run as that account", async () => {
        const r = await openAdmin({}, [{ match: "set -euf", effects: [] }]);
        await select(r, "bob");
        await r.press(keys.enter, keys.right, keys.right);
        await r.waitFor("There are no authorized public keys for this account.");
        await r.press("n");
        await r.waitFor("Add SSH key for bob");
        await r.press(ED25519, keys.enter);
        await r.waitFor("status: success: Added key mock@laptop for bob");
        const lister = spawnedWith("/bin/sh").find(([argv]) => argv[2]!.includes("ssh-keygen -l"))!;
        expect(mock!.sent(lister[1].channel as string)).toBe(`${ED25519}\n`);
        /*
         * Not root in bob's home: bob owns it, and a symlink planted there
         * (~/.ssh -> /root/.ssh) would make root chown and append to the
         * link's target. runuser drops to bob first, so nothing is chowned.
         */
        const [argv, options] = adderRun();
        expect(argv.slice(0, 6)).toEqual(["runuser", "-u", "bob", "--", "/bin/sh", "-c"]);
        expect(argv.slice(7)).toEqual(["--", "/home/bob"]);
        expect(argv[6]).not.toContain("chown");
        expect(argv[6]).toContain("umask 077");
        expect(options).toMatchObject({ superuser: "require", err: "message" });
        expect(mock!.sent(options.channel as string)).toBe(`${ED25519}\n`);
    });

    it("adds a key to your own account as yourself, without administrative access", async () => {
        const r = await open(scenario({ spawnPatterns: [{ match: "set -euf" }] }));
        await r.waitFor("logged in");
        await r.press(keys.enter, keys.right, keys.right);
        await r.waitFor("mockFingerprint");
        await r.press("n");
        await r.waitFor("Add SSH key for mock");
        await r.press(ED25519, keys.enter);
        await r.waitFor("status: success: Added key mock@laptop for mock");
        const [argv, options] = adderRun();
        expect([argv[0], argv[1], ...argv.slice(3)]).toEqual(["/bin/sh", "-c", "--", "/home/mock"]);
        expect(options.superuser).toBeUndefined();
    });

    it("does not add a key for an account without a home directory", async () => {
        const s = scenario({ ...ADMIN });
        s.files!["/etc/passwd"] = withPasswd(PASSWD.replace("bob:x:1002:1002::/home/bob:/bin/zsh", "bob:x:1002:1002:::/bin/zsh"));
        const r = await open(s, { allowed: true });
        await r.waitFor(f => f.includes("locked") && f.includes("2026-09-20"));
        await select(r, "bob");
        await r.press(keys.enter, keys.right, keys.right);
        await r.waitFor("This account has no home directory.");
        await r.press("n");
        await r.waitFor("status: warning: bob has no home directory to keep SSH keys in");
        expect(r.lastFrame()).not.toContain("Add SSH key");
        expect(spawned().filter(([argv]) => argv.some(arg => arg.includes("authorized_keys")))).toEqual([]);
    });

    it("refuses pasted text with two keys before running anything", async () => {
        const r = await openAdmin();
        await select(r, "bob");
        await r.press(keys.enter, keys.right, keys.right);
        await r.waitFor("There are no authorized public keys");
        await r.press("n");
        await r.waitFor("Add SSH key for bob");
        await r.press(`${ED25519} ${RSA}`, keys.enter);
        await waitForDialog(r, "Only one key at a time");
        expect(spawnedWith("/bin/sh")).toEqual([]);
    });

    it("reports a key ssh-keygen does not accept", async () => {
        const r = await openAdmin({}, [{ match: "ssh-keygen -l -f authorized_keys", stdout: "\nssh-ed25519 AAAAbroken\n" }]);
        await select(r, "bob");
        await r.press(keys.enter, keys.right, keys.right);
        await r.waitFor("There are no authorized public keys");
        await r.press("n", "ssh-ed25519 AAAAbroken", keys.enter);
        await waitForDialog(r, "The key you provided was not valid.");
        expect(spawnedWith("/bin/sh").filter(([argv]) => argv[2]!.includes("cat >>"))).toEqual([]);
    });

    it("removes a key by rewriting the file with its tag, keeping the other lines", async () => {
        const s = scenario({}, {});
        s.files!["/home/mock/.ssh/authorized_keys"] = `# laptop\n${ED25519}\n${RSA}\n`;
        s.spawnPatterns!.unshift({
            match: "ssh-keygen -l -f authorized_keys",
            stdout: `256 SHA256:mockFingerprint mock@laptop (ED25519)\n${ED25519}\n2048 SHA256:rsaPrint alice@desk (RSA)\n${RSA}\n`,
        });
        const r = await open(s);
        await r.waitFor("logged in");
        await r.press(keys.enter, keys.right, keys.right);
        await r.waitFor("rsaPrint");
        await r.press(keys.down, "x");
        const frame = await r.waitFor("Remove SSH key");
        expect(dialogText(frame)).toContain('Remove the key "alice@desk" (SHA256:rsaPrint) from /home/mock/.ssh/authorized_keys?');
        expect(frame).not.toContain("last usable key");
        await r.press(keys.enter);
        await r.waitFor("status: success: Removed key alice@desk for mock");
        const write = mock!.opened("fsreplace1").find(o => o.path === "/home/mock/.ssh/authorized_keys")!;
        expect(write.superuser).toBe("try");
        expect(write.tag).toMatch(/^1:/);
        expect(frames(write.channel)).toEqual([`# laptop\n${ED25519}\n`]);
    });

    it("does not rewrite a key file that is a symbolic link elsewhere", async () => {
        const s = scenario({ ...ADMIN }, {
            // alice made ~/.ssh a link to root's.
            "realpath -e -- /home/alice /home/alice/.ssh/authorized_keys": { stdout: "/home/alice\n/root/.ssh/authorized_keys\n" },
        });
        const r = await open(s, { allowed: true });
        await r.waitFor(f => f.includes("locked") && f.includes("2026-09-20"));
        await select(r, "alice");
        await r.press(keys.enter, keys.right, keys.right);
        await r.waitFor("/home/alice/.ssh/authorized_keys");
        await r.press("x");
        await r.waitFor("Remove SSH key");
        await r.press(keys.enter);
        await waitForDialog(r, "/home/alice/.ssh/authorized_keys is a symbolic link (to /root/.ssh/authorized_keys), or is in one: not changed.");
        expect(spawnedWith("realpath")[0]![1]).toMatchObject({ superuser: "try" });
        expect(mock!.opened("fsreplace1")).toEqual([]);
    });

    it("removes a key whose line has spaces around it, which the lister reads trimmed", async () => {
        const s = scenario();
        s.files!["/home/mock/.ssh/authorized_keys"] = `\t${ED25519}  \n${RSA}\n`;
        s.spawnPatterns!.unshift({
            match: "ssh-keygen -l -f authorized_keys",
            // The real lister's `while read -r line` drops the spaces and the tab.
            stdout: `256 SHA256:mockFingerprint mock@laptop (ED25519)\n${ED25519}\n2048 SHA256:rsaPrint alice@desk (RSA)\n${RSA}\n`,
        });
        const r = await open(s);
        await r.waitFor("logged in");
        await r.press(keys.enter, keys.right, keys.right);
        await r.waitFor("rsaPrint");
        await r.press("x");
        await waitForDialog(r, 'Remove the key "mock@laptop"');
        await r.press(keys.enter);
        await r.waitFor("status: success: Removed key mock@laptop for mock");
        const write = mock!.opened("fsreplace1").find(o => o.path === "/home/mock/.ssh/authorized_keys")!;
        expect(frames(write.channel)).toEqual([`${RSA}\n`]);
    });

    it("leaves an empty file when the last key goes, and says so first", async () => {
        const r = await open(scenario());
        await r.waitFor("logged in");
        await r.press(keys.enter, keys.right, keys.right);
        await r.waitFor("mockFingerprint");
        await r.press("x");
        const frame = await r.waitFor("Remove SSH key");
        expect(dialogText(frame)).toContain("It is the last usable key: mock can no longer log in with an SSH key. The file itself is kept.");
        await r.press(keys.enter);
        await r.waitFor("status: success: Removed key mock@laptop for mock");
        const write = mock!.opened("fsreplace1").find(o => o.path === "/home/mock/.ssh/authorized_keys")!;
        // One empty frame: "write an empty file", not "delete" (no frame).
        expect(frames(write.channel)).toEqual([""]);
    });
});

describe("groups", () => {
    /** The rows of the groups table: the first word of each line below its header. */
    function groupRows(frame: string): string[] {
        const lines = frame.split("\n");
        const header = lines.findIndex(line => /^\s+Group\s+GID/.test(line));
        return lines.slice(header + 1).map(line => line.slice(2).trim().split(/\s+/)[0] ?? "").filter(Boolean)
            .filter(word => !word.startsWith("status:"));
    }

    async function toGroups(r: RenderedPage): Promise<string> {
        await r.press(keys.right);
        return r.waitFor("[Groups]");
    }

    it("lists every group with its kind, users and members; ← → switch tabs", async () => {
        const r = await open(scenario());
        await r.waitFor("2 system hidden");
        expect(r.lastFrame()).toContain("[Accounts]  Groups");
        const frame = await toGroups(r);
        expect(frame).toContain("8 groups · by kind · 3 user-created");
        // Administrator groups, then the user-created ones, then the system's.
        expect(groupRows(frame)).toEqual(["wheel", "alice", "bob", "mock", "docker", "libvirt", "root", "users"]);
        expect(frame).toMatch(/wheel\s+10 admin\s+1 mock/);
        expect(frame).toMatch(/alice\s+1001 user\s+1 alice/);
        expect(frame).toMatch(/docker\s+982 system\s+0/);
        // The root group: root's primary group, not an administrator group.
        expect(frame).toMatch(/root\s+0 system\s+1 root/);
        await r.press("s");
        expect(groupRows(await r.waitFor("by name"))).toEqual(["alice", "bob", "docker", "libvirt", "mock", "root", "users", "wheel"]);
        await r.press("/", "lib", keys.enter);
        await r.waitFor("1 of 8 groups");
        await r.press(keys.enter);
        const info = await waitForDialog(r, "Group libvirt");
        expect(info).toContain("Group ID 981");
        expect(info).toMatch(/Members\s+alice/);
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Group libvirt"));
        await r.press(keys.left);
        await r.waitFor(f => f.includes("[Accounts]") && f.includes("4 accounts"));
    });

    it("says a group is nobody's primary group as 'none', and counts the members it cannot show", async () => {
        const many = Array.from({ length: 120 }, (_, i) => `member${String(i).padStart(3, "0")}`);
        const s = scenario();
        s.files!["/etc/group"] = withPasswd(GROUP + `bigteam:x:1100:${many.join(",")}\n`);
        const r = await open(s, { columns: 80, rows: 24 });
        await r.waitFor("2 system hidden");
        await toGroups(r);
        await r.press("/", "bigteam", keys.enter, keys.enter);
        const text = await waitForDialog(r, "Group bigteam");
        expect(text).toMatch(/Primary group of none/);
        expect(text).not.toContain("nobody");
        const shown = text.match(/member\d{3}/g) ?? [];
        expect(shown.length).toBeGreaterThan(10);
        expect(text).toContain(`${shown.at(-1)}, … and ${120 - shown.length} more`);
    });

    it("explains instead of acting without access, and for system groups", async () => {
        const r = await open(scenario());
        await r.waitFor("2 system hidden");
        await toGroups(r);
        await r.press("n");
        await r.waitFor("status: warning: Creating groups needs administrative access (press A)");
        await r.press("/", "docker", keys.enter, "D");
        await r.waitFor("status: warning: Delete: docker is a system group (GID 982, outside 1000-60000)");
        expect(spawnedWith("groupdel")).toEqual([]);
    });

    it("creates a group with groupadd, offering the next free GID", async () => {
        const r = await openAdmin({
            "groupadd devs -g 1003": { effects: [{ files: { "/etc/group": withPasswd(GROUP + "devs:x:1003:\n") } }] },
        });
        await toGroups(r);
        await r.press("n");
        const text = await waitForDialog(r, "Create new group");
        expect(text).toMatch(/Group ID 1003/);
        await r.press("devs", keys.enter);
        await waitForDialog(r, "Press Enter again to create devs (GID 1003).");
        expect(spawnedWith("groupadd")).toEqual([]);
        await r.press(keys.enter);
        const frame = await r.waitFor("status: success: Created group devs");
        await r.waitFor(f => /› devs\s+1003 user/.test(f));
        expect(frame).not.toContain("Create new group");
        const [argv, options] = spawnedWith("groupadd")[0]!;
        expect(argv).toEqual(["groupadd", "devs", "-g", "1003"]);
        expect(options).toMatchObject({ superuser: "require", err: "message" });
    });

    it("checks the name and GID first, and lets groupadd choose without a GID", async () => {
        const r = await openAdmin({}, [{ match: "^groupadd ", "exit-status": 9, stderr: "groupadd: group 'devs' already exists\n" }]);
        await toGroups(r);
        await r.press("n");
        await r.waitFor("Create new group");
        await r.press("wheel", keys.enter);
        await waitForDialog(r, "This group name already exists");
        await r.press(keys.ctrl("u"), "devs", keys.down, keys.ctrl("u"), "10", keys.enter);
        await waitForDialog(r, "The group ID 10 is already used by wheel.");
        expect(spawnedWith("groupadd")).toEqual([]);
        await r.press(keys.ctrl("u"), keys.enter);
        await waitForDialog(r, "Press Enter again to create devs.");
        expect(spawnedWith("groupadd")).toEqual([]);
        await r.press(keys.enter);
        // groupadd's own refusal shows in the dialog, which stays open.
        await waitForDialog(r, "groupadd: group 'devs' already exists");
        expect(spawnedWith("groupadd")[0]![0]).toEqual(["groupadd", "devs"]);
    });

    it("renames a user-created group with groupmod, and selects it", async () => {
        const r = await openAdmin({
            "groupmod bob --new-name builders": {
                effects: [{ files: { "/etc/group": withPasswd(GROUP.replace("bob:x:1002:", "builders:x:1002:")) } }],
            },
        });
        await toGroups(r);
        await r.press("/", "bob", keys.enter, "R");
        const text = await waitForDialog(r, "Rename group bob");
        expect(text).toContain("Renaming a group may affect sudo rules");
        await r.press(keys.enter);
        await waitForDialog(r, "Type the new name.");
        await r.press(keys.ctrl("u"), "builders", keys.enter);
        await waitForDialog(r, "Press Enter again to rename bob to builders.");
        expect(spawnedWith("groupmod")).toEqual([]);
        await r.press(keys.enter);
        await r.waitFor("status: success: Renamed group bob to builders");
        await r.waitFor(f => /› builders\s+1002 user\s+1 bob/.test(f));
        const [argv, options] = spawnedWith("groupmod")[0]!;
        expect(argv).toEqual(["groupmod", "bob", "--new-name", "builders"]);
        expect(options).toMatchObject({ superuser: "require", err: "message" });
    });

    it("deletes a group, and forces it (saying so) for someone's primary group", async () => {
        const s = scenario({ ...ADMIN }, { "groupdel projects": {}, "groupdel -f alice": {} });
        s.files!["/etc/group"] = withPasswd(GROUP + "projects:x:1050:alice,bob\n");
        const r = await open(s, { allowed: true });
        await r.waitFor(f => f.includes("locked") && f.includes("2026-09-20"));
        await toGroups(r);
        await r.press("/", "projects", keys.enter, "D");
        let text = await waitForDialog(r, "Delete group projects");
        expect(text).toContain("Delete the group projects (GID 1050)? Its members lose it: alice, bob.");
        expect(text).toContain("< Delete >");
        await r.press(keys.enter);
        await r.waitFor("status: success: Deleted group projects");
        await r.press("/", keys.ctrl("u"), "alice", keys.enter, "D");
        text = await waitForDialog(r, "Delete group alice");
        expect(text).toContain("alice (GID 1001) is the primary group of alice. Deleting it anyway (groupdel -f)");
        expect(text).toContain("< Force delete >");
        await r.press(keys.enter);
        await r.waitFor("status: success: Deleted group alice");
        expect(spawnedWith("groupdel").map(([argv, options]) => [argv, options.superuser, options.err])).toEqual([
            [["groupdel", "projects"], "require", "message"],
            [["groupdel", "-f", "alice"], "require", "message"],
        ]);
    });
});

describe("small terminals", () => {
    it("fits the list and the details into 50x10", async () => {
        const r = await open(scenario(), { columns: 50, rows: 11 });
        let frame = await r.waitFor("logged in");
        const lines = frame.split("\n");
        expect(lines.length).toBeLessThanOrEqual(11);
        for (const line of lines)
            expect(line.length).toBeLessThanOrEqual(50);
        expect(listed(frame)).toEqual(["mock", "alice", "bob", "root"]);
        await r.press(keys.enter);
        frame = await r.waitFor("[Account]");
        for (const line of frame.split("\n"))
            expect(line.length).toBeLessThanOrEqual(50);
        expect(frame.split("\n").length).toBeLessThanOrEqual(11);
        await r.press(keys.escape, keys.right);
        frame = await r.waitFor(f => f.includes("[Groups]") && /alice\s+1001/.test(f));
        for (const line of frame.split("\n"))
            expect(line.length).toBeLessThanOrEqual(50);
        expect(frame.split("\n").length).toBeLessThanOrEqual(11);
    });
});

// ---- review fixes ---------------------------------------------------------------------

/** The lines inside the dialog box on screen, trimmed (the title is the first). */
function boxLines(frame: string): string[] {
    return frame.split("\n").flatMap(line => {
        // The title is set into the top border: "┌───┤ Title ├───┐".
        const title = /┤ (.*) ├/.exec(line);
        if (title)
            return [title[1]!];
        const first = line.indexOf("│");
        const last = line.lastIndexOf("│");
        return first >= 0 && last > first ? [line.slice(first + 1, last).trim()] : [];
    });
}

describe("keys typed ahead", () => {
    /*
     * The list's action keys are plain letters. Someone who types a name
     * without "/" first opens a dialog with its first letter, and the Enter
     * that ends the word must not confirm what they never saw.
     */
    it("does not let the Enter after a typed word confirm the dialog its first letter opened", async () => {
        const r = await openAdmin({
            "/usr/sbin/userdel bob": {}, "passwd -e bob": {}, "gpasswd -a bob wheel": {}, "loginctl terminate-user alice": {},
        });
        await select(r, "bob");
        // One read ("Dave" pasted or typed faster than it is read), key by key, and "carol" whose third letter acts.
        for (const [typing, title] of [[["Dave"], "Delete bob"], [["f", "r", "e", "d"], "Force password change"],
                                       [["carol"], "Make administrator"]] as const) {
            await r.press(...typing, keys.enter);
            const text = await waitForDialog(r, "Press Enter again");
            expect(text).toContain(title);
            await r.press(keys.escape);
            await r.waitFor(f => !dialogText(f).includes(title));
        }
        await select(r, "alice");
        await r.press("tom", keys.enter);
        expect(await waitForDialog(r, "Press Enter again")).toContain("Terminate sessions of alice");
        const acted = () => spawned().filter(([argv]) => ["/usr/sbin/userdel", "gpasswd", "loginctl"].includes(argv[0]!) ||
                                                        (argv[0] === "passwd" && argv[1] === "-e"));
        expect(acted()).toEqual([]);
        // Seen now: the next Enter is a decision.
        await r.press(keys.enter);
        await r.waitFor("status: success: Terminated the sessions of alice");
        expect(acted().map(([argv]) => argv)).toEqual([["loginctl", "terminate-user", "alice"]]);
    });

    it("lets the delete dialog's Space toggle only once nothing was typed ahead", async () => {
        const r = await openAdmin({ "/usr/sbin/userdel -r bob": {} });
        await select(r, "bob");
        await r.press("Dave Smith", keys.enter);
        await waitForDialog(r, "Press Enter again");
        // The space inside the typed name did not tick "Delete files".
        expect(r.lastFrame()).toMatch(/Delete files\s+\[ \]/);
        await r.press(" ");
        await r.waitFor(f => /Delete files\s+\[x\]/.test(f));
        await r.press(keys.enter);
        await r.waitFor("status: success: Deleted account bob");
        expect(spawnedWith("/usr/sbin/userdel").map(([argv]) => argv)).toEqual([["/usr/sbin/userdel", "-r", "bob"]]);
    });

    it("does not rename or create a group from a word typed on the Groups tab", async () => {
        const r = await openAdmin({ "groupmod bob --new-name bobust": {}, "groupadd ginx -g 1003": {} });
        await r.press(keys.right);
        await r.waitFor("[Groups]");
        await r.press("/", "bob", keys.enter);
        await r.waitFor("1 of 8 groups");
        // "R" opens Rename with "bob" in the field, "ust" goes after it, and the Enter only asks.
        await r.press("Rust", keys.enter);
        expect(await waitForDialog(r, "Press Enter again to rename bob to bobust.")).toContain("Rename group bob");
        // An edit takes the question back.
        await r.press(keys.backspace, "t", keys.enter);
        await waitForDialog(r, "Press Enter again to rename bob to bobust.");
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Rename group bob"));
        await r.press(keys.escape);
        await r.waitFor("8 groups");
        await r.press("nginx", keys.enter);
        expect(await waitForDialog(r, "Press Enter again to create ginx (GID 1003).")).toContain("Create new group");
        expect(spawned().filter(([argv]) => argv[0] === "groupmod" || argv[0] === "groupadd")).toEqual([]);
    });

    it("does not apply group changes typed ahead, and warns before you leave an administrator group", async () => {
        const r = await openAdmin({ "gpasswd -d mock wheel": {} });
        await select(r, "mock");
        // g opens the editor, w filters to wheel, the space unticks it, and the Enter only asks.
        await r.press("gw ", keys.enter);
        const text = await waitForDialog(r, "Press Enter again to apply");
        expect(text).toContain("Will remove from wheel.");
        expect(text).toContain("This removes your own account from wheel: you may no longer be able to get administrative access.");
        expect(spawnedWith("gpasswd")).toEqual([]);
        // Any other key takes the question back.
        await r.press(keys.down);
        await r.waitFor(f => !dialogText(f).includes("Press Enter again"));
        expect(spawnedWith("gpasswd")).toEqual([]);
        await r.press(keys.enter);
        await waitForDialog(r, "Press Enter again to apply");
        await r.press(keys.enter);
        await r.waitFor("status: success: Groups of mock changed: -wheel");
        expect(spawnedWith("gpasswd").map(([argv]) => argv)).toEqual([["gpasswd", "-d", "mock", "wheel"]]);
    });

    it("runs a confirmed action once, however often Enter is pressed", async () => {
        const r = await openAdmin({
            "passwd -e bob": { chunks: [{ data: "", delayMs: 500 }] },
            "/usr/sbin/userdel bob": { chunks: [{ data: "", delayMs: 500 }] },
        });
        await select(r, "bob");
        await r.press("f");
        await r.waitFor("Force password change");
        await r.press(keys.enter, keys.enter, keys.enter);
        await r.waitFor("status: success: bob must change the password at the next login");
        expect(spawned().filter(([argv]) => argv[0] === "passwd" && argv[1] === "-e")).toHaveLength(1);
        await r.press("D");
        await r.waitFor("Delete bob");
        await r.press(keys.enter, keys.enter, keys.enter);
        await r.waitFor("status: success: Deleted account bob");
        expect(spawnedWith("/usr/sbin/userdel")).toHaveLength(1);
    });
});

describe("lingering users", () => {
    /** bob: Linger=yes and no session, so logind lists him as "lingering". */
    function lingeringBob(extraSpawn: MockScenario["spawn"] = {}): MockScenario {
        const s = scenario({ ...ADMIN }, extraSpawn);
        const manager = s.dbus!.system![LOGIN1]!["org.freedesktop.login1.Manager"]!;
        (manager.methods!.ListUsers!.reply as unknown[][])[0]!.push([1002, "bob", `${LOGIN1}/user/_1002`]);
        s.dbus!.system![`${LOGIN1}/user/_1002`] = { "org.freedesktop.login1.User": { properties: { State: "lingering" } } };
        return s;
    }

    it("offers to end a lingering user's processes, and says that userdel refuses while they run", async () => {
        const r = await open(lingeringBob({ "loginctl terminate-user bob": {} }), { allowed: true });
        const frame = await r.waitFor(f => f.includes("locked") && f.includes("2026-09-20"));
        // Not logged in (no session): the list shows when he last was.
        expect(frame).toMatch(/bob\s+1002\s+2026-09-20/);
        await select(r, "bob");
        await r.press("D");
        let text = await waitForDialog(r, "Delete bob");
        expect(text).toContain("bob's user services are running (lingering), and userdel refuses while any of their processes run");
        await r.press(keys.escape);
        await r.waitFor(f => !dialogText(f).includes("Delete bob"));
        await r.press("t");
        text = await waitForDialog(r, "End the processes of bob");
        expect(text).toContain("bob is not logged in, but linger is enabled");
        await r.press(keys.enter);
        await r.waitFor("status: success: Ended the processes of bob");
        expect(spawnedWith("loginctl")).toEqual([
            [["loginctl", "terminate-user", "bob"], expect.objectContaining({ superuser: "try", err: "message" })],
        ]);
    });
});

describe("live sessions", () => {
    it("keeps the sessions on screen while it re-reads them after a logind signal", async () => {
        const s = scenario({}, {
            "last --time-format iso -n25 --fullnames mock": {
                stdout: "mock     pts/0        10.0.0.5         2026-10-02T17:12:02-06:00   still logged in\n",
                // A logind signal, well after the Sessions tab has shown.
                effects: [{ signal: [LOGIN1, "org.freedesktop.login1.Manager", "SessionRemoved", ["9", `${LOGIN1}/session/_39`]], delayMs: 1500 }],
            },
        });
        (s.dbus!.system![LOGIN1]!["org.freedesktop.login1.Manager"]!.methods!.ListSessions as JsonObject).delayMs = 300;
        const r = await open(s);
        await r.waitFor("logged in");
        await r.press(keys.enter, keys.right);
        await r.waitFor(f => f.includes("[Sessions (1)]") && f.includes("pts/0"));
        const count = (...parts: string[]) => mock!.received().filter(e => parts.every(p => e.data?.includes(p))).length;
        // The signal: ListSessions again, then this session's properties again.
        await r.waitFor(() => count('"ListSessions"') >= 2, 5000);
        const seen: string[] = [];
        const deadline = Date.now() + 4000;
        while (count('"GetAll"', "/session/_33") < 2) {
            seen.push(r.lastFrame());
            if (Date.now() > deadline)
                throw new Error("the sessions were not read again");
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        seen.push(await r.waitFor("[Sessions (1)]"));
        expect(seen.filter(f => f.includes("Loading sessions"))).toEqual([]);
        expect(seen.every(f => f.includes("[Sessions (1)]") && f.includes("pts/0"))).toBe(true);
    }, 15_000);
});

describe("dialogs on a small screen", () => {
    it("keeps the groups editor's rows in order at 64x18, with a failure readable", async () => {
        const r = await openAdmin(
            { "gpasswd -a alice docker": { "exit-status": 3, stderr: "gpasswd: cannot lock /etc/group; try again later.\n" } },
            [], { columns: 64, rows: 19 });
        await select(r, "alice");
        await r.press("g");
        await r.waitFor("Groups of alice");
        // alice, bob, docker, ...: mark docker and apply; gpasswd fails.
        await r.press(keys.down, keys.down, " ");
        await r.waitFor("Will add to docker");
        await r.press(keys.enter);
        await waitForDialog(r, "Press Enter again to apply");
        await r.press(keys.enter);
        const frame = await r.waitFor("try again later");
        const lines = boxLines(frame);
        expect(lines.some(line => /\[=\] alice\s+primary group/.test(line))).toBe(true);
        expect(lines.some(line => /\[ \] bob\s+primary group/.test(line))).toBe(false);
        expect(lines.some(line => /› \[x\] docker\s+will add/.test(line))).toBe(true);
        const text = dialogText(frame);
        expect(text).toContain("Adding to docker failed: gpasswd: cannot lock /etc/group; try again later.");
        expect(text).toContain("Will add to docker.");
        expect(text).toContain("alice must log out and back in");
    });

    it("shows the cursor's row in the groups editor at 50x10", async () => {
        const r = await openAdmin({}, [], { columns: 50, rows: 11 });
        await select(r, "bob");
        await r.press("g");
        await r.waitFor("Groups of bob");
        expect(boxLines(r.lastFrame()).some(line => /^› \[ \] alice/.test(line))).toBe(true);
        await r.press(" ");
        const frame = await r.waitFor("Will add to alice.");
        expect(boxLines(frame).some(line => /^› \[x\] alice\s+will add/.test(line))).toBe(true);
    });

    it("keeps the delete dialog's text and buttons apart at 50x10", async () => {
        const r = await openAdmin({}, [], { columns: 50, rows: 11 });
        await select(r, "bob");
        await r.press("D");
        const frame = await r.waitFor("Delete bob");
        const lines = boxLines(frame);
        expect(lines.some(line => line.startsWith("The account bob, UID 1002, will be deleted."))).toBe(true);
        expect(lines.some(line => /Delete files\s+\[ \]/.test(line))).toBe(true);
        expect(lines.some(line => line.startsWith("< Delete >"))).toBe(true);
        expect(dialogText(frame)).not.toContain("undone.002");
    });

    it("says the create form does not fit at 50x10 instead of squeezing its rows together", async () => {
        const r = await openAdmin({}, [], { columns: 50, rows: 11 });
        await r.press("n");
        const text = await waitForDialog(r, "Enlarge the terminal, or press Esc.");
        expect(text).toContain("Create new account");
        expect(text).not.toContain("Password");
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Create new account"));
        expect(spawned().filter(([argv]) => argv[0] === "useradd" || argv[0] === "/usr/sbin/useradd")).toEqual([]);
    });

    it("keeps the password fields and buttons of a locked account's dialog at 50x10", async () => {
        const r = await openAdmin({}, [], { columns: 50, rows: 11 });
        await select(r, "alice");
        await r.press("p");
        const frame = await r.waitFor("Set password for alice");
        const lines = boxLines(frame);
        expect(lines.some(line => /^›?\s*New password/.test(line))).toBe(true);
        expect(lines.some(line => /^\s*Confirm password/.test(line))).toBe(true);
        expect(lines.some(line => line.startsWith("< Set password >"))).toBe(true);
        expect(dialogText(frame)).not.toContain("Password login is disallowed");
    });

    it("drops the rename warning rather than overdraw it at 50x10", async () => {
        const r = await openAdmin({}, [], { columns: 50, rows: 11 });
        await r.press(keys.right);
        await r.waitFor("[Groups]");
        await r.press("/", "bob", keys.enter, "R");
        const frame = await r.waitFor("Rename group bob");
        const lines = boxLines(frame);
        expect(lines.some(line => /^›?\s*New name\s+bob/.test(line))).toBe(true);
        expect(lines.some(line => line.startsWith("< Rename >"))).toBe(true);
        expect(dialogText(frame)).not.toContain("Renaming a group");
        // The question the first Enter puts fits as well.
        await r.press("s", keys.enter);
        const asked = await r.waitFor(f => dialogText(f).includes("Press Enter again to rename bob to bobs."));
        expect(boxLines(asked).some(line => line.startsWith("< Rename >"))).toBe(true);
    });
});

describe("text from the host", () => {
    const SO = "\x0e";
    const OSC8 = "\x1b]8;;http://example.invalid/\x1b\\";
    const EVIL = `ev${SO}il`;
    const GRP = `gr${SO}p`;

    /** Control characters in what Ink writes, other than its own styling and line feeds. */
    function controls(r: RenderedPage): string[] {
        let raw = r.lastRawFrame();
        // The harness's status line is its own and uncleaned (the shell's footer cleans).
        const at = raw.lastIndexOf("status: ");
        if (at >= 0)
            raw = raw.slice(0, at);
        // eslint-disable-next-line no-control-regex
        raw = raw.replace(/\x1b\[[0-9;:]*m/g, "");
        // eslint-disable-next-line no-control-regex
        return [...raw.matchAll(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g)].map(match => JSON.stringify(match[0]));
    }

    function hostile(): MockScenario {
        const s = scenario({ ...ADMIN }, {
            "chage -l mock": {
                stdout: `Last password change\t\t\t\t\t: Jan 05, 2026${SO}\n` +
                    `Password expires\t\t\t\t\t: ${OSC8}never\x07\n` +
                    `Account expires\t\t\t\t\t\t: Mar 01, 2026\r[SPOOFED]\n`,
            },
        });
        s.files!["/etc/passwd"] = withPasswd(PASSWD.replace("Mock User", `Mock${SO} User`) +
                                             `${EVIL}:x:1005:10:Evil:/home/evil:/bin/bash\n`);
        s.files!["/etc/group"] = withPasswd(GROUP + `${GRP}:x:1040:bob\n`);
        const props = (s.dbus!.system![`${LOGIN1}/session/_33`]!["org.freedesktop.login1.Session"]!.properties as JsonObject);
        props.State = `active${SO}${OSC8}`;
        s.spawnPatterns!.unshift({
            match: "ssh-keygen -l -f authorized_keys", stdout: `256 SHA256:mockFingerprint mo${SO}ck@laptop (ED25519)\n${ED25519}\n`,
        });
        return s;
    }

    it("cleans every host string before it reaches the terminal", async () => {
        const r = await open(hostile(), { allowed: true, columns: 130 });
        await r.waitFor(f => f.includes("locked") && f.includes("2026-09-20"));
        expect(controls(r)).toEqual([]);
        // Details: chage's dates, then the session's state, the key comment, the history.
        await r.press(keys.enter);
        await r.waitFor(f => /Password expires\s+\S/.test(f) && !/Password expires\s+…/.test(f));
        expect(r.lastFrame()).toMatch(/Account expires\s+Mar 01, 2026\[SPOOFED\]/);
        expect(controls(r)).toEqual([]);
        await r.press(keys.right);
        await r.waitFor("[Sessions (1)]");
        expect(controls(r)).toEqual([]);
        await r.press(keys.right);
        await r.waitFor("mockFingerprint");
        expect(controls(r)).toEqual([]);
        // An account whose name the "remove admin" reason repeats (wheel is its primary group).
        await r.press(keys.escape);
        await r.waitFor("2 system hidden");
        await r.press("/", "1005", keys.enter, keys.enter);
        await r.waitFor("the administrator group is the primary group of ev^Nil");
        expect(controls(r)).toEqual([]);
        // Groups: the list, the rename dialog's field, the create dialog's GID clash.
        await r.press(keys.escape, keys.escape, keys.right);
        await r.waitFor("[Groups]");
        expect(controls(r)).toEqual([]);
        await r.press("/", "gr", keys.enter, "R");
        await waitForDialog(r, "Rename group gr^Np");
        expect(controls(r)).toEqual([]);
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Rename group"));
        await r.press("n");
        await r.waitFor("Create new group");
        await r.press("newgrp", keys.down, keys.ctrl("u"), "1040", keys.enter);
        await waitForDialog(r, "The group ID 1040 is already used by gr^Np.");
        expect(controls(r)).toEqual([]);
        expect(spawnedWith("groupadd")).toEqual([]);
    });
});

describe("key hints", () => {
    /** The page's hints in the order the footer takes them. */
    function hints(frame: string): string[] {
        const line = frame.split("\n").find(l => l.startsWith("hints: ")) ?? "";
        return line.slice("hints: ".length).split(" | ").filter(Boolean);
    }

    /*
     * What the shell's footer shows of them on an 80x24 terminal: its own
     * hints ("1-9 pages  A admin  ? help  q quit") leave 41 columns, filled
     * with whole hints in order (app.tsx Footer).
     */
    function footer80(list: readonly string[]): string[] {
        const out: string[] = [];
        let used = 0;
        for (const hint of list) {
            const next = used + textWidth(hint) + (out.length ? 2 : 0);
            if (next > 41)
                break;
            out.push(hint);
            used = next;
        }
        return out;
    }

    it("puts the keys an 80-column footer must show first", async () => {
        // 65 columns: the page area beside the menu on an 80-column terminal.
        let r = await open(scenario(), { columns: 65, rows: 23, showHints: true });
        let frame = await r.waitFor("2 system hidden");
        expect(footer80(hints(frame))).toEqual(["←→ groups", "/ filter", "h sys", "s sort"]);
        await r.press(keys.right);
        frame = await r.waitFor("[Groups]");
        expect(footer80(hints(frame))).toEqual(["←→ accounts", "/ filter", "s sort"]);
        // Your own SSH keys: adding and removing come first.
        await r.press(keys.left);
        await r.waitFor("[Accounts]");
        await r.press(keys.enter, keys.right, keys.right);
        frame = await r.waitFor("mockFingerprint");
        expect(footer80(hints(frame))).toEqual(["n add key", "x remove", "esc back", "←→ tabs"]);
        cleanup();
        mock?.close();
        r = await open(scenario({ ...ADMIN }), { allowed: true, columns: 65, rows: 23, showHints: true });
        frame = await r.waitFor(f => f.includes("locked") && f.includes("2 system hidden"));
        expect(footer80(hints(frame))).toEqual(["←→ groups", "/ filter", "n new", "h sys", "s sort"]);
    });
});

describe("the list", () => {
    it("marks system accounts in words, not only by colour", async () => {
        const r = await open(scenario());
        await r.waitFor("2 system hidden");
        await r.press("h");
        const frame = await r.waitFor("system accounts shown");
        expect(frame).toMatch(/ bin \(system\)\s/);
        expect(frame).toMatch(/ svc \(system\)\s/);
        expect(frame).not.toMatch(/alice \(system\)|root \(system\)/);
    });

    it("comes back from the details at the same place in a long list", async () => {
        const s = scenario();
        const many = Array.from({ length: 40 }, (_, i) => `user${String(i).padStart(2, "0")}:x:${2000 + i}:100::/home/u${i}:/bin/bash`);
        s.files!["/etc/passwd"] = withPasswd(PASSWD + many.join("\n") + "\n");
        const r = await open(s, { rows: 20 });
        await r.waitFor("user00");
        await r.press(keys.end, ...Array.from({ length: 10 }, () => keys.up));
        const before = await r.waitFor("› user29");
        const row = before.split("\n").findIndex(line => line.startsWith("› "));
        await r.press(keys.enter);
        await r.waitFor("[Account]");
        await r.press(keys.escape);
        const after = await r.waitFor(f => f.includes("› user29") && !f.includes("[Account]"));
        expect(after.split("\n").findIndex(line => line.startsWith("› "))).toBe(row);
        // And from the Groups tab.
        await r.press(keys.right);
        await r.waitFor("[Groups]");
        await r.press(keys.left);
        const back = await r.waitFor(f => f.includes("› user29") && f.includes("[Accounts]"));
        expect(back.split("\n").findIndex(line => line.startsWith("› "))).toBe(row);
    });

    it("keeps the last order by activity while the login facts are still loading", async () => {
        const s = scenario({}, { lastlog: { chunks: [{ data: LASTLOG, delayMs: 1500 }] } });
        // Only mock is logged in: by activity bob (Sep 20) comes before alice and root (never).
        const manager = s.dbus!.system![LOGIN1]!["org.freedesktop.login1.Manager"]!;
        (manager.methods!.ListUsers!.reply as unknown[][])[0] = [[1000, "mock", `${LOGIN1}/user/_1000`]];
        // As an earlier visit, sorted by last activity, left it.
        const r = await open(s, {
            seed: { "accounts:sort": { key: "login", reverse: false }, "accounts:login-order": ["mock", "bob", "alice", "root"] },
        });
        let frame = await r.waitFor(f => f.includes("by last active") && f.includes("logged in"));
        expect(frame).not.toContain("2026-09-20");
        expect(listed(frame)).toEqual(["mock", "bob", "alice", "root"]);
        frame = await r.waitFor("2026-09-20", 5000);
        expect(listed(frame)).toEqual(["mock", "bob", "alice", "root"]);
    });
});
