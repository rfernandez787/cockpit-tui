/*
 * Colours and glyphs.
 *
 * The TUI is for places a browser cannot go -- serial consoles, bare VTs,
 * minimal SSH sessions -- so nothing may depend on colour or Unicode alone.
 * Every state has a text form and colour only reinforces it; selection is a
 * marker glyph as well as its colours. Without a UTF-8 locale the glyphs
 * fall back to ASCII. COCKPIT_TUI_ASCII=1 (or 0) overrides the detection.
 */

import chalk from "chalk";
import { readConfig } from "../config.js";

function detectUnicode(env: NodeJS.ProcessEnv = process.env): boolean {
    const forced = env.COCKPIT_TUI_ASCII;
    if (forced === "1" || forced === "true")
        return false;
    if (forced === "0" || forced === "false")
        return true;
    // POSIX precedence: the first of these that is set and non-empty wins.
    const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
    return /utf-?8/i.test(locale);
}

export const unicode = detectUnicode();

export const glyphs = unicode
    ? {
        pointer: "›",
        arrow: "→",
        dot: "·",
        cursor: "▏",
        updown: "↑↓",
        leftright: "←→",
        bullet: "●",
        hollow: "○",
        ellipsis: "…",
        up: "↑",
        down: "↓",
        barFull: "█",
        barEmpty: "░",
        separator: "│",
        spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
        check: "✓",
        cross: "✗",
        warning: "!",
    }
    : {
        pointer: ">",
        arrow: "->",
        dot: "-",
        cursor: "|",
        updown: "up/dn",
        leftright: "<-/->",
        bullet: "*",
        hollow: "o",
        ellipsis: "...",
        up: "^",
        down: "v",
        barFull: "#",
        barEmpty: ".",
        separator: "|",
        spinner: ["|", "/", "-", "\\"],
        check: "+",
        cross: "x",
        warning: "!",
    };

/** Ink border style for boxes and dialogs: newt's plain single line. */
export const borderStyle = unicode ? "single" as const : "classic" as const;

/**
 * The pieces of a border that are drawn by hand: a window's top border, around
 * its title, and the panels a page builds line by line. They match borderStyle.
 */
export const frame = unicode
    ? { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│", titleLeft: "┤", titleRight: "├" }
    : { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|", titleLeft: "|", titleRight: "|" };

/**
 * A real terminal with every style switched off (FORCE_COLOR=0, TERM=dumb):
 * inverse video is gone, so things drawn with it need a glyph instead.
 * (Not merely a non-terminal: tests render without styles too.)
 */
export const unstyledTerminal = chalk.level === 0 && process.stdout.isTTY === true;

/**
 * NO_COLOR (no-color.org): no colours, but bold and inverse stay, since the
 * selection and the text cursor rely on them. Ink only applies colour names
 * it recognises, so the "none" below simply leaves text uncoloured.
 */
export const noColor = Boolean(process.env.NO_COLOR);

/**
 * Whether the newt look is painted: a root, windows with a shadow and entry
 * fields in the palette's colours, as in nmtui and whiptail. It needs colour. With NO_COLOR
 * or no styling at all the layout is the same but nothing is painted, and
 * selection and the cursor fall back to inverse video and glyphs.
 */
export const styled = chalk.level > 0 && !noColor;

/**
 * The terminal has more than the basic sixteen colours (256 or true colour):
 * a scheme can then tell the screen, a window and its shadow apart by shades.
 * With sixteen (a Linux console) each scheme has a second palette made of
 * colour names only.
 */
export const richColor = chalk.level >= 2;

export interface Palette {
    root: { fg: string, bg: string };
    /** Keys on the help line and the host name in the root text. */
    rootBright: string;
    window: { fg: string, bg: string };
    title: string;
    shadow: string;
    entry: { fg: string, bg: string };
    /** The row the cursor is on in a list. */
    selected: { fg: string, bg: string };
}

export type Roles = Record<"accent" | "ok" | "warning" | "error" | "dim" | "info", string>;

const clone = (p: Palette): Palette => ({ ...p, root: { ...p.root }, window: { ...p.window }, entry: { ...p.entry }, selected: { ...p.selected } });

/** One colour scheme: what is painted, and the text colours that read on it. */
export interface Scheme {
    readonly label: string;
    readonly description: string;
    readonly palette: Palette;
    /** Text in a window. */
    readonly colors: Roles;
    /** Text on the root: the header and the help line. */
    readonly rootColors: Roles;
}

/**
 * The colour schemes, by name. Values are Ink colours: names from the basic
 * sixteen, which a Linux console shows as a terminal emulator does, and hex
 * values where the terminal has more (`richColor`). The palette's roles are
 * newt's own (see NEWT_COLORS in whiptail(1)); the layout is the same in
 * every scheme.
 */
const schemesFor = (rich: boolean) => ({
    dark: rich
        // Three depths of dark: the screen, the windows a step lighter, and
        // a black shadow that shows against both. "gray" (bright black) is
        // too close to the lighter window for dim text: a grey that reads on it.
        ? {
            label: "Dark",
            description: "dark grey windows on a darker screen",
            palette: {
                root: { fg: "white", bg: "#1c1c1c" }, rootBright: "whiteBright", window: { fg: "white", bg: "#3a3a3a" },
                title: "cyanBright", shadow: "#000000", entry: { fg: "whiteBright", bg: "blue" }, selected: { fg: "black", bg: "cyan" },
            },
            colors: { accent: "cyanBright", ok: "greenBright", warning: "yellowBright", error: "redBright", dim: "#a8a8a8", info: "blueBright" },
            rootColors: { accent: "whiteBright", ok: "greenBright", warning: "yellowBright", error: "redBright", dim: "#a8a8a8", info: "cyanBright" },
        }
        : {
            label: "Dark",
            description: "black windows on a black screen",
            palette: {
                root: { fg: "white", bg: "black" }, rootBright: "whiteBright", window: { fg: "white", bg: "black" },
                title: "cyanBright", shadow: "gray", entry: { fg: "whiteBright", bg: "blue" }, selected: { fg: "black", bg: "cyan" },
            },
            colors: { accent: "cyanBright", ok: "greenBright", warning: "yellowBright", error: "redBright", dim: "gray", info: "blueBright" },
            rootColors: { accent: "whiteBright", ok: "greenBright", warning: "yellowBright", error: "redBright", dim: "gray", info: "cyanBright" },
        },
    light: rich
        ? {
            label: "Light",
            description: "near-white windows on a grey screen",
            palette: {
                root: { fg: "black", bg: "#bcbcbc" }, rootBright: "black", window: { fg: "black", bg: "#eeeeee" },
                title: "blue", shadow: "#6c6c6c", entry: { fg: "whiteBright", bg: "blue" }, selected: { fg: "whiteBright", bg: "blue" },
            },
            // Yellow does not read on a light window: a dark orange for warnings.
            colors: { accent: "blue", ok: "#008700", warning: "#af5f00", error: "#d70000", dim: "#626262", info: "blue" },
            rootColors: { accent: "black", ok: "#005f00", warning: "#875f00", error: "#af0000", dim: "#444444", info: "blue" },
        }
        : {
            label: "Light",
            description: "white windows on a grey screen",
            palette: {
                root: { fg: "black", bg: "white" }, rootBright: "black", window: { fg: "black", bg: "whiteBright" },
                title: "blue", shadow: "gray", entry: { fg: "whiteBright", bg: "blue" }, selected: { fg: "whiteBright", bg: "blue" },
            },
            colors: { accent: "blue", ok: "green", warning: "magenta", error: "red", dim: "gray", info: "blue" },
            rootColors: { accent: "black", ok: "green", warning: "magenta", error: "red", dim: "gray", info: "blue" },
        },
    midnight: rich
        ? {
            label: "Midnight",
            description: "deep blue windows, soft colours",
            palette: {
                root: { fg: "#c0caf5", bg: "#0f1424" }, rootBright: "whiteBright", window: { fg: "#c0caf5", bg: "#1f2a48" },
                title: "#7dcfff", shadow: "#000000", entry: { fg: "whiteBright", bg: "#414f80" }, selected: { fg: "#0f1424", bg: "#7aa2f7" },
            },
            colors: { accent: "#7dcfff", ok: "#9ece6a", warning: "#e0af68", error: "#f7768e", dim: "#8f9ac4", info: "#7aa2f7" },
            rootColors: { accent: "whiteBright", ok: "#9ece6a", warning: "#e0af68", error: "#f7768e", dim: "#8f9ac4", info: "#7dcfff" },
        }
        : {
            label: "Midnight",
            description: "blue windows on a black screen",
            palette: {
                root: { fg: "white", bg: "black" }, rootBright: "whiteBright", window: { fg: "whiteBright", bg: "blue" },
                title: "yellowBright", shadow: "gray", entry: { fg: "whiteBright", bg: "black" }, selected: { fg: "black", bg: "cyan" },
            },
            colors: { accent: "cyanBright", ok: "greenBright", warning: "yellowBright", error: "redBright", dim: "white", info: "cyanBright" },
            rootColors: { accent: "whiteBright", ok: "greenBright", warning: "yellowBright", error: "redBright", dim: "gray", info: "cyanBright" },
        },
    // nmtui's and whiptail's own: the basic colours only, at any depth.
    newt: {
        label: "Newt",
        description: "nmtui's own: a blue screen, light grey windows",
        palette: {
            root: { fg: "white", bg: "blue" }, rootBright: "whiteBright", window: { fg: "black", bg: "white" },
            title: "red", shadow: "black", entry: { fg: "white", bg: "blue" }, selected: { fg: "whiteBright", bg: "blue" },
        },
        colors: { accent: "blue", ok: "green", warning: "magenta", error: "red", dim: "gray", info: "blue" },
        rootColors: { accent: "whiteBright", ok: "greenBright", warning: "yellowBright", error: "redBright", dim: "white", info: "cyanBright" },
    },
}) satisfies Record<string, Scheme>;

/** Both depths, built once: the one this terminal shows, and the other for tests of it. */
const BY_DEPTH = { rich: schemesFor(true), plain: schemesFor(false) };
const SCHEMES = richColor ? BY_DEPTH.rich : BY_DEPTH.plain;

/** A scheme's name: a built-in one, or one the viewer made (the Colours page). */
export type ThemeName = string;
export type BuiltinTheme = keyof typeof SCHEMES;

export const DEFAULT_THEME: BuiltinTheme = "dark";

const BUILTIN_NAMES = Object.keys(SCHEMES) as BuiltinTheme[];

/** The viewer's own schemes, by name, in the order they were made. */
const custom = new Map<string, Scheme>();

export interface ThemeInfo {
    readonly name: ThemeName;
    readonly label: string;
    readonly description: string;
    /** Made by the viewer: it can be changed, renamed and deleted. */
    readonly custom: boolean;
}

/** The schemes on offer, in the picker's order: the built-in ones, then the viewer's own. */
export function listThemes(): ThemeInfo[] {
    return [
        ...BUILTIN_NAMES.map(name => ({ name, label: SCHEMES[name].label, description: SCHEMES[name].description, custom: false })),
        ...[...custom].map(([name, scheme]) => ({ name, label: scheme.label, description: scheme.description, custom: true })),
    ];
}

export function isBuiltinTheme(value: unknown): value is BuiltinTheme {
    return typeof value === "string" && Object.hasOwn(SCHEMES, value);
}

export function isThemeName(value: unknown): value is ThemeName {
    return isBuiltinTheme(value) || (typeof value === "string" && custom.has(value));
}

/**
 * Everything a scheme defines. A built-in one at this terminal's colour
 * depth or the given one (tests check both); a custom one is the same at any
 * depth -- where the terminal has sixteen colours, its shades are shown as
 * the nearest of those.
 */
export function schemeOf(name: ThemeName, rich: boolean = richColor): Scheme {
    const own = custom.get(name);
    if (own)
        return own;
    return (rich ? BY_DEPTH.rich : BY_DEPTH.plain)[isBuiltinTheme(name) ? name : DEFAULT_THEME];
}

const COLOUR_NAMES = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "gray", "redBright", "greenBright", "yellowBright", "blueBright", "magentaBright", "cyanBright", "whiteBright",
] as const;

/** The sixteen colours every terminal has, by the names Ink knows them by. */
export const BASIC_COLOURS: readonly string[] = COLOUR_NAMES;

/** A colour a scheme may hold: one of the sixteen names, or "#rrggbb". */
export function isColour(value: unknown): value is string {
    return typeof value === "string" && ((COLOUR_NAMES as readonly string[]).includes(value) || /^#[0-9a-f]{6}$/.test(value));
}

const PAIRS = ["root", "window", "entry", "selected"] as const;
const SINGLES = ["rootBright", "title", "shadow"] as const;
const ROLE_NAMES = ["accent", "ok", "warning", "error", "dim", "info"] as const;

/**
 * A scheme read from the settings file, which anyone may have edited: every
 * colour checked, anything missing or wrong taken from `base`. Null when it
 * is not a scheme at all.
 */
export function parseScheme(value: unknown, base: Scheme = schemeOf(DEFAULT_THEME)): Scheme | null {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const v = value as Record<string, unknown>;
    const record = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {});
    const colour = (x: unknown, fallback: string) => (isColour(x) ? x : fallback);
    const p = record(v.palette);
    const palette = clone(base.palette);
    for (const pair of PAIRS) {
        palette[pair] = { fg: colour(record(p[pair]).fg, base.palette[pair].fg), bg: colour(record(p[pair]).bg, base.palette[pair].bg) };
    }
    for (const single of SINGLES)
        palette[single] = colour(p[single], base.palette[single]);
    const roles = (x: unknown, fallback: Roles): Roles =>
        Object.fromEntries(ROLE_NAMES.map(role => [role, colour(record(x)[role], fallback[role])])) as Roles;
    return {
        label: typeof v.label === "string" && v.label.trim() ? v.label.trim().slice(0, 40) : "Custom",
        description: typeof v.description === "string" ? v.description.slice(0, 80) : "",
        palette,
        colors: roles(v.colors, base.colors),
        rootColors: roles(v.rootColors, base.rootColors),
    };
}

/** A name a custom scheme may have: short, lower case, and not a built-in one's. */
export function schemeNameProblem(name: string): string | null {
    if (!name)
        return "Give the scheme a name";
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(name))
        return "Lower-case letters, digits and dashes, starting with a letter, at most 24";
    if (isBuiltinTheme(name))
        return `${name} is a built-in scheme`;
    return null;
}

/**
 * Replace the viewer's schemes with those in the settings file's "schemes"
 * (config.ts). Entries with a bad name, or that are not schemes, are left out.
 */
export function loadCustomSchemes(value: unknown): void {
    custom.clear();
    if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [name, entry] of Object.entries(value)) {
            const scheme = schemeNameProblem(name) === null ? parseScheme(entry) : null;
            if (scheme)
                custom.set(name, scheme);
        }
    }
    if (!isThemeName(current))
        setTheme(DEFAULT_THEME);
}

/** The viewer's schemes as the settings file holds them. */
export function customSchemes(): Record<string, Scheme> {
    return Object.fromEntries(custom);
}

/**
 * The scheme at startup: COCKPIT_TUI_THEME if it names one, else the one the
 * picker last saved (config.ts), else the default. `--theme` is applied over
 * this by the command line (cli.ts), with setTheme().
 */
function initialTheme(): ThemeName {
    const config = readConfig();
    for (const [name, entry] of Object.entries(config.schemes && typeof config.schemes === "object" ? config.schemes : {})) {
        const scheme = /^[a-z][a-z0-9-]{0,23}$/.test(name) && !Object.hasOwn(SCHEMES, name) ? parseScheme(entry) : null;
        if (scheme)
            custom.set(name, scheme);
    }
    const fromEnvironment = process.env.COCKPIT_TUI_THEME;
    if (isThemeName(fromEnvironment))
        return fromEnvironment;
    return isThemeName(config.theme) ? config.theme : DEFAULT_THEME;
}

/** Without colour the usual text colours, on whatever the terminal's own background is. */
const UNPAINTED: Roles = noColor
    ? { accent: "none", ok: "none", warning: "none", error: "none", dim: "none", info: "none" }
    : { accent: "cyan", ok: "green", warning: "yellow", error: "red", dim: "gray", info: "blue" };


/**
 * The palette in use. One object for the life of the program, changed in
 * place by setTheme(): every module that imported it sees the new colours
 * the next time it reads them. Do not copy its values at module load.
 */
let current: ThemeName = initialTheme();

export const palette: Palette = clone(schemeOf(current).palette);

/**
 * The shadow under a window is half a row: a terminal's cells are about twice
 * as tall as they are wide, so a whole row would be twice the column at the
 * window's side. It is drawn as upper half blocks in the shadow's colour, on
 * whatever is beneath. null without Unicode: there the whole row is painted.
 */
export const shadowBelow: string | null = unicode ? "▀" : null;

/**
 * Colour roles for text in a window. Values are Ink colours, applied as
 * foreground colours. When the look is painted they are the scheme's, chosen
 * to read on its window; otherwise the terminal's own background is left
 * alone and they are the usual ones. Changed in place by setTheme(), like
 * the palette.
 */
export const colors: Roles = { ...(styled ? schemeOf(current).colors : UNPAINTED) };

/** The same roles for text on the root: the header and the help line. */
export const rootColors: Roles = { ...(styled ? schemeOf(current).rootColors : UNPAINTED) };

const themeListeners = new Set<() => void>();

/** The scheme in use. */
export function themeName(): ThemeName {
    return current;
}

let version = 0;

/**
 * Changes with everything that changes what is painted: another scheme, or
 * the one in use being edited. What the shell re-renders on; the scheme's
 * name alone (themeName()) is what remounts a page.
 */
export function themeVersion(): number {
    return version;
}

function notify(): void {
    version++;
    for (const listener of [...themeListeners]) {
        try {
            listener();
        } catch (error) {
            console.error("theme listener failed:", error);
        }
    }
}

/** Put a scheme's colours into the palette and the roles everyone imported. */
function paint(scheme: Scheme): void {
    Object.assign(palette, clone(scheme.palette));
    if (styled) {
        Object.assign(colors, scheme.colors);
        Object.assign(rootColors, scheme.rootColors);
    }
}

/** Switch schemes: the palette and the roles change in place, and whoever subscribed is told. */
export function setTheme(name: ThemeName): void {
    if (name === current || !isThemeName(name))
        return;
    current = name;
    paint(schemeOf(name));
    notify();
}

/**
 * Show these colours without changing which scheme is in use: the Colours
 * page trying a colour before it is kept. applyScheme(null) goes back to the
 * scheme in use as it is stored.
 */
export function applyScheme(scheme: Scheme | null): void {
    paint(scheme ?? schemeOf(current));
    notify();
}

/** Add one of the viewer's own schemes, or replace it; if it is the one in use, it is repainted. */
export function registerScheme(name: string, scheme: Scheme): void {
    if (schemeNameProblem(name) !== null)
        throw new Error(`not a name for a custom scheme: ${name}`);
    custom.set(name, { ...scheme, palette: clone(scheme.palette), colors: { ...scheme.colors }, rootColors: { ...scheme.rootColors } });
    if (name === current)
        paint(schemeOf(name));
    notify();
}

/** Remove one of the viewer's own schemes; if it was in use, the default takes over. */
export function removeScheme(name: string): void {
    if (!custom.delete(name))
        return;
    if (name === current) {
        current = DEFAULT_THEME;
        paint(schemeOf(current));
    }
    notify();
}

/** For useSyncExternalStore: called after every change to what is painted or to the list of schemes. */
export function subscribeTheme(listener: () => void): () => void {
    themeListeners.add(listener);
    return () => themeListeners.delete(listener);
}

/**
 * Background used to blank the area under an overlay.
 *
 * Deliberately not a colour: Ink's background pass writes spaces for any
 * truthy value but only styles names it recognises, so this clears what is
 * underneath a dialog without imposing a colour on the user's scheme.
 */
export const overlayFill = "none";

export type Severity = "info" | "success" | "warning" | "error";

export function severityColor(severity: Severity): string {
    switch (severity) {
    case "success": return colors.ok;
    case "warning": return colors.warning;
    case "error": return colors.error;
    default: return colors.accent;
    }
}

export const _private = { detectUnicode };
