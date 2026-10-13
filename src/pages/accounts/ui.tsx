/*
 * View pieces shared by the Accounts list and details: how login facts are
 * worded, and a scrollable list of label/value rows.
 *
 * Words carry every state (colour only reinforces them), so the page reads
 * correctly on a terminal without colour.
 */
import { Box, Text } from "../../tui/ink.js";
import { useKeys, Layer } from "../../tui/keyboard.js";
import { useScroll } from "../../tui/components/ScrollView.js";
import { fit, formatTimestamp, truncate, width as textWidth, wrap } from "../../tui/text.js";
import { colors, glyphs } from "../../tui/theme.js";
import { isLoggedInState, lockState, type LockState } from "./model.js";
import type { LoginDetails } from "./data.js";

export interface Cell {
    readonly text: string;
    readonly color?: string;
}



/** "logged in", a date, "never", "…" while loading, "?" when unknown. */
export function lastActiveCell(details: LoginDetails, name: string): Cell {
    if (isLoggedInState(details.states?.get(name)))
        return { text: "logged in", color: colors.ok };
    if (details.lastLogin === null)
        return { text: glyphs.ellipsis, color: colors.dim };
    const time = details.lastLogin.get(name);
    if (time !== undefined)
        return { text: formatTimestamp(time, false) };
    if (details.lastLoginFailed)
        return { text: "?", color: colors.dim };
    return { text: "never", color: colors.dim };
}

export function lockOf(details: LoginDetails, name: string): LockState {
    return details.locksStatus === "ready" ? lockState(details.locks, name) : "unknown";
}

/** The list's lock column: only meaningful once the lock state could be read. */
export function lockCell(details: LoginDetails, name: string): Cell {
    if (details.locksStatus === "loading")
        return { text: glyphs.ellipsis, color: colors.dim };
    const lock = lockOf(details, name);
    if (lock === "locked")
        return { text: "locked", color: colors.warning };
    if (lock === "unknown")
        return { text: "?", color: colors.dim };
    return { text: "" };
}

/*
 * A session's length, compact but exact enough to compare: "35s", "16m",
 * "1h 52m", "1d 17h". (text.ts formatDuration() rounds down to one unit,
 * which turns 1h 52m into "1 hour".)
 */
export function formatSpan(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0)
        return "";
    const s = Math.floor(seconds);
    if (s < 60)
        return `${s}s`;
    if (s < 3600)
        return `${Math.floor(s / 60)}m`;
    if (s < 86400)
        return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/*
 * A table's empty state that may need more than one line. Table renders a
 * string `empty` as one Text that Ink wraps under the indent; this wraps it
 * itself, indented like the rows and cut to the lines there are.
 */
export function EmptyNote({ text, width, height, color = colors.dim }: {
    text: string, width: number, height: number, color?: string,
}) {
    const lines = wrap(text, Math.max(1, width - 2)).slice(0, Math.max(1, height));
    return (
        <Box flexDirection="column" width={width} height={Math.max(1, height)}>
            {lines.map((line, i) => <Text key={i} color={color} wrap="truncate">{"  " + line}</Text>)}
        </Box>
    );
}

/*
 * The first line of the two list views, which ← → switch between:
 *
 *   [Accounts]  Groups   4 accounts · by name · 2 system hidden
 *
 * The current view is bracketed as well as highlighted (no colour needed);
 * the view's facts follow, dim, cut to what is left of the line.
 */
export const LIST_TABS = ["Accounts", "Groups"] as const;

export function TabLine({ current, detail, width }: { current: number, detail: string, width: number }) {
    const head = LIST_TABS.map((tab, i) => (i === current ? `[${tab}]` : ` ${tab} `)).join(" ");
    const room = Math.max(0, width - textWidth(head) - 2);
    return (
        <Text wrap="truncate">
            {LIST_TABS.map((tab, i) => (
                <Text key={tab}>
                    {i > 0 ? " " : ""}
                    {i === current
                        ? <Text bold color={colors.accent}>{`[${tab}]`}</Text>
                        : <Text color={colors.dim}>{` ${tab} `}</Text>}
                </Text>
            ))}
            {detail && room > 0 ? <Text color={colors.dim}>{"  " + truncate(detail, room)}</Text> : null}
        </Text>
    );
}

/** The local time zone, for labelling times when the host may be elsewhere. */
export function localZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
    } catch {
        return "local time";
    }
}

export interface Row {
    readonly label: string;
    readonly value: string;
    readonly color?: string;
    /** A section title spanning both columns. */
    readonly heading?: boolean;
    /** A legend row: the label is a key, in a narrow column of its own. */
    readonly isKey?: boolean;
}

/** The key column of legend rows ("  p  set password"). */
const KEY_WIDTH = 5;

/*
 * Label/value rows that scroll with the arrow keys when they do not fit.
 * Values must already be clean. A dim arrow in the last column says there is
 * more above or below.
 */
export function RowList({ rows, width, height, labelWidth, active }: {
    rows: readonly Row[], width: number, height: number, labelWidth: number, active: boolean,
}) {
    const scroll = useScroll(rows.length, height);
    useKeys(scroll.handleKey, { layer: Layer.page, active: active && scroll.max > 0, hints: [[glyphs.updown, "scroll"]] });
    const more = scroll.max > 0;
    const inner = more ? Math.max(0, width - 2) : width;
    const valueWidth = Math.max(0, inner - labelWidth);
    const shown = rows.slice(scroll.top, scroll.top + height);
    return (
        <Box flexDirection="row" width={width} height={height}>
            <Box flexDirection="column" width={inner} height={height}>
                {shown.map((row, i) => (
                    <Text key={scroll.top + i} wrap="truncate">
                        {row.heading
                            ? <Text bold={!row.color} color={row.color ?? colors.accent}>{fit(row.label, inner)}</Text>
                            : row.isKey
                                ? <>
                                    <Text color={row.color ?? colors.accent} bold>{fit(row.label, KEY_WIDTH)}</Text>
                                    <Text color={row.color}>{fit(row.value, Math.max(0, inner - KEY_WIDTH))}</Text>
                                </>
                                : <>
                                    <Text color={colors.dim}>{fit(row.label, labelWidth)}</Text>
                                    <Text color={row.color}>{fit(row.value, valueWidth)}</Text>
                                </>}
                    </Text>
                ))}
            </Box>
            {more && (
                <Box flexDirection="column" width={2} height={height} alignItems="flex-end">
                    <Text color={colors.dim}>{scroll.top > 0 ? glyphs.up : " "}</Text>
                    <Box flexGrow={1} />
                    <Text color={colors.dim}>{scroll.top < scroll.max ? glyphs.down : " "}</Text>
                </Box>
            )}
        </Box>
    );
}

/** Width for a label column: the longest label plus a gap, within limits. */
export function labelColumn(rows: readonly Row[], width: number): number {
    const longest = Math.max(0, ...rows.filter(row => !row.heading && !row.isKey).map(row => textWidth(row.label)));
    return Math.max(4, Math.min(longest + 2, Math.floor(width / 2)));
}
