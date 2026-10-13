/*
 * The Storage page's two views: the device tree, and one device's details.
 *
 *     Name                         Device   Content               Location     Used / Size
 *   › Samsung SSD 970 (S6S1…)      nvme0n1  Partitions (gpt)                       1.00 TB
 *     ├─nvme0n1p1                           vfat filesystem       /boot/efi   7.4 / 630 MB █░░░░░░░
 *     └─nvme0n1p3                           LVM2 physical volume  rhel              998 GB
 *
 * Nothing depends on colour: a device that is not in use (not mounted,
 * locked, inactive) says so in words in the Location column.
 *
 * Where panels are drawn, every top-level device -- a drive, a volume group
 * -- is a panel of its own, titled with its name, holding its row and the
 * rows of what is inside it. The columns line up across the panels, under
 * one header line; the selection moves through all of them as one list, and
 * the panels scroll as a whole to keep the selected device's in view:
 *
 *     Name          Content               Location      Size  Used
 *   ┌─┤ Samsung SSD 970 (S6S1…) ├──────────────────────────────────┐
 *   │› nvme0n1      Partitions (gpt)                  1.00 TB      │
 *   │  ├─nvme0n1p1  vfat filesystem       /boot/efi    629 MB    1%│
 *   └──────────────────────────────────────────────────────────────┘
 *   ┌─┤ rhel ├─────────────────────────────────────────────────────┐
 *   │  Volume group LVM2 volume group     0 B free     998 GB      │
 *
 * Above the devices, upstream's two plots of what the drives are doing:
 *
 *   ┌─┤ MiB/s Reading ├──────────── 12.3 ─┐ ┌─┤ MiB/s Writing ├───────────── 0.48 ─┐
 *   │30               ▂▅                  │ │1.5                                  │
 *   │20           ▁▃▅███▆▃                │ │  1        ▂                 ▁       │
 *   │10 ▁▁▁▁▁▁▂▃▅▇█████████▇▅▂▁▁▁▁▁▁▁▁▁▁▁▁│ │0.5 ▁▁▁▁▁▁█▃▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▂█▁▁▁▁▁▁▁▁│
 *   │ 0    16:24            16:25         │ │  0   16:24            16:25         │
 *
 * Down the left, the rate at the top of each row; along the foot, the time
 * of day where each minute began.
 *
 * Without panels (a small terminal, COCKPIT_TUI_PANELS=0) it is one table,
 * under one line with both rates and a strip of each plot.
 */
import { useEffect, useMemo, useRef } from "react";
import { Box, Text } from "../../tui/ink.js";
import { useKeys, type Hint } from "../../tui/keyboard.js";
import { Table, useListNav, type Column, type ListNav } from "../../tui/components/Table.js";
import { ScrollView, type LineLike } from "../../tui/components/ScrollView.js";
import { Panel, PANEL_EDGE, panelled } from "../../tui/components/Panel.js";
import { fit, truncate, width as textWidth } from "../../tui/text.js";
import { colors, glyphs, unicode } from "../../tui/theme.js";
import { clean } from "../../lib/hosttext.js";
import { formatRate, plotRows, plotScale } from "../../lib/plot.js";
import { PLOT_EXTRA_ROWS, plotHeight, PlotPair } from "../../tui/components/Plot.js";
import type { Throughput } from "./store.js";
import {
    detailSections, formatSize, formatUsage, rowActions, type ActionId, type ActionInfo, type Objects, type Row, type Usage,
} from "./model.js";

const TREE = unicode
    ? { branch: "├─", last: "└─", pipe: "│ ", blank: "  " }
    : { branch: "|-", last: "`-", pipe: "| ", blank: "  " };

/** The tree lines in front of a row's name. */
export function treePrefix(row: Row): string {
    return row.lasts.map((last, i) =>
        (i === row.lasts.length - 1 ? (last ? TREE.last : TREE.branch) : (last ? TREE.blank : TREE.pipe))).join("");
}

/** The usage of the filesystem on a row: by its first mount point. */
export function rowUsage(row: Row, usage: ReadonlyMap<string, Usage>): Usage | null {
    for (const dir of row.mountPoints) {
        const found = usage.get(dir);
        if (found && found.total > 0)
            return found;
    }
    return null;
}

/** Room for "5.8 / 14 TB" and for "1.00 TB". */
const SIZE_WIDTH = 14;
const BAR_WIDTH = 8;

/** How full, as a bar `width` cells long: at least one cell once anything is used, never full before it is. */
export function usageBar(fraction: number, width: number): string {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
    let filled = Math.round(clamped * width);
    if (clamped > 0 && filled === 0)
        filled = 1;
    if (clamped < 1 && filled === width)
        filled = width - 1;
    return glyphs.barFull.repeat(filled) + glyphs.barEmpty.repeat(width - filled);
}

function usageColor(fraction: number): string | undefined {
    return fraction >= 0.95 ? colors.error : fraction >= 0.8 ? colors.warning : undefined;
}

function shortDevice(row: Row): string {
    return clean(row.device.replace(/^\/dev\/(mapper\/)?/, ""));
}

/** A top-level row inside its own panel: the panel's title has its name, so the row says which device it is. */
function headName(row: Row): string {
    return shortDevice(row) || (row.kind === "vgroup" ? "Volume group" : row.kind === "drive" ? "Drive" : clean(row.name));
}

/** `grouped`: for the per-device panels, where a top-level row's name is its panel's title. */
function columnsFor(rows: readonly Row[], usage: ReadonlyMap<string, Usage>, grouped: boolean): Column<Row>[] {
    const widest = (texts: string[], min: number, max: number) =>
        Math.max(min, Math.min(max, Math.max(0, ...texts.map(t => textWidth(t)))));
    const name = (row: Row) => (grouped && row.depth === 0 ? headName(row) : `${treePrefix(row)}${clean(row.name)}`);
    // A partition's name is its device: said once.
    const device = (row: Row) => {
        const short = shortDevice(row);
        return short === clean(row.name) ? "" : short;
    };
    return [
        { id: "name", title: "Name", grow: 3, minWidth: widest(rows.map(name), 12, 24), value: name },
        // In a panel the top-level row already is its device, and a volume's device is its group and name.
        ...(grouped ? [] : [{
            id: "device", title: "Device", width: widest(rows.map(device), 6, 16), dropPriority: 3, value: device, color: () => colors.dim,
        } satisfies Column<Row>]),
        {
            id: "content", title: "Content", grow: 2, minWidth: widest(rows.map(r => clean(r.contentText)), 10, 20), dropPriority: 1,
            value: row => clean(row.contentText), color: row => (row.content === "empty" || row.content === "none" ? colors.dim : undefined),
        },
        {
            id: "location", title: "Location", grow: 2, minWidth: 10,
            value: row => clean(row.location), color: row => (row.idle ? colors.warning : undefined),
        },
        {
            // A mounted filesystem: how much of it is used; anything else: how big it is.
            id: "size", title: "Used / Size", width: SIZE_WIDTH, align: "right",
            value: row => {
                const u = rowUsage(row, usage);
                return u ? formatUsage(u.used, u.total) : row.size > 0 ? formatSize(row.size) : "";
            },
        },
        {
            id: "used", title: "", width: BAR_WIDTH, dropPriority: 2,
            value: row => {
                const u = rowUsage(row, usage);
                return u ? usageBar(u.used / u.total, BAR_WIDTH) : "";
            },
            color: row => {
                const u = rowUsage(row, usage);
                return u ? usageColor(u.used / u.total) ?? colors.accent : undefined;
            },
        },
    ];
}

/** The footer hints for a row's actions: only the ones that can be done now, and only with access. */
function actionHints(actions: readonly ActionInfo[], allowed: boolean): Hint[] {
    return allowed ? actions.filter(a => a.blocked === null).map(a => [a.key, a.label] as const) : [];
}

export interface ViewProps {
    readonly objects: Objects;
    readonly rows: readonly Row[];
    readonly usage: ReadonlyMap<string, Usage>;
    /** What the drives are reading and writing, for the plots. */
    readonly throughput: Throughput;
    /** Administrative access is on. */
    readonly allowed: boolean;
    readonly width: number;
    readonly height: number;
    /** An action key was pressed on a row; the page decides what happens. */
    readonly onAction: (action: ActionInfo, row: Row) => void;
    /** Read everything again. */
    readonly onRefresh: () => void;
    /** A dialog is open: keys are its. */
    readonly busy: boolean;
}

// ---- the plots -------------------------------------------------------------------

/** The two plots side by side, as wide as the page. */
function Plots({ throughput, width, rows }: { throughput: Throughput, width: number, rows: number }) {
    return (
        <PlotPair width={width} rows={rows} times={throughput.times}
                  left={{ title: "Reading", samples: throughput.readHistory, current: throughput.read }}
                  right={{ title: "Writing", samples: throughput.writeHistory, current: throughput.write }} />
    );
}

/** Both rates on one line, each with a strip of its plot: what a page without panels shows. */
export function throughputLine(throughput: Throughput, width: number): { label: string, value: string, strip: string }[] {
    const strip = Math.max(0, Math.floor((width - 2) / 2) - 22);
    return ([["Reading", throughput.read, throughput.readHistory], ["Writing", throughput.write, throughput.writeHistory]] as const)
            .map(([label, current, history]) => ({
                label,
                value: current === null ? glyphs.ellipsis : formatRate(current),
                strip: plotRows(history, strip, 1, plotScale(history), !unicode)[0] ?? "",
            }));
}

/** A top-level device with what is inside it: one panel. */
export interface Group {
    readonly head: Row;
    readonly rows: readonly Row[];
    /** Index of the head in the whole list. */
    readonly start: number;
}

export function groupRows(rows: readonly Row[]): Group[] {
    const groups: { head: Row, rows: Row[], start: number }[] = [];
    rows.forEach((row, i) => {
        if (row.depth === 0 || groups.length === 0)
            groups.push({ head: row, rows: [row], start: i });
        else
            groups.at(-1)!.rows.push(row);
    });
    return groups;
}

/**
 * Which panels are drawn, from `first` on, in `available` lines: as many
 * whole ones as fit. One that is taller than everything available is cut to
 * it and scrolls inside. `first` moves just far enough to hold `selected`.
 */
export function panelWindow(heights: readonly number[], selected: number, first: number, available: number): { first: number, count: number } {
    let from = Math.max(0, Math.min(first, heights.length - 1));
    if (selected >= 0 && selected < from)
        from = selected;
    const span = (a: number, b: number) => heights.slice(a, b + 1).reduce((sum, h) => sum + h, 0);
    while (selected > from && span(from, selected) > available)
        from++;
    let count = 0;
    let used = 0;
    for (let i = from; i < heights.length; i++) {
        if (count > 0 && used + heights[i]! > available)
            break;
        used += heights[i]!;
        count++;
    }
    return { first: from, count };
}

/** A list position for a Table that only draws: the selection is the page's. */
function fixedNav(index: number, offset: number, visible: number, count: number): ListNav {
    return { index, key: null, offset, visible, count, select() {}, selectKey() {}, handleKey: () => false };
}

function actionFor(actions: readonly ActionInfo[], input: string): ActionInfo | null {
    return actions.find(a => a.key === input) ?? null;
}

export function DeviceList(props: ViewProps & {
    readonly initialSelection: string | null;
    readonly onSelection: (id: string) => void;
    readonly onOpen: (id: string) => void;
    readonly summary: string;
    readonly warning: string | null;
}) {
    const { objects, rows, usage } = props;
    const boxed = panelled(props.width, props.height);
    const width = boxed ? props.width - PANEL_EDGE : props.width;
    const height = boxed ? props.height - PANEL_EDGE : props.height;
    const keys = useMemo(() => rows.map(row => row.id), [rows]);
    const nav = useListNav(keys, Math.max(1, height - 2), { active: !props.busy, initialKey: props.initialSelection });
    const selected = nav.index >= 0 ? rows[nav.index] ?? null : null;
    const actions = useMemo(() => (selected ? rowActions(objects, selected) : []), [objects, selected]);
    const columns = useMemo(() => columnsFor(rows, usage, boxed), [rows, usage, boxed]);
    const groups = useMemo(() => groupRows(rows), [rows]);
    // The first panel drawn: kept, so that moving the selection inside what is on screen scrolls nothing.
    const firstPanel = useRef(0);

    // Saved when the list goes away, not on every move: see services/list.tsx.
    const save = useRef<() => void>(() => {});
    save.current = () => {
        if (nav.key !== null)
            props.onSelection(nav.key);
    };
    useEffect(() => () => save.current(), []);

    useKeys((input, key) => {
        if (key.return) {
            if (nav.key)
                props.onOpen(nav.key);
            return true;
        }
        if (key.ctrl && input === "r") {
            props.onRefresh();
            return true;
        }
        if (key.ctrl || key.meta)
            return false;
        if (input === "j" || input === "k") {
            nav.select(nav.index + (input === "j" ? 1 : -1));
            return true;
        }
        const action = selected ? actionFor(actions, input) : null;
        if (action && selected) {
            props.onAction(action, selected);
            return true;
        }
        return false;
    }, {
        active: !props.busy,
        hints: [["enter", "details"], ...actionHints(actions, props.allowed), ["ctrl+r", "refresh"]],
        help: [
            ["enter", "details"], ["m", "mount"], ["u", "unmount"], ["o", "unlock"], ["l", "lock"],
            ["s", "start swap"], ["x", "stop swap"], ["f", "format"], ["ctrl+r", "refresh"],
        ],
    });

    const detail = props.warning ? clean(props.warning) : props.summary;
    if (boxed && groups.length > 0) {
        // One header line, then the panels. Inside a panel: its border on each side and its shadow.
        const inner = props.width - PANEL_EDGE;
        const plotted = plotHeight(props.height);
        // The plots, the header line, then the devices' panels in what is left.
        const available = Math.max(PANEL_EDGE + 1, props.height - 1 - (plotted + PLOT_EXTRA_ROWS));
        const heights = groups.map(group => Math.min(group.rows.length + PANEL_EDGE, available));
        const current = groups.findIndex(group => nav.index >= group.start && nav.index < group.start + group.rows.length);
        const shown = panelWindow(heights, current, firstPanel.current, available);
        firstPanel.current = shown.first;
        const all = shown.count === groups.length;
        return (
            <Box flexDirection="column" width={props.width} height={props.height}>
                <Plots throughput={props.throughput} width={props.width} rows={plotted} />
                <Box marginLeft={1} width={inner} height={1} flexShrink={0}>
                    {/* The column titles, once, over the panels' columns. */}
                    <Table rows={[]} columns={columns} nav={fixedNav(-1, 0, 0, 0)} width={inner} height={1} />
                </Box>
                {groups.slice(shown.first, shown.first + shown.count).map((group, i) => {
                    const height = heights[shown.first + i]!;
                    const visible = height - PANEL_EDGE;
                    const index = nav.index - group.start;
                    const within = index >= 0 && index < group.rows.length;
                    const offset = within ? Math.max(0, Math.min(index - visible + 1, group.rows.length - visible)) : 0;
                    return (
                        <Panel key={group.head.id} title={clean(group.head.name)} width={props.width} height={height}
                               {...(i === 0 && props.warning
                                   ? { detail: truncate(clean(props.warning), Math.max(0, inner - 30)) }
                                   // Not every panel fits: the one with the selection says where in the list it is.
                                   : within && !all ? { detail: `${nav.index + 1}/${rows.length}` } : {})}>
                            <Table rows={group.rows} columns={columns} showHeader={false} width={inner} height={visible}
                                   nav={fixedNav(within ? index : -1, offset, visible, group.rows.length)} focused={!props.busy} />
                        </Panel>
                    );
                })}
            </Box>
        );
    }
    return (
        <Panel plain={!boxed} title="Storage" detail={truncate(detail, Math.max(0, width - 14))} width={props.width} height={props.height}>
            <Box flexDirection="column" width={width} height={height}>
                <Text wrap="truncate">
                    {throughputLine(props.throughput, width).map((part, i) => (
                        <Text key={part.label}>
                            {i ? "  " : ""}
                            <Text color={colors.dim}>{`${part.label} `}</Text>
                            {fit(part.value, 11)}
                            <Text color={colors.accent}>{part.strip}</Text>
                        </Text>
                    ))}
                </Text>
                <Table rows={rows} columns={columns} nav={nav} width={width} height={Math.max(2, height - 1)}
                       focused={!props.busy} empty="No storage devices." />
            </Box>
        </Panel>
    );
}

/** A row's details as lines: headings, then "label  value". */
export function detailLines(objects: Objects, row: Row, usage: Usage | null, actions: readonly ActionInfo[], allowed: boolean, width: number): LineLike[] {
    const lines: LineLike[] = [];
    const sections = detailSections(objects, row, usage);
    const labels = Math.min(22, Math.max(0, ...sections.flatMap(s => s.fields.map(f => textWidth(f.label)))) + 2);
    const tones = { ok: colors.ok, warning: colors.warning, error: colors.error } as const;
    for (const section of sections) {
        if (lines.length)
            lines.push("");
        lines.push({ text: section.title, bold: true, color: colors.accent });
        for (const field of section.fields) {
            lines.push({
                text: truncate(`${fit(field.label, labels)}${clean(field.value)}`, width),
                ...(field.tone ? { color: tones[field.tone] } : {}),
            });
        }
    }
    const blocked = actions.filter(a => a.blocked !== null);
    if (actions.length && !allowed) {
        lines.push("", { text: "Changing storage requires administrative access: press A.", color: colors.warning });
    } else if (blocked.length) {
        lines.push("");
        for (const action of blocked)
            lines.push({ text: truncate(clean(`Cannot ${action.label}: ${action.blocked}.`), width), color: colors.warning });
    }
    return lines;
}

export function DeviceDetails(props: ViewProps & { readonly row: Row, readonly onBack: () => void }) {
    const { objects, row, usage } = props;
    const boxed = panelled(props.width, props.height);
    const width = boxed ? props.width - PANEL_EDGE : props.width;
    const height = boxed ? props.height - PANEL_EDGE : props.height;
    const actions = useMemo(() => rowActions(objects, row), [objects, row]);
    const lines = useMemo(() => detailLines(objects, row, rowUsage(row, usage), actions, props.allowed, width),
                          [objects, row, usage, actions, props.allowed, width]);

    useKeys((input, key) => {
        if (key.escape || key.backspace) {
            props.onBack();
            return true;
        }
        if (key.ctrl && input === "r") {
            props.onRefresh();
            return true;
        }
        if (key.ctrl || key.meta)
            return false;
        const action = actionFor(actions, input) as ActionInfo | null;
        if (action) {
            props.onAction(action, row);
            return true;
        }
        return false;
    }, {
        active: !props.busy,
        hints: [["esc", "back"], ...actionHints(actions, props.allowed)],
    });

    return (
        <Panel plain={!boxed} title={clean(row.name)} detail={clean(row.device)} width={props.width} height={props.height}>
            <ScrollView lines={lines} width={width} height={height} active={!props.busy} />
        </Panel>
    );
}

export type { ActionId };
