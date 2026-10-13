/*
 * A horizontal usage bar: "[█████░░░░░]". The numbers belong next to it in
 * text, since the bar alone means nothing without colour or Unicode.
 */
import { Text } from "../ink.js";
import { colors, glyphs } from "../theme.js";

export interface MeterProps {
    /** 0..1; values outside are clamped, null draws an empty, dim bar. */
    readonly fraction: number | null;
    /** Total width including the brackets. */
    readonly width: number;
    /** Fractions at or above these turn the bar yellow / red. */
    readonly warnAt?: number;
    readonly dangerAt?: number;
}

export function meterBar(fraction: number | null, width: number): { filled: number, empty: number } {
    const inner = Math.max(0, width - 2);
    if (fraction === null || !Number.isFinite(fraction))
        return { filled: 0, empty: inner };
    const clamped = Math.max(0, Math.min(1, fraction));
    // Round, but never show a full bar for less than 100% or an empty one for more than 0%.
    let filled = Math.round(clamped * inner);
    if (clamped > 0 && filled === 0)
        filled = 1;
    if (clamped < 1 && filled === inner && inner > 0)
        filled = inner - 1;
    return { filled, empty: inner - filled };
}

export function Meter({ fraction, width, warnAt = 0.8, dangerAt = 0.95 }: MeterProps) {
    if (width < 3)
        return null;
    const { filled, empty } = meterBar(fraction, width);
    const color = fraction === null
        ? colors.dim
        : fraction >= dangerAt ? colors.error : fraction >= warnAt ? colors.warning : colors.ok;
    return (
        <Text>
            [<Text color={color}>{glyphs.barFull.repeat(filled)}</Text>
            <Text color={colors.dim}>{glyphs.barEmpty.repeat(empty)}</Text>]
        </Text>
    );
}
