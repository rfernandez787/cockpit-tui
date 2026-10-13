/*
 * Panels: the sub-windows a page frames its content in, and the line-built
 * ones of the overview.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Box, Text } from "../../src/tui/ink.js";
import { Panel, PANEL_MIN_COLUMNS, PANEL_MIN_ROWS, panelBottom, panelled, panelTop, setPanels } from "../../src/tui/components/Panel.js";
import { panelLines, twoPanels, type Cell } from "../../src/pages/overview/layout.js";
import { frame } from "../../src/tui/theme.js";
import { width as textWidth } from "../../src/tui/text.js";
import { cleanup, renderInk } from "../helpers/ink.js";

afterEach(() => {
    cleanup();
    setPanels(true);
});

const { topLeft: TL, topRight: TR, bottomLeft: BL, bottomRight: BR, horizontal: H, vertical: V, titleLeft: L, titleRight: R } = frame;

describe("a panel's border", () => {
    it("carries the title at the left and the detail at the right, always exactly as wide as asked", () => {
        expect(panelTop("Usage", 30, "updating").join("")).toBe(`${TL}${H}${L} Usage ${R}${H.repeat(7)} updating ${H}${TR}`);
        expect(panelTop("Usage", 30).join("")).toBe(`${TL}${H}${L} Usage ${R}${H.repeat(18)}${TR}`);
        for (let width = 2; width <= 40; width++) {
            expect(textWidth(panelTop("System information", width, "h host name").join("")), `${width} columns`).toBe(width);
            expect(textWidth(panelBottom(width))).toBe(width);
        }
    });

    it("gives up the detail first, then cuts the title, then drops it", () => {
        expect(panelTop("Configuration", 24, "h host name, t time").join("")).toBe(`${TL}${H}${L} Configuration ${R}${H.repeat(4)}${TR}`);
        expect(panelTop("Configuration", 14)[1]).toMatch(/^Conf/);
        expect(panelTop("Configuration", 14)[1]).not.toBe("Configuration");
        expect(panelTop("Configuration", 8).join("")).toBe(`${TL}${H.repeat(6)}${TR}`);
        expect(panelBottom(6)).toBe(`${BL}${H.repeat(4)}${BR}`);
    });
});

describe("the Panel component", () => {
    it("frames its children in its width and height, less the column and row of its shadow", () => {
        const r = renderInk(
            <Box width={24} height={6} flexDirection="column">
                <Panel title="Keys" detail="2" width={21} height={5}><Text>one</Text><Text>two</Text></Panel>
                <Text>after</Text>
            </Box>, { columns: 24, rows: 6 });
        const rows = r.lastFrame().split("\n");
        expect(rows[0]!.trimEnd()).toBe(`${TL}${H}${L} Keys ${R}${H.repeat(5)} 2 ${H}${TR}`);
        expect(rows[1]!.trimEnd()).toBe(`${V}one${" ".repeat(15)}${V}`);
        expect(rows[2]!.trimEnd()).toBe(`${V}two${" ".repeat(15)}${V}`);
        expect(rows[3]!.trimEnd()).toBe(`${BL}${H.repeat(18)}${BR}`);
        // Unpainted without colour: the shadow's row is there, and empty.
        expect(rows[4]!.trimEnd()).toBe("");
        expect(rows[5]!.trimEnd()).toBe("after");
    });

    it("clips what does not fit instead of growing", () => {
        const r = renderInk(
            <Box width={13} height={5} flexDirection="column">
                <Panel title="T" width={13} height={4}><Text>one</Text><Text>two</Text><Text>three</Text></Panel>
                <Text>after</Text>
            </Box>, { columns: 13, rows: 5 });
        const rows = r.lastFrame().split("\n");
        expect(rows[2]!.trimEnd()).toBe(`${BL}${H.repeat(10)}${BR}`);
        expect(rows[4]!.trimEnd()).toBe("after");
        expect(r.lastFrame()).not.toContain("two");
    });

    it("draws only its children when plain", () => {
        const r = renderInk(
            <Box width={12} height={2} flexDirection="column">
                <Panel plain title="T" width={12} height={4}><Text>one</Text><Text>two</Text></Panel>
            </Box>, { columns: 12, rows: 2 });
        expect(r.lastFrame().split("\n").map(row => row.trimEnd())).toEqual(["one", "two"]);
    });

    it("is used only by pages with the room, and never when switched off", () => {
        expect(panelled(PANEL_MIN_COLUMNS, PANEL_MIN_ROWS)).toBe(true);
        expect(panelled(PANEL_MIN_COLUMNS - 1, 40)).toBe(false);
        expect(panelled(200, PANEL_MIN_ROWS - 1)).toBe(false);
        setPanels(false);
        expect(panelled(200, 60)).toBe(false);
    });
});

describe("the overview's line-built panels", () => {
    const text = (line: { segs: readonly { text: string }[] }) => line.segs.map(seg => seg.text).join("");
    const cells = (title: string, rows: string[], detail?: string): Cell[] => [
        { key: title, flush: true, heading: { title, ...(detail ? { detail } : {}) }, content: () => [{ text: title }] },
        ...rows.map((row, i): Cell => ({ key: `${title}${i}`, ...(i === 0 ? { focus: "hostname" as const } : {}), content: () => [{ text: row }] })),
    ];

    it("turn a section into lines of exactly the panel's width, the heading in the border", () => {
        const lines = panelLines(cells("Health", ["all good", "a very long row that will not fit in it"], "R restart"), 31, null);
        expect(lines.map(text)).toEqual([
            `${panelTop("Health", 30, "R restart").join("")} `,
            `${V}  all good${" ".repeat(18)}${V} `,
            expect.stringMatching(new RegExp(`^\\${V}  a very long row that will.*\\${V} $`)),
            `${panelBottom(30)} `,
            " ".repeat(31),
        ]);
        expect(lines.every(line => textWidth(text(line)) === 31)).toBe(true);
        expect(lines.map(line => line.focus)).toEqual([undefined, "hostname", undefined, undefined, undefined]);
        // The shadow: beside every line but the first, and the line below, one cell in.
        expect(lines.map(line => line.segs.at(-1)!.shadow === true)).toEqual([false, true, true, true, true]);
        expect(lines[4]!.segs).toEqual([{ text: " " }, { text: " ".repeat(30), shadow: true }]);
    });

    it("mark the selected row inside the border, which stays as it is", () => {
        const [, row] = panelLines(cells("Health", ["all good"]), 20, "hostname");
        expect(row!.segs[0]).toEqual({ text: V });
        expect(row!.segs.at(-2)).toEqual({ text: V });
        expect(row!.segs.slice(1, -2).every(seg => seg.inverse)).toBe(true);
    });

    it("pad the shorter of two panels side by side, and keep both rows' selection", () => {
        const lines = twoPanels(cells("A", ["1"]), cells("B", ["1", "2", "3"]), 13, 0, 15, null);
        expect(lines).toHaveLength(6);
        expect(lines.every(line => textWidth(text(line)) === 28)).toBe(true);
        expect(text(lines[2]!)).toBe(`${V}${" ".repeat(10)}${V} ${V}  2${" ".repeat(9)}${V} `);
        expect(text(lines[4]!)).toBe(`${panelBottom(12)} ${panelBottom(14)} `);
        expect(lines[1]!.focus).toBe("hostname");
    });
});
