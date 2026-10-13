/*
 * The Logs page's pure model: what the filters mean in journalctl terms, how
 * journal entries become list rows, and how journal values are made fit for
 * a terminal.
 *
 * Nothing here touches the bridge or React, so all of it is tested directly
 * (test/pages/logs-model.test.ts). The page (index.tsx) and the stream hook
 * (journal-view.ts) build on it.
 *
 * Text safety: a journal value is whatever a process logged. journalctl sends
 * values that are not printable UTF-8 as byte arrays, which lib/journal.ts
 * decodes -- so decoded text may hold ESC sequences, CR and other controls
 * (302 such messages on the development host, mostly coloured container
 * output). displayText() removes whole escape sequences first, so coloured
 * output reads as its text rather than as "^[[37m" noise, removes bidi
 * controls, and then runs text.ts clean() over the rest, so anything left
 * that could drive the terminal is shown in caret notation instead.
 */
import {
    PRIORITIES, PRIORITY_BADGES, PRIORITY_LABELS, fieldText, isByteArray, journalArgs,
    type JournalEntry, type JournalFilter, type Priority, type UnitMatch,
} from "../../lib/journal.js";
import type { Hint } from "../../tui/keyboard.js";
import { clean, formatTimestamp, wrap, width as textWidth } from "../../tui/text.js";
import { colors, glyphs, unicode } from "../../tui/theme.js";

/**
 * How many entries one page query asks for, and the most the view keeps in
 * memory. Mutable only so tests can work with pages of a handful of entries:
 * a real page would not fit in the mock bridge's scenario.
 */
export const limits = { page: 1000, max: 20000 };

// ---- filters -------------------------------------------------------------------

/** The time range: a relative window, a boot, or a custom since/until. */
export type TimeChoice =
    | { readonly kind: "recent", readonly since: string }
    /** id "0" is the current boot (an offset); older boots use their boot id. */
    | { readonly kind: "boot", readonly id: string, readonly index: number, readonly first?: number, readonly last?: number }
    | { readonly kind: "custom", readonly since?: string, readonly until?: string };

export interface LogsFilter {
    readonly priority: Priority;
    readonly time: TimeChoice;
    readonly identifier?: string;
    readonly unit?: UnitMatch;
    readonly grep?: string;
    /** Extra FIELD=VALUE matches, all of which must hold. */
    readonly matches: readonly string[];
}

/** The relative windows on offer, upstream's "Last 24 hours" and "Last 7 days". */
export const RECENT = [
    { since: "-24hours", label: "Last 24 hours", name: "the last 24 hours" },
    { since: "-7days", label: "Last 7 days", name: "the last 7 days" },
] as const;

/** Upstream's defaults: errors and worse, from the last 24 hours. */
export const DEFAULT_FILTER: LogsFilter = {
    priority: "err",
    time: { kind: "recent", since: "-24hours" },
    matches: [],
};

export const CURRENT_BOOT: TimeChoice = { kind: "boot", id: "0", index: 0 };

/** The filter as journal.ts understands it. */
export function journalFilter(filter: LogsFilter): JournalFilter {
    const time = filter.time;
    return {
        priority: filter.priority,
        ...(time.kind === "recent" ? { since: time.since } : {}),
        ...(time.kind === "boot" ? { boot: time.id } : {}),
        ...(time.kind === "custom" && time.since ? { since: time.since } : {}),
        ...(time.kind === "custom" && time.until ? { until: time.until } : {}),
        ...(filter.identifier ? { identifier: filter.identifier } : {}),
        ...(filter.unit ? { unit: filter.unit } : {}),
        ...(filter.grep ? { grep: filter.grep } : {}),
        ...(filter.matches.length ? { matches: filter.matches } : {}),
    };
}

/**
 * The filter for entries older than the time range, for "load earlier".
 * Like upstream, loading earlier deliberately continues past the time
 * filter; every other filter still applies.
 *
 * `anchored`: the query starts strictly before the oldest entry shown
 * (--after-cursor with --reverse), so the cursor alone is the bound. With
 * nothing shown there is no cursor: a since-based range is then bounded by
 * --until=<its since>, everything before the window. A boot or an until-only
 * range has nothing to anchor on, so there is nothing earlier to offer (null).
 */
export function earlierFilter(filter: JournalFilter, anchored: boolean): JournalFilter | null {
    const { boot, since, until: _until, ...rest } = filter;
    if (anchored)
        return rest;
    if (since && boot === undefined)
        return { ...rest, until: since };
    return null;
}

/** "@<seconds>.<microseconds>": an entry's exact time, as journalctl's --until reads it. */
export function exactTime(entry: JournalEntry): string | null {
    const raw = entry.fields.__REALTIME_TIMESTAMP;
    if (typeof raw !== "string" || !/^\d{7,}$/.test(raw))
        return null;
    return `@${raw.slice(0, -6)}.${raw.slice(-6)}`;
}

export interface EarlierQuery {
    readonly argv: string[];
    /** Still within the time range (rather than past it). */
    readonly within: boolean;
}

/**
 * The query for "load earlier": entries older than the oldest one shown.
 *
 * While the time range may hold more (the last query came back full) the
 * range still applies. journalctl refuses --since together with a cursor
 * ("Please specify only one of --since=, --cursor=, and --after-cursor="),
 * so a since-based range continues with --until=@<the oldest entry's time>
 * instead: exact to the microsecond and inclusive, so the oldest entry comes
 * back once and is dropped as a duplicate. A boot or an until-only range
 * combines with --after-cursor directly.
 *
 * Once the range is exhausted, the query continues past it from the oldest
 * cursor (earlierFilter()), like upstream. Null: nothing earlier to ask for.
 */
export function earlierQuery(filter: JournalFilter, oldest: JournalEntry | undefined, windowDone: boolean, lines: number): EarlierQuery | null {
    if (!windowDone && oldest) {
        if (!filter.since)
            return { argv: journalArgs(filter, { kind: "page", lines, before: oldest.cursor }), within: true };
        const until = exactTime(oldest);
        if (until)
            return { argv: journalArgs({ ...filter, until }, { kind: "page", lines }), within: true };
        // An entry without a usable time: continue past the range instead.
    }
    const base = earlierFilter(filter, oldest !== undefined);
    if (!base)
        return null;
    return {
        argv: journalArgs(base, oldest ? { kind: "page", lines, before: oldest.cursor } : { kind: "page", lines }),
        within: false,
    };
}

/** Why following is impossible with this filter, or null when it is possible. */
export function followBlocked(filter: LogsFilter): string | null {
    if (filter.time.kind === "boot" && filter.time.id !== "0")
        return "a past boot is shown";
    if (filter.time.kind === "custom" && filter.time.until)
        return "the time range has an end";
    return null;
}

/** The params other pages may pass (navigation.go("logs", params)). */
export interface LogsParams {
    readonly unit?: { readonly name: string, readonly user?: boolean };
    readonly priority?: string;
    readonly identifier?: string;
}

/**
 * The filter for params handed over by another page ("view all logs" on
 * Services), or null when they hold nothing usable. Params come from other
 * code, so every field is checked. They start with no search, and over the
 * whole journal when a unit is given (upstream's 24 hours would hide a unit
 * that has been quiet for a day).
 */
export function filterFromParams(params: unknown): LogsFilter | null {
    if (!params || typeof params !== "object")
        return null;
    const p = params as Record<string, unknown>;
    let unit: UnitMatch | undefined;
    if (p.unit && typeof p.unit === "object") {
        const u = p.unit as Record<string, unknown>;
        if (typeof u.name === "string" && u.name.trim())
            unit = u.user === true ? { name: u.name.trim(), user: true } : { name: u.name.trim() };
    } else if (typeof p.unit === "string" && p.unit.trim()) {
        unit = { name: p.unit.trim() };
    }
    const priority = typeof p.priority === "string" && (PRIORITIES as readonly string[]).includes(p.priority)
        ? p.priority as Priority
        : undefined;
    const identifier = typeof p.identifier === "string" && p.identifier.trim() ? p.identifier.trim() : undefined;
    if (!unit && !priority && !identifier)
        return null;
    return {
        ...DEFAULT_FILTER,
        // A unit's log is asked for from its own recent lines, which may be
        // days old (a service that failed last week): the whole journal, not
        // the last 24 hours, or the view would open empty.
        ...(unit ? { time: { kind: "custom" } as const } : {}),
        priority: priority ?? DEFAULT_FILTER.priority,
        ...(unit ? { unit } : {}),
        ...(identifier ? { identifier } : {}),
    };
}

/** A stable identity for a filter, to key queries on. */
export function filterKey(filter: LogsFilter): string {
    return JSON.stringify(journalFilter(filter));
}

// ---- labels ----------------------------------------------------------------------

export function timeLabel(time: TimeChoice): string {
    switch (time.kind) {
    case "recent":
        return RECENT.find(r => r.since === time.since)?.label ?? `Since ${time.since}`;
    case "boot":
        if (time.id === "0")
            return "Current boot";
        return `Boot ${time.index}` + (time.first ? ` (${formatTimestamp(time.first, false)})` : "");
    case "custom":
        if (time.since && time.until)
            return `${time.since} to ${time.until}`;
        if (time.since)
            return `Since ${time.since}`;
        if (time.until)
            return `Until ${time.until}`;
        return "Entire journal";
    }
}

/** The time range as the object of a sentence: "Start of the last 24 hours". */
export function timeName(time: TimeChoice): string {
    switch (time.kind) {
    case "recent":
        return RECENT.find(r => r.since === time.since)?.name ?? "the time range";
    case "boot":
        return time.id === "0" ? "the current boot" : `boot ${time.index}`;
    case "custom":
        return "the time range";
    }
}

/** The filter summary, one segment per active filter. Raw text: clean() before display. */
export function filterSummary(filter: LogsFilter): string[] {
    const parts: string[] = [PRIORITY_LABELS[filter.priority], timeLabel(filter.time)];
    if (filter.unit)
        parts.push(`${filter.unit.user ? "user unit" : "unit"} ${filter.unit.name}`);
    if (filter.identifier)
        parts.push(`identifier ${filter.identifier}`);
    if (filter.grep)
        parts.push(`matching "${filter.grep}"`);
    if (filter.matches.length)
        parts.push(formatMatches(filter.matches));
    return parts;
}

/** "ERR", "WARN", ...; "-" for the rare entry without PRIORITY. */
export function priorityBadge(priority: number | null): string {
    return priority === null ? "-" : PRIORITY_BADGES[priority] ?? "-";
}

/** Upstream marks emerg..err (its warning icon); the TUI adds yellow for warnings. */
export function priorityColor(priority: number | null): string | undefined {
    if (priority === null)
        return colors.dim;
    if (priority <= 3)
        return colors.error;
    if (priority === 4)
        return colors.warning;
    return colors.dim;
}

// ---- text ------------------------------------------------------------------------

/*
 * Terminal escape sequences, removed whole: CSI (ESC [ or C1 0x9B) with its
 * parameters, OSC (ESC ] or 0x9D) up to BEL or ST, DCS/SOS/PM/APC up to ST,
 * and the short two- and three-byte escapes (ESC ( B, ESC 7, ESC c ...). An
 * unterminated string sequence runs to the end of the text, which is also
 * what a terminal would swallow.
 */
// eslint-disable-next-line no-control-regex
const ESCAPES = /(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]|(?:\x1b\]|\u009d)[^\x07\x1b\u009c]*(?:\x07|\x1b\\|\u009c)?|(?:\x1b[PX^_]|[\u0090\u0098\u009e\u009f])[^\x1b\u009c]*(?:\x1b\\|\u009c)?|\x1b[ -/]*[0-~]/g;

/*
 * Bidirectional controls can make text read differently from what it is:
 * Unicode's whole Bidi_Control set, the Arabic letter mark included.
 */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** One line of host text, safe and readable. */
export function displayText(raw: string): string {
    return clean(raw.replace(ESCAPES, "").replace(BIDI, ""));
}

/** The lines of a value, without the trailing line break most messages carry. */
export function splitLines(raw: string): string[] {
    return raw.replace(/[\r\n]+$/, "").split(/\r?\n/);
}

/** Multi-line host text as safe display lines. */
export function displayLines(raw: string): string[] {
    return splitLines(raw).map(displayText);
}

const TAB_STOP = 8;

/**
 * One line of host text for the entry detail, where layout matters: like
 * displayText(), but a tab advances to the next 8-column stop, the way the
 * terminal would show it, instead of becoming one space. Java and Go stack
 * traces indent with tabs.
 */
export function displayLine(raw: string): string {
    const parts = raw.replace(ESCAPES, "").replace(BIDI, "").split("\t").map(part => clean(part));
    let out = parts[0]!;
    let column = textWidth(out);
    for (const part of parts.slice(1)) {
        const pad = TAB_STOP - (column % TAB_STOP);
        out += " ".repeat(pad) + part;
        column += pad + textWidth(part);
    }
    return out;
}

/**
 * Wrap one display line, keeping its indentation: the continuation of a
 * wrapped traceback line stays under its own text instead of starting at the
 * left edge. (text.ts wrap() drops leading whitespace, which flattens
 * tracebacks.) Indentation deeper than half the width is cut to half, so a
 * deeply nested line still has room.
 */
export function wrapIndented(line: string, columns: number): string[] {
    const cols = Math.max(1, columns);
    const indent = /^ */.exec(line)![0];
    if (!indent)
        return wrap(line, cols);
    if (indent.length === line.length)
        return [""]; // only blanks: an empty line
    const keep = indent.slice(0, Math.floor(cols / 2));
    return wrap(line.slice(indent.length), cols - keep.length).map(piece => keep + piece);
}

// ---- rows ------------------------------------------------------------------------

/** What a list row shows for an entry, computed once per entry. */
export interface EntryText {
    /** Local "YYYY-MM-DD", for day boundaries. */
    readonly day: string;
    /** Local "HH:MM:SS". */
    readonly time: string;
    readonly badge: string;
    readonly identifier: string;
    /** The first line of MESSAGE, safe for display. */
    readonly message: string;
    /** Further lines of MESSAGE. */
    readonly more: number;
}

const textCache = new WeakMap<JournalEntry, EntryText>();

export function entryText(entry: JournalEntry): EntryText {
    let text = textCache.get(entry);
    if (!text) {
        const stamp = formatTimestamp(entry.time);
        const lines = splitLines(entry.message);
        text = {
            day: stamp.slice(0, 10),
            time: stamp.slice(11),
            badge: priorityBadge(entry.priority),
            identifier: displayText(entry.identifier),
            message: displayText(lines[0] ?? ""),
            more: lines.length - 1,
        };
        textCache.set(entry, text);
    }
    return text;
}

let dayFormat: Intl.DateTimeFormat | null = null;

/** "Friday, October 2, 2026" in the terminal's locale, like upstream's day headers. */
export function dayLabel(ms: number): string {
    dayFormat ??= new Intl.DateTimeFormat(undefined, { dateStyle: "full" });
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? "Unknown date" : dayFormat.format(date);
}

export type Row =
    | { readonly kind: "day", readonly key: string, readonly text: string }
    | { readonly kind: "reboot", readonly key: string }
    /** Where entries from before the time range begin ("load earlier" went past it). */
    | { readonly kind: "range", readonly key: string, readonly text: string }
    /**
     * `entry` is the newest of `count` identical consecutive entries, `oldest`
     * the last; `cursors` are all of theirs, newest first.
     */
    | {
        readonly kind: "entry", readonly key: string, readonly entry: JournalEntry, readonly count: number,
        readonly oldest: JournalEntry, readonly cursors: readonly string[],
    };

export type EntryRow = Extract<Row, { kind: "entry" }>;

/** Upstream's entry_is_equal(): same day, boot, identifier, priority and message. */
function sameLine(a: JournalEntry, b: JournalEntry): boolean {
    return a.message === b.message && a.identifier === b.identifier && a.priority === b.priority &&
        a.bootId === b.bootId && entryText(a).day === entryText(b).day;
}

/**
 * List rows for entries in newest-first order, the way upstream's journal
 * renderer lays them out: a day header above each day's entries, a "Reboot"
 * separator where the boot id changes, and consecutive identical entries
 * collapsed into one row with a count.
 *
 * Keys are cursors, so a row keeps its key when entries arrive above or below
 * it: an entry row is keyed by its newest entry, a separator by the entry
 * just below it. The one exception is a run of repeats that grows at the top
 * (following): its newest entry, and so its key, changes. Navigation finds
 * such a row through `cursors` (nav.ts).
 *
 * `range`: the first entry from before the time range, if "load earlier"
 * went past it, and the separator's text. Repeats never run across it.
 */
export function buildRows(entries: readonly JournalEntry[], range?: { readonly cursor: string, readonly text: string }): Row[] {
    const rows: Row[] = [];
    let group: { entry: JournalEntry, count: number, oldest: JournalEntry, cursors: string[] } | null = null;
    const flush = () => {
        if (group)
            rows.push({ kind: "entry", key: group.entry.cursor, ...group });
    };
    for (const entry of entries) {
        const crossing = entry.cursor === range?.cursor;
        if (group && !crossing && sameLine(group.entry, entry)) {
            group.count += 1;
            group.oldest = entry;
            group.cursors.push(entry.cursor);
            continue;
        }
        flush();
        const previous = group?.oldest;
        if (crossing)
            rows.push({ kind: "range", key: `range:${entry.cursor}`, text: range!.text });
        if (!previous || crossing || entryText(previous).day !== entryText(entry).day)
            rows.push({ kind: "day", key: `day:${entry.cursor}`, text: dayLabel(entry.time) });
        if (previous && previous.bootId && entry.bootId && previous.bootId !== entry.bootId)
            rows.push({ kind: "reboot", key: `boot:${entry.cursor}` });
        group = { entry, count: 1, oldest: entry, cursors: [entry.cursor] };
    }
    flush();
    return rows;
}

/**
 * Text the page writes itself, ASCII where the locale is not UTF-8 (theme.ts
 * `unicode`): a serial console or a bare VT would show the bytes of "·" or
 * "←" as garbage.
 */
export const sym = unicode
    ? { dot: "·", range: "–", upDown: "↑↓", leftRight: "←→" }
    : { dot: "|", range: "-", upDown: "up/dn", leftRight: "<-/->" };

/** The ×N suffix of a collapsed row. */
export function repeatText(count: number): string {
    return count > 1 ? `${unicode ? "×" : "x"}${count}` : "";
}

/**
 * The marker for further message lines: "[+3 lines]", or "[+3]" where the
 * message column is too narrow to spend eleven columns on it.
 */
export function moreText(more: number, compact = false): string {
    if (more <= 0)
        return "";
    return compact ? `[+${more}]` : `[+${more} line${more === 1 ? "" : "s"}]`;
}

/** A separator line: "── Reboot ─────". */
export function ruleText(label: string, columns: number): string {
    const dash = unicode ? "─" : "-";
    const head = `${dash}${dash} ${label} `;
    const room = columns - textWidth(head);
    return room > 0 ? head + dash.repeat(room) : head;
}

// ---- entry details -------------------------------------------------------------

const FACILITIES = [
    "kern", "user", "mail", "daemon", "auth", "syslog", "lpr", "news", "uucp", "cron", "authpriv", "ftp",
    "ntp", "security", "console", "solaris-cron", "local0", "local1", "local2", "local3", "local4", "local5",
    "local6", "local7",
];

/** "2026-10-02 17:29:55.733197" from journal microseconds. */
export function preciseTime(micros: number): string {
    const stamp = formatTimestamp(micros / 1000);
    if (!stamp)
        return "";
    return `${stamp}.${String(Math.floor(micros % 1_000_000)).padStart(6, "0")}`;
}

/** A readable gloss for fields whose raw value is a number: times, priority, facility. */
export function fieldNote(key: string, value: string): string | null {
    if (!/^\d+$/.test(value))
        return null;
    const n = Number(value);
    switch (key) {
    case "__REALTIME_TIMESTAMP":
    case "_SOURCE_REALTIME_TIMESTAMP":
        return preciseTime(n) || null;
    case "__MONOTONIC_TIMESTAMP":
    case "_SOURCE_MONOTONIC_TIMESTAMP":
        return `${(n / 1e6).toFixed(6)} s after boot`;
    case "PRIORITY":
        return PRIORITIES[n] ?? null;
    case "SYSLOG_FACILITY":
        return FACILITIES[n] ?? null;
    default:
        return null;
    }
}

export interface FieldValue {
    /** Display lines (safe). */
    readonly lines: readonly string[];
    /** A dim remark: "binary, 67 bytes", "3 values", "02:15:00 ...". */
    readonly note: string | null;
    /** journalctl left the value out (too long); --all would include it. */
    readonly missing: boolean;
}

/**
 * How one field value displays. journalctl sends a string; a byte array when
 * the value is not printable UTF-8; an array of those when the field occurs
 * more than once; null when the value is too long to print without --all.
 */
export function fieldValue(key: string, value: unknown): FieldValue {
    if (value === null)
        return { lines: ["[no data]"], note: "too long to print by default", missing: true };
    if (typeof value === "string")
        return { lines: splitLines(value).map(displayLine), note: fieldNote(key, value), missing: false };
    if (isByteArray(value))
        return { lines: splitLines(fieldText(value)).map(displayLine), note: `binary, ${value.length} bytes`, missing: false };
    if (Array.isArray(value)) {
        const parts = value.map(item => fieldValue(key, item));
        return {
            lines: parts.flatMap(part => part.lines),
            note: `${value.length} values`,
            missing: parts.some(part => part.missing),
        };
    }
    if (value === undefined)
        return { lines: [""], note: null, missing: false };
    return { lines: [displayText(typeof value === "object" ? JSON.stringify(value) : String(value))], note: null, missing: false };
}

/** Whether any field was left out for length, so fetching with --all helps. */
export function hasMissing(fields: Readonly<Record<string, unknown>>): boolean {
    return Object.entries(fields).some(([key, value]) => fieldValue(key, value).missing);
}

export interface DetailLine {
    readonly text: string;
    readonly color?: string;
    readonly bold?: boolean;
    readonly dim?: boolean;
}

/**
 * The scrollable body of the entry detail: the full message, a summary, then
 * every other field sorted by name, with long values wrapped and multi-line
 * values continued under their first line. Wrapping keeps each line's
 * indentation, so tracebacks read as tracebacks.
 */
export function detailLines(row: EntryRow, columns: number, extra: { unit: UnitMatch | null }): DetailLine[] {
    const entry = row.entry;
    const out: DetailLine[] = [];
    const cols = Math.max(10, columns);

    for (const line of splitLines(entry.message).map(displayLine))
        for (const piece of wrapIndented(line, cols))
            out.push({ text: piece, bold: true });
    out.push({ text: "" });

    const summary: [string, string][] = [];
    if (row.count > 1)
        summary.push(["Repeated", `${row.count} times, first at ${formatTimestamp(row.oldest.time)}`]);
    // The unit name is host text too: UNIT=, USER_UNIT= and COREDUMP_UNIT=
    // are ordinary fields that any process may log, with any bytes in them.
    if (extra.unit)
        summary.push([extra.unit.user ? "User unit" : "Unit", `${displayText(extra.unit.name)}  (o opens it in Services)`]);
    if (summary.length) {
        for (const [label, value] of summary)
            out.push({ text: `${label.padEnd(10)} ${value}`, color: colors.accent });
        out.push({ text: "" });
    }

    const keys = Object.keys(entry.fields).filter(key => key !== "MESSAGE").sort();
    out.push({ text: `Fields (${keys.length})`, dim: true });
    const labelWidth = Math.min(Math.max(10, Math.floor(cols / 3)), Math.max(0, ...keys.map(k => textWidth(k))) + 2);
    const valueWidth = Math.max(8, cols - labelWidth);
    const pad = " ".repeat(labelWidth);
    for (const key of keys) {
        const value = fieldValue(key, entry.fields[key]);
        const lines: string[] = [];
        for (const line of value.lines)
            lines.push(...wrapIndented(line, valueWidth));
        if (value.note)
            lines.push(`(${value.note})`);
        const label = displayText(key);
        if (textWidth(label) + 1 > labelWidth) {
            // A field name longer than the label column gets a line of its own.
            out.push({ text: label, dim: true });
            lines.forEach(line => out.push({ text: pad + line }));
            continue;
        }
        lines.forEach((line, i) => out.push({
            text: (i === 0 ? label.padEnd(labelWidth) : pad) + line,
            ...(value.missing ? { color: colors.warning } : {}),
        }));
    }
    return out;
}

let zone: string | null = null;

/** The terminal's time zone, e.g. "MDT": what the times shown are in. */
export function zoneName(): string {
    if (zone === null) {
        try {
            zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
                .formatToParts(new Date()).find(part => part.type === "timeZoneName")?.value ?? "local time";
        } catch {
            zone = "local time";
        }
    }
    return zone;
}

// ---- footer ----------------------------------------------------------------------

/**
 * Columns taken by the shell's own hints ("1-9 pages  A admin  ? help  q quit")
 * and the gap the footer keeps before them. The footer (app.tsx) lays those
 * out first and gives the page's hints what is left after its leading space
 * and last column, dropping whole hints from the end of a set that does not
 * fit -- so a set must fit that room exactly, or its last hint goes missing.
 */
const SHELL_HINTS = 34 + 3;

/** The first of `sets` (most detailed first) that fits beside the shell's hints. */
export function fitHints(columns: number, sets: readonly (readonly Hint[])[]): Hint[] {
    const budget = columns - 2 - SHELL_HINTS;
    const cost = (hints: readonly Hint[]) =>
        hints.reduce((sum, [key, label], i) => sum + textWidth(key) + 1 + textWidth(label) + (i ? 2 : 0), 0);
    return [...(sets.find(hints => cost(hints) <= budget) ?? sets.at(-1) ?? [])];
}

// ---- commands --------------------------------------------------------------------

/** Quote one argument for a POSIX shell, only when it needs it. */
export function shellQuote(arg: string): string {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell command equivalent to a journalctl argv the page runs, the way
 * upstream's "copy command" shows it: without the plumbing (-q, JSON output,
 * the page size) and without a "--" that ends nothing.
 */
export function displayCommand(argv: readonly string[]): string {
    const shown = argv.filter(arg => arg !== "-q" && arg !== "--output=json" && !/^--lines=\d+$/.test(arg));
    if (shown.at(-1) === "--")
        shown.pop();
    return shown.map(shellQuote).join(" ");
}

// ---- user input ------------------------------------------------------------------

const UNIT_SUFFIX = /\.(service|socket|device|mount|automount|swap|target|path|timer|slice|scope)$/;

/**
 * A unit name typed by the user, completed the way `journalctl -u` and
 * `systemctl` complete it: a name without a unit type gets ".service".
 * Returns "" for empty input (no unit filter).
 */
export function normalizeUnit(text: string): { name: string } | { error: string } {
    const name = text.trim();
    if (!name)
        return { name: "" };
    if (/\s/.test(name))
        return { error: "A unit name has no spaces." };
    if (/[*?[\]]/.test(name))
        return { error: "Patterns are not supported here; enter one unit name." };
    if (name.includes("/"))
        return { error: "A unit name has no \"/\"." };
    return { name: UNIT_SUFFIX.test(name) ? name : `${name}.service` };
}

/**
 * FIELD=VALUE terms typed by the user, separated by spaces ("\ " for a space
 * inside a value). Field names follow journald's rules: capital letters,
 * digits and underscores, not starting with a digit, at most 64 characters.
 */
export function parseMatches(text: string): { matches: string[] } | { error: string } {
    const terms: string[] = [];
    let current = "";
    let inTerm = false;
    let escaped = false;
    for (const char of text) {
        if (escaped) {
            current += char;
            escaped = false;
        } else if (char === "\\") {
            escaped = true;
            inTerm = true;
        } else if (/\s/.test(char)) {
            if (inTerm)
                terms.push(current);
            current = "";
            inTerm = false;
        } else {
            current += char;
            inTerm = true;
        }
    }
    if (escaped)
        current += "\\";
    if (inTerm)
        terms.push(current);

    for (const term of terms) {
        if (term === "+")
            return { error: "\"+\" (either/or) is not supported here. Repeat a field to allow several values." };
        const eq = term.indexOf("=");
        const field = eq > 0 ? term.slice(0, eq) : "";
        if (!/^[A-Z_][A-Z0-9_]*$/.test(field) || field.length > 64)
            return { error: `"${term}" is not FIELD=VALUE (field names are capital letters, digits and "_").` };
    }
    return { matches: terms };
}

/** Matches back into the text form parseMatches() reads. */
export function formatMatches(matches: readonly string[]): string {
    return matches.map(m => m.replace(/\\/g, "\\\\").replace(/ /g, "\\ ")).join(" ");
}

/** For the identifier picker: the identifiers among loaded entries. */
export function identifiersIn(entries: readonly JournalEntry[]): string[] {
    const seen = new Set<string>();
    for (const entry of entries) {
        const id = entry.fields.SYSLOG_IDENTIFIER;
        if (typeof id === "string" && id)
            seen.add(id);
    }
    return [...seen];
}

/** Case-insensitive sort, as upstream sorts its identifier menu. */
export function sortNames(names: Iterable<string>): string[] {
    return [...new Set(names)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** Short boot id for labels. */
export function shortBoot(id: string): string {
    return id.length > 12 ? `${id.slice(0, 12)}${glyphs.ellipsis}` : id;
}
