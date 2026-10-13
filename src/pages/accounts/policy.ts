/*
 * Which actions apply to an account, and why not when they do not.
 *
 * The rules are upstream's (accounts-list.js UserActions, account-details.js
 * buttons): everything that changes an account needs administrative access;
 * root and your own account cannot be deleted, logged out or locked; only an
 * account with processes running has anything to terminate. The views show
 * disabled actions dimmed with the reason, so a missing action is never a
 * mystery.
 *
 * Reasons may name the account or group as it is in /etc/passwd or
 * /etc/group: raw host text, which the views clean before showing it.
 */
import type { Account, GroupInfo, LockState } from "./model.js";

export type ActionId = "password" | "expire" | "lock" | "admin" | "groups" | "terminate" | "delete";

export interface ActionContext {
    readonly allowed: boolean;
    /** The logged-in user of this TUI. */
    readonly current: string | null;
    /** The group that grants the administrator role here, if any. */
    readonly adminGroup: string | null;
    readonly loggedIn: boolean;
    /*
     * Processes of the account run (model.ts hasProcessesState): logged in,
     * or not but lingering or with closing sessions. Terminating is offered
     * for all of these: it is the way past userdel's "currently used by
     * process" refusal. (Upstream counts lingering as logged in, so it
     * offers "Log user out" there too.)
     */
    readonly running: boolean;
    readonly lock: LockState;
}

export interface ActionInfo {
    readonly id: ActionId;
    readonly key: string;
    readonly label: string;
    readonly enabled: boolean;
    /** Why it is disabled; null when enabled. */
    readonly reason: string | null;
}

export const NEEDS_ADMIN = "needs administrative access (press A)";

/** Supplementary administrator groups: the ones the role can be removed from. */
export function removableAdminGroups(account: Account): string[] {
    return account.adminGroups.filter(group => account.groups.includes(group));
}

export function accountActions(account: Account, ctx: ActionContext): ActionInfo[] {
    const self = account.name === ctx.current;
    const root = account.uid === 0;
    const make = (id: ActionId, key: string, label: string, reason: string | null): ActionInfo =>
        ({ id, key, label, enabled: reason === null, reason });
    // A reason that access would not fix comes first: "root cannot be
    // deleted" says more than "needs administrative access".
    const admin = (reason: string | null = null) => reason ?? (ctx.allowed ? null : NEEDS_ADMIN);

    const isAdmin = account.adminGroups.length > 0;
    let adminReason: string | null = null;
    if (root)
        adminReason = "root is always an administrator";
    else if (!isAdmin && !ctx.adminGroup)
        adminReason = "this system has no wheel or sudo group";
    else if (isAdmin && removableAdminGroups(account).length === 0)
        adminReason = `the administrator group is the primary group of ${account.name}`;

    return [
        make("password", "p", "set password", admin()),
        make("expire", "f", "force change", admin()),
        make("lock", "l", ctx.lock === "locked" ? "unlock" : "lock",
             admin(self ? "you cannot lock your own account" : null)),
        make("admin", "r", isAdmin ? "remove admin" : "make admin", admin(adminReason)),
        make("groups", "g", "groups", admin()),
        make("terminate", "t", "terminate",
             admin(root ? "root's sessions are not ended from here"
                 : self ? "this would end your own session"
                     : !ctx.running ? "not logged in" : null)),
        make("delete", "D", "delete",
             admin(root ? "root cannot be deleted" : self ? "you cannot delete your own account" : null)),
    ];
}

export type GroupActionId = "rename-group" | "delete-group";

export interface GroupActionInfo {
    readonly id: GroupActionId;
    readonly key: string;
    readonly label: string;
    readonly enabled: boolean;
    readonly reason: string | null;
}

/*
 * accounts-list.js / group-actions.jsx: renaming and deleting are offered
 * only for groups in the GID range for people (login.defs GID_MIN..GID_MAX).
 * The others belong to the system and its packages, which refer to them by
 * name. Creating a group is a page-wide action and only needs access.
 */
export function groupActions(group: GroupInfo, ctx: { allowed: boolean, gidMin: number, gidMax: number }): GroupActionInfo[] {
    const reason = group.userCreated
        ? (ctx.allowed ? null : NEEDS_ADMIN)
        : `${group.name} is a system group (GID ${group.gid}, outside ${ctx.gidMin}-${ctx.gidMax})`;
    return [
        { id: "rename-group", key: "R", label: "rename", enabled: reason === null, reason },
        { id: "delete-group", key: "D", label: "delete", enabled: reason === null, reason },
    ];
}
