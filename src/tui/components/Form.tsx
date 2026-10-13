/*
 * A form in a dialog: "Create account", "Change host name", "Set time".
 *
 * Fields are controlled by the caller (values live in the caller's state);
 * the form owns only which field has focus. Keys:
 *
 *   ↑ ↓  Tab  Shift+Tab   move between fields (the dialog traps keys, so Tab
 *                         never reaches the shell's page switching here)
 *   Space                 toggle a checkbox
 *   ← →                   change a select (move the cursor in a text field)
 *   Enter                 submit, from any field
 *   Esc                   cancel (not while busy)
 *
 * Validation is the caller's: put a message in a field's `error`, or the
 * form-wide `error` for a failure from the host, and keep the dialog open.
 */
import { useState } from "react";
import { Box, Text } from "../ink.js";
import { Buttons, Dialog, DialogText, dialogInnerWidth, useDialogWidth } from "./Dialog.js";
import { TextInput } from "./TextInput.js";
import { Spinner } from "./Spinner.js";
import type { KeyHandler } from "../keyboard.js";
import { fit, truncate, wrap, width as textWidth } from "../text.js";
import { colors, glyphs, unicode, type Severity } from "../theme.js";

interface FieldBase {
    readonly id: string;
    readonly label: string;
    readonly disabled?: boolean;
    /** A dim line under the field. */
    readonly help?: string;
    /** A red line under the field; the form stays open. */
    readonly error?: string | null;
}

export interface TextField extends FieldBase {
    readonly kind: "text" | "password";
    readonly value: string;
    readonly placeholder?: string;
    readonly maxLength?: number;
}

export interface CheckboxField extends FieldBase {
    readonly kind: "checkbox";
    readonly value: boolean;
}

export interface SelectField extends FieldBase {
    readonly kind: "select";
    readonly value: string;
    readonly options: readonly { readonly value: string, readonly label: string }[];
}

export type FormField = TextField | CheckboxField | SelectField;

export interface FormDialogProps {
    readonly title: string;
    readonly fields: readonly FormField[];
    readonly onChange: (id: string, value: string | boolean) => void;
    readonly onSubmit: () => void;
    readonly onCancel: () => void;
    /** Paragraph above the fields. */
    readonly intro?: string;
    readonly submitLabel?: string;
    readonly busy?: boolean;
    readonly busyText?: string;
    /** A failure from the host, shown above the buttons. */
    readonly error?: string | null;
    readonly width?: number;
    readonly tone?: Severity;
}

export function FormDialog(props: FormDialogProps) {
    const width = useDialogWidth(props.width ?? 64);
    const inner = dialogInnerWidth(width);
    const enabled = props.fields.map((f, i) => (f.disabled ? -1 : i)).filter(i => i >= 0);
    const [focusState, setFocus] = useState(() => enabled[0] ?? -1);
    const focus = enabled.includes(focusState) ? focusState : enabled[0] ?? -1;
    const busy = props.busy ?? false;
    const label = props.submitLabel ?? "OK";

    const labelWidth = Math.min(Math.floor(inner / 2), Math.max(...props.fields.map(f => textWidth(f.label))) + 2);
    const fieldWidth = Math.max(4, inner - labelWidth);

    const move = (step: number) => {
        if (enabled.length === 0)
            return;
        const at = Math.max(0, enabled.indexOf(focus));
        setFocus(enabled[(at + step + enabled.length) % enabled.length]!);
    };

    const onKey: KeyHandler = (input, key) => {
        if (busy)
            return true;
        const field = props.fields[focus];
        if (key.downArrow || (key.tab && !key.shift)) { move(1); return true }
        if (key.upArrow || (key.tab && key.shift)) { move(-1); return true }
        if (key.return) { props.onSubmit(); return true }
        if (!field)
            return false;
        if (field.kind === "checkbox" && input === " ") {
            props.onChange(field.id, !field.value);
            return true;
        }
        if (field.kind === "select" && (key.leftArrow || key.rightArrow || input === " ")) {
            const at = field.options.findIndex(o => o.value === field.value);
            const step = key.leftArrow ? -1 : 1;
            const next = field.options[(at + step + field.options.length) % field.options.length];
            if (next)
                props.onChange(field.id, next.value);
            return true;
        }
        return false;
    };

    return (
        <Dialog
            title={props.title}
            width={width}
            tone={props.tone ?? "info"}
            onCancel={busy ? undefined : props.onCancel}
            onKey={onKey}
            hints={busy ? [] : [[glyphs.updown, "field"], ["enter", label.toLowerCase()], ["esc", "cancel"]]}
        >
            {props.intro ? <DialogText width={width}>{props.intro}</DialogText> : null}
            <Box flexDirection="column" marginTop={1} flexShrink={0}>
                {props.fields.map((field, i) => (
                    <FieldRow key={field.id} field={field} focused={i === focus && !busy}
                              labelWidth={labelWidth} fieldWidth={fieldWidth}
                              onChange={value => props.onChange(field.id, value)}
                              onSubmit={props.onSubmit} />
                ))}
            </Box>
            {props.error ? <DialogText width={width} color={colors.error}>{props.error}</DialogText> : null}
            <Box marginTop={1} flexShrink={0}>
                {busy
                    ? <Spinner label={props.busyText ?? "Working"} />
                    : <Buttons confirm={label} />}
            </Box>
        </Dialog>
    );
}

function FieldRow({ field, focused, labelWidth, fieldWidth, onChange, onSubmit }: {
    field: FormField, focused: boolean, labelWidth: number, fieldWidth: number,
    onChange: (value: string | boolean) => void, onSubmit: () => void,
}) {
    const labelColor = field.disabled ? colors.dim : focused ? colors.accent : undefined;
    const marker = focused ? glyphs.pointer : " ";
    let control;
    switch (field.kind) {
    case "text":
    case "password":
        control = field.disabled
            ? <Text color={colors.dim} wrap="truncate">{field.kind === "password" ? "" : field.value}</Text>
            : (
                <TextInput
                    value={field.value}
                    onChange={value => onChange(value)}
                    onSubmit={onSubmit}
                    focus={focused}
                    width={fieldWidth}
                    {...(field.kind === "password" ? { mask: unicode ? "•" : "*" } : {})}
                    {...(field.placeholder ? { placeholder: field.placeholder } : {})}
                    {...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {})}
                />
            );
        break;
    case "checkbox":
        control = <Text color={field.disabled ? colors.dim : undefined}>{field.value ? "[x]" : "[ ]"}</Text>;
        break;
    case "select": {
        const option = field.options.find(o => o.value === field.value);
        const text = `${focused ? "< " : ""}${option?.label ?? field.value}${focused ? " >" : ""}`;
        control = <Text color={field.disabled ? colors.dim : undefined} wrap="truncate">{truncate(text, fieldWidth)}</Text>;
        break;
    }
    }
    return (
        <Box flexDirection="column" flexShrink={0}>
            <Box>
                <Box width={labelWidth}>
                    <Text color={labelColor} bold={focused} wrap="truncate">{fit(`${marker}${field.label}`, labelWidth)}</Text>
                </Box>
                <Box width={fieldWidth}>{control}</Box>
            </Box>
            {field.error
                ? wrap(field.error, fieldWidth).map((line, i) => (
                    <Box key={`e${i}`} marginLeft={labelWidth}><Text color={colors.error}>{line}</Text></Box>))
                : null}
            {field.help && !field.error
                ? wrap(field.help, fieldWidth).map((line, i) => (
                    <Box key={`h${i}`} marginLeft={labelWidth}><Text color={colors.dim}>{line}</Text></Box>))
                : null}
        </Box>
    );
}
