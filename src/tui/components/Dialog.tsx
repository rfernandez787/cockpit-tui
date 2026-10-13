/*
 * Modal dialogs.
 *
 * A dialog floats over its area (the page, or the whole screen for the
 * shell's own dialogs): an absolutely positioned box the size of the area
 * centres it, and the dialog blanks what is beneath it with a fill.
 *
 * Keys: the dialog opens a KeyScope, so its own fields and lists get keys
 * first; then `onKey`; then Esc (cancel) and Enter (confirm); then it traps,
 * so nothing leaks to the page or the shell underneath.
 *
 * Mind where keys are handled. A useKeys() call in the component that
 * *renders* <Dialog> registers outside the dialog's scope and never sees a
 * key while the dialog is open. Handle dialog keys with `onKey`, or in a
 * component rendered as one of the dialog's children.
 *
 * Mind where it is rendered, too. Ink positions an absolute box relative to
 * its parent and paints later siblings over it, so a dialog must be the LAST
 * child of the box that spans its area (the page's root box): anywhere else
 * it is off centre, clipped, or painted over.
 *
 * The dialog never grows past its area: content beyond that is clipped at the
 * bottom, so keep what must stay visible (an input, the buttons line) early,
 * or bound long text with DialogText's maxLines.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { Box, Text } from "../ink.js";
import { Window } from "./Window.js";
import { KeyScope, Layer, useKeys, type Hint, type KeyHandler } from "../keyboard.js";
import { colors, glyphs, severityColor, styled, type Severity } from "../theme.js";
import { truncate, width as textWidth, wrap } from "../text.js";
import { Spinner } from "./Spinner.js";

export interface Area {
    readonly width: number;
    readonly height: number;
}

const AreaContext = createContext<Area>({ width: 80, height: 24 });

/** Declare the size of the region that dialogs inside should centre in. */
export function AreaProvider({ area, children }: { area: Area, children: ReactNode }) {
    return <AreaContext.Provider value={area}>{children}</AreaContext.Provider>;
}

export function useArea(): Area {
    return useContext(AreaContext);
}

export interface DialogProps {
    readonly title: string;
    /** Preferred outer width; shrinks to fit the area. */
    readonly width?: number;
    readonly tone?: Severity;
    readonly children?: ReactNode;
    /** Esc. Omit to make the dialog impossible to dismiss with Esc. */
    readonly onCancel?: () => void;
    /** Enter, when nothing inside the dialog consumed it. */
    readonly onConfirm?: () => void;
    /** Any other key, inside the dialog's scope; return true to consume it. */
    readonly onKey?: KeyHandler;
    readonly hints?: readonly Hint[];
}

/** Inner text width of a dialog of the given outer width (border + padding). */
export function dialogInnerWidth(outer: number): number {
    return Math.max(1, outer - 4);
}

/** The outer width a dialog will actually get in the current area. */
export function useDialogWidth(preferred = 60): number {
    const area = useArea();
    return Math.max(20, Math.min(preferred, area.width - 2));
}

function DialogKeys({ onCancel, onConfirm, onKey, hints }: Pick<DialogProps, "onCancel" | "onConfirm" | "onKey" | "hints">) {
    useKeys((input, key) => {
        if (onKey?.(input, key) === true)
            return true;
        if (key.escape && onCancel) {
            onCancel();
            return true;
        }
        if (key.return && onConfirm) {
            onConfirm();
            return true;
        }
        return true;
    }, {
        layer: Layer.global,
        trap: true,
        hints: hints ?? [
            ...(onConfirm ? [["enter", "confirm"] as const] : []),
            ...(onCancel ? [["esc", "cancel"] as const] : []),
        ],
    });
    return null;
}

export function Dialog(props: DialogProps) {
    const area = useArea();
    const outer = Math.max(20, Math.min(props.width ?? 60, area.width - 2));
    // newt's own colours unless the dialog has something to say: a warning
    // or a destructive question is framed and titled in its colour.
    const tone = props.tone && props.tone !== "info" ? severityColor(props.tone) : undefined;

    return (
        <Box position="absolute" top={0} left={0} width={area.width} height={area.height}
             alignItems="center" justifyContent="center" overflow="hidden">
            <Window title={props.title} width={outer} maxHeight={Math.max(3, area.height)}
                    {...(tone ? { borderColor: tone } : {})}>
                <Box flexDirection="column" flexShrink={1} overflow="hidden">
                    <KeyScope>
                        {props.children}
                        <DialogKeys onCancel={props.onCancel} onConfirm={props.onConfirm} onKey={props.onKey} hints={props.hints} />
                    </KeyScope>
                </Box>
            </Window>
        </Box>
    );
}

/**
 * Wrapped paragraphs, sized to the dialog. With `maxLines`, longer text is
 * cut to that many lines, the last ending in an ellipsis.
 */
export function DialogText({ children, width, color, maxLines }: {
    children: string, width: number, color?: string, maxLines?: number,
}) {
    const inner = dialogInnerWidth(width);
    let lines = wrap(children, inner);
    if (maxLines !== undefined && lines.length > Math.max(1, maxLines)) {
        const keep = Math.max(1, maxLines);
        lines = lines.slice(0, keep);
        lines[keep - 1] = truncate(lines[keep - 1]! + " " + glyphs.ellipsis, inner);
    }
    return (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
            {lines.map((line, i) => (
                <Text key={i} color={color}>{line || " "}</Text>
            ))}
        </Box>
    );
}

/**
 * The row of buttons that ends a dialog, as newt draws them: "< OK >  < Cancel >".
 * Enter presses the first, which is drawn as the one in focus, and Esc the
 * second; the bottom line of the screen says so. Dialogs with more keys than
 * these two spell them out in a line of their own instead.
 */
export function Buttons({ confirm, cancel = "Cancel", armed = true }: {
    confirm?: string,
    /** null for a dialog with nothing to cancel. */
    cancel?: string | null,
    /** false leaves the confirming button's place empty: Enter does nothing yet. */
    armed?: boolean,
}) {
    const first = confirm ? `< ${confirm} >` : "";
    return (
        <Text wrap="truncate">
            {armed ? <Text inverse={styled} bold>{first}</Text> : " ".repeat(textWidth(first))}
            {first && cancel ? "   " : ""}
            {cancel ? `< ${cancel} >` : ""}
        </Text>
    );
}

export interface ConfirmProps {
    readonly title: string;
    readonly message: string;
    /** Label for the confirming action, e.g. "Stop". */
    readonly confirmLabel?: string;
    readonly danger?: boolean;
    readonly busy?: boolean;
    readonly busyText?: string;
    readonly error?: string | null;
    readonly onConfirm: () => void;
    readonly onCancel: () => void;
    readonly width?: number;
    /** Ignore Enter for this long after opening (type-ahead protection). */
    readonly armMs?: number;
}

/** A yes/no question, with room for progress and a failure message. */
export function ConfirmDialog(props: ConfirmProps) {
    const width = useDialogWidth(props.width ?? 56);
    const label = props.confirmLabel ?? "OK";
    // An Enter that arrives within armMs of the question appearing was typed
    // before anyone could have read it (":wq<Enter>" in a shell that turned out
    // to be detached): ignore it rather than take it as the answer.
    const [opened] = useState(() => Date.now());
    const confirm = () => {
        if (Date.now() - opened >= (props.armMs ?? 0))
            props.onConfirm();
    };
    return (
        <Dialog
            title={props.title}
            width={width}
            tone={props.danger ? "error" : "info"}
            onCancel={props.busy ? undefined : props.onCancel}
            onConfirm={props.busy ? undefined : confirm}
            hints={props.busy ? [] : [["enter", label.toLowerCase()], ["esc", "cancel"]]}
        >
            <DialogText width={width}>{props.message}</DialogText>
            {props.error ? <DialogText width={width} color={colors.error}>{props.error}</DialogText> : null}
            <Box marginTop={1}>
                {props.busy
                    ? <Spinner label={props.busyText ?? "Working"} />
                    : <Buttons confirm={label} />}
            </Box>
        </Dialog>
    );
}
