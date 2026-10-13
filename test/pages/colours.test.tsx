/*
 * The Colours page: going through the schemes, copying one, changing a
 * colour with its preview, what is written to the settings file and read
 * back from it, renaming and deleting -- and that the built-in schemes
 * cannot be changed. FORCE_COLOR has to be set before chalk (and so
 * theme.ts) is first loaded; each test has a settings file of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.hoisted(() => {
    process.env.FORCE_COLOR = "1";
    delete process.env.COCKPIT_TUI_THEME;
    delete process.env.NO_COLOR;
});

import ColoursPage, { CONFIRM_ARM_MS } from "../../src/pages/colours/index.js";
import { readConfig } from "../../src/config.js";
import {
    DEFAULT_THEME, listThemes, loadCustomSchemes, palette, schemeOf, setTheme, themeName,
} from "../../src/tui/theme.js";
import { renderPage, type RenderedPage } from "../helpers/page.js";
import { cleanup, keys } from "../helpers/ink.js";

let dir = "";
let file = "";

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cockpit-tui-colours-"));
    file = join(dir, "config.json");
    process.env.COCKPIT_TUI_CONFIG = file;
});

afterEach(() => {
    cleanup();
    loadCustomSchemes({});
    setTheme(DEFAULT_THEME);
    process.env.COCKPIT_TUI_CONFIG = "";
    rmSync(dir, { recursive: true, force: true });
});

function start(options: { showHints?: boolean, rows?: number } = {}): RenderedPage {
    return renderPage(ColoursPage, { columns: 110, rows: options.rows ?? 40, ...(options.showHints ? { showHints: true } : {}) });
}

const saved = () => JSON.parse(readFileSync(file, "utf8")) as { theme?: string, schemes?: Record<string, { palette: { window: { bg: string } } }> };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** The built-in dark scheme at this run's colour depth: what a copy of it starts with. */
const DARK = schemeOf("dark");
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** In the colour dialog: go through the choices until `label` is the one shown. */
async function choose(r: RenderedPage, label: string): Promise<void> {
    for (let i = 0; i < 18; i++) {
        if (r.lastFrame().includes(`< ${label} >`))
            return;
        await r.press(keys.right);
    }
    throw new Error(`no choice ${label}:\n${r.lastFrame()}`);
}

const selectedLine = (r: RenderedPage) => r.lastFrame().split("\n").find(l => l.startsWith("›")) ?? "";

/** n, then Enter on the suggested name: a copy of the scheme shown. */
async function copy(r: RenderedPage): Promise<void> {
    await r.press("n");
    await r.waitFor("A scheme of your own");
    await r.press(keys.enter);
    await r.waitFor("yours, as --theme");
}

describe("the schemes", () => {
    it("shows the scheme in use with every colour it has, built-in ones as read-only", async () => {
        const r = start({ showHints: true });
        // (The hints line is drawn a moment after the page.)
        const frame = await r.waitFor(f => f.includes("Text on the screen") && f.includes("n copy to change"));
        expect(frame).toMatch(/^‹ Dark › +built in/m);
        expect(frame).toContain("Built-in schemes cannot be changed: n makes a copy of this one that can.");
        expect(frame).toMatch(new RegExp(`Background\\s+${escaped(DARK.palette.root.bg)}`));
        expect(frame).toMatch(/The main window's title\s+cyanBright/);
        expect(frame).toMatch(/hints: ←→ scheme \| n copy to change\s*$/m);
        await r.press(keys.enter);
        await r.waitFor("status: info: Dark is built in and cannot be changed: press n to make a copy that can");
        await r.press("d");
        await r.waitFor("status: info: Dark is built in: it cannot be deleted");
        expect(listThemes().filter(t => t.custom)).toEqual([]);
    });

    it("goes through them with the arrows, using and remembering each", async () => {
        const r = start();
        await r.waitFor("‹ Dark ›");
        await r.press(keys.right);
        await r.waitFor("‹ Light ›");
        expect(themeName()).toBe("light");
        expect(saved().theme).toBe("light");
        await r.press(keys.left, keys.left);
        await r.waitFor("‹ Newt ›");
        expect(themeName()).toBe("newt");
        expect(palette.root.bg).toBe("blue");
    });
});

describe("a scheme of your own", () => {
    it("is a copy under a name you give, in use at once and saved", async () => {
        const r = start({ showHints: true });
        await r.waitFor("‹ Dark ›");
        await r.press("n");
        const dialog = await r.waitFor("A scheme of your own");
        expect(dialog).toContain("my-dark");
        // The suggested name can be changed; a bad one is refused.
        await r.press("\x15".repeat(0), ...Array(7).fill(keys.backspace), "Bad Name", keys.enter);
        await r.waitFor("Lower-case letters, digits and dashes, starting");
        await r.press(...Array(8).fill(keys.backspace), "dark", keys.enter);
        await r.waitFor("dark is a built-in scheme");
        await r.press(...Array(4).fill(keys.backspace), "night", keys.enter);
        const frame = await r.waitFor("‹ Night ›");
        expect(frame).toContain("yours, as --theme night");
        expect(frame).toMatch(/hints: ←→ scheme \| enter change colour \| n copy \| r rename \| d delete$/m);
        expect(themeName()).toBe("night");
        expect(listThemes().at(-1)).toMatchObject({ name: "night", label: "Night", custom: true });
        expect(saved().theme).toBe("night");
        expect(saved().schemes!.night!.palette.window.bg).toBe(schemeOf("dark").palette.window.bg);
    });

    it("has each colour changed in a dialog that shows the choice at once; Esc puts it back, Enter keeps and saves it", async () => {
        const r = start();
        await r.waitFor("‹ Dark ›");
        await copy(r);
        // The screen's background is the first slot.
        const was = DARK.palette.root.bg;
        expect(selectedLine(r)).toContain(was);
        await r.press(keys.enter);
        await r.waitFor("Screen: Background");
        await choose(r, "red");
        // Shown at once, on the whole program...
        expect(palette.root.bg).toBe("red");
        // ...but not stored, and Esc puts the old colour back.
        expect(schemeOf("my-dark").palette.root.bg).toBe(was);
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Screen: Background"));
        expect(palette.root.bg).toBe(was);
        expect(saved().schemes!["my-dark"]!.palette).toMatchObject({ root: { bg: was } });

        await r.press(keys.enter);
        await r.waitFor("Screen: Background");
        await choose(r, "green");
        await r.press(keys.enter);
        await r.waitFor(f => /Background\s+green/.test(f) && !f.includes("Screen: Background"));
        expect(palette.root.bg).toBe("green");
        expect(schemeOf("my-dark").palette.root.bg).toBe("green");
        expect(JSON.parse(readFileSync(file, "utf8")).schemes["my-dark"].palette.root.bg).toBe("green");
        // The built-in scheme it was copied from is as it was.
        expect(schemeOf("dark").palette.root.bg).toBe(was);
    });

    it("takes a colour as #rrggbb, and nothing that is not one", async () => {
        const r = start();
        await r.waitFor("‹ Dark ›");
        await copy(r);
        await r.press(keys.down, keys.down, keys.enter);
        await r.waitFor("Windows: Background");
        await choose(r, "another: give it below");
        await r.press(keys.down, ...Array(7).fill(keys.backspace), "#12", keys.enter);
        await r.waitFor("Not a colour: six hex digits after #");
        expect(schemeOf("my-dark").palette.window.bg).toBe(DARK.palette.window.bg);
        await r.press("3456");
        // A whole colour typed: shown.
        expect(palette.window.bg).toBe("#123456");
        await r.press(keys.enter);
        await r.waitFor(f => /Background\s+#123456/.test(f) && !f.includes("Windows: Background"));
        expect(saved().schemes!["my-dark"]!.palette.window.bg).toBe("#123456");
    });

    it("warns about text in the colour of what is behind it", async () => {
        const r = start();
        await r.waitFor("‹ Dark ›");
        await copy(r);
        // The selected row's text is black on cyan: make its background black too.
        for (let i = 0; i < 6; i++)
            await r.press(keys.down);
        await r.press(keys.enter);
        await r.waitFor("Selected row: Background");
        await choose(r, "black");
        await r.press(keys.enter);
        await r.waitFor("Unreadable: selected row / text is the colour of what is behind");
    });

    it("is read back from the settings file, bad entries left out", async () => {
        writeFileSync(file, JSON.stringify({
            theme: "ocean",
            schemes: {
                ocean: { label: "Ocean", palette: { window: { bg: "#002b36" } } },
                "Bad Name": { label: "x" },
                dark: { label: "Not the built-in" },
                broken: "nonsense",
            },
        }));
        loadCustomSchemes(readConfig().schemes);
        setTheme("ocean");
        expect(listThemes().filter(t => t.custom).map(t => t.name)).toEqual(["ocean"]);
        expect(schemeOf("dark").label).toBe("Dark");
        const r = start();
        const frame = await r.waitFor("‹ Ocean ›");
        expect(frame).toMatch(/Background\s+#002b36/);
        expect(palette.window.bg).toBe("#002b36");
    });

    it("is renamed and deleted; deleting the one in use falls back to the default", async () => {
        const r = start();
        await r.waitFor("‹ Dark ›");
        await copy(r);
        await r.press("r");
        await r.waitFor("Rename My dark");
        await r.press(...Array(7).fill(keys.backspace), "dusk", keys.enter);
        await r.waitFor("‹ Dusk ›");
        expect(listThemes().filter(t => t.custom).map(t => t.name)).toEqual(["dusk"]);
        expect(saved()).toMatchObject({ theme: "dusk" });
        expect(Object.keys(saved().schemes!)).toEqual(["dusk"]);

        await r.press("d");
        await r.waitFor("Delete your colour scheme dusk?");
        // Not answered by a key typed on.
        await r.press(keys.enter);
        expect(themeName()).toBe("dusk");
        await wait(CONFIRM_ARM_MS + 50);
        await r.press(keys.enter);
        await r.waitFor("status: success: Deleted dusk");
        expect(themeName()).toBe("dark");
        expect(listThemes().some(t => t.custom)).toBe(false);
        expect(saved()).toEqual({ theme: "dark", schemes: {} });
        expect(r.lastFrame()).toContain("‹ Dark ›");
    });

    it("keeps working when the settings file cannot be written, and says so", async () => {
        writeFileSync(join(dir, "plain"), "");
        process.env.COCKPIT_TUI_CONFIG = join(dir, "plain", "below", "config.json");
        const r = start();
        await r.waitFor("‹ Dark ›");
        await r.press(keys.right);
        await r.waitFor("status: warning: The colours are kept for this run only");
        expect(themeName()).toBe("light");
    });

    it("scrolls its list on a short page, keeping the selected colour in view", async () => {
        const r = start({ rows: 14 });
        await r.waitFor("‹ Dark ›");
        await r.press(keys.end);
        const frame = await r.waitFor("Information");
        expect(selectedLine(r)).toContain("Information");
        expect(frame.split("\n").length).toBeLessThanOrEqual(14);
    });
});
