/*
 * Line-based layout for the overview.
 *
 * The page is a dashboard of short labelled rows in one or two columns, and
 * it must never draw more lines than it was given. Building it as a flat list
 * of lines -- each a run of styled segments fitted to an exact width --
 * keeps that arithmetic exact: the page knows its height before it renders,
 * scrolls by slicing the list, and knows which line every selectable row is
 * on. Flexbox would decide all of that out of sight.
 *
 * Segments are cut with an ellipsis and padded with spaces, so every line is
 * exactly as wide as its column and a selected row's inverse video runs the
 * full width, the way the shared Table draws its selection.
 */
import type { ReactNode } from "react";
import { Text } from "../../tui/ink.js";
import { meterBar } from "../../tui/components/Meter.js";
import { truncate, width as textWidth } from "../../tui/text.js";
import { colors, frame, glyphs, palette, shadowBelow, styled } from "../../tui/theme.js";
import { panelBottom, panelTop } from "../../tui/components/Panel.js";

export interface Seg {
    readonly text: string;
    readonly color?: string;
    readonly bold?: boolean;
    readonly inverse?: boolean;
    /** A panel's shadow: blank cells on the shadow's colour. */
    readonly shadow?: boolean;
}

export type Segs = readonly Seg[];

/** Cut `segs` to `width` columns (an ellipsis marks the cut) and pad to exactly `width`. */
export function fitSegs(segs: Segs, width: number): Seg[] {
    const out: Seg[] = [];
    let used = 0;
    for (const seg of segs) {
        if (used >= width)
            break;
        const w = textWidth(seg.text);
        if (used + w <= width) {
            out.push(seg);
            used += w;
            continue;
        }
        const cut = truncate(seg.text, width - used);
        out.push({ ...seg, text: cut });
        used += textWidth(cut);
        break;
    }
    if (used < width)
        out.push({ text: " ".repeat(width - used) });
    return out;
}

/**
 * The shared Meter's look ("[███░░░]", ASCII "[###...]") as segments.
 * `muted` draws an old value in grey, so it does not pass for a live one.
 */
export function meterSegs(fraction: number | null, width: number, warnAt = 0.8, dangerAt = 0.9, muted = false): Seg[] {
    if (width < 3)
        return [];
    const { filled, empty } = meterBar(fraction, width);
    const color = fraction === null || muted
        ? colors.dim
        : fraction >= dangerAt ? colors.error : fraction >= warnAt ? colors.warning : colors.ok;
    return [
        { text: "[" },
        { text: glyphs.barFull.repeat(filled), color },
        { text: glyphs.barEmpty.repeat(empty), color: colors.dim },
        { text: "]" },
    ];
}

/** What can be selected and acted on with Enter. */
export type FocusId = "failed" | "schedule" | "hostname" | "time";

/** One row of a column: content for a given width. */
export interface Cell {
    readonly key: string;
    readonly focus?: FocusId;
    /** Drawn without the two-column indent (section headings, the page header). */
    readonly flush?: boolean;
    /** A section heading: what its panel is titled when the section is drawn as one. */
    readonly heading?: { readonly title: string, readonly detail?: string };
    readonly content: (width: number) => Segs;
}

/** A full-width line of the page. */
export interface Line {
    readonly key: string;
    readonly focus?: FocusId;
    readonly segs: Segs;
}

const INDENT = 2;

/** A cell drawn into exactly `width` columns, with its selection marker. */
export function cellSegs(cell: Cell | undefined, width: number, focused: FocusId | null): Seg[] {
    if (!cell || width <= 0)
        return width > 0 ? [{ text: " ".repeat(width) }] : [];
    if (cell.flush)
        return fitSegs(cell.content(width), width);
    const selected = cell.focus !== undefined && cell.focus === focused;
    const marker: Seg = { text: selected ? `${glyphs.pointer} ` : "  ", bold: selected };
    const body = fitSegs(cell.content(Math.max(0, width - INDENT)), Math.max(0, width - INDENT));
    return [marker, ...body].map(seg => (selected ? { ...seg, inverse: true } : seg));
}

/** One column of cells as lines. */
export function singleColumn(cells: readonly Cell[], width: number, focused: FocusId | null): Line[] {
    return cells.map(cell => ({
        key: cell.key,
        ...(cell.focus ? { focus: cell.focus } : {}),
        segs: cellSegs(cell, width, focused),
    }));
}

/** Two columns side by side, as many lines as the taller one. */
export function twoColumns(left: readonly Cell[], right: readonly Cell[], leftWidth: number, gap: number,
                           rightWidth: number, focused: FocusId | null, key: string): Line[] {
    const lines: Line[] = [];
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const l = left[i];
        const r = right[i];
        const focus = l?.focus ?? r?.focus;
        lines.push({
            key: `${key}:${l?.key ?? "-"}:${r?.key ?? "-"}`,
            ...(focus ? { focus } : {}),
            segs: [...cellSegs(l, leftWidth, focused), { text: " ".repeat(gap) }, ...cellSegs(r, rightWidth, focused)],
        });
    }
    return lines;
}

/**
 * A section as a panel (see Panel.tsx), line by line: its heading cell
 * becomes the title in the top border and the other cells the rows inside,
 * padded with empty rows to `rows` of them. As there, the last column and the
 * last line are the panel's shadow.
 */
export function panelLines(cells: readonly Cell[], width: number, focused: FocusId | null, rows = 0): Line[] {
    const [head, ...body] = cells;
    const key = head?.key ?? "panel";
    const outer = width;
    width = Math.max(2, outer - 1);
    const inner = width - 2;
    const shade: Seg = { text: " ", shadow: true };
    const [left, name, middle, note, right] = panelTop(head?.heading?.title ?? "", width, head?.heading?.detail);
    const lines: Line[] = [{
        key: `${key}:top`,
        segs: [
            { text: left },
            { text: name, color: colors.accent, bold: true },
            { text: middle },
            { text: note, color: colors.dim },
            { text: `${right} ` },
        ].filter(seg => seg.text),
    }];
    for (let i = 0; i < Math.max(body.length, rows); i++) {
        const cell = body[i];
        lines.push({
            key: cell?.key ?? `${key}:pad${i}`,
            ...(cell?.focus ? { focus: cell.focus } : {}),
            segs: [{ text: frame.vertical }, ...cellSegs(cell, inner, focused), { text: frame.vertical }, shade],
        });
    }
    // Below, half a row (theme.ts): half blocks where they can be drawn.
    const half = styled ? shadowBelow : null;
    lines.push({ key: `${key}:bottom`, segs: [{ text: panelBottom(width) }, shade] });
    lines.push({
        key: `${key}:shadow`,
        segs: [{ text: " " }, half !== null ? { text: half.repeat(width), color: palette.shadow } : { text: " ".repeat(width), shadow: true }],
    });
    return lines;
}

/** Two panels side by side, the shorter one padded to the height of the taller. */
export function twoPanels(left: readonly Cell[], right: readonly Cell[], leftWidth: number, gap: number,
                          rightWidth: number, focused: FocusId | null): Line[] {
    const rows = Math.max(left.length, right.length) - 1;
    const l = panelLines(left, leftWidth, focused, rows);
    const r = panelLines(right, rightWidth, focused, rows);
    return l.map((line, i) => {
        const other = r[i]!;
        const focus = line.focus ?? other.focus;
        return {
            key: `${line.key}:${other.key}`,
            ...(focus ? { focus } : {}),
            segs: [...line.segs, { text: " ".repeat(gap) }, ...other.segs],
        };
    });
}

export function blankLine(key: string): Line {
    return { key, segs: [] };
}

/** Draw a line. Segments are already clean and fitted. */
export function renderLine(line: Line): ReactNode {
    return (
        <Text key={line.key} wrap="truncate">
            {line.segs.length === 0
                ? " "
                : line.segs.map((seg, i) => (
                    <Text key={i} color={seg.color} bold={seg.bold} inverse={seg.inverse}
                          {...(seg.shadow && styled ? { backgroundColor: palette.shadow } : {})}>{seg.text}</Text>
                ))}
        </Text>
    );
}
