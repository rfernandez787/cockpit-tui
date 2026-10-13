#!/usr/bin/env node
/*
 * A mock cockpit-bridge, speaking the real wire protocol on stdio.
 *
 * This exists because the environment this project is developed in has no
 * systemd, no D-Bus and no container runtime, so the real backends the pages
 * talk to cannot be reached. The mock lets the transport, handshake, channel
 * routing and page logic be tested for real against the actual framing.
 *
 * Deliberately plain JavaScript: StreamTransport spawns it as a subprocess, so
 * needing no TypeScript loader keeps the test path short and robust.
 *
 * Message shapes follow the real (Python) cockpit-bridge 356, read from its
 * source and confirmed against frames captured from it. Each module's header
 * lists what it reproduces and where it knowingly differs:
 *
 *   core.mjs     framing, flow control, the call log, channel registry,
 *                privilege, effects, the "wedged" state
 *   fs.mjs       fsread1, fsreplace1, fswatch1, fsinfo on an in-memory tree
 *   metrics.mjs  metrics1 with source "internal"
 *   dbus.mjs     dbus-json3 on a scripted object tree; cockpit.Superuser
 *   stream.mjs   stream: scripted processes and pseudo-terminals
 *   http.mjs     http-stream2: scripted HTTP routes on a unix socket (podman's REST
 *                service); its header documents the "http" scenario and effects
 *
 * test/mock-bridge/harness.ts starts it for tests (startMock()).
 *
 * ---- Like the real bridge, the mock punishes protocol mistakes ---------------
 *
 *   - Some client mistakes WEDGE the real bridge: an exception escapes its
 *     frame handler, and from then on no frame on any channel is processed
 *     (running processes and timers carry on; nothing is said on the wire).
 *     The mock does the same and prints "mock-bridge: WEDGED: <why>" on
 *     stderr. Triggers: a data frame or a second "done" after the client's
 *     "done" on a pipe (non-pty) stream; {"command": "options", "window"} on
 *     a pipe stream; a dbus-json3 frame that is not exactly one JSON document
 *     (two messages in one frame included); a pong without a sequence.
 *   - A transport-level control message other than init, kill and authorize
 *     (e.g. "ping"), a duplicate channel id, or a control frame that is not a
 *     JSON object makes the real bridge exit with status 1; so does the mock.
 *   - Options the real bridge only validates inside an async task (stream:
 *     a bad "err", "pty", "directory", "window", non-string "spawn" or
 *     "environ" entries) leave the channel without ready or close forever.
 *   - {"command": "kill"} without "host" closes every channel (or the given
 *     "group"'s; the default group is "default"), like a client close.
 *   - stdin EOF closes every open channel before the mock exits.
 *
 * ---- Environment ---------------------------------------------------------
 *
 *   COCKPIT_MOCK_SCENARIO_FILE  a file holding the scenario below, as JSON
 *   COCKPIT_MOCK_SCENARIO       the scenario inline (used when no file is
 *                               given; an environment variable caps it near
 *                               128 KiB, the file does not)
 *   COCKPIT_MOCK_LOG       optional file; one JSON line is appended (synchronously)
 *                          per frame the mock RECEIVES from the client:
 *                            {"channel": "<id or empty>", "control": {...}}
 *                            {"channel": "<id>", "data": "<utf8 text>"}
 *                            {"channel": "<id>", "base64": "<bytes>"}  (not UTF-8)
 *                          so tests can assert what the client sent: D-Bus calls,
 *                          spawned argv, file contents written, stdin, resizes.
 *                          Frames arriving while the mock is wedged are logged
 *                          too, though never processed.
 *
 * ---- Scenario (every key optional) -----------------------------------------
 *
 *   {
 *     "initDelayMs": 0,          // stall before sending init
 *     "noInit": false,           // never send init at all
 *     "initProblem": null,       // send init carrying a problem
 *     "version": 1,              // protocol version to claim
 *     "info": { ... },           // replaces the info channel's payload
 *     "superuser": false,        // true: a root bridge is already running
 *     "superuserFlow": { ... },  // the cockpit.Superuser conversation, below
 *     "files": { ... },
 *     "metrics": { ... }, "metricsCompress": false,
 *     "dbus": { ... }, "dbusOwners": { ... },
 *     "spawn": { ... }, "spawnPatterns": [ ... ]
 *   }
 *
 * Privilege. A channel opened with a "superuser" other than "try" (normally
 * "require") is refused with "access-denied" unless a root bridge is active:
 * scenario "superuser": true, or the cockpit.Superuser flow has escalated
 * (Current is neither "none" nor "init"). "require" and "try" channels opened
 * while one is active are privileged: they act as root on the filesystem. In
 * a root session (info.user.uid 0) every channel is.
 *
 * superuserFlow -- cockpit.Superuser at /superuser on the internal bus:
 *
 *   "superuserFlow": {
 *     "prompts": [ { "prompt": "Password for alice: ", "message": "", "echo": false } ],
 *     "password": "s3cr3t",        // the Answer that succeeds
 *     "bridges": ["sudo", "pkexec"]
 *   }
 *   Start emits a Prompt signal per prompt (retrying with "Sorry, try again."
 *   after a wrong Answer); no prompts means passwordless success. An init
 *   message carrying "superuser": {"id": "sudo" | "any"} escalates at startup
 *   the way the real bridge does: one {"command": "authorize", "challenge":
 *   "plain1:<hex user>", "cookie"} (only if there are prompts), answered by
 *   the client's {"command": "authorize", "cookie", "response"}, then a
 *   transport-level {"command": "superuser-init-done"} either way.
 *
 * files -- the in-memory filesystem (fsread1, fsreplace1, fswatch1, fsinfo):
 *
 *   "files": {
 *     "/etc/motd": "Welcome\n",                  // UTF-8 content
 *     "/var/lib/blob": { "base64": "AAEC/w==" },  // raw bytes
 *     "/etc/shadow": { "content": "root:*:...", "mode": 0, "user": "root", "group": "root" },
 *     "/etc/sudoers.d/": {},                     // a directory (trailing slash)
 *     "/srv/drop/": { "mode": 1023, "user": "root" },   // 01777
 *     "/etc/nologin": null                       // documents an absent file
 *   }
 *   Parent directories exist implicitly, and so do the usual top-level ones
 *   (/etc, /tmp, /var/log, ...) and the user's home. Owners and modes default
 *   like a real host's: inside the session user's home everything belongs to
 *   the user, elsewhere to root:root; files are 0644, directories 0755, /tmp
 *   and /var/tmp 01777, /root 0550. "mode" (a number: 420 is 0644),
 *   "user"/"uid" and "group"/"gid" override that. Unprivileged channels get
 *   Unix permission checks the way the kernel does them: reading needs search
 *   permission on every ancestor and read permission on the file; fsreplace1
 *   writes a temp file into the target's directory and renames it, so writing
 *   or deleting needs write permission on the DIRECTORY (and ownership in a
 *   sticky one), and a write with a tag copies the old owner, which only root
 *   may give away. So an unprivileged write to /etc/... is "access-denied",
 *   as in production. Privileged channels may do anything.
 *   Tags look like the real ones, "1:<ino>-<mtime>-<octal mode>-<uid>-<gid>",
 *   and change on every write. Writes and deletions reach fswatch1 and fsinfo
 *   watchers (cockpit.file().watch() uses fsinfo) with the real events.
 *
 * metrics -- metrics1, source "internal":
 *
 *   "metrics": {
 *     "memory.used": { "samples": [1000, 2000] },
 *     "cpu.basic.user": { "samples": [0, 500, 1500] },     // ask derive "rate"
 *     "network.interface.rx": { "instances": ["lo", "eth0"],
 *                               "samples": [[0, 0], [100, 2000]] },
 *     "disk.dev.read": { "samples": [{ "sda": 1 }, { "sda": 2, "sdb": 0 }] },
 *     "my.custom": { "units": "count", "semantics": "instant", "samples": [7] }
 *   },
 *   "metricsCompress": false
 *   One sample per interval, the last repeated once they run out. Instanced
 *   samples are arrays (matching "instances") or {instance: value} objects; a
 *   change in the instance set re-sends meta. Every name the real internal
 *   source supports is accepted (unscripted ones sample 0), with its real
 *   units and semantics as defaults; other names must be scripted. Unknown
 *   names and unit mismatches close "not-supported" like the real bridge.
 *   Rows are uncompressed, like the Python bridge; "metricsCompress": true
 *   emulates the legacy C bridge (unchanged values null, trailing ones
 *   dropped). Non-internal sources close as on a host without python3-pcp.
 *
 * dbus -- dbus-json3, one object tree per bus ("system", "session",
 * "internal", or an "address" string):
 *
 *   "dbus": {
 *     "system": {
 *       "/org/freedesktop/systemd1": {
 *         "org.freedesktop.DBus.ObjectManager": {},   // enables path_namespace watches here
 *         "org.freedesktop.systemd1.Manager": {
 *           "properties": { "Version": "255", "NFailedUnits": { "t": "u", "v": 2 } },
 *           "writable": ["LogLevel"],                  // Properties.Set allowed; others are read-only
 *           "methods": {
 *             "Reload": null,                           // replies []
 *             "GetUnit": { "in": ["s"], "out": ["o"],   // "in": arguments are checked
 *                          "reply": ["/org/freedesktop/systemd1/unit/sshd_2eservice"] },
 *             "StartUnit": {
 *               "reply": ["/job/1"],
 *               "error": ["org.freedesktop.systemd1.NoSuchUnit", ["Unit x not found."]],
 *               "delayMs": 0,
 *               "effects": [ ...effects, below... ],
 *               "byArgs": [ { "args": ["sshd.service", "replace"], "reply": ["/job/2"],
 *                             "effects": [ ... ] } ]
 *             }
 *           },
 *           "signals": { "JobRemoved": { "in": ["u", "o", "s", "s"] } },  // meta only
 *           "meta": { ... }      // merged over the generated meta, per section
 *         }
 *       }
 *     }
 *   },
 *   "dbusOwners": { "system": { "org.example.Gone": null, "org.example.Here": ":1.7" } }
 *
 *   Property values are plain JSON (signature inferred: s, b, i/x, d, a...,
 *   a{sv}) or variants {"t": "u", "v": 2} for an exact type. A method gives
 *   "reply" (the out arguments) or "error"; a "byArgs" entry whose "args"
 *   deep-equal the call's replaces the method's reply/error/effects. "out" or
 *   "type" fix the reply's "type" signature. A method that declares "in" has
 *   its arguments marshalled and checked like the real bridge and an sd-bus
 *   service would (python.error / InvalidArgs); without "in" anything goes.
 *   A call's "timeout" (ms) shorter than "delayMs" gets NoReply. Properties.
 *   Get/GetAll/Set work on every object (Set only on "writable" properties;
 *   it updates the tree and notifies before replying), and ObjectManager.
 *   GetManagedObjects where declared. Names are owned (by ":1.42") unless
 *   "dbusOwners" says otherwise; null means no owner.
 *
 * Effects -- side effects of a D-Bus method (after its reply, unless
 * "beforeReply": true) or of a spawned command (when it exits). Each may carry
 * "delayMs", and D-Bus ones a "bus" (default: the caller's) and a "sender"
 * (default: the calling channel's name):
 *
 *   { "signal": ["/path", "iface", "Member", [args]] }   delivered per add-match
 *   { "properties": ["/path", "iface", { "Prop": value }] }
 *                     updates the tree; notify to watchers, then PropertiesChanged
 *   { "added": ["/path", { "iface": { "Prop": value } }] }
 *                     new interfaces (or full {"properties", "methods"} defs);
 *                     InterfacesAdded via the nearest ObjectManager ancestor
 *   { "removed": ["/path", ["iface"]] }                  omitted list: all of them
 *   { "owner": ["org.example.Name", ":1.99" | null] }    the name changes hands
 *   { "files": { "/etc/passwd": "...", "/etc/gone": null }, "inPlace": false }
 *                     files change behind the client's back (as root). By
 *                     default a file is REPLACED (a new inode renamed into
 *                     place, as useradd, sed -i or an editor do); "inPlace":
 *                     true WRITES the existing inode (an append, a log
 *                     growing), which watchers see as "changed".
 *
 * spawn -- stream channels. Exact argv (joined by spaces) first, then the
 * first "spawnPatterns" entry whose "match" regex (unanchored) matches:
 *
 *   "spawn": {
 *     "hostname": { "stdout": "box\n" },
 *     "false": { "exit-status": 1, "stderr": "it failed\n" },
 *     "journalctl -f": { "chunks": [ { "data": "a\n" }, { "data": "b\n", "delayMs": 50 } ],
 *                        "keepOpen": true },
 *     "chpasswd": { "readInput": true },
 *     "/bin/bash -i": { "stdout": "$ ", "exitOn": "exit\r",
 *                       "replies": [ { "line": "^ls$", "stdout": "a b\n$ " } ] }
 *   },
 *   "spawnPatterns": [ { "match": "^useradd ", "effects": [ { "files": { ... } } ] } ]
 *
 *   Result fields: "stdout" (one shot, string or {"base64"}), "chunks"
 *   ([{"data" | "base64" | "stderr", "delayMs"}], delays relative to the
 *   previous chunk), "stderr" (also spelled "message"), "exit-status",
 *   "exit-signal" ("TERM" or 15: reported as exit-status -15, the way the
 *   Python bridge does), "problem" (the spawn fails: close without ready),
 *   "keepOpen" (stay open until the client sends done or closes), "readInput"
 *   (output starts only after the client's done; its input is in the log),
 *   "exitOn" (pty: exit, with "exit-status" or 0, once the client has typed
 *   this), "replies" (pty: [{"line": regex, "stdout"}] -- output written when
 *   the client enters a matching line), "effects".
 *   Output reaches the client the way a pipe delivers it: in frames of at
 *   most 8 KiB, which need not end at a line boundary.
 *   stderr follows the open's "err": "message" (default) puts it in the close
 *   message, "out" merges it into the output, "ignore" drops it. Unscripted
 *   commands close "not-found". A "directory" must exist in the mock's
 *   filesystem (closes "not-found" otherwise). Output is checked as UTF-8 on
 *   text channels (bad bytes close "protocol-error"); "binary": "raw" passes
 *   it unchanged.
 *
 *   With "pty": true the channel acts as a terminal in cooked mode: what the
 *   client types is echoed by the line discipline (CR and LF as CRLF, control
 *   characters as ^C..., erase/kill/word-erase/reprint/literal-next as a tty
 *   does them), scripted output gets ONLCR (LF becomes CRLF), stderr goes to
 *   the terminal, a client "done" is ignored, and the open's "window" and
 *   later {"command": "options", "window": {"rows", "cols"}} resizes are in
 *   the log.
 *
 * Any other payload closes "not-supported".
 */

import {
    scenario, channels, control, sendControl, sendJson, writeFrame, logReceived, finish, guarded,
    rootBridgeActive, isPrivileged, diagnostic, wedged, protocolError, pong, user, isPlainObject, SEND_WINDOW,
    sendAck,
} from "./core.mjs";
import { fsread1, fsreplace1, fswatch1, fsinfo } from "./fs.mjs";
import { metrics1 } from "./metrics.mjs";
import { dbusjson3, superuserInit, superuserAuthorize } from "./dbus.mjs";
import { stream } from "./stream.mjs";
import { httpStream2 } from "./http.mjs";

const LF = 0x0a;

// ---- the trivial payloads ----------------------------------------------------

const nullPayload = {
    open(state) {
        control.ready(state.id);
    },
    // The real NullChannel does not take data: Channel.do_data() closes.
    data(state) {
        finish(state, {});
    },
};

const echoPayload = {
    open(state) {
        control.ready(state.id);
    },
    data(state, payload) {
        writeFrame(state.id, payload);
        sendAck(state, payload); // after the echo: EchoChannel.do_data() sends first
    },
    done(state) {
        control.done(state.id);
        finish(state, {});
    },
};

/** What cockpit-bridge 356's Bridge.info() reports, in its key order. */
function defaultInfo() {
    return {
        channels: {
            "dbus-json3": [], echo: [], fsinfo: [], fslist1: [], fsread1: [], fsreplace1: ["attrs"],
            fswatch1: [], "http-stream2": [], info: [], metrics1: [], null: [], "http-stream1": [], stream: [],
        },
        os_release: { NAME: "Mock Linux", ID: "mock", VERSION_ID: "1", PRETTY_NAME: "Mock Linux 1" },
        user: {
            fullname: "Mock User", gid: user.gid, group: user.group, groups: user.groups,
            home: user.home, name: user.name, shell: "/bin/bash", uid: user.uid,
        },
    };
}

const infoPayload = {
    // InfoChannel: ready, one pretty-printed JSON message, done, close.
    open(state) {
        control.ready(state.id);
        sendJson(state.id, scenario.info ?? defaultInfo());
        control.done(state.id);
        finish(state, {});
    },
};

const payloads = {
    null: nullPayload,
    echo: echoPayload,
    info: infoPayload,
    "dbus-json3": dbusjson3,
    "http-stream2": httpStream2,
    stream,
    metrics1,
    fsread1,
    fsreplace1,
    fswatch1,
    fsinfo,
};

// ---- routing -----------------------------------------------------------------

/** str() of a JSON value, as the Python bridge's messages print it. */
function pyStr(value) {
    if (value === null || value === undefined)
        return "None";
    if (typeof value === "boolean")
        return value ? "True" : "False";
    return typeof value === "string" ? value : JSON.stringify(value);
}

/** The options Channel.do_control() parses for every payload, as jsonutil reports bad ones. */
function commonOptionError(options) {
    const flow = options["flow-control"];
    if (flow !== undefined && typeof flow !== "boolean")
        return "attribute 'flow-control': must have type bool";
    const acks = options["send-acks"];
    if (acks !== undefined && acks !== "bytes")
        return `attribute 'send-acks': invalid value "${pyStr(acks)}" not in ['bytes']`;
    if (options.group !== undefined && typeof options.group !== "string")
        return "attribute 'group': must have type str";
    const binary = options.binary;
    if (binary !== undefined && binary !== "raw")
        return `attribute 'binary': invalid value "${pyStr(binary)}" not in ['raw']`;
    return null;
}

function openChannel(options) {
    const id = options.channel;
    if (channels.has(id))
        protocolError("channel is already open");

    // SuperuserRoutingRule: "try" quietly falls back to an unprivileged
    // channel; any other truthy value requires the root bridge.
    if (options.superuser && options.superuser !== "try" && user.uid !== 0 && !rootBridgeActive()) {
        control.close(id, { problem: "access-denied" });
        return;
    }

    const payload = options.payload;
    const handler = typeof payload === "string" && Object.hasOwn(payloads, payload) ? payloads[payload] : null;
    if (!handler) {
        diagnostic(`mock does not implement payload: ${payload}`);
        control.close(id, { problem: "not-supported" });
        return;
    }

    const optionError = commonOptionError(options);
    if (optionError) {
        control.close(id, { message: optionError, problem: "protocol-error" });
        return;
    }

    const state = {
        id, payload, options, handler, timers: new Set(), privileged: isPrivileged(options),
        group: options.group ?? "default",
        flow: options["flow-control"] === true ? { sequence: 0, window: SEND_WINDOW, resume: null } : null,
    };
    channels.set(id, state);
    guarded(state, () => handler.open(state));
}

/** Channel.do_close(): what a client close, a kill and stdin EOF all do. */
function closeChannel(state) {
    if (state.handler.clientClose)
        guarded(state, () => state.handler.clientClose(state));
    else
        finish(state, {});
}

function channelControl(id, command, message) {
    if (command === "open") {
        openChannel(message);
        return;
    }
    const state = channels.get(id);
    // Unknown channels: races are not an error. Hung channels never got
    // ready, and the real bridge queues their messages forever.
    if (!state || state.hung)
        return;

    switch (command) {
    case "close":
        closeChannel(state);
        break;
    case "done":
        if (state.handler.done)
            guarded(state, () => state.handler.done(state, message));
        break;
    case "options":
        if (state.handler.options)
            guarded(state, () => state.handler.options(state, message));
        else
            finish(state, { message: 'This channel does not implement "options"', problem: "not-supported" });
        break;
    case "ping":
        // Receive-side flow control: answered at once, except by metrics1,
        // which never reads its queue.
        if (state.payload !== "metrics1")
            sendControl({ ...message, command: "pong" });
        break;
    case "pong":
        pong(state, message);
        break;
    default:
        break; // "ready" and anything else: ignored
    }
}

function channelData(id, payload) {
    const state = channels.get(id);
    if (!state || state.hung)
        return;
    if (state.handler.data)
        guarded(state, () => state.handler.data(state, payload));
    else
        finish(state, {}); // Channel.do_data(): this payload takes no data
}

function kill(message) {
    const host = message.host ?? null;
    const group = message.group ?? null;
    if ((host !== null && typeof host !== "string") || (group !== null && typeof group !== "string"))
        protocolError("control message: kill with a bad host or group");
    // Channels ignore a kill that names a host (that is for remote peers).
    if (host !== null)
        return;
    for (const state of [...channels.values()]) {
        if (state.hung || (group !== null && state.group !== group))
            continue;
        if (channels.get(state.id) === state)
            closeChannel(state);
    }
}

function transportControl(command, message) {
    switch (command) {
    case "init":
        if (!Number.isInteger(message.version))
            protocolError("control message: attribute 'version' must have type int");
        if (message.version !== 1)
            protocolError("incorrect version number");
        if (typeof message.host !== "string")
            protocolError("control message: attribute 'host' required");
        if (isPlainObject(message.superuser))
            superuserInit(message.superuser);
        break;
    case "kill":
        kill(message);
        break;
    case "authorize":
        superuserAuthorize(message);
        break;
    default:
        // Including "ping": the real bridge answers no transport-level ping.
        protocolError(`unexpected control message ${command} received`);
    }
}

function handleControl(text) {
    let message;
    try {
        message = JSON.parse(text);
    } catch (error) {
        protocolError(`control message: ${error.message}`);
    }
    if (!isPlainObject(message))
        protocolError("control message: must have type dict");
    logReceived("", null, message);
    if (wedged())
        return;
    if (typeof message.command !== "string")
        protocolError("control message: attribute 'command' required");
    if (message.channel !== undefined) {
        if (typeof message.channel !== "string")
            protocolError("control message: attribute 'channel': must have type str");
        channelControl(message.channel, message.command, message);
    } else {
        transportControl(message.command, message);
    }
}

// ---- read loop -------------------------------------------------------------

let buffer = Buffer.alloc(0);

process.stdin.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (wedged())
        diagnostic(`still wedged (${wedged()}); not processing anything received`);
    for (;;) {
        const nl = buffer.indexOf(LF);
        if (nl === -1)
            break;
        const length = Number(buffer.subarray(0, nl).toString("ascii"));
        if (!Number.isInteger(length))
            protocolError("frame size is not an integer");
        const start = nl + 1;
        if (buffer.length < start + length)
            break;
        const frame = buffer.subarray(start, start + length);
        buffer = Buffer.from(buffer.subarray(start + length));

        const split = frame.indexOf(LF);
        const channel = frame.subarray(0, split).toString("utf8");
        const payload = Buffer.from(frame.subarray(split + 1));
        if (channel === "") {
            handleControl(payload.toString("utf8"));
        } else {
            logReceived(channel, payload, null);
            if (!wedged())
                channelData(channel, payload);
        }
    }
});

/*
 * EOF: the router closes every endpoint (each sends its close) and the
 * bridge exits once they are gone. Channels that never got ready never
 * close, which keeps the real bridge alive; the mock exits regardless.
 */
process.stdin.on("end", () => {
    for (const state of [...channels.values()])
        if (!state.hung && channels.get(state.id) === state)
            closeChannel(state);
    process.stdout.write("", () => process.exit(0));
});

process.stdout.on("error", () => process.exit(0));

// ---- startup: the bridge speaks first ---------------------------------------

if (!scenario.noInit) {
    const send = () => sendControl({
        command: "init",
        version: scenario.version ?? 1,
        capabilities: { "explicit-superuser": true },
        "os-release": { NAME: "Mock Linux", ID: "mock", VERSION_ID: "1" },
        packages: { base1: null, system: null },
        ...(scenario.initProblem ? { problem: scenario.initProblem } : {}),
    });
    if (scenario.initDelayMs)
        setTimeout(send, scenario.initDelayMs);
    else
        send();
}

