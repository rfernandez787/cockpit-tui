/*
 * The colour schemes (theme.ts) and choosing one: every scheme complete and
 * legible, switching in place, the saved choice (config.ts), and what is
 * painted after a switch. FORCE_COLOR has to be set before chalk (and so
 * theme.ts) is first loaded; the config file is a temporary one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = vi.hoisted(() => {
    process.env.FORCE_COLOR = "1";
    delete process.env.COCKPIT_TUI_THEME;
    delete process.env.NO_COLOR;
    return { path: "" };
});

import { configPath, readConfig, writeConfig } from "../../src/config.js";
import { Box, Text } from "../../src/tui/ink.js";
import { Window } from "../../src/tui/components/Window.js";
import {
    colors, DEFAULT_THEME, isThemeName, palette, richColor, rootColors, schemeOf, applyScheme, isBuiltinTheme, listThemes, loadCustomSchemes, registerScheme, removeScheme, setTheme, subscribeTheme, themeName, themeVersion,
} from "../../src/tui/theme.js";
import { cleanup, renderInk } from "../helpers/ink.js";

const THEMES = listThemes();

afterEach(() => {
    cleanup();
    loadCustomSchemes({});
    setTheme(DEFAULT_THEME);
    if (dir.path)
        rmSync(dir.path, { recursive: true, force: true });
    dir.path = "";
});

const NAMES = new Set([
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "gray",
    "redBright", "greenBright", "yellowBright", "blueBright", "magentaBright", "cyanBright", "whiteBright",
]);
const valid = (colour: string) => NAMES.has(colour) || /^#[0-9a-f]{6}$/.test(colour);

/** Approximate lightness 0..255 of a hex colour, for "does this read on that". */
function light(colour: string): number | null {
    if (!colour.startsWith("#"))
        return null;
    const [r, g, b] = [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16)) as [number, number, number];
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

describe("the colour schemes", () => {
    it("offers dark first, and newt's own among the others", () => {
        expect(THEMES.map(t => t.name)).toEqual(["dark", "light", "midnight", "newt"]);
        expect(DEFAULT_THEME).toBe("dark");
        expect(themeName()).toBe("dark");
        expect(isThemeName("light")).toBe(true);
        expect(isThemeName("solarized")).toBe(false);
        expect(isThemeName("toString")).toBe(false);
        expect(isThemeName(undefined)).toBe(false);
    });

    // Both depths, whichever this run has: the shades a 256-colour terminal
    // shows, and the names alone that a Linux console gets.
    for (const rich of [false, true]) for (const { name } of THEMES) {
        it(`${name}, ${rich ? "with shades" : "sixteen colours"}: every colour is one Ink understands, and text can be told from what it is on`, () => {
            const scheme = schemeOf(name, rich);
            expect(scheme.label).not.toBe("");
            expect(scheme.description).not.toBe("");
            const p = scheme.palette;
            const all = [
                p.root.fg, p.root.bg, p.rootBright, p.window.fg, p.window.bg, p.title, p.shadow, p.entry.fg, p.entry.bg,
                p.selected.fg, p.selected.bg, ...Object.values(scheme.colors), ...Object.values(scheme.rootColors),
            ];
            for (const colour of all)
                expect(valid(colour), `${name}: ${colour}`).toBe(true);
            // No text in the colour of its own background.
            for (const [role, colour] of Object.entries(scheme.colors))
                expect(colour, `${name}: ${role} on the window`).not.toBe(p.window.bg);
            for (const [role, colour] of Object.entries(scheme.rootColors))
                expect(colour, `${name}: ${role} on the root`).not.toBe(p.root.bg);
            expect(p.window.fg).not.toBe(p.window.bg);
            expect(p.root.fg).not.toBe(p.root.bg);
            expect(p.selected.fg).not.toBe(p.selected.bg);
            expect(p.entry.fg).not.toBe(p.entry.bg);
            // Where shades are given as hex, text is well clear of its background.
            const pairs: [string, string][] = [
                [p.window.fg, p.window.bg], [p.root.fg, p.root.bg], [scheme.colors.dim, p.window.bg], [scheme.rootColors.dim, p.root.bg],
            ];
            for (const [fg, bg] of pairs) {
                const a = light(fg);
                const b = light(bg);
                if (a !== null && b !== null)
                    expect(Math.abs(a - b), `${name}: ${fg} on ${bg}`).toBeGreaterThan(60);
            }
        });
    }

    it("has shades where the terminal has them, and names alone where it has sixteen colours", () => {
        for (const { name } of THEMES)
            expect(JSON.stringify(schemeOf(name, false)), name).not.toContain("#");
        for (const name of ["dark", "light", "midnight"] as const) {
            const p = schemeOf(name, true).palette;
            // The screen, the window and the shadow are three different shades.
            expect(new Set([p.root.bg, p.window.bg, p.shadow]).size, name).toBe(3);
            for (const colour of [p.root.bg, p.window.bg, p.shadow])
                expect(colour, name).toMatch(/^#[0-9a-f]{6}$/);
        }
        // Newt's own is the basic colours at any depth.
        expect(schemeOf("newt", true)).toEqual(schemeOf("newt", false));
        // And the one in use is this terminal's depth.
        expect(schemeOf("dark")).toBe(schemeOf("dark", richColor));
    });
});

describe("switching", () => {
    it("changes the palette and the roles in place, and tells whoever subscribed, once per change", () => {
        const before = { palette, colors, rootColors, window: palette.window };
        const heard: string[] = [];
        const stop = subscribeTheme(() => heard.push(themeName()));
        setTheme("newt");
        expect(themeName()).toBe("newt");
        // The same objects every module imported: only their contents changed.
        expect(palette).toBe(before.palette);
        expect(colors).toBe(before.colors);
        expect(rootColors).toBe(before.rootColors);
        expect(palette).toEqual(schemeOf("newt").palette);
        expect(colors).toEqual(schemeOf("newt").colors);
        expect(rootColors).toEqual(schemeOf("newt").rootColors);
        setTheme("newt");
        setTheme("light");
        expect(heard).toEqual(["newt", "light"]);
        stop();
        setTheme("dark");
        expect(heard).toHaveLength(2);
        // The schemes themselves are not what was changed.
        expect(schemeOf("newt").palette.window.bg).toBe("white");
    });

    it("paints a window in the new scheme's colours the next time it is drawn", () => {
        const tree = <Box width={24} height={5}><Window title="Edit" width={20}><Text>hello</Text></Window></Box>;
        const r = renderInk(tree);
        expect(r.lastRawFrame()).not.toContain("\x1b[47m");
        setTheme("newt");
        r.rerender(<Box width={24} height={5}><Window title="Edit" width={20}><Text>hello</Text></Window></Box>);
        const raw = r.lastRawFrame();
        // Newt: black text on a light grey window, its title red.
        expect(raw).toContain("\x1b[47m");
        expect(raw).toContain("\x1b[30mhello");
        expect(raw).toContain("\x1b[31mEdit");
    });
});

describe("schemes of the viewer's own", () => {
    const mine = () => ({ ...schemeOf("dark"), label: "Mine", description: "", palette: { ...schemeOf("dark").palette, window: { fg: "white", bg: "#102030" } } });

    it("are listed after the built-in ones, usable by name, and gone again when removed", () => {
        registerScheme("mine", mine());
        expect(listThemes().map(t => `${t.name}${t.custom ? "*" : ""}`)).toEqual(["dark", "light", "midnight", "newt", "mine*"]);
        expect(isThemeName("mine")).toBe(true);
        expect(isBuiltinTheme("mine")).toBe(false);
        setTheme("mine");
        expect(palette.window.bg).toBe("#102030");
        // Removing the one in use falls back to the default.
        removeScheme("mine");
        expect(themeName()).toBe("dark");
        expect(palette.window.bg).toBe(schemeOf("dark").palette.window.bg);
        expect(isThemeName("mine")).toBe(false);
        setTheme("mine");
        expect(themeName()).toBe("dark");
    });

    it("cannot take a built-in scheme's name, and never change a built-in scheme", () => {
        expect(() => registerScheme("dark", mine())).toThrow();
        expect(() => registerScheme("Not A Name", mine())).toThrow();
        removeScheme("dark");
        expect(listThemes().map(t => t.name)).toContain("dark");
        expect(schemeOf("dark").label).toBe("Dark");
    });

    it("repaint when the one in use is replaced, and a preview changes what is painted but not what is stored", () => {
        registerScheme("mine", mine());
        setTheme("mine");
        const versions = [themeVersion()];
        applyScheme({ ...mine(), palette: { ...mine().palette, shadow: "red" } });
        versions.push(themeVersion());
        expect(palette.shadow).toBe("red");
        expect(schemeOf("mine").palette.shadow).not.toBe("red");
        expect(themeName()).toBe("mine");
        applyScheme(null);
        versions.push(themeVersion());
        expect(palette.shadow).toBe(schemeOf("mine").palette.shadow);
        registerScheme("mine", { ...mine(), palette: { ...mine().palette, title: "magenta" } });
        versions.push(themeVersion());
        expect(palette.title).toBe("magenta");
        // Every one of those is a change the shell repaints for.
        expect(new Set(versions).size).toBe(4);
    });

    it("are stored as copies: changing what was registered afterwards changes nothing", () => {
        const scheme = mine();
        registerScheme("mine", scheme);
        scheme.palette.window.bg = "red";
        expect(schemeOf("mine").palette.window.bg).toBe("#102030");
    });
});

describe("the saved choice", () => {
    function temporary(): NodeJS.ProcessEnv {
        dir.path = mkdtempSync(join(tmpdir(), "cockpit-tui-config-"));
        return { COCKPIT_TUI_CONFIG: join(dir.path, "nested", "config.json") };
    }

    it("lives under XDG_CONFIG_HOME, or ~/.config, unless COCKPIT_TUI_CONFIG says otherwise", () => {
        expect(configPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/cockpit-tui/config.json");
        expect(configPath({})).toMatch(/\/\.config\/cockpit-tui\/config\.json$/);
        expect(configPath({ COCKPIT_TUI_CONFIG: "/tmp/c.json", XDG_CONFIG_HOME: "/x" })).toBe("/tmp/c.json");
        // Empty: no file at all (the test suite runs like this).
        expect(configPath({ COCKPIT_TUI_CONFIG: "" })).toBeNull();
        expect(readConfig({ COCKPIT_TUI_CONFIG: "" })).toEqual({});
        expect(() => writeConfig({ theme: "light" }, { COCKPIT_TUI_CONFIG: "" })).not.toThrow();
        expect(configPath()).toBeNull();
    });

    it("is written as JSON, creating its directory, and keeps what else is in the file", () => {
        const env = temporary();
        expect(readConfig(env)).toEqual({});
        writeConfig({ theme: "midnight" }, env);
        expect(JSON.parse(readFileSync(env.COCKPIT_TUI_CONFIG!, "utf8"))).toEqual({ theme: "midnight" });
        writeFileSync(env.COCKPIT_TUI_CONFIG!, JSON.stringify({ theme: "midnight", other: 1 }));
        writeConfig({ theme: "light" }, env);
        expect(readConfig(env)).toEqual({ theme: "light", other: 1 });
    });

    it("reads a broken or foreign file as no settings, and a write that cannot happen throws", () => {
        const env = temporary();
        writeConfig({ theme: "light" }, env);
        writeFileSync(env.COCKPIT_TUI_CONFIG!, "{ not json");
        expect(readConfig(env)).toEqual({});
        writeFileSync(env.COCKPIT_TUI_CONFIG!, "[1, 2]");
        expect(readConfig(env)).toEqual({});
        // A directory that cannot be made: its parent is a regular file.
        expect(() => writeConfig({ theme: "light" }, { COCKPIT_TUI_CONFIG: join(env.COCKPIT_TUI_CONFIG!, "below", "config.json") })).toThrow();
    });
});
