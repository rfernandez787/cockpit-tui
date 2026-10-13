/*
 * The groups list (upstream's "Groups" card, accounts-list.js), the second
 * tab of the list view:
 *
 *    Accounts  [Groups]  72 groups · by kind · 2 user-created
 *     Group              GID Kind   Users Members
 *   › wheel               10 admin      2 mock, ric
 *     ric               1000 user       1 ric
 *     docker             982 system     1 alice
 *
 * Kind: "admin" groups give their members the administrator role, "user"
 * groups have a GID in login.defs' range for people (the only ones renamed
 * or deleted here, as upstream), "system" ones belong to the system and its
 * packages. Members lists the accounts whose primary group it is first.
 * Enter shows a group's members in full.
 */
import { useEffect, useMemo, useState } from "react";
import { Box, Text } from "../../tui/ink.js";
import { useKeys, isPlain, type Hint } from "../../tui/keyboard.js";
import { Panel, PANEL_EDGE, panelled } from "../../tui/components/Panel.js";
import { Table, useListNav, type Column } from "../../tui/components/Table.js";
import { TextInput } from "../../tui/components/TextInput.js";
import { LimitedAccessBanner } from "../../tui/components/misc.js";
import { usePersistentState } from "../../tui/session-context.js";
import { usePrivilege } from "../../tui/privilege.js";
import { useStatus } from "../../tui/status.js";
import { clean } from "../../tui/text.js";
import { colors, glyphs } from "../../tui/theme.js";
import { matchesGroupFilter, sortGroups, type GroupInfo, type GroupSortKey, type LoginDefs } from "./model.js";
import { groupActions, NEEDS_ADMIN, type GroupActionId } from "./policy.js";
import { EmptyNote, TabLine } from "./ui.js";

export interface GroupListProps {
    readonly width: number;
    readonly height: number;
    readonly groups: readonly GroupInfo[];
    readonly loginDefs: LoginDefs;
    /** False while a dialog is open. */
    readonly active: boolean;
    /** ← →: back to the accounts. */
    readonly onSwitch: () => void;
    readonly onOpen: (group: GroupInfo) => void;
    readonly onCreate: () => void;
    readonly onAction: (id: GroupActionId, group: GroupInfo) => void;
    /** Select this group as soon as it is listed (it may have just been created or renamed). */
    readonly selectNext: string | null;
    readonly onSelectedNext: () => void;
}

interface SortState {
    readonly key: GroupSortKey;
    readonly reverse: boolean;
}

const SORT_ORDER: readonly GroupSortKey[] = ["kind", "name", "gid", "count"];
const SORT_LABEL: Record<GroupSortKey, string> = { kind: "kind", name: "name", gid: "GID", count: "users" };

export function kindOf(group: GroupInfo): "admin" | "user" | "system" {
    return group.admin ? "admin" : group.userCreated ? "user" : "system";
}

/** The accounts in a group: whose primary group it is first, then the members. */
export function groupMembers(group: GroupInfo): string[] {
    return [...group.primary, ...group.members.filter(member => !group.primary.includes(member))];
}

export function GroupList(props: GroupListProps) {
    const { groups, active } = props;
    // Two panels when there is room: the tabs with what is shown, and the table.
    // `width` and `height` are what is left for those lines inside them.
    const boxed = panelled(props.width, props.height);
    const width = boxed ? props.width - PANEL_EDGE : props.width;
    const height = boxed ? props.height - 2 * PANEL_EDGE : props.height;
    const privilege = usePrivilege();
    const allowed = privilege.allowed === true;
    const { notify } = useStatus();
    const [filter, setFilter] = usePersistentState("accounts:group-filter", "");
    const [editing, setEditing] = useState(false);
    const [sort, setSort] = usePersistentState<SortState>("accounts:group-sort", { key: "kind", reverse: false });
    const [selected, setSelected] = usePersistentState<string | null>("accounts:group-selected", null);

    const rows = useMemo(() => sortGroups(groups.filter(group => matchesGroupFilter(group, filter)), sort.key, sort.reverse),
                         [groups, filter, sort]);
    const banner = privilege.allowed === false && privilege.configured === true;
    const filterLine = editing || filter !== "";
    const tableHeight = Math.max(2, height - 1 - (banner ? 1 : 0) - (filterLine ? 1 : 0));

    const nav = useListNav(rows.map(group => group.name), tableHeight - 1, { active, initialKey: selected });
    const group = rows[nav.index] ?? null;

    // Remember the selection across leaving the page and remounts.
    useEffect(() => {
        if (nav.key !== null && nav.key !== selected)
            setSelected(nav.key);
    }, [nav.key, selected, setSelected]);

    // A group just created or renamed is selected once the /etc/group watch lists it.
    const { selectNext, onSelectedNext } = props;
    useEffect(() => {
        if (selectNext === null)
            return;
        if (rows.some(row => row.name === selectNext)) {
            nav.selectKey(selectNext);
            onSelectedNext();
        } else if (filter && groups.some(row => row.name === selectNext)) {
            setFilter(""); // it exists, but the filter hides it
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectNext, rows]);

    const actions = group
        ? groupActions(group, { allowed, gidMin: props.loginDefs.gidMin, gidMax: props.loginDefs.gidMax })
        : [];

    // Ordered and worded for an 80-column footer, like the accounts list's.
    const hints: Hint[] = [
        [glyphs.leftright, "accounts"],
        ["/", "filter"],
        ...(allowed ? [["n", "new"] as const] : []),
        ["s", "sort"],
        ["enter", "members"],
        ...actions.filter(action => action.enabled).map(action => [action.key, action.label] as const),
        ["S", "reverse"],
    ];

    useKeys((input, key) => {
        if (key.return) {
            if (group)
                props.onOpen(group);
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
        case "n":
            if (allowed)
                props.onCreate();
            else
                notify(`Creating groups ${NEEDS_ADMIN}`, "warning");
            return true;
        }
        const action = actions.find(a => a.key === input);
        if (!action || !group)
            return false;
        if (action.enabled)
            props.onAction(action.id, group);
        else
            notify(clean(`${action.label.charAt(0).toUpperCase()}${action.label.slice(1)}: ${action.reason}`), "warning");
        return true;
    }, { active: active && !editing, hints });

    const columns = useMemo<Column<GroupInfo>[]>(() => [
        {
            id: "name", title: "Group", grow: 1, minWidth: 12, value: g => clean(g.name),
            color: g => (kindOf(g) === "system" ? colors.dim : undefined),
        },
        { id: "gid", title: "GID", width: 6, align: "right", value: g => String(g.gid) },
        {
            id: "kind", title: "Kind", width: 6, dropPriority: 2, value: kindOf,
            color: g => (g.admin ? colors.warning : kindOf(g) === "system" ? colors.dim : undefined),
        },
        { id: "count", title: "Users", width: 5, align: "right", dropPriority: 1, value: g => String(g.count) },
        { id: "members", title: "Members", grow: 3, minWidth: 12, dropPriority: 3, value: g => groupMembers(g).map(clean).join(", ") },
    ], []);

    const userCreated = groups.filter(g => g.userCreated).length;
    const detail = [
        filter ? `${rows.length} of ${groups.length} groups` : `${rows.length} group${rows.length === 1 ? "" : "s"}`,
        `by ${SORT_LABEL[sort.key]}${sort.reverse ? " (reversed)" : ""}`,
        `${userCreated} user-created`,
    ].join(` ${glyphs.dot} `);
    const empty = filter ? `No groups match "${clean(filter)}". Esc clears the filter.` : "No groups.";

    return (
        <Box flexDirection="column" width={props.width} height={props.height}>
            <Panel plain={!boxed} title="View" width={props.width} height={props.height - tableHeight - PANEL_EDGE}>
            <TabLine current={1} detail={detail} width={width} />
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
                        placeholder="name or GID"
                        hints={[["enter", "done"], ["esc", "clear"]]}
                    />
                </Box>
            )}
            </Panel>
            <Panel plain={!boxed} title="Groups" width={props.width} height={tableHeight + PANEL_EDGE}>
            <Table rows={rows} columns={columns} nav={nav} width={width} height={tableHeight}
                   empty={<EmptyNote text={empty} width={width} height={tableHeight - 1} />} />
            </Panel>
        </Box>
    );
}
