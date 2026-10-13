import { describe, it, expect } from "vitest";
import { clean, cleanLines, fit, truncate, width, wrap, formatDuration, formatTimestamp } from "../../src/tui/text.js";
import { glyphs, _private } from "../../src/tui/theme.js";

describe("clean()", () => {
    it("neutralises escape sequences so host text cannot drive the terminal", () => {
        const hostile = "a\x1b[2Jb\x1b]52;c;ZXZpbA==\x07c";
        const cleaned = clean(hostile);
        expect(cleaned).not.toMatch(/\x1b/);
        expect(cleaned).not.toMatch(/\x07/);
        expect(cleaned).toBe("a^[[2Jb^[]52;c;ZXZpbA==^Gc");
    });

    it("drops bidi controls, which would reorder text on screen", () => {
        expect(clean("abc\u202Edef\u2066g\u200Fh")).toBe("abcdefgh");
    });

    it("shows C1 controls and DEL visibly", () => {
        expect(clean("x\x9by\x7fz")).toBe("x\\x9by^?z");
    });

    it("flattens tabs and drops carriage returns", () => {
        expect(clean("a\tb\r")).toBe("a b");
    });

    it("keeps line structure in cleanLines()", () => {
        expect(cleanLines("one\r\ntwo\x1b\nthree")).toEqual(["one", "two^[", "three"]);
    });
});

describe("fitting text", () => {
    it("measures wide characters as two columns", () => {
        expect(width("日本")).toBe(4);
        expect(width("abc")).toBe(3);
    });

    it("truncates with an ellipsis, never splitting a wide character", () => {
        expect(truncate("hello world", 8)).toBe("hello world".slice(0, 8 - width(glyphs.ellipsis)) + glyphs.ellipsis);
        const cut = truncate("日本語テキスト", 6);
        expect(width(cut)).toBeLessThanOrEqual(6);
        expect(cut.endsWith(glyphs.ellipsis)).toBe(true);
    });

    it("leaves short text alone", () => {
        expect(truncate("short", 10)).toBe("short");
    });

    it("pads to an exact width, left or right aligned", () => {
        expect(fit("ab", 5)).toBe("ab   ");
        expect(fit("ab", 5, "right")).toBe("   ab");
        expect(width(fit("日本語", 5))).toBe(5);
        expect(fit("anything", 0)).toBe("");
    });

    it("wraps words, hard-breaks long ones, and keeps explicit newlines", () => {
        expect(wrap("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
        expect(wrap("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
        expect(wrap("one\ntwo", 10)).toEqual(["one", "two"]);
        for (const line of wrap("a sentence that is long enough to wrap several times", 12))
            expect(width(line)).toBeLessThanOrEqual(12);
    });
});

describe("formatting", () => {
    it("formats coarse durations", () => {
        expect(formatDuration(0)).toBe("0 seconds");
        expect(formatDuration(1)).toBe("1 second");
        expect(formatDuration(119)).toBe("1 minute");
        expect(formatDuration(7200)).toBe("2 hours");
        expect(formatDuration(3 * 86400 + 5)).toBe("3 days");
        expect(formatDuration(-1)).toBe("");
    });

    it("formats local timestamps", () => {
        const date = new Date(2026, 0, 2, 3, 4, 5);
        expect(formatTimestamp(date)).toBe("2026-01-02 03:04:05");
        expect(formatTimestamp(date, false)).toBe("2026-01-02 03:04");
        expect(formatTimestamp(Number.NaN)).toBe("");
    });
});

describe("locale detection", () => {
    it("uses Unicode only under a UTF-8 locale, honouring precedence and the override", () => {
        expect(_private.detectUnicode({ LANG: "en_US.UTF-8" })).toBe(true);
        expect(_private.detectUnicode({ LANG: "C" })).toBe(false);
        expect(_private.detectUnicode({})).toBe(false);
        expect(_private.detectUnicode({ LC_ALL: "C", LANG: "en_US.UTF-8" })).toBe(false);
        expect(_private.detectUnicode({ LC_CTYPE: "de_DE.utf8", LANG: "C" })).toBe(true);
        expect(_private.detectUnicode({ LANG: "en_US.UTF-8", COCKPIT_TUI_ASCII: "1" })).toBe(false);
        expect(_private.detectUnicode({ LANG: "C", COCKPIT_TUI_ASCII: "0" })).toBe(true);
    });
});
