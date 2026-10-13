/*
 * Cockpit channel-protocol framing.
 *
 * Two wire formats carry the identical message:
 *
 *   stream (stdio, ssh):  <decimal-length> LF <channel-id> LF <payload>
 *   websocket:                              <channel-id> LF <payload>
 *
 * The length prefix exists only because stdio and ssh have no message
 * boundaries; a WebSocket provides its own. `<decimal-length>` counts
 * `<channel-id> LF <payload>` and excludes the length line itself.
 *
 * An empty channel id (a leading LF) means the control channel.
 *
 * Everything here is byte-oriented. Payloads may be binary, and even on text
 * channels multi-byte UTF-8 makes string indexing unsafe for the length math.
 */

const LF = 0x0a;

/** Longest decimal length prefix we will scan for before giving up. */
const MAX_LENGTH_DIGITS = 10;

export class ProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ProtocolError";
    }
}

export interface Frame {
    /** Channel id; the empty string denotes a control message. */
    channel: string;
    payload: Buffer;
}

function toBuffer(payload: Buffer | Uint8Array | string): Buffer {
    if (typeof payload === "string")
        return Buffer.from(payload, "utf8");
    if (Buffer.isBuffer(payload))
        return payload;
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
}

/** Encode one frame for a stream transport (stdio / ssh). */
export function encodeStreamFrame(channel: string, payload: Buffer | Uint8Array | string): Buffer {
    const body = toBuffer(payload);
    const header = Buffer.from(`${channel}\n`, "utf8");
    const length = header.length + body.length;
    return Buffer.concat([Buffer.from(`${length}\n`, "utf8"), header, body]);
}

/** Encode one frame for a WebSocket transport (no length prefix). */
export function encodeWsFrame(channel: string, payload: Buffer | Uint8Array | string): Buffer {
    return Buffer.concat([Buffer.from(`${channel}\n`, "utf8"), toBuffer(payload)]);
}

/** Split `<channel-id> LF <payload>` — the shared inner format of both wire formats. */
export function splitFrame(frame: Buffer): Frame {
    const nl = frame.indexOf(LF);
    if (nl === -1)
        throw new ProtocolError("frame is missing the channel separator");
    return {
        channel: frame.subarray(0, nl).toString("utf8"),
        // subarray aliases the input; copy so callers can retain it safely.
        payload: Buffer.from(frame.subarray(nl + 1)),
    };
}

/**
 * Incremental parser for stream transports.
 *
 * Length-driven, never line-driven: the bridge pretty-prints its control JSON
 * with `indent=2`, so payloads contain LF freely.
 */
export class StreamFrameParser {
    #buffer: Buffer = Buffer.alloc(0);

    /** Feed bytes; returns every complete frame now available. */
    push(chunk: Buffer | Uint8Array): Frame[] {
        this.#buffer = this.#buffer.length === 0
            ? toBuffer(chunk)
            : Buffer.concat([this.#buffer, toBuffer(chunk)]);

        const frames: Frame[] = [];
        for (;;) {
            const frame = this.#next();
            if (frame === null)
                break;
            frames.push(frame);
        }
        return frames;
    }

    /** Bytes held back awaiting a complete frame. */
    get pending(): number {
        return this.#buffer.length;
    }

    #next(): Frame | null {
        const nl = this.#buffer.indexOf(LF);
        if (nl === -1) {
            // Guard against a peer that never sends a separator.
            if (this.#buffer.length > MAX_LENGTH_DIGITS)
                throw new ProtocolError("size line is too long");
            return null;
        }
        if (nl > MAX_LENGTH_DIGITS)
            throw new ProtocolError("size line is too long");

        const lengthText = this.#buffer.subarray(0, nl).toString("ascii");
        if (!/^[1-9][0-9]*$/.test(lengthText))
            throw new ProtocolError(`frame size is not an integer: ${JSON.stringify(lengthText)}`);
        const length = Number(lengthText);

        const start = nl + 1;
        const end = start + length;
        if (this.#buffer.length < end)
            return null; // frame not yet complete

        const frame = splitFrame(this.#buffer.subarray(start, end));
        this.#buffer = Buffer.from(this.#buffer.subarray(end));
        return frame;
    }
}
