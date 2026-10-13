/*
 * The Accounts page's live data, as hooks.
 *
 * Sources (cockpit 356 pkg/users/users.js, account-details.js and friends):
 *
 *   /etc/passwd, /etc/group, /etc/shells, login.defs   watched files
 *   logind (system bus)                                 who is logged in, sessions
 *   passwd -S --all / the shadow lock script            lock state (needs root)
 *   lastlog2 database or lastlog                        last login
 *   chage -l, last, ~/.ssh/authorized_keys              per-account details
 *
 * Unlike upstream, the list never waits for the slow parts: rows appear as
 * soon as /etc/passwd and /etc/group are read, and the login columns fill in
 * when their answers arrive.
 *
 * Everything here is opened by the page's components and closed when they
 * unmount; the page is remounted when administrative access changes, so the
 * privileged reads are simply redone then.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import cockpit from "../../cockpit.js";
import { useAsync, useFile, useMounted, useSignal, unvariant, type DBusClient } from "../../tui/hooks.js";
import {
    exec, isAccessDenied, readLastLogins, readLockStates, listKeys, type KeysFile, type LastLoginSource,
} from "./actions.js";
import {
    parseChage, parseGroups, parseLast, parseLoginDefs, parsePasswd, parseShells,
    type AuthorizedKey, type Expiry, type GroupEntry, type LoginDefs, type LoginRecord, type PasswdEntry,
} from "./model.js";

// ---- files -----------------------------------------------------------------------

export interface AccountFiles {
    /** Null until read. */
    readonly passwd: PasswdEntry[] | null;
    readonly groups: GroupEntry[] | null;
    readonly shells: string[];
    readonly loginDefs: LoginDefs;
    /** Why /etc/passwd or /etc/group cannot be shown, if it cannot. */
    readonly error: string | null;
}

function fileError(path: string, error: unknown): string {
    const e = error as { message?: unknown, problem?: unknown } | null;
    const text = typeof e?.message === "string" && e.message ? e.message
        : typeof e?.problem === "string" ? e.problem : String(error);
    return `Cannot read ${path}: ${text}`;
}

/*
 * users.js reads the files with cockpit.file().watch(), unprivileged, and
 * login.defs from /etc or, when that does not exist, /usr/etc (the
 * "hermetic /usr" layout). Hooks cannot be conditional, so both login.defs
 * locations are watched and /etc wins; a missing one costs one fsinfo.
 */
export function useAccountFiles(): AccountFiles {
    const passwdFile = useFile("/etc/passwd");
    const groupFile = useFile("/etc/group");
    const shellsFile = useFile("/etc/shells");
    const etcDefs = useFile("/etc/login.defs");
    const usrDefs = useFile("/usr/etc/login.defs");

    const passwd = useMemo(() => (typeof passwdFile.content === "string" ? parsePasswd(passwdFile.content) : null),
                           [passwdFile.content]);
    const groups = useMemo(() => (typeof groupFile.content === "string" ? parseGroups(groupFile.content) : null),
                           [groupFile.content]);
    const shells = useMemo(() => parseShells(shellsFile.content ?? ""), [shellsFile.content]);
    const defsText = typeof etcDefs.content === "string" ? etcDefs.content
        : etcDefs.content === null ? usrDefs.content ?? null : null;
    const loginDefs = useMemo(() => parseLoginDefs(defsText), [defsText]);

    let error: string | null = null;
    if (passwdFile.content === null)
        error = "/etc/passwd does not exist.";
    else if (passwdFile.error && passwdFile.content === undefined)
        error = fileError("/etc/passwd", passwdFile.error);
    else if (groupFile.error && groupFile.content === undefined)
        error = fileError("/etc/group", groupFile.error);

    // A missing /etc/group is survivable: no group names, no memberships.
    const groupsOrEmpty = groupFile.content === null ? [] : groups;
    return { passwd, groups: groupsOrEmpty, shells, loginDefs, error };
}

// ---- login details ---------------------------------------------------------------------

export type LocksStatus = "limited" | "loading" | "ready" | "failed";

export interface LoginDetails {
    /** logind User.State by user name; null until logind has answered. */
    readonly states: ReadonlyMap<string, string> | null;
    readonly statesFailed: boolean;
    /** Last login (ms) by user name; null while loading. Empty when unavailable. */
    readonly lastLogin: ReadonlyMap<string, number> | null;
    readonly lastLoginFailed: boolean;
    /** Locked or not, by user name; null unless locksStatus is "ready". */
    readonly locks: ReadonlyMap<string, boolean> | null;
    readonly locksStatus: LocksStatus;
    /** Changes whenever logind reports a change, for views following sessions. */
    readonly loginTick: number;
    /** Re-read the lock state, e.g. after changing it. */
    readonly refreshLocks: () => void;
}

const LOGIN1 = "/org/freedesktop/login1";
const MANAGER = "org.freedesktop.login1.Manager";
const CALL_OPTIONS = { type: "", flags: "", timeout: 5000 } as const;

/*
 * A trailing-edge debounce whose timer dies with the component. users.js
 * debounces all of getLoginDetails() by 100 ms on any logind Manager
 * signal; here the cheap logind part keeps that, and the lastlog part --
 * one or two process spawns -- waits a second.
 */
function useDebounced(fn: () => void, ms: number): () => void {
    const ref = useRef(fn);
    ref.current = fn;
    const timer = useRef<NodeJS.Timeout | null>(null);
    useEffect(() => () => {
        if (timer.current)
            clearTimeout(timer.current);
    }, []);
    return useCallback(() => {
        if (timer.current)
            clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            timer.current = null;
            ref.current();
        }, ms);
    }, [ms]);
}

/*
 * Who is logged in, who is locked, and when everyone last logged in.
 *
 * Upstream gets these in one getLoginDetails() that the page waits for, and
 * starts it from the /etc/shadow watch's first callback -- which, without
 * privileges, is an access-denied error (spec gotchas 5 and 6). Here each
 * part is loaded on its own at mount, and refreshed by what changes it:
 * logind signals for logins, the /etc/shadow watch (privileged only) and
 * explicit refreshLocks() calls for the lock state.
 */
export function useLoginDetails(logind: DBusClient, allowed: boolean): LoginDetails {
    const mounted = useMounted();
    const [states, setStates] = useState<ReadonlyMap<string, string> | null>(null);
    const [statesFailed, setStatesFailed] = useState(false);
    const [lastLogin, setLastLogin] = useState<ReadonlyMap<string, number> | null>(null);
    const [lastLoginFailed, setLastLoginFailed] = useState(false);
    const [locks, setLocks] = useState<ReadonlyMap<string, boolean> | null>(null);
    const [locksStatus, setLocksStatus] = useState<LocksStatus>(allowed ? "loading" : "limited");
    const [loginTick, setLoginTick] = useState(0);
    // Only the newest request of each kind may land.
    const seq = useRef({ states: 0, last: 0, locks: 0 });
    /*
     * Aborted at unmount: the lastlog reader may still have a `date` per
     * unreadable line to run, and the lock reader a second command, none of
     * which anyone will see once the page is gone.
     */
    const life = useRef<AbortController | null>(null);
    const lifeSignal = () => (life.current ??= new AbortController()).signal;
    useEffect(() => {
        const controller = life.current ??= new AbortController();
        return () => {
            controller.abort();
            life.current = null;
        };
    }, []);

    const loadStates = useCallback(async () => {
        const mine = ++seq.current.states;
        try {
            const [users] = await logind.call(LOGIN1, MANAGER, "ListUsers", null, CALL_OPTIONS);
            const list = (users ?? []) as [number, string, string][];
            // allSettled: a user who logged out between the two calls
            // (UnknownObject) must not lose everyone else's state, as
            // upstream's Promise.all does (spec gotcha 4).
            const results = await Promise.allSettled(list.map(async ([, name, path]) => {
                const [state] = await logind.call(path, "org.freedesktop.DBus.Properties", "Get",
                                                  ["org.freedesktop.login1.User", "State"],
                                                  { type: "ss", flags: "", timeout: 5000 });
                return [name, String(unvariant(state))] as const;
            }));
            if (!mounted() || mine !== seq.current.states)
                return;
            const map = new Map<string, string>();
            for (const result of results)
                if (result.status === "fulfilled")
                    map.set(result.value[0], result.value[1]);
            setStates(map);
            setStatesFailed(false);
        } catch {
            if (mounted() && mine === seq.current.states) {
                setStates(previous => previous ?? new Map());
                setStatesFailed(true);
            }
        }
    }, [logind, mounted]);

    const lastLoginSource = useRef<LastLoginSource | null>(null);
    const loadLastLogin = useCallback(async () => {
        const mine = ++seq.current.last;
        try {
            const { times, source } = await readLastLogins(lastLoginSource.current, lifeSignal());
            lastLoginSource.current = source;
            if (mounted() && mine === seq.current.last) {
                setLastLogin(times);
                setLastLoginFailed(false);
            }
        } catch {
            // Background information: a "?" in the column, never a message.
            if (mounted() && mine === seq.current.last) {
                setLastLogin(previous => previous ?? new Map());
                setLastLoginFailed(true);
            }
        }
    }, [mounted]);

    const loadLocks = useCallback(async () => {
        if (!allowed)
            return;
        const mine = ++seq.current.locks;
        try {
            const result = await readLockStates(lifeSignal());
            if (mounted() && mine === seq.current.locks) {
                setLocks(result);
                setLocksStatus("ready");
            }
        } catch (error) {
            if (mounted() && mine === seq.current.locks) {
                setLocksStatus(isAccessDenied(error) ? "limited" : "failed");
                setLocks(null);
            }
        }
    }, [allowed, mounted]);

    useEffect(() => {
        void loadStates();
        void loadLastLogin();
        void loadLocks();
    }, [loadStates, loadLastLogin, loadLocks]);

    const statesSoon = useDebounced(() => {
        setLoginTick(n => n + 1);
        void loadStates();
    }, 100);
    const lastLoginSoon = useDebounced(() => void loadLastLogin(), 1000);
    const locksSoon = useDebounced(() => void loadLocks(), 300);

    /*
     * Any Manager signal: SessionNew/Removed, UserNew/Removed, ... (users.js
     * reacts to all of them: SessionRemoved comes at once, UserRemoved only
     * after the "closing" period).
     */
    useSignal(logind, { interface: MANAGER, path: LOGIN1 }, () => {
        statesSoon();
        lastLoginSoon();
    });

    /*
     * Lock, unlock, expire and password changes all rewrite /etc/shadow.
     * Watching it needs root (an unprivileged inotify watch on a 0000 file
     * fails), so only with administrative access, and never reading it.
     * The first callback reports the current tag and is not a change.
     */
    useEffect(() => {
        if (!allowed)
            return;
        const file = cockpit.file("/etc/shadow", { superuser: "try" });
        let seen: string | null | undefined;
        const handle = file.watch((_content, tag, error) => {
            if (error)
                return;
            if (seen !== undefined && tag !== seen)
                locksSoon();
            seen = tag;
        }, { read: false });
        return () => {
            handle.remove();
            file.close();
        };
    }, [allowed, locksSoon]);

    return {
        states, statesFailed, lastLogin, lastLoginFailed, locks, locksStatus, loginTick,
        refreshLocks: locksSoon,
    };
}

// ---- sessions ------------------------------------------------------------------------------

export interface SessionInfo {
    readonly id: string;
    /** "pts/0", "tty2", "web console" (cockpit) or "". */
    readonly tty: string;
    /** PAM service: "sshd", "cockpit", "gdm-password", ... */
    readonly service: string;
    readonly remoteHost: string;
    readonly seat: string;
    readonly display: string;
    /** "online", "active", "closing". */
    readonly state: string;
    readonly type: string;
    readonly class: string;
    /** ms since the epoch, or null. */
    readonly since: number | null;
    readonly idle: boolean;
}

function sessionFrom(id: string, seat: string, props: Record<string, unknown>): SessionInfo {
    const text = (key: string) => {
        const value = unvariant(props[key]);
        return typeof value === "string" ? value : "";
    };
    const timestamp = Number(unvariant(props.Timestamp));
    return {
        id,
        tty: text("TTY"),
        service: text("Service"),
        remoteHost: text("RemoteHost"),
        seat,
        display: text("Display"),
        state: text("State"),
        type: text("Type"),
        class: text("Class"),
        since: Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(timestamp / 1000) : null,
        idle: unvariant(props.IdleHint) === true,
    };
}

/*
 * The account's logind sessions: Manager.ListSessions (id, uid, user, seat,
 * path), then the properties of this user's sessions. Upstream has no such
 * view (only "Logged in"); the data is what `loginctl list-sessions` shows
 * and is readable without privileges.
 *
 * Follows logind via `tick` with reload(), which keeps the sessions on
 * screen until the new answer is in. (As a dependency, every logind signal
 * -- any login or logout on the machine -- would blank the tab and the
 * session counts for a round trip.)
 */
export function useSessions(logind: DBusClient, name: string, tick: number): {
    sessions: SessionInfo[] | null, error: unknown,
} {
    const seenTick = useRef(tick);
    const state = useAsync(async () => {
        const [list] = await logind.call(LOGIN1, MANAGER, "ListSessions", null, CALL_OPTIONS);
        const mine = ((list ?? []) as [string, number, string, string, string][]).filter(s => s[2] === name);
        const results = await Promise.allSettled(mine.map(async ([id, , , seat, path]) => {
            const [props] = await logind.call(path, "org.freedesktop.DBus.Properties", "GetAll",
                                              ["org.freedesktop.login1.Session"], { type: "s", flags: "", timeout: 5000 });
            return sessionFrom(id, seat, (props ?? {}) as Record<string, unknown>);
        }));
        // A session that ended between the two calls is simply gone.
        return results.flatMap(result => (result.status === "fulfilled" ? [result.value] : []))
                .sort((a, b) => (a.since ?? 0) - (b.since ?? 0) || a.id.localeCompare(b.id));
    }, [logind, name]);
    const { reload } = state;
    useEffect(() => {
        if (tick !== seenTick.current) {
            seenTick.current = tick;
            reload();
        }
    }, [tick, reload]);
    return { sessions: state.value ?? null, error: state.value === undefined ? state.error : null };
}

// ---- expiry ------------------------------------------------------------------------------

/*
 * account-details.js get_expire(): chage -l with superuser "try". Without
 * administrative access it only works for your own account (chage is setuid
 * and checks); otherwise the facts are unknown (null), as upstream shows
 * nothing. `nonce` re-reads it after a change.
 *
 * Unlike upstream, chage is not even started when it is bound to fail
 * (`readable` false: someone else's account without access). Besides the
 * wasted spawn, every refused run leaves a failed "change age" record in
 * the audit log, which reads as if this user had tried to change it.
 */
export function useExpiry(name: string, nonce: number, readable: boolean): { expiry: Expiry | null, loading: boolean } {
    const state = useAsync(async signal => {
        if (!readable)
            return null;
        try {
            const { stdout } = await exec(["chage", "-l", name], { environ: ["LC_ALL=C"], err: "message", superuser: "try" },
                                          undefined, signal);
            return parseChage(stdout);
        } catch {
            return null;
        }
    }, [name, nonce, readable]);
    return { expiry: state.value ?? null, loading: state.loading && state.value === undefined };
}

// ---- login history ---------------------------------------------------------------------

/* account-logs-panel.jsx: `last` for this account, read once per account. */
export function useLoginHistory(name: string): { records: LoginRecord[] | null, error: unknown } {
    const state = useAsync(async signal => {
        const { stdout } = await exec(["last", "--time-format", "iso", "-n25", "--fullnames", name],
                                      { environ: ["LC_ALL=C"] }, undefined, signal);
        return parseLast(stdout, name);
    }, [name]);
    return { records: state.value ?? null, error: state.value === undefined ? state.error : null };
}

// ---- authorized keys -------------------------------------------------------------------

export type KeysStatus = "loading" | "ready" | "access-denied" | "failed" | "no-home";

export interface KeysState {
    readonly status: KeysStatus;
    readonly keys: readonly AuthorizedKey[];
    readonly path: string;
    readonly error: string | null;
    /** The watched file, for removing a key; null without a home directory. */
    readonly file: KeysFile | null;
}

/*
 * authorized-keys.js: <home>/.ssh/authorized_keys, watched with superuser
 * "try" (so with administrative access another user's file is readable),
 * each version listed through ssh-keygen. A missing file is no keys; a
 * result for a version that has since been replaced is dropped.
 */
export function useAuthorizedKeys(home: string): KeysState {
    const path = `${home.replace(/\/+$/, "")}/.ssh/authorized_keys`;
    const [state, setState] = useState<Omit<KeysState, "path" | "file">>({ status: "loading", keys: [], error: null });
    const [file, setFile] = useState<KeysFile | null>(null);

    useEffect(() => {
        if (!home) {
            setState({ status: "no-home", keys: [], error: null });
            setFile(null);
            return;
        }
        setState({ status: "loading", keys: [], error: null });
        const handle = cockpit.file(path, { superuser: "try" });
        setFile(handle as unknown as KeysFile);
        let live = true;
        let version = 0;
        const watch = handle.watch((content, _tag, error) => {
            const mine = ++version;
            if (error) {
                const problem = (error as { problem?: string }).problem;
                setState({
                    status: problem === "access-denied" ? "access-denied" : problem === "not-found" ? "ready" : "failed",
                    keys: [],
                    error: problem === "access-denied" || problem === "not-found" ? null : String(error.message || problem),
                });
                return;
            }
            if (!content) {
                setState({ status: "ready", keys: [], error: null });
                return;
            }
            listKeys(content).then(
                keys => {
                    if (live && mine === version)
                        setState({ status: "ready", keys, error: null });
                },
                (failure: unknown) => {
                    if (live && mine === version)
                        setState({ status: "failed", keys: [], error: (failure as Error).message ?? String(failure) });
                });
        });
        return () => {
            live = false;
            watch.remove();
            handle.close();
        };
    }, [home, path]);

    return { ...state, path, file };
}
