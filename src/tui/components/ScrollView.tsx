/*
 * A scrollable block of pre-rendered lines: unit details, a log entry's
 * fields, help text. Lines must already be clean (see text.ts) and should be
 * no wider than `width`; longer ones are truncated, not wrapped, so the
 * scroll arithmetic stays exact.
 */
import { useState } from "react";
import { Box, Text } from "../ink.js";
import { useKeys, Layer, type Hint, type Key } from "../keyboard.js";
import { fit } from "../text.js";
import { colors, glyphs } from "../theme.js";

export interface Line {
    readonly text: string;
    readonly color?: string;
    readonly bold?: boolean;
    readonly dim?: boolean;
}

export type LineLike = string | Line;

export interface ScrollViewProps {
    readonly lines: readonly LineLike[];
    readonly width: number;
    readonly height: number;
    /** Whether arrow/page keys scroll this view. */
    readonly active?: boolean;
    readonly hints?: readonly Hint[];
    /** Open scrolled to the bottom (logs). */
    readonly startAtEnd?: boolean;
}

export function useScroll(total: number, height: number, startAtEnd = false) {
    const [top, setTop] = useState(() => (startAtEnd ? Math.max(0, total - height) : 0));
    const max = Math.max(0, total - height);
    const clamped = Math.min(top, max);
    const handleKey = (_input: string, key: Key): boolean => {
        if (key.upArrow) setTop(Math.max(0, clamped - 1));
        else if (key.downArrow) setTop(Math.min(max, clamped + 1));
        else if (key.pageUp) setTop(Math.max(0, clamped - Math.max(1, height - 1)));
        else if (key.pageDown) setTop(Math.min(max, clamped + Math.max(1, height - 1)));
        else if (key.home) setTop(0);
        else if (key.end) setTop(max);
        else return false;
        return true;
    };
    return { top: clamped, max, handleKey, setTop };
}

export function ScrollView({ lines, width, height, active = true, hints, startAtEnd = false }: ScrollViewProps) {
    const scroll = useScroll(lines.length, height, startAtEnd);
    useKeys(scroll.handleKey, { layer: Layer.page, active, hints: hints ?? [[`${glyphs.updown} PgUp PgDn`, "scroll"]] });

    const shown = lines.slice(scroll.top, scroll.top + height);
    const more = scroll.max > 0;
    const textWidth = more ? Math.max(0, width - 2) : width;

    return (
        <Box flexDirection="row" width={width} height={height}>
            <Box flexDirection="column" width={textWidth} height={height}>
                {shown.map((line, i) => {
                    const l: Line = typeof line === "string" ? { text: line } : line;
                    return (
                        <Text key={scroll.top + i} color={l.dim ? colors.dim : l.color} bold={l.bold} wrap="truncate">
                            {fit(l.text, textWidth)}
                        </Text>
                    );
                })}
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
