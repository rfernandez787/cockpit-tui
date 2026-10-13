/*
 * Numbers, sizes, rates and durations as the overview shows them.
 *
 * Deliberately locale-free (toPrecision/toFixed, never toLocaleString): the
 * page is read on serial consoles and over ssh with whatever LANG happens to
 * be set, and Node's ICU default locale need not match it. Cockpit's own
 * formatters localise the decimal separator, which would make "14.8" read as
 * "14,8" on one terminal and not another; a fixed format is the calmer choice
 * for a dashboard, and it keeps tests deterministic.
 *
 * The shapes follow Cockpit's: three significant digits, sizes in binary
 * units (GiB), rates in decimal units (kB/s), as upstream's usage card and
 * metrics page do.
 */

const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"] as const;
const RATE_UNITS = ["B/s", "kB/s", "MB/s", "GB/s", "TB/s", "PB/s"] as const;

/**
 * Three significant digits without an exponent: 1.21, 14.8, 183, 1000.
 * Integers are shown as they are, like cockpit.format_number().
 */
export function significant(x: number): string {
    if (!Number.isFinite(x))
        return "?";
    if (Number.isInteger(x))
        return String(x);
    if (Math.abs(x) >= 100)
        return x.toFixed(0);
    return x.toPrecision(3);
}

/** Scale `n` into the largest unit it is at least 1 of. */
function scale(n: number, factor: number, units: readonly string[]): { value: number, unit: string, power: number } {
    let power = 0;
    let value = n;
    while (Math.abs(value) >= factor && power < units.length - 1) {
        value /= factor;
        power += 1;
    }
    return { value, unit: units[power]!, power };
}

/** A size in binary units: "7.75 MiB", "4.00 GiB", "512 B". */
export function formatBytes(n: number): string {
    if (!Number.isFinite(n))
        return "?";
    const { value, unit } = scale(n, 1024, BINARY_UNITS);
    return `${significant(value)} ${unit}`;
}

/**
 * "used / total unit" with both numbers in the total's unit, the way the
 * usage card labels memory: "14.8 / 58.5 GiB". Decimals follow the total's
 * magnitude so the two numbers line up and a small `used` reads "0.4", not
 * "0.400".
 */
export function formatBytesPair(used: number, total: number): string {
    if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0)
        return "?";
    const { value, unit, power } = scale(total, 1024, BINARY_UNITS);
    const decimals = power === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
    const usedValue = used / 1024 ** power;
    return `${usedValue.toFixed(decimals)} / ${value.toFixed(decimals)} ${unit}`;
}

/**
 * A rate in decimal units: "90.0 kB/s", "183 kB/s", "1.21 MB/s". Anything
 * below one byte per second is "0 B/s"; that also hides the negative rate a
 * counter reset produces for one sample (upstream metrics.jsx does the same).
 */
export function formatRate(bytesPerSecond: number): string {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 1)
        return "0 B/s";
    const { value, unit } = scale(bytesPerSecond, 1000, RATE_UNITS);
    return `${significant(value)} ${unit}`;
}

/** Uptime the way uptime(1) prints it: "41 min", "3:41", "12 days, 3:41". */
export function formatUptime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0)
        return "";
    const total = Math.floor(seconds / 60);
    const days = Math.floor(total / 1440);
    const hours = Math.floor((total % 1440) / 60);
    const minutes = total % 60;
    const clock = `${hours}:${String(minutes).padStart(2, "0")}`;
    if (days > 0)
        return `${days} day${days === 1 ? "" : "s"}, ${clock}`;
    if (hours > 0)
        return clock;
    return `${minutes} min`;
}

/** How long until something: "in 4 min", "in 1 h 5 min", "in 2 days 3 h". */
export function formatIn(milliseconds: number): string {
    if (!Number.isFinite(milliseconds))
        return "";
    if (milliseconds <= 0)
        return "now";
    const minutes = Math.ceil(milliseconds / 60000);
    if (minutes < 60)
        return `in ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
    const days = Math.floor(hours / 24);
    return `in ${days} day${days === 1 ? "" : "s"}${hours % 24 ? ` ${hours % 24} h` : ""}`;
}

/** "1 unit", "2 units". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
    return `${n} ${n === 1 ? singular : pluralForm}`;
}
