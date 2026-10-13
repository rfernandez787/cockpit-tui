/*
 * The newt look in newt's own colours (COCKPIT_TUI_THEME=newt), which needs
 * colour: every other test renders without it. FORCE_COLOR and the theme have
 * to be set before chalk (and so theme.ts) is first loaded. The default, dark
 * colours are in look-dark.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    process.env.FORCE_COLOR = "1";
    process.env.COCKPIT_TUI_THEME = "newt";
    delete process.env.NO_COLOR;
});

import { Box, Text } from "../../src/tui/ink.js";
import { TextInput } from "../../src/tui/components/TextInput.js";
import { Window, topBorder } from "../../src/tui/components/Window.js";
import { Panel } from "../../src/tui/components/Panel.js";
import { KeyboardProvider } from "../../src/tui/keyboard.js";
import { styled } from "../../src/tui/theme.js";
import { cleanup, renderInk, stripAnsi } from "../helpers/ink.js";

afterEach(cleanup);

const BLACK = "\x1b[30m", RED = "\x1b[31m", BLUE = "\x1b[34m", BRIGHT = "\x1b[97m", WHITE = "\x1b[37m";
const ON_GREY = "\x1b[47m", ON_BLUE = "\x1b[44m", ON_BLACK = "\x1b[40m", INVERSE = "\x1b[7m";

describe("the newt look", () => {
    it("is painted when the terminal has colour", () => {
        expect(styled).toBe(true);
    });

    it("draws a window grey with dark text, its title red in the border, and a shadow", () => {
        const r = renderInk(<Box width={24} height={5}><Window title="Edit" width={20}><Text>hello</Text></Window></Box>);
        const raw = r.lastRawFrame();
        const rows = stripAnsi(raw).split("\n");
        expect(rows[0]).toMatch(/^┌─+┤ Edit ├─+┐$/);
        expect(rows[1]).toMatch(/^│ hello +│ $/);
        expect(rows[3]).toMatch(/^ ▀{20}$/);
        expect(raw).toContain(`${RED}Edit`);
        expect(raw.split("\n")[1]).toContain(`${ON_GREY}${BLACK}│`);
        expect(raw).toContain(`${BLACK}hello`);
        // One cell right of the border; below it half a row, as half blocks.
        expect(raw.split("\n")[1]).toContain(`${ON_BLACK} `);
        expect(raw.split("\n")[2]).toContain(`${ON_BLACK} `);
        expect(raw.split("\n")[3]).toContain(`${BLACK}${"▀".repeat(20)}`);
        expect(raw.split("\n")[3]).not.toContain(ON_BLACK);
    });

    it("draws the selected row light on blue, whatever its pieces' own colours", () => {
        const r = renderInk(
            <Box backgroundColor="white" width={12}>
                <Text inverse>a<Text color="green">b</Text>c</Text>
            </Box>);
        const raw = r.lastRawFrame();
        expect(stripAnsi(raw)).toContain("abc");
        expect(raw).toContain(`${ON_BLUE}${BRIGHT}abc`);
        expect(raw).not.toContain(INVERSE);
        expect(raw).not.toContain("\x1b[32m");
    });

    it("lets nested text keep the colour around it", () => {
        const r = renderInk(<Text color="red">a<Text bold>b</Text></Text>);
        expect(r.lastRawFrame()).not.toContain(BLACK);
    });

    it("draws an entry as a blue field filled to its width, with the cursor in it", async () => {
        const field = (value: string, focus: boolean) => (
            <KeyboardProvider>
                <Box backgroundColor="white" width={12}>
                    <TextInput value={value} onChange={() => {}} width={8} focus={focus} />
                </Box>
            </KeyboardProvider>);
        const r = renderInk(field("abc", false));
        expect(r.lastRawFrame()).toContain(`${ON_BLUE}${WHITE}abc_____`);
        r.rerender(field("abc", true));
        await r.waitFor("abc");
        // The cursor cell is in the window's colours, after the text.
        expect(r.lastRawFrame()).toMatch(/abc(\x1b\[\d+m)*\x1b\[47m(\x1b\[\d+m)* (\x1b\[\d+m)*\x1b\[44m(\x1b\[\d+m)*____/);
        expect(stripAnsi(r.lastRawFrame()).split("\n")[0]).toBe("abc ____    ");
    });

    it("draws a panel as a small window: its title blue in the border, and a shadow within its own size", () => {
        const r = renderInk(<Box width={20} height={4} backgroundColor="white"><Panel title="Keys" width={20} height={4}><Text>hello</Text></Panel></Box>);
        const raw = r.lastRawFrame().split("\n");
        const rows = stripAnsi(r.lastRawFrame()).split("\n");
        expect(rows[0]).toMatch(/^┌─┤ Keys ├─+┐ $/);
        expect(rows[1]).toMatch(/^│hello +│ $/);
        expect(rows[2]).toMatch(/^└─+┘ $/);
        expect(raw[0]).toContain(`${BLUE}Keys`);
        expect(raw[0]).not.toContain(ON_BLACK);
        // One cell right of the border from the second row, and the row below it, one cell in.
        expect(raw[1]).toContain(`${ON_BLACK} `);
        expect(raw[2]).toContain(`${ON_BLACK} `);
        expect(rows[3]).toMatch(/^ ▀{19}$/);
        expect(raw[3]).toContain(`${BLACK}${"▀".repeat(19)}`);
        expect(raw[3]).not.toContain(ON_BLACK);
    });

    it("drops a title that does not fit rather than the border", () => {
        expect(topBorder("Title", 7).join("")).toBe("┌─────┐");
        expect(topBorder("A long title", 12).join("")).toHaveLength(12);
    });
});
