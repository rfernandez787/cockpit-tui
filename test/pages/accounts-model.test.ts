/*
 * The Accounts page's pure logic: parsers, rules, validators and the action
 * policy. Command output samples are the ones captured on a RHEL 9 machine
 * for the research spec (lastlog, last, the key lister), plus upstream's
 * own test vectors where it has them.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    adminGroupFor, buildAccounts, buildGroups, chageDate, checkKeyText, hasProcessesState, isLastKey, isLoggedInState, isNoLoginShell,
    isSystemAccount, lockState, matchesFilter, matchesGroupFilter, nextGid, parseChage, parseEpochSeconds, parseGroups,
    parseKeyList, parseLast, parseLastlog, parseLastlog2, parseLoginDefs, parsePasswd, parsePasswdStatus,
    parsePasswdStatusAll, parseShadowLocks, parseShells, removeKeyLine, sortAccounts, sortGroups, suggestUsername,
    validateFullName, validateGid, validateGroupName, validatePasswords, validateUsername,
    DEFAULT_LOGIN_DEFS, type Account,
} from "../../src/pages/accounts/model.js";
import { accountActions, groupActions, removableAdminGroups, NEEDS_ADMIN } from "../../src/pages/accounts/policy.js";
import { deleteGroupMessage } from "../../src/pages/accounts/dialogs.js";
import { useraddArgv } from "../../src/pages/accounts/actions.js";
import { formatSpan } from "../../src/pages/accounts/ui.js";
import { SHADOW_LOCK_SCRIPT } from "../../src/pages/accounts/scripts.js";

const PASSWD = [
    "root:x:0:0:root:/root:/bin/bash",
    "bin:x:1:1:bin:/bin:/sbin/nologin",
    "sync:x:5:0:sync:/sbin:/bin/sync",
    "ollama:x:973:971::/usr/share/ollama:/bin/false",
    "ric:x:1000:1000:Ric Example,Room 1,,:/home/ric:/bin/bash",
    "svc:x:1500:1500:Service:/var/svc:/usr/sbin/nologin",
    "nobody:x:65534:65534:Kernel Overflow User:/:/sbin/nologin",
    "damaged:x:1234:1234:Damaged",
    "+::::::",
    "broken:x:abc:1::/:/bin/sh",
    "",
].join("\n");

const GROUP = [
    "root:x:0:",
    "wheel:x:10:ric",
    "users:x:100:",
    "ric:x:1000:",
    "libvirt:x:981:ric,eric",
    "short:x:42",
    "tekkit-group:x:1001:ric",
].join("\n");

describe("file parsers", () => {
    it("parses passwd like upstream, tolerating short lines and skipping NIS and broken ones", () => {
        const entries = parsePasswd(PASSWD);
        expect(entries.map(e => e.name)).toEqual(["root", "bin", "sync", "ollama", "ric", "svc", "nobody", "damaged"]);
        const ric = entries.find(e => e.name === "ric")!;
        expect(ric).toEqual({
            name: "ric", password: "x", uid: 1000, gid: 1000, gecos: "Ric Example,Room 1", home: "/home/ric", shell: "/bin/bash",
        });
        expect(entries.find(e => e.name === "damaged")).toMatchObject({ uid: 1234, gecos: "Damaged", home: "", shell: "" });
        expect(parsePasswd(null)).toEqual([]);
    });

    it("parses groups, dropping empty member names and surviving short lines", () => {
        const groups = parseGroups(GROUP);
        expect(groups.find(g => g.name === "libvirt")).toEqual({ name: "libvirt", gid: 981, members: ["ric", "eric"] });
        expect(groups.find(g => g.name === "users")!.members).toEqual([]);
        expect(groups.find(g => g.name === "short")).toEqual({ name: "short", gid: 42, members: [] });
    });

    it("parses shells without comments and blanks", () => {
        expect(parseShells("# comment\n/bin/sh\n\n/bin/bash\n  /usr/bin/tmux  \n")).toEqual(["/bin/sh", "/bin/bash", "/usr/bin/tmux"]);
    });

    it("reads login.defs ranges, each falling back on its own", () => {
        expect(parseLoginDefs("UID_MIN 500\n#UID_MAX 1\nUID_MAX\t\t60000\nGID_MIN 1000\nUSERGROUPS_ENAB yes\n"))
            .toEqual({ uidMin: 500, uidMax: 60000, gidMin: 1000, gidMax: 60000, userGroups: true });
        expect(parseLoginDefs("USERGROUPS_ENAB no")).toMatchObject({ uidMin: 1000, userGroups: false });
        expect(parseLoginDefs(null)).toEqual(DEFAULT_LOGIN_DEFS);
    });
});

describe("accounts", () => {
    const accounts = buildAccounts(parsePasswd(PASSWD), parseGroups(GROUP), 1000);
    const get = (name: string) => accounts.find(a => a.name === name)!;

    it("hides system accounts by UID_MIN and no-login shells, but never root", () => {
        expect(accounts.filter(a => !a.system).map(a => a.name)).toEqual(["root", "ric", "damaged"]);
        expect(isSystemAccount({ uid: 999, shell: "/bin/bash" }, 1000)).toBe(true);
        expect(isSystemAccount({ uid: 999, shell: "/bin/bash" }, 500)).toBe(false);
        expect(isSystemAccount({ uid: 0, shell: "/bin/bash" }, 1000)).toBe(false);
        expect(isSystemAccount({ uid: 0, shell: "/sbin/nologin" }, 1000)).toBe(true);
        for (const shell of ["/sbin/nologin", "/usr/sbin/nologin", "/bin/false", "/usr/bin/false"])
            expect(isNoLoginShell(shell)).toBe(true);
        for (const shell of ["/bin/bash", "", "/bin/sync", "/usr/bin/falsely"])
            expect(isNoLoginShell(shell)).toBe(false);
    });

    it("derives groups, the primary group and the administrator role", () => {
        expect(get("ric")).toMatchObject({
            fullName: "Ric Example", primaryGroup: "ric", groups: ["wheel", "libvirt", "tekkit-group"], adminGroups: ["wheel"],
        });
        // root is an administrator through its primary group, as upstream labels it.
        expect(get("root")).toMatchObject({ primaryGroup: "root", groups: [], adminGroups: ["root"] });
        expect(removableAdminGroups(get("root"))).toEqual([]);
        expect(removableAdminGroups(get("ric"))).toEqual(["wheel"]);
        expect(get("damaged")).toMatchObject({ primaryGroup: null, adminGroups: [] });
        // The root group makes only root an administrator, not sync (gid 0).
        expect(get("sync")).toMatchObject({ primaryGroup: "root", adminGroups: [] });
    });

    it("picks the administrator group per distribution family", () => {
        const both = parseGroups("wheel:x:10:\nsudo:x:27:\n");
        expect(adminGroupFor(both, { ID: "rhel", ID_LIKE: "fedora" })).toBe("wheel");
        expect(adminGroupFor(both, { ID: "ubuntu", ID_LIKE: "debian" })).toBe("sudo");
        expect(adminGroupFor(parseGroups("sudo:x:27:\n"), { ID: "fedora" })).toBe("sudo");
        expect(adminGroupFor(parseGroups("users:x:100:\n"), {})).toBeNull();
    });

    it("sorts with the current user first, and logged-in before never", () => {
        const facts = (a: Pick<Account, "name">) => ({
            loggedIn: a.name === "damaged",
            lastLogin: a.name === "root" ? 5 : null,
        });
        const visible = accounts.filter(a => !a.system);
        expect(sortAccounts(visible, "name", false, "ric", facts).map(a => a.name)).toEqual(["ric", "damaged", "root"]);
        expect(sortAccounts(visible, "name", true, "ric", facts).map(a => a.name)).toEqual(["ric", "root", "damaged"]);
        expect(sortAccounts(visible, "uid", false, null, facts).map(a => a.name)).toEqual(["root", "ric", "damaged"]);
        expect(sortAccounts(visible, "login", false, null, facts).map(a => a.name)).toEqual(["damaged", "root", "ric"]);
    });

    it("filters on name, full name, UID and supplementary groups", () => {
        expect(matchesFilter(get("ric"), "EXAMPLE")).toBe(true);
        expect(matchesFilter(get("ric"), "1000")).toBe(true);
        expect(matchesFilter(get("ric"), "tekkit")).toBe(true);
        expect(matchesFilter(get("root"), "tekkit")).toBe(false);
        expect(matchesFilter(get("root"), "  ")).toBe(true);
    });
});

describe("login state", () => {
    it("counts only sessions as logged in, not lingering", () => {
        expect(isLoggedInState("active")).toBe(true);
        expect(isLoggedInState("online")).toBe(true);
        expect(isLoggedInState("lingering")).toBe(false);
        expect(isLoggedInState("closing")).toBe(false);
        expect(isLoggedInState(undefined)).toBe(false);
    });

    it("knows which states still have processes running: sessions, closing ones, a lingering user manager", () => {
        for (const state of ["active", "online", "lingering", "closing"])
            expect(hasProcessesState(state)).toBe(true);
        expect(hasProcessesState("offline")).toBe(false);
        expect(hasProcessesState(undefined)).toBe(false);
    });

    it("reads lock state from passwd -S, both flavours, and from the shadow script", () => {
        expect(parsePasswdStatusAll("root P 2024-01-01 0 99999 7 -1\nbob L 2024-01-01 0 99999 7 -1\nnew NP 2024-01-01 0 99999 7 -1\n"))
            .toEqual(new Map([["root", false], ["bob", true], ["new", false]]));
        expect(parsePasswdStatus("bob LK 2026-10-02 0 99999 7 -1 (Password locked.)\n")).toBe(true);
        expect(parsePasswdStatus("bob PS 2026-10-02 0 99999 7 -1 (Password set, SHA512 crypt.)\n")).toBe(false);
        expect(parsePasswdStatus("")).toBeNull();
        const locks = parseShadowLocks("root $\nbin *\nlocked !\nnopw !\nempty \n");
        expect(locks).toEqual(new Map([["root", false], ["bin", false], ["locked", true], ["nopw", true], ["empty", false]]));
        expect(lockState(locks, "locked")).toBe("locked");
        expect(lockState(locks, "root")).toBe("unlocked");
        expect(lockState(locks, "ghost")).toBe("unknown");
        expect(lockState(null, "root")).toBe("unknown");
    });
});

describe("last login", () => {
    it("parses the lastlog2 JSON", () => {
        expect(parseLastlog2('{"ric": {"time": 1790982722, "tty": "pts/0", "host": "1.2.3.4"}, "x": {"time": 0}}'))
            .toEqual(new Map([["ric", 1790982722000]]));
    });

    it("parses legacy lastlog in-process, with the same epoch as date(1)", () => {
        const out = [
            "Username         Port     From                                       Latest",
            "root                                                                **Never logged in**",
            "ric              pts/0    192.168.50.205                            Fri Oct  2 17:12:02 -0600 2026",
            "gdm              tty1                                               Sun Sep 20 10:43:42 -0600 2026",
            "odd              pts/1    host                                      Fri Oct  2 17:12:02 XYZ 2026",
            "",
        ].join("\n");
        const { times, unparsed } = parseLastlog(out);
        // The spec verified `date +%s -d "Oct 2 17:12:02 -0600 2026"` = 1790982722.
        expect(times.get("ric")).toBe(1790982722000);
        expect(times.get("gdm")).toBe(1789922622000);
        expect(times.has("root")).toBe(false);
        expect(unparsed).toEqual([["odd", "Oct 2 17:12:02 XYZ 2026"]]);
        expect(parseEpochSeconds("1790982722\n")).toBe(1790982722000);
        expect(parseEpochSeconds("date: invalid date 'garbage'")).toBeNull();
    });
});

describe("formatting", () => {
    it("gives session lengths compactly, but exact enough to compare", () => {
        expect(formatSpan(35)).toBe("35s");
        expect(formatSpan(59.9)).toBe("59s");
        expect(formatSpan(60)).toBe("1m");
        expect(formatSpan(16 * 60 + 5)).toBe("16m");
        expect(formatSpan(3600 + 52 * 60)).toBe("1h 52m");
        expect(formatSpan(9 * 3600 + 18 * 60)).toBe("9h 18m");
        expect(formatSpan(86400 + 17 * 3600 + 52 * 60)).toBe("1d 17h");
        expect(formatSpan(-1)).toBe("");
        expect(formatSpan(Number.NaN)).toBe("");
    });
});

describe("chage -l", () => {
    it("turns chage's dates into calendar days without time zone shifts", () => {
        expect(chageDate("Nov 01, 2026")).toBe("2026-11-01");
        expect(chageDate("never")).toBe("never");
        expect(chageDate("password must be changed")).toBe("must change");
        expect(chageDate("2026-11-01")).toBe("2026-11-01");
    });

    it("parses the facts", () => {
        const out = [
            "Last password change\t\t\t\t\t: Jan 05, 2026",
            "Password expires\t\t\t\t\t: password must be changed",
            "Password inactive\t\t\t\t\t: never",
            "Account expires\t\t\t\t\t\t: Dec 31, 2026",
            "Minimum number of days between password change\t\t: 0",
            "Maximum number of days between password change\t\t: 99999",
            "Number of days of warning before password expires\t: 7",
        ].join("\n");
        expect(parseChage(out)).toEqual({
            lastChange: "2026-01-05", passwordExpires: "must change", accountExpires: "2026-12-31", maxDays: "99999",
        });
        expect(parseChage("")).toEqual({ lastChange: null, passwordExpires: null, accountExpires: null, maxDays: null });
    });
});

describe("last", () => {
    const out = [
        "ric      pts/0        192.168.50.205   2026-10-02T17:12:02-06:00   still logged in",
        "ric      web console  ::ffff:192.168.50.115 2026-10-01T21:35:59-06:00 - 2026-10-01T21:36:58-06:00  (00:00)",
        "eric     pts/3        10.0.0.9         2026-10-01T10:00:00-06:00 - 2026-10-01T11:00:00-06:00  (01:00)",
        "ric      tmux(1234).%0                 2026-09-30T10:00:00-06:00 - 2026-09-30T11:00:00-06:00  (01:00)",
        "ric      pts/2        10.6.0.3         2026-09-25T18:12:22-06:00 - crash                     (1+00:01)",
        "ric      tty2                          2026-09-20T10:00:00-06:00 - 2026-09-20T10:30:00-06:00  (00:30)",
        "reboot   system boot  5.14.0-687.el9   2026-09-20T09:00:00-06:00   still running",
        "",
        "wtmp begins 2025-09-06T19:42:29-06:00",
    ].join("\n");

    it("keeps only this account's logins, open ones included, with terminal and origin", () => {
        const records = parseLast(out, "ric");
        expect(records).toHaveLength(4);
        expect(records[0]).toEqual({
            start: Date.parse("2026-10-02T17:12:02-06:00"), end: null, endText: "still logged in", tty: "pts/0", from: "192.168.50.205",
        });
        expect(records[1]).toMatchObject({ tty: "web console", from: "::ffff:192.168.50.115", endText: null });
        expect(records[1]!.end! - records[1]!.start).toBe(59_000);
        expect(records[2]).toMatchObject({ end: null, endText: "crash", from: "10.6.0.3" });
        expect(records[3]).toMatchObject({ tty: "tty2", from: "" });
        expect(parseLast(out, "eric")).toHaveLength(1);
    });
});

describe("authorized keys", () => {
    const RSA = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDpAQgUA3efyrzjxijOvvEPT4wtIk2GGVW8";

    it("parses the lister's output like upstream, naming comment-less keys by their start", () => {
        const keys = parseKeyList([
            "3072 SHA256:6+l4abc ric@server-box (RSA)",
            `${RSA} ric@server-box`,
            "256 SHA256:oDqM0Z no comment (ED25519)",
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM",
            "not-a-key is not a public key file.",
            "garbage",
            "",
        ].join("\n"));
        expect(keys).toHaveLength(3);
        expect(keys[0]).toEqual({
            raw: `${RSA} ric@server-box`, valid: true, size: "3072", fingerprint: "SHA256:6+l4abc",
            comment: "ric@server-box", algorithm: "RSA",
        });
        expect(keys[1]).toMatchObject({ valid: true, comment: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM", algorithm: "ED25519" });
        expect(keys[2]).toMatchObject({ raw: "garbage", valid: false, fingerprint: null });
    });

    it("refuses pasted text that is not exactly one public key", () => {
        expect(checkKeyText(`${RSA} me@host`)).toBeNull();
        expect(checkKeyText(`from="10.0.0.0/8",no-pty ${RSA} me@host`)).toBeNull();
        expect(checkKeyText("sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t me")).toBeNull();
        expect(checkKeyText("   ")).toMatch(/Paste a public key/);
        expect(checkKeyText("-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXk")).toMatch(/private key/);
        expect(checkKeyText(`${RSA} a@b ${RSA} c@d`)).toMatch(/more than one key/);
        expect(checkKeyText("hello world")).toMatch(/does not look like/);
        expect(checkKeyText("ssh-ed25519 not*base64")).toMatch(/missing or damaged/);
    });

    it("removes one line and keeps everything else, newline included", () => {
        const content = `# keys\n${RSA} a@b\n\nssh-ed25519 AAAA c@d\n`;
        expect(removeKeyLine(content, `${RSA} a@b`)).toBe("# keys\n\nssh-ed25519 AAAA c@d\n");
        expect(removeKeyLine(`${RSA} a@b`, `${RSA} a@b`)).toBe("");
        expect(removeKeyLine(`${RSA} a@b\n`, `${RSA} a@b`)).toBe("");
        expect(removeKeyLine(`${RSA} a@b\r\nx\n`, `${RSA} a@b`)).toBe("x\n");
        expect(removeKeyLine(content, "ssh-ed25519 BBBB")).toBeNull();
        // Only the first copy goes.
        expect(removeKeyLine("k\nk\n", "k")).toBe("k\n");
    });

    it("finds a key line the lister trimmed: its `read` drops spaces and tabs around the line", () => {
        expect(removeKeyLine(`${RSA} a@b  \nx\n`, `${RSA} a@b`)).toBe("x\n");
        expect(removeKeyLine(`x\n\t ${RSA} a@b\n`, `${RSA} a@b`)).toBe("x\n");
        expect(removeKeyLine(` ${RSA} a@b \r\n`, `${RSA} a@b`)).toBe("");
        // Spaces inside the line still count: that is another line.
        expect(removeKeyLine(`${RSA}  a@b\n`, `${RSA} a@b`)).toBeNull();
    });

    it("knows when a key is the last usable one", () => {
        const keys = parseKeyList(`256 SHA256:x c (ED25519)\nk1 c\n256 SHA256:y d (ED25519)\nk2 d\n`);
        expect(isLastKey(keys, "k1 c")).toBe(false);
        expect(isLastKey(keys.slice(0, 1), "k1 c")).toBe(true);
        // A duplicated line leaves its twin behind.
        const twins = parseKeyList(`256 SHA256:x c (ED25519)\nk1 c\n256 SHA256:x c (ED25519)\nk1 c\n`);
        expect(isLastKey(twins, "k1 c")).toBe(false);
        // Lines ssh-keygen rejected let nobody in.
        const withJunk = parseKeyList(`256 SHA256:x c (ED25519)\nk1 c\n\ngarbage\n`);
        expect(withJunk.map(k => k.valid)).toEqual([true, false]);
        expect(isLastKey(withJunk, "k1 c")).toBe(true);
        expect(isLastKey(withJunk, "garbage")).toBe(false);
    });
});

describe("forms", () => {
    const passwd = parsePasswd(PASSWD);
    const groups = parseGroups(GROUP);

    it("suggests a user name from the full name, as upstream", () => {
        expect(suggestUsername("John Smith")).toBe("jsmith");
        expect(suggestUsername("Anton Arbitrary")).toBe("aarbitrary");
        expect(suggestUsername("Ján Šťastný")).toBe("jstastny");
        expect(suggestUsername("Berta")).toBe("berta");
        expect(suggestUsername("  ")).toBe("");
        expect(suggestUsername("--dash")).toBe("dash");
    });

    it("validates user names against every passwd entry and useradd's rules", () => {
        expect(validateUsername("bob", passwd, groups, true)).toBeNull();
        expect(validateUsername("Berta.x_1-2", passwd, groups, true)).toBeNull();
        expect(validateUsername("", passwd, groups, true)).toBe("No user name specified");
        expect(validateUsername("bad name", passwd, groups, true)).toMatch(/can only consist/);
        expect(validateUsername("-r", passwd, groups, true)).toMatch(/dash/);
        expect(validateUsername("1234", passwd, groups, true)).toMatch(/number/);
        expect(validateUsername("x".repeat(33), passwd, groups, true)).toMatch(/32/);
        // svc is a hidden system account: upstream would not have caught this.
        expect(validateUsername("svc", passwd, groups, true)).toBe("This user name already exists");
        expect(validateUsername("libvirt", passwd, groups, true)).toMatch(/group named libvirt/);
        expect(validateUsername("libvirt", passwd, groups, false)).toBeNull();
    });

    it("validates the full name and the passwords", () => {
        expect(validateFullName("")).toBeNull();
        expect(validateFullName("A: B")).toMatch(/colons/);
        expect(validatePasswords("", "", true)).toEqual({ password: "Empty password" });
        expect(validatePasswords("", "", false)).toEqual({});
        expect(validatePasswords("a", "b", true)).toEqual({ confirm: "The passwords do not match" });
        expect(validatePasswords("x".repeat(257), "x".repeat(257), true).password).toMatch(/256/);
    });

    it("builds useradd's argv from what was given", () => {
        expect(useraddArgv({ user: "bob", fullName: "", adminGroup: null })).toEqual(["useradd", "--create-home", "bob"]);
        expect(useraddArgv({ user: "bob", fullName: "Bob Smith", adminGroup: "wheel" }))
            .toEqual(["useradd", "--create-home", "-c", "Bob Smith", "-G", "wheel", "bob"]);
    });
});

describe("action policy", () => {
    const accounts = buildAccounts(parsePasswd(PASSWD), parseGroups(GROUP), 1000);
    const get = (name: string) => accounts.find(a => a.name === name)!;
    const ctx = { allowed: true, current: "ric", adminGroup: "wheel", loggedIn: true, running: true, lock: "unlocked" as const };
    const action = (name: string, id: string, overrides = {}) =>
        accountActions(get(name), { ...ctx, ...overrides }).find(a => a.id === id)!;

    it("protects root and your own account, as upstream", () => {
        expect(action("root", "delete").reason).toBe("root cannot be deleted");
        expect(action("ric", "delete").reason).toBe("you cannot delete your own account");
        expect(action("ric", "lock").enabled).toBe(false);
        expect(action("ric", "terminate").enabled).toBe(false);
        expect(action("root", "terminate").enabled).toBe(false);
        expect(action("damaged", "delete").enabled).toBe(true);
        expect(action("damaged", "terminate", { loggedIn: false, running: false }).reason).toBe("not logged in");
    });

    it("ends the processes of a user who is not logged in but still has some (lingering, closing)", () => {
        // userdel refuses while the user's service manager runs: terminating it is the way forward.
        expect(action("damaged", "terminate", { loggedIn: false, running: true })).toMatchObject({ enabled: true, reason: null });
        expect(action("root", "terminate", { loggedIn: false, running: true }).enabled).toBe(false);
    });

    it("needs administrative access for every change, and says so", () => {
        for (const info of accountActions(get("damaged"), { ...ctx, allowed: false }))
            expect(info).toMatchObject({ enabled: false, reason: NEEDS_ADMIN });
        // A reason access would not fix comes first.
        expect(action("root", "delete", { allowed: false }).reason).toBe("root cannot be deleted");
    });

    it("labels lock and the administrator role by the current state", () => {
        expect(action("damaged", "lock").label).toBe("lock");
        expect(action("damaged", "lock", { lock: "locked" }).label).toBe("unlock");
        expect(action("damaged", "lock", { lock: "unknown" }).label).toBe("lock");
        expect(action("ric", "admin").label).toBe("remove admin");
        expect(action("damaged", "admin").label).toBe("make admin");
        expect(action("damaged", "admin", { adminGroup: null }).enabled).toBe(false);
        expect(action("root", "admin").enabled).toBe(false);
    });
});

describe("groups", () => {
    const passwd = parsePasswd(PASSWD);
    const groups = parseGroups(GROUP);
    const infos = buildGroups(groups, passwd, DEFAULT_LOGIN_DEFS);
    const get = (name: string) => infos.find(g => g.name === name)!;

    it("adds primary members from all of passwd, and counts each account once", () => {
        // root's group is the primary group of root and of sync (gid 0), hidden or not.
        expect(get("root")).toMatchObject({ primary: ["root", "sync"], members: [], count: 2, admin: false, userCreated: false });
        expect(get("wheel")).toMatchObject({ primary: [], members: ["ric"], count: 1, admin: true, userCreated: false });
        expect(get("ric")).toMatchObject({ primary: ["ric"], count: 1, userCreated: true });
        const both = buildGroups(parseGroups("ric:x:1000:ric,eve\n"), passwd, DEFAULT_LOGIN_DEFS)[0]!;
        expect(both.count).toBe(2); // upstream: 3
        expect(get("tekkit-group").userCreated).toBe(true);
    });

    it("sorts by kind (admin, user-created, system), name, GID or users (most first), always totally", () => {
        expect(sortGroups(infos, "kind", false).map(g => g.name))
            .toEqual(["wheel", "ric", "tekkit-group", "libvirt", "root", "short", "users"]);
        expect(sortGroups(infos, "name", false).map(g => g.name).slice(0, 3)).toEqual(["libvirt", "ric", "root"]);
        expect(sortGroups(infos, "gid", false).map(g => g.gid)).toEqual([0, 10, 42, 100, 981, 1000, 1001]);
        const byCount = sortGroups(infos, "count", false).map(g => g.name);
        expect(byCount.slice(0, 2)).toEqual(["libvirt", "root"]); // 2 each, then by name
        expect(sortGroups(infos, "count", true).map(g => g.name)).toEqual([...byCount].reverse());
    });

    it("filters on name or GID", () => {
        expect(infos.filter(g => matchesGroupFilter(g, "LIB")).map(g => g.name)).toEqual(["libvirt"]);
        expect(infos.filter(g => matchesGroupFilter(g, "100")).map(g => g.name)).toEqual(["users", "ric", "tekkit-group"]);
        expect(infos.filter(g => matchesGroupFilter(g, " ")).length).toBe(infos.length);
    });

    it("offers the GID groupadd would pick, not upstream's max + 2", () => {
        expect(nextGid(groups, DEFAULT_LOGIN_DEFS)).toBe(1002);
        expect(nextGid(parseGroups("root:x:0:\n"), DEFAULT_LOGIN_DEFS)).toBe(1000);
        const full = { ...DEFAULT_LOGIN_DEFS, gidMin: 1000, gidMax: 1002 };
        expect(nextGid(parseGroups("a:x:1000:\nc:x:1002:\n"), full)).toBe(1001);
        expect(nextGid(parseGroups("a:x:1000:\nb:x:1001:\nc:x:1002:\n"), full)).toBeNull();
    });

    it("validates new group names and GIDs against every group", () => {
        expect(validateGroupName("devs", groups)).toBeNull();
        expect(validateGroupName("", groups)).toBe("No group name specified");
        expect(validateGroupName("my group", groups)).toMatch(/can only consist/);
        expect(validateGroupName("-g", groups)).toMatch(/dash/);
        expect(validateGroupName("123", groups)).toMatch(/number/);
        expect(validateGroupName("g".repeat(33), groups)).toMatch(/32/);
        expect(validateGroupName("wheel", groups)).toBe("This group name already exists");
        expect(validateGid("", groups)).toBeNull();
        expect(validateGid(" 1500 ", groups)).toBeNull();
        expect(validateGid("10", groups)).toBe("The group ID 10 is already used by wheel.");
        expect(validateGid("-1", groups)).toMatch(/number from 0/);
        expect(validateGid("99999999999", groups)).toMatch(/number from 0/);
    });

    it("renames and deletes only user-created groups, with access", () => {
        const ctx = { allowed: true, gidMin: 1000, gidMax: 60000 };
        expect(groupActions(get("tekkit-group"), ctx).every(a => a.enabled)).toBe(true);
        expect(groupActions(get("tekkit-group"), { ...ctx, allowed: false }).map(a => a.reason)).toEqual([NEEDS_ADMIN, NEEDS_ADMIN]);
        expect(groupActions(get("wheel"), ctx)[1]).toMatchObject({
            id: "delete-group", key: "D", enabled: false, reason: "wheel is a system group (GID 10, outside 1000-60000)",
        });
    });

    it("says what deleting a group leaves behind", () => {
        expect(deleteGroupMessage(get("tekkit-group"))).toBe(
            "Delete the group tekkit-group (GID 1001)? Its members lose it: ric. Files owned by the group keep GID 1001.");
        expect(deleteGroupMessage(get("ric"))).toBe(
            "ric (GID 1000) is the primary group of ric. Deleting it anyway (groupdel -f) leaves that account with " +
            "GID 1000 as a primary group without a name. Files owned by the group keep GID 1000.");
    });
});

describe("the lock-state script", () => {
    /*
     * Run for real on a stand-in for /etc/shadow: it must print each name and
     * at most the first character of the password field -- never a hash.
     */
    it("prints each name with only the first character of its password field", () => {
        const dir = mkdtempSync(join(tmpdir(), "accounts-shadow-"));
        try {
            const file = join(dir, "shadow");
            writeFileSync(file, [
                "root:$6$rounds=5000$saltsalt$c2VjcmV0aGFzaHNlY3JldGhhc2g:19000:0:99999:7:::",
                "locked:!$6$saltsalt$bG9ja2VkaGFzaGxvY2tlZGhhc2g:19000:0:99999:7:::",
                "never:!!:19000:0:99999:7:::",
                "empty::19000:0:99999:7:::",
                "star:*:19000:0:99999:7:::",
                // The last line has no newline.
                "last:$y$j9T$c2FsdA$aGFzaGhhc2hoYXNo:19000:0:99999:7:::",
            ].join("\n"));
            expect(SHADOW_LOCK_SCRIPT).toContain("< /etc/shadow");
            const out = execFileSync("sh", ["-c", SHADOW_LOCK_SCRIPT.replace("/etc/shadow", file)], { encoding: "utf8" });
            const lines = out.split("\n").filter(Boolean);
            expect(lines).toEqual(["root $", "locked !", "never !", "empty ", "star *", "last $"]);
            for (const line of lines)
                expect(line).toMatch(/^[^ ]+ .?$/);
            expect(out).not.toMatch(/saltsalt|aGFz|c2Vj/);
            expect(parseShadowLocks(out)).toEqual(new Map([
                ["root", false], ["locked", true], ["never", true], ["empty", false], ["star", false], ["last", false],
            ]));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
