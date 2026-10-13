/*
 * Logs: the systemd journal, newest first, following new entries as they
 * are logged. Upstream's pkg/systemd/logs.jsx and logDetails.jsx, read
 * through journalctl (see journal-view.ts for the queries, model.ts for what
 * the filters mean and how rows are built).
 *
 *   Error and above · Last 24 hours · unit sshd.service          <- filters
 *   ● Following  ·  279 entries                                  <- state
 *   ✗ Following stopped: ...                       <- banner, when needed
 *     TIME     PRIO   IDENTIFIER   MESSAGE                     12/279
 *     ── Friday, October 2, 2026 ──────────────────────────────────────
 *   › 18:13:44 ERR    sshd-session error: kex_exchange_identification ×3
 *
 * Keys (list): ↑↓ j k PgUp PgDn, g/Home newest, G/End oldest; Enter opens
 * the entry; f or Space pauses and resumes following; p t i u / m set the
 * priority, time range, identifier, unit, search and field matches; c clears
 * them; L loads earlier entries; r reloads; ! shows the equivalent journalctl
 * command; Esc dismisses the banner. In the entry: Esc back, ←→ newer/older,
 * o opens its unit in Services, a fetches values journalctl left out.
 *
 * Filters, the selection and the follow setting outlive the page (persistent
 * state); entries do not, they are read again. Params from another page
 * ("view all logs" on Services) replace the filters once, at mount, and
 * turn following back on.
 *
 * The entry detail shows the row that was opened, held as it was: following
 * may fold a new repeat into that row, or push it out of memory, and neither
 * should change what is being read. ←→ step from wherever that row is now.
 *
 * Errors follow the journal rules of spec G4/G21/G28: journalctl's own words,
 * cleaned, in the list area when nothing could be read, or in a one-line
 * banner over the entries; notices (exit 0 with stderr) as a warning; and a
 * hint to turn on administrative access where that would help.
 */
import { useEffect, useMemo, useState } from "react";
import { useWindowSize } from "ink";
import { Box, Text } from "../../tui/ink.js";
import cockpit from "../../cockpit.js";
import type { PageProps } from "../../tui/page.js";
import { useKeys, isPlain, type Hint } from "../../tui/keyboard.js";
import { useAsync } from "../../tui/hooks.js";
import { usePersistentState, useSession } from "../../tui/session-context.js";
import { useNavigation, usePageParams } from "../../tui/navigation.js";
import { usePrivilege, type Privilege } from "../../tui/privilege.js";
import { useStatus } from "../../tui/status.js";
import { Spinner } from "../../tui/components/Spinner.js";
import { fit, truncate, wrap, width as textWidth } from "../../tui/text.js";
import { Panel, PANEL_EDGE, panelled } from "../../tui/components/Panel.js";
import { colors, glyphs } from "../../tui/theme.js";
import { capabilities, journalArgs, type JournalEntry, type UnitMatch } from "../../lib/journal.js";
import {
    DEFAULT_FILTER, buildRows, displayCommand, displayText, filterFromParams, filterKey, filterSummary, fitHints,
    followBlocked, journalFilter, limits, shellQuote, sym, timeName, zoneName, type EntryRow, type LogsFilter, type LogsParams,
    type Row,
} from "./model.js";
import { useJournalView, type JournalView } from "./journal-view.js";
import { TOP, navKey, navModel, resolve, moveTo, stepEntry, type NavState } from "./nav.js";
import { LogList, identifierWidth, type Trailer } from "./list.js";
import { EntryDetail } from "./detail.js";
import {
    CommandDialog, CustomTimeDialog, GrepDialog, IdentifierDialog, MatchesDialog, PriorityDialog, TimeDialog, UnitDialog,
} from "./dialogs.js";

type DialogKind = "priority" | "time" | "custom-time" | "identifier" | "unit" | "grep" | "matches" | "command";

/** Groups whose members read the whole journal (journal file ACLs). */
const JOURNAL_GROUPS = ["adm", "wheel", "systemd-journal"];

export default function LogsPage(props: PageProps) {
    // Two panels when there is room: the filter with the journal's state, and
    // the entries. `width` and `height` are what is left for those lines.
    const boxed = panelled(props.width, props.height);
    const width = boxed ? props.width - PANEL_EDGE : props.width;
    const height = boxed ? props.height - 2 * PANEL_EDGE : props.height;
    const params = usePageParams<LogsParams>("logs");
    const { hostname, session } = useSession();
    const privilege = usePrivilege();
    const navigation = useNavigation();
    const { notify } = useStatus();
    const { columns } = useWindowSize();

    // Params from another page replace the saved filters, once.
    const [savedFilter, saveFilter] = usePersistentState<LogsFilter>("logs:filter", DEFAULT_FILTER);
    const [savedNav, saveNav] = usePersistentState<NavState>("logs:nav", TOP);
    const [fromParams] = useState(() => filterFromParams(params));
    const [filter, setFilter] = useState<LogsFilter>(fromParams ?? savedFilter);
    const [nav, setNav] = useState<NavState>(fromParams ? TOP : savedNav);
    const [followWanted, setFollowWanted] = usePersistentState("logs:follow", true);
    useEffect(() => saveFilter(filter), [filter, saveFilter]);
    useEffect(() => saveNav(nav), [nav, saveNav]);
    // "View all logs" from another page means the live log, even if it was paused here earlier.
    useEffect(() => {
        if (fromParams)
            setFollowWanted(true);
    }, [fromParams, setFollowWanted]);

    const [reload, setReload] = useState(0);
    // The entry detail: the row it was opened on, as it was then.
    const [detail, setDetail] = useState<EntryRow | null>(null);
    const [dialog, setDialog] = useState<DialogKind | null>(null);
    const [command, setCommand] = useState<{ command: string, note: string } | null>(null);
    // The banners put away with Esc (by key: several may apply at once).
    const [dismissed, setDismissed] = useState<ReadonlySet<string>>(NONE);

    const caps = useAsync(signal => capabilities(signal), []);
    const jf = useMemo(() => journalFilter(filter), [filter]);
    const queryKey = useMemo(() => filterKey(filter), [filter]);
    const blocked = followBlocked(filter);
    const view = useJournalView({ filter: jf, queryKey, reload, follow: followWanted && !blocked, host: hostname });

    const rangeName = timeName(filter.time);
    const rows = useMemo(
        () => buildRows(view.entries, view.boundary ? { cursor: view.boundary, text: `Before ${rangeName}` } : undefined),
        [view.entries, view.boundary, rangeName]);
    // The identifier column is sized once a query's entries are in, and then
    // kept: entries that arrive later (following, loading earlier) are cut to
    // it, rather than shifting every message sideways under the reader.
    const sizing = `${queryKey}\n${reload}\n${width}`;
    const [identSize, setIdentSize] = useState<{ key: string, width: number } | null>(null);
    const kept = identSize?.key === sizing ? identSize.width : null;
    const measured = useMemo(() => (kept === null ? identifierWidth(rows, width) : 0), [kept, rows, width]);
    const identWidth = kept ?? measured;
    const settled = !view.loading && view.entries.length > 0;
    useEffect(() => {
        if (kept === null && settled)
            setIdentSize({ key: sizing, width: measured });
    }, [kept, settled, sizing, measured]);
    const ordinals = useMemo(() => entryOrdinals(rows), [rows]);

    // ---- layout ----------------------------------------------------------------

    const banner = bannerFor(view, privilege, dismissed);
    const bannerRows = banner ? bannerLines(banner, Math.max(1, width - 2)) : [];
    const listHeight = Math.max(2, height - 2 - bannerRows.length);
    const visible = Math.max(1, listHeight - 1);
    const trailer = trailerFor(view, filter);
    const hasTrailer = trailer !== null;
    const model = useMemo(() => navModel(rows, hasTrailer), [rows, hasTrailer]);
    const current = resolve(model, nav, visible);
    const selected = current.index >= 0 ? rows[current.index] as EntryRow : null;

    // ---- actions ---------------------------------------------------------------

    const applyFilter = (next: LogsFilter) => {
        setDialog(null);
        // The same query under another name (a custom range equal to a preset,
        // say) only relabels; anything else starts over at the newest entry.
        const changed = filterKey(next) !== filterKey(filter);
        setFilter(next);
        if (changed) {
            setNav(TOP);
            setDetail(null);
            setDismissed(NONE);
        }
    };

    /**
     * Open an entry row in the detail. The list selection is pinned to it
     * (no longer "the newest"), so the list shows it on return.
     */
    const openDetail = (index: number, from = current) => {
        const row = rows[index];
        if (row?.kind !== "entry")
            return;
        setNav({ ...moveTo(model, from, index, visible), top: false });
        setDetail(row);
    };

    const toggleFollow = () => {
        if (blocked) {
            notify(`Not following: ${blocked}.`);
            return;
        }
        if (view.error) {
            // Following starts after a good read; flipping the setting now would do nothing visible.
            notify("The journal could not be read: r tries again.", "warning");
            return;
        }
        if (view.followError) {
            // A new attempt: if it fails the same way, say so again.
            setDismissed(d => without(d, followBanner(view.followError!).key));
            view.retryFollow();
            setFollowWanted(true);
            return;
        }
        setFollowWanted(wanted => !wanted);
    };

    const loadEarlier = () => {
        if (view.earlierError) {
            const failed = earlierBanner(view.earlierError).key;
            setDismissed(d => without(d, failed));
        }
        const result = view.loadEarlier();
        if (result === "none" && view.error)
            notify("The journal could not be read: r tries again.", "warning");
        else if (result === "none")
            notify("No earlier entries match the filters.");
        else if (result === "full")
            notify(`The list holds at most ${limits.max.toLocaleString()} entries; narrow the filters to see older ones.`, "warning");
    };

    const showGrep = () => {
        if (caps.value?.grep)
            setDialog("grep");
        else if (caps.loading)
            notify("Still checking what journalctl supports.");
        else
            notify("This journalctl cannot search messages (it was built without PCRE2).", "warning");
    };

    const listCommand = () => {
        setCommand({
            command: displayCommand(journalArgs(jf, { kind: "page", lines: limits.page })),
            note: "Newest first, as listed here. To follow new entries instead, replace --reverse with --follow.",
        });
        setDialog("command");
    };

    const entryCommand = (entry: JournalEntry) => {
        setCommand({
            command: ["journalctl", "--all", "--output=verbose", "--lines=1", `--cursor=${entry.cursor}`].map(shellQuote).join(" "),
            note: "This entry with every field, as journalctl prints it.",
        });
        setDialog("command");
    };

    const openUnit = (unit: UnitMatch) => {
        navigation.go("services", { unit: unit.name, user: unit.user === true });
    };

    /** ←→ in the detail: the next older (1) or newer (-1) row from where the open one is now. */
    const step = (direction: 1 | -1) => {
        if (!detail)
            return;
        const at = model.indexOf(detail.entry.cursor);
        if (at < 0) {
            notify("This entry is no longer in the list.");
            return;
        }
        const target = stepEntry(model, at, direction);
        if (target < 0) {
            notify(direction < 0 ? "This is the newest entry." : "This is the oldest entry loaded.");
            return;
        }
        openDetail(target, resolve(model, { ...nav, key: detail.entry.cursor, index: at, top: false }, visible));
    };

    // ---- keys ------------------------------------------------------------------

    const listActive = detail === null && dialog === null;
    useKeys((input, key) => {
        const moves = key.upArrow ? "up" : key.downArrow ? "down" : key.pageUp ? "pageUp" : key.pageDown ? "pageDown"
            : key.home ? "home" : key.end ? "end" : null;
        if (moves) {
            const next = navKey(model, current, visible, moves);
            if (next)
                setNav(next);
            return true;
        }
        if (key.return) {
            if (selected)
                openDetail(current.index);
            return true;
        }
        if (key.escape) {
            if (!banner)
                return false;
            setDismissed(d => new Set(d).add(banner.key));
            return true;
        }
        if (!isPlain(input, key))
            return false;
        const letter = { k: "up", j: "down", g: "home", G: "end" } as const;
        if (input in letter) {
            const next = navKey(model, current, visible, letter[input as keyof typeof letter]);
            if (next)
                setNav(next);
            return true;
        }
        switch (input) {
        case "f":
        case " ": toggleFollow(); return true;
        case "p": setDialog("priority"); return true;
        case "t": setDialog("time"); return true;
        case "i": setDialog("identifier"); return true;
        case "u": setDialog("unit"); return true;
        case "/": showGrep(); return true;
        case "m": setDialog("matches"); return true;
        case "c": applyFilter(DEFAULT_FILTER); return true;
        case "L": loadEarlier(); return true;
        case "r": setReload(n => n + 1); setDismissed(NONE); return true;
        case "!": listCommand(); return true;
        default: return false;
        }
    }, {
        active: listActive,
        hints: listHints(columns, {
            // What f does: pause what is wanted (even while it starts), or follow (again).
            following: followWanted && view.followError === null,
            blocked: blocked !== null,
            failed: view.error !== null,
            empty: view.entries.length === 0,
            noEarlier: view.reachedStart || view.entries.length >= limits.max,
        }),
        help: LIST_HELP,
    });

    // ---- render ----------------------------------------------------------------

    const dialogNode = (() => {
        switch (dialog) {
        case "priority":
            return <PriorityDialog current={filter.priority} onCancel={() => setDialog(null)}
                                   onPick={priority => applyFilter({ ...filter, priority })} />;
        case "time":
            return <TimeDialog time={filter.time} caps={caps.value} onCancel={() => setDialog(null)}
                               onCustom={() => setDialog("custom-time")}
                               onPick={time => applyFilter({ ...filter, time })} />;
        case "custom-time":
            return <CustomTimeDialog time={filter.time} host={hostname} onCancel={() => setDialog(null)}
                                     onApply={time => applyFilter({ ...filter, time })} />;
        case "identifier":
            return <IdentifierDialog filter={filter} entries={view.entries} caps={caps.value} host={hostname}
                                     onCancel={() => setDialog(null)}
                                     onPick={identifier => applyFilter(withOptional(filter, "identifier", identifier))} />;
        case "unit":
            return <UnitDialog unit={filter.unit} onCancel={() => setDialog(null)}
                               onApply={unit => applyFilter(withOptional(filter, "unit", unit))} />;
        case "grep":
            return <GrepDialog grep={filter.grep} host={hostname} onCancel={() => setDialog(null)}
                               onApply={grep => applyFilter(withOptional(filter, "grep", grep))} />;
        case "matches":
            return <MatchesDialog matches={filter.matches} onCancel={() => setDialog(null)}
                                  onApply={matches => applyFilter({ ...filter, matches })} />;
        case "command":
            return command ? <CommandDialog {...command} onClose={() => setDialog(null)} /> : null;
        default:
            return null;
        }
    })();

    const remote = session !== null && session.mode !== "local";
    if (detail) {
        return (
            <Box flexDirection="column" width={props.width} height={props.height}>
                <Panel plain={!boxed} title="Entry" width={props.width} height={props.height}>
                    <EntryDetail row={detail} width={width} height={boxed ? props.height - PANEL_EDGE : height} host={hostname}
                                 active={dialog === null} zone={remote ? zoneName() : null}
                                 onBack={() => setDetail(null)} onStep={step} onUnit={openUnit} onCommand={entryCommand} />
                </Panel>
                {dialogNode}
            </Box>
        );
    }

    const position = selected && model.count > visible
        ? positionText((ordinals.before[current.index] ?? 0) + 1, ordinals.total)
        : null;
    return (
        <Box flexDirection="column" width={props.width} height={props.height}>
            <Panel plain={!boxed} title="Filter" width={props.width} height={props.height - listHeight - PANEL_EDGE}>
                <SummaryLine filter={filter} width={width} />
                <StatusLine view={view} filter={filter} blocked={blocked} followWanted={followWanted}
                            remote={remote} width={width} />
                {bannerRows.map((line, i) => (
                    <Text key={i} color={banner!.color} wrap="truncate">
                        {fit(`${i === 0 ? banner!.glyph : " "} ${line}`, width)}
                    </Text>
                ))}
            </Panel>
            <Panel plain={!boxed} title="Journal" width={props.width} height={listHeight + PANEL_EDGE}>
                {view.entries.length > 0
                    ? <LogList rows={rows} nav={current} width={width} height={listHeight} trailer={trailer}
                               identWidth={identWidth} position={position} />
                    : <EmptyState view={view} filter={filter} privilege={privilege} following={view.following}
                                  width={width} height={listHeight} />}
            </Panel>
            {dialogNode}
        </Box>
    );
}

/** Set or clear one optional filter field. */
function withOptional<K extends "identifier" | "unit" | "grep">(filter: LogsFilter, key: K, value: LogsFilter[K] | undefined): LogsFilter {
    const next: Record<string, unknown> = { ...filter };
    if (value === undefined || value === "")
        delete next[key];
    else
        next[key] = value;
    return next as unknown as LogsFilter;
}

export interface ListHintState {
    /** Following is wanted (f pauses) rather than paused (f follows). */
    readonly following: boolean;
    /** Following is impossible for the filter. */
    readonly blocked: boolean;
    /** The journal could not be read: following and loading earlier wait for r. */
    readonly failed?: boolean;
    /** No entries to open. */
    readonly empty?: boolean;
    /** Nothing earlier can be loaded: the start was reached, or the list holds all it may. */
    readonly noEarlier?: boolean;
}

/**
 * Footer hints for the list, as many as fit beside the shell's own: "? help"
 * and "q quit" must stay visible on an 80-column terminal (model.ts fitHints).
 * Only keys that do something now are offered.
 */
export function listHints(columns: number, state: ListHintState): Hint[] {
    const { following, blocked, failed = false, empty = false, noEarlier = false } = state;
    const when = (condition: boolean, ...hints: Hint[]): Hint[] => (condition ? hints : []);
    const enter = (label: string) => when(!empty, ["enter", label]);
    // After a failed read, reading again is what helps: it comes first.
    const retry = when(failed, ["r", "reload"]);
    const follow = when(!blocked && !failed, ["f", following ? "pause" : "follow"]);
    const earlier = (label: string) => when(!failed && !noEarlier, ["L", label]);
    return fitHints(columns, [
        [...enter("details"), ...retry, ...follow, ["p t i u / m", "filter"], ["c", "clear"], ...earlier("earlier"), ["!", "command"],
            ...when(!failed, ["r", "reload"])],
        [...enter("details"), ...retry, ...follow, ["p t i u / m", "filter"], ["c", "clear"], ...earlier("earlier"), ["!", "command"]],
        [...enter("details"), ...retry, ...follow, ["p t i u /", "filter"], ...earlier("earlier"), ["!", "command"]],
        [...enter("open"), ...retry, ...follow, ["ptiu/", "filter"], ...earlier("more")],
        [...enter("open"), ...retry, ...follow, ["ptiu/", "filter"]],
        [...enter("open"), ...retry, ...follow],
        [...enter("open"), ...retry],
        failed ? retry : enter("open"),
    ]);
}

/** Every key of the list, for the help screen, which has room the footer lacks. */
export const LIST_HELP: readonly Hint[] = [
    ["enter", "entry details"],
    ["f, space", "follow new entries, or pause"],
    ["p", "filter by priority"],
    ["t", "filter by time"],
    ["i", "filter by identifier"],
    ["u", "filter by unit"],
    ["/", "search messages"],
    ["m", "filter by journal fields"],
    ["c", "clear the filters"],
    ["L", "load earlier entries"],
    ["r", "reload"],
    ["!", "the equivalent journalctl command"],
    ["esc", "dismiss a notice"],
];

/** "12/279": the selected entry's place among all entries, both with thousands separators. */
export function positionText(ordinal: number, total: number): string {
    return `${ordinal.toLocaleString()}/${total.toLocaleString()}`;
}

/** For each row, how many entries the rows above it hold (repeats count each time). */
export function entryOrdinals(rows: readonly Row[]): { before: Int32Array, total: number } {
    const before = new Int32Array(rows.length);
    let n = 0;
    rows.forEach((row, i) => {
        before[i] = n;
        if (row.kind === "entry")
            n += row.count;
    });
    return { before, total: n };
}

// ---- pieces ------------------------------------------------------------------------

function SummaryLine({ filter, width }: { filter: LogsFilter, width: number }) {
    const parts = filterSummary(filter).map(displayText);
    const active = filterKey(filter) !== filterKey(DEFAULT_FILTER);
    return (
        <Text wrap="truncate">
            <Text bold color={colors.accent}>{truncate(parts.join(` ${sym.dot} `), width)}</Text>
            {active && textWidth(parts.join(` ${sym.dot} `)) + 12 < width ? <Text color={colors.dim}>{"  (c clears)"}</Text> : null}
        </Text>
    );
}

function StatusLine({ view, filter, blocked, followWanted, remote, width }: {
    view: JournalView, filter: LogsFilter, blocked: string | null, followWanted: boolean, remote: boolean, width: number,
}) {
    // Over ssh or ws this terminal's time zone may not be the host's: say
    // which one the times are in.
    const right = remote ? `times in ${zoneName()}` : "";
    const count = view.entries.length;
    const extra = [
        `${count.toLocaleString()} ${count === 1 ? "entry" : "entries"}`,
        ...(view.beyond ? [`includes entries before ${timeName(filter.time)}`] : []),
    ].join(`  ${sym.dot}  `);

    let state: { glyph: string, word: string, color: string };
    if (view.error)
        state = { glyph: glyphs.cross, word: "Failed", color: colors.error };
    else if (view.followError)
        state = { glyph: glyphs.cross, word: "Following stopped", color: colors.error };
    else if (view.following)
        state = { glyph: glyphs.bullet, word: "Following", color: colors.ok };
    else if (blocked)
        state = { glyph: glyphs.hollow, word: `Not following: ${blocked}`, color: colors.dim };
    else if (!followWanted)
        state = { glyph: glyphs.hollow, word: "Paused", color: colors.warning };
    else
        state = { glyph: glyphs.hollow, word: "Waiting", color: colors.dim };

    const rightWidth = right ? textWidth(right) + 1 : 0;
    if (view.loading) {
        return (
            <Box width={width} height={1}>
                <Box width={Math.max(0, width - rightWidth)}><Spinner label="Loading" /></Box>
                {right ? <Text color={colors.dim}>{fit(right, rightWidth, "right")}</Text> : null}
            </Box>
        );
    }
    const head = `${state.glyph} ${state.word}`;
    const left = Math.max(0, width - rightWidth);
    const rest = Math.max(0, left - textWidth(head));
    return (
        <Text wrap="truncate">
            <Text color={state.color}>{truncate(head, left)}</Text>
            <Text color={colors.dim}>{fit(rest > 4 ? `  ${sym.dot}  ${extra}` : "", rest)}</Text>
            {right ? <Text color={colors.dim}>{fit(right, rightWidth, "right")}</Text> : null}
        </Text>
    );
}

interface Banner {
    /** What happened (safe text). */
    readonly text: string;
    /** What to do about it, kept visible when the text is cut short. */
    readonly action: string | null;
    readonly glyph: string;
    readonly color: string;
    /** Identifies it for Esc. */
    readonly key: string;
}

const NONE: ReadonlySet<string> = new Set();

function without(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
    if (!set.has(key))
        return set;
    const next = new Set(set);
    next.delete(key);
    return next;
}

function makeBanner(kind: "error" | "warning", text: string, action: string | null = null): Banner {
    return {
        text, action,
        glyph: kind === "error" ? glyphs.cross : glyphs.warning,
        color: kind === "error" ? colors.error : colors.warning,
        key: action ? `${text} ${action}` : text,
    };
}

const followBanner = (message: string) => makeBanner("error", `Following stopped: ${displayText(message)}`, "(f tries again)");
const earlierBanner = (message: string) => makeBanner("error", `Could not load earlier entries: ${displayText(message)}`);

/**
 * A banner in at most two lines. Text that needs more is cut short, with an
 * ellipsis, and its action keeps its place at the end, so the way out ("f
 * tries again") is never what is lost.
 */
export function bannerLines(b: Pick<Banner, "text" | "action">, columns: number): string[] {
    const lines = wrap(b.action ? `${b.text} ${b.action}` : b.text, columns);
    if (lines.length <= 2)
        return lines;
    if (b.action && textWidth(b.action) + 2 <= columns) {
        const [first = "", ...rest] = wrap(b.text, columns);
        return [first, `${truncate(rest.join(" "), columns - textWidth(b.action) - 1)} ${b.action}`];
    }
    return [lines[0]!, truncate(`${lines[1]!} ${glyphs.ellipsis}`, columns)];
}

/** Who may read only part of the journal, as far as we can tell. */
function limitedReader(privilege: Privilege): boolean {
    if (privilege.allowed !== false || privilege.isRoot)
        return false;
    const user = cockpit.info?.user as { uid?: number, groups?: unknown } | undefined;
    if (!user || user.uid === 0 || !Array.isArray(user.groups))
        return false; // unknown: say nothing rather than something wrong
    return !user.groups.some(group => JOURNAL_GROUPS.includes(String(group)));
}

/** What to do about an error, where there is something to do. */
function advice(message: string, privilege: Privilege): string | null {
    if (/insufficient permissions|permission denied|access denied/i.test(message)) {
        if (privilege.allowed === false && privilege.configured === true)
            return "Press A to turn on administrative access.";
        return "Members of the adm, wheel and systemd-journal groups can read the whole journal.";
    }
    if (/timestamp|--since|--until|boot/i.test(message))
        return "Press t to choose another time range.";
    if (/pattern/i.test(message))
        return "Press / to change the search.";
    if (/match/i.test(message))
        return "Press m to change the field matches.";
    if (/not installed/.test(message))
        return null;
    return "Press r to try again.";
}

/** journalctl's message, then what to do about it: "Bad message." + "Press r to try again." */
function withAdvice(message: string, help: string | null): Banner {
    const text = displayText(message);
    return makeBanner("error", help && !/[.!?:]$/.test(text) ? `${text}.` : text, help);
}

function bannerFor(view: JournalView, privilege: Privilege, dismissed: ReadonlySet<string>): Banner | null {
    const candidates: (Banner | null)[] = [
        // Without entries, the list area shows the error in full instead.
        view.error && view.entries.length > 0 ? withAdvice(view.error, advice(view.error, privilege)) : null,
        view.followError ? followBanner(view.followError) : null,
        view.earlierError ? earlierBanner(view.earlierError) : null,
        view.notice && view.entries.length > 0 ? makeBanner("warning", displayText(view.notice)) : null,
        limitedReader(privilege)
            ? makeBanner("warning", privilege.configured === true
                ? "Only entries you may read are shown. Press A for administrative access to see all."
                : "Only entries you may read are shown: not a member of adm, wheel or systemd-journal.")
            : null,
    ];
    return candidates.find(candidate => candidate !== null && !dismissed.has(candidate.key)) ?? null;
}

function trailerFor(view: JournalView, filter: LogsFilter): Trailer | null {
    if (view.entries.length === 0 || view.loading)
        return null;
    if (view.loadingEarlier)
        return { text: "Loading earlier entries", loading: true };
    if (view.entries.length >= limits.max)
        return { text: `${limits.max.toLocaleString()} entries is the most the list holds; narrow the filters for older ones` };
    if (view.error)
        return null;
    if (view.reachedStart)
        return { text: "No earlier entries" };
    if (!view.windowDone)
        return { text: "L loads more" };
    if (view.beyond)
        return { text: "L loads earlier entries" };
    return { text: `Start of ${timeName(filter.time)} ${sym.dot} L loads earlier entries` };
}

function EmptyState({ view, filter, privilege, following, width, height }: {
    view: JournalView, filter: LogsFilter, privilege: Privilege, following: boolean, width: number, height: number,
}) {
    const lines: { text: string, color?: string }[] = [];
    if (view.loading) {
        return (
            <Box width={width} height={height} flexDirection="column" paddingX={2} paddingTop={1}>
                <Spinner label="Reading the journal" />
            </Box>
        );
    }
    if (view.error) {
        lines.push({ text: `${glyphs.cross} ${displayText(view.error)}`, color: colors.error });
        const help = advice(view.error, privilege);
        if (help)
            lines.push({ text: help });
    } else {
        lines.push({ text: `No entries match the filters in ${timeName(filter.time)}.` });
        if (view.notice)
            lines.push({ text: `${glyphs.warning} ${displayText(view.notice)}`, color: colors.warning });
        if (following)
            lines.push({ text: "New entries appear here as they are logged.", color: colors.dim });
        const tips: string[] = [];
        if (!view.reachedStart && filter.time.kind !== "boot" && !(filter.time.kind === "custom" && !filter.time.since))
            tips.push("L loads earlier entries");
        if (filter.priority !== "debug")
            tips.push("p shows lower priorities");
        tips.push("t picks another time range");
        if (filterKey(filter) !== filterKey(DEFAULT_FILTER))
            tips.push("c clears the filters");
        lines.push({ text: "" });
        lines.push({ text: tips.join(` ${sym.dot} `), color: colors.dim });
    }
    const inner = Math.max(1, width - 4);
    const wrapped = lines.flatMap(line => (line.text ? wrap(line.text, inner) : [""]).map(text => ({ ...line, text })));
    return (
        <Box width={width} height={height} flexDirection="column" paddingX={2} paddingTop={1}>
            {wrapped.slice(0, Math.max(0, height - 1)).map((line, i) => (
                <Text key={i} color={line.color} wrap="truncate">{line.text || " "}</Text>
            ))}
        </Box>
    );
}
