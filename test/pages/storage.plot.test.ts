/*
 * The storage plots' pure half (plot.ts): the scale and its unit, the rows
 * of blocks, and rates as text.
 */
import { describe, it, expect } from "vitest";
import { formatRate, inUnit, MIN_SCALE, plotRows, plotScale, xLabels, yLabels } from "../../src/lib/plot.js";

const MIB = 1024 * 1024;

describe("the scale", () => {
    it("is never below 1 MiB/s, and otherwise makes every row a round step up to the peak or past it", () => {
        expect(plotScale([])).toEqual({ max: MIB, step: MIB, unit: MIB, unitName: "MiB/s" });
        expect(plotScale([0, 300, 5000]).max).toBe(MIN_SCALE);
        expect(plotScale([1.2 * MIB]).max).toBe(2 * MIB);
        expect(plotScale([3 * MIB]).max).toBe(5 * MIB);
        // Four rows: steps of 10 reach 40 for a peak of 34, as upstream's axis does.
        expect(plotScale([34 * MIB], 4)).toMatchObject({ max: 40 * MIB, step: 10 * MIB });
        expect(plotScale([17 * MIB], 4)).toMatchObject({ max: 20 * MIB, step: 5 * MIB });
        expect(plotScale([81 * MIB, 2 * MIB], 4)).toMatchObject({ max: 100 * MIB, step: 25 * MIB });
        expect(plotScale([7 * MIB], 3)).toMatchObject({ max: 7.5 * MIB, step: 2.5 * MIB });
        expect(plotScale([640 * MIB], 2)).toMatchObject({ max: 1000 * MIB, step: 500 * MIB });
        // An idle disk on four rows: quarters of a MiB/s.
        expect(plotScale([100], 4)).toMatchObject({ max: MIB, step: 0.25 * MIB });
        expect(plotScale([100], 3)).toMatchObject({ max: 1.5 * MIB, step: 0.5 * MIB });
    });

    it("counts in GiB/s once the peak is there, and ignores what is not a number", () => {
        expect(plotScale([1500 * MIB])).toMatchObject({ max: 2 * 1024 * MIB, unit: 1024 * MIB, unitName: "GiB/s" });
        expect(plotScale([Number.NaN, Number.POSITIVE_INFINITY, 3 * MIB]).max).toBe(5 * MIB);
    });

    it("numbers the rows down the left: the rate at the top of each", () => {
        expect(yLabels(plotScale([34 * MIB], 4), 4)).toEqual(["40", "30", "20", "10"]);
        expect(yLabels(plotScale([17 * MIB], 4), 4)).toEqual(["20", "15", "10", "5"]);
        expect(yLabels(plotScale([7 * MIB], 3), 3)).toEqual(["7.5", "5", "2.5"]);
        expect(yLabels(plotScale([], 4), 4)).toEqual(["1", "0.75", "0.5", "0.25"]);
        expect(yLabels(plotScale([], 2), 2)).toEqual(["1", "0.5"]);
        expect(yLabels(plotScale([1500 * MIB], 2), 2)).toEqual(["2", "1"]);
    });

    it("writes rates in the scale's unit", () => {
        const scale = plotScale([37 * MIB], 4);
        expect(inUnit(scale.max, scale)).toBe("40.0");
        expect(inUnit(0, scale)).toBe("0");
        expect(inUnit(12.34 * MIB, scale)).toBe("12.3");
        expect(inUnit(0.5 * MIB, scale)).toBe("0.50");
        expect(inUnit(250 * MIB, scale)).toBe("250");
        expect(inUnit(100, scale)).toBe("<0.01");
    });
});

describe("the times along the foot", () => {
    // Local times, as the viewer's clock shows them.
    const at = (h: number, m: number, sec: number) => new Date(2026, 9, 3, h, m, sec).getTime();
    const every2s = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i * 2000);

    it("writes the time where each minute's first sample is, and nothing else", () => {
        // 16:23:50, :52, ... : the sixth sample is the first of 16:24, the 36th of 16:25.
        const times = every2s(at(16, 23, 50), 40);
        const line = xLabels(times, 40);
        expect(line).toHaveLength(40);
        expect(line.indexOf("16:24")).toBe(5);
        expect(line.indexOf("16:25")).toBe(35);
        expect(line.replace(/16:2[45]/g, "").trim()).toBe("");
    });

    it("lines up with a plot that is not full yet, and with one that shows only the newest samples", () => {
        // 09:59:56, :58, 10:00:00, ...: the third sample is the first of 10:00.
        const times = every2s(at(9, 59, 56), 8);
        expect(xLabels(times, 8).indexOf("10:00")).toBe(2);
        // Right-aligned like the samples: four blank columns first.
        expect(xLabels(times, 12).indexOf("10:00")).toBe(6);
        const long = every2s(at(9, 58, 0), 100);
        // Only the last 40 are shown: 09:59 began before them, 10:00 is the first of them.
        const tail = xLabels(long, 40);
        expect(tail).not.toContain("09:59");
        expect(tail.indexOf("10:00")).toBe(0);
        expect(tail.indexOf("10:01")).toBe(30);
    });

    it("leaves out a label that would run into the one before it or off the end", () => {
        // A new minute every two columns: 12:01 is written, the next ones have no room, the last would not fit.
        const crowded = Array.from({ length: 12 }, (_, i) => at(12, Math.floor(i / 2), (i % 2) * 30));
        expect(xLabels(crowded, 12)).toBe("  12:01     ");
        // Too near the right edge to fit.
        expect(xLabels(every2s(at(8, 59, 54), 4), 4).trim()).toBe("");
        expect(xLabels([], 5)).toBe("     ");
        expect(xLabels(every2s(at(8, 0, 0), 3), 0)).toBe("");
    });
});

describe("the rows", () => {
    // A plot whose top is 8 MiB/s, whatever its rows.
    const scale = { max: 8 * MIB, step: 8 * MIB, unit: MIB, unitName: "MiB/s" };

    it("puts the newest sample at the right, blank where there is none yet, each row as wide as asked", () => {
        const rows = plotRows([8 * MIB, 4 * MIB], 6, 2, scale, false);
        expect(rows).toEqual(["    █ ", "    ██"]);
        expect(plotRows([], 4, 3, scale, false)).toEqual(["    ", "    ", "    "]);
    });

    it("has eight levels per cell, and shows any activity at all as the lowest", () => {
        const [row] = plotRows([0, 1, 1 * MIB, 2 * MIB, 3 * MIB, 4 * MIB, 5 * MIB, 6 * MIB, 7 * MIB, 8 * MIB, 99 * MIB], 11, 1, scale, false);
        expect(row).toBe(" ▁▁▂▃▄▅▆▇██");
    });

    it("keeps only the samples that fit", () => {
        const samples = Array.from({ length: 50 }, (_, i) => (i % 2 ? 8 * MIB : 0));
        expect(plotRows(samples, 4, 1, scale, false)).toEqual([" █ █"]);
        expect(plotRows(samples, 0, 2, scale, false)).toEqual(["", ""]);
    });

    it("stacks rows: a full lower row under a partly filled upper one", () => {
        expect(plotRows([6 * MIB], 1, 2, scale, false)).toEqual(["▄", "█"]);
        expect(plotRows([2 * MIB], 1, 2, scale, false)).toEqual([" ", "▄"]);
    });

    it("draws with ASCII where there is no Unicode", () => {
        const [row] = plotRows([0, 1, 2 * MIB, 4 * MIB, 6 * MIB, 8 * MIB], 6, 1, scale, true);
        expect(row).toBe(" ..:|#");
        expect(/^[\x20-\x7e]*$/.test(plotRows([3 * MIB, 8 * MIB], 5, 3, scale, true).join(""))).toBe(true);
    });
});

describe("rates as text", () => {
    it("picks the unit by size", () => {
        expect(formatRate(0)).toBe("0 B/s");
        expect(formatRate(900)).toBe("900 B/s");
        expect(formatRate(640 * 1024)).toBe("640 KiB/s");
        expect(formatRate(3.24 * MIB)).toBe("3.2 MiB/s");
        expect(formatRate(250 * MIB)).toBe("250 MiB/s");
        expect(formatRate(1536 * MIB)).toBe("1.50 GiB/s");
        expect(formatRate(Number.NaN)).toBe("?");
        expect(formatRate(-1)).toBe("?");
    });
});
