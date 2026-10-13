/*
 * Accounts: local user accounts (upstream cockpit 356 pkg/users, "Local
 * accounts").
 *
 * The list shows the people of this machine -- system accounts hidden
 * unless asked for -- with who is logged in, administrator role, lock state
 * and last login; Enter opens one account in detail. ← → switch to the
 * groups (upstream's "Groups" card) and back. Everything that changes an
 * account or group needs administrative access and asks first; see
 * policy.ts for which action applies when, and actions.ts for the exact
 * commands (upstream's).
 *
 * Module map:
 *   model.ts    parsers, rules and validators (pure)
 *   policy.ts   which actions apply to an account or a group (pure)
 *   scripts.ts  the shell and Python scripts run on the host
 *   actions.ts  the commands, as promises
 *   data.ts     live data hooks
 *   List.tsx, Groups.tsx, Details.tsx, dialogs.tsx, ui.tsx   the views
 *
 * The page remounts when administrative access changes (the shell keys it
 * on the privilege generation), which reopens every privileged read; the
 * view, selection, filter and sort survive that in persistent state.
 */
import { useEffect, useMemo, useReducer, useState } from "react";
import { Box } from "../../tui/ink.js";
import cockpit from "../../cockpit.js";
import { Notice } from "../../tui/components/misc.js";
import { useDBusClient } from "../../tui/hooks.js";
import { usePageParams } from "../../tui/navigation.js";
import { Panel, PANEL_EDGE, panelled } from "../../tui/components/Panel.js";
import type { PageProps } from "../../tui/page.js";
import { usePrivilege } from "../../tui/privilege.js";
import { usePersistentState } from "../../tui/session-context.js";
import { useStatus } from "../../tui/status.js";
import { clean } from "../../tui/text.js";
import { colors, glyphs } from "../../tui/theme.js";
import {
    deleteGroup, expirePassword, removeKey, setLocked, setMembership, terminateUser, type CreateStep,
} from "./actions.js";
import { useAccountFiles, useLoginDetails, type KeysState } from "./data.js";
import { AccountDetails, type DetailsTab } from "./Details.js";
import {
    AddKeyDialog, ConfirmAction, CreateAccountDialog, CreateGroupDialog, DeleteAccountDialog, deleteGroupMessage,
    GroupInfoDialog, GroupsDialog, MessageDialog, PasswordDialog, partialCreateMessage, RenameGroupDialog,
} from "./dialogs.js";
import { GroupList } from "./Groups.js";
import { AccountList } from "./List.js";
import {
    adminGroupFor, buildAccounts, buildGroups, isLastKey, isLoggedInState,
    type Account, type AuthorizedKey, type GroupInfo,
} from "./model.js";
import { removableAdminGroups, type ActionId } from "./policy.js";
import { lockOf } from "./ui.js";

type View =
    | { readonly kind: "list" }
    | { readonly kind: "groups" }
    | { readonly kind: "details", readonly name: string, readonly tab: DetailsTab };

/*
 * A dialog about an account keeps the account as it was when the dialog
 * opened, and renders with the live entry while there is one. The snapshot
 * matters when the account disappears underneath an open dialog -- above
 * all while deleting it: userdel rewrites /etc/passwd long before it exits
 * (with -r it still has the home directory to remove), so the watch drops
 * the account mid-command, and the dialog must still be there to report
 * how the command ended. Group dialogs do the same with the group.
 */
type DialogState =
    | { kind: "create" }
    | { kind: "create-group" }
    | { kind: "group-info" | "rename-group" | "delete-group", group: GroupInfo }
    | { kind: "delete" | "password" | "expire" | "groups", account: Account }
    /* logind's State when it opened: whether there are sessions to end, or only processes. */
    | { kind: "terminate", account: Account, loginState: string | undefined }
    | { kind: "lock", account: Account, lock: boolean }
    | { kind: "admin", account: Account, add: boolean }
    | { kind: "add-key", account: Account, keys: KeysState }
    | { kind: "remove-key", account: Account, key: AuthorizedKey, keys: KeysState }
    | { kind: "message", title: string, text: string, tone: "info" | "warning" | "error" };

/** Params another page may pass with go("accounts", ...): open this account. */
export interface AccountsParams {
    readonly user?: string;
}

export default function AccountsPage({ width, height }: PageProps) {
    const privilege = usePrivilege();
    const allowed = privilege.allowed === true;
    const { notify } = useStatus();
    const files = useAccountFiles();
    const logind = useDBusClient("org.freedesktop.login1", { bus: "system" });
    const details = useLoginDetails(logind, allowed);
    const params = usePageParams<AccountsParams>("accounts");
    const [view, setView] = usePersistentState<View>("accounts:view", { kind: "list" });
    const [dialog, setDialog] = useState<DialogState | null>(null);
    const [selectNext, setSelectNext] = useState<string | null>(null);
    const [selectNextGroup, setSelectNextGroup] = useState<string | null>(null);
    const [expiryNonce, bumpExpiry] = useReducer((n: number) => n + 1, 0);
    const current = cockpit.info.user?.name ?? null;

    useEffect(() => {
        if (params?.user)
            setView({ kind: "details", name: params.user, tab: "account" });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const accounts = useMemo(
        () => (files.passwd && files.groups ? buildAccounts(files.passwd, files.groups, files.loginDefs.uidMin) : null),
        [files.passwd, files.groups, files.loginDefs.uidMin]);
    const adminGroup = useMemo(() => adminGroupFor(files.groups ?? [], cockpit.info.os_release ?? {}), [files.groups]);
    const groupInfos = useMemo(
        () => (files.passwd && files.groups ? buildGroups(files.groups, files.passwd, files.loginDefs) : []),
        [files.passwd, files.groups, files.loginDefs]);

    if (files.error)
        return <Notice width={width} height={height} color={colors.error}>{clean(files.error)}</Notice>;
    if (!accounts)
        return <Notice width={width} height={height} loading>{`Loading accounts${glyphs.ellipsis}`}</Notice>;

    const find = (name: string): Account | null => accounts.find(account => account.name === name) ?? null;
    const loggedIn = (name: string) => isLoggedInState(details.states?.get(name));
    const close = () => setDialog(null);

    const onAction = (id: ActionId, account: Account) => {
        switch (id) {
        case "lock":
            setDialog({ kind: "lock", account, lock: lockOf(details, account.name) !== "locked" });
            break;
        case "admin":
            setDialog({ kind: "admin", account, add: account.adminGroups.length === 0 });
            break;
        case "terminate":
            setDialog({ kind: id, account, loginState: details.states?.get(account.name) });
            break;
        case "password":
        case "expire":
        case "groups":
        case "delete":
            setDialog({ kind: id, account });
            break;
        }
    };

    const renderDialog = (state: DialogState) => {
        if (state.kind === "message")
            return <MessageDialog title={state.title} message={state.text} tone={state.tone} onClose={close} />;
        if (state.kind === "create") {
            return (
                <CreateAccountDialog
                    passwd={files.passwd ?? []}
                    groups={files.groups ?? []}
                    loginDefs={files.loginDefs}
                    adminGroup={adminGroup}
                    onCreated={(user, warnings) => {
                        setDialog(null);
                        setSelectNext(user);
                        setView({ kind: "list" });
                        if (warnings.length)
                            notify(`Created account ${clean(user)}. ${clean(warnings.join(" "))}`, "warning");
                        else
                            notify(`Created account ${clean(user)}`, "success");
                    }}
                    onPartial={(user: string, step: CreateStep, message: string) => {
                        setSelectNext(user);
                        setDialog({
                            kind: "message", tone: "error", title: "Account created with problems",
                            text: partialCreateMessage(user, step, message),
                        });
                    }}
                    onCancel={close}
                />
            );
        }
        if (state.kind === "create-group") {
            return (
                <CreateGroupDialog
                    groups={files.groups ?? []}
                    loginDefs={files.loginDefs}
                    onCreated={name => {
                        setDialog(null);
                        setSelectNextGroup(name);
                        notify(`Created group ${clean(name)}`, "success");
                    }}
                    onCancel={close}
                />
            );
        }
        if ("group" in state) {
            const group = groupInfos.find(info => info.name === state.group.name) ?? state.group;
            const name = clean(group.name);
            if (state.kind === "group-info")
                return <GroupInfoDialog group={group} onClose={close} />;
            if (state.kind === "rename-group") {
                return (
                    <RenameGroupDialog
                        group={group}
                        groups={files.groups ?? []}
                        onRenamed={newName => {
                            setDialog(null);
                            setSelectNextGroup(newName);
                            notify(`Renamed group ${name} to ${clean(newName)}`, "success");
                        }}
                        onCancel={close}
                    />
                );
            }
            const force = group.primary.length > 0;
            return (
                <ConfirmAction
                    title={`Delete group ${name}`}
                    message={deleteGroupMessage(group)}
                    confirmLabel={force ? "Force delete" : "Delete"}
                    danger
                    busyText={`Deleting ${name}`}
                    onClose={close}
                    run={async () => {
                        await deleteGroup(group.name, force);
                        notify(`Deleted group ${name}`, "success");
                    }}
                />
            );
        }

        const account = find(state.account.name) ?? state.account;
        const name = clean(account.name);
        switch (state.kind) {
        case "delete":
            return (
                <DeleteAccountDialog
                    account={account}
                    loginState={details.states?.get(account.name)}
                    onDeleted={warnings => {
                        setDialog(null);
                        if (view.kind === "details" && view.name === account.name)
                            setView({ kind: "list" });
                        notify(`Deleted account ${name}${warnings ? `. ${clean(warnings)}` : ""}`, warnings ? "warning" : "success");
                    }}
                    onCancel={close}
                />
            );
        case "password":
            return (
                <PasswordDialog account={account} locked={lockOf(details, account.name) === "locked"} onCancel={close} onDone={() => {
                    setDialog(null);
                    bumpExpiry();
                    details.refreshLocks();
                    notify(`Password of ${name} changed`, "success");
                }} />
            );
        case "expire":
            return (
                <ConfirmAction
                    title="Force password change"
                    message={`${name} will have to choose a new password at the next login (passwd -e).`}
                    confirmLabel="Force change"
                    busyText="Expiring the password"
                    onClose={close}
                    run={async () => {
                        await expirePassword(account.name);
                        bumpExpiry();
                        notify(`${name} must change the password at the next login`, "success");
                    }}
                />
            );
        case "lock":
            return (
                <ConfirmAction
                    title={state.lock ? `Lock ${name}` : `Unlock ${name}`}
                    message={state.lock
                        ? `Disallow password login for ${name}? The password is kept but stops working; ` +
                          "other ways to log in, such as SSH keys, still work."
                        : `Allow password login for ${name} again?`}
                    confirmLabel={state.lock ? "Lock" : "Unlock"}
                    danger={state.lock}
                    busyText={state.lock ? "Locking" : "Unlocking"}
                    onClose={close}
                    run={async () => {
                        let result: boolean | null;
                        try {
                            result = await setLocked(account.name, state.lock);
                        } catch (error) {
                            // usermod refuses to unlock "!!": there is no password to restore.
                            if (!state.lock && /passwordless/.test(String((error as Error).message)))
                                throw new Error(`${(error as Error).message} Set a password instead (p): that also allows password login.`);
                            throw error;
                        } finally {
                            details.refreshLocks();
                        }
                        if (result === !state.lock)
                            notify(`usermod succeeded, but passwd -S still reports ${name} as ${result ? "locked" : "unlocked"}`, "warning");
                        else
                            notify(state.lock ? `Locked ${name}` : `Unlocked ${name}`, "success");
                    }}
                />
            );
        case "admin": {
            const group = adminGroup ?? "";
            const remove = removableAdminGroups(account);
            const self = account.name === current;
            const relogin = loggedIn(account.name) ? ` ${name} must log out and back in for this to take effect.` : "";
            return (
                <ConfirmAction
                    title={state.add ? "Make administrator" : "Remove administrator role"}
                    message={state.add
                        ? `Add ${name} to the ${clean(group)} group, which grants administrative access (sudo)?${relogin}`
                        : `Remove ${name} from ${remove.map(g => clean(g)).join(", ")}?` +
                          (self ? " This is your own account: you may no longer be able to get administrative access." : "") +
                          relogin}
                    confirmLabel={state.add ? "Make administrator" : "Remove"}
                    danger={!state.add}
                    busyText={state.add ? `Adding ${name} to ${clean(group)}` : `Removing ${name}`}
                    onClose={close}
                    run={async () => {
                        if (state.add) {
                            await setMembership(account.name, group, true);
                        } else {
                            for (const g of remove)
                                await setMembership(account.name, g, false);
                        }
                        notify(state.add ? `${name} is now an administrator` : `${name} is no longer an administrator`, "success");
                    }}
                />
            );
        }
        case "groups":
            return (
                <GroupsDialog
                    account={account}
                    groups={files.groups ?? []}
                    loggedIn={loggedIn(account.name)}
                    self={account.name === current}
                    onCancel={close}
                    onDone={summary => {
                        setDialog(null);
                        notify(`Groups of ${name} changed: ${summary}` +
                               (loggedIn(account.name) ? ` (${name} must log in again for it to take effect)` : ""), "success");
                    }}
                />
            );
        case "terminate": {
            /*
             * Sessions, or only processes: a lingering user's service
             * manager, or what closed sessions left running. Either way
             * loginctl terminate-user ends them all (and userdel refuses
             * until it has).
             */
            const sessions = isLoggedInState(state.loginState);
            return (
                <ConfirmAction
                    title={sessions ? `Terminate sessions of ${name}` : `End the processes of ${name}`}
                    message={sessions
                        ? `End every session of ${name}? Their running programs are killed (loginctl terminate-user).`
                        : state.loginState === "lingering"
                            ? `${name} is not logged in, but linger is enabled, so their user services run anyway. ` +
                              `Stop them and every other process of ${name} (loginctl terminate-user)? ` +
                              "Linger stays enabled: the services start again at the next boot."
                            : `${name} has logged out, but programs of the closed sessions still run. ` +
                              `Kill every process of ${name} (loginctl terminate-user)?`}
                    confirmLabel="Terminate"
                    danger
                    busyText="Terminating"
                    onClose={close}
                    run={async () => {
                        await terminateUser(account.name);
                        bumpExpiry();
                        notify(sessions ? `Terminated the sessions of ${name}` : `Ended the processes of ${name}`, "success");
                    }}
                />
            );
        }
        case "add-key":
            return (
                <AddKeyDialog account={account} self={account.name === current} onCancel={close} onDone={key => {
                    setDialog(null);
                    notify(`Added key ${clean(key.comment ?? key.fingerprint ?? "")} for ${name}`, "success");
                }} />
            );
        case "remove-key": {
            const { key, keys } = state;
            const file = keys.file;
            const label = clean(key.comment ?? (key.valid ? "Unnamed" : "invalid key"));
            const last = isLastKey(keys.keys, key.raw);
            return (
                <ConfirmAction
                    title="Remove SSH key"
                    message={`Remove the key "${label}"${key.fingerprint ? ` (${clean(key.fingerprint)})` : ""} from ${clean(keys.path)}? ` +
                             "Logins with it stop working." +
                             // Upstream deletes the file with its last key; here it is kept (possibly empty).
                             (last ? ` It is the last usable key: ${name} can no longer log in with an SSH key. ` +
                                     "The file itself is kept." : "")}
                    confirmLabel="Remove"
                    danger
                    busyText="Removing the key"
                    onClose={close}
                    run={async () => {
                        if (!file)
                            throw new Error("The key file is not available.");
                        await removeKey(file, key.raw, account.home);
                        notify(`Removed key ${label} for ${name}`, "success");
                    }}
                />
            );
        }
        }
    };

    const active = dialog === null;

    /*
     * The two lists stay mounted while the details or the other list show,
     * hidden: coming back finds them scrolled where they were. (Remounted,
     * a list would scroll only just far enough to show the selection, which
     * lands it on the last line with different rows around it.)
     */
    const boxed = panelled(width, height);
    return (
        <Box flexDirection="column" width={width} height={height}>
            <Box display={view.kind === "list" ? "flex" : "none"} flexDirection="column" width={width} height={height}>
                <AccountList
                    width={width}
                    height={height}
                    accounts={accounts}
                    details={details}
                    current={current}
                    adminGroup={adminGroup}
                    active={active && view.kind === "list"}
                    onOpen={name => setView({ kind: "details", name, tab: "account" })}
                    onAction={onAction}
                    onCreate={() => setDialog({ kind: "create" })}
                    onSwitch={() => setView({ kind: "groups" })}
                    selectNext={selectNext}
                    onSelectedNext={() => setSelectNext(null)}
                />
            </Box>
            <Box display={view.kind === "groups" ? "flex" : "none"} flexDirection="column" width={width} height={height}>
                <GroupList
                    width={width}
                    height={height}
                    groups={groupInfos}
                    loginDefs={files.loginDefs}
                    active={active && view.kind === "groups"}
                    onSwitch={() => setView({ kind: "list" })}
                    onOpen={group => setDialog({ kind: "group-info", group })}
                    onCreate={() => setDialog({ kind: "create-group" })}
                    onAction={(id, group) => setDialog({ kind: id, group })}
                    selectNext={selectNextGroup}
                    onSelectedNext={() => setSelectNextGroup(null)}
                />
            </Box>
            {view.kind === "details" && (
                <Panel plain={!boxed} title="Account" width={width} height={height}>
                <AccountDetails
                    key={view.name}
                    width={boxed ? width - PANEL_EDGE : width}
                    height={boxed ? height - PANEL_EDGE : height}
                    name={view.name}
                    account={find(view.name)}
                    details={details}
                    logind={logind}
                    current={current}
                    adminGroup={adminGroup}
                    active={active}
                    tab={view.tab}
                    onTab={tab => setView({ kind: "details", name: view.name, tab })}
                    expiryNonce={expiryNonce}
                    onBack={() => setView({ kind: "list" })}
                    onAction={onAction}
                    onAddKey={(account, keys) => setDialog({ kind: "add-key", account, keys })}
                    onRemoveKey={(account, key, keys) => setDialog({ kind: "remove-key", account, key, keys })}
                />
                </Panel>
            )}
            {dialog && renderDialog(dialog)}
        </Box>
    );
}
