/*
 * Everything the Accounts page runs on the host, as plain promises.
 *
 * Argv and channel options follow upstream byte for byte (cockpit 356
 * pkg/users), so an action does here exactly what the web console does; the
 * comment on each says where it comes from, and where this deliberately
 * differs.
 *
 * Privilege: actions use superuser "require" (refused with access-denied
 * unless administrative access is on) except where upstream uses "try" --
 * the views only offer an action when it can work.
 */
import cockpit from "../../cockpit.js";
import { LISTER, ADDER, PYTHON_INVOKE, LASTLOG2_PY, SHADOW_LOCK_SCRIPT } from "./scripts.js";
import {
    parseKeyList, parseLastlog, parseLastlog2, parseEpochSeconds, parsePasswdStatus, parsePasswdStatusAll,
    parseShadowLocks, removeKeyLine, type AuthorizedKey,
} from "./model.js";

// ---- running commands ----------------------------------------------------------

export interface CommandOptions {
    superuser?: "try" | "require";
    /** Default "message": stderr arrives in the close message. */
    err?: "message" | "out" | "ignore";
    environ?: string[];
}

export interface CommandResult {
    readonly stdout: string;
    /** stderr of a successful run (warnings), with err "message". */
    readonly stderr: string;
}

/** A failed command: the host's own words in `message`. */
export class CommandError extends Error {
    readonly problem: string | null;
    readonly exitStatus: number | null;

    constructor(message: string, problem: string | null, exitStatus: number | null) {
        super(message);
        this.name = "CommandError";
        this.problem = problem;
        this.exitStatus = exitStatus;
    }
}

interface RawProcessError {
    problem?: string | null;
    exit_status?: number | null;
    exit_signal?: number | null;
    message?: string;
}

/*
 * Run argv, optionally feeding `input` to its stdin (then EOF).
 *
 * Why not hooks.ts run(): with err "out" the bridge closes with an empty
 * "message", so the ProcessError carries no text at all -- the merged output
 * arrives only as the deferred's second fail() argument, which a plain
 * promise drops (spec gotcha 7; chpasswd's errors were lost that way). This
 * keeps it: a failure's message is stderr, else that output, else a
 * description of the exit.
 */
export function exec(argv: readonly string[], options: CommandOptions = {}, input?: string,
                     signal?: AbortSignal): Promise<CommandResult> {
    const proc = cockpit.spawn([...argv], { err: "message", ...options });
    if (input !== undefined)
        proc.input(input);
    // A block body on purpose: close() returns the spawn's own promise,
    // and Node's EventTarget re-raises a rejection of a promise that a
    // listener returns as an uncaught exception.
    const cancel = () => {
        proc.close("cancelled");
    };
    if (signal?.aborted)
        cancel();
    else if (signal) {
        signal.addEventListener("abort", cancel, { once: true });
        // A signal that outlives many commands (the page's own) must not
        // collect a listener per command.
        proc.always(() => signal.removeEventListener("abort", cancel));
    }
    return new Promise<CommandResult>((resolve, reject) => {
        proc.done((stdout, message) => resolve({ stdout, stderr: message ?? "" }));
        proc.fail((exc, output) => {
            const error = exc as unknown as RawProcessError;
            const status = typeof error.exit_status === "number" ? error.exit_status : null;
            let text = (error.message ?? "").trim();
            if (!text && output)
                text = output.trim();
            if (!text) {
                text = status !== null && status < 0
                    ? `${argv[0]} was killed by signal ${-status}`
                    : status !== null
                        ? `${argv[0]} exited with code ${status}`
                        : error.problem ?? `${argv[0]} failed`;
            }
            reject(new CommandError(text, error.problem ?? null, status));
        });
    });
}

/** Is this the refusal of a "require" channel without administrative access? */
export function isAccessDenied(error: unknown): boolean {
    return (error as { problem?: unknown } | null)?.problem === "access-denied";
}

function isCancelled(error: unknown): boolean {
    const problem = (error as { problem?: unknown } | null)?.problem;
    return problem === "cancelled" || problem === "terminated";
}

// ---- reading -----------------------------------------------------------------------

/*
 * Lock state of every account (users.js getLoginDetails, "locked password").
 *
 * `passwd -S --all` exists in shadow-utils >= 4.14; RHEL's libuser passwd
 * answers "bad argument --all". Upstream then reads all of /etc/shadow into
 * the browser; the fallback here is SHADOW_LOCK_SCRIPT, which applies the
 * same rule on the host and sends only one character per account (see
 * scripts.ts). Upstream falls back only on "bad argument --all"; here any
 * failure other than a refusal falls back (passwd may be missing entirely).
 */
export async function readLockStates(signal?: AbortSignal): Promise<Map<string, boolean>> {
    try {
        const { stdout } = await exec(["passwd", "-S", "--all"],
                                      { superuser: "require", err: "message", environ: ["LC_ALL=C"] }, undefined, signal);
        return parsePasswdStatusAll(stdout);
    } catch (error) {
        if (isAccessDenied(error) || isCancelled(error) || signal?.aborted)
            throw error;
    }
    const { stdout } = await exec(["sh", "-c", SHADOW_LOCK_SCRIPT], { superuser: "require", err: "message" }, undefined, signal);
    return parseShadowLocks(stdout);
}

/* utils.js get_locked(): one account, after changing it. Null when unreadable. */
export async function readLockState(name: string): Promise<boolean | null> {
    try {
        const { stdout } = await exec(["passwd", "-S", name], { environ: ["LC_ALL=C"], superuser: "require" });
        return parsePasswdStatus(stdout);
    } catch {
        return null;
    }
}

export type LastLoginSource = "lastlog2" | "lastlog";

/*
 * Last login per account name, in ms (users.js getLoginDetails, "last logged
 * in"): the lastlog2 database if the system has one, else legacy lastlog.
 * Upstream runs `date` once per lastlog line to parse its dates; here that
 * happens only for dates the JavaScript parser cannot read, capped.
 *
 * `known` is the source that answered last time: a system on legacy lastlog
 * is not probed for lastlog2 again on every refresh (one Python start each).
 */
export async function readLastLogins(known: LastLoginSource | null = null, signal?: AbortSignal):
    Promise<{ times: Map<string, number>, source: LastLoginSource }> {
    if (known !== "lastlog") {
        try {
            const { stdout } = await exec([...PYTHON_INVOKE, LASTLOG2_PY], { err: "message" }, undefined, signal);
            return { times: parseLastlog2(stdout), source: "lastlog2" };
        } catch (error) {
            if (signal?.aborted)
                throw error;
        }
    }
    const { stdout } = await exec(["lastlog"], { environ: ["LC_ALL=C"] }, undefined, signal);
    const { times, unparsed } = parseLastlog(stdout);
    for (const [name, text] of unparsed.slice(0, 20)) {
        try {
            const out = await exec(["date", "+%s", "-d", text], { environ: ["LC_ALL=C"], err: "out" }, undefined, signal);
            const time = parseEpochSeconds(out.stdout);
            if (time !== null)
                times.set(name, time);
        } catch {
            if (signal?.aborted)
                throw new CommandError("cancelled", "cancelled", null);
        }
    }
    return { times, source: "lastlog" };
}

// ---- password quality ------------------------------------------------------------------

export type Quality = { ok: true } | { ok: false, message: string };

/*
 * lib/cockpit-components-password.tsx password_quality(): pwscore reads the
 * password on stdin (no newline) and prints a score, or fails with the
 * reason. A host without pwscore (problem "not-found") is not a reason to
 * refuse every password: then there is simply no quality check.
 */
export async function checkPasswordQuality(password: string): Promise<Quality> {
    try {
        const { stdout } = await exec(["/usr/bin/pwscore"], { err: "message" }, password);
        if (parseInt(stdout, 10) === 0)
            return { ok: false, message: "Password is too weak" };
        return { ok: true };
    } catch (error) {
        const e = error as CommandError;
        if (e.problem === "not-found")
            return { ok: true };
        return { ok: false, message: (e.message || "Password is not acceptable").replace(/\s*\n\s*/g, " ") };
    }
}

// ---- account actions ------------------------------------------------------------------

/*
 * password-dialogs.js passwd_change(): chpasswd reads "user:password" (no
 * newline) as root. err "out", as upstream -- exec() keeps the text.
 */
export function setPassword(user: string, password: string): Promise<CommandResult> {
    return exec(["chpasswd"], { superuser: "require", err: "out" }, `${user}:${password}`);
}

/* password-dialogs.js reset_password_dialog(). */
export function expirePassword(user: string): Promise<CommandResult> {
    return exec(["passwd", "-e", user], { superuser: "require", err: "message" });
}

/*
 * account-details.js change_locked(): usermod --lock/--unlock, then check
 * with passwd -S and try once more if the state did not take (upstream's
 * workaround for cockpit#1216 / rhbz#853153). Resolves with the state
 * passwd -S reports afterwards, null if it could not be read.
 */
export async function setLocked(user: string, locked: boolean): Promise<boolean | null> {
    const argv = ["/usr/sbin/usermod", user, locked ? "--lock" : "--unlock"];
    await exec(argv, { superuser: "require", err: "message" });
    let state = await readLockState(user);
    if (state === !locked) {
        await exec(argv, { superuser: "require", err: "message" });
        state = await readLockState(user);
    }
    return state;
}

/* account-details.js AccountGroupsSelect addGroup()/removeGroup(). */
export function setMembership(user: string, group: string, member: boolean): Promise<CommandResult> {
    return exec(["gpasswd", member ? "-a" : "-d", user, group], { superuser: "require", err: "message" });
}

/* logout-account-dialog.js / account-details.js logout_account(): "try", as upstream. */
export function terminateUser(user: string): Promise<CommandResult> {
    return exec(["loginctl", "terminate-user", user], { superuser: "try", err: "message" });
}

/* delete-account-dialog.js: -r removes the home directory and mail spool. */
export function deleteAccount(user: string, removeFiles: boolean): Promise<CommandResult> {
    return exec(["/usr/sbin/userdel", ...(removeFiles ? ["-r"] : []), user], { superuser: "require", err: "message" });
}

export interface NewAccount {
    readonly user: string;
    readonly fullName: string;
    /** Empty: no password is set (only allowed together with `lock`). */
    readonly password: string;
    /** Add to this administrator group, if any. */
    readonly adminGroup: string | null;
    readonly lock: boolean;
    readonly forceChange: boolean;
}

/*
 * account-create-dialog.js create(): useradd, then chpasswd, then lock or
 * expire. The dialog here asks for less than upstream's (no home directory,
 * shell or UID fields), so useradd picks its own defaults for those -- the
 * values in /etc/default/useradd and login.defs, i.e. exactly what upstream
 * pre-fills -- and `-s/-u/-d` are not passed. The administrator role is
 * granted by useradd itself (-G), so that step cannot half-fail.
 */
export function useraddArgv(account: Pick<NewAccount, "user" | "fullName" | "adminGroup">): string[] {
    const argv = ["useradd", "--create-home"];
    if (account.fullName)
        argv.push("-c", account.fullName);
    if (account.adminGroup)
        argv.push("-G", account.adminGroup);
    argv.push(account.user);
    return argv;
}

export type CreateStep = "useradd" | "password" | "lock" | "expire";

/*
 * Creating an account is several commands and is not atomic (spec gotcha
 * 9): if a step after useradd fails, the account exists. That is reported
 * as such -- `created` -- so the caller says what state the account is in
 * instead of offering a retry that would fail with "user already exists".
 */
export class CreateError extends Error {
    readonly step: CreateStep;
    readonly created: boolean;

    constructor(step: CreateStep, created: boolean, cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = "CreateError";
        this.step = step;
        this.created = created;
    }
}

export async function createAccount(account: NewAccount, progress: (step: CreateStep) => void): Promise<string[]> {
    const warnings: string[] = [];
    const step = async (name: CreateStep, run: () => Promise<CommandResult>) => {
        progress(name);
        try {
            const result = await run();
            if (result.stderr.trim())
                warnings.push(result.stderr.trim());
        } catch (error) {
            throw new CreateError(name, name !== "useradd", error);
        }
    };

    await step("useradd", () => exec(useraddArgv(account), { superuser: "require", err: "message" }));
    // Without a password the account keeps useradd's disabled one ("!!" or
    // "!"), which passwd -S already reports as locked: nothing to lock.
    if (account.password)
        await step("password", () => setPassword(account.user, account.password));
    if (account.lock && account.password)
        await step("lock", () => exec(["usermod", account.user, "--lock"], { superuser: "require", err: "message" }));
    else if (account.forceChange && !account.lock)
        await step("expire", () => exec(["passwd", "-e", account.user], { superuser: "require", err: "message" }));
    return warnings;
}

// ---- groups ------------------------------------------------------------------------------

/*
 * group-create-dialog.js: `groupadd <name> -g <gid>`. Upstream always passes
 * a GID; here an empty one lets groupadd pick (it picks what nextGid()
 * offers, so the dialog's default makes no difference).
 */
export function createGroup(name: string, gid: string): Promise<CommandResult> {
    return exec(["groupadd", name, ...(gid ? ["-g", gid] : [])], { superuser: "require", err: "message" });
}

/*
 * delete-group-dialog.js: -f ("Force delete") when the group is someone's
 * primary group, which groupdel otherwise refuses.
 */
export function deleteGroup(name: string, force: boolean): Promise<CommandResult> {
    return exec(["groupdel", ...(force ? ["-f"] : []), name], { superuser: "require", err: "message" });
}

/* rename-group-dialog.jsx. */
export function renameGroup(name: string, newName: string): Promise<CommandResult> {
    return exec(["groupmod", name, "--new-name", newName], { superuser: "require", err: "message" });
}

// ---- authorized keys ---------------------------------------------------------------------

/*
 * authorized-keys.js parse_pubkeys(): ssh-keygen's view of each key line.
 * Runs unprivileged on the content handed to it.
 */
export async function listKeys(content: string): Promise<AuthorizedKey[]> {
    const { stdout } = await exec(["/bin/sh", "-c", LISTER, "--"], {}, content + "\n");
    return parseKeyList(stdout);
}

/*
 * The adder's argv: run as the account whose home it writes to. Your own
 * account: as yourself, the bridge's user. Someone else's (administrative
 * access): root starts it and runuser drops to that account at once.
 *
 * Deliberately not upstream's way (authorized-keys.js add_key(): the
 * script as root with superuser "try", chowning as it goes), which follows
 * whatever symlinks the account planted in its own home; see scripts.ts.
 * `runuser -u` runs the command itself, not the account's login shell, so a
 * nologin shell is no obstacle.
 */
export function adderArgv(user: string, home: string, self: boolean): { argv: string[], options: CommandOptions } {
    const script = ["/bin/sh", "-c", ADDER, "--", home];
    return self
        ? { argv: script, options: { err: "message" } }
        : { argv: ["runuser", "-u", user, "--", ...script], options: { superuser: "require", err: "message" } };
}

/*
 * authorized-keys.js add_key(): the first key in `text` must be one
 * ssh-keygen accepts; then the adder appends it, as the account (adderArgv).
 */
export async function addKey(user: string, home: string, text: string, self: boolean): Promise<AuthorizedKey> {
    // Without an absolute home the script would work on "/.ssh" or relative to wherever it starts.
    if (!home.startsWith("/"))
        throw new CommandError(`${user} has no home directory to keep SSH keys in.`, null, null);
    const keys = await listKeys(text.trim());
    const key = keys[0];
    if (!key?.valid)
        throw new CommandError("The key you provided was not valid.", null, null);
    const { argv, options } = adderArgv(user, home, self);
    try {
        await exec(argv, options, key.raw + "\n");
    } catch (error) {
        throw new CommandError(`Error saving authorized keys: ${(error as Error).message}`, null, null);
    }
    return key;
}

/** The parts of a cockpit.file handle removal uses. */
/*
 * The key file is rewritten as root (with administrative access), in a
 * directory the account owns: a planted symlink (~/.ssh -> /root/.ssh, or
 * authorized_keys -> any file) would have root rewrite the link's target.
 * Refuse unless ~/.ssh/authorized_keys resolves to just that under the
 * resolved home directory (which may itself be a link, as /home is on some
 * systems). Upstream does not check.
 */
export async function checkKeysPath(home: string): Promise<void> {
    const dir = home.replace(/\/+$/, "");
    const path = `${dir}/.ssh/authorized_keys`;
    const { stdout } = await exec(["realpath", "-e", "--", dir, path], { superuser: "try", err: "message" });
    const [realHome, realPath] = stdout.split("\n");
    if (!realHome || realPath !== `${realHome.replace(/\/+$/, "")}/.ssh/authorized_keys`)
        throw new CommandError(`${path} is a symbolic link (to ${realPath || "nothing"}), or is in one: not changed.`, null, null);
}

export interface KeysFile {
    read(): unknown;
    replace(content: string | null, tag?: string): Promise<string>;
}

/* Read with the tag, which file.read()'s promise does not pass on. */
function readWithTag(file: KeysFile): Promise<{ content: string | null, tag: string | null }> {
    return new Promise((resolve, reject) => {
        const promise = file.read() as {
            done(callback: (content: string | null, tag: string | null) => void): unknown,
            fail(callback: (error: unknown) => void): unknown,
        };
        promise.done((content, tag) => resolve({ content, tag }));
        promise.fail(error => reject(error));
    });
}

/*
 * authorized-keys.js remove_key(), with the edit of model.ts removeKeyLine():
 * read with the tag, write back with it (fsreplace1 then keeps owner, mode
 * and SELinux label), and start over if the file changed in between. Unlike
 * file.modify() this can refuse: a key that is no longer there is an error,
 * not a rewrite of unchanged content.
 */
export async function removeKey(file: KeysFile, raw: string, home?: string): Promise<void> {
    if (home)
        await checkKeysPath(home);
    for (let attempt = 0; ; attempt++) {
        const { content, tag } = await readWithTag(file);
        const next = content === null ? null : removeKeyLine(content, raw);
        if (next === null)
            throw new CommandError("The key is no longer in the file.", null, null);
        try {
            await file.replace(next, tag ?? undefined);
            return;
        } catch (error) {
            if ((error as { problem?: unknown }).problem !== "change-conflict" || attempt >= 3)
                throw error;
        }
    }
}
