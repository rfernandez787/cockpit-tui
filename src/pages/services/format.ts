/*
 * Text, times and sizes as the Services page shows them.
 *
 * Dates are the viewer's local time (formatTimestamp), like upstream's,
 * which formats in the browser. Over ssh or ws that zone may not be the
 * host's, so remote sessions get the zone's name appended.
 */
import cockpit from "../../cockpit.js";
import { formatDuration, formatTimestamp, truncate, wrap } from "../../tui/text.js";
import { glyphs } from "../../tui/theme.js";
import { clean } from "../../lib/hosttext.js";

export { clean };

/** Text ending as a sentence: a period added unless it already ends in one (systemd's errors usually do). */
export function sentence(text: string): string {
    const trimmed = text.trimEnd();
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Clean text wrapped to `columns`, at most `rows` lines, as one string with
 * line breaks: for Notice and DialogText, which wrap but do not clip (lines
 * past their box are drawn over each other). Text that does not fit ends in
 * an ellipsis; a `tail` (what to do about it, "Press Esc to go back.") is
 * kept whole after it.
 */
export function fitText(text: string, columns: number, rows: number, tail = ""): string {
    const width = Math.max(1, columns);
    const all = wrap(tail ? `${text} ${tail}` : text, width);
    if (all.length <= Math.max(1, rows))
        return all.join("\n");
    const tailLines = tail ? wrap(tail, width) : [];
    const room = Math.max(1, rows - tailLines.length);
    const head = wrap(text, width).slice(0, room);
    head[room - 1] = truncate(`${head[room - 1] ?? ""} ${glyphs.ellipsis}`, width);
    return [...head, ...tailLines].slice(0, Math.max(1, rows)).join("\n");
}

/** "in 23 minutes", "2 hours ago", "now". */
export function relativeTime(ms: number, now: number): string {
    const seconds = Math.round((ms - now) / 1000);
    if (Math.abs(seconds) < 5)
        return "now";
    const span = formatDuration(Math.abs(seconds));
    return seconds > 0 ? `in ${span}` : `${span} ago`;
}

/** The local time zone's short name ("MDT"), or "" if the runtime cannot say. */
export function zoneName(at: number = Date.now()): string {
    try {
        return new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
            .formatToParts(new Date(at)).find(part => part.type === "timeZoneName")?.value ?? "";
    } catch {
        return "";
    }
}

/** "2026-10-02 18:30:00 (in 23 minutes)", with the zone when it may not be the host's. */
export function describeTime(ms: number, now: number, options: { zone?: boolean, seconds?: boolean } = {}): string {
    const zone = options.zone ? zoneName(ms) : "";
    return `${formatTimestamp(ms, options.seconds ?? true)}${zone ? " " + zone : ""} (${relativeTime(ms, now)})`;
}

/** Bytes as upstream shows them (cockpit.format_bytes: "1.28 MB"). */
export function formatBytes(bytes: number): string {
    return cockpit.format_bytes(bytes);
}
