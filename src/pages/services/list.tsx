/*
 * The unit list: a tab per unit type, the owner (system or user units), a
 * text filter, a state filter, and the table itself.
 *
 *   [Services]  Targets  Sockets!  Timers  Paths                [System] User
 *   331 services · 1 failed · /ssh · failed only
 *     Unit              Description             State            Startup
 *   › sshd              OpenSSH server daemon   Running          Enabled
 *
 * A failed row is marked three ways -- red, a cross, and sorted to the top --
 * and a tab with failed units carries a "!".
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text } from "../../tui/ink.js";
import { useKeys } from "../../tui/keyboard.js";
import { useInterval } from "../../tui/hooks.js";
import { Table, useListNav, type Column } from "../../tui/components/Table.js";
import { TextInput } from "../../tui/components/TextInput.js";
import { Notice } from "../../tui/components/misc.js";
import { Panel, PANEL_EDGE, panelled } from "../../tui/components/Panel.js";
import { fit, formatTimestamp, truncate, width as textWidth } from "../../tui/text.js";
import { colors, glyphs } from "../../tui/theme.js";
import {
    ACTIONS, actionRowText, buildRows, failedByType, filterIsEmpty, filterOptions, isActive, NO_FILTER, TYPE_LABELS, UNIT_TYPES,
    type ActionId, type Owner, type StateFilter, type UnitRow, type UnitType,
} from "./model.js";
import type { UnitStore } from "./store.js";
import { FilterDialog } from "./dialogs.js";
import { runningActions } from "./actions.js";
import { clean, fitText, relativeTime, sentence } from "./format.js";

export interface UnitListProps {
    readonly store: UnitStore;
    readonly owner: Owner;
    readonly tab: UnitType;
    readonly text: string;
    readonly filter: StateFilter;
    readonly initialSelection: string | null;
    /** The owner toggle is offered (not root, and the session bus answers). */
    readonly canSwitchOwner: boolean;
    readonly width: number;
    readonly height: number;
    readonly onTab: (tab: UnitType) => void;
    readonly onText: (text: string) => void;
    readonly onFilter: (filter: StateFilter) => void;
    /** The row selected on this owner's tab, saved when the list goes away (not per move). */
    readonly onSelection: (owner: Owner, tab: UnitType, id: string) => void;
    readonly onOpen: (id: string) => void;
    readonly onOwner: () => void;
    /** Replace a store whose channel closed with a new one. */
    readonly onReconnect: () => void;
}

/** The tab's own suffix is implied by the tab: "sshd" on Services, "multi-user" on Targets. */
function displayName(id: string, tab: UnitType): string {
    const suffix = "." + tab;
    return id.endsWith(suffix) && id.length > suffix.length ? id.slice(0, -suffix.length) : id;
}

function rowGlyph(row: UnitRow): string {
    if (row.hasFailed)
        return glyphs.cross;
    if (row.activeState === undefined)
        return " "; // an alias: no state of its own
    return isActive(row.activeState) || row.activeState === "deactivating" ? glyphs.bullet : glyphs.hollow;
}

function rowColor(row: UnitRow): string | undefined {
    if (row.hasFailed)
        return colors.error;
    switch (row.activeState) {
    case "active": return colors.ok;
    case "activating":
    case "deactivating":
    case "reloading": return colors.warning;
    default: return colors.dim;
    }
}

function startupColor(row: UnitRow): string | undefined {
    switch (row.fileState) {
    case "enabled":
    case "enabled-runtime":
    case "disabled":
        return undefined;
    case "masked":
    case "masked-runtime":
        return colors.warning;
    case "bad":
    case "invalid":
        return colors.error;
    default:
        return colors.dim;
    }
}

/** An action under way, as its unit's row shows it: "Disabling…". */
function rowPending(action: ActionId): string {
    return `${actionRowText(action)}${glyphs.ellipsis}`;
}

/** Room for any of those, so the columns never move while an action runs. */
const PENDING_WIDTH = Math.max(...ACTIONS.map(a => textWidth(rowPending(a.id))));

/** The Timers tab's "Next run" column: "in 23 minutes". */
const NEXT_RUN_WIDTH = 14;

/**
 * The table's columns. Lower-value columns drop first as the page narrows
 * (dropPriority: higher goes earlier). On the Timers tab the relative times
 * ("in 23 minutes") outlast the absolute ones, as in `systemctl list-timers`.
 */
function columnsFor(tab: UnitType, rows: readonly UnitRow[], now: number,
                    pendingOf: (id: string) => ActionId | null, width: number): Column<UnitRow>[] {
    const widest = (texts: string[], min: number, max: number) =>
        Math.max(min, Math.min(max, Math.max(0, ...texts.map(t => textWidth(t)))));
    const pendingText = (row: UnitRow) => {
        const action = pendingOf(row.id);
        return action === null ? null : rowPending(action);
    };
    const timers = tab === "timer";
    // Sized by the states alone: a running action's text fits in it anyway.
    const stateWidth = widest(rows.map(r => r.combinedState), Math.max(11, PENDING_WIDTH), 26);
    const startupWidth = widest(rows.map(r => r.startup), 7, 12);
    // The name is what tells rows apart: other columns go before it is cut
    // short -- except a timer's next run, which is what that tab is for. Its
    // room: the table less the selection marker (2), the glyph, the state,
    // the next run and the gaps between them.
    const nameRoom = timers ? width - 2 - (1 + stateWidth + NEXT_RUN_WIDTH + 3) : 24;
    const unitWidth = widest(rows.map(r => clean(displayName(r.id, tab))), 12, Math.max(12, Math.min(24, nameRoom)));
    // Undefined: not known yet (or not loaded); null: known to have none.
    const absolute = (ms: number | null | undefined) =>
        ms ? formatTimestamp(ms, false) : ms === null ? "n/a" : "";
    const relative = (ms: number | null | undefined) =>
        ms ? relativeTime(ms, now) : ms === null ? "n/a" : "";

    const columns: Column<UnitRow>[] = [
        { id: "glyph", title: "", width: 1, value: rowGlyph, color: rowColor },
        {
            id: "unit", title: "Unit", grow: 2, minWidth: unitWidth,
            value: row => clean(displayName(row.id, tab)),
            color: row => (row.hasFailed ? colors.error : undefined),
        },
        {
            // A timer's description mostly repeats its name; its schedule matters more.
            id: "description", title: "Description", grow: 3, minWidth: 10, dropPriority: timers ? 7 : 2,
            // Masked and not-found units have their name as description; upstream hides it.
            value: row => (row.description === row.id ? "" : clean(row.description)), color: () => colors.dim,
        },
        {
            id: "state", title: "State", width: stateWidth,
            value: row => pendingText(row) ?? clean(row.combinedState),
            color: row => (pendingText(row) !== null ? colors.warning : row.hasFailed ? colors.error : undefined),
        },
        {
            id: "startup", title: "Startup", width: startupWidth, dropPriority: timers ? 2 : 1,
            value: row => clean(row.startup), color: startupColor,
        },
    ];
    if (timers) {
        columns.push(
            { id: "left", title: "Next run", width: NEXT_RUN_WIDTH, dropPriority: 1, value: row => relative(row.nextRun) },
            { id: "next", title: "At", width: 16, dropPriority: 3, value: row => absolute(row.nextRun), color: () => colors.dim },
            { id: "passed", title: "Last trigger", width: 14, dropPriority: 5, value: row => relative(row.lastTrigger) },
            { id: "last", title: "At", width: 16, dropPriority: 6, value: row => absolute(row.lastTrigger), color: () => colors.dim },
        );
    }
    return columns;
}

const OWNER_NAMES: Readonly<Record<Owner, string>> = { system: "System", user: "User" };

/**
 * How the tab bar fits: the gap between tabs, and whether the owner
 * ("[System] User") fits on the right. When it does not, the summary line
 * names the owner instead.
 */
function tabBarLayout(failed: ReadonlyMap<UnitType, number>, owner: Owner, canSwitchOwner: boolean, width: number) {
    const ownerParts = canSwitchOwner || owner === "user"
        ? (["system", "user"] as const).map(o => ({ text: o === owner ? `[${OWNER_NAMES[o]}]` : ` ${OWNER_NAMES[o]} `, current: o === owner }))
        : [];
    const ownerWidth = ownerParts.reduce((sum, p) => sum + textWidth(p.text), 0);
    const tabs = UNIT_TYPES.map(type => ({
        type,
        label: TYPE_LABELS[type],
        bang: (failed.get(type) ?? 0) > 0,
    }));
    // Two spaces between tabs if they fit, one if not.
    const tabsWidth = (gap: number) => tabs.reduce((sum, t, i) => sum + textWidth(t.label) + 2 + (t.bang ? 1 : 0) + (i ? gap : 0), 0);
    const gap = tabsWidth(2) + ownerWidth + 2 <= width ? 2 : 1;
    const showOwner = ownerParts.length > 0 && tabsWidth(gap) + ownerWidth + 1 <= width;
    const used = tabsWidth(gap) + (showOwner ? ownerWidth : 0);
    return { ownerParts, tabs, gap, showOwner, used };
}

/** The tab bar, with failure markers, and the owner on the right. */
function TabBar({ tab, failed, owner, canSwitchOwner, width }: {
    tab: UnitType, failed: ReadonlyMap<UnitType, number>, owner: Owner, canSwitchOwner: boolean, width: number,
}) {
    const { ownerParts, tabs, gap, showOwner, used } = tabBarLayout(failed, owner, canSwitchOwner, width);
    const bang = <Text bold color={colors.error}>!</Text>;

    return (
        <Box width={width} height={1}>
            <Text wrap="truncate">
                {tabs.map((t, i) => (
                    <Text key={t.type}>
                        {i ? " ".repeat(gap) : ""}
                        {t.type === tab
                            ? <Text bold color={colors.accent}>[{t.label}{t.bang ? bang : ""}]</Text>
                            : <Text color={colors.dim}> {t.label}{t.bang ? bang : ""} </Text>}
                    </Text>
                ))}
                {showOwner ? " ".repeat(Math.max(1, width - used)) : ""}
                {showOwner && ownerParts.map(p => (
                    <Text key={p.text} bold={p.current} color={p.current ? colors.accent : colors.dim}>{p.text}</Text>
                ))}
            </Text>
        </Box>
    );
}

export function UnitList(props: UnitListProps) {
    const { store, owner, tab, text, filter } = props;
    // Two panels when there is room: the tabs and the summary, and the table.
    // `width` and `height` are what is left for those lines inside them.
    const boxed = panelled(props.width, props.height);
    const width = boxed ? props.width - PANEL_EDGE : props.width;
    const height = boxed ? props.height - 2 * PANEL_EDGE : props.height;
    const version = useSyncExternalStore(store.subscribe, store.getVersion);
    const [editing, setEditing] = useState(false);
    const [picking, setPicking] = useState(false);

    // Timer state costs a GetAll per timer: fetched only once the tab is shown.
    useEffect(() => {
        if (tab === "timer")
            store.wantTimers();
    }, [store, tab]);

    const rows = useMemo(() => buildRows({
        units: store.units.values(), files: store.files, type: tab, text, filter,
        timers: store.timers, monotonicBase: store.monotonicBase,
    }), [store, version, tab, text, filter]);
    const total = useMemo(() => buildRows({ units: store.units.values(), files: store.files, type: tab }).length,
                          [store, version, tab]);
    const failed = useMemo(() => failedByType(store.units.values()), [store, version]);
    const failedTotal = [...failed.values()].reduce((a, b) => a + b, 0);
    const keys = useMemo(() => rows.map(row => row.id), [rows]);

    const tableHeight = Math.max(2, height - 2);
    const nav = useListNav(keys, tableHeight - 1, { active: !picking, initialKey: props.initialSelection });

    // The selection is saved when the list goes away -- another tab or owner,
    // a unit's details, another page -- not on every move: saving re-renders
    // the whole page, and a held arrow key would do that once per row.
    const save = useRef<() => void>(() => {});
    save.current = () => {
        if (nav.key !== null)
            props.onSelection(owner, tab, nav.key);
    };
    useEffect(() => () => save.current(), []);

    const filtering = text !== "" || !filterIsEmpty(filter);

    // Actions running on units (started from their details) show on their rows.
    const actionsVersion = useSyncExternalStore(runningActions.subscribe, runningActions.version);
    const pendingOf = useCallback((id: string) => runningActions.get(owner, id)?.action ?? null,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [owner, actionsVersion]);

    // Relative timer times ("in 23 minutes") need a clock, but only on that
    // tab: `tick` re-renders them every 10 seconds; any repaint refreshes them.
    const [tick, setTick] = useState(0);
    useInterval(() => setTick(n => n + 1), tab === "timer" ? 10_000 : null);
    const columns = useMemo(() => columnsFor(tab, rows, Date.now(), pendingOf, width),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tab, rows, tick, pendingOf, width]);

    useKeys((input, key) => {
        if (key.leftArrow || key.rightArrow) {
            const at = UNIT_TYPES.indexOf(tab);
            const next = UNIT_TYPES[(at + (key.rightArrow ? 1 : -1) + UNIT_TYPES.length) % UNIT_TYPES.length]!;
            props.onTab(next);
            return true;
        }
        if (key.return) {
            if (nav.key)
                props.onOpen(nav.key);
            return true;
        }
        if (key.escape) {
            if (text) {
                props.onText("");
                return true;
            }
            return false;
        }
        if (key.ctrl && input === "r") {
            if (store.fatal)
                props.onReconnect();
            else
                store.relist();
            return true;
        }
        if (key.ctrl || key.meta)
            return false;
        switch (input) {
        case "j":
            nav.select(nav.index + 1);
            return true;
        case "k":
            nav.select(nav.index - 1);
            return true;
        case "/":
            setEditing(true);
            return true;
        case "f":
            setPicking(true);
            return true;
        case "F":
            props.onFilter({ ...filter, failedOnly: !filter.failedOnly });
            return true;
        case "c":
            props.onText("");
            props.onFilter(NO_FILTER);
            return true;
        case "o":
            props.onOwner();
            return true;
        default:
            return false;
        }
    }, {
        active: !editing && !picking,
        hints: [
            // Without a list there is nothing to open, search or filter: only
            // the way out of the error is worth the footer's room.
            ...(store.status === "error"
                ? [["ctrl+r", store.fatal ? "reconnect" : "retry"] as const, [glyphs.leftright, "type"] as const]
                : [
                    ["enter", "open"] as const,
                    [glyphs.leftright, "type"] as const,
                    ["/", "search"] as const,
                    ["f", "filter"] as const,
                    ["F", "failed only"] as const, // a toggle; the summary line says when it is on
                    ...(filtering ? [["c", "clear filters"] as const] : []),
                ]),
            ...(props.canSwitchOwner || owner === "user" ? [["o", owner === "system" ? "user units" : "system units"] as const] : []),
        ],
    });

    // ---- the summary line --------------------------------------------------------
    const count = (n: number) => `${n} ${n === 1 ? tab : TYPE_LABELS[tab].toLowerCase()}`;
    const parts: { text: string, color?: string }[] = [];
    // Whose units these are, when the tab bar has no room to say.
    const layout = tabBarLayout(failed, owner, props.canSwitchOwner, width);
    if (layout.ownerParts.length && !layout.showOwner)
        parts.push({ text: OWNER_NAMES[owner], color: colors.accent });
    if (store.status === "ready") {
        parts.push({ text: filtering ? `${rows.length} of ${count(total)}` : count(total) });
        if (failedTotal)
            parts.push({ text: `${failedTotal} failed`, color: colors.error });
    }
    if (text && !editing)
        parts.push({ text: `/${clean(text)}`, color: colors.accent });
    if (filter.failedOnly)
        parts.push({ text: "failed only", color: colors.accent });
    if (filter.active.length || filter.file.length)
        parts.push({ text: [...filter.active, ...filter.file].join(", "), color: colors.accent });
    const status = store.reloading ? `systemd is reloading${glyphs.ellipsis}`
        : store.warning ? clean(store.warning)
        : store.listing && store.status === "ready" ? `refreshing${glyphs.ellipsis}` : "";

    let summary;
    if (editing) {
        summary = (
            <Box width={width} height={1}>
                <Text color={colors.accent}>Search: </Text>
                <TextInput
                    value={text}
                    width={Math.max(1, width - 8)}
                    placeholder="name or description"
                    onChange={props.onText}
                    onSubmit={() => setEditing(false)}
                    onCancel={() => {
                        props.onText("");
                        setEditing(false);
                    }}
                    hints={[["enter", "done"], ["esc", "clear"]]}
                />
            </Box>
        );
    } else {
        let used = 0;
        const shown = parts.filter(part => {
            const cost = textWidth(part.text) + (used ? 3 : 0);
            if (used + cost > width - (status ? Math.min(textWidth(status), 30) + 1 : 0))
                return false;
            used += cost;
            return true;
        });
        const room = Math.max(0, width - used);
        summary = (
            <Box width={width} height={1}>
                <Text wrap="truncate">
                    {shown.map((part, i) => (
                        <Text key={i}>
                            {i ? <Text color={colors.dim}>{` ${glyphs.dot} `}</Text> : ""}
                            <Text color={part.color}>{part.text}</Text>
                        </Text>
                    ))}
                    {status ? <Text color={store.warning ? colors.warning : colors.dim}>{fit(status, room, "right")}</Text> : ""}
                </Text>
            </Box>
        );
    }

    // ---- the table ---------------------------------------------------------------
    let body;
    if (store.status === "error") {
        const hint = store.fatal
            ? owner === "user" ? " Press Ctrl+R to reconnect, or o for the system units." : " Press Ctrl+R to reconnect."
            : " Press Ctrl+R to retry.";
        // Notice: padding of 2 on each side and a blank line above; it does not clip.
        body = (
            <Notice width={width} height={tableHeight} color={colors.error}>
                {fitText(sentence(clean(store.error ?? "Loading units failed")), width - 4, tableHeight - 1, hint.trim())}
            </Notice>
        );
    } else if (store.status === "loading") {
        body = <Notice width={width} height={tableHeight} loading>{owner === "user" ? "Listing your units" : "Listing units"}</Notice>;
    } else {
        const empty = filtering
            ? "No matching units. Press c to clear the filters."
            : `No ${TYPE_LABELS[tab].toLowerCase()}.`;
        body = (
            <Table rows={rows} columns={columns} nav={nav} width={width} height={tableHeight}
                   focused={!editing} empty={truncate(empty, Math.max(1, width - 2))} />
        );
    }

    return (
        <Box flexDirection="column" width={props.width} height={props.height}>
            <Panel plain={!boxed} title="Units" width={props.width} height={2 + PANEL_EDGE}>
                <TabBar tab={tab} failed={failed} owner={owner} canSwitchOwner={props.canSwitchOwner} width={width} />
                {summary}
            </Panel>
            <Panel plain={!boxed} title={TYPE_LABELS[tab]} detail={OWNER_NAMES[owner]} width={props.width} height={tableHeight + PANEL_EDGE}>
                {body}
            </Panel>
            {picking && (
                <FilterDialog
                    options={filterOptions(store.units.values(), store.files, filter)}
                    value={filter}
                    onApply={next => {
                        props.onFilter(next);
                        setPicking(false);
                    }}
                    onCancel={() => setPicking(false)}
                />
            )}
        </Box>
    );
}
