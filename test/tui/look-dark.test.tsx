/*
 * The default, dark colours of the newt look: a dark screen, windows a shade
 * lighter with light text and a black shadow, a cyan selection, blue entry
 * fields. Where the terminal has only sixteen colours there is one black, so
 * the windows are black and the shadow dark grey; the tests follow whichever
 * depth the test run has. The layout is tested with newt's own colours in
 * look.test.tsx; this is only the palette.
 * FORCE_COLOR has to be set before chalk (and so theme.ts) is first loaded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    process.env.FORCE_COLOR = "1";
    delete process.env.COCKPIT_TUI_THEME;
    delete process.env.NO_COLOR;
});

import { Box, Text } from "../../src/tui/ink.js";
import { TextInput } from "../../src/tui/components/TextInput.js";
import { Window } from "../../src/tui/components/Window.js";
import { Table, type ListNav } from "../../src/tui/components/Table.js";
import { KeyboardProvider } from "../../src/tui/keyboard.js";
import { colors, palette, richColor, styled, themeName } from "../../src/tui/theme.js";
import { cleanup, renderInk, stripAnsi } from "../helpers/ink.js";

afterEach(cleanup);

const WHITE = "\x1b[37m", BRIGHT_CYAN = "\x1b[96m", BRIGHT_WHITE = "\x1b[97m";
const ON_BLACK = "\x1b[40m", ON_BLUE = "\x1b[44m", ON_CYAN = "\x1b[46m", ON_GREY = "\x1b[47m";

describe("the dark theme", () => {
    it("is the default, and painted when the terminal has colour", () => {
        expect(themeName()).toBe("dark");
        expect(styled).toBe(true);
        if (!richColor) {
            expect(palette).toMatchObject({ root: { bg: "black" }, window: { bg: "black" }, shadow: "gray" });
            return;
        }
        // Three shades: windows lighter than the screen, the shadow darker than both.
        const level = (hex: string) => parseInt(hex.slice(1, 3), 16);
        expect(level(palette.window.bg)).toBeGreaterThan(level(palette.root.bg) + 20);
        expect(level(palette.shadow)).toBeLessThan(level(palette.root.bg) - 20);
        // Dim text still reads on the lighter window.
        expect(level(colors.dim)).toBeGreaterThan(level(palette.window.bg) + 90);
    });

    it("draws a window dark with light text and its title bright in the border", () => {
        const r = renderInk(<Box width={24} height={5}><Window title="Edit" width={20}><Text>hello</Text></Window></Box>);
        const raw = r.lastRawFrame();
        expect(stripAnsi(raw).split("\n")[0]).toMatch(/^┌─+┤ Edit ├─+┐$/);
        expect(raw).toContain(`${BRIGHT_CYAN}Edit`);
        // The window's own shade (#3a3a3a, as 256-colour or true colour), or black with sixteen colours.
        if (richColor)
            expect(raw.split("\n")[1]).toMatch(/\x1b\[48;(5;237|2;58;58;58)m\x1b\[37m│/);
        else
            expect(raw.split("\n")[1]).toContain(`${ON_BLACK}${WHITE}│`);
        expect(raw).toContain(`${WHITE}hello`);
        // Nothing of newt's light grey is left.
        expect(raw).not.toContain(ON_GREY);
    });

    it("draws an entry as a blue field with bright text", () => {
        const r = renderInk(
            <KeyboardProvider><Window width={20}><TextInput value="abc" onChange={() => {}} width={10} /></Window></KeyboardProvider>);
        const raw = r.lastRawFrame();
        expect(raw).toContain(ON_BLUE);
        expect(raw).toContain(BRIGHT_WHITE);
    });

    it("draws the selected row dark on cyan", () => {
        const nav: ListNav = { index: 0, key: "a", offset: 0, visible: 2, count: 2, select() {}, selectKey() {}, handleKey: () => false };
        const r = renderInk(
            <KeyboardProvider>
                <Window width={24}>
                    <Table rows={["first", "second"]} columns={[{ id: "n", title: "Name", value: row => row }]} nav={nav} width={20} height={3} />
                </Window>
            </KeyboardProvider>);
        const selected = r.lastRawFrame().split("\n").find(line => stripAnsi(line).includes("first"))!;
        expect(selected).toContain(ON_CYAN);
    });

    it("uses text colours that read on a dark window", () => {
        expect(colors).toMatchObject({ accent: "cyanBright", warning: "yellowBright", error: "redBright", dim: richColor ? "#a8a8a8" : "gray" });
    });
});
