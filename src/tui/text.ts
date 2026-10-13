/*
 * Measuring, fitting and cleaning text for a fixed-width grid.
 *
 * Widths are terminal columns, not string lengths: CJK and emoji take two,
 * combining marks take none. Measurement goes through string-width, the same
 * library Ink lays out with, so our padding and Ink's layout always agree.
 *
 * Everything shown on screen that came from the managed host -- journal
 * messages, unit descriptions, user names, file contents -- must pass
 * through clean() first. Ink writes text to the terminal verbatim, so a log
 * line containing an escape sequence could otherwise clear the screen, move
 * the cursor, retitle the window or write the clipboard (OSC 52).
 */
import stringWidth from "string-width";
import { glyphs, unicode } from "./theme.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function width(text: string): number {
    return stringWidth(text);
}

/**
 * Make untrusted text safe and single-line.
 *
 * C0 controls, DEL and C1 controls become caret/hex notation so they stay
 * visible without being interpreted; bidi controls are dropped. Tabs become a space and line breaks a
 * visible return glyph; use cleanLines() to keep line structure instead.
 */
/** Unicode bidirectional controls: marks, embeddings, overrides and isolates. */
const BIDI_CONTROLS = new Set([0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);

export function clean(text: string): string {
    let out = "";
    for (const char of text) {
        const code = char.codePointAt(0)!;
        if (code === 0x09)
            out += " ";
        else if (code === 0x0a)
            out += unicode ? "⏎" : " ";
        else if (code === 0x0d)
            continue;
        else if (code < 0x20)
            out += "^" + String.fromCharCode(code + 64);
        else if (code === 0x7f)
            out += "^?";
        else if (code >= 0x80 && code <= 0x9f)
            out += `\\x${code.toString(16)}`;
        else if (BIDI_CONTROLS.has(code))
            continue; // would reorder what follows on screen ("Trojan Source")
        else
            out += char;
    }
    return out;
}

/** Clean text but keep its lines, for multi-line views. */
export function cleanLines(text: string): string[] {
    return text.replace(/\r\n/g, "\n").split("\n").map(line => clean(line));
}

/** Clean multi-line text into a single string that keeps its line breaks. */
export function cleanBlock(text: string): string {
    return cleanLines(text).join("\n");
}

/** Fit text into `columns`, ending in an ellipsis when it had to be cut. */
export function truncate(text: string, columns: number): string {
    if (columns <= 0)
        return "";
    if (stringWidth(text) <= columns)
        return text;
    const ellipsis = glyphs.ellipsis;
    const ellipsisWidth = stringWidth(ellipsis);
    if (columns <= ellipsisWidth)
        return ellipsis.slice(0, columns);
    let out = "";
    let used = 0;
    for (const { segment } of segmenter.segment(text)) {
        const w = stringWidth(segment);
        if (used + w > columns - ellipsisWidth)
            break;
        out += segment;
        used += w;
    }
    return out + ellipsis;
}

/** Truncate or pad to exactly `columns`. */
export function fit(text: string, columns: number, align: "left" | "right" = "left"): string {
    if (columns <= 0)
        return "";
    const fitted = truncate(text, columns);
    const gap = Math.max(0, columns - stringWidth(fitted));
    return align === "right" ? " ".repeat(gap) + fitted : fitted + " ".repeat(gap);
}

/**
 * Word-wrap to `columns`, hard-breaking words longer than a line.
 * Existing line breaks are kept. Input should already be clean().
 */
export function wrap(text: string, columns: number): string[] {
    if (columns <= 0)
        return [];
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
        let line = "";
        let lineWidth = 0;
        for (const word of paragraph.split(/(\s+)/)) {
            if (word === "")
                continue;
            const wordWidth = stringWidth(word);
            if (/^\s+$/.test(word)) {
                if (lineWidth > 0 && lineWidth + wordWidth <= columns) {
                    line += word;
                    lineWidth += wordWidth;
                }
                continue;
            }
            if (lineWidth + wordWidth <= columns) {
                line += word;
                lineWidth += wordWidth;
                continue;
            }
            if (lineWidth > 0) {
                lines.push(line.trimEnd());
                line = "";
                lineWidth = 0;
            }
            if (wordWidth <= columns) {
                line = word;
                lineWidth = wordWidth;
                continue;
            }
            for (const { segment } of segmenter.segment(word)) {
                const w = stringWidth(segment);
                if (lineWidth + w > columns) {
                    lines.push(line);
                    line = "";
                    lineWidth = 0;
                }
                line += segment;
                lineWidth += w;
            }
        }
        lines.push(line.trimEnd());
    }
    return lines;
}

/** "3 days", "5 hours": coarse durations for uptime and "since" columns. */
export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0)
        return "";
    const units: [number, string][] = [[86400, "day"], [3600, "hour"], [60, "minute"], [1, "second"]];
    for (const [size, name] of units) {
        if (seconds >= size || size === 1) {
            const n = Math.floor(seconds / size);
            return `${n} ${name}${n === 1 ? "" : "s"}`;
        }
    }
    return "";
}

/** Local "YYYY-MM-DD HH:MM:SS" for a Date or milliseconds since the epoch. */
export function formatTimestamp(when: Date | number, withSeconds = true): string {
    const date = typeof when === "number" ? new Date(when) : when;
    if (Number.isNaN(date.getTime()))
        return "";
    const p = (n: number) => String(n).padStart(2, "0");
    const day = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
    const time = `${p(date.getHours())}:${p(date.getMinutes())}` + (withSeconds ? `:${p(date.getSeconds())}` : "");
    return `${day} ${time}`;
}
