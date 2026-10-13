/*
 * A single-line text field.
 *
 * Takes keys at the input layer while focused, so typing never triggers page
 * or global shortcuts; keys it has no use for (arrows up/down, Tab) fall
 * through, which lets a filter field and the list it filters work together.
 *
 * Editing follows readline: Ctrl+A/E home/end, Ctrl+U/K kill to start/end,
 * Ctrl+W kill word. `mask` hides the value for passwords; an empty mask
 * shows nothing at all, the way sudo does.
 */
import { useState } from "react";
import { InkText, Text } from "../ink.js";
import { useKeys, Layer, type Hint } from "../keyboard.js";
import { width as textWidth } from "../text.js";
import { colors, glyphs, palette, styled, unstyledTerminal } from "../theme.js";

export interface TextInputProps {
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly onSubmit?: (value: string) => void;
    readonly onCancel?: () => void;
    /** Whether this field receives keys. */
    readonly focus?: boolean;
    /** Replace each character with this; "" hides the value entirely. */
    readonly mask?: string;
    readonly placeholder?: string;
    /** Columns available, including the cursor cell. */
    readonly width: number;
    readonly hints?: readonly Hint[];
    /** Longest value accepted, in characters. */
    readonly maxLength?: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
    return Array.from(segmenter.segment(text), s => s.segment);
}

/** Keep only what a single-line field can hold: no control characters or newlines. */
function sanitizeInput(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\r\n|\r|\n|\t/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export function TextInput(props: TextInputProps) {
    const { value, onChange, focus = true, mask, placeholder, width } = props;
    const chars = graphemes(value);
    // The cursor counts graphemes, so editing never splits an emoji or accent.
    const [cursorState, setCursor] = useState(chars.length);
    const cursor = Math.min(cursorState, chars.length);

    const limit = props.maxLength;

    const set = (nextChars: string[], nextCursor: number) => {
        // Refuse only growth past the limit: a value that is already too long
        // (set by the caller) can still be shortened.
        if (limit !== undefined && nextChars.length > limit && nextChars.length > chars.length)
            return;
        const next = nextChars.join("");
        setCursor(Math.max(0, Math.min(nextCursor, nextChars.length)));
        if (next !== value)
            onChange(next);
    };

    useKeys((input, key) => {
        if (key.return) {
            props.onSubmit?.(value);
            return true;
        }
        if (key.escape) {
            if (props.onCancel) {
                props.onCancel();
                return true;
            }
            return false;
        }
        if (key.leftArrow) { setCursor(Math.max(0, cursor - 1)); return true }
        if (key.rightArrow) { setCursor(Math.min(chars.length, cursor + 1)); return true }
        if (key.home || (key.ctrl && input === "a")) { setCursor(0); return true }
        if (key.end || (key.ctrl && input === "e")) { setCursor(chars.length); return true }
        if (key.backspace) {
            if (cursor > 0)
                set([...chars.slice(0, cursor - 1), ...chars.slice(cursor)], cursor - 1);
            return true;
        }
        if (key.delete) {
            if (cursor < chars.length)
                set([...chars.slice(0, cursor), ...chars.slice(cursor + 1)], cursor);
            return true;
        }
        if (key.ctrl && input === "u") { set(chars.slice(cursor), 0); return true }
        if (key.ctrl && input === "k") { set(chars.slice(0, cursor), cursor); return true }
        if (key.ctrl && input === "w") {
            let start = cursor;
            while (start > 0 && chars[start - 1] === " ") start--;
            while (start > 0 && chars[start - 1] !== " ") start--;
            set([...chars.slice(0, start), ...chars.slice(cursor)], start);
            return true;
        }
        if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown)
            return false;
        const text = sanitizeInput(input);
        if (text) {
            // A paste longer than the room left keeps what fits.
            const room = limit === undefined ? Infinity : Math.max(0, limit - chars.length);
            const inserted = graphemes(text).slice(0, room);
            if (inserted.length)
                set([...chars.slice(0, cursor), ...inserted, ...chars.slice(cursor)], cursor + inserted.length);
            return true;
        }
        return false;
    }, { layer: Layer.input, active: focus, hints: props.hints ?? [] });

    if (width <= 0)
        return null;

    if (styled)
        return <Entry {...props} chars={chars} cursor={cursor} />;

    if (!value && placeholder && !focus)
        return <Text color={colors.dim} wrap="truncate">{placeholder}</Text>;

    const shown = mask === undefined ? chars : mask === "" ? [] : chars.map(() => mask);
    const shownCursor = mask === "" ? 0 : cursor;

    if (!focus)
        return <Text wrap="truncate">{shown.join("")}</Text>;

    // Scroll horizontally so the cursor cell stays in view.
    let start = 0;
    const widthOf = (from: number, to: number) => textWidth(shown.slice(from, to).join(""));
    while (start < shownCursor && widthOf(start, shownCursor) + 1 > width)
        start++;
    let end = shownCursor;
    while (end < shown.length && widthOf(start, end + 1) + (end + 1 === shown.length ? 1 : 0) <= width)
        end++;

    const before = shown.slice(start, shownCursor).join("");
    const atCursor = shown[shownCursor] ?? " ";
    const after = shown.slice(shownCursor + 1, Math.max(shownCursor + 1, end)).join("");

    // Without any styling (TERM=dumb, FORCE_COLOR=0) inverse video is gone
    // too: mark the cursor with a glyph so the field is visibly focused.
    if (unstyledTerminal) {
        return <Text wrap="truncate">{before}{glyphs.cursor}{atCursor === " " ? "" : atCursor}{after}</Text>;
    }

    if (!value && placeholder) {
        return (
            <Text wrap="truncate">
                <Text inverse>{placeholder.slice(0, 1) || " "}</Text>
                <Text color={colors.dim}>{placeholder.slice(1)}</Text>
            </Text>
        );
    }

    return (
        <Text wrap="truncate">
            {before}
            <Text inverse>{atCursor}</Text>
            {after}
        </Text>
    );
}

/**
 * The field as newt draws an entry: light on blue across its whole width, the
 * unused part filled with underscores, so a field shows where it is and how
 * long it is even when empty. The cursor is the one cell in the window's own
 * colours.
 */
function Entry({ chars, cursor, focus = true, mask, placeholder, width }: TextInputProps & { chars: string[], cursor: number }) {
    const entry = { color: palette.entry.fg, backgroundColor: palette.entry.bg };
    const shown = mask === undefined ? chars : mask === "" ? [] : chars.map(() => mask);
    const at = !focus ? 0 : mask === "" ? 0 : cursor;
    const widthOf = (from: number, to: number) => textWidth(shown.slice(from, to).join(""));

    // Scroll horizontally so the cursor cell stays in view.
    let start = 0;
    while (start < at && widthOf(start, at) + 1 > width)
        start++;
    let end = Math.max(start, at);
    while (end < shown.length && widthOf(start, end + 1) <= width)
        end++;

    const fill = (used: number) => "_".repeat(Math.max(0, width - used));
    if (!focus) {
        const text = shown.slice(start, end).join("");
        return shown.length === 0 && placeholder
            ? <InkText {...entry} wrap="truncate">{placeholder.slice(0, width)}{fill(textWidth(placeholder))}</InkText>
            : <InkText {...entry} wrap="truncate">{text}{fill(textWidth(text))}</InkText>;
    }

    const before = shown.slice(start, at).join("");
    const empty = shown.length === 0 && placeholder ? placeholder : "";
    const atCursor = shown[at] ?? (empty.slice(0, 1) || " ");
    const after = empty ? empty.slice(1, width) : shown.slice(at + 1, Math.max(at + 1, end)).join("");
    const used = textWidth(before) + textWidth(atCursor) + textWidth(after);
    return (
        <InkText {...entry} wrap="truncate">
            {before}
            <InkText color={palette.window.fg} backgroundColor={palette.window.bg}>{atCursor}</InkText>
            {after}
            {fill(used)}
        </InkText>
    );
}
