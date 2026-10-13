/*
 * The Accounts page's data sources against a real cockpit-bridge.
 *
 * Read-only, and unprivileged: everything here only reads files, asks logind
 * and runs commands that report (lastlog, last, date, pwscore, ssh-keygen -l
 * on a copy). Nothing that changes an account is ever sent -- not even to
 * see it refused: the one refusal checked is "require" on `true`, because on
 * a host where the bridge is root (or sudo needs no password) a refused
 * argv would simply run. `chage -l` is left out on purpose: it is read-only,
 * but every run writes an audit record.
 *
 * Skips without a bridge; tolerates a container without logind, wtmp or
 * lastlog by checking shapes only where there is data.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cockpit from "../../src/cockpit.js";
import { initInfo } from "../../src/session.js";
import { localTransport, type StreamTransport } from "../../src/transport/stream.js";
import AccountsPage from "../../src/pages/accounts/index.js";
import { checkPasswordQuality, exec, isAccessDenied, readLastLogins } from "../../src/pages/accounts/actions.js";
import { LISTER } from "../../src/pages/accounts/scripts.js";
import {
    buildAccounts, isLoggedInState, isSystemAccount, parseEpochSeconds, parseGroups, parseKeyList, parseLast,
    parseLastlog, parseLoginDefs, parsePasswd, parseShells,
} from "../../src/pages/accounts/model.js";
import { renderPage } from "../helpers/page.js";
import { cleanup } from "../helpers/ink.js";

const haveBridge = spawnSync("cockpit-bridge", ["--version"], { stdio: "ignore" }).status === 0;
const isRoot = process.getuid?.() === 0;

const LOGIN1 = "/org/freedesktop/login1";
const MANAGER = "org.freedesktop.login1.Manager";
const CALL = { type: "", flags: "", timeout: 5000 } as const;

let active: StreamTransport | null = null;

async function connect(): Promise<void> {
    const transport = localTransport({ onStderr: () => {} });
    transport.install();
    active = transport;
    await transport.connect();
    await initInfo();
}

afterEach(() => {
    cleanup();
    active?.close();
    active = null;
});

async function read(path: string): Promise<string | null> {
    const file = cockpit.file(path);
    try {
        return await file.read();
    } finally {
        file.close();
    }
}

describe.skipIf(!haveBridge)("the Accounts page's sources against a real bridge", () => {
    it("parses the account files, and the current user is a person, not a system account", async () => {
        await connect();
        const passwd = parsePasswd(await read("/etc/passwd"));
        const groups = parseGroups(await read("/etc/group"));
        const shells = parseShells(await read("/etc/shells"));
        const defs = parseLoginDefs(await read("/etc/login.defs") ?? await read("/usr/etc/login.defs"));
        expect(passwd.length).toBeGreaterThan(0);
        expect(groups.length).toBeGreaterThan(0);
        expect(shells.every(shell => shell.startsWith("/"))).toBe(true);
        expect(defs.uidMin).toBeGreaterThan(0);
        expect(defs.uidMax).toBeGreaterThan(defs.uidMin);

        // The parser keeps what getent-free upstream keeps: every well-formed line.
        const lines = readFileSync("/etc/passwd", "utf8").split("\n").filter(line => /^[^+:-][^:]*:[^:]*:\d+:/.test(line));
        expect(passwd.map(entry => entry.name)).toEqual(lines.map(line => line.split(":")[0]));

        const accounts = buildAccounts(passwd, groups, defs.uidMin);
        const me = accounts.find(account => account.name === cockpit.info.user?.name);
        expect(me).toBeDefined();
        if (me!.uid >= defs.uidMin && !/nologin|false/.test(me!.shell))
            expect(me!.system).toBe(false);
        for (const account of accounts) {
            if (account.uid !== 0 && account.uid < defs.uidMin)
                expect(account.system, account.name).toBe(true);
        }
        // The supplementary groups agree with what id(1) reports for this process.
        const ids = spawnSync("id", ["-Gn"], { encoding: "utf8" }).stdout.trim().split(/\s+/);
        for (const group of me!.groups)
            expect(ids, group).toContain(group);
    });

    it("asks logind who is logged in, with upstream's call shapes", async () => {
        await connect();
        const logind = cockpit.dbus("org.freedesktop.login1", { bus: "system" });
        try {
            let users: [number, string, string][];
            try {
                const [reply] = await logind.call(LOGIN1, MANAGER, "ListUsers", null, CALL);
                users = reply as [number, string, string][];
            } catch {
                return; // no logind here (a container)
            }
            expect(Array.isArray(users)).toBe(true);
            for (const [uid, name, path] of users) {
                expect(typeof uid).toBe("number");
                expect(typeof name).toBe("string");
                expect(path).toMatch(/^\/org\/freedesktop\/login1\/user\//);
                const [state] = await logind.call(path, "org.freedesktop.DBus.Properties", "Get",
                                                  ["org.freedesktop.login1.User", "State"], { type: "ss", flags: "", timeout: 5000 });
                const value = (state as { t: string, v: string });
                expect(value.t).toBe("s");
                expect(["offline", "lingering", "online", "active", "closing"]).toContain(value.v);
            }

            // Sessions, as the details' Sessions tab reads them.
            const [sessions] = await logind.call(LOGIN1, MANAGER, "ListSessions", null, CALL);
            for (const [id, uid, user, seat, path] of sessions as [string, number, string, string, string][]) {
                expect(typeof id).toBe("string");
                expect(typeof uid).toBe("number");
                expect(typeof user).toBe("string");
                expect(typeof seat).toBe("string");
                const [props] = await logind.call(path, "org.freedesktop.DBus.Properties", "GetAll",
                                                  ["org.freedesktop.login1.Session"], { type: "s", flags: "", timeout: 5000 })
                    .catch(() => [null]); // ended in between
                if (!props)
                    continue;
                const p = props as Record<string, { t: string, v: unknown }>;
                for (const key of ["TTY", "Service", "RemoteHost", "State", "Display"])
                    expect(typeof p[key]?.v, key).toBe("string");
                expect(typeof p.Timestamp?.v).toBe("number");
                // A user with an open session is never "lingering" or "offline" (spec gotcha 4).
                const user_ = users.find(([, name]) => name === user);
                if (user_ && p.State?.v !== "closing") {
                    const [state] = await logind.call(user_[2], "org.freedesktop.DBus.Properties", "Get",
                                                      ["org.freedesktop.login1.User", "State"], { type: "ss", flags: "", timeout: 5000 })
                        .catch(() => [null]);
                    if (state)
                        expect(isLoggedInState((state as { v: string }).v), user).toBe(true);
                }
            }
        } finally {
            logind.close();
        }
    });

    it("reads last logins without privileges, and parses lastlog's dates exactly like date(1)", async () => {
        await connect();
        const { times, source } = await readLastLogins();
        expect(["lastlog2", "lastlog"]).toContain(source);
        const now = Date.now();
        for (const [name, time] of times) {
            expect(typeof name).toBe("string");
            expect(time).toBeGreaterThan(0);
            expect(time).toBeLessThan(now + 86_400_000);
        }
        // A second read knows the source and does not probe for lastlog2 again.
        expect((await readLastLogins(source)).source).toBe(source);

        if (source !== "lastlog")
            return;
        // The page parses lastlog's dates in-process where upstream runs
        // `date +%s -d` per line; check that against date itself.
        const { stdout } = await exec(["lastlog"], { environ: ["LC_ALL=C"] });
        const dated = stdout.split("\n").slice(1).filter(line => line.trim() && !line.includes("**Never logged in**"));
        const { times: parsed, unparsed } = parseLastlog(stdout);
        expect(unparsed).toEqual([]);
        for (const line of dated.slice(0, 3)) {
            const fields = line.trim().split(/[ \t]+/);
            const out = await exec(["date", "+%s", "-d", fields.slice(-5).join(" ")], { environ: ["LC_ALL=C"], err: "out" });
            expect(parsed.get(fields[0]!)).toBe(parseEpochSeconds(out.stdout));
        }
    });

    it("reads the current user's login history", async () => {
        await connect();
        const name = cockpit.info.user!.name;
        const { stdout } = await exec(["last", "--time-format", "iso", "-n25", "--fullnames", name], { environ: ["LC_ALL=C"] });
        const records = parseLast(stdout, name);
        // Every line of this user's that has a start time is one record (tmux/screen aside).
        const lines = stdout.split("\n").filter(line => line.startsWith(`${name} `) && /\d{4}-\d{2}-\d{2}T/.test(line) &&
            !line.includes("tmux") && !line.includes("screen"));
        expect(records).toHaveLength(lines.length);
        for (const record of records) {
            expect(record.start).toBeGreaterThan(0);
            // An open or crashed session says why it has no end time.
            if (record.end === null)
                expect(record.endText).toMatch(/\S/);
            else
                expect(record.end).toBeGreaterThanOrEqual(record.start);
        }
    });

    it("lists the current user's authorized keys through upstream's lister", async ({ skip }) => {
        await connect();
        const path = join(cockpit.info.user!.home, ".ssh", "authorized_keys");
        if (!existsSync(path))
            skip();
        let content: string;
        try {
            content = readFileSync(path, "utf8");
        } catch {
            return skip();
        }
        const dir = mkdtempSync(join(tmpdir(), "accounts-lister-"));
        try {
            const { stdout } = await exec(["/bin/sh", "-c", LISTER, "--"], { environ: [`TMPDIR=${dir}`] }, content + "\n");
            const keys = parseKeyList(stdout);
            const lines = content.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
            expect(keys).toHaveLength(lines.length);
            for (const key of keys.filter(k => k.valid)) {
                expect(key.fingerprint).toMatch(/^SHA256:/);
                expect(key.algorithm).toBeTruthy();
                expect(key.comment).toBeTruthy();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it.skipIf(!existsSync("/usr/bin/pwscore"))("checks password quality with pwscore, as upstream", async () => {
        await connect();
        const weak = await checkPasswordQuality("abc");
        expect(weak.ok).toBe(false);
        expect(weak.ok ? "" : weak.message).toMatch(/\S/);
        expect(weak.ok ? "" : weak.message).not.toContain("\n");
        expect(await checkPasswordQuality("Xk2#pLq9-Vw7!rTz4")).toEqual({ ok: true });
    });

    it.skipIf(isRoot)("refuses superuser \"require\" without administrative access", async () => {
        await connect();
        const error = await exec(["true"], { superuser: "require" }).then(() => null, (e: unknown) => e);
        expect(isAccessDenied(error)).toBe(true);
    });

    it("renders the list for the current user, unprivileged", async () => {
        await connect();
        const passwd = parsePasswd(await read("/etc/passwd"));
        const defs = parseLoginDefs(await read("/etc/login.defs") ?? await read("/usr/etc/login.defs"));
        const visible = passwd.filter(entry => !isSystemAccount(entry, defs.uidMin)).map(entry => entry.name);
        const me = cockpit.info.user!.name;

        const r = renderPage(AccountsPage, { columns: 120, rows: Math.max(12, visible.length + 6), allowed: false });
        const frame = await r.waitFor(f => f.split("\n").some(line =>
            line.includes(`${me} (you)`) && /(logged in|\d{4}-\d{2}-\d{2} \d{2}:\d{2}|never)/.test(line)), 10_000);
        const rows = frame.split("\n").filter(line => /^[›> ] \S/.test(line) && !/^\s+User\s/.test(line));
        expect(rows[0]).toContain(`${me} (you)`);
        for (const name of visible)
            expect(frame, name).toMatch(new RegExp(`^[›> ] ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m"));
        // Without access the lock state is unknown, and says so.
        expect(rows.every(row => / \? /.test(row))).toBe(true);
    });
});
