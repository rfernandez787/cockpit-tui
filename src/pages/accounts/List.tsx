/*
 * The accounts list (upstream's "Accounts" card, accounts-list.js), the
 * first tab of the list view (← → switch to the groups, Groups.tsx):
 *
 *   [Accounts]  Groups   3 accounts · by name · 44 system hidden
 *     User             Full name          UID Role  Lock   Last active      Groups
 *   › ric (you)        Ric Example       1000 admin        logged in        wheel, libvirt
 *     alice            Alice Arbitrary   1001       locked 2026-09-20 10:43
 *     root             root                 0 admin        never
 *
 * System accounts (shown with h) say "(system)" after the name, as your own
 * says "(you)": dim alone would vanish without colour.
 * Lock reads "?" while the state cannot be known (it needs root to read).
 * The filter (/) matches name, full name, UID and group names, as upstream.
 * The rows appear as soon as /etc/passwd is read; login facts fill in when
 * their answers arrive. Actions apply to the selected account; the ones that
 * do not apply say why in the footer instead of doing nothing.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text } from "../../tui/ink.js";
import { useKeys, isPlain, type Hint } from "../../tui/keyboard.js";
import { Panel, PANEL_EDGE, panelled } from "../../tui/components/Panel.js";
import { Table, useListNav, type Column } from "../../tui/components/Table.js";
import { TextInput } from "../../tui/components/TextInput.js";
import { LimitedAccessBanner } from "../../tui/components/misc.js";
import { usePersistentState, useSession } from "../../tui/session-context.js";
import { usePrivilege } from "../../tui/privilege.js";
import { useStatus } from "../../tui/status.js";
import { clean } from "../../tui/text.js";
import { colors, glyphs } from "../../tui/theme.js";
import {
    hasProcessesState, isLoggedInState, matchesFilter, sortAccounts, sortByOrder, type Account, type LoginFacts, type SortKey,
} from "./model.js";
import { accountActions, NEEDS_ADMIN, type ActionId } from "./policy.js";
import type { LoginDetails } from "./data.js";
import { EmptyNote, lastActiveCell, localZone, lockCell, lockOf, TabLine } from "./ui.js";

export interface ListProps {
    readonly width: number;
    readonly height: number;
    readonly accounts: readonly Account[];
    readonly details: LoginDetails;
    readonly current: string | null;
    readonly adminGroup: string | null;
    /** False while a dialog is open. */
    readonly active: boolean;
    readonly onOpen: (name: string) => void;
    readonly onAction: (id: ActionId, account: Account) => void;
    readonly onCreate: () => void;
    /** ← →: over to the groups. */
    readonly onSwitch: () => void;
    /** Select this account as soon as it is listed (it may have just been created). */
    readonly selectNext: string | null;
    readonly onSelectedNext: () => void;
}

interface SortState {
    readonly key: SortKey;
    readonly reverse: boolean;
}

const SORT_ORDER: readonly SortKey[] = ["name", "uid", "login"];
const SORT_LABEL: Record<SortKey, string> = { name: "name", uid: "UID", login: "last active" };

interface Row {
    readonly account: Account;
    readonly self: boolean;
}

export function AccountList(props: ListProps) {
    const { accounts, details, current, active } = props;
    // Two panels when there is room: the tabs with what is shown, and the table.
    // `width` and `height` are what is left for those lines inside them.
    const boxed = panelled(props.width, props.height);
    const width = boxed ? props.width - PANEL_EDGE : props.width;
    const height = boxed ? props.height - 2 * PANEL_EDGE : props.height;
    const privilege = usePrivilege();
    const allowed = privilege.allowed === true;
    const { notify } = useStatus();
    const { session } = useSession();
    const [filter, setFilter] = usePersistentState("accounts:filter", "");
    const [editing, setEditing] = useState(false);
    const [sort, setSort] = usePersistentState<SortState>("accounts:sort", { key: "name", reverse: false });
    const [showSystem, setShowSystem] = usePersistentState("accounts:system", false);
    const [selected, setSelected] = usePersistentState<string | null>("accounts:selected", current);

    const base = useMemo(() => accounts.filter(account => showSystem || !account.system), [accounts, showSystem]);
    const hidden = accounts.length - base.length;
    const facts = useCallback((account: Account): LoginFacts => ({
        loggedIn: isLoggedInState(details.states?.get(account.name)),
        lastLogin: details.lastLogin?.get(account.name) ?? null,
    }), [details.states, details.lastLogin]);

    /*
     * Sorting by last activity needs logind's and lastlog's answers, which
     * come a moment after the rows -- on every visit, and after every change
     * of administrative access. Until both are in, the order this sort gave
     * last time stands in, rather than name order re-sorted under the cursor
     * a second later.
     */
    const [loginOrder, setLoginOrder] = usePersistentState<readonly string[] | null>("accounts:login-order", null);
    const factsReady = details.states !== null && details.lastLogin !== null;
    const rows = useMemo<Row[]>(() => {
        const shown = base.filter(account => matchesFilter(account, filter));
        const sorted = sort.key === "login" && !factsReady && loginOrder
            ? sortByOrder(shown, loginOrder, sort.reverse, current)
            : sortAccounts(shown, sort.key, sort.reverse, current, facts);
        return sorted.map(account => ({ account, self: account.name === current }));
    }, [base, filter, sort, current, facts, factsReady, loginOrder]);
    useEffect(() => {
        if (sort.key !== "login" || !factsReady)
            return;
        const order = sortAccounts(accounts, "login", false, null, facts).map(account => account.name);
        if (!loginOrder || order.length !== loginOrder.length || order.some((name, i) => name !== loginOrder[i]))
            setLoginOrder(order);
    }, [sort.key, factsReady, accounts, facts, loginOrder, setLoginOrder]);

    /*
     * The lock state needs root to read (spec gotcha 3). Without it the
     * column stays and says "?" for every account, rather than vanishing and
     * letting a locked account look like any other; such a column carries no
     * information, though, so on a narrow terminal it is the first to go.
     */
    const lockKnown = details.locksStatus === "ready" || details.locksStatus === "loading";
    const banner = privilege.allowed === false && privilege.configured === true;
    const filterLine = editing || filter !== "";
    const tableHeight = Math.max(2, height - 1 - (banner ? 1 : 0) - (filterLine ? 1 : 0));

    const nav = useListNav(rows.map(row => row.account.name), tableHeight - 1, {
        active,
        initialKey: selected,
    });
    const account = rows[nav.index]?.account ?? null;

    // Remember the selection across leaving the page and remounts.
    useEffect(() => {
        if (nav.key !== null && nav.key !== selected)
            setSelected(nav.key);
    }, [nav.key, selected, setSelected]);

    // An account just created is selected once the passwd watch lists it.
    const { selectNext, onSelectedNext } = props;
    useEffect(() => {
        if (selectNext === null)
            return;
        if (rows.some(row => row.account.name === selectNext)) {
            nav.selectKey(selectNext);
            onSelectedNext();
        } else if (filter && base.some(account => account.name === selectNext)) {
            setFilter(""); // it exists, but the filter hides it
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectNext, rows]);

    const actions = account
        ? accountActions(account, {
            allowed, current, adminGroup: props.adminGroup,
            loggedIn: isLoggedInState(details.states?.get(account.name)),
            running: hasProcessesState(details.states?.get(account.name)),
            lock: lockOf(details, account.name),
        })
        : [];

    /*
     * The footer shows whole hints in this order until its line is full, and
     * on an 80-column terminal 41 columns are left beside the shell's own: the
     * keys nothing else on screen reveals come first, short. Enter is what
     * everyone tries anyway, and every account action is listed with its key
     * on the details' Account tab.
     */
    const hints: Hint[] = [
        [glyphs.leftright, "groups"],
        ["/", "filter"],
        ...(allowed ? [["n", "new"] as const] : []),
        ["h", "sys"],
        ["s", "sort"],
        ["enter", "details"],
        ...actions.filter(a => a.enabled && ["password", "lock", "delete"].includes(a.id)).map(a => [a.key, a.label] as const),
        ["S", "reverse"],
    ];
    const help = hints.map(([keys, label]): Hint => (keys === "h" ? [keys, "show or hide system accounts"]
        : keys === "s" ? [keys, "change the sort"] : keys === "S" ? [keys, "reverse the sort"] : [keys, label]));

    useKeys((input, key) => {
        if (key.return) {
            if (account)
                props.onOpen(account.name);
            return true;
        }
        if (key.escape) {
            if (filter) {
                setFilter("");
                return true;
            }
            return false;
        }
        if (key.leftArrow || key.rightArrow) {
            props.onSwitch();
            return true;
        }
        if (!isPlain(input, key))
            return false;
        switch (input) {
        case "/":
            setEditing(true);
            return true;
        case "s": {
            const next = SORT_ORDER[(SORT_ORDER.indexOf(sort.key) + 1) % SORT_ORDER.length]!;
            setSort({ key: next, reverse: false });
            return true;
        }
        case "S":
            setSort({ ...sort, reverse: !sort.reverse });
            return true;
        case "h":
            setShowSystem(!showSystem);
            return true;
        case "n":
            if (allowed)
                props.onCreate();
            else
                notify(`Creating accounts ${NEEDS_ADMIN}`, "warning");
            return true;
        }
        const action = actions.find(a => a.key === input);
        if (!action || !account)
            return false;
        if (action.enabled)
            props.onAction(action.id, account);
        else
            notify(clean(`${capitalize(action.label)}: ${action.reason}`), "warning");
        return true;
    }, { active: active && !editing, hints, help });

    const columns = useMemo<Column<Row>[]>(() => [
        {
            id: "name", title: "User", grow: 1, minWidth: 12,
            value: row => clean(row.account.name) + (row.self ? " (you)" : row.account.system ? " (system)" : ""),
            color: row => (row.account.system ? colors.dim : undefined),
        },
        { id: "full", title: "Full name", grow: 1, minWidth: 10, dropPriority: 5, value: row => clean(row.account.fullName) },
        { id: "uid", title: "UID", width: 6, align: "right", dropPriority: 4, value: row => String(row.account.uid) },
        {
            id: "role", title: "Role", width: 5, dropPriority: 3,
            value: row => (row.account.adminGroups.length ? "admin" : ""),
            color: () => colors.warning,
        },
        {
            id: "lock", title: "Lock", width: 6, dropPriority: lockKnown ? 2 : 7,
            value: row => lockCell(details, row.account.name).text,
            color: row => lockCell(details, row.account.name).color,
        },
        {
            id: "last", title: "Last active", width: 16, dropPriority: 1,
            value: row => lastActiveCell(details, row.account.name).text,
            color: row => lastActiveCell(details, row.account.name).color,
        },
        {
            id: "groups", title: "Groups", grow: 2, minWidth: 12, dropPriority: 6,
            value: row => row.account.groups.map(group => clean(group)).join(", "),
        },
    ], [details, lockKnown]);

    const shown = rows.length;
    const detail = [
        // Without logind nobody shows as logged in; say why rather than imply it -- first, so a narrow line keeps it.
        details.statesFailed ? "logind unavailable: login state unknown" : "",
        filter ? `${shown} of ${base.length} accounts` : `${shown} account${shown === 1 ? "" : "s"}`,
        `by ${SORT_LABEL[sort.key]}${sort.reverse ? " (reversed)" : ""}`,
        showSystem ? "system accounts shown" : hidden > 0 ? `${hidden} system hidden` : "",
        session && session.mode !== "local" ? `times in ${localZone()}` : "",
    ].filter(Boolean).join(` ${glyphs.dot} `);

    const empty = filter
        ? `No accounts match "${clean(filter)}". Esc clears the filter.`
        : hidden > 0 ? "No accounts. Press h to show system accounts." : "No accounts.";

    return (
        <Box flexDirection="column" width={props.width} height={props.height}>
            <Panel plain={!boxed} title="View" width={props.width} height={props.height - tableHeight - PANEL_EDGE}>
            <TabLine current={0} detail={detail} width={width} />
            {banner && <LimitedAccessBanner width={width} />}
            {filterLine && (
                <Box width={width} height={1}>
                    <Text color={editing ? colors.accent : colors.dim}>Filter: </Text>
                    <TextInput
                        value={filter}
                        onChange={setFilter}
                        onSubmit={() => setEditing(false)}
                        onCancel={() => {
                            setFilter("");
                            setEditing(false);
                        }}
                        focus={editing && active}
                        width={Math.max(1, width - 8)}
                        placeholder="name, full name, UID or group"
                        hints={[["enter", "done"], ["esc", "clear"]]}
                    />
                </Box>
            )}
            </Panel>
            <Panel plain={!boxed} title="Accounts" width={props.width} height={tableHeight + PANEL_EDGE}>
            <Table rows={rows} columns={columns} nav={nav} width={width} height={tableHeight}
                   empty={<EmptyNote text={empty} width={width} height={tableHeight - 1} />} />
            </Panel>
        </Box>
    );
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
