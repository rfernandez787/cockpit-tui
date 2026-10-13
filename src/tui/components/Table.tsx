/*
 * A scrolling, selectable table.
 *
 * Selection follows the row's key, not its index, so a list that re-sorts or
 * grows underneath the cursor (units changing state, journal lines arriving)
 * keeps pointing at the same row. Only the visible window is rendered, so a
 * list of thousands costs no more than a screenful.
 *
 * Rows are assembled as fixed-width strings: the selected row is one inverse
 * run across the full width, and a marker glyph shows the selection even on
 * a terminal with no styling at all.
 */
import { useRef, useState, type ReactNode } from "react";
import { Box, Text } from "../ink.js";
import { useKeys, Layer, type Key, type Hint } from "../keyboard.js";
import { fit, width as textWidth, wrap } from "../text.js";
import { colors, glyphs } from "../theme.js";

export interface ListNav {
    /** Selected index, or -1 when the list is empty. */
    readonly index: number;
    /** Key of the selected row, or null when the list is empty. */
    readonly key: string | null;
    /** Index of the first visible row. */
    readonly offset: number;
    /** Rows that fit in the view. */
    readonly visible: number;
    readonly count: number;
    select(index: number): void;
    selectKey(key: string): void;
    /** Apply a navigation key; returns true when it was one. */
    handleKey(input: string, key: Key): boolean;
}

interface NavState {
    key: string | null;
    index: number;
    offset: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Selection and scrolling over `keys`, one per row in display order.
 *
 * With `active`, arrow keys, PgUp/PgDn and Home/End are consumed at the page
 * layer. Pass `active: false` to drive it yourself through handleKey.
 */
export function useListNav(keys: readonly string[], visible: number, options: {
    active?: boolean,
    initialKey?: string | null,
    hints?: readonly Hint[],
} = {}): ListNav {
    const [state, setState] = useState<NavState>(() => ({
        key: options.initialKey ?? null, index: 0, offset: 0,
    }));
    // Where the selected row last actually was. Rows move (a list re-sorts
    // or grows above the selection), so this, not the index it was selected
    // at, is where to fall back to when the row disappears.
    const lastResolved = useRef(0);

    const count = keys.length;
    const rows = Math.max(1, visible);

    // Resolve the selection against the current keys: by key if it still
    // exists, otherwise by where it last was, clamped.
    let index = -1;
    if (count > 0) {
        const byKey = state.key === null ? -1 : keys.indexOf(state.key);
        index = byKey >= 0 ? byKey : clamp(state.key === null ? state.index : lastResolved.current, 0, count - 1);
        if (byKey >= 0)
            lastResolved.current = byKey;
    }
    let offset = clamp(state.offset, 0, Math.max(0, count - rows));
    if (index >= 0) {
        if (index < offset)
            offset = index;
        else if (index >= offset + rows)
            offset = index - rows + 1;
    }

    const select = (next: number) => {
        if (count === 0)
            return;
        const target = clamp(next, 0, count - 1);
        lastResolved.current = target;
        let nextOffset = offset;
        if (target < nextOffset)
            nextOffset = target;
        else if (target >= nextOffset + rows)
            nextOffset = target - rows + 1;
        setState({ key: keys[target] ?? null, index: target, offset: nextOffset });
    };

    const selectKey = (key: string) => {
        const target = keys.indexOf(key);
        if (target >= 0)
            select(target);
        else
            setState(previous => ({ ...previous, key }));
    };

    const handleKey = (_input: string, key: Key): boolean => {
        if (count === 0)
            return key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end;
        if (key.upArrow) select(index - 1);
        else if (key.downArrow) select(index + 1);
        else if (key.pageUp) select(index - Math.max(1, rows - 1));
        else if (key.pageDown) select(index + Math.max(1, rows - 1));
        else if (key.home) select(0);
        else if (key.end) select(count - 1);
        else return false;
        return true;
    };

    useKeys(handleKey, {
        layer: Layer.page,
        active: options.active ?? true,
        hints: options.hints ?? [],
    });

    return {
        index,
        key: index >= 0 ? keys[index] ?? null : null,
        offset,
        visible: rows,
        count,
        select,
        selectKey,
        handleKey,
    };
}

export interface Column<T> {
    readonly id: string;
    readonly title: string;
    /** Fixed width. Omit for a flexible column sharing the leftover space. */
    readonly width?: number;
    /** Share of the leftover space among flexible columns; default 1. */
    readonly grow?: number;
    /** Flexible columns never shrink below this; default 8. */
    readonly minWidth?: number;
    /** Dropped first when space runs out; higher drops earlier. */
    readonly dropPriority?: number;
    readonly align?: "left" | "right";
    /** Cell text. Must already be safe for the terminal (see text.ts clean()). */
    readonly value: (row: T) => string;
    readonly color?: (row: T) => string | undefined;
}

/** Work out each column's width; columns that do not fit get 0 and are skipped. */
export function layoutColumns<T>(columns: readonly Column<T>[], total: number, gap = 1): number[] {
    const included = columns.map(() => true);

    const compute = (): number[] | null => {
        const live = columns.filter((_, i) => included[i]);
        const gaps = Math.max(0, live.length - 1) * gap;
        const fixed = live.reduce((sum, c) => sum + (c.width ?? 0), 0);
        const flexible = live.filter(c => c.width === undefined);
        const minFlex = flexible.reduce((sum, c) => sum + (c.minWidth ?? 8), 0);
        const room = total - gaps - fixed;
        if (room < minFlex)
            return null;
        // Every flexible column starts at its minimum; the extra is shared by
        // grow, and the rounding remainder goes to the last one, so the
        // flexible columns fill `room` exactly.
        const extra = room - minFlex;
        const totalGrow = flexible.reduce((sum, c) => sum + (c.grow ?? 1), 0) || 1;
        const widths = columns.map((c, i) => {
            if (!included[i])
                return 0;
            if (c.width !== undefined)
                return c.width;
            return (c.minWidth ?? 8) + Math.floor(extra * (c.grow ?? 1) / totalGrow);
        });
        const flexIndexes = columns.map((c, i) => (included[i] && c.width === undefined ? i : -1)).filter(i => i >= 0);
        const lastFlex = flexIndexes.at(-1);
        if (lastFlex !== undefined) {
            const used = flexIndexes.reduce((sum, i) => sum + widths[i]!, 0);
            widths[lastFlex] = widths[lastFlex]! + (room - used);
        }
        return widths;
    };

    for (;;) {
        const widths = compute();
        if (widths)
            return widths;
        // Drop the most expendable remaining column and try again.
        const liveCount = included.filter(Boolean).length;
        let drop = -1;
        let worst = 0;
        columns.forEach((c, i) => {
            if (included[i] && liveCount > 1 && (c.dropPriority ?? 0) > worst) {
                worst = c.dropPriority ?? 0;
                drop = i;
            }
        });
        if (drop < 0) {
            // Nothing left is expendable: squeeze what remains into the space.
            const each = Math.max(0, Math.floor((total - Math.max(0, liveCount - 1) * gap) / Math.max(1, liveCount)));
            return columns.map((c, i) => (included[i] ? Math.min(c.width ?? each, each) : 0));
        }
        included[drop] = false;
    }
}

export interface TableProps<T> {
    readonly rows: readonly T[];
    readonly columns: readonly Column<T>[];
    readonly nav: ListNav;
    readonly width: number;
    /** Total height including the header line. */
    readonly height: number;
    /** Selection drawn as inverse video when focused, as a marker only when not. */
    readonly focused?: boolean;
    readonly showHeader?: boolean;
    readonly empty?: ReactNode;
}

const MARKER_WIDTH = 2;

export function Table<T>(props: TableProps<T>) {
    const { rows, columns, nav, width, height, focused = true, showHeader = true } = props;
    if (height <= 0 || width <= 0)
        return null;
    const bodyHeight = Math.max(0, height - (showHeader ? 1 : 0));
    const widths = layoutColumns(columns, Math.max(0, width - MARKER_WIDTH));
    const shown = columns.map((c, i) => ({ column: c, width: widths[i]! })).filter(c => c.width > 0);

    let header = fit(" ".repeat(MARKER_WIDTH) + shown.map(c => fit(c.column.title, c.width, c.column.align)).join(" "), width);
    if (rows.length > bodyHeight && nav.index >= 0) {
        // Position indicator in the header's trailing blank space, never over a title.
        const position = ` ${nav.index + 1}/${rows.length}`;
        const titles = header.trimEnd();
        if (textWidth(titles) + textWidth(position) <= width)
            header = fit(titles, width - textWidth(position)) + position;
    }

    const visibleRows = rows.slice(nav.offset, nav.offset + bodyHeight);

    return (
        <Box flexDirection="column" width={width} height={height}>
            {showHeader && <Text bold wrap="truncate">{fit(header, width)}</Text>}
            {rows.length === 0 && props.empty !== undefined
                ? <Box width={width} height={bodyHeight} flexDirection="column">
                    {typeof props.empty === "string"
                        // Wrapped here, so every line keeps the rows' indent.
                        ? wrap(props.empty, Math.max(1, width - MARKER_WIDTH)).slice(0, Math.max(1, bodyHeight)).map((line, i) => (
                            <Text key={i} color={colors.dim} wrap="truncate">{" ".repeat(MARKER_WIDTH) + line}</Text>))
                        : props.empty}
                </Box>
                : visibleRows.map((row, i) => {
                    const index = nav.offset + i;
                    const selected = index === nav.index;
                    const marker = selected ? `${glyphs.pointer} ` : "  ";
                    const used = MARKER_WIDTH + shown.reduce((sum, c) => sum + c.width, 0) + Math.max(0, shown.length - 1);
                    return (
                        <Text key={index} inverse={selected && focused} bold={selected && !focused} wrap="truncate">
                            {fit(marker, MARKER_WIDTH)}
                            {shown.map((c, j) => (
                                <Text key={c.column.id} color={c.column.color?.(row)}>
                                    {(j > 0 ? " " : "") + fit(c.column.value(row), c.width, c.column.align)}
                                </Text>
                            ))}
                            {used < width ? " ".repeat(width - used) : ""}
                        </Text>
                    );
                })}
        </Box>
    );
}
