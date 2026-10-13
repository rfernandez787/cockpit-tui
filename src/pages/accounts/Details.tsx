/*
 * One account in detail (upstream's account-details.js with its "Authorized
 * public SSH keys" and "Login history" cards), as tabs switched with ← →:
 *
 *   Account    the account's fields, password and expiry state, and the
 *              actions with the reason any of them does not apply
 *   Sessions   its logind sessions now (upstream only says "Logged in")
 *   SSH keys   ~/.ssh/authorized_keys: add (n), remove (x)
 *   History    recent logins from wtmp (`last`)
 *
 * Details work for every passwd entry, hidden system accounts included, as
 * upstream's do; an account that disappears (deleted elsewhere) says so.
 */
import { Box, Text } from "../../tui/ink.js";
import { useKeys, isPlain, type Hint } from "../../tui/keyboard.js";
import { Table, useListNav, type Column } from "../../tui/components/Table.js";
import { Heading, LimitedAccessBanner, Notice, Tabs } from "../../tui/components/misc.js";
import { usePrivilege } from "../../tui/privilege.js";
import { useSession } from "../../tui/session-context.js";
import { useStatus } from "../../tui/status.js";
import { clean, fit, formatTimestamp } from "../../tui/text.js";
import { colors, glyphs } from "../../tui/theme.js";
import type { DBusClient } from "../../tui/hooks.js";
import {
    hasProcessesState, isLoggedInState, isNoLoginShell, type Account, type AuthorizedKey, type Expiry, type LoginRecord,
} from "./model.js";
import { accountActions, NEEDS_ADMIN, type ActionId, type ActionInfo } from "./policy.js";
import {
    useAuthorizedKeys, useExpiry, useLoginHistory, useSessions,
    type KeysState, type LoginDetails, type SessionInfo,
} from "./data.js";
import { hostError } from "./dialogs.js";
import { EmptyNote, formatSpan, lastActiveCell, labelColumn, localZone, lockOf, RowList, type Row } from "./ui.js";

export type DetailsTab = "account" | "sessions" | "keys" | "history";

const TABS: readonly DetailsTab[] = ["account", "sessions", "keys", "history"];

export interface DetailsProps {
    readonly width: number;
    readonly height: number;
    readonly name: string;
    /** Null when the name is not (or no longer) in /etc/passwd. */
    readonly account: Account | null;
    readonly details: LoginDetails;
    readonly logind: DBusClient;
    readonly current: string | null;
    readonly adminGroup: string | null;
    /** False while a dialog is open. */
    readonly active: boolean;
    readonly tab: DetailsTab;
    readonly onTab: (tab: DetailsTab) => void;
    /** Changes after an action that changes chage's facts. */
    readonly expiryNonce: number;
    readonly onBack: () => void;
    readonly onAction: (id: ActionId, account: Account) => void;
    readonly onAddKey: (account: Account, keys: KeysState) => void;
    readonly onRemoveKey: (account: Account, key: AuthorizedKey, keys: KeysState) => void;
}

export function AccountDetails(props: DetailsProps) {
    const { width, height, name, account, details, tab, active } = props;
    const privilege = usePrivilege();
    const allowed = privilege.allowed === true;
    const { notify } = useStatus();
    const { session } = useSession();
    const self = name === props.current;

    // Every source is opened unconditionally (hooks), keyed by what it needs.
    const { sessions, error: sessionsError } = useSessions(props.logind, name, details.loginTick);
    const keys = useAuthorizedKeys(account?.home ?? "");
    const history = useLoginHistory(name);
    const { expiry, loading: expiryLoading } = useExpiry(name, props.expiryNonce, self || allowed);

    const banner = privilege.allowed === false && privilege.configured === true;
    const contentHeight = Math.max(1, height - 2 - (banner ? 1 : 0));

    const loginState = details.states?.get(name);
    const loggedIn = isLoggedInState(loginState);
    const actions = account
        ? accountActions(account, {
            allowed, current: props.current, adminGroup: props.adminGroup, loggedIn,
            running: hasProcessesState(loginState), lock: lockOf(details, name),
        })
        : [];
    const mayEditKeys = self || allowed;

    // ---- tables ----------------------------------------------------------------------
    const sessionRows = sessions ?? [];
    const sessionNav = useListNav(sessionRows.map(s => s.id), contentHeight - 1, { active: active && tab === "sessions" });
    const keyRows = keys.keys;
    const keysTableHeight = Math.max(1, contentHeight - 1);
    const keyNav = useListNav(keyRows.map((k, i) => `${i}:${k.raw}`), keysTableHeight - 1, { active: active && tab === "keys" });
    const historyRows = history.records ?? [];
    const historyNav = useListNav(historyRows.map((r, i) => `${i}:${r.start}`), contentHeight - 1,
                                  { active: active && tab === "history" });
    const selectedKey = keyRows[keyNav.index] ?? null;

    // ---- keys ------------------------------------------------------------------------
    // The tab's own keys first: on an 80-column footer they would be cut otherwise.
    const tabHints: Hint[] = tab === "keys" && account
        ? mayEditKeys
            ? [["n", "add key"], ...(selectedKey ? [["x", "remove"] as const] : [])]
            : []
        : [];
    const hints: Hint[] = [
        ...tabHints,
        ["esc", "back"],
        [glyphs.leftright, "tabs"],
        ...actions.filter(a => a.enabled).map(a => [a.key, a.label] as const),
    ];

    useKeys((input, key) => {
        if (key.escape || key.backspace) {
            props.onBack();
            return true;
        }
        if (key.leftArrow || key.rightArrow) {
            const at = TABS.indexOf(tab);
            props.onTab(TABS[(at + (key.leftArrow ? TABS.length - 1 : 1)) % TABS.length]!);
            return true;
        }
        if (!account)
            return false;
        const plain = isPlain(input, key);
        if (tab === "keys" && (key.delete || (plain && (input === "x" || input === "n")))) {
            if (!mayEditKeys) {
                notify(`Changing ${clean(name)}'s keys ${NEEDS_ADMIN}`, "warning");
                return true;
            }
            if (input === "n" && !account.home.startsWith("/"))
                notify(`${clean(name)} has no home directory to keep SSH keys in`, "warning");
            else if (input === "n")
                props.onAddKey(account, keys);
            else if (selectedKey)
                props.onRemoveKey(account, selectedKey, keys);
            return true;
        }
        if (!plain)
            return false;
        const action = actions.find(a => a.key === input);
        if (!action)
            return false;
        if (action.enabled)
            props.onAction(action.id, account);
        else
            notify(clean(`${action.label.charAt(0).toUpperCase()}${action.label.slice(1)}: ${action.reason}`), "warning");
        return true;
    }, { active, hints });

    if (!account) {
        return (
            <Box flexDirection="column" width={width} height={height}>
                <Heading title={clean(name)} width={width} />
                <Notice width={width} height={height - 1} color={colors.error}>
                    {`The account ${clean(name)} is not in /etc/passwd (any more). Press Esc to go back to the list.`}
                </Notice>
            </Box>
        );
    }

    const title = clean(account.fullName || account.name);
    const facts = [
        clean(account.name),
        `UID ${account.uid}`,
        self ? "your account" : "",
        account.system ? "system account" : "",
        session && session.mode !== "local" ? `times in ${localZone()}` : "",
    ].filter(Boolean).join(` ${glyphs.dot} `);
    const labels = [
        "Account",
        `Sessions${sessions ? ` (${sessions.length})` : ""}`,
        `SSH keys${keys.status === "ready" ? ` (${keys.keys.length})` : ""}`,
        "History",
    ];

    let content;
    switch (tab) {
    case "account": {
        const rows = accountRows(account, {
            details, expiry, expiryLoading, sessions, self, allowed, loggedIn, loginState, actions,
        });
        content = <RowList rows={rows} width={width} height={contentHeight} labelWidth={labelColumn(rows, width)}
                           active={active} />;
        break;
    }
    case "sessions":
        content = (
            <Table rows={sessionRows} columns={SESSION_COLUMNS} nav={sessionNav} width={width} height={contentHeight}
                   empty={<EmptyNote width={width} height={contentHeight - 1}
                                     {...(sessions === null && sessionsError ? { color: colors.error } : {})}
                                     text={sessions !== null ? (loggedIn ? "No sessions." : "Not logged in.")
                                         : sessionsError ? `Sessions are not available: ${hostError(sessionsError)}`
                                             : `Loading sessions${glyphs.ellipsis}`} />} />
        );
        break;
    case "keys":
        content = (
            <Box flexDirection="column" width={width} height={contentHeight}>
                <Text color={colors.dim} wrap="truncate">{fit(keysCaption(keys, mayEditKeys), width)}</Text>
                <Table rows={keyRows} columns={KEY_COLUMNS} nav={keyNav} width={width} height={keysTableHeight}
                       empty={<EmptyNote width={width} height={keysTableHeight - 1} text={keysEmpty(keys, allowed)}
                                         {...(keys.status === "failed" ? { color: colors.error } : {})} />} />
            </Box>
        );
        break;
    case "history":
        content = (
            <Table rows={historyRows} columns={HISTORY_COLUMNS} nav={historyNav} width={width} height={contentHeight}
                   empty={<EmptyNote width={width} height={contentHeight - 1}
                                     {...(history.error ? { color: colors.error } : {})}
                                     text={history.records === null
                                         ? history.error ? `Login history is not available: ${hostError(history.error)}`
                                             : `Loading login history${glyphs.ellipsis}`
                                         : "No logins recorded."} />} />
        );
        break;
    }

    return (
        <Box flexDirection="column" width={width} height={height}>
            <Heading title={title} detail={facts} width={width} />
            {banner && <LimitedAccessBanner width={width} />}
            <Tabs tabs={labels} current={TABS.indexOf(tab)} width={width} />
            {content}
        </Box>
    );
}

// ---- the Account tab ----------------------------------------------------------------

interface RowContext {
    readonly details: LoginDetails;
    readonly expiry: Expiry | null;
    readonly expiryLoading: boolean;
    readonly sessions: SessionInfo[] | null;
    readonly self: boolean;
    readonly allowed: boolean;
    readonly loggedIn: boolean;
    readonly loginState: string | undefined;
    readonly actions: readonly ActionInfo[];
}

/* Rows are clean text: chage's values are passed on as it printed them when they are not dates it knows. */
function expiryText(value: string | null | undefined, ctx: RowContext, kind: "password" | "account" | "change"): Row["value"] {
    if (ctx.expiryLoading)
        return glyphs.ellipsis;
    if (ctx.expiry === null)
        return ctx.self || ctx.allowed ? "unknown" : "unknown (needs administrative access)";
    if (!value)
        return "unknown";
    if (value === "never")
        return "never";
    if (value === "must change")
        return kind === "change" ? "password must be changed" : "must be changed at next login";
    return clean(value);
}

function accountRows(account: Account, ctx: RowContext): Row[] {
    const { details } = ctx;
    const lock = lockOf(details, account.name);
    let passwordLogin: Row;
    if (details.locksStatus === "loading")
        passwordLogin = { label: "Password login", value: `checking${glyphs.ellipsis}`, color: colors.dim };
    else if (lock === "locked")
        passwordLogin = { label: "Password login", value: "disallowed (account locked)", color: colors.warning };
    else if (lock === "unlocked")
        passwordLogin = { label: "Password login", value: "allowed" };
    else
        passwordLogin = {
            label: "Password login",
            value: details.locksStatus === "failed" ? "unknown (could not be read)" : "unknown (needs administrative access)",
            color: colors.dim,
        };

    /*
     * A "closing" session is logged out but still has processes (with
     * logind's KillUserProcesses=no, e.g. a tmux left running): counted
     * apart, so the numbers add up to the Sessions tab's.
     */
    const open = ctx.sessions?.filter(s => s.state !== "closing").length ?? 0;
    const closing = (ctx.sessions?.length ?? 0) - open;
    const counts = [open ? plural(open, "session") : "", closing ? `${closing} closing` : ""].filter(Boolean).join(", ");
    const last = lastActiveCell(details, account.name);
    const lastLogin: Row = ctx.loggedIn
        ? { label: "Last login", value: `logged in now${counts ? ` (${counts})` : ""}`, color: colors.ok }
        : {
            label: "Last login",
            value: (last.text === "?" ? "unknown" : last.text) +
                (closing ? ` (${plural(closing, "closing session")} left)`
                    // Not logged in, yet processes run: why terminating (t) is offered.
                    : ctx.loginState === "lingering" ? " (lingering: user services run)" : ""),
            ...(last.color ? { color: last.color } : {}),
        };

    const passwordExpires = expiryText(ctx.expiry?.passwordExpires, ctx, "password");
    const accountExpires = expiryText(ctx.expiry?.accountExpires, ctx, "account");
    const shell = account.shell
        ? clean(account.shell) + (isNoLoginShell(account.shell) ? " (cannot log in)" : "")
        : "/bin/sh (default)";

    const gecosRest = account.gecos.split(",").slice(1).filter(Boolean).join(", ");
    const rows: Row[] = [
        { label: "User name", value: clean(account.name) + (ctx.self ? "  (your account)" : "") },
        { label: "Full name", value: clean(account.fullName) || "none", ...(account.fullName ? {} : { color: colors.dim }) },
        // The rest of the GECOS field (room, phones, ...), only when there is a rest; the name is the row above.
        ...(gecosRest ? [{ label: "GECOS (rest)", value: clean(gecosRest) }] : []),
        { label: "User ID", value: String(account.uid) },
        { label: "Primary group", value: `${account.primaryGroup ? clean(account.primaryGroup) : "?"} (GID ${Number.isFinite(account.gid) ? account.gid : "?"})` },
        {
            label: "Groups",
            value: account.groups.length ? account.groups.map(g => clean(g)).join(", ") : "none",
            ...(account.groups.length ? {} : { color: colors.dim }),
        },
        account.adminGroups.length
            ? { label: "Administrator", value: `yes (${account.adminGroups.map(g => clean(g)).join(", ")})`, color: colors.warning }
            : { label: "Administrator", value: "no" },
        { label: "Home directory", value: clean(account.home) || "none" },
        { label: "Shell", value: shell },
        passwordLogin,
        { label: "Password changed", value: expiryText(ctx.expiry?.lastChange, ctx, "change") },
        {
            label: "Password expires", value: passwordExpires,
            ...(passwordExpires.startsWith("must") ? { color: colors.warning } : {}),
        },
        {
            label: "Account expires", value: accountExpires,
            ...(isPast(ctx.expiry?.accountExpires) ? { color: colors.error } : {}),
        },
        lastLogin,
        { label: "", value: "" },
        { label: "Actions", value: "", heading: true },
    ];
    // Without access every action needs it: say that once, not per line.
    if (!ctx.allowed)
        rows.push({ label: "These need administrative access (press A).", value: "", heading: true, color: colors.dim });
    const labelWidth = Math.max(...ctx.actions.map(action => action.label.length)) + 2;
    for (const action of ctx.actions) {
        // A reason may name the account as /etc/passwd spells it (policy.ts).
        const reason = action.enabled || action.reason === NEEDS_ADMIN ? "" : clean(action.reason ?? "");
        rows.push({
            label: `  ${action.key}`,
            value: reason ? `${action.label.padEnd(labelWidth)}${reason}` : action.label,
            isKey: true,
            ...(action.enabled ? {} : { color: colors.dim }),
        });
    }
    return rows;
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** A "YYYY-MM-DD" day before today. */
function isPast(day: string | null | undefined): boolean {
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day))
        return false;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return day < today;
}

// ---- the other tabs ------------------------------------------------------------------

const SESSION_COLUMNS: Column<SessionInfo>[] = [
    { id: "id", title: "Session", width: 8, value: s => clean(s.id) },
    { id: "tty", title: "Terminal", grow: 1, minWidth: 8, value: s => clean(s.tty || (s.display ? `display ${s.display}` : "")) || "-" },
    { id: "service", title: "Service", width: 10, dropPriority: 2, value: s => clean(s.service) },
    { id: "from", title: "From", grow: 2, minWidth: 8, dropPriority: 1, value: s => clean(s.remoteHost || s.seat) || "local" },
    {
        id: "state", title: "State", width: 12,
        value: s => clean(s.state) + (s.idle && s.state !== "closing" ? ", idle" : ""),
        color: s => (s.state === "active" ? colors.ok : s.state === "closing" ? colors.dim : undefined),
    },
    { id: "since", title: "Since", width: 16, dropPriority: 3, value: s => (s.since ? formatTimestamp(s.since, false) : "") },
];

const KEY_COLUMNS: Column<AuthorizedKey>[] = [
    {
        id: "name", title: "Name", grow: 2, minWidth: 10,
        value: k => clean(k.comment ?? (k.valid ? "Unnamed" : k.raw.slice(0, 40))),
        color: k => (k.valid ? undefined : colors.error),
    },
    {
        id: "type", title: "Type", width: 12, dropPriority: 2,
        value: k => (k.algorithm ? clean(`${k.algorithm} ${k.size ?? ""}`.trim()) : "invalid"),
    },
    { id: "fp", title: "Fingerprint", grow: 3, minWidth: 12, dropPriority: 1, value: k => clean(k.fingerprint ?? "Invalid key") },
];

const HISTORY_COLUMNS: Column<LoginRecord>[] = [
    { id: "start", title: "Started", width: 16, value: r => formatTimestamp(r.start, false) },
    {
        id: "end", title: "Ended", width: 16,
        value: r => (r.end !== null ? formatTimestamp(r.end, false) : clean(r.endText ?? "")),
        color: r => (r.end === null && r.endText === "still logged in" ? colors.ok : undefined),
    },
    {
        id: "duration", title: "Duration", width: 8, dropPriority: 2,
        value: r => (r.end !== null ? formatSpan(Math.max(0, (r.end - r.start) / 1000)) : ""),
    },
    // An IPv4 address whole (15) before Terminal or Duration: the address is what matters most.
    { id: "from", title: "From", grow: 2, minWidth: 15, value: r => clean(r.from) },
    { id: "tty", title: "Terminal", grow: 1, minWidth: 8, dropPriority: 1, value: r => clean(r.tty) },
];

/* The file, first, so a narrow terminal cuts the remark rather than the path. */
function keysCaption(keys: KeysState, mayEdit: boolean): string {
    if (keys.status === "no-home")
        return "No home directory, so no authorized_keys.";
    return mayEdit ? clean(keys.path) : `${clean(keys.path)} (read-only)`;
}

/* authorized-keys-panel.js empty captions. */
function keysEmpty(keys: KeysState, allowed: boolean): string {
    switch (keys.status) {
    case "loading":
        return `Loading${glyphs.ellipsis}`;
    case "access-denied":
        return "You do not have permission to view the authorized public keys for this account." +
            (allowed ? "" : " Press A for administrative access.");
    case "failed":
        return `Failed to load authorized keys${keys.error ? `: ${clean(keys.error)}` : "."}`;
    case "no-home":
        return "This account has no home directory.";
    default:
        return "There are no authorized public keys for this account.";
    }
}
