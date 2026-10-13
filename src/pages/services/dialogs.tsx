/*
 * The Services page's dialogs: the state filter, and running an action.
 *
 * Keys go through Dialog's onKey (a useKeys next to a <Dialog> would sit
 * outside the dialog's key scope and never see a key).
 */
import { useEffect, useRef, useState } from "react";
import { Box, Text } from "../../tui/ink.js";
import { Buttons, Dialog, DialogText, dialogInnerWidth, useArea, useDialogWidth } from "../../tui/components/Dialog.js";
import { Spinner } from "../../tui/components/Spinner.js";
import type { KeyHandler } from "../../tui/keyboard.js";
import { useMounted } from "../../tui/hooks.js";
import { errorText, useStatus } from "../../tui/status.js";
import { fit, truncate, width as textWidth, wrap } from "../../tui/text.js";
import { colors, glyphs } from "../../tui/theme.js";
import type { ActionId, FilterOptions, Owner, StateFilter } from "./model.js";
import { trackAction, type ActionTarget } from "./actions.js";
import { clean } from "./format.js";

// ---- state filter ------------------------------------------------------------------

type FilterItem =
    | { readonly kind: "failed" }
    | { readonly kind: "header", readonly label: string }
    | { readonly kind: "active" | "file", readonly label: string };

function checked(filter: StateFilter, item: FilterItem): boolean {
    switch (item.kind) {
    case "failed": return filter.failedOnly;
    case "active": return filter.active.includes(item.label);
    case "file": return filter.file.includes(item.label);
    default: return false;
    }
}

function toggled(filter: StateFilter, item: FilterItem): StateFilter {
    const flip = (list: readonly string[], label: string) =>
        list.includes(label) ? list.filter(l => l !== label) : [...list, label];
    switch (item.kind) {
    case "failed": return { ...filter, failedOnly: !filter.failedOnly };
    case "active": return { ...filter, active: flip(filter.active, item.label) };
    case "file": return { ...filter, file: flip(filter.file, item.label) };
    default: return filter;
    }
}

/**
 * Pick which states to show: "failed only", and upstream's two multi-selects
 * (active state, file state). Nothing changes until Enter.
 */
export function FilterDialog({ options, value, onApply, onCancel }: {
    options: FilterOptions,
    value: StateFilter,
    onApply: (filter: StateFilter) => void,
    onCancel: () => void,
}) {
    const area = useArea();
    const width = useDialogWidth(56);
    const inner = dialogInnerWidth(width);
    const [draft, setDraft] = useState(value);

    const items: FilterItem[] = [
        { kind: "failed" },
        { kind: "header", label: "Active state" },
        ...options.active.map(label => ({ kind: "active" as const, label })),
        { kind: "header", label: "Startup (unit file state)" },
        ...options.file.map(label => ({ kind: "file" as const, label })),
    ];
    const selectable = items.flatMap((item, i) => (item.kind === "header" ? [] : [i]));
    const [cursorState, setCursor] = useState(selectable[0] ?? 0);
    const cursor = selectable.includes(cursorState) ? cursorState : selectable[0] ?? 0;

    // Border, title, a blank line, the list, a blank line, the key line.
    const rows = Math.max(3, Math.min(items.length, area.height - 7));
    let top = Math.max(0, Math.min(cursor - Math.floor(rows / 2), items.length - rows));
    if (cursor < top)
        top = cursor;

    const move = (step: number) => {
        const at = Math.max(0, selectable.indexOf(cursor));
        const next = Math.max(0, Math.min(selectable.length - 1, at + step));
        setCursor(selectable[next] ?? cursor);
    };

    const onKey: KeyHandler = (input, key) => {
        if (key.upArrow || input === "k") { move(-1); return true }
        if (key.downArrow || input === "j") { move(1); return true }
        if (key.pageUp) { move(-rows); return true }
        if (key.pageDown) { move(rows); return true }
        if (key.home) { move(-selectable.length); return true }
        if (key.end) { move(selectable.length); return true }
        if (input === " ") {
            const item = items[cursor];
            if (item)
                setDraft(previous => toggled(previous, item));
            return true;
        }
        if (input === "c") {
            setDraft({ failedOnly: false, active: [], file: [] });
            return true;
        }
        if (key.return) {
            onApply(draft);
            return true;
        }
        return false;
    };

    return (
        <Dialog title="Filter units" width={width} onCancel={onCancel} onKey={onKey}
                hints={[["space", "toggle"], ["enter", "apply"], ["c", "clear"], ["esc", "cancel"]]}>
            <Box flexDirection="column" marginTop={1}>
                {items.slice(top, top + rows).map((item, i) => {
                    const index = top + i;
                    if (item.kind === "header")
                        return <Text key={index} bold color={colors.dim} wrap="truncate">{fit(item.label, inner)}</Text>;
                    const selected = index === cursor;
                    const label = item.kind === "failed" ? "Failed units only" : item.label;
                    const box = checked(draft, item) ? "[x]" : "[ ]";
                    const indent = item.kind === "failed" ? "" : "  ";
                    return (
                        <Text key={index} inverse={selected} wrap="truncate">
                            {fit(`${selected ? glyphs.pointer : " "}${indent}${box} ${label}`, inner)}
                        </Text>
                    );
                })}
            </Box>
            <Box marginTop={1}>
                <Text color={colors.dim} wrap="truncate">[Space] toggle [Enter] apply [c] clear [Esc] cancel</Text>
            </Box>
        </Dialog>
    );
}

// ---- actions -------------------------------------------------------------------------

export interface ActionRequest {
    readonly action: ActionId;
    readonly target: ActionTarget;
    /** "Stop and disable crond.service". */
    readonly title: string;
    /** "Stopping and disabling crond.service", while it runs. */
    readonly progress: string;
    /** What will happen, in words: asked before anything is done. Raw host text. */
    readonly question: string;
    /** The running units a stop or restart takes along, named after the question. */
    readonly dependents: { readonly verb: string, readonly names: readonly string[] } | null;
    /** Said last: that systemd reloads its configuration as well. */
    readonly after: string;
    /** The confirming button, e.g. "Stop and disable". */
    readonly confirmLabel: string;
    /** It takes something down: a stop, a mask, a reboot. */
    readonly danger: boolean;
}

/** The longest list of dependents named in full; more are counted. */
const NAMED_DEPENDENTS = 6;

/**
 * The whole question: what happens, the dependents that go with it (the
 * first `named` of them by name, the rest counted), and what follows.
 */
export function questionText(request: ActionRequest, named = NAMED_DEPENDENTS): string {
    let text = request.question;
    const dependents = request.dependents;
    if (dependents && dependents.names.length) {
        const names = dependents.names;
        const shown = Math.max(0, Math.min(named, names.length));
        const rest = names.length - shown;
        const list = shown === 0
            ? `${names.length} unit${names.length === 1 ? "" : "s"}`
            : names.slice(0, shown).join(", ") + (rest > 0 ? ` and ${rest} more` : "");
        text += ` Units that depend on it are ${dependents.verb} as well: ${list}.`;
    }
    return request.after ? `${text} ${request.after}` : text;
}

/**
 * The question as lines that fit: `rows` lines of `columns`. When it is too
 * long, fewer dependents are named; if that is not enough, it is cut short.
 */
export function questionLines(request: ActionRequest, columns: number, rows: number): string[] {
    const width = Math.max(1, columns);
    const most = Math.max(1, rows);
    let lines: string[] = [];
    for (let named = Math.min(NAMED_DEPENDENTS, request.dependents?.names.length ?? 0); named >= 0; named--) {
        lines = wrap(clean(questionText(request, named)), width);
        if (lines.length <= most)
            return lines;
    }
    lines = lines.slice(0, most);
    lines[most - 1] = truncate(`${lines[most - 1] ?? ""} ${glyphs.ellipsis}`, width);
    return lines;
}

/** Lines a dialog has for its text: the border, the title, a blank line, the text, a blank line, the key line. */
function textRows(areaHeight: number): number {
    return Math.max(1, areaHeight - 6);
}

/**
 * How long a question is shown before Enter answers it. Keys typed ahead --
 * "/sshd" and Enter, meant for a search that the details view does not
 * have, where "s" opens the start question -- reach the dialog one by one
 * as soon as it is drawn; this keeps such an Enter from answering a
 * question nobody has read. Esc cancels at once.
 */
export const CONFIRM_ARM_MS = 300;

/**
 * Run an action: ask first, saying what will happen, then show progress
 * until every job it queued has finished. Success closes the dialog and says
 * so in the footer; failure stays here, with systemd's reason. Esc while it
 * runs leaves it running in the background; the outcome still reaches the
 * footer.
 */
export function ActionDialog({ owner, request, onClose }: {
    owner: Owner,
    request: ActionRequest,
    onClose: () => void,
}) {
    const area = useArea();
    const width = useDialogWidth(60);
    const { notify } = useStatus();
    const mounted = useMounted();
    const [phase, setPhase] = useState<"confirm" | "running" | "failed">("confirm");
    const [error, setError] = useState<string | null>(null);
    const [armed, setArmed] = useState(false);
    const started = useRef(false);
    const title = clean(request.title);
    const progress = clean(request.progress);
    // Text is wrapped and bounded here: a dialog taller than its area would
    // draw its lines over each other.
    const rows = textRows(area.height);

    useEffect(() => {
        const timer = setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
        return () => clearTimeout(timer);
    }, []);

    const run = () => {
        if (started.current)
            return;
        started.current = true;
        setPhase("running");
        trackAction(owner, request.target, request.action).then(result => {
            const text = clean(result.note ? `${result.message}. ${result.note}` : result.message);
            notify(text, result.note ? "warning" : "success");
            if (mounted())
                onClose();
        }, (failure: unknown) => {
            const text = clean(errorText(failure));
            if (mounted()) {
                setError(text);
                setPhase("failed");
            } else {
                // Sent to the background earlier: the footer is all that is left.
                notify(text, "error");
            }
        });
    };

    if (phase === "confirm") {
        // DialogText wraps to the same inner width, so these lines stay as they are.
        const message = questionLines(request, dialogInnerWidth(width), rows).join("\n");
        // ConfirmDialog's look, with Enter offered only once the question has been up a moment.
        const label = request.confirmLabel;
        return (
            <Dialog title={title} width={width} tone={request.danger ? "error" : "info"}
                    onCancel={onClose} onConfirm={armed ? run : undefined}
                    hints={armed ? [["enter", label.toLowerCase()], ["esc", "cancel"]] : [["esc", "cancel"]]}>
                <DialogText width={width}>{message}</DialogText>
                <Box marginTop={1}>
                    <Buttons confirm={label} armed={armed} />
                </Box>
            </Dialog>
        );
    }

    if (phase === "running") {
        return (
            <Dialog title={title} width={width} tone={request.danger ? "error" : "info"}
                    onCancel={() => {
                        notify(`${progress} continues in the background`, "info");
                        onClose();
                    }}
                    hints={[["esc", "background"]]}>
                <Box marginTop={1}>
                    <Spinner label={`${progress}${glyphs.ellipsis}`} />
                </Box>
                <Box marginTop={1}>
                    <Text color={colors.dim} wrap="truncate">[Esc] continue in the background</Text>
                </Box>
            </Dialog>
        );
    }

    return (
        <Dialog title={title} width={width} tone="error" onCancel={onClose} onConfirm={onClose}
                hints={[["esc", "close"]]}>
            <DialogText width={width} color={colors.error} maxLines={rows}>{error ?? "The action failed."}</DialogText>
            <Box marginTop={1}>
                <Buttons confirm="Close" cancel={null} />
            </Box>
        </Dialog>
    );
}
