/*
 * Keys Ink has already parsed, turned back into the bytes a terminal sends.
 *
 * The shell is in an emulator inside the TUI, so every key it gets has been
 * through Ink's parser first. Ink's parse loses part of the encoding -- the
 * modifiers on arrows and function keys, the function keys themselves -- so
 * this is the plain VT encoding of what survives: text, Enter, Tab,
 * Backspace, Esc, the arrows and paging keys, Ctrl+letter and Alt+key.
 *
 * Arrows, Home and End have two encodings; which one a program expects is a
 * mode it sets (DECCKM, "application cursor keys": vim, less, readline in
 * some setups), and the emulator knows it.
 */
import type { Key } from "../../tui/keyboard.js";

const ESC = "\x1b";

export interface KeyModes {
    /** DECCKM is set: arrows, Home and End are sent as SS3 (ESC O) sequences. */
    readonly applicationCursor?: boolean;
}

export function keyBytes(input: string, key: Key, modes: KeyModes = {}): string {
    const cursor = modes.applicationCursor ? `${ESC}O` : `${ESC}[`;
    const prefix = key.meta && !key.escape ? ESC : "";
    if (key.return)
        return prefix + "\r";
    if (key.tab)
        return key.shift ? `${ESC}[Z` : prefix + "\t";
    if (key.backspace)
        return prefix + "\x7f";
    if (key.delete)
        return `${ESC}[3~`;
    if (key.escape)
        return ESC;
    if (key.upArrow)
        return cursor + "A";
    if (key.downArrow)
        return cursor + "B";
    if (key.rightArrow)
        return cursor + "C";
    if (key.leftArrow)
        return cursor + "D";
    if (key.home)
        return cursor + "H";
    if (key.end)
        return cursor + "F";
    if (key.pageUp)
        return `${ESC}[5~`;
    if (key.pageDown)
        return `${ESC}[6~`;
    if (key.ctrl && input.length === 1) {
        const code = input.toLowerCase().charCodeAt(0);
        if (code >= 0x61 && code <= 0x7a) // Ctrl+letter
            return prefix + String.fromCharCode(code - 0x60);
        if (input === " " || input === "@")
            return prefix + "\x00";
        if (code >= 0x5b && code <= 0x5f) // Ctrl+[ \ ] ^ _
            return prefix + String.fromCharCode(code - 0x40);
        return "";
    }
    return prefix + input;
}
