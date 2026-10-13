/*
 * Shared plumbing for the mock cockpit-bridge: the scenario, frame output,
 * flow control, the call log, the channel registry, privilege state, the
 * "wedged" state and small helpers.
 *
 * Every payload module (fs.mjs, metrics.mjs, dbus.mjs, stream.mjs) imports
 * from here; bridge.mjs is only the entry point that reads frames and routes
 * them. See the header of bridge.mjs for the scenario format.
 */
import { openSync, readFileSync, writeSync } from "node:fs";

/*
 * The scenario comes from a file (COCKPIT_MOCK_SCENARIO_FILE, what the test
 * harness uses) or inline (COCKPIT_MOCK_SCENARIO). An environment variable
 * caps a scenario near 128 KiB (E2BIG at exec), too small for outputs that
 * reach the real bridge's flow-control window.
 */
function loadScenario() {
    const file = process.env.COCKPIT_MOCK_SCENARIO_FILE || "";
    return JSON.parse(file ? readFileSync(file, "utf8") : (process.env.COCKPIT_MOCK_SCENARIO || "{}"));
}

export const scenario = loadScenario();

/** Diagnostics go to stderr, which the tests' transports usually collect. */
export function diagnostic(message) {
    process.stderr.write(`mock-bridge: ${message}\n`);
}

// ---- frame output ----------------------------------------------------------

/*
 * Channel.BLOCK_SIZE and Channel.SEND_WINDOW of the real bridge. A channel
 * opened with "flow-control": true (the vendored channel.js sets it on every
 * channel) gets {"command": "ping", "sequence": N} after every 16 KiB of
 * output, and fsread1 and stream stop producing once 2 MiB are unacknowledged
 * until a {"command": "pong", "sequence": N} moves the window to N + 2 MiB.
 */
export const BLOCK_SIZE = 16 * 1024;
export const SEND_WINDOW = 2 * 1024 * 1024;

/**
 * Write one frame. For a channel's data, returns what the real send_bytes()
 * returns: false once the flow-control window is full (the caller should
 * stop until the channel's flow.resume callback runs).
 */
export function writeFrame(channel, payload) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
    const header = Buffer.from(`${channel}\n`, "utf8");
    const frame = Buffer.concat([header, body]);
    process.stdout.write(`${frame.length}\n`);
    process.stdout.write(frame);
    if (channel === "")
        return true;
    const state = channels.get(channel);
    return state ? account(state, body.length) : true;
}

function account(state, length) {
    const flow = state.flow;
    if (!flow)
        return true;
    const before = flow.sequence;
    flow.sequence += length;
    if (Math.floor(before / BLOCK_SIZE) !== Math.floor(flow.sequence / BLOCK_SIZE))
        sendControl({ channel: state.id, command: "ping", sequence: flow.sequence });
    return flow.sequence < flow.window;
}

/** Is there room in the channel's send window (always, without flow control)? */
export function windowOpen(state) {
    return !state.flow || state.flow.sequence < state.flow.window;
}

/** Run fn once the window has room again (now, if it has). */
export function whenWindowOpen(state, fn) {
    if (windowOpen(state))
        fn();
    else
        state.flow.resume = fn;
}

/** A client "pong": Channel.do_pong(). */
export function pong(state, message) {
    if (!state.flow) {
        diagnostic(`channel ${state.id}: got wild pong (the channel was opened without "flow-control")`);
        return;
    }
    if (typeof message.sequence !== "number") {
        // message['sequence'] + SEND_WINDOW raises outside the handlers that
        // turn errors into a close.
        wedge(`pong without a numeric "sequence" on channel ${state.id} (channel.py do_pong)`);
        return;
    }
    state.flow.window = message.sequence + SEND_WINDOW;
    if (state.flow.sequence < state.flow.window && state.flow.resume) {
        const resume = state.flow.resume;
        state.flow.resume = null;
        guarded(state, resume);
    }
}

/*
 * The real bridge pretty-prints control JSON with indent=2 and a trailing
 * newline. Reproduced so clients that mistakenly parse by line will fail
 * here rather than in production.
 */
export function sendControl(message) {
    writeFrame("", JSON.stringify(message, null, 2) + "\n");
}

/** A JSON data message, formatted the way the real bridge's send_json() does. */
export function sendJson(channel, message) {
    return writeFrame(channel, JSON.stringify(message, null, 2) + "\n");
}

/*
 * Control messages with the key order the real bridge produces: ready and
 * done are built as {channel, command, ...extra}; close as {...args, command,
 * channel}, because the router merges the close arguments first. Order is not
 * semantically meaningful, but matching it keeps captured and mocked frames
 * byte-comparable.
 */
export const control = {
    ready(id, extra = {}) {
        sendControl({ channel: id, command: "ready", ...extra });
    },
    done(id) {
        sendControl({ channel: id, command: "done" });
    },
    close(id, args = {}) {
        sendControl({ ...args, command: "close", channel: id });
    },
};

/*
 * "send-acks": "bytes" -- Channel.send_ack(): {"channel", "command": "ack",
 * "bytes": N} for each data frame the channel takes in, once it has taken
 * it. Where that falls relative to the channel's own output differs by
 * payload, so each payload calls this at the real bridge's point: echo after
 * echoing, stream before the process answers, fsreplace1 as it reads a
 * frame, dbus-json3 before any reply. Payloads that never read (metrics1) or
 * close on data (null, fsread1, ...) never ack.
 */
export function sendAck(state, payload) {
    if (state.options["send-acks"] === "bytes" && channels.get(state.id) === state)
        sendControl({ channel: state.id, command: "ack", bytes: payload.length });
}

/** Python's json.dumps() default style: ", " and ": " separators, no indent. */
export function pyJson(value) {
    if (value === null || value === undefined)
        return "null";
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number") {
        if (Number.isFinite(value))
            return String(value);
        return Number.isNaN(value) ? "NaN" : (value > 0 ? "Infinity" : "-Infinity");
    }
    if (typeof value === "string")
        return JSON.stringify(value).replace(/[\u007f-￿]/g,
                                             c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    if (Array.isArray(value))
        return "[" + value.map(pyJson).join(", ") + "]";
    return "{" + Object.entries(value).map(([k, v]) => `${pyJson(k)}: ${pyJson(v)}`).join(", ") + "}";
}

// ---- the call log ----------------------------------------------------------

const logPath = process.env.COCKPIT_MOCK_LOG || "";
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/*
 * Opened once, in append mode: each entry is one synchronous write(2), so it
 * is in the file before the frame is even processed. Writing through the fd
 * also means a harness that has already deleted the file cannot have it
 * re-created behind its back (appendFileSync() would).
 */
let logFd = null;
if (logPath) {
    try {
        logFd = openSync(logPath, "a");
    } catch (error) {
        process.stderr.write(`mock-bridge: cannot open ${logPath}: ${error.message}\n`);
    }
}

/*
 * One JSON line per frame RECEIVED from the client, appended synchronously so
 * a test can read the file right after an await:
 *
 *   {"channel": "<id or empty>", "control": {...}}   control frames
 *   {"channel": "<id>", "data": "<utf8 text>"}       data frames
 *   {"channel": "<id>", "base64": "<bytes>"}         data that is not UTF-8
 */
export function logReceived(channel, payload, message) {
    if (logFd === null)
        return;
    let entry;
    if (message) {
        entry = { channel: typeof message.channel === "string" ? message.channel : "", control: message };
    } else {
        try {
            entry = { channel, data: strictUtf8.decode(payload) };
        } catch {
            entry = { channel, base64: payload.toString("base64") };
        }
    }
    try {
        writeSync(logFd, JSON.stringify(entry) + "\n");
    } catch {
        // Nothing useful to do; the test reading it will notice.
    }
}

// ---- a broken bridge ---------------------------------------------------------

/*
 * Some client mistakes raise an exception in the real bridge outside the
 * handlers that turn errors into a close message: the exception propagates
 * out of the frame parser, the frame stays at the head of the input buffer,
 * and every later read raises again. From then on NO frame on ANY channel is
 * processed, nothing is reported on the wire, and the traceback goes to the
 * journal or stderr. Running processes, timers and D-Bus signals carry on.
 * The mock reproduces that state ("wedged"), so a page that does this fails
 * its tests the way it would fail in production, and says why on stderr.
 */
let wedgedBy = null;

export function wedge(reason) {
    if (wedgedBy !== null)
        return;
    wedgedBy = reason;
    diagnostic(`WEDGED: ${reason}. The real cockpit-bridge stops processing ALL further frames here ` +
               "(an exception escapes its frame handler); so does the mock.");
}

export function wedged() {
    return wedgedBy;
}

/*
 * A protocol error at the transport level (an unknown transport-level
 * command, a duplicate channel id, a control message that is not a JSON
 * object): the real bridge closes its transport without another word and
 * exits with status 1.
 */
export function protocolError(message) {
    diagnostic(`protocol error, exiting with status 1 like the real bridge: ${message}`);
    process.exit(1);
}

// ---- channels --------------------------------------------------------------

/**
 * Open channels by id. Each entry is the payload module's own state object,
 * which always carries {id, payload, options, handler, timers, privileged,
 * group, flow}.
 */
export const channels = new Map();

/** Run fn after ms, unless the channel has closed by then. */
export function schedule(state, ms, fn) {
    const timer = setTimeout(() => {
        state.timers.delete(timer);
        if (channels.get(state.id) === state)
            guarded(state, fn);
    }, Math.max(0, ms || 0));
    state.timers.add(timer);
    return timer;
}

export function clearTimers(state) {
    for (const timer of state.timers)
        clearTimeout(timer);
    state.timers.clear();
}

/** Forget a channel and send its close message (if args is not null). */
export function finish(state, args = {}) {
    clearTimers(state);
    if (state.flow)
        state.flow.resume = null;
    if (channels.get(state.id) === state)
        channels.delete(state.id);
    if (args !== null)
        control.close(state.id, args);
}

export function isOpen(state) {
    return channels.get(state.id) === state;
}

/*
 * Run a handler, turning an exception into a close with "internal-error" the
 * way the real bridge's run_wrapper does, so a scenario typo fails the channel
 * rather than crashing the mock.
 */
export function guarded(state, fn) {
    try {
        const result = fn();
        if (result && typeof result.catch === "function")
            result.catch(error => fail(state, error));
    } catch (error) {
        fail(state, error);
    }
}

function fail(state, error) {
    diagnostic(`channel ${state.id} (${state.payload}): ${error?.stack || error}`);
    if (channels.get(state.id) === state) {
        finish(state, {
            problem: "internal-error",
            message: String(error?.message || error),
            cause: String(error?.stack || error).split("\n").map(line => `${line}\n`),
        });
    }
}

// ---- privilege -------------------------------------------------------------

/**
 * cockpit.Superuser's "Current" property, kept by dbus.mjs. Anything other
 * than "none" or "init" means a privileged bridge is running.
 */
export const privilege = { current: "none" };

/** Would the real bridge route superuser channels to a root bridge now? */
export function rootBridgeActive() {
    return scenario.superuser === true || !["none", "init"].includes(privilege.current);
}

// ---- the user the unprivileged bridge runs as -------------------------------

const infoUser = scenario.info?.user ?? {};

export const user = {
    name: infoUser.name ?? "mock",
    uid: infoUser.uid ?? 1000,
    gid: infoUser.gid ?? 1000,
    group: infoUser.group ?? infoUser.name ?? "mock",
    home: infoUser.home ?? `/home/${infoUser.name ?? "mock"}`,
    groups: infoUser.groups ?? ["mock", "wheel"],
};

/** Does this open message get a privileged (root) channel? A root session's always do. */
export function isPrivileged(options) {
    return user.uid === 0
        || ((options.superuser === "require" || options.superuser === "try") && rootBridgeActive());
}

/** Name <-> id tables for the in-memory filesystem's owners. */
export const usersByName = { root: 0, [user.name]: user.uid };
export const groupsByName = { root: 0, wheel: 10, adm: 4, [user.group]: user.gid };

// ---- small helpers ---------------------------------------------------------

export function deepEqual(a, b) {
    if (a === b)
        return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
        return false;
    if (Array.isArray(a) !== Array.isArray(b))
        return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

export function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Scripted bytes: a plain string is UTF-8 text; {"base64": "..."} is raw bytes. */
export function toBytes(spec) {
    if (spec === undefined || spec === null)
        return Buffer.alloc(0);
    if (isPlainObject(spec) && typeof spec.base64 === "string")
        return Buffer.from(spec.base64, "base64");
    return Buffer.from(String(spec), "utf8");
}

/*
 * Python's UnicodeDecodeError wording for the first invalid byte, used where
 * the real bridge fails a text channel on non-UTF-8 output. Returns null when
 * the bytes are valid (a truncated tail counts as valid: it may complete in
 * the next chunk).
 */
export function utf8Error(bytes) {
    let i = 0;
    while (i < bytes.length) {
        const b = bytes[i];
        const need = b < 0x80 ? 0 : (b >= 0xc2 && b <= 0xdf) ? 1 : (b >= 0xe0 && b <= 0xef) ? 2
            : (b >= 0xf0 && b <= 0xf4) ? 3 : -1;
        if (need < 0)
            return `'utf-8' codec can't decode byte 0x${b.toString(16).padStart(2, "0")} ` +
                   `in position ${i}: invalid start byte`;
        for (let k = 1; k <= need; k++) {
            if (i + k >= bytes.length)
                return null;
            const c = bytes[i + k];
            if ((c & 0xc0) !== 0x80)
                return `'utf-8' codec can't decode byte 0x${b.toString(16).padStart(2, "0")} ` +
                       `in position ${i}: invalid continuation byte`;
        }
        i += need + 1;
    }
    return null;
}

// ---- effects ---------------------------------------------------------------

/*
 * Scripted side effects ("effects": [...] on D-Bus methods and spawn results).
 * Payload modules register a handler per effect kind; see bridge.mjs's header
 * for the kinds. context = {bus, sender} describes where the effect came from.
 */
export const effectKinds = {};

export function applyEffect(effect, context = {}) {
    for (const [kind, handler] of Object.entries(effectKinds)) {
        if (Object.hasOwn(effect, kind)) {
            try {
                handler(effect, context);
            } catch (error) {
                // Often from a timer: report it rather than crash the mock.
                diagnostic(`effect ${JSON.stringify(effect)} failed: ${error?.stack || error}`);
            }
            return;
        }
    }
    diagnostic(`unknown effect: ${JSON.stringify(effect)}`);
}

/** Apply effects now, or after their own "delayMs" (independent timers). */
export function applyEffects(effects, context = {}) {
    for (const effect of effects ?? []) {
        if (effect.delayMs)
            setTimeout(() => applyEffect(effect, context), effect.delayMs);
        else
            applyEffect(effect, context);
    }
}
