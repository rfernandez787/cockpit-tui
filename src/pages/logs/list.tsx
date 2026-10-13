/*
 * The log list: one line per entry (or per run of identical entries), with
 * day headers, "Reboot" separators and a trailer row, newest at the top.
 *
 * Rows are assembled as fixed-width strings like the shared Table, so the
 * selected row is one inverse run with a marker glyph that still shows on a
 * terminal with no styling; separators span the full width, which a Table
 * cannot do. Only the rows in view are rendered.
 *
 *   TIME     PRIO   IDENTIFIER   MESSAGE                                 12/279
 *   ── Friday, October 2, 2026 ─────────────────────────────────────────────
 * › 18:13:44 ERR    sshd-session error: kex_exchange_identification     ×3
 *   ── Reboot ─────────────────────────────────────────────────────────────
 *   ── Before the last 24 hours ───────────────  (after "load earlier")
 */
import { Box, Text } from "../../tui/ink.js";
import { layoutColumns, type Column } from "../../tui/components/Table.js";
import { Spinner } from "../../tui/components/Spinner.js";
import { fit, width as textWidth } from "../../tui/text.js";
import { colors, glyphs } from "../../tui/theme.js";
import { entryText, moreText, priorityColor, repeatText, ruleText, type EntryRow, type Row } from "./model.js";
import type { Resolved } from "./nav.js";

const MARKER = 2;

/** The trailer under the last entry: how to get more, or why there is none. */
export interface Trailer {
    readonly text: string;
    readonly loading?: boolean;
}

/** Column widths for the list; identifiers get what they need, within reason. */
export function listColumns(identWidth: number): Column<EntryRow>[] {
    return [
        { id: "time", title: "TIME", width: 8, value: row => entryText(row.entry).time },
        { id: "prio", title: "PRIO", width: 6, dropPriority: 2, value: row => entryText(row.entry).badge },
        { id: "ident", title: "IDENTIFIER", width: identWidth, dropPriority: 1, value: row => entryText(row.entry).identifier },
        { id: "message", title: "MESSAGE", minWidth: 12, value: row => entryText(row.entry).message },
    ];
}

/** The identifier column: as wide as the widest identifier, up to a share of the width. */
export function identifierWidth(rows: readonly Row[], width: number): number {
    const cap = Math.max(6, Math.min(24, Math.floor(width * 0.22)));
    let widest = 6;
    for (const row of rows) {
        if (row.kind !== "entry")
            continue;
        widest = Math.max(widest, textWidth(entryText(row.entry).identifier));
        if (widest >= cap)
            return cap;
    }
    return widest;
}

/** Below this many columns the message cell marks further lines as "[+N]". */
const COMPACT_MESSAGE = 48;

/** The message cell: first line, then "[+N lines]" and "×N" kept visible at its end. */
function messageCell(row: EntryRow, columns: number): { text: string, more: string, repeat: string } {
    const text = entryText(row.entry);
    const more = moreText(text.more, columns < COMPACT_MESSAGE);
    const repeat = repeatText(row.count);
    const suffix = [more, repeat].filter(Boolean).join(" ");
    if (!suffix || columns <= textWidth(suffix) + 4)
        return { text: fit(text.message, columns), more: "", repeat: "" };
    const room = columns - textWidth(suffix) - 1;
    return { text: fit(text.message, room) + " ", more: more ? more + (repeat ? " " : "") : "", repeat };
}

export function LogList({ rows, nav, width, height, trailer, identWidth, focused = true, position }: {
    rows: readonly Row[],
    nav: Resolved,
    width: number,
    /** Including the header line. */
    height: number,
    trailer: Trailer | null,
    identWidth: number,
    focused?: boolean,
    /** "12/279": the selected entry row among all entry rows. */
    position: string | null,
}) {
    const body = Math.max(0, height - 1);
    const columns = listColumns(identWidth);
    const widths = layoutColumns(columns, Math.max(0, width - MARKER));
    const shown = columns.map((column, i) => ({ column, width: widths[i]! })).filter(c => c.width > 0);
    const inner = Math.max(0, width - MARKER);

    let header = " ".repeat(MARKER) + shown.map(c => fit(c.column.title, c.width)).join(" ");
    if (position && textWidth(header.trimEnd()) + textWidth(position) + 1 <= width)
        header = fit(header.trimEnd(), width - textWidth(position)) + position;

    const lines = [];
    for (let i = nav.offset; i < nav.offset + body; i++) {
        if (i < rows.length) {
            const row = rows[i]!;
            if (row.kind === "day") {
                lines.push(
                    <Text key={row.key} color={colors.dim} bold wrap="truncate">
                        {" ".repeat(MARKER) + fit(ruleText(row.text, inner), inner)}
                    </Text>);
            } else if (row.kind === "reboot") {
                lines.push(
                    <Text key={row.key} color={colors.warning} wrap="truncate">
                        {" ".repeat(MARKER) + fit(ruleText("Reboot", inner), inner)}
                    </Text>);
            } else if (row.kind === "range") {
                lines.push(
                    <Text key={row.key} color={colors.accent} wrap="truncate">
                        {" ".repeat(MARKER) + fit(ruleText(row.text, inner), inner)}
                    </Text>);
            } else {
                lines.push(<EntryLine key={row.key} row={row} shown={shown} width={width}
                                      selected={i === nav.index} focused={focused} />);
            }
        } else if (i === rows.length && trailer) {
            lines.push(
                <Box key="trailer" width={width}>
                    <Text wrap="truncate">{" ".repeat(MARKER)}</Text>
                    {trailer.loading
                        ? <Spinner label={trailer.text} color={colors.dim} />
                        : <Text color={colors.dim} wrap="truncate">{fit(ruleText(trailer.text, inner), inner)}</Text>}
                </Box>);
        }
    }

    return (
        <Box flexDirection="column" width={width} height={height}>
            <Text bold wrap="truncate">{fit(header, width)}</Text>
            {lines}
        </Box>
    );
}

function EntryLine({ row, shown, width, selected, focused }: {
    row: EntryRow,
    shown: { column: Column<EntryRow>, width: number }[],
    width: number,
    selected: boolean,
    focused: boolean,
}) {
    const marker = selected ? `${glyphs.pointer} ` : "  ";
    const used = MARKER + shown.reduce((sum, c) => sum + c.width, 0) + Math.max(0, shown.length - 1);
    return (
        <Text inverse={selected && focused} bold={selected && !focused} wrap="truncate">
            {fit(marker, MARKER)}
            {shown.map((c, j) => {
                const gap = j > 0 ? " " : "";
                if (c.column.id === "message") {
                    const cell = messageCell(row, c.width);
                    return (
                        <Text key="message">
                            {gap + cell.text}
                            {cell.more ? <Text color={colors.dim}>{cell.more}</Text> : null}
                            {cell.repeat ? <Text color={colors.accent} bold>{cell.repeat}</Text> : null}
                        </Text>
                    );
                }
                const color = c.column.id === "time" ? colors.dim
                    : c.column.id === "prio" ? priorityColor(row.entry.priority) : undefined;
                return <Text key={c.column.id} color={color}>{gap + fit(c.column.value(row), c.width)}</Text>;
            })}
            {used < width ? " ".repeat(width - used) : ""}
        </Text>
    );
}
