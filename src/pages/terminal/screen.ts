/*
 * The emulator's screen as lines the page can draw: for each row of the
 * view, runs of cells that share their colours and attributes.
 *
 * The emulator (xterm.js, headless) has already taken every control byte
 * out of the shell's output: what is left in a cell is a character and how
 * to draw it. That is what makes host output safe here -- nothing the shell
 * prints reaches the real terminal as an escape sequence, only as text in
 * colours this page chooses. Characters go out as they are, except for the
 * bidirectional controls, which would reorder the rest of the line on
 * terminals that implement them.
 *
 * Colours: the 16 basic ones by name, so the user's own scheme applies as in
 * any terminal; the 256-colour cube and true colour as hex, which the real
 * terminal's colour depth then decides (chalk downsamples). A cell without
 * colours has the window's.
 */
import type { IBufferCell, Terminal as Emulator } from "@xterm/headless";
import { BIDI_CONTROLS } from "./describe.js";

export interface Run {
    readonly text: string;
    /** An Ink colour: a name or "#rrggbb"; undefined for the window's own. */
    readonly fg?: string;
    readonly bg?: string;
    readonly bold?: boolean;
    readonly dim?: boolean;
    readonly italic?: boolean;
    readonly underline?: boolean;
    /** Foreground and background swapped: SGR 7, or the cursor's cell. */
    readonly inverse?: boolean;
}

export type Row = readonly Run[];

const NAMES = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "gray", "redBright", "greenBright", "yellowBright", "blueBright", "magentaBright", "cyanBright", "whiteBright",
] as const;

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map(v => v.toString(16).padStart(2, "0")).join("")}`;

/** A palette index as an Ink colour: xterm's 256-colour table. */
export function paletteColor(index: number): string | undefined {
    if (!Number.isInteger(index) || index < 0 || index > 255)
        return undefined;
    if (index < 16)
        return NAMES[index];
    if (index < 232) {
        const n = index - 16;
        const level = (v: number) => (v === 0 ? 0 : 55 + 40 * v);
        return hex(level(Math.floor(n / 36)), level(Math.floor(n / 6) % 6), level(n % 6));
    }
    const grey = 8 + 10 * (index - 232);
    return hex(grey, grey, grey);
}

function rgbColor(value: number): string {
    return hex((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}

function style(cell: IBufferCell): Omit<Run, "text"> {
    const fg = cell.isFgPalette() ? paletteColor(cell.getFgColor()) : cell.isFgRGB() ? rgbColor(cell.getFgColor()) : undefined;
    const bg = cell.isBgPalette() ? paletteColor(cell.getBgColor()) : cell.isBgRGB() ? rgbColor(cell.getBgColor()) : undefined;
    return {
        ...(fg ? { fg } : {}),
        ...(bg ? { bg } : {}),
        ...(cell.isBold() ? { bold: true } : {}),
        ...(cell.isDim() ? { dim: true } : {}),
        ...(cell.isItalic() ? { italic: true } : {}),
        ...(cell.isUnderline() ? { underline: true } : {}),
        ...(cell.isInverse() ? { inverse: true } : {}),
    };
}

function sameStyle(a: Omit<Run, "text">, b: Omit<Run, "text">): boolean {
    return a.fg === b.fg && a.bg === b.bg && !a.bold === !b.bold && !a.dim === !b.dim && !a.italic === !b.italic &&
        !a.underline === !b.underline && !a.inverse === !b.inverse;
}

/** The cursor is hidden (DECTCEM off). xterm.js has no public reading of it. */
function cursorHidden(emulator: Emulator): boolean {
    const core = (emulator as unknown as { _core?: { coreService?: { isCursorHidden?: unknown } } })._core;
    return core?.coreService?.isCursorHidden === true;
}

export interface ScreenOptions {
    /** Draw the cursor's cell inverted (when the program shows a cursor and the view is not scrolled back). */
    readonly cursor: boolean;
    /** The real terminal has no Unicode: anything else becomes "?". */
    readonly ascii: boolean;
}

/** The rows now in view, each exactly as wide as the emulator. */
export function screenRows(emulator: Emulator, options: ScreenOptions): Row[] {
    const buffer = emulator.buffer.active;
    const scrolledBack = buffer.viewportY !== buffer.baseY;
    const showCursor = options.cursor && !scrolledBack && !cursorHidden(emulator);
    const rows: Row[] = [];
    let cell: IBufferCell | undefined;

    for (let y = 0; y < emulator.rows; y++) {
        const line = buffer.getLine(buffer.viewportY + y);
        const runs: Run[] = [];
        let text = "";
        let current: Omit<Run, "text"> = {};
        const flush = () => {
            if (text)
                runs.push({ text, ...current });
            text = "";
        };
        for (let x = 0; x < emulator.cols; x++) {
            cell = line?.getCell(x, cell);
            // The second half of a wide character: its first half drew both.
            if (cell && cell.getWidth() === 0)
                continue;
            let chars = cell?.getChars() || " ";
            let next = cell ? style(cell) : {};
            if (cell?.isInvisible())
                chars = " ".repeat(Math.max(1, cell.getWidth()));
            chars = chars.replace(BIDI_CONTROLS, "");
            if (options.ascii && /[^\x20-\x7e]/.test(chars))
                chars = "?".repeat(Math.max(1, cell?.getWidth() ?? 1));
            if (!chars)
                chars = " ";
            if (showCursor && y === buffer.cursorY && x === buffer.cursorX)
                next = { ...next, inverse: !next.inverse };
            if (!sameStyle(next, current)) {
                flush();
                current = next;
            }
            text += chars;
        }
        flush();
        rows.push(runs);
    }
    return rows;
}

/** How far the view is scrolled back, for "42 lines up": 0 at the bottom. */
export function scrolledLines(emulator: Emulator): number {
    const buffer = emulator.buffer.active;
    return buffer.baseY - buffer.viewportY;
}
