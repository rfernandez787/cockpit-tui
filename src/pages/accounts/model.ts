/*
 * The Accounts page's model: parsers for the files and command output the
 * page reads, the rules upstream applies to them, and the validators of its
 * forms. Everything here is pure, so it is tested without a bridge.
 *
 * Upstream is cockpit 356 pkg/users (users.js, accounts-list.js,
 * account-details.js, account-create-dialog.js, authorized-keys.js) and
 * pkg/lib/pam_user_parser.ts. Where this deliberately differs, the comment
 * says so and why.
 *
 * Nothing here cleans text for the screen: values are raw host data and the
 * views pass them through clean() when they render them.
 */

// ---- /etc/passwd, /etc/group, /etc/shells ------------------------------------

export interface PasswdEntry {
    readonly name: string;
    readonly password: string;
    readonly uid: number;
    readonly gid: number;
    /** The whole GECOS field, trailing commas removed (upstream). */
    readonly gecos: string;
    readonly home: string;
    readonly shell: string;
}

/*
 * pam_user_parser.ts parse_passwd_content(), tolerant of short lines (an
 * upstream test appends "damaged:x:1234:1234:Damaged" and expects it listed).
 *
 * Unlike upstream, lines without a name or with a non-numeric UID are
 * skipped: NIS compat entries ("+::::::", "-user") and broken lines would
 * otherwise show up as accounts with a NaN UID that every UID rule then
 * treats unpredictably.
 */
export function parsePasswd(content: string | null | undefined): PasswdEntry[] {
    const entries: PasswdEntry[] = [];
    for (const line of (content ?? "").split("\n")) {
        if (!line)
            continue;
        const c = line.split(":");
        const name = c[0] ?? "";
        const uid = parseInt(c[2] ?? "", 10);
        if (!name || name.startsWith("+") || name.startsWith("-") || !Number.isFinite(uid))
            continue;
        entries.push({
            name,
            password: c[1] ?? "",
            uid,
            gid: parseInt(c[3] ?? "", 10),
            gecos: (c[4] ?? "").replace(/,*$/, ""),
            home: c[5] ?? "",
            shell: c[6] ?? "",
        });
    }
    return entries;
}

export interface GroupEntry {
    readonly name: string;
    readonly gid: number;
    /** Supplementary members (the fourth field), empty names removed. */
    readonly members: readonly string[];
}

/*
 * parse_group_content(). Upstream throws on a line with fewer than four
 * fields (c[3] undefined), which leaves the whole page loading forever; here
 * such a line simply has no members.
 */
export function parseGroups(content: string | null | undefined): GroupEntry[] {
    const groups: GroupEntry[] = [];
    for (const line of (content ?? "").trim().split("\n")) {
        if (!line)
            continue;
        const c = line.split(":");
        const name = c[0] ?? "";
        const gid = parseInt(c[2] ?? "", 10);
        if (!name || name.startsWith("+") || name.startsWith("-") || !Number.isFinite(gid))
            continue;
        groups.push({ name, gid, members: (c[3] ?? "").split(",").filter(member => member !== "") });
    }
    return groups;
}

/** parse_shells_content(): non-blank lines without a "#". */
export function parseShells(content: string | null | undefined): string[] {
    return (content ?? "").trim().split("\n").map(line => line.trim()).filter(line => line && !line.includes("#"));
}

// ---- login.defs ----------------------------------------------------------------

export interface LoginDefs {
    readonly uidMin: number;
    readonly uidMax: number;
    readonly gidMin: number;
    readonly gidMax: number;
    /** USERGROUPS_ENAB: useradd creates a group named after the user. Null when not set. */
    readonly userGroups: boolean | null;
}

/*
 * The UID range used to tell people from system accounts. Upstream's list
 * hard-codes 1000 and uses login.defs only for the create dialog (with 500 as
 * its fallback); here UID_MIN drives the list too, and 1000 -- what every
 * current distribution ships -- is the fallback for both.
 */
export const DEFAULT_LOGIN_DEFS: LoginDefs = { uidMin: 1000, uidMax: 60000, gidMin: 1000, gidMax: 60000, userGroups: null };

/*
 * users.js parses the four ranges with /^KEY\s+(\d+)/m and crashes when one
 * is missing; here each one falls back on its own.
 */
export function parseLoginDefs(content: string | null | undefined): LoginDefs {
    if (!content)
        return DEFAULT_LOGIN_DEFS;
    const number = (key: string, fallback: number) => {
        const match = content.match(new RegExp(`^\\s*${key}\\s+(\\d+)`, "m"));
        const value = match ? parseInt(match[1]!, 10) : NaN;
        return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    const groups = content.match(/^\s*USERGROUPS_ENAB\s+(\S+)/m);
    return {
        uidMin: number("UID_MIN", DEFAULT_LOGIN_DEFS.uidMin),
        uidMax: number("UID_MAX", DEFAULT_LOGIN_DEFS.uidMax),
        gidMin: number("GID_MIN", DEFAULT_LOGIN_DEFS.gidMin),
        gidMax: number("GID_MAX", DEFAULT_LOGIN_DEFS.gidMax),
        userGroups: groups ? /^yes$/i.test(groups[1]!) : null,
    };
}

// ---- accounts ---------------------------------------------------------------------

/** Membership in any of these makes an account an administrator (users.js `admins`). */
export const ADMIN_GROUPS: readonly string[] = ["sudo", "root", "wheel"];

/*
 * Shells that mean "this account does not log in". Upstream matches
 * /^(\/usr)?\/sbin\/nologin/ and exactly "/bin/false"; the merged-/usr
 * spellings of the same programs are added here, since on current
 * distributions /usr/bin/false and /bin/false are one file.
 */
const NO_LOGIN_SHELL = /^(\/usr)?\/s?bin\/(nologin|false)$/;

export function isNoLoginShell(shell: string): boolean {
    return NO_LOGIN_SHELL.test(shell);
}

/*
 * accounts-list.js: hidden are system accounts below the first regular UID
 * (root excepted) and accounts that cannot log in. They stay reachable: the
 * list can show them (h), and details work for every passwd entry.
 *
 * UID_MAX is deliberately not applied: an account above it was still created
 * on purpose (useradd -u), and hiding it would hide a real person.
 */
export function isSystemAccount(entry: Pick<PasswdEntry, "uid" | "shell">, uidMin: number): boolean {
    return (entry.uid < uidMin && entry.uid !== 0) || isNoLoginShell(entry.shell);
}

export interface Account extends PasswdEntry {
    /** The first GECOS field, the person's name. */
    readonly fullName: string;
    /** The primary group's name, if /etc/group has it. */
    readonly primaryGroup: string | null;
    /** Supplementary groups, in /etc/group order. */
    readonly groups: readonly string[];
    /*
     * Administrator groups the account is in, as a member or as its primary
     * group. Upstream counts the root group for everyone, so the system
     * accounts whose primary group is root (sync, shutdown, halt, operator)
     * show as administrators; being in that group grants no sudo, so here it
     * counts only for UID 0 itself.
     */
    readonly adminGroups: readonly string[];
    readonly system: boolean;
}

export function buildAccounts(passwd: readonly PasswdEntry[], groups: readonly GroupEntry[], uidMin: number): Account[] {
    const groupByGid = new Map<number, GroupEntry>();
    for (const group of groups)
        if (!groupByGid.has(group.gid))
            groupByGid.set(group.gid, group);
    const memberOf = new Map<string, string[]>();
    for (const group of groups)
        for (const member of group.members)
            (memberOf.get(member) ?? memberOf.set(member, []).get(member)!).push(group.name);

    return passwd.map(entry => {
        const primary = groupByGid.get(entry.gid) ?? null;
        const supplementary = [...new Set(memberOf.get(entry.name) ?? [])];
        const all = new Set([...(primary ? [primary.name] : []), ...supplementary]);
        return {
            ...entry,
            fullName: entry.gecos.split(",")[0] ?? "",
            primaryGroup: primary?.name ?? null,
            groups: supplementary,
            adminGroups: ADMIN_GROUPS.filter(group => all.has(group) && (group !== "root" || entry.uid === 0)),
            system: isSystemAccount(entry, uidMin),
        };
    });
}

/*
 * The group that grants the administrator role. Upstream only displays the
 * role (any of sudo/root/wheel); granting it needs one group to add people
 * to. Debian and its derivatives use "sudo", everyone else "wheel" --
 * upstream's own tests choose the same way (bots machine.py get_admin_group).
 */
export function adminGroupFor(groups: readonly GroupEntry[], osRelease: { ID?: string, ID_LIKE?: string } = {}): string | null {
    const family = `${osRelease.ID ?? ""} ${osRelease.ID_LIKE ?? ""}`.toLowerCase();
    const preferred = /\b(debian|ubuntu)\b/.test(family) ? ["sudo", "wheel"] : ["wheel", "sudo"];
    return preferred.find(name => groups.some(group => group.name === name)) ?? null;
}

// ---- login state ---------------------------------------------------------------

/*
 * Logged in means at least one session: logind's User.State is "online" or
 * "active". Upstream counts everything but "closing", which includes
 * "lingering" -- a user with Linger=yes and no session at all would show as
 * logged in and offer "Log user out".
 */
export function isLoggedInState(state: string | undefined): boolean {
    return state === "active" || state === "online";
}

/*
 * Whether processes of the user still run, as far as logind knows: open
 * sessions, sessions that are "closing" (logged out, but with
 * KillUserProcesses=no their programs live on), or with Linger=yes the
 * user's service manager ("lingering"). userdel refuses while any of them
 * run ("user bob is currently used by process N"), and loginctl
 * terminate-user ends them all -- so terminating is offered for every one of
 * these states, not only when logged in.
 */
export function hasProcessesState(state: string | undefined): boolean {
    return state !== undefined && state !== "offline";
}

export type LockState = "locked" | "unlocked" | "unknown";

/*
 * `passwd -S --all` (shadow-utils >= 4.14): "name L 2024-01-01 0 99999 7 -1",
 * status L (locked), NP (no password) or P (usable). libuser's single-user
 * form says LK/NP/PS instead.
 */
export function parsePasswdStatusAll(output: string): Map<string, boolean> {
    const locks = new Map<string, boolean>();
    for (const line of output.trim().split("\n")) {
        const fields = line.trim().split(/\s+/);
        if (fields[0] && fields[1])
            locks.set(fields[0], isLockedStatus(fields[1]));
    }
    return locks;
}

export function isLockedStatus(status: string): boolean {
    return status === "L" || status === "LK";
}

/** `passwd -S name`: the second field. Null when the output is not that. */
export function parsePasswdStatus(output: string): boolean | null {
    const status = output.trim().split(/\s+/)[1];
    return status ? isLockedStatus(status) : null;
}

/*
 * Output of SHADOW_LOCK_SCRIPT (scripts.ts): "name X" where X is the first
 * character of the password field. Upstream's fallback reads all of
 * /etc/shadow and calls a hash starting with "!" locked; the script applies
 * the same rule on the host, so no password hash ever reaches this client.
 */
export function parseShadowLocks(output: string): Map<string, boolean> {
    const locks = new Map<string, boolean>();
    for (const line of output.split("\n")) {
        const space = line.indexOf(" ");
        const name = space < 0 ? line : line.slice(0, space);
        if (name)
            locks.set(name, line.slice(space + 1).startsWith("!"));
    }
    return locks;
}

export function lockState(locks: ReadonlyMap<string, boolean> | null, name: string): LockState {
    const locked = locks?.get(name);
    return locked === undefined ? "unknown" : locked ? "locked" : "unlocked";
}

// ---- last login ------------------------------------------------------------------

/** lastlog2.py's JSON: {name: {time (s), tty, host}} -> name -> ms. */
export function parseLastlog2(output: string): Map<string, number> {
    const result = new Map<string, number>();
    const data = JSON.parse(output) as Record<string, { time?: unknown }>;
    for (const [name, entry] of Object.entries(data ?? {})) {
        const time = Number(entry?.time);
        if (Number.isFinite(time) && time > 0)
            result.set(name, time * 1000);
    }
    return result;
}

/*
 * Legacy `lastlog` (LC_ALL=C):
 *
 *   Username         Port     From             Latest
 *   root                                       **Never logged in**
 *   ric              pts/0    192.168.50.205   Fri Oct  2 17:12:02 -0600 2026
 *
 * The date is the last five tokens without the weekday. Upstream spawns
 * `date +%s -d` once per line to parse it; V8 parses this form exactly (the
 * spec verified the same epoch), so only lines it cannot parse are handed
 * back for `date`.
 */
export function parseLastlog(output: string): { times: Map<string, number>, unparsed: [string, string][] } {
    const times = new Map<string, number>();
    const unparsed: [string, string][] = [];
    for (const line of output.split("\n").slice(1)) {
        if (!line.trim() || line.includes("**Never logged in**"))
            continue;
        const fields = line.trim().split(/[ \t]+/);
        const name = fields[0];
        if (!name || fields.length < 6)
            continue;
        const text = fields.slice(-5).join(" ");
        const time = Date.parse(text);
        if (Number.isFinite(time))
            times.set(name, time);
        else
            unparsed.push([name, text]);
    }
    return { times, unparsed };
}

/** `date +%s` output to ms, or null. */
export function parseEpochSeconds(output: string): number | null {
    const trimmed = output.trim();
    if (!/^-?\d+$/.test(trimmed))
        return null;
    return parseInt(trimmed, 10) * 1000;
}

// ---- chage -l -------------------------------------------------------------------

export interface Expiry {
    /** "YYYY-MM-DD", "never", or "must change" (password must be changed). */
    readonly lastChange: string | null;
    readonly passwordExpires: string | null;
    readonly accountExpires: string | null;
    /** Maximum days between changes, as chage prints it. */
    readonly maxDays: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/*
 * chage prints calendar dates as "%b %d, %Y" ("Nov 01, 2026", a UTC day).
 * They are days, not instants, so they become "YYYY-MM-DD" text without ever
 * passing through a Date and a time zone that could move them by one.
 */
export function chageDate(value: string): string {
    const v = value.trim();
    if (/^never$/i.test(v))
        return "never";
    if (/password must be changed/i.test(v))
        return "must change";
    const match = v.match(/^([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})$/);
    const month = match ? MONTHS.indexOf(match[1]!) : -1;
    if (match && month >= 0)
        return `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v))
        return v; // chage -i
    return v;
}

/* account-details.js get_expire(), keeping the raw facts rather than sentences. */
export function parseChage(output: string): Expiry {
    let lastChange: string | null = null;
    let passwordExpires: string | null = null;
    let accountExpires: string | null = null;
    let maxDays: string | null = null;
    for (const line of output.split("\n")) {
        const at = line.indexOf(":");
        if (at < 0)
            continue;
        const key = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (key.startsWith("Last password change"))
            lastChange = chageDate(value);
        else if (key.startsWith("Password expires"))
            passwordExpires = chageDate(value);
        else if (key.startsWith("Account expires"))
            accountExpires = chageDate(value);
        else if (key.startsWith("Maximum number of days between password change"))
            maxDays = value;
    }
    return { lastChange, passwordExpires, accountExpires, maxDays };
}

// ---- last (login history) ---------------------------------------------------------

export interface LoginRecord {
    readonly start: number;
    /** Null while the session is still open. */
    readonly end: number | null;
    /** "still logged in", "crash", "down", "gone - no logout", ... when there is no end time. */
    readonly endText: string | null;
    readonly tty: string;
    readonly from: string;
}

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:?\d{2}|Z)/g;

/*
 * `last --time-format iso -n25 --fullnames <name>` (LC_ALL=C):
 *
 *   ric      pts/0        10.6.0.3         2026-09-25T18:12:22-06:00 - 2026-09-26T03:31:06-06:00  (09:18)
 *   ric      web console  ::ffff:1.2.3.4   2026-10-02T17:09:15-06:00   still logged in
 *
 * account-logs-panel.jsx keeps lines that merely contain the name
 * (so "eric" shows up in "ric"'s history), drops sessions that are still
 * open, and takes "From" as the fifth token from the end. Here the first
 * token must be the name, open sessions are kept (marked), and the fields
 * are found around the ISO timestamps. The terminal column can contain a
 * space ("web console"), so the host is the token just before the start time
 * -- for a local login without a host, that is the terminal, as upstream.
 * tmux/screen pseudo-logins are dropped, as upstream.
 */
export function parseLast(output: string, name: string): LoginRecord[] {
    const records: LoginRecord[] = [];
    for (const line of output.split("\n")) {
        const tokens = line.trim().split(/\s+/);
        if (tokens[0] !== name || line.includes("tmux") || line.includes("screen"))
            continue;
        const stamps = [...line.matchAll(ISO)];
        const first = stamps[0];
        if (!first || first.index === undefined)
            continue;
        const start = Date.parse(first[0]);
        if (!Number.isFinite(start))
            continue;
        const before = line.slice(0, first.index).trim().split(/\s+/);
        const from = before.length >= 3 ? before.at(-1)! : "";
        const tty = before.slice(1, before.length >= 3 ? -1 : undefined).join(" ");
        const second = stamps[1];
        let end: number | null = null;
        let endText: string | null = null;
        if (second) {
            end = Date.parse(second[0]);
            if (!Number.isFinite(end))
                continue;
        } else {
            const rest = line.slice(first.index + first[0].length).replace(/\(.*\)\s*$/, "").replace(/^\s*-\s*/, "").trim();
            endText = rest || null;
        }
        records.push({ start, end, endText, tty, from });
    }
    return records;
}

// ---- authorized keys ---------------------------------------------------------------

export interface AuthorizedKey {
    /** The line in authorized_keys. */
    readonly raw: string;
    readonly valid: boolean;
    readonly size: string | null;
    readonly fingerprint: string | null;
    readonly comment: string | null;
    readonly algorithm: string | null;
}

/* "2048 SHA256:AAAA... Comment Here (RSA)" (authorized-keys.js PUBKEY_RE). */
const PUBKEY_RE = /^(\S+)\s+(\S+)\s+(.*)\((\S+)\)$/;

/*
 * The lister script's output: for every key line, ssh-keygen's verdict and
 * then the line itself (authorized-keys.js parse_pubkeys()). A comment-less
 * key is named by its first two fields, as upstream ("ssh-ed25519 AAAA...").
 */
export function parseKeyList(output: string): AuthorizedKey[] {
    const lines = output.split("\n");
    const keys: AuthorizedKey[] = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
        const raw = lines[i + 1]!;
        const match = lines[i]!.trim().match(PUBKEY_RE);
        let comment: string | null = match ? match[3]!.trim() : null;
        if (comment === "authorized_keys" || comment === "no comment")
            comment = null;
        if (match && !comment && raw)
            comment = raw.split(" ").slice(0, 2).join(" ") || null;
        keys.push({
            raw,
            valid: Boolean(match) && Boolean(raw),
            size: match ? match[1]! : null,
            fingerprint: match ? match[2]! : null,
            comment,
            algorithm: match ? match[4]! : null,
        });
    }
    return keys;
}

const KEY_TYPE = /^(ssh-(rsa|dss|ed25519|ed448)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/;

/*
 * Shape check before a key is handed to ssh-keygen. The text field flattens
 * a pasted multi-line file into one line, and ssh-keygen would accept its
 * first key and take everything after it as the comment -- so a second key
 * type anywhere after the first is refused. Options before the type
 * ("from=... ssh-ed25519 AAAA...") are allowed, as in authorized_keys.
 */
export function checkKeyText(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed)
        return "Paste a public key, e.g. the contents of ~/.ssh/id_ed25519.pub.";
    if (/-----BEGIN/.test(trimmed) || /PRIVATE KEY/.test(trimmed))
        return "That is a private key. Paste the public key (the .pub file) instead.";
    const tokens = trimmed.split(/\s+/);
    const typeAt = tokens.findIndex(token => KEY_TYPE.test(token));
    if (typeAt < 0)
        return "This does not look like an SSH public key (no key type such as ssh-ed25519 or ssh-rsa).";
    if (!tokens[typeAt + 1] || !/^[A-Za-z0-9+/]+={0,3}$/.test(tokens[typeAt + 1]!))
        return "The key data after the key type is missing or damaged.";
    if (tokens.slice(typeAt + 2).some(token => KEY_TYPE.test(token)))
        return "Only one key at a time: the text contains more than one key.";
    return null;
}

/*
 * The new content of authorized_keys without `raw` (its first occurrence).
 *
 * authorized-keys.js remove_key() trims the file, drops the line and joins
 * the rest without a final newline, deleting the file (null) when nothing
 * is left. Here every other line (comments, blank lines) is kept as it was,
 * the final newline stays, and an empty result stays an empty file rather
 * than a deletion. Returns null when the key is not in the content.
 *
 * `raw` is the line as the lister read it: `while read -r line` drops the
 * spaces and tabs around it (and a CRLF file leaves a "\r" at its end), so
 * lines are compared without what surrounds them.
 */
export function removeKeyLine(content: string, raw: string): string | null {
    const lines = content.split("\n");
    const trailing = content.endsWith("\n");
    if (trailing)
        lines.pop();
    const wanted = raw.trim();
    const at = wanted ? lines.findIndex(line => line.trim() === wanted) : -1;
    if (at < 0)
        return null;
    lines.splice(at, 1);
    if (lines.length === 0)
        return "";
    return lines.join("\n") + (trailing ? "\n" : "");
}

/*
 * Whether removing `raw` (its first occurrence, as removeKeyLine() does)
 * leaves no usable key: lines ssh-keygen rejected do not let anyone in, and
 * a duplicated line still leaves its twin behind.
 */
export function isLastKey(keys: readonly AuthorizedKey[], raw: string): boolean {
    const at = keys.findIndex(key => key.raw === raw);
    return !keys.some((key, i) => i !== at && key.valid);
}

// ---- forms --------------------------------------------------------------------------

/** dialog-utils.js is_valid_char_name(). */
export function isValidNameChar(c: string): boolean {
    return /^[a-zA-Z0-9._-]$/.test(c);
}

/* account-create-dialog.js suggest_username(), diacritics table and all. */
export function suggestUsername(fullName: string): string {
    const table: Record<string, string> = {
        a: "[àáâãäå]", ae: "æ", c: "[čç]", d: "ď", e: "[èéêë]", i: "[íìïî]", l: "[ĺľ]", n: "[ňñ]",
        o: "[òóôõö]", oe: "œ", r: "[ŕř]", s: "š", t: "ť", u: "[ùúůûűü]", y: "[ýÿ]", z: "ž",
    };
    const words = fullName.trim().split(/\s+/).filter(Boolean);
    let result = "";
    if (words.length === 1)
        result = words[0]!.toLowerCase();
    else if (words.length > 1)
        result = words[0]![0]!.toLowerCase() + words.at(-1)!.toLowerCase();
    for (const [plain, pattern] of Object.entries(table))
        result = result.replace(new RegExp(pattern, "g"), plain);
    return [...result].filter(isValidNameChar).join("").replace(/^-+/, "");
}

/** Longest user name useradd accepts (the utmp ut_user field). */
export const USER_NAME_MAX = 32;

/*
 * validate_username(), plus what upstream leaves to useradd to reject with a
 * less helpful message:
 *  - uniqueness is checked against every passwd entry, not only the listed
 *    ones (upstream misses hidden system accounts);
 *  - a leading "-" would be taken as an option by useradd's argument parser;
 *  - with USERGROUPS_ENAB, an existing group of the same name makes useradd
 *    fail ("group x exists - if you want to add this user to that group, use
 *    -g").
 */
export function validateUsername(name: string, passwd: readonly PasswdEntry[], groups: readonly GroupEntry[],
                                 userGroups: boolean | null): string | null {
    if (!name)
        return "No user name specified";
    if (![...name].every(isValidNameChar))
        return "The user name can only consist of letters from a-z, digits, dots, dashes and underscores.";
    if (name.startsWith("-"))
        return "The user name must not start with a dash.";
    if (/^\d+$/.test(name))
        return "The user name must not be a number.";
    if (name.length > USER_NAME_MAX)
        return `The user name must be at most ${USER_NAME_MAX} characters long.`;
    if (passwd.some(entry => entry.name === name))
        return "This user name already exists";
    if (userGroups && groups.some(group => group.name === name))
        return `A group named ${name} already exists; useradd would refuse to create the account.`;
    return null;
}

/*
 * validate_real_name() requires a name and refuses ":"; here the full name
 * is optional (useradd does not need one), and line breaks are refused too.
 */
export function validateFullName(fullName: string): string | null {
    if (fullName.includes(":"))
        return "The full name must not contain colons.";
    if (/[\n\r]/.test(fullName))
        return "The full name must be a single line.";
    return null;
}

export const PASSWORD_MAX = 256;

export interface PasswordErrors {
    password?: string;
    confirm?: string;
}

export function validatePasswords(password: string, confirm: string, required: boolean): PasswordErrors {
    const errors: PasswordErrors = {};
    if (!password && required)
        errors.password = "Empty password";
    else if (password.length > PASSWORD_MAX)
        errors.password = `Password is longer than ${PASSWORD_MAX} characters`;
    if (confirm !== password)
        errors.confirm = "The passwords do not match";
    return errors;
}

// ---- groups ------------------------------------------------------------------------------

export interface GroupInfo extends GroupEntry {
    /* Accounts whose primary group this is, from all of /etc/passwd (hidden ones too). */
    readonly primary: readonly string[];
    /** Distinct accounts in the group, primary or supplementary. */
    readonly count: number;
    /** Membership grants the administrator role (wheel, sudo). */
    readonly admin: boolean;
    /*
     * Between GID_MIN and GID_MAX: made for people, not by a package.
     * Upstream offers rename and delete only for these, and so does this.
     */
    readonly userCreated: boolean;
}

/*
 * users.js groupsExtraInfo. Upstream counts a member twice when the group is
 * both their primary and a supplementary one; here each account counts once.
 * The root group is not an administrator group here (see buildAccounts()).
 */
export function buildGroups(groups: readonly GroupEntry[], passwd: readonly PasswdEntry[], defs: LoginDefs): GroupInfo[] {
    return groups.map(group => {
        const primary = passwd.filter(entry => entry.gid === group.gid).map(entry => entry.name);
        return {
            ...group,
            primary,
            count: new Set([...primary, ...group.members]).size,
            admin: group.name !== "root" && ADMIN_GROUPS.includes(group.name),
            userCreated: group.gid >= defs.gidMin && group.gid <= defs.gidMax,
        };
    });
}

export type GroupSortKey = "kind" | "name" | "gid" | "count";

/* Administrator groups, then the ones made for people, then the system's. */
function kindRank(group: GroupInfo): number {
    return group.admin ? 0 : group.userCreated ? 1 : 2;
}

/*
 * "kind" is the default: like upstream's order, which pins the
 * administrator groups first, it puts the groups an admin deals with on top
 * of the dozens a distribution ships. Ties fall back on the name, so every
 * order is total (upstream's comparator is not: spec gotcha 14).
 */
export function sortGroups(groups: readonly GroupInfo[], key: GroupSortKey, reverse: boolean): GroupInfo[] {
    const compare = (a: GroupInfo, b: GroupInfo): number => {
        const order = key === "gid" ? a.gid - b.gid
            : key === "count" ? b.count - a.count
                : key === "kind" ? kindRank(a) - kindRank(b) : 0;
        return order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    };
    return [...groups].sort((a, b) => (reverse ? -compare(a, b) : compare(a, b)));
}

/* accounts-list.js group filter: a substring of the name or of the GID. */
export function matchesGroupFilter(group: GroupInfo, text: string): boolean {
    const needle = text.trim().toLowerCase();
    return !needle || group.name.toLowerCase().includes(needle) || String(group.gid).includes(needle);
}

/*
 * The GID to offer for a new group: what groupadd itself would pick (shadow
 * find_new_gid): one above the highest GID in use within [GID_MIN, GID_MAX],
 * or GID_MIN; past GID_MAX, the lowest free one in the range. Upstream offers
 * the highest + 2 (group-create-dialog.js adds one twice, spec gotcha 11).
 * Null when the range is full.
 */
export function nextGid(groups: readonly GroupEntry[], defs: LoginDefs): number | null {
    const used = new Set(groups.map(group => group.gid));
    const inRange = [...used].filter(gid => gid >= defs.gidMin && gid <= defs.gidMax);
    const next = inRange.length ? Math.max(...inRange) + 1 : defs.gidMin;
    if (next <= defs.gidMax)
        return next;
    for (let gid = defs.gidMin; gid <= defs.gidMax; gid++)
        if (!used.has(gid))
            return gid;
    return null;
}

/*
 * group-create-dialog.js validate_name(), plus what groupadd would refuse:
 * a leading "-", an all-digit name, more than 32 characters. Checked
 * against every group, as the dialog sees all of /etc/group.
 */
export function validateGroupName(name: string, groups: readonly GroupEntry[]): string | null {
    if (!name)
        return "No group name specified";
    if (![...name].every(isValidNameChar))
        return "The group name can only consist of letters from a-z, digits, dots, dashes and underscores.";
    if (name.startsWith("-"))
        return "The group name must not start with a dash.";
    if (/^\d+$/.test(name))
        return "The group name must not be a number.";
    if (name.length > USER_NAME_MAX)
        return `The group name must be at most ${USER_NAME_MAX} characters long.`;
    if (groups.some(group => group.name === name))
        return "This group name already exists";
    return null;
}

/*
 * The GID field of the create dialog: empty lets groupadd choose. Upstream
 * only checks for a non-negative integer and leaves duplicates to groupadd
 * ("GID '0' already exists"); /etc/group is at hand, so here it says so first.
 */
export function validateGid(text: string, groups: readonly GroupEntry[]): string | null {
    const value = text.trim();
    if (!value)
        return null;
    if (!/^\d+$/.test(value) || Number(value) > 2147483647)
        return "The group ID must be a number from 0 to 2147483647.";
    const owner = groups.find(group => group.gid === Number(value));
    return owner ? `The group ID ${value} is already used by ${owner.name}.` : null;
}

// ---- list ------------------------------------------------------------------------------

export type SortKey = "name" | "uid" | "login";

export interface LoginFacts {
    readonly loggedIn: boolean;
    /** Milliseconds, or null when never / unknown. */
    readonly lastLogin: number | null;
}

/*
 * accounts-list.js sortRows(): the current user always first; "last active"
 * puts logged-in accounts first and never-logged-in last, newest first in
 * between. Ties fall back on the name so the order is total.
 */
export function sortAccounts<T extends Pick<Account, "name" | "uid">>(
    accounts: readonly T[], key: SortKey, reverse: boolean, current: string | null,
    facts: (account: T) => LoginFacts,
): T[] {
    const byName = (a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const rank = (a: T): number => {
        const f = facts(a);
        return f.loggedIn ? Number.POSITIVE_INFINITY : f.lastLogin ?? Number.NEGATIVE_INFINITY;
    };
    const compare = (a: T, b: T): number => {
        let order = 0;
        if (key === "uid")
            order = a.uid - b.uid;
        else if (key === "login") {
            const ra = rank(a);
            const rb = rank(b);
            order = ra === rb ? 0 : ra > rb ? -1 : 1;
        }
        return order || byName(a, b);
    };
    const sorted = [...accounts].sort((a, b) => (reverse ? -compare(a, b) : compare(a, b)));
    if (current) {
        const at = sorted.findIndex(account => account.name === current);
        if (at > 0)
            sorted.unshift(...sorted.splice(at, 1));
    }
    return sorted;
}

/*
 * Accounts in a remembered order of names (an earlier sortAccounts() result,
 * unreversed): names it does not know go last, by name. `reverse` and the
 * current user first, as sortAccounts() does them.
 */
export function sortByOrder<T extends Pick<Account, "name">>(
    accounts: readonly T[], order: readonly string[], reverse: boolean, current: string | null,
): T[] {
    const at = new Map(order.map((name, i) => [name, i]));
    const rank = (account: T) => at.get(account.name) ?? order.length;
    const compare = (a: T, b: T): number => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const sorted = [...accounts].sort((a, b) => (reverse ? -compare(a, b) : compare(a, b)));
    if (current) {
        const first = sorted.findIndex(account => account.name === current);
        if (first > 0)
            sorted.unshift(...sorted.splice(first, 1));
    }
    return sorted;
}

/*
 * accounts-list.js filter: case-insensitive substring of the name, the GECOS
 * field, the UID, or a supplementary group's name.
 */
export function matchesFilter(account: Account, text: string): boolean {
    const needle = text.trim().toLowerCase();
    if (!needle)
        return true;
    return account.name.toLowerCase().includes(needle) ||
        account.gecos.toLowerCase().includes(needle) ||
        String(account.uid).includes(needle) ||
        account.groups.some(group => group.toLowerCase().includes(needle));
}
