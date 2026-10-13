/*
 * Throughput plots in character cells: the pure half. Shared by Storage
 * ("MiB/s Reading", "MiB/s Writing"; upstream's pkg/storaged/plot.jsx) and
 * Networking ("Sending", "Receiving"; pkg/networkmanager/plots.js), cockpit 356.
 *
 * A plot is a few rows of block characters, one column per sample, the
 * newest at the right. Each cell has eight levels (▁▂▃▄▅▆▇█), so four rows
 * tell 32 heights apart; without Unicode there are four levels per cell
 * (. : | #). The scale is the largest sample on show, rounded up so that
 * every row of the plot is a round step (the numbers down its left side),
 * and never less than a floor -- upstream's plots do not zoom in on an idle
 * disk's noise either. The unit follows the scale and is in the plot's
 * title, as upstream writes it. Under the plot, the time of day at every
 * minute that began within it.
 *
 * Samples are in a base unit per second: bytes for disks (MiB/s, GiB/s),
 * bits for the network (Kbps, Mbps, Gbps), as upstream shows each.
 */

const KIB = 1024;
const MIB = 1024 * 1024;

/** The least a plot's scale goes down to, in bytes per second. */
export const MIN_SCALE = MIB;

export interface Scale {
    /** Bytes per second at the top of the plot. */
    readonly max: number;
    /** Bytes per second that one row of the plot spans: the step between the numbers on its axis. */
    readonly step: number;
    /** What one unit is, in bytes per second, and its name. */
    readonly unit: number;
    readonly unitName: string;
}

/** A round step at or above `value`: 1, 2, 2.5 or 5 times a power of ten. */
function roundStep(value: number): number {
    const power = 10 ** Math.floor(Math.log10(value));
    for (const step of [1, 2, 2.5, 5]) {
        // (A hair of tolerance: 0.25 is not exactly 2.5 * 10^-1 in floating point.)
        if (step * power >= value * (1 - 1e-9))
            return step * power;
    }
    return 10 * power;
}

/** The units a plot may count in, smallest first: [what one is in the base unit per second, its name]. */
export type Units = readonly (readonly [number, string])[];

/** Disk throughput, in bytes per second. */
export const BYTE_UNITS: Units = [[MIB, "MiB/s"], [1024 * MIB, "GiB/s"]];
/** Network throughput, in bits per second: decimal, as link speeds are. */
export const BIT_UNITS: Units = [[1e3, "Kbps"], [1e6, "Mbps"], [1e9, "Gbps"]];

/**
 * The scale for these samples on a plot `rows` high: each row a round step,
 * the top at or above the largest sample (and at or above `floor`), in the
 * largest unit the top reaches.
 */
export function plotScale(samples: readonly number[], rows = 1, units: Units = BYTE_UNITS,
                          floor: number = units === BYTE_UNITS ? MIN_SCALE : units[0]![0] * 100): Scale {
    const peak = Math.max(floor, ...samples.filter(v => Number.isFinite(v)));
    const [unit, unitName] = [...units].reverse().find(([size]) => peak >= size) ?? units[0]!;
    const count = Math.max(1, rows);
    const step = roundStep(peak / unit / count) * unit;
    return { max: step * count, step, unit, unitName };
}

/** A number on the axis: "40", "2.5", "0.25". */
function tick(value: number): string {
    return String(Number(value.toPrecision(3)));
}

/** The numbers down the plot's left side, top first: the value at the top of each row. */
export function yLabels(scale: Scale, rows: number): string[] {
    const count = Math.max(1, rows);
    return Array.from({ length: count }, (_, i) => tick(scale.step * (count - i) / scale.unit));
}

function clock(ms: number): string {
    const date = new Date(ms);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * The line under the plot, `width` columns like its rows: "16:24" starting
 * at the column of the first sample of each minute. `times` are the samples'
 * own (milliseconds, the viewer's clock), aligned with the plot's samples;
 * a label that would run into the one before it, or off the end, is left out.
 */
export function xLabels(times: readonly number[], width: number): string {
    const columns = Math.max(0, width);
    const shown = columns > 0 ? times.slice(-columns) : [];
    const pad = columns - shown.length;
    const cells = Array.from({ length: columns }, () => " ");
    let free = 0;
    shown.forEach((time, i) => {
        const before = i > 0 ? shown[i - 1]! : times[times.length - shown.length - 1];
        if (before === undefined || Math.floor(before / 60_000) === Math.floor(time / 60_000))
            return;
        const at = pad + i;
        const label = clock(time);
        if (at < free || at + label.length > columns)
            return;
        [...label].forEach((char, j) => { cells[at + j] = char });
        // A space before the next one.
        free = at + label.length + 1;
    });
    return cells.join("");
}

/** "12.3", "0.5", "120": a rate in the scale's unit, as the plot's note and axis write it. */
export function inUnit(bytesPerSecond: number, scale: Scale): string {
    const value = bytesPerSecond / scale.unit;
    if (value === 0)
        return "0";
    if (value >= 100)
        return value.toFixed(0);
    if (value >= 10)
        return value.toFixed(1);
    return value >= 0.005 ? value.toFixed(2) : "<0.01";
}

/** A rate with a unit of its own, for one line without a plot: "3.2 MiB/s", "640 KiB/s". */
export function formatRate(bytesPerSecond: number): string {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0)
        return "?";
    if (bytesPerSecond >= 1024 * MIB)
        return `${(bytesPerSecond / (1024 * MIB)).toFixed(2)} GiB/s`;
    if (bytesPerSecond >= MIB)
        return `${(bytesPerSecond / MIB).toFixed(bytesPerSecond >= 100 * MIB ? 0 : 1)} MiB/s`;
    if (bytesPerSecond >= KIB)
        return `${(bytesPerSecond / KIB).toFixed(0)} KiB/s`;
    return `${bytesPerSecond.toFixed(0)} B/s`;
}

const BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const ASCII = [" ", ".", ":", "|", "#"];

/**
 * The plot's rows, top first, each exactly `width` columns: the last `width`
 * samples, the newest at the right, blank where there is no sample yet. Any
 * sample above zero shows at least the lowest level, so activity is never
 * rounded away to nothing.
 */
export function plotRows(samples: readonly number[], width: number, height: number, scale: Scale, ascii: boolean): string[] {
    const levels = ascii ? ASCII : BLOCKS;
    const perCell = levels.length - 1;
    const columns = Math.max(0, width);
    // (slice(-0) would be every sample.)
    const shown = columns > 0 ? samples.slice(-columns) : [];
    const pad = columns - shown.length;
    const heights = shown.map(value => {
        if (!Number.isFinite(value) || value <= 0)
            return 0;
        const steps = Math.round(Math.min(1, value / scale.max) * height * perCell);
        return Math.max(1, steps);
    });
    const rows: string[] = [];
    for (let row = height - 1; row >= 0; row--) {
        let line = " ".repeat(pad);
        for (const steps of heights)
            line += levels[Math.max(0, Math.min(perCell, steps - row * perCell))];
        rows.push(line);
    }
    return rows;
}
