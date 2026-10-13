/*
 * The emulator's screen as the rows the Terminal page draws (screen.ts):
 * text where the shell's programs put it, in their colours and attributes,
 * the cursor, wide characters, scrollback -- and nothing of the escape
 * sequences themselves.
 */
import { afterEach, describe, expect, it } from "vitest";
import xterm from "@xterm/headless";
import type { Terminal as Emulator } from "@xterm/headless";
import { paletteColor, screenRows, scrolledLines, type Row } from "../../src/pages/terminal/screen.js";

const made: Emulator[] = [];

afterEach(() => {
    for (const emulator of made.splice(0))
        emulator.dispose();
});

async function emulate(output: string, cols = 20, rows = 4): Promise<Emulator> {
    const emulator = new xterm.Terminal({ cols, rows, scrollback: 100, allowProposedApi: true });
    made.push(emulator);
    await new Promise<void>(resolve => emulator.write(output, resolve));
    return emulator;
}

const text = (row: Row) => row.map(run => run.text).join("");
const PLAIN = { cursor: false, ascii: false };

describe("the screen as rows", () => {
    it("gives every row, each as wide as the screen", async () => {
        const rows = screenRows(await emulate("hello\r\nworld"), PLAIN);
        expect(rows.map(text)).toEqual(["hello".padEnd(20), "world".padEnd(20), " ".repeat(20), " ".repeat(20)]);
    });

    it("puts text where cursor movement put it, and erases what was erased", async () => {
        const rows = screenRows(await emulate("aaaa\r\nbbbb\x1b[1;3Hxx\x1b[2;1H\x1b[K\x1b[3;5Hend"), PLAIN);
        expect(rows.map(row => text(row).trimEnd())).toEqual(["aaxx", "", "    end", ""]);
    });

    it("splits a row into runs by colour and attribute", async () => {
        const [row] = screenRows(await emulate("a\x1b[31mred\x1b[1;4mbold\x1b[0m \x1b[42mbg\x1b[0m"), PLAIN);
        expect(row!.slice(0, 5)).toEqual([
            { text: "a" },
            { text: "red", fg: "red" },
            { text: "bold", fg: "red", bold: true, underline: true },
            { text: " " },
            { text: "bg", bg: "green" },
        ]);
    });

    it("names the basic sixteen colours and gives the rest as hex", async () => {
        const [row] = screenRows(await emulate("\x1b[94mb\x1b[38;5;196mc\x1b[38;5;244mg\x1b[38;2;1;2;3mt\x1b[48;5;21mB"), PLAIN);
        expect(row!.slice(0, 5).map(run => run.fg)).toEqual(["blueBright", "#ff0000", "#808080", "#010203", "#010203"]);
        expect(row![4]!.bg).toBe("#0000ff");
        expect(paletteColor(0)).toBe("black");
        expect(paletteColor(15)).toBe("whiteBright");
        expect(paletteColor(16)).toBe("#000000");
        expect(paletteColor(231)).toBe("#ffffff");
        expect(paletteColor(232)).toBe("#080808");
        expect(paletteColor(256)).toBeUndefined();
    });

    it("marks inverse video, dim and italic", async () => {
        const [row] = screenRows(await emulate("\x1b[7minv\x1b[0m\x1b[2mdim\x1b[0m\x1b[3mit"), PLAIN);
        expect(row!.slice(0, 3)).toEqual([
            { text: "inv", inverse: true }, { text: "dim", dim: true }, { text: "it", italic: true },
        ]);
    });

    it("draws the cursor's cell inverted when asked, and not when the program hid it", async () => {
        const shown = await emulate("ab");
        expect(screenRows(shown, { cursor: true, ascii: false })[0]!.slice(0, 2)).toEqual([{ text: "ab" }, { text: " ", inverse: true }]);
        expect(screenRows(shown, PLAIN)[0]).toEqual([{ text: "ab".padEnd(20) }]);
        const hidden = await emulate("ab\x1b[?25l");
        expect(screenRows(hidden, { cursor: true, ascii: false })[0]).toEqual([{ text: "ab".padEnd(20) }]);
    });

    it("keeps a wide character to its two columns", async () => {
        const [row] = screenRows(await emulate("日本x", 8), PLAIN);
        expect(text(row!)).toBe("日本x   ");
    });

    it("has only ASCII for a terminal without Unicode", async () => {
        const [row] = screenRows(await emulate("é日x─", 8), { cursor: false, ascii: true });
        expect(text(row!)).toBe("???x?   ");
    });

    it("leaves no control byte and no bidi control in what it gives", async () => {
        const emulator = await emulate("a\x1b]0;title\x07b\x1b]52;c;QUJD\x07c‮d\x1b[6n\x07e\tf");
        const all = screenRows(emulator, PLAIN).map(text).join("\n");
        // eslint-disable-next-line no-control-regex
        expect(all).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/);
        expect(all.split("\n")[0]!.startsWith("abcde")).toBe(true);
    });

    it("hides text the program made invisible", async () => {
        const [row] = screenRows(await emulate("a\x1b[8msecret\x1b[0mb"), PLAIN);
        expect(text(row!).trimEnd()).toBe("a      b");
    });

    it("shows the scrollback when scrolled, without a cursor", async () => {
        const emulator = await emulate("1\r\n2\r\n3\r\n4\r\n5\r\n6", 6, 3);
        expect(screenRows(emulator, PLAIN).map(row => text(row).trim())).toEqual(["4", "5", "6"]);
        expect(scrolledLines(emulator)).toBe(0);
        emulator.scrollLines(-2);
        expect(scrolledLines(emulator)).toBe(2);
        const rows = screenRows(emulator, { cursor: true, ascii: false });
        expect(rows.map(row => text(row).trim())).toEqual(["2", "3", "4"]);
        expect(rows.flat().some(run => run.inverse)).toBe(false);
    });

    it("shows the alternate screen of a full-screen program, and the shell's again after it", async () => {
        const emulator = await emulate("prompt$ \x1b[?1049h\x1b[2J\x1b[Hvim here");
        expect(screenRows(emulator, PLAIN).map(row => text(row).trim())).toEqual(["vim here", "", "", ""]);
        await new Promise<void>(resolve => emulator.write("\x1b[?1049l", resolve));
        expect(text(screenRows(emulator, PLAIN)[0]!).trimEnd()).toBe("prompt$");
    });
});
