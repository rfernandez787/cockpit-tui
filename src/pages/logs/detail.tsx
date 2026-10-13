/*
 * One journal entry in full: the whole message, then every field sorted by
 * name (upstream's logDetails.jsx), scrollable.
 *
 * The entry already in memory is shown as is; upstream re-fetches it only
 * because its detail is a separate URL route. The exception is a field that
 * journalctl left out for being too long (4096 bytes or more, sent as null
 * unless --all): "a" fetches the entry again with --all (spec G16), and the
 * cursor that comes back is checked, as upstream does, since --cursor seeks
 * to the nearest entry when the exact one is gone.
 *
 * "o" opens the entry's unit on the Services page, for the unit types
 * upstream links (service, target, socket, timer, path).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useWindowSize } from "ink";
import { Box, Text } from "../../tui/ink.js";
import { useKeys, isPlain, type Hint } from "../../tui/keyboard.js";
import { useStatus } from "../../tui/status.js";
import { useScroll } from "../../tui/components/ScrollView.js";
import { Heading } from "../../tui/components/misc.js";
import { Spinner } from "../../tui/components/Spinner.js";
import { fit, formatTimestamp } from "../../tui/text.js";
import { colors, glyphs } from "../../tui/theme.js";
import {
    entryUnit, journalArgs, streamJournal, PRIORITIES,
    type JournalEntry, type JournalStream, type UnitMatch,
} from "../../lib/journal.js";
import { detailLines, displayText, entryText, fitHints, hasMissing, sym, type EntryRow } from "./model.js";

export interface DetailProps {
    readonly row: EntryRow;
    readonly width: number;
    readonly height: number;
    readonly host: string;
    /** The time zone to name after the time, when it may not be the host's. */
    readonly zone: string | null;
    readonly onBack: () => void;
    /** Show the next older (1) or newer (-1) entry. */
    readonly onStep: (step: 1 | -1) => void;
    readonly onUnit: (unit: UnitMatch) => void;
    readonly onCommand: (entry: JournalEntry) => void;
    /** False while a dialog is open over the detail. */
    readonly active: boolean;
}

/** Footer hints for the detail, as many as fit beside the shell's own. */
export function detailHints(columns: number, unit: boolean, missing: boolean): Hint[] {
    const o = (label: string): Hint[] => (unit ? [["o", label]] : []);
    const a = (label: string): Hint[] => (missing ? [["a", label]] : []);
    return fitHints(columns, [
        [["esc", "back"], [sym.upDown, "scroll"], [sym.leftRight, "newer/older"], ...o("open unit"), ...a("full values"), ["!", "command"]],
        [["esc", "back"], [sym.leftRight, "newer/older"], ...o("open unit"), ...a("full values"), ["!", "command"]],
        [["esc", "back"], [sym.leftRight, "entries"], ...o("unit"), ...a("full values")],
        [["esc", "back"], [sym.leftRight, "entries"], ...o("unit"), ...a("all")],
        [["esc", "back"], ...o("unit"), ...a("all")],
        [["esc", "back"]],
    ]);
}

/** Every key of the detail, for the help screen. */
export const DETAIL_HELP: readonly Hint[] = [
    ["esc", "back to the list"],
    [`${sym.upDown} PgUp PgDn`, "scroll"],
    [sym.leftRight, "newer / older entry"],
    ["o", "open the entry's unit"],
    ["a", "fetch values too long to show"],
    ["!", "the equivalent journalctl command"],
];

export function EntryDetail(props: DetailProps) {
    const { row, width, height, active } = props;
    const { columns } = useWindowSize();
    const { notify } = useStatus();
    // The entry re-read with --all, for the entry it was read for.
    const [full, setFull] = useState<JournalEntry | null>(null);
    const [fetching, setFetching] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const fetchRef = useRef<JournalStream | null>(null);

    const cursor = row.entry.cursor;
    const entry = full?.cursor === cursor ? full : row.entry;
    const unit = useMemo(() => entryUnit(entry), [entry]);
    const missing = useMemo(() => hasMissing(entry.fields), [entry]);

    const fetchFull = () => {
        if (fetching)
            return;
        setFetching(true);
        setFetchError(null);
        let found: JournalEntry | null = null;
        fetchRef.current = streamJournal(journalArgs({}, { kind: "entry", cursor, all: true }), batch => {
            found ??= batch.find(e => e.cursor === cursor) ?? null;
        }, outcome => {
            fetchRef.current = null;
            setFetching(false);
            if (outcome.kind === "error") {
                setFetchError(outcome.message);
            } else if (!found) {
                // --cursor seeks to the nearest entry when the exact one is gone (rotated, vacuumed).
                setFetchError("Journal entry not found: it may have been rotated out of the journal.");
            } else {
                setFull(found);
                // The values change in place, perhaps out of view: say so.
                notify("Fetched the values journalctl left out.", "success");
            }
        }, { host: props.host, batchMs: 0 });
    };

    // One line of heading, one of status (fetching / errors) when needed.
    const status = fetching || fetchError;
    const bodyHeight = Math.max(1, height - 1 - (status ? 1 : 0));
    const textWidth = Math.max(10, width - 2);
    const lines = useMemo(
        () => detailLines(entry === row.entry ? row : { ...row, entry }, textWidth, { unit }),
        [row, entry, textWidth, unit]);
    const scroll = useScroll(lines.length, bodyHeight);
    const { setTop } = scroll;

    // Another entry (←/→): start at its top, and forget the fetch for the
    // previous one.
    useEffect(() => {
        setTop(0);
        setFetchError(null);
        return () => {
            fetchRef.current?.close();
            fetchRef.current = null;
            setFetching(false);
        };
    }, [cursor, setTop]);

    useKeys((input, key) => {
        if (key.escape) {
            props.onBack();
            return true;
        }
        if (key.leftArrow) {
            props.onStep(-1);
            return true;
        }
        if (key.rightArrow) {
            props.onStep(1);
            return true;
        }
        if (scroll.handleKey(input, key))
            return true;
        if (!isPlain(input, key))
            return false;
        switch (input) {
        case "k": return scroll.handleKey("", { ...key, upArrow: true });
        case "j": return scroll.handleKey("", { ...key, downArrow: true });
        case "g": return scroll.handleKey("", { ...key, home: true });
        case "G": return scroll.handleKey("", { ...key, end: true });
        case "o":
            if (unit)
                props.onUnit(unit);
            else
                notify("This entry belongs to no service, socket, timer, path or target unit.");
            return true;
        case "a":
            if (missing)
                fetchFull();
            else
                notify("Every value of this entry is already shown in full.");
            return true;
        case "!":
            props.onCommand(entry);
            return true;
        default:
            return false;
        }
    }, { active, hints: detailHints(columns, unit !== null, missing), help: DETAIL_HELP });

    const text = entryText(entry);
    const priority = entry.priority === null ? "no priority" : `priority ${PRIORITIES[entry.priority]} (${entry.priority})`;
    const title = `Entry at ${formatTimestamp(entry.time)}${props.zone ? ` ${props.zone}` : ""}`;
    const detail = [text.identifier, priority].filter(Boolean).join(`  ${sym.dot}  `);

    const visible = lines.slice(scroll.top, scroll.top + bodyHeight);
    const more = scroll.max > 0;
    const lineWidth = more ? width - 2 : width;

    return (
        <Box flexDirection="column" width={width} height={height}>
            <Heading title={title} detail={detail} width={width} />
            {fetching ? <Spinner label="Fetching full values" /> : null}
            {!fetching && fetchError
                ? <Text color={colors.error} wrap="truncate">{fit(`${glyphs.cross} ${displayText(fetchError)}`, width)}</Text>
                : null}
            <Box flexDirection="row" width={width} height={bodyHeight}>
                <Box flexDirection="column" width={lineWidth} height={bodyHeight}>
                    {visible.map((line, i) => (
                        <Text key={scroll.top + i} color={line.dim ? colors.dim : line.color} bold={line.bold} wrap="truncate">
                            {fit(line.text, lineWidth)}
                        </Text>
                    ))}
                </Box>
                {more && (
                    <Box flexDirection="column" width={2} height={bodyHeight} alignItems="flex-end">
                        <Text color={colors.dim}>{scroll.top > 0 ? glyphs.up : " "}</Text>
                        <Box flexGrow={1} />
                        <Text color={colors.dim}>{scroll.top < scroll.max ? glyphs.down : " "}</Text>
                    </Box>
                )}
            </Box>
        </Box>
    );
}
