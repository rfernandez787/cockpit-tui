import { describe, it, expect } from "vitest";
import {
    StreamFrameParser, ProtocolError, splitFrame,
    encodeStreamFrame, encodeWsFrame,
} from "../src/transport/framing.js";

describe("stream framing", () => {
    it("encodes the byte-level example from doc/protocol.md", () => {
        // "a payload of the string 'abc' ... through the channel 'a5'" => 6\na5\nabc
        const frame = encodeStreamFrame("a5", "abc");
        expect(frame.toString("utf8")).toBe("6\na5\nabc");
        expect([...frame]).toEqual([0x36, 0x0a, 0x61, 0x35, 0x0a, 0x61, 0x62, 0x63]);
    });

    it("encodes a control frame with an empty channel id", () => {
        const json = '{"command":"init","version":1,"host":"localhost"}';
        const frame = encodeStreamFrame("", json);
        // length counts the channel id, its LF, and the payload => 0 + 1 + 49
        expect(frame.toString("utf8")).toBe(`${json.length + 1}\n\n${json}`);
    });

    it("round-trips through the parser", () => {
        const parser = new StreamFrameParser();
        const frames = parser.push(encodeStreamFrame("a5", "abc"));
        expect(frames).toHaveLength(1);
        expect(frames[0]!.channel).toBe("a5");
        expect(frames[0]!.payload.toString()).toBe("abc");
    });

    it("reads a control frame as the empty channel", () => {
        const parser = new StreamFrameParser();
        const [frame] = parser.push(encodeStreamFrame("", '{"command":"init"}'));
        expect(frame!.channel).toBe("");
        expect(JSON.parse(frame!.payload.toString())).toEqual({ command: "init" });
    });

    it("is length-driven, not line-driven: payloads may contain newlines", () => {
        // The bridge pretty-prints control JSON with indent=2, so this is the
        // normal case, not an edge case.
        const pretty = JSON.stringify({ command: "init", version: 1 }, null, 2) + "\n";
        const parser = new StreamFrameParser();
        const [frame] = parser.push(encodeStreamFrame("", pretty));
        expect(frame!.channel).toBe("");
        expect(frame!.payload.toString()).toBe(pretty);
    });

    it("reassembles a frame split across arbitrary chunk boundaries", () => {
        const whole = encodeStreamFrame("c7", "hello world");
        for (let cut = 1; cut < whole.length; cut++) {
            const parser = new StreamFrameParser();
            expect(parser.push(whole.subarray(0, cut))).toHaveLength(0);
            const frames = parser.push(whole.subarray(cut));
            expect(frames).toHaveLength(1);
            expect(frames[0]!.payload.toString()).toBe("hello world");
        }
    });

    it("returns several frames coalesced in one chunk", () => {
        const parser = new StreamFrameParser();
        const frames = parser.push(Buffer.concat([
            encodeStreamFrame("", '{"command":"ready","channel":"x"}'),
            encodeStreamFrame("x", "one"),
            encodeStreamFrame("x", "two"),
        ]));
        expect(frames.map(f => f.channel)).toEqual(["", "x", "x"]);
        expect(frames[2]!.payload.toString()).toBe("two");
    });

    it("preserves binary payloads exactly", () => {
        // Bytes that are invalid UTF-8 and include LF and NUL.
        const blob = Buffer.from([0x00, 0x0a, 0xff, 0xfe, 0x0a, 0x42]);
        const parser = new StreamFrameParser();
        const [frame] = parser.push(encodeStreamFrame("b1", blob));
        expect(frame!.payload.equals(blob)).toBe(true);
    });

    it("computes length in bytes, not characters, for multi-byte UTF-8", () => {
        const text = "café ☕";
        const frame = encodeStreamFrame("u1", text);
        const declared = Number(frame.subarray(0, frame.indexOf(0x0a)).toString());
        expect(declared).toBe(Buffer.byteLength("u1\n" + text, "utf8"));

        const parser = new StreamFrameParser();
        const [parsed] = parser.push(frame);
        expect(parsed!.payload.toString("utf8")).toBe(text);
    });

    it("holds back an incomplete frame without consuming it", () => {
        const parser = new StreamFrameParser();
        expect(parser.push(Buffer.from("6\na5\nab"))).toHaveLength(0);
        expect(parser.pending).toBeGreaterThan(0);
        expect(parser.push(Buffer.from("c"))).toHaveLength(1);
        expect(parser.pending).toBe(0);
    });

    it("rejects a non-integer size line", () => {
        const parser = new StreamFrameParser();
        expect(() => parser.push(Buffer.from("abc\nx\n"))).toThrow(ProtocolError);
    });

    it("rejects a leading-zero size line as non-canonical", () => {
        const parser = new StreamFrameParser();
        expect(() => parser.push(Buffer.from("06\na5\nabc"))).toThrow(ProtocolError);
    });

    it("rejects an over-long size line rather than buffering forever", () => {
        const parser = new StreamFrameParser();
        expect(() => parser.push(Buffer.from("1234567890123456789\n"))).toThrow(/size line is too long/);
    });
});

describe("websocket framing", () => {
    it("omits the length prefix", () => {
        expect(encodeWsFrame("a5", "abc").toString()).toBe("a5\nabc");
    });

    it("encodes a control message as a bare leading newline", () => {
        expect(encodeWsFrame("", '{"command":"init","version":1}').toString())
            .toBe('\n{"command":"init","version":1}');
    });

    it("decodes into the same shape as the stream parser", () => {
        expect(splitFrame(Buffer.from("a5\nabc"))).toMatchObject({ channel: "a5" });
        expect(splitFrame(Buffer.from("\n{}")).channel).toBe("");
    });

    it("rejects a frame with no channel separator", () => {
        expect(() => splitFrame(Buffer.from("no-newline-here"))).toThrow(ProtocolError);
    });
});
