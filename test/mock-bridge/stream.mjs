/*
 * "stream" channels: scripted processes, optionally on a pseudo-terminal.
 *
 * Message shapes follow cockpit-bridge 356 (channels/stream.py and
 * transports.py), confirmed against captured frames:
 *
 *   ready {"pid"}, output frames, done, close {"exit-status", "message"}
 *
 * "message" is ALWAYS present: the stderr text with err "message" (the
 * default), "" otherwise -- also when the client closes a running process,
 * which gets {"exit-status": null, "message": <stderr so far>}. A process
 * killed by a signal reports a negative exit status (-15 for SIGTERM); the
 * Python bridge has no "exit-signal".
 *
 * Output arrives the way a pipe delivers it: in frames of at most 8 KiB (the
 * captured size for coreutils writers), not aligned to lines. Text channels
 * pass it through a strict incremental UTF-8 decoder: a split character
 * waits for its tail (an empty frame is sent meanwhile), invalid bytes close
 * "protocol-error" -- and the real bridge still sends a stray "done" for the
 * closed channel when the process ends. Output ending inside a character
 * gets no "done" at all, just the normal close. "binary": "raw" passes bytes
 * through. With "flow-control", output stops after the 2 MiB window until
 * the client's pong (the real bridge stops reading the pipe).
 *
 * Mistakes that wedge the whole real bridge (see core.mjs): data or a second
 * "done" after the client's "done" on a pipe, and "options" with a "window"
 * on a pipe. Options the real bridge only checks inside create_transport()
 * ("err", "pty", "directory", "window", the types of "spawn" and "environ")
 * hang the channel: no ready, no close, ever. An "environ" entry without "="
 * closes "protocol-error"; a "directory" that does not exist in the mock's
 * filesystem closes "not-found" before ready.
 *
 * With "pty": true the channel behaves like a terminal in cooked mode (the
 * Linux n_tty defaults): input is echoed (CR and LF as CRLF, control
 * characters as ^X; ^? erases with "\b \b", ^U and ^W erase the line or word
 * the same way, ^R reprints the line, ^V quotes the next character, ^D on an
 * empty line is EOF and not echoed, ^S/^Q are flow control), output gets
 * ONLCR (LF becomes CRLF), stderr goes to the terminal, "done" from the
 * client is ignored (a pty has no EOF to send), and window size changes
 * arrive as {"command": "options", "window": {"rows", "cols"}}. The mock does
 * not apply the size to anything: script what a program would print.
 */
import {
    scenario, control, writeFrame, finish, schedule, toBytes, utf8Error, isPlainObject, applyEffects,
    channels, wedge, diagnostic, sendAck,
} from "./core.mjs";
import { directoryStatus } from "./fs.mjs";

let nextPid = 4242;

/** What one read() of a pipe delivers at most, as captured (writers using 8 KiB buffers). */
const PIPE_CHUNK = 8192;

const SIGNALS = {
    HUP: 1, INT: 2, QUIT: 3, ILL: 4, TRAP: 5, ABRT: 6, BUS: 7, FPE: 8, KILL: 9,
    USR1: 10, SEGV: 11, USR2: 12, PIPE: 13, ALRM: 14, TERM: 15,
};

/** Exact argv first, then the first matching pattern. */
function lookup(key) {
    const exact = (scenario.spawn ?? {})[key];
    if (exact !== undefined)
        return exact;
    return (scenario.spawnPatterns ?? []).find(pattern => new RegExp(pattern.match).test(key));
}

const isStrv = value => Array.isArray(value) && value.every(item => typeof item === "string");

/**
 * The JsonError create_transport() would raise for these options, in its
 * order, or null. Such an error is never turned into a close.
 */
function transportOptionError(options) {
    if (!isStrv(options.spawn))
        return `attribute 'spawn': must be a list of strings`;
    if (options.spawn.length === 0)
        return "an empty \"spawn\" list (subprocess.Popen: IndexError)";
    if (options.err !== undefined && !["out", "ignore", "message"].includes(options.err))
        return `attribute 'err': invalid value "${String(options.err)}" not in ['out', 'ignore', 'message']`;
    if (options.directory !== undefined && typeof options.directory !== "string")
        return "attribute 'directory': must have type str";
    if (options.pty !== undefined && typeof options.pty !== "boolean")
        return "attribute 'pty': must have type bool";
    if (options.window !== undefined) {
        const error = windowError(options.window);
        if (error)
            return error;
    }
    if (options.environ !== undefined && !isStrv(options.environ))
        return "attribute 'environ': must be a list of strings";
    return null;
}

/** get_object(options, 'window', WindowSize) wording, or null when valid. */
function windowError(window) {
    if (!isPlainObject(window))
        return "attribute 'window': must have type dict";
    for (const key of ["rows", "cols"]) {
        if (!Object.hasOwn(window, key))
            return `attribute 'window': attribute '${key}' required`;
        if (!Number.isInteger(window[key]))
            return `attribute 'window': attribute '${key}': must have type int`;
    }
    return null;
}

export const stream = {
    open(state) {
        const options = state.options;
        // SubprocessStreamChannel is chosen when "spawn" is there at all.
        if (options.spawn === undefined || options.spawn === null) {
            openSocket(state);
            return;
        }

        const optionError = transportOptionError(options);
        if (optionError) {
            state.hung = true;
            diagnostic(`channel ${state.id}: ${optionError}. The real bridge raises this inside create_transport(), ` +
                       "where it never becomes a close: the channel gets no ready and no close, ever. So does the mock's.");
            return;
        }
        if ((options.environ ?? []).some(entry => !entry.includes("="))) {
            finish(state, { message: 'invalid "environ" option for stream channel', problem: "protocol-error" });
            return;
        }
        if (options.directory !== undefined) {
            const status = directoryStatus(options.directory, state.privileged);
            if (status !== "ok") {
                // Popen's chdir: FileNotFoundError, PermissionError, or another OSError.
                diagnostic(`channel ${state.id}: directory ${JSON.stringify(options.directory)}: ${status}`);
                finish(state, { problem: { "not-directory": "internal-error" }[status] ?? status });
                return;
            }
        }

        const key = options.spawn.join(" ");
        const result = lookup(key);
        if (!result) {
            diagnostic(`no scripted result for: ${key} (closing "not-found", as for a missing command)`);
            finish(state, { problem: "not-found" });
            return;
        }
        if (result.problem) {
            // The spawn itself failed: no ready, just the close.
            finish(state, { ...(result.message !== undefined ? { message: result.message } : {}), problem: result.problem });
            return;
        }

        Object.assign(state, {
            result,
            err: options.err ?? "message",
            pty: options.pty === true,
            binary: options.binary === "raw",
            window: isPlainObject(options.window) ? options.window : { rows: 0, cols: 0 },
            stderr: [],
            partial: Buffer.alloc(0), // an incomplete UTF-8 sequence awaiting its tail
            typed: "",                 // pty input, for "exitOn"
            line: [],                  // the pty's current line: [{byte, width}]
            literalNext: false,        // pty: the previous byte was ^V
            eof: false,                // the client sent done
            zombie: false,             // closed (protocol-error) but the process runs on
            phase: "running",
        });

        control.ready(state.id, { pid: nextPid++ });
        if (result.readInput)
            state.phase = "reading"; // the scripted output starts after the client's done
        else
            run(state);
    },

    data(state, payload) {
        if (!state.pty && state.eof) {
            wedge(`a data frame on stream channel ${state.id} after the client's "done" ` +
                  "(transports.py _Transport.write(): assert not self._eof)");
            return;
        }
        // Written to the process at once, so acknowledged before it can answer.
        sendAck(state, payload);
        // Whatever the client feeds a process is in the call log; a pty also
        // echoes it, as the line discipline would.
        if (state.pty)
            echo(state, payload);
    },

    done(state) {
        if (state.pty)
            return; // the real bridge cannot write EOF to a pty
        if (state.eof) {
            wedge(`a second "done" on stream channel ${state.id} ` +
                  "(transports.py _Transport.write_eof(): assert not self._eof)");
            return;
        }
        state.eof = true;
        if (state.phase === "reading") {
            state.phase = "running";
            run(state);
        } else if (state.phase === "open") {
            exit(state);
        }
        // Otherwise a keepOpen process ends once its output is out.
    },

    options(state, message) {
        if (message.window === undefined)
            return;
        const error = windowError(message.window);
        if (error) {
            finish(state, { message: error, problem: "protocol-error" });
            return;
        }
        if (!state.pty) {
            wedge(`{"command": "options", "window": ...} on stream channel ${state.id}, which has no pty ` +
                  "(transports.py set_window_size(): assert self._pty_fd is not None)");
            return;
        }
        state.window = message.window; // TIOCSWINSZ
    },

    clientClose(state) {
        // The process is terminated; the bridge never collects its status,
        // but reports the stderr it has.
        finish(state, { "exit-status": null, message: stderrText(state) });
    },
};

function openSocket(state) {
    const { unix, port } = state.options;
    if (unix !== undefined && port !== undefined)
        finish(state, { message: 'cannot specify both "port" and "unix" options', problem: "protocol-error" });
    else if (unix === undefined && port === undefined)
        finish(state, { message: 'no "port" or "unix" or other address option for channel', problem: "protocol-error" });
    else
        finish(state, { message: "mock-bridge does not emulate socket streams", problem: "not-found" });
}

function stderrText(state) {
    return !state.pty && state.err === "message" ? Buffer.concat(state.stderr ?? []).toString("utf8") : "";
}

// ---- the scripted process ------------------------------------------------------

/** Run fn after ms while the process lives (a protocol-error close does not stop it). */
function later(state, ms, fn) {
    if (state.zombie)
        setTimeout(fn, Math.max(0, ms || 0));
    else
        schedule(state, ms, fn);
}

/** Produce the scripted output in order, then exit or stay open. */
function run(state) {
    const result = state.result;
    const steps = [];
    if (result.stdout !== undefined)
        steps.push({ delayMs: 0, stream: "out", bytes: toBytes(result.stdout) });
    for (const chunk of result.chunks ?? []) {
        const isErr = chunk.stderr !== undefined;
        const spec = isErr ? chunk.stderr : chunk.base64 !== undefined ? { base64: chunk.base64 } : chunk.data;
        steps.push({ delayMs: chunk.delayMs ?? 0, stream: isErr ? "err" : "out", bytes: toBytes(spec) });
    }
    // "message" is the original spelling of stderr, kept for older scenarios.
    const stderr = result.stderr ?? result.message;
    if (stderr !== undefined)
        steps.push({ delayMs: 0, stream: "err", bytes: toBytes(stderr) });

    const next = i => {
        if (i === steps.length) {
            stepsDone(state);
            return;
        }
        later(state, steps[i].delayMs, () => emit(state, steps[i], () => next(i + 1)));
    };
    next(0);
}

function stepsDone(state) {
    const result = state.result;
    const typedExit = state.pty && result.exitOn !== undefined && state.typed.includes(result.exitOn);
    if (typedExit || (result.keepOpen && state.eof))
        exit(state); // the client got there while the output was still coming
    else if (result.keepOpen || (state.pty && result.exitOn !== undefined))
        state.phase = "open"; // until done, close, or exitOn
    else
        exit(state);
}

/** Route one step's bytes per the err mode, then continue with then(). */
function emit(state, step, then) {
    if (step.stream === "err" && !state.pty && state.err !== "out") {
        if (state.err === "message")
            state.stderr.push(step.bytes);
        then();
        return;
    }
    write(state, state.pty ? onlcr(step.bytes) : step.bytes, then);
}

/** What the program writes, as the bridge reads it: pipe-sized frames, flow-controlled. */
function write(state, bytes, then) {
    const pieces = [];
    for (let start = 0; start < bytes.length; start += PIPE_CHUNK)
        pieces.push(bytes.subarray(start, start + PIPE_CHUNK));
    const pump = i => {
        for (; i < pieces.length; i++) {
            if (!deliver(state, pieces[i])) {
                if (channels.get(state.id) === state) {
                    // The window is full: the real bridge stops reading the pipe.
                    const resumeAt = i + 1;
                    state.flow.resume = () => pump(resumeAt);
                    return;
                }
            }
        }
        then();
    };
    pump(0);
}

/** data_received(): returns false when the flow-control window is full. */
function deliver(state, data) {
    if (state.binary)
        return writeFrame(state.id, data);
    // The strict incremental decoder of Channel.send_data().
    const bytes = Buffer.concat([state.partial, data]);
    const error = utf8Error(bytes);
    if (error) {
        if (!state.zombie) {
            finish(state, { message: error, problem: "protocol-error" });
            state.zombie = true; // the process runs on, reading continues
        }
        return true; // the failed chunk is dropped; the decoder keeps its old state
    }
    const cut = completePrefix(bytes);
    state.partial = Buffer.from(bytes.subarray(cut));
    // A chunk that only starts a character still sends a (empty) frame.
    return writeFrame(state.id, bytes.subarray(0, cut));
}

/** Length of data without a trailing incomplete UTF-8 sequence. */
function completePrefix(data) {
    for (let back = 1; back <= Math.min(3, data.length); back++) {
        const b = data[data.length - back];
        if ((b & 0xc0) === 0x80)
            continue; // continuation byte: keep looking for the lead
        const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
        return need > back ? data.length - back : data.length;
    }
    return data.length;
}

/** ONLCR: the terminal turns every LF the program writes into CRLF. */
function onlcr(bytes) {
    const out = [];
    for (const b of bytes) {
        if (b === 0x0a)
            out.push(0x0d);
        out.push(b);
    }
    return Buffer.from(out);
}

function exitStatus(result) {
    const signal = result["exit-signal"];
    if (signal !== undefined) {
        const number = typeof signal === "number" ? signal : SIGNALS[String(signal).replace(/^SIG/, "")];
        return -(number ?? 15);
    }
    return result["exit-status"] ?? 0;
}

/**
 * The process is done with its output. Its stdout reaches EOF ("done") and it
 * exits (the close) -- at once, or with "exitDelayMs" that much later: a
 * process that closed its stdout and runs on (sh -c 'exec >&-; sleep 1').
 * ProtocolChannel.eof_received() sends done at EOF, and the close waits for
 * the exit. On a pty there is no EOF while the process lives (it still has
 * the terminal as stdin and stderr), so done and close both wait for the exit.
 */
function exit(state) {
    if (state.phase === "exited" || state.phase === "exiting")
        return;
    const delay = state.result.exitDelayMs ?? 0;
    const pipeEofFirst = delay > 0 && !state.pty;
    const exited = () => {
        state.phase = "exited";
        // Whatever the command changed, it changed before it exited.
        applyEffects(state.result.effects, {});
        if (!pipeEofFirst)
            stdoutEof(state);
        if (!state.zombie)
            finish(state, { "exit-status": exitStatus(state.result), message: stderrText(state) });
    };
    if (delay <= 0) {
        exited();
        return;
    }
    state.phase = "exiting"; // a client done or more output changes nothing now
    if (pipeEofFirst)
        stdoutEof(state);
    later(state, delay, exited);
}

function stdoutEof(state) {
    // EOF inside a character: done() raises before sending "done" (the
    // channel just closes when the process is gone). On a channel that was
    // already closed (protocol-error), the real bridge still sends a stray
    // "done" for it.
    if (state.partial.length === 0)
        control.done(state.id);
}

// ---- the line discipline ---------------------------------------------------

const CTRL = letter => letter.charCodeAt(0) - 0x40;
const VINTR = CTRL("C");
const VQUIT = 0x1c;
const VERASE = 0x7f;
const VKILL = CTRL("U");
const VEOF = CTRL("D");
const VSTART = CTRL("Q");
const VSTOP = CTRL("S");
const VSUSP = CTRL("Z");
const VREPRINT = CTRL("R");
const VWERASE = CTRL("W");
const VLNEXT = CTRL("V");

/** How a byte echoes with ECHOCTL: control characters as ^X (two columns). */
function echoOf(b) {
    if (b < 0x20 && b !== 0x09 && b !== 0x0a)
        return [0x5e, b + 0x40];
    if (b === 0x7f)
        return [0x5e, 0x3f];
    return [b];
}

const RUBOUT = [0x08, 0x20, 0x08];

/** Rub out the last character of the line (ECHOE, IUTF8), as many columns as it took. */
function eraseOne(state, out) {
    let width = 0;
    for (;;) {
        const last = state.line.pop();
        if (!last)
            break;
        width += last.width;
        if ((last.byte & 0xc0) !== 0x80)
            break; // ASCII or a lead byte: the whole character is gone
    }
    for (let k = 0; k < width; k++)
        out.push(...RUBOUT);
}

function lineText(state) {
    return Buffer.from(state.line.map(entry => entry.byte)).toString("utf8");
}

/** The line discipline's echo of what the client typed, and line delivery. */
function echo(state, payload) {
    const out = [];
    const lines = [];
    for (const b of payload) {
        if (state.literalNext) {
            // After ^V: the byte is taken as is; "^\b" is replaced by its echo.
            state.literalNext = false;
            const shown = echoOf(b);
            out.push(...shown);
            state.line.push({ byte: b, width: shown.length });
            continue;
        }
        if (b === 0x0d || b === 0x0a) {
            out.push(0x0d, 0x0a); // ICRNL, then ONLCR on the echoed newline
            lines.push(lineText(state));
            state.line = [];
        } else if (b === VERASE) {
            eraseOne(state, out);
        } else if (b === VKILL) {
            while (state.line.length)
                eraseOne(state, out);
        } else if (b === VWERASE) {
            while (state.line.length && state.line[state.line.length - 1].byte === 0x20)
                eraseOne(state, out);
            while (state.line.length && state.line[state.line.length - 1].byte !== 0x20)
                eraseOne(state, out);
        } else if (b === VREPRINT) {
            out.push(...echoOf(b), 0x0d, 0x0a);
            for (const entry of state.line)
                out.push(...echoOf(entry.byte));
        } else if (b === VLNEXT) {
            out.push(0x5e, 0x08);
            state.literalNext = true;
        } else if (b === VEOF) {
            // EOF on an empty line, else the line goes to the reader without
            // a newline; nothing is echoed either way.
            if (state.line.length) {
                lines.push(lineText(state));
                state.line = [];
            }
        } else if (b === VSTOP || b === VSTART) {
            // IXON: output flow control, not echoed.
        } else if (b === VINTR || b === VQUIT || b === VSUSP) {
            out.push(...echoOf(b)); // ISIG: the signal flushes the line
            state.line = [];
        } else {
            const shown = echoOf(b);
            out.push(...shown);
            state.line.push({ byte: b, width: (b & 0xc0) === 0x80 ? 0 : shown.length });
        }
    }
    if (out.length)
        writeFrame(state.id, Buffer.from(out));

    // A program reading the terminal answers each line it gets.
    for (const line of lines) {
        const reply = (state.result.replies ?? []).find(entry => new RegExp(entry.line).test(line));
        if (reply && reply.stdout !== undefined && state.phase !== "exited")
            write(state, onlcr(toBytes(reply.stdout)), () => {});
    }

    const exitOn = state.result.exitOn;
    if (exitOn !== undefined) {
        state.typed += payload.toString("utf8");
        if (state.typed.includes(exitOn) && state.phase === "open")
            exit(state);
    }
}
