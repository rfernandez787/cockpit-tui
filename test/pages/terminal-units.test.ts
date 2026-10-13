/*
 * The Terminal page's small pure pieces: window-size validation (the G1/G2
 * bridge wedges), close-message mapping (G7) and the words for it, and the
 * bytes a parsed key is turned back into.
 */
import { describe, expect, it } from "vitest";
import { clampDimension, measureWindow, MAX_DIMENSION, sameWindow, windowSize } from "../../src/pages/terminal/window.js";
import { describeEnding, endingFromClose, isFailure, noBidi, signalName } from "../../src/pages/terminal/describe.js";
import { keyBytes } from "../../src/pages/terminal/keys.js";
import { makeKey } from "../../src/tui/keyboard.js";

describe("window sizes", () => {
    it("clamps every finite number to an integer in 1..65535", () => {
        expect(clampDimension(24)).toBe(24);
        expect(clampDimension(24.9)).toBe(24);
        expect(clampDimension(0.5)).toBe(1);
        expect(clampDimension(0)).toBe(1);
        expect(clampDimension(-3)).toBe(1);
        expect(clampDimension(65535)).toBe(65535);
        expect(clampDimension(65536)).toBe(MAX_DIMENSION);
        expect(clampDimension(1e12)).toBe(MAX_DIMENSION);
    });

    it("refuses anything that is not a finite number", () => {
        for (const bad of [undefined, null, NaN, Infinity, -Infinity, "24", {}, [24]])
            expect(clampDimension(bad), String(bad)).toBe(null);
    });

    it("makes a size only from two usable values", () => {
        expect(windowSize(0.5, 70000)).toEqual({ rows: 1, cols: 65535 });
        expect(windowSize(40, 132)).toEqual({ rows: 40, cols: 132 });
        expect(windowSize(NaN, 80)).toBe(null);
        expect(windowSize(24, undefined)).toBe(null);
        // Every size it hands out is what the bridge's struct.pack('2H') accepts.
        for (const [r, c] of [[0, 0], [1.5, 2.5], [-1, -1], [65536, 65536], [3e9, 7]] as const) {
            const size = windowSize(r, c)!;
            for (const value of [size.rows, size.cols]) {
                expect(Number.isInteger(value)).toBe(true);
                expect(value).toBeGreaterThanOrEqual(1);
                expect(value).toBeLessThanOrEqual(65535);
            }
        }
    });

    it("compares sizes, with null never equal", () => {
        expect(sameWindow({ rows: 24, cols: 80 }, { rows: 24, cols: 80 })).toBe(true);
        expect(sameWindow({ rows: 24, cols: 80 }, { rows: 24, cols: 81 })).toBe(false);
        expect(sameWindow(null, { rows: 24, cols: 80 })).toBe(false);
        expect(sameWindow(null, null)).toBe(false);
    });

    it("measures the terminal, then COLUMNS/LINES, then 80x24, saying when it guessed", () => {
        expect(measureWindow({ rows: 40, columns: 132 }, {})).toEqual({ rows: 40, cols: 132, assumed: false });
        expect(measureWindow({ rows: 0, columns: 0 }, { LINES: "30", COLUMNS: "90" }))
            .toEqual({ rows: 30, cols: 90, assumed: true });
        expect(measureWindow({}, {})).toEqual({ rows: 24, cols: 80, assumed: true });
        expect(measureWindow({ rows: 50 }, { COLUMNS: "100" })).toEqual({ rows: 50, cols: 100, assumed: true });
        // Junk in the environment is ignored.
        expect(measureWindow({}, { LINES: "-5", COLUMNS: "80x" })).toEqual({ rows: 24, cols: 80, assumed: true });
        expect(measureWindow({}, { LINES: "0", COLUMNS: "" })).toEqual({ rows: 24, cols: 80, assumed: true });
        // Absurd sizes are clamped, never passed on.
        expect(measureWindow({ rows: 100000, columns: 70000 }, {})).toEqual({ rows: 65535, cols: 65535, assumed: false });
    });
});

describe("how a session ended", () => {
    it("maps every close shape (G7)", () => {
        // Client close(): channel.js reports it locally, with nothing in it.
        expect(endingFromClose({ command: "close", channel: "4" }, true)).toEqual({ kind: "killed" });
        // ... and that wins over whatever the transport says afterwards.
        expect(endingFromClose({ problem: "disconnected" }, true)).toEqual({ kind: "killed" });
        expect(endingFromClose({ "exit-status": 0, message: "" }, false)).toEqual({ kind: "exited", status: 0 });
        expect(endingFromClose({ "exit-status": 7, message: "" }, false)).toEqual({ kind: "exited", status: 7 });
        expect(endingFromClose({ "exit-status": -9, message: "" }, false)).toEqual({ kind: "signal", signal: "SIGKILL" });
        expect(endingFromClose({ "exit-status": -1, message: "" }, false)).toEqual({ kind: "signal", signal: "SIGHUP" });
        // The bridge tore down a process it never reaped.
        expect(endingFromClose({ "exit-status": null, message: "" }, false)).toEqual({ kind: "ended" });
        expect(endingFromClose({}, false)).toEqual({ kind: "ended" });
        // The legacy C bridge names the signal.
        expect(endingFromClose({ "exit-signal": "TERM" }, false)).toEqual({ kind: "signal", signal: "SIGTERM" });
        expect(endingFromClose({ "exit-signal": "SIGHUP" }, false)).toEqual({ kind: "signal", signal: "SIGHUP" });
        // Spawn failures.
        expect(endingFromClose({ problem: "not-found" }, false)).toEqual({ kind: "failed", problem: "not-found", message: "" });
        expect(endingFromClose({ problem: "protocol-error", message: "invalid \"environ\"" }, false))
            .toEqual({ kind: "failed", problem: "protocol-error", message: "invalid \"environ\"" });
        // The connection going is not the shell's doing.
        expect(endingFromClose({ problem: "disconnected" }, false)).toEqual({ kind: "lost", problem: "disconnected", message: "" });
        expect(endingFromClose({ problem: "terminated", message: "x" }, false)).toEqual({ kind: "lost", problem: "terminated", message: "x" });
        // Junk is not a status.
        expect(endingFromClose({ "exit-status": "3" }, false)).toEqual({ kind: "ended" });
        expect(endingFromClose({ "exit-status": 2.5 }, false)).toEqual({ kind: "ended" });
    });

    it("names signals", () => {
        expect(signalName(9)).toBe("SIGKILL");
        expect(signalName(15)).toBe("SIGTERM");
        expect(signalName(1)).toBe("SIGHUP");
        expect(signalName(64)).toBe("signal 64");
        expect(signalName(0)).toBe("signal 0");
    });

    it("says it in words, naming the shell and directory for a failed start", () => {
        expect(describeEnding({ kind: "exited", status: 0 })).toBe("Exited");
        expect(describeEnding({ kind: "exited", status: 7 })).toBe("Exited with status 7");
        expect(describeEnding({ kind: "signal", signal: "SIGKILL" })).toBe("Killed by SIGKILL");
        expect(describeEnding({ kind: "killed" })).toBe("Closed from cockpit-tui");
        expect(describeEnding({ kind: "ended" })).toBe("Ended");
        expect(describeEnding({ kind: "lost", problem: "disconnected", message: "" })).toBe("Connection lost");
        expect(describeEnding({ kind: "failed", problem: "not-found", message: "" }, "/bin/zsh", "/home/a"))
            .toBe("Could not start: not found: /bin/zsh or /home/a does not exist");
        expect(describeEnding({ kind: "failed", problem: "access-denied", message: "" }, "/bin/zsh", null))
            .toBe("Could not start: permission denied for /bin/zsh");
        expect(describeEnding({ kind: "failed", problem: "internal-error", message: "Exec format error" }))
            .toBe("Could not start: Exec format error");
        expect(describeEnding({ kind: "failed", problem: "internal-error", message: "" }))
            .toBe("Could not start: internal-error");
    });

    it("treats non-zero exits, signals, failures and a lost connection as failures", () => {
        expect(isFailure({ kind: "exited", status: 0 })).toBe(false);
        expect(isFailure({ kind: "killed" })).toBe(false);
        expect(isFailure({ kind: "ended" })).toBe(false);
        expect(isFailure({ kind: "exited", status: 1 })).toBe(true);
        expect(isFailure({ kind: "signal", signal: "SIGKILL" })).toBe(true);
        expect(isFailure({ kind: "failed", problem: "x", message: "" })).toBe(true);
        expect(isFailure({ kind: "lost", problem: "x", message: "" })).toBe(true);
    });

    it("says a shell the bridge closed while it ran ended, in red, rather than that it could not start", () => {
        const aborted = { kind: "aborted", problem: "internal-error", message: "pty gone" } as const;
        expect(describeEnding(aborted)).toBe("Ended: pty gone");
        expect(describeEnding({ ...aborted, message: "" })).toBe("Ended: internal-error");
        expect(isFailure(aborted)).toBe(true);
    });

    it("blanks bidirectional formatting characters for text shown on the page", () => {
        expect(noBidi("T\u202eLIVE\u2066x\u2069y\u061cz")).toBe("T LIVE x y z");
        expect(noBidi("plain é ü")).toBe("plain é ü");
    });
});

describe("keys for the shell", () => {
    it("turns Ink's parsed keys back into the bytes the terminal sent", () => {
        expect(keyBytes("ab", makeKey())).toBe("ab");
        expect(keyBytes("", makeKey({ return: true }))).toBe("\r");
        expect(keyBytes("", makeKey({ tab: true }))).toBe("\t");
        expect(keyBytes("", makeKey({ tab: true, shift: true }))).toBe("\x1b[Z");
        expect(keyBytes("", makeKey({ backspace: true }))).toBe("\x7f");
        expect(keyBytes("", makeKey({ delete: true }))).toBe("\x1b[3~");
        expect(keyBytes("", makeKey({ escape: true }))).toBe("\x1b");
        expect(keyBytes("", makeKey({ upArrow: true }))).toBe("\x1b[A");
        expect(keyBytes("", makeKey({ leftArrow: true }))).toBe("\x1b[D");
        expect(keyBytes("", makeKey({ pageDown: true }))).toBe("\x1b[6~");
        expect(keyBytes("a", makeKey({ ctrl: true }))).toBe("\x01");
        expect(keyBytes("Z", makeKey({ ctrl: true }))).toBe("\x1a");
        expect(keyBytes("\\", makeKey({ ctrl: true }))).toBe("\x1c");
        expect(keyBytes("b", makeKey({ meta: true }))).toBe("\x1bb");
        expect(keyBytes("", makeKey({ meta: true, return: true }))).toBe("\x1b\r");
        expect(keyBytes("1", makeKey({ ctrl: true }))).toBe("");
        expect(keyBytes("]", makeKey({ ctrl: true }))).toBe("\x1d");
    });

    it("sends arrows, Home and End the way the program in the shell asked for them", () => {
        const app = { applicationCursor: true };
        expect(keyBytes("", makeKey({ upArrow: true }), app)).toBe("\x1bOA");
        expect(keyBytes("", makeKey({ leftArrow: true }), app)).toBe("\x1bOD");
        expect(keyBytes("", makeKey({ home: true }), app)).toBe("\x1bOH");
        expect(keyBytes("", makeKey({ end: true }), app)).toBe("\x1bOF");
        expect(keyBytes("", makeKey({ end: true }))).toBe("\x1b[F");
        // Only those: paging keys have one encoding.
        expect(keyBytes("", makeKey({ pageUp: true }), app)).toBe("\x1b[5~");
    });
});
