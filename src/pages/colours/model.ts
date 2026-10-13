/*
 * Colours: the pure half. A colour scheme (theme.ts) as the list of slots
 * the page shows, reading and changing one slot, making a copy to change,
 * and finding the combinations nobody can read.
 */
import type { Palette, Roles, Scheme } from "../../tui/theme.js";

export interface Slot {
    /** Where in the scheme: "window.bg", "colors.warning". */
    readonly id: string;
    readonly group: string;
    readonly label: string;
    /** What it is painted on, when it is text: the slot whose colour is behind it. */
    readonly on?: string;
}

const ROLE_LABELS: Readonly<Record<keyof Roles, string>> = {
    accent: "Accent: titles, keys, what is active",
    ok: "Good: running, healthy, done",
    warning: "Warning",
    error: "Error: failed, refused",
    dim: "Dim: secondary text",
    info: "Information",
};

const roles = (prefix: "colors" | "rootColors", group: string, on: string): Slot[] =>
    (Object.keys(ROLE_LABELS) as (keyof Roles)[]).map(role => ({ id: `${prefix}.${role}`, group, label: ROLE_LABELS[role], on }));

/** Every colour of a scheme that the page offers to change, in the order it lists them. */
export const SLOTS: readonly Slot[] = [
    { id: "root.bg", group: "Screen", label: "Background" },
    { id: "root.fg", group: "Screen", label: "Text: the header and the help line", on: "root.bg" },
    { id: "window.bg", group: "Windows", label: "Background" },
    { id: "window.fg", group: "Windows", label: "Text and borders", on: "window.bg" },
    { id: "title", group: "Windows", label: "The main window's title", on: "window.bg" },
    { id: "shadow", group: "Windows", label: "Shadow" },
    { id: "selected.bg", group: "Selected row", label: "Background" },
    { id: "selected.fg", group: "Selected row", label: "Text", on: "selected.bg" },
    { id: "entry.bg", group: "Entry fields", label: "Background" },
    { id: "entry.fg", group: "Entry fields", label: "Text", on: "entry.bg" },
    ...roles("colors", "Text in windows", "window.bg"),
    ...roles("rootColors", "Text on the screen", "root.bg"),
];

type Pair = "root" | "window" | "entry" | "selected";

/** The colour in a slot. */
export function slotValue(scheme: Scheme, id: string): string {
    const [head, tail] = id.split(".") as [string, string | undefined];
    if (head === "colors" || head === "rootColors")
        return scheme[head][tail as keyof Roles];
    if (tail === undefined)
        return scheme.palette[head as "title" | "shadow"];
    return scheme.palette[head as Pair][tail as "fg" | "bg"];
}

/** The scheme with one slot changed; the scheme given is not touched. */
export function withSlot(scheme: Scheme, id: string, colour: string): Scheme {
    const [head, tail] = id.split(".") as [string, string | undefined];
    if (head === "colors" || head === "rootColors")
        return { ...scheme, [head]: { ...scheme[head], [tail as keyof Roles]: colour } };
    const palette: Palette = {
        ...scheme.palette,
        root: { ...scheme.palette.root }, window: { ...scheme.palette.window },
        entry: { ...scheme.palette.entry }, selected: { ...scheme.palette.selected },
    };
    if (tail === undefined)
        palette[head as "title" | "shadow"] = colour;
    else
        palette[head as Pair][tail as "fg" | "bg"] = colour;
    return { ...scheme, palette };
}

/** "My dark" from "my-dark": what a new scheme is called in lists until it is given another label. */
export function labelFor(name: string): string {
    const words = name.replace(/-+/g, " ").trim();
    return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** A copy of `base` under a new name, to be changed. */
export function forkScheme(base: Scheme, name: string, from: string): Scheme {
    return {
        label: labelFor(name),
        description: `made from ${from}`,
        palette: {
            ...base.palette, root: { ...base.palette.root }, window: { ...base.palette.window },
            entry: { ...base.palette.entry }, selected: { ...base.palette.selected },
        },
        colors: { ...base.colors },
        rootColors: { ...base.rootColors },
    };
}

/** Text slots whose colour is the very colour they are painted on: unreadable. */
export function collisions(scheme: Scheme): Slot[] {
    return SLOTS.filter(slot => slot.on !== undefined && slotValue(scheme, slot.id) === slotValue(scheme, slot.on));
}

/**
 * What the user typed, as a colour a scheme can hold: one of the sixteen
 * names (in any case, "grey" too), "#rrggbb" or "#rgb". Null when it is none.
 */
export function parseColour(text: string, names: readonly string[]): string | null {
    const typed = text.trim();
    if (!typed)
        return null;
    const lower = typed.toLowerCase().replace(/^grey$/, "gray");
    const named = names.find(name => name.toLowerCase() === lower);
    if (named)
        return named;
    const hex = lower.startsWith("#") ? lower.slice(1) : lower;
    if (/^[0-9a-f]{6}$/.test(hex))
        return `#${hex}`;
    if (/^[0-9a-f]{3}$/.test(hex) && lower.startsWith("#"))
        return `#${[...hex].map(c => c + c).join("")}`;
    return null;
}
