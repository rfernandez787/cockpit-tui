/*
 * The Colours page's pure half: the slots cover every colour a scheme has,
 * reading and changing one, copying a scheme, unreadable combinations, and
 * what counts as a colour when typed.
 */
import { describe, it, expect } from "vitest";
import { collisions, forkScheme, labelFor, parseColour, slotValue, SLOTS, withSlot } from "../../src/pages/colours/model.js";
import { BASIC_COLOURS, isColour, listThemes, parseScheme, schemeNameProblem, schemeOf } from "../../src/tui/theme.js";

const dark = schemeOf("dark", true);

describe("the slots", () => {
    it("cover every colour of a scheme the program paints with, once each", () => {
        const ids = SLOTS.map(slot => slot.id);
        expect(new Set(ids).size).toBe(ids.length);
        const all = [
            ...(["root", "window", "entry", "selected"] as const).flatMap(pair => [`${pair}.fg`, `${pair}.bg`]),
            "title", "shadow",
            ...Object.keys(dark.colors).map(role => `colors.${role}`),
            ...Object.keys(dark.rootColors).map(role => `rootColors.${role}`),
        ];
        expect([...ids].sort()).toEqual([...all].sort());
        // Text slots say what they are painted on, and that is a slot too.
        for (const slot of SLOTS)
            if (slot.on)
                expect(ids).toContain(slot.on);
    });

    it("read a slot of every kind, in every scheme", () => {
        expect(slotValue(dark, "window.bg")).toBe("#3a3a3a");
        expect(slotValue(dark, "title")).toBe("cyanBright");
        expect(slotValue(dark, "colors.dim")).toBe("#a8a8a8");
        expect(slotValue(dark, "rootColors.accent")).toBe("whiteBright");
        for (const { name } of listThemes())
            for (const slot of SLOTS)
                expect(isColour(slotValue(schemeOf(name, true), slot.id)), `${name} ${slot.id}`).toBe(true);
    });

    it("change one slot and nothing else, leaving the scheme given as it was", () => {
        const before = JSON.stringify(dark);
        for (const slot of SLOTS) {
            const changed = withSlot(dark, slot.id, "#123456");
            expect(slotValue(changed, slot.id)).toBe("#123456");
            for (const other of SLOTS)
                if (other.id !== slot.id)
                    expect(slotValue(changed, other.id)).toBe(slotValue(dark, other.id));
        }
        expect(JSON.stringify(dark)).toBe(before);
    });
});

describe("a copy to change", () => {
    it("has the same colours under its own label, and shares nothing with what it was made from", () => {
        const copy = forkScheme(dark, "my-dark", "Dark");
        expect(copy).toMatchObject({ label: "My dark", description: "made from Dark" });
        expect(copy.palette).toEqual(dark.palette);
        expect(copy.palette.window).not.toBe(dark.palette.window);
        expect(copy.colors).not.toBe(dark.colors);
        expect(labelFor("solar--night-2")).toBe("Solar night 2");
    });

    it("needs a name of its own", () => {
        expect(schemeNameProblem("my-dark")).toBeNull();
        expect(schemeNameProblem("")).toMatch(/name/);
        expect(schemeNameProblem("dark")).toBe("dark is a built-in scheme");
        expect(schemeNameProblem("My Dark")).not.toBeNull();
        expect(schemeNameProblem("2fast")).not.toBeNull();
        expect(schemeNameProblem("x".repeat(25))).not.toBeNull();
        expect(schemeNameProblem("__proto__")).not.toBeNull();
    });
});

describe("unreadable combinations", () => {
    it("are text in the colour of what it is painted on", () => {
        expect(collisions(dark)).toEqual([]);
        for (const { name } of listThemes()) {
            expect(collisions(schemeOf(name, true)), name).toEqual([]);
            expect(collisions(schemeOf(name, false)), name).toEqual([]);
        }
        const bad = withSlot(withSlot(dark, "window.fg", "#3a3a3a"), "rootColors.dim", "#1c1c1c");
        expect(collisions(bad).map(slot => slot.id)).toEqual(["window.fg", "rootColors.dim"]);
        // Changing the background can do it as well.
        expect(collisions(withSlot(dark, "selected.bg", "black")).map(slot => slot.id)).toEqual(["selected.fg"]);
    });
});

describe("a colour as typed", () => {
    it("is one of the sixteen names in any case, or hex with or without its #", () => {
        expect(parseColour("cyan", BASIC_COLOURS)).toBe("cyan");
        expect(parseColour(" RedBright ", BASIC_COLOURS)).toBe("redBright");
        expect(parseColour("grey", BASIC_COLOURS)).toBe("gray");
        expect(parseColour("#3A3a3a", BASIC_COLOURS)).toBe("#3a3a3a");
        expect(parseColour("1c1c1c", BASIC_COLOURS)).toBe("#1c1c1c");
        expect(parseColour("#abc", BASIC_COLOURS)).toBe("#aabbcc");
    });

    it("is nothing else", () => {
        for (const text of ["", "  ", "#12345", "#1234567", "abc", "purple", "#ggg", "rgb(1,2,3)", "\x1b[31m"])
            expect(parseColour(text, BASIC_COLOURS), JSON.stringify(text)).toBeNull();
        expect(parseColour("cyan", [])).toBeNull();
    });
});

describe("a scheme from the settings file", () => {
    it("keeps what is valid and takes the rest from the default", () => {
        const base = schemeOf("dark");
        const parsed = parseScheme({
            label: "  Mine  ", palette: { window: { bg: "#102030", fg: "nonsense" }, title: 7, shadow: "blue" },
            colors: { ok: "#00ff00", error: "\x1b[31m" }, rootColors: "x",
        })!;
        expect(parsed.label).toBe("Mine");
        expect(parsed.palette.window).toEqual({ bg: "#102030", fg: base.palette.window.fg });
        expect(parsed.palette.title).toBe(base.palette.title);
        expect(parsed.palette.shadow).toBe("blue");
        expect(parsed.colors.ok).toBe("#00ff00");
        expect(parsed.colors.error).toBe(base.colors.error);
        expect(parsed.rootColors).toEqual(base.rootColors);
        for (const slot of SLOTS)
            expect(isColour(slotValue(parsed, slot.id))).toBe(true);
    });

    it("is not one when it is not an object", () => {
        for (const value of [null, undefined, "dark", 5, [1, 2]])
            expect(parseScheme(value)).toBeNull();
        expect(parseScheme({})).toMatchObject({ label: "Custom" });
    });
});
