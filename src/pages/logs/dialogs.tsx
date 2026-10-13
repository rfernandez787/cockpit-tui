/*
 * The Logs page's filter dialogs.
 *
 *   p  priority     a picker of the eight levels ("Error and above" ...)
 *   t  time         current boot, last 24 hours, last 7 days, a custom
 *                   since/until, and earlier boots from --list-boots
 *   i  identifier   the SYSLOG_IDENTIFIERs in the current selection, read
 *                   when the picker opens (a full scan of the time range,
 *                   stopped if the picker closes first: identifiers.ts),
 *                   plus those already loaded; type to narrow, or to use a
 *                   name that is not listed
 *   u  unit         a unit name, system or user
 *   /  grep         a PCRE2 pattern on MESSAGE
 *   m  matches      raw FIELD=VALUE terms
 *   !  command      the equivalent journalctl command line
 *
 * Times and patterns are checked by journalctl itself before they are
 * applied (checkArguments: --lines=0 parses and compiles, then shows
 * nothing), so a typo keeps the form open with journalctl's own complaint
 * instead of turning the list into an error.
 *
 * Key handling follows the Dialog contract: everything that takes keys is
 * rendered inside the dialog, so it is inside the dialog's key scope.
 *
 * Every dialog fits its area, down to the smallest page (50x10): Dialog
 * shrinks content taller than its area rather than cutting it off, which
 * draws lines over each other. So explanations give way first (a form's
 * intro becomes a short one, or none; the command's note goes), and a
 * picker shows fewer rows.
 */
import { useEffect, useRef, useState } from "react";
import { Box, Text } from "../../tui/ink.js";
import { useKeys, type Hint } from "../../tui/keyboard.js";
import { useAsync } from "../../tui/hooks.js";
import { Dialog, DialogText, dialogInnerWidth, useArea, useDialogWidth } from "../../tui/components/Dialog.js";
import { FormDialog, type FormDialogProps, type FormField } from "../../tui/components/Form.js";
import { TextInput } from "../../tui/components/TextInput.js";
import { useListNav } from "../../tui/components/Table.js";
import { Spinner } from "../../tui/components/Spinner.js";
import { clean, fit, formatTimestamp, truncate, wrap, width as textWidth } from "../../tui/text.js";
import { colors, glyphs } from "../../tui/theme.js";
import {
    PRIORITIES, PRIORITY_LABELS, listBoots,
    type Boot, type Capabilities, type JournalEntry, type Priority, type UnitMatch,
} from "../../lib/journal.js";
import {
    CURRENT_BOOT, RECENT, displayText, formatMatches, identifiersIn, journalFilter, normalizeUnit, parseMatches,
    sortNames, sym, timeLabel, type LogsFilter, type TimeChoice,
} from "./model.js";
import { checkArguments } from "./journal-view.js";
import { scanIdentifiers, type ScanResult } from "./identifiers.js";

// ---- picker ----------------------------------------------------------------------

export interface PickItem {
    readonly value: string;
    /** Safe display text. */
    readonly label: string;
    /** Dim text after the label. */
    readonly detail?: string;
}

export interface PickerProps {
    readonly title: string;
    readonly items: readonly PickItem[];
    /** The value in effect now, marked with a bullet and selected first. */
    readonly current: string;
    readonly onPick: (value: string) => void;
    readonly onCancel: () => void;
    /** Show a text field that narrows the list; Enter on text matching nothing uses the text. */
    readonly filterable?: boolean;
    /** A line with a spinner, while more items are on their way. */
    readonly loading?: string | null;
    /** Why the list may be incomplete (safe text), shown under the field. */
    readonly problem?: string | null;
    readonly width?: number;
}

export function PickerDialog(props: PickerProps) {
    const width = useDialogWidth(props.width ?? 60);
    return (
        <Dialog title={props.title} width={width} onCancel={props.onCancel} hints={[]}>
            <PickerBody {...props} width={width} />
        </Dialog>
    );
}

function PickerBody(props: PickerProps & { width: number }) {
    const { items, current, onPick, filterable = false } = props;
    const area = useArea();
    const inner = dialogInnerWidth(props.width);
    const [query, setQuery] = useState("");

    const needle = query.trim();
    let shown: readonly PickItem[] = items;
    if (filterable && needle) {
        const lower = needle.toLowerCase();
        // The "all" choice (empty value) is what an empty field means.
        shown = items.filter(item => item.value !== "" && item.value.toLowerCase().includes(lower));
        if (!items.some(item => item.value === needle))
            shown = [...shown, { value: needle, label: `Use "${clean(needle)}"` }];
    }

    // Border and title, the blank line above the list and the position under
    // it, the field and the loading line: what the list rows have to share
    // the area with, together with the problem.
    const fixed = 5 + (filterable ? 1 : 0) + (props.loading ? 1 : 0);
    const problem = props.problem ? limitLines(wrap(`${glyphs.warning} ${props.problem}`, inner), area.height - fixed - 3 >= 2 ? 2 : 1, inner) : [];
    // Rows to spare around the dialog where there is room, but never more than fit.
    const available = area.height - fixed - problem.length;
    const maxRows = Math.max(1, Math.min(available, Math.max(3, available - 3)));
    const rows = Math.max(1, Math.min(maxRows, shown.length));
    const nav = useListNav(shown.map(item => item.value), rows, { initialKey: current });

    const pick = () => {
        const item = shown[nav.index];
        if (item)
            onPick(item.value);
    };

    useKeys((_input, key) => {
        if (key.return) {
            pick();
            return true;
        }
        return false;
    }, {
        hints: [[sym.upDown, "choose"], ["enter", "apply"], ["esc", "cancel"]] satisfies Hint[],
    });

    const labelWidth = Math.min(Math.max(8, ...shown.map(item => textWidth(item.label))), Math.max(8, inner - 4 - 10));
    return (
        <Box flexDirection="column" marginTop={1}>
            {filterable
                ? (
                    <Box>
                        <Text color={colors.dim}>Filter </Text>
                        <TextInput value={query} onChange={setQuery} onSubmit={pick} width={Math.max(4, inner - 7)}
                                   placeholder="type to narrow the list" />
                    </Box>
                )
                : null}
            {props.loading ? <Spinner label={props.loading} /> : null}
            {problem.map((line, i) => <Text key={`p${i}`} color={colors.warning} wrap="truncate">{line}</Text>)}
            {shown.length === 0 ? <Text color={colors.dim}>(nothing to choose)</Text> : null}
            {shown.slice(nav.offset, nav.offset + rows).map((item, i) => {
                const index = nav.offset + i;
                const selected = index === nav.index;
                const head = `${selected ? glyphs.pointer : " "} ${item.value === current ? glyphs.bullet : " "} `;
                const label = fit(item.label, labelWidth);
                const room = Math.max(0, inner - textWidth(head) - labelWidth - 2);
                return (
                    <Text key={item.value} inverse={selected} wrap="truncate">
                        {head}{label}
                        <Text color={colors.dim}>{item.detail && room > 0 ? "  " + fit(item.detail, room) : fit("", room + 2)}</Text>
                    </Text>
                );
            })}
            {shown.length > rows
                ? <Text color={colors.dim}>{`${nav.index + 1}/${shown.length}`}</Text>
                : null}
        </Box>
    );
}

/** At most `max` of `lines`, the last of them ending in an ellipsis if any were left out. */
function limitLines(lines: readonly string[], max: number, columns: number): string[] {
    const keep = Math.max(1, max);
    if (lines.length <= keep)
        return [...lines];
    const out = lines.slice(0, keep);
    out[keep - 1] = truncate(`${out[keep - 1]!} ${glyphs.ellipsis}`, columns);
    return out;
}

// ---- forms -----------------------------------------------------------------------

/** The rows FormDialog lays out besides its intro: fields with their help or error lines, the form's error, the buttons. */
export function formRows(fields: readonly FormField[], width: number, error?: string | null): number {
    const inner = dialogInnerWidth(width);
    const labelWidth = Math.min(Math.floor(inner / 2), Math.max(...fields.map(f => textWidth(f.label))) + 2);
    const fieldWidth = Math.max(4, inner - labelWidth);
    const below = (field: FormField) =>
        field.error ? wrap(field.error, fieldWidth).length : field.help ? wrap(field.help, fieldWidth).length : 0;
    return 1 + fields.reduce((sum, field) => sum + 1 + below(field), 0) + (error ? 1 + wrap(error, inner).length : 0) + 2;
}

/**
 * A form fitted to `height` rows (the dialog's area): the first of `intros`
 * (longest first) that fits, or none; without the fields' help lines if even
 * the form alone does not fit; and with the form's error cut to the lines
 * left (Dialog would otherwise squeeze its lines into each other).
 */
export function fitForm(fields: readonly FormField[], error: string | null | undefined, intros: readonly string[],
                        width: number, height: number): { fields: readonly FormField[], intro: string | undefined, error: string | null } {
    // The dialog's border and title.
    const room = height - 3;
    const inner = dialogInnerWidth(width);
    const shown = formRows(fields, width, error) > room ? fields.map(field => ({ ...field, help: undefined })) : fields;
    let fitted = error || null;
    if (fitted && formRows(shown, width, fitted) > room) {
        // The error's own blank line above it, then what is left of the room.
        const lines = Math.max(1, room - formRows(shown, width, null) - 1);
        fitted = limitLines(wrap(fitted, inner), lines, inner).join(" ");
        if (wrap(fitted, inner).length > lines)
            fitted = truncate(error!, inner);
    }
    const left = room - formRows(shown, width, fitted);
    return { fields: shown, intro: intros.find(text => 1 + wrap(text, inner).length <= left), error: fitted };
}

/** FormDialog with an intro that gives way (fitForm()) where the area is short. */
function FittedFormDialog({ intros, ...props }: Omit<FormDialogProps, "intro"> & { intros: readonly string[] }) {
    const area = useArea();
    const width = useDialogWidth(props.width ?? 64);
    const { fields, intro, error } = fitForm(props.fields, props.error, intros, width, area.height);
    return <FormDialog {...props} fields={fields} error={error} {...(intro ? { intro } : {})} />;
}

// ---- priority --------------------------------------------------------------------

export function PriorityDialog({ current, onPick, onCancel }: {
    current: Priority, onPick: (priority: Priority) => void, onCancel: () => void,
}) {
    const items = PRIORITIES.map((priority, n) => ({ value: priority, label: PRIORITY_LABELS[priority], detail: `${priority} (${n})` }));
    return (
        <PickerDialog title="Priority" items={items} current={current} width={48}
                      onPick={value => onPick(value as Priority)} onCancel={onCancel} />
    );
}

// ---- time ------------------------------------------------------------------------

function timeValue(time: TimeChoice): string {
    switch (time.kind) {
    case "recent": return `recent:${time.since}`;
    case "boot": return `boot:${time.id}`;
    case "custom": return "custom";
    }
}

function bootSpan(boot: Boot): string {
    return `${formatTimestamp(boot.first, false)} ${sym.range} ${formatTimestamp(boot.last, false)}`;
}

/** Never settles: waits for a dependency that has not arrived yet. */
const pending = <T,>() => new Promise<T>(() => {});

export function TimeDialog({ time, caps, onPick, onCustom, onCancel }: {
    time: TimeChoice,
    caps: Capabilities | undefined,
    onPick: (time: TimeChoice) => void,
    onCustom: () => void,
    onCancel: () => void,
}) {
    // Earlier boots, for hosts with a persistent journal; a volatile journal
    // has only the current one, and then none are offered (spec G5). Closing
    // the dialog stops a listing still running (useAsync aborts its signal).
    const boots = useAsync(signal => (caps ? listBoots(caps, signal) : pending<Boot[]>()), [caps]);
    const list = boots.value ?? [];
    const current = list.find(boot => boot.index === 0);
    const earlier = list.filter(boot => boot.index < 0);

    const items: PickItem[] = [
        { value: "boot:0", label: "Current boot", ...(current ? { detail: `since ${formatTimestamp(current.first, false)}` } : {}) },
        ...RECENT.map(r => ({ value: `recent:${r.since}`, label: r.label })),
        { value: "custom", label: `Custom range${glyphs.ellipsis}`, ...(time.kind === "custom" ? { detail: clean(timeLabel(time)) } : {}) },
        ...earlier.map(boot => ({ value: `boot:${boot.id}`, label: `Boot ${boot.index}`, detail: bootSpan(boot) })),
    ];
    const loading = !caps || (caps.bootsJson && boots.loading) ? "Reading the list of boots" : null;

    return (
        <PickerDialog title="Time range" items={items} current={timeValue(time)} width={60} loading={loading}
                      onCancel={onCancel}
                      onPick={value => {
                          if (value === "custom")
                              onCustom();
                          else if (value === "boot:0")
                              onPick(CURRENT_BOOT);
                          else if (value.startsWith("recent:"))
                              onPick({ kind: "recent", since: value.slice("recent:".length) });
                          else {
                              const boot = earlier.find(b => `boot:${b.id}` === value);
                              if (boot)
                                  onPick({ kind: "boot", id: boot.id, index: boot.index, first: boot.first, last: boot.last });
                          }
                      }} />
    );
}

export function CustomTimeDialog({ time, host, onApply, onCancel }: {
    time: TimeChoice,
    host: string,
    onApply: (time: TimeChoice) => void,
    onCancel: () => void,
}) {
    const [since, setSince] = useState(time.kind === "custom" ? time.since ?? "" : time.kind === "recent" ? time.since : "");
    const [until, setUntil] = useState(time.kind === "custom" ? time.until ?? "" : "");
    const check = useCheck(host);

    const submit = () => {
        const s = since.trim();
        const u = until.trim();
        const args = [...(s ? [`--since=${s}`] : []), ...(u ? [`--until=${u}`] : [])];
        const apply = () => onApply({ kind: "custom", ...(s ? { since: s } : {}), ...(u ? { until: u } : {}) });
        if (args.length === 0)
            apply();
        else
            check.run(args, /timestamp|since|until/i, apply);
    };

    return (
        <FittedFormDialog
            title="Custom time range"
            intros={[
                "Times as journalctl reads them, in the host's time zone: \"2026-10-01 08:00\", " +
                "\"yesterday\", \"today\", \"-2h\", \"@1700000000\". Leave a field empty for no limit.",
                "e.g. \"yesterday\", \"-2h\", \"2026-10-01 08:00\"",
            ]}
            fields={[
                { kind: "text", id: "since", label: "Since", value: since, placeholder: "e.g. yesterday" },
                { kind: "text", id: "until", label: "Until", value: until, placeholder: "e.g. today 12:00" },
            ]}
            onChange={(id, value) => {
                check.clear();
                if (id === "since")
                    setSince(String(value));
                else
                    setUntil(String(value));
            }}
            onSubmit={submit}
            onCancel={onCancel}
            submitLabel="Apply"
            busy={check.busy}
            busyText="Checking with journalctl"
            error={check.error}
        />
    );
}

// ---- identifier ------------------------------------------------------------------

export function IdentifierDialog({ filter, entries, caps, host, onPick, onCancel }: {
    filter: LogsFilter,
    entries: readonly JournalEntry[],
    caps: Capabilities | undefined,
    host: string,
    onPick: (identifier: string | undefined) => void,
    onCancel: () => void,
}) {
    // Scanned once per opening, for the filter as it was when it opened, and
    // stopped when the picker closes. Until it is done -- or if it fails --
    // the identifiers of the entries already loaded are on offer, and any
    // name can be typed.
    const [query] = useState(() => journalFilter(filter));
    const [scan, setScan] = useState<ScanResult | null>(null);
    useEffect(() => {
        if (!caps)
            return;
        const running = scanIdentifiers(query, caps, host, setScan);
        return () => running.close();
    }, [caps, query, host]);

    const names = sortNames([...(scan?.names ?? []), ...identifiersIn(entries)]);
    const items: PickItem[] = [
        { value: "", label: "All identifiers" },
        ...names.map(name => ({ value: name, label: displayText(name) })),
    ];
    return (
        <PickerDialog title="Identifier (SYSLOG_IDENTIFIER)" items={items} current={filter.identifier ?? ""} width={56}
                      filterable loading={scan ? null : "Reading identifiers in the time range"}
                      problem={scan?.error ? `Could not list every identifier: ${displayText(scan.error)}` : null}
                      onPick={value => onPick(value || undefined)} onCancel={onCancel} />
    );
}

// ---- unit, grep, matches ---------------------------------------------------------

export function UnitDialog({ unit, onApply, onCancel }: {
    unit: UnitMatch | undefined,
    onApply: (unit: UnitMatch | undefined) => void,
    onCancel: () => void,
}) {
    const [name, setName] = useState(unit?.name ?? "");
    const [user, setUser] = useState(unit?.user === true);
    const [error, setError] = useState<string | null>(null);

    const submit = () => {
        const result = normalizeUnit(name);
        if ("error" in result) {
            setError(result.error);
            return;
        }
        onApply(result.name ? (user ? { name: result.name, user: true } : { name: result.name }) : undefined);
    };

    return (
        <FittedFormDialog
            title="Unit"
            intros={[
                "Entries from a systemd unit, and about it (UNIT=, COREDUMP_UNIT=). " +
                "A name without a type means .service; leave it empty for all units.",
                "Empty for all units; no type means .service",
            ]}
            fields={[
                { kind: "text", id: "name", label: "Unit", value: name, placeholder: "e.g. sshd.service", error },
                { kind: "checkbox", id: "user", label: "User unit", value: user, help: "a systemd --user unit" },
            ]}
            onChange={(id, value) => {
                if (id === "name") {
                    setName(String(value));
                    setError(null);
                } else {
                    setUser(Boolean(value));
                }
            }}
            onSubmit={submit}
            onCancel={onCancel}
            submitLabel="Apply"
        />
    );
}

export function GrepDialog({ grep, host, onApply, onCancel }: {
    grep: string | undefined,
    host: string,
    onApply: (grep: string | undefined) => void,
    onCancel: () => void,
}) {
    const [pattern, setPattern] = useState(grep ?? "");
    const check = useCheck(host);

    const submit = () => {
        if (!pattern.trim()) {
            onApply(undefined);
            return;
        }
        check.run([`--grep=${pattern}`], /pattern/i, () => onApply(pattern));
    };

    return (
        <FittedFormDialog
            title="Search messages"
            intros={[
                "A Perl-compatible regular expression, matched against MESSAGE. All lower case ignores " +
                "case; any capital letter makes it case-sensitive. Leave it empty to show every message.",
                "A regex on MESSAGE; lower case ignores case",
            ]}
            fields={[{ kind: "text", id: "pattern", label: "Pattern", value: pattern, placeholder: "e.g. fail(ed|ure)" }]}
            onChange={(_id, value) => {
                check.clear();
                setPattern(String(value));
            }}
            onSubmit={submit}
            onCancel={onCancel}
            submitLabel="Search"
            busy={check.busy}
            busyText="Checking the pattern"
            error={check.error}
        />
    );
}

export function MatchesDialog({ matches, onApply, onCancel }: {
    matches: readonly string[],
    onApply: (matches: string[]) => void,
    onCancel: () => void,
}) {
    const [text, setText] = useState(formatMatches(matches));
    const [error, setError] = useState<string | null>(null);

    const submit = () => {
        const result = parseMatches(text);
        if ("error" in result)
            setError(result.error);
        else
            onApply(result.matches);
    };

    return (
        <FittedFormDialog
            title="Field matches"
            intros={[
                "Journal fields that must match, as FIELD=VALUE separated by spaces (\"\\ \" for a space " +
                "in a value). Repeating a field allows any of its values. Example: _TRANSPORT=kernel _PID=1",
                "All must hold, e.g. _TRANSPORT=kernel _PID=1",
            ]}
            fields={[{ kind: "text", id: "matches", label: "Matches", value: text, placeholder: "e.g. _UID=0", error }]}
            onChange={(_id, value) => {
                setText(String(value));
                setError(null);
            }}
            onSubmit={submit}
            onCancel={onCancel}
            submitLabel="Apply"
        />
    );
}

/**
 * Validation by journalctl: run checkArguments(), and if journalctl rejects
 * the arguments for the reason `relevant` describes, keep the form open with
 * its message. Any other failure (no journal access, say) is left for the
 * list to report, so it never blocks applying a filter.
 */
function useCheck(host: string) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The run whose answer is still wanted. The dialog going away stops it.
    const latest = useRef<AbortController | null>(null);
    useEffect(() => () => {
        latest.current?.abort();
        latest.current = null;
    }, []);

    return {
        busy,
        error,
        clear: () => setError(null),
        run(args: string[], relevant: RegExp, apply: () => void) {
            if (busy)
                return;
            const run = new AbortController();
            latest.current = run;
            setBusy(true);
            setError(null);
            void checkArguments(args, host, run.signal).then(message => {
                if (latest.current !== run)
                    return;
                latest.current = null;
                setBusy(false);
                if (message && relevant.test(message))
                    setError(displayText(message));
                else
                    apply();
            });
        },
    };
}

// ---- command ---------------------------------------------------------------------

export function CommandDialog({ command, note, onClose }: { command: string, note: string, onClose: () => void }) {
    const width = useDialogWidth(76);
    const area = useArea();
    const text = displayText(command);
    // The command is there to be copied, so it is always shown whole; the
    // note gets what is left: the border, the title and two blank lines aside.
    const noteRows = area.height - 3 - 2 - wrap(text, dialogInnerWidth(width)).length;
    return (
        <Dialog title="Equivalent command" width={width} onCancel={onClose} onConfirm={onClose} hints={[["esc", "close"]]}>
            <DialogText width={width}>{text}</DialogText>
            {noteRows > 0 ? <DialogText width={width} color={colors.dim} maxLines={noteRows}>{note}</DialogText> : null}
        </Dialog>
    );
}
