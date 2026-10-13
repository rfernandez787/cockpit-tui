/*
 * dbus-json3 over a scripted object tree, with the real bridge's semantics
 * (cockpit-bridge 356, channels/dbus.py), confirmed against frames captured
 * from it (system bus, and a throwaway service on a private bus). Services
 * answer like sd-bus ones (systemd, logind, hostnamed, ...: wording from the
 * captures and systemd 252's bus-objects.c); the internal bus answers like
 * the bridge's own systemd_ctypes objects.
 *
 *  - open with "name": a data message {"owner": "<unique>"} comes BEFORE the
 *    ready, which carries "unique-name". A name with no owner gets
 *    {"owner": null} and then close "not-found".
 *  - Every frame must hold exactly one JSON document: anything else (two
 *    newline-separated messages, invalid JSON, a bare number) raises out of
 *    the real do_data() and WEDGES the whole bridge (see core.mjs).
 *  - replies are {"reply": [[...out args]], "id", "flags", "type"}: "flags" is
 *    null unless the call carried "flags" (then "<"), "type" is always the
 *    reply signature. Errors are {"error": [name, [message]], "id"}.
 *  - Calls are marshalled against a signature: the call's "type", "" for no
 *    arguments, or else the method's introspected "in" (cached per channel,
 *    with what "watch" introspected and "meta" messages injected). Wrong
 *    arity or JSON types fail in the bridge as "python.error" with the
 *    Python traceback; a signature the service does not expect gets
 *    InvalidArgs "Invalid arguments 'i' to call I.M(), expecting 's'." --
 *    for methods that declare "in" in the scenario. A call whose arguments
 *    need introspection that is not available gets UnknownMethod
 *    "Introspection data for method ... not available". "timeout" (ms) gives
 *    NoReply "Method call timed out" when the method takes longer; a call
 *    array without four elements, or "args" null without "type", gets no
 *    answer at all.
 *  - "watch" answers meta, then notify, then {"reply": [], "id"}. Meta comes
 *    from introspection, so a path watch without "interface" also lists
 *    org.freedesktop.DBus.Peer, Introspectable and Properties. A watch on a
 *    path with no object fails with only UnknownObject. It also subscribes
 *    the channel to PropertiesChanged under that path (namespace), which
 *    arrives as "notify" with plain values -- one notify per registered watch
 *    covering the path, duplicates included. A path_namespace watch needs an
 *    ObjectManager at exactly that path, or it fails with only an error; with
 *    one, InterfacesAdded/Removed arrive as meta+notify / notify with nulls.
 *  - {"signal": [...]} messages arrive only through "add-match" rules: one
 *    message per matching rule. Channels opened with a "name" only see
 *    signals from that name. "remove-match", "unwatch" and client "signal"
 *    messages are ignored -- the Python bridge implements none.
 *  - Properties are variants ({"t", "v"}) in Get/GetAll replies and in
 *    PropertiesChanged signals, plain values in notify. Properties are
 *    read-only unless the interface lists them in "writable": Set on another
 *    one is PropertyReadOnly "Property 'X' is not writable." (on the
 *    internal bus: UnknownProperty, as systemd_ctypes answers).
 *  - meta reports every property's flags as "r" (the Python bridge reports
 *    readwrite properties as "r"; only write-only ones get "w").
 *
 * Known differences: a GDBus service (NetworkManager, udisks2, ...) answers a
 * watch on a missing path with empty meta/notify/reply instead of an error,
 * and words InvalidArgs differently; the mock answers like sd-bus. A reply
 * "type" without "out" is inferred from the JSON values ("s" for an object
 * path): declare "out" where the signature matters.
 */
import {
    scenario, channels, control, sendJson, sendControl, finish, diagnostic, privilege, user,
    isPlainObject, deepEqual, effectKinds, applyEffect, applyEffects, wedge,
} from "./core.mjs";

const PROPERTIES = "org.freedesktop.DBus.Properties";
const OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager";
const PEER = "org.freedesktop.DBus.Peer";
const INTROSPECTABLE = "org.freedesktop.DBus.Introspectable";
const DEFAULT_OWNER = ":1.42";
const MACHINE_ID = "6d6f636b6d6f636b6d6f636b6d6f636b";

/** Does this bus answer like systemd_ctypes (the bridge's own objects) rather than sd-bus? */
const pythonService = bus => bus === "internal";

// ---- values ----------------------------------------------------------------

function isVariant(value) {
    return isPlainObject(value) && typeof value.t === "string" && Object.hasOwn(value, "v")
        && Object.keys(value).length === 2;
}

/** A best-effort D-Bus signature for a JSON value; scripts can give exact ones. */
function signatureOf(value) {
    if (isVariant(value))
        return "v";
    if (typeof value === "string")
        return "s";
    if (typeof value === "boolean")
        return "b";
    if (typeof value === "number") {
        if (!Number.isInteger(value))
            return "d";
        return value >= -(2 ** 31) && value < 2 ** 31 ? "i" : "x";
    }
    if (Array.isArray(value))
        return `a${value.length ? signatureOf(value[0]) : "s"}`;
    if (isPlainObject(value)) {
        const values = Object.values(value);
        return `a{s${values.length && !values.every(isVariant) ? signatureOf(values[0]) : "v"}}`;
    }
    return "s";
}

/** A property value as the tree keeps it: a variant, its value as the bridge would send it. */
function toVariant(value, type) {
    const variant = isVariant(value) ? value : { t: type ?? signatureOf(value), v: value };
    return { t: variant.t, v: encode(variant.t, variant.v) };
}

/** {name: variant} as notify carries it: {name: value}. */
function plainProps(props) {
    return Object.fromEntries([...props].map(([name, variant]) => [name, variant.v]));
}

// ---- values as the bridge sends them --------------------------------------------

/*
 * The real bridge reads every value off the bus with its D-Bus type, and its
 * JSON encoder (systemd_ctypes' JSONEncoder) writes bytes -- every 'ay' --
 * as a base64 string, inside arrays, dicts, structs and variants too. So
 * wherever the type is known (a property's variant, a reply's "type"/"out",
 * a signal's declared "in"), a scripted 'ay' given as busctl prints it, an
 * array of byte values, goes out as base64, like the real one. A base64
 * string is taken as is (and normalized).
 */
function encode(type, value) {
    if (typeof type !== "string" || !/ay|v/.test(type))
        return value;
    if (type === "ay")
        return encodeBytes(value);
    if (type === "v")
        return isVariant(value) ? { t: value.t, v: encode(value.t, value.v) } : value;
    if (type[0] === "a" && type[1] === "{") {
        const valueType = type.slice(3, -1);
        return isPlainObject(value)
            ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(valueType, item)]))
            : value;
    }
    if (type[0] === "a")
        return Array.isArray(value) ? value.map(item => encode(type.slice(1), item)) : value;
    if (type[0] === "(" && Array.isArray(value)) {
        let members;
        try {
            members = splitSignature(type.slice(1, -1));
        } catch {
            return value;
        }
        return value.map((item, k) => (k < members.length ? encode(members[k], item) : item));
    }
    return value;
}

function encodeBytes(value) {
    if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255))
        return Buffer.from(value).toString("base64");
    const decoded = typeof value === "string" ? a2bBase64(value) : null;
    if (decoded?.bytes)
        return decoded.bytes.toString("base64");
    diagnostic(`an 'ay' value must be an array of byte values or a base64 string; the real bridge never sends ${JSON.stringify(value)}`);
    return value;
}

/** A body (a reply's out arguments, a signal's) encoded by its signature, where that parses. */
function encodeBody(signature, body) {
    let types;
    try {
        types = splitSignature(signature);
    } catch {
        return body;
    }
    return body.map((value, k) => (k < types.length ? encode(types[k], value) : value));
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Python 3.9's binascii.a2b_base64(), which is lenient: characters outside
 * the alphabet are skipped, a pad sequence ends the input, and only a final
 * group of 1 (or 2-3 without their padding) characters is an error.
 * Returns {bytes}, {error: <binascii.Error message>} or {nonAscii: <the
 * UnicodeEncodeError message of value.encode('ascii')>}.
 */
function a2bBase64(text) {
    const chars = Array.from(text);
    const bad = chars.findIndex(c => c.codePointAt(0) > 0x7f);
    if (bad !== -1) {
        let end = bad;
        while (end < chars.length && chars[end].codePointAt(0) > 0x7f)
            end += 1;
        const code = chars[bad].codePointAt(0);
        const shown = code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}`
            : code <= 0xffff ? `\\u${code.toString(16).padStart(4, "0")}` : `\\U${code.toString(16).padStart(8, "0")}`;
        return {
            nonAscii: end - bad === 1
                ? `'ascii' codec can't encode character '${shown}' in position ${bad}: ordinal not in range(128)`
                : `'ascii' codec can't encode characters in position ${bad}-${end - 1}: ordinal not in range(128)`,
        };
    }
    const out = [];
    let quad = 0;
    let left = 0;
    let pads = 0;
    for (const c of chars) {
        if (c === "=") {
            if (quad >= 2 && quad + ++pads >= 4)
                return { bytes: Buffer.from(out) };
            continue;
        }
        const n = BASE64_ALPHABET.indexOf(c);
        if (n === -1)
            continue;
        pads = 0;
        if (quad === 1)
            out.push(((left << 2) | (n >> 4)) & 0xff);
        else if (quad === 2)
            out.push(((left << 4) | (n >> 2)) & 0xff);
        else if (quad === 3)
            out.push(((left << 6) | n) & 0xff);
        left = quad === 0 ? n : quad === 1 ? n & 0x0f : quad === 2 ? n & 0x03 : 0;
        quad = (quad + 1) % 4;
    }
    if (quad === 1) {
        return { error: "Invalid base64-encoded string: number of data characters " +
                        `(${Math.floor(out.length / 3) * 4 + 1}) cannot be 1 more than a multiple of 4` };
    }
    return quad === 0 ? { bytes: Buffer.from(out) } : { error: "Incorrect padding" };
}

// ---- marshalling (systemd_ctypes' bustypes, as JSON values meet it) ----------

/** Split a signature into complete types; throws on an invalid one. */
function splitSignature(signature) {
    const types = [];
    let i = 0;
    const one = () => {
        const c = signature[i];
        if (c === undefined)
            throw new Error("truncated");
        if ("ybnqiuxtdhsogv".includes(c)) {
            i += 1;
            return;
        }
        if (c === "a") {
            i += 1;
            if (signature[i] === "{") {
                i += 1;
                if (!"ybnqiuxtdhsog".includes(signature[i] ?? "!"))
                    throw new Error("bad key");
                i += 1;
                one();
                if (signature[i] !== "}")
                    throw new Error("unclosed {");
                i += 1;
            } else {
                one();
            }
            return;
        }
        if (c === "(") {
            i += 1;
            if (signature[i] === ")")
                throw new Error("empty struct");
            while (signature[i] !== ")") {
                if (signature[i] === undefined)
                    throw new Error("unclosed (");
                one();
            }
            i += 1;
            return;
        }
        throw new Error(`bad type ${c}`);
    };
    while (i < signature.length) {
        const start = i;
        one();
        types.push(signature.slice(start, i));
    }
    return types;
}

function pyTypeName(value) {
    if (value === null || value === undefined)
        return "NoneType";
    if (typeof value === "boolean")
        return "bool";
    if (typeof value === "number")
        return Number.isInteger(value) ? "int" : "float";
    if (typeof value === "string")
        return "str";
    return Array.isArray(value) ? "list" : "dict";
}

/** Python's repr() of a JSON value. */
function pyRepr(value) {
    if (value === null || value === undefined)
        return "None";
    if (typeof value === "boolean")
        return value ? "True" : "False";
    if (typeof value === "number")
        return String(value);
    if (typeof value === "string") {
        const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
        const body = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
            .replace(/[\x00-\x1f\x7f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
        return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote;
    }
    if (Array.isArray(value))
        return `[${value.map(pyRepr).join(", ")}]`;
    return `{${Object.entries(value).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(", ")}}`;
}

/** str() of a value, as an f-string shows it. */
const pyStr = value => (typeof value === "string" ? value : pyRepr(value));

const RANGES = {
    y: [0, 255], n: [-(2 ** 15), 2 ** 15 - 1], q: [0, 2 ** 16 - 1], i: [-(2 ** 31), 2 ** 31 - 1],
    u: [0, 2 ** 32 - 1], x: [-(2 ** 63), 2 ** 63 - 1], t: [0, 2 ** 64 - 1],
};

function isObjectPath(value) {
    return value === "/" || /^(\/[A-Za-z0-9_]+)+$/.test(value);
}

const BUSTYPES = "/usr/lib/python3.9/site-packages/cockpit/_vendor/systemd_ctypes/bustypes.py";
const frame = (line, fn, code) => `  File "${BUSTYPES}", line ${line}, in ${fn}\n    ${code}\n`;
const STRING_WRITER = frame(246, "string_writer", "append_basic(message, type_constant, convert(value))");

/**
 * What the writer for `type` raises for this JSON value, or null:
 * [exception, message, traceback frames inside the writers].
 */
function marshalError(type, value) {
    const c = type[0];
    if (c === "s") {
        return typeof value === "string" ? null
            : ["TypeError", `descriptor 'encode' for 'str' objects doesn't apply to a '${pyTypeName(value)}' object`,
                STRING_WRITER];
    }
    if (c === "o" || c === "g") {
        if (typeof value !== "string") {
            return ["TypeError", `'${c}' encodes 'str', not '${pyTypeName(value)}'`, STRING_WRITER +
                frame(226, "convert", "raise TypeError(f\"'{typestring}' encodes 'str', not '{candidate.__class__.__name__}'\")")];
        }
        if (c === "o" && !isObjectPath(value)) {
            return ["ValueError", "Invalid value provided for type 'o'", STRING_WRITER +
                frame(228, "convert", "raise ValueError(f\"Invalid value provided for type '{typestring}'\")")];
        }
        return null;
    }
    const unrepresentable = () => ["TypeError", `Cannot represent value ${pyStr(value)} with type '${c}'`,
        frame(183, "fixed_writer", "raise TypeError(f\"Cannot represent value {value} with type '{self.typestring}'\")")];
    const ctypesError = message => ["TypeError", message, frame(181, "fixed_writer", "setter(variable, value)")];
    if (c === "b")
        return typeof value === "boolean" || value === 0 || value === 1 ? null : unrepresentable();
    if (RANGES[c]) {
        if (typeof value === "boolean")
            return null; // bool is an int in Python
        if (typeof value !== "number")
            return ctypesError(`an integer is required (got type ${pyTypeName(value)})`);
        if (!Number.isInteger(value))
            return ctypesError("int expected instead of float");
        const [lo, hi] = RANGES[c];
        return value >= lo && value <= hi ? null : unrepresentable();
    }
    if (c === "d") {
        return typeof value === "number" || typeof value === "boolean" ? null
            : ctypesError(`must be real number, not ${pyTypeName(value)}`);
    }
    if (c === "h") {
        return ["TypeError", `'h' type requires file object, not '${pyTypeName(value)}'`,
            frame(205, "handle_writer", "raise TypeError(f\"'h' type requires file object, not '{value.__class__.__name__}'\") from exc")];
    }
    if (c === "v") {
        const bad = ["TypeError", "'v' can encode Variant objects, or mappings with 't' and 'v' keys",
            frame(416, "variant_writer", "raise TypeError(\"'v' can encode Variant objects, or mappings with 't' and 'v' keys\") from exc")];
        if (!isPlainObject(value) || !Object.hasOwn(value, "t") || !Object.hasOwn(value, "v"))
            return bad;
        let inner;
        try {
            inner = typeof value.t === "string" ? splitSignature(value.t) : null;
        } catch {
            inner = null;
        }
        if (!inner || inner.length !== 1)
            return ["TypeError", `Invalid type signature '${pyStr(value.t)}'`, frame(413, "variant_writer", "type_, = from_signature(value['t'])  # type: ignore[index] # can throw TypeError")];
        const error = marshalError(inner[0], value.v);
        return error && [error[0], error[1], frame(419, "variant_writer", "type_.writer(message, contents)") + error[2]];
    }
    if (type === "ay") {
        if (typeof value === "string") {
            return /^[A-Za-z0-9+/]*={0,2}$/.test(value.replace(/\s/g, "")) ? null
                : ["ValueError", "'ay' cannot encode invalid base64 string",
                    frame(260, "bytes_writer", "raise ValueError(\"'ay' cannot encode invalid base64 string\") from exc")];
        }
        return ["TypeError", `'ay' can only encode bytes-like or base64 string objects, not '${pyTypeName(value)}'.`,
            frame(264, "bytes_writer", "raise TypeError(\"'ay' can only encode bytes-like or base64 string objects, \"")];
    }
    if (c === "a" && type[1] === "{") {
        if (!isPlainObject(value)) {
            return ["AttributeError", `'${pyTypeName(value)}' object has no attribute 'items'`,
                frame(383, "dict_writer", "for key, val in value.items():  # type: ignore[attr-defined] # can raise AttributeError")];
        }
        const keyType = type[2];
        const valueType = type.slice(3, -1);
        for (const [key, item] of Object.entries(value)) {
            const keyError = marshalError(keyType, key);
            if (keyError)
                return [keyError[0], keyError[1], frame(385, "dict_writer", "key_writer(message, key)                                 # key") + keyError[2]];
            const valueError = marshalError(valueType, item);
            if (valueError)
                return [valueError[0], valueError[1], frame(386, "dict_writer", "value_writer(message, val)                               # value") + valueError[2]];
        }
        return null;
    }
    const items = Array.isArray(value) ? value : typeof value === "string" ? [...value]
        : isPlainObject(value) ? Object.keys(value) : null;
    if (c === "a") {
        if (!items) {
            return ["TypeError", `'${pyTypeName(value)}' object is not iterable`,
                frame(319, "array_writer", "for item in value:  # type: ignore[attr-defined] # can throw TypeError")];
        }
        for (const item of items) {
            const error = marshalError(type.slice(1), item);
            if (error)
                return [error[0], error[1], frame(320, "array_writer", "item_writer(message, item)") + error[2]];
        }
        return null;
    }
    if (c === "(") {
        if (!items) {
            return ["TypeError", `object of type '${pyTypeName(value)}' has no len()`,
                frame(344, "struct_writer", "n_items = len(value)  # type: ignore[arg-type] # can throw TypeError")];
        }
        const members = splitSignature(type.slice(1, -1));
        if (items.length !== members.length) {
            return ["TypeError", `Wrong numbers of items (${items.length}) for structure type '${type}'`,
                frame(346, "struct_writer", "raise TypeError(f\"Wrong numbers of items ({n_items}) for structure type '{self.typestring}'\")")];
        }
        for (let k = 0; k < members.length; k++) {
            const error = marshalError(members[k], items[k]);
            if (error)
                return [error[0], error[1], frame(349, "struct_writer", "item_writer(message, item)") + error[2]];
        }
        return null;
    }
    return null;
}

const DO_CALL = "Traceback (most recent call last):\n" +
    "  File \"/usr/lib/python3.9/site-packages/cockpit/channels/dbus.py\", line 332, in do_call\n" +
    "    method_call = self.bus.message_new_method_call(self.name, path, iface, method, signature, *args)\n";
const TRACEBACK = DO_CALL +
    "  File \"/usr/lib/python3.9/site-packages/cockpit/_vendor/systemd_ctypes/bus.py\", line 331, in message_new_method_call\n" +
    "    message.append(types, *args)\n";

/** The python.error text message_new_method_call() would produce, or null. */
function marshalArgs(signature, args) {
    let types;
    try {
        types = splitSignature(signature);
    } catch {
        return `${TRACEBACK}TypeError: Invalid type signature '${signature}'\n`;
    }
    if (types.length !== args.length) {
        const tuple = args.length === 1 ? `(${pyRepr(args[0])},)` : `(${args.map(pyRepr).join(", ")})`;
        return TRACEBACK +
            "  File \"/usr/lib/python3.9/site-packages/cockpit/_vendor/systemd_ctypes/bus.py\", line 131, in append\n" +
            "    assert len(types) == len(args), f'call args {args} have different length than signature {signature}'\n" +
            `AssertionError: call args ${tuple} have different length than signature ${signature}\n`;
    }
    for (let k = 0; k < types.length; k++) {
        const error = marshalError(types[k], args[k]);
        if (error) {
            return TRACEBACK +
                "  File \"/usr/lib/python3.9/site-packages/cockpit/_vendor/systemd_ctypes/bus.py\", line 133, in append\n" +
                "    type_.writer(self, arg)\n" +
                `${error[2]}${error[0]}: ${error[1]}\n`;
        }
    }
    return null;
}

// ---- the object tree -------------------------------------------------------

/** bus -> Map(path -> Map(interface -> {props, methods, signals, meta, writable})) */
const trees = {};

function tree(bus) {
    return (trees[bus] ??= new Map());
}

/** True for an "added" value that is a full interface definition. */
function isInterfaceDef(def) {
    return isPlainObject(def) && (isPlainObject(def.properties) || isPlainObject(def.methods));
}

function addInterface(bus, path, iface, def = {}) {
    const objects = tree(bus);
    if (!objects.has(path))
        objects.set(path, new Map());
    objects.get(path).set(iface, {
        props: new Map(Object.entries(def.properties ?? {}).map(([name, value]) => [name, toVariant(value)])),
        methods: def.methods ?? {},
        signals: def.signals ?? {},
        meta: def.meta,
        writable: new Set(def.writable ?? []),
    });
}

for (const [bus, objects] of Object.entries(scenario.dbus ?? {}))
    for (const [path, interfaces] of Object.entries(objects ?? {}))
        for (const [iface, def] of Object.entries(interfaces ?? {}))
            addInterface(bus, path, iface, def ?? {});

/** Introspection data of the standard interfaces, as captured. */
const STANDARD_META = {
    [PEER]: {
        methods: { Ping: { in: [], out: [] }, GetMachineId: { in: [], out: ["s"] } },
        properties: {},
        signals: {},
    },
    [INTROSPECTABLE]: {
        methods: { Introspect: { in: [], out: ["s"] } },
        properties: {},
        signals: {},
    },
    [PROPERTIES]: {
        methods: {
            Get: { in: ["s", "s"], out: ["v"] },
            GetAll: { in: ["s"], out: ["a{sv}"] },
            Set: { in: ["s", "s", "v"], out: [] },
        },
        properties: {},
        signals: { PropertiesChanged: { in: ["s", "a{sv}", "as"] } },
    },
    [OBJECT_MANAGER]: {
        methods: { GetManagedObjects: { in: [], out: ["a{oa{sa{sv}}}"] } },
        properties: {},
        signals: { InterfacesAdded: { in: ["o", "a{sa{sv}}"] }, InterfacesRemoved: { in: ["o", "as"] } },
    },
};

/** The meta entry for one interface, as the real bridge builds it from introspection. */
function metaFor(bus, path, iface) {
    const def = tree(bus).get(path)?.get(iface);
    if (!def)
        return STANDARD_META[iface] && tree(bus).has(path) ? structuredClone(STANDARD_META[iface]) : null;
    if (STANDARD_META[iface])
        return structuredClone(STANDARD_META[iface]);
    const meta = { methods: {}, properties: {}, signals: {} };
    for (const [name, method] of Object.entries(def.methods))
        meta.methods[name] = {
            in: method?.in ?? [],
            out: method?.out ?? (Array.isArray(method?.reply) ? method.reply.map(signatureOf) : []),
        };
    for (const [name, variant] of def.props)
        meta.properties[name] = { flags: "r", type: variant.t };
    for (const [name, signal] of Object.entries(def.signals))
        meta.signals[name] = { in: signal?.in ?? [] };
    for (const section of ["methods", "properties", "signals"])
        if (def.meta?.[section])
            meta[section] = { ...meta[section], ...def.meta[section] };
    return meta;
}

/**
 * Introspect: {interface: meta} for every interface at path, the standard
 * ones included (sd-bus lists Peer, Introspectable and Properties first), or
 * null when there is no object there (UnknownObject).
 */
function introspect(bus, path) {
    const object = tree(bus).get(path);
    if (!object)
        return null;
    const names = pythonService(bus)
        ? [...object.keys(), INTROSPECTABLE, PEER, PROPERTIES]
        : [PEER, INTROSPECTABLE, PROPERTIES, ...object.keys()];
    const result = {};
    for (const name of names)
        result[name] = metaFor(bus, path, name);
    return result;
}

/** The signature the service expects, when the scenario declared it; else null (anything goes). */
function expectedSignature(bus, path, iface, method) {
    if (STANDARD_META[iface])
        return STANDARD_META[iface].methods[method]?.in.join("") ?? null;
    const def = tree(bus).get(path)?.get(iface);
    if (!def)
        return null;
    const spec = Object.hasOwn(def.methods, method) ? def.methods[method] : def.meta?.methods?.[method];
    return Array.isArray(spec?.in) ? spec.in.join("") : null;
}

function inNamespace(path, namespace) {
    return namespace === "/" || path === namespace || path.startsWith(`${namespace}/`);
}

function parentPath(path) {
    const i = path.lastIndexOf("/");
    return i <= 0 ? "/" : path.slice(0, i);
}

/** The ObjectManager that reports objectPath: its nearest managing ancestor. */
function managerOf(bus, objectPath) {
    let path = objectPath;
    while (path !== "/") {
        path = parentPath(path);
        if (tree(bus).get(path)?.has(OBJECT_MANAGER))
            return path;
    }
    return null;
}

/** Introspection XML, for Introspectable.Introspect. */
function introspectionXml(bus, path) {
    const escape = text => String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    let xml = "<node>";
    for (const [name, meta] of Object.entries(introspect(bus, path) ?? {})) {
        xml += `<interface name="${escape(name)}">`;
        for (const [method, info] of Object.entries(meta.methods ?? {})) {
            xml += `<method name="${escape(method)}">`;
            for (const type of info.in ?? [])
                xml += `<arg type="${escape(type)}" direction="in"/>`;
            for (const type of info.out ?? [])
                xml += `<arg type="${escape(type)}" direction="out"/>`;
            xml += "</method>";
        }
        for (const [prop, info] of Object.entries(meta.properties ?? {}))
            xml += `<property name="${escape(prop)}" access="${info.flags === "w" ? "write" : "read"}" type="${escape(info.type)}"/>`;
        for (const [signal, info] of Object.entries(meta.signals ?? {}))
            xml += `<signal name="${escape(signal)}">${(info.in ?? []).map(type => `<arg type="${escape(type)}"/>`).join("")}</signal>`;
        xml += "</interface>";
    }
    const prefix = path === "/" ? "/" : `${path}/`;
    const children = new Set();
    for (const other of tree(bus).keys())
        if (other.startsWith(prefix) && other !== path)
            children.add(other.slice(prefix.length).split("/")[0]);
    for (const child of children)
        xml += `<node name="${escape(child)}"/>`;
    return `${xml}</node>`;
}

// ---- name owners -----------------------------------------------------------

/** bus -> {well-known name -> unique name | null}; unlisted names are owned. */
const owners = structuredClone(scenario.dbusOwners ?? {});

function ownerOf(bus, name) {
    const table = owners[bus] ?? {};
    return Object.hasOwn(table, name) ? table[name] : DEFAULT_OWNER;
}

// ---- delivery --------------------------------------------------------------

function dbusChannels(bus) {
    return [...channels.values()].filter(state => state.payload === "dbus-json3" && state.bus === bus && state.open);
}

/** A channel opened with a name only hears from that name's owner. */
function hears(state, sender) {
    return !state.name || sender === undefined || sender === state.name || sender === state.owner;
}

/** D-Bus match rule semantics for the keys clients use. */
function ruleMatches(rule, path, iface, member, args, sender) {
    for (const [key, value] of Object.entries(rule)) {
        if (key === "type") {
            if (value !== "signal")
                return false;
        } else if (key === "path") {
            if (path !== value)
                return false;
        } else if (key === "path_namespace") {
            if (!inNamespace(path, value))
                return false;
        } else if (key === "interface") {
            if (iface !== value)
                return false;
        } else if (key === "member") {
            if (member !== value)
                return false;
        } else if (key === "sender") {
            if (sender !== undefined && sender !== value)
                return false;
        } else if (/^arg\d+$/.test(key)) {
            if (args[Number(key.slice(3))] !== value)
                return false;
        } else if (/^arg\d+path$/.test(key)) {
            const arg = args[Number(key.slice(3, -4))];
            if (typeof arg !== "string" || !(arg === value || (value.endsWith("/") && arg.startsWith(value))
                                              || (arg.endsWith("/") && value.startsWith(arg))))
                return false;
        } else if (key !== "destination" && key !== "eavesdrop") {
            diagnostic(`add-match key "${key}" is not supported; rule never matches`);
            return false;
        }
    }
    return true;
}

function emitSignal(bus, path, iface, member, args, sender) {
    for (const state of dbusChannels(bus)) {
        if (!hears(state, sender))
            continue;
        for (const rule of state.matches)
            if (ruleMatches(rule, path, iface, member, args, sender))
                sendJson(state.id, { signal: [path, iface, member, args] });
    }
}

/** What a PropertiesChanged signal causes: notify per covering watch, then the signal. */
function emitPropertiesChanged(bus, path, iface, changed, invalidated, sender) {
    const values = Object.fromEntries(Object.entries(changed).map(([name, variant]) => [name, variant.v]));
    // The real bridge Get()s invalidated properties and reports their values.
    const props = tree(bus).get(path)?.get(iface)?.props;
    for (const name of invalidated)
        if (props?.has(name))
            values[name] = props.get(name).v;

    for (const state of dbusChannels(bus)) {
        if (!hears(state, sender))
            continue;
        for (const watch of state.watches)
            if (watch.recursive ? inNamespace(path, watch.path) : path === watch.path)
                sendJson(state.id, { notify: { [path]: { [iface]: values } } });
    }
    emitSignal(bus, path, PROPERTIES, "PropertiesChanged", [iface, changed, invalidated], sender);
}

function emitInterfacesAdded(bus, objectPath, added, sender) {
    const manager = managerOf(bus, objectPath);
    if (!manager)
        return; // nothing announces objects that no ObjectManager covers
    for (const state of dbusChannels(bus)) {
        if (!hears(state, sender))
            continue;
        for (const watch of state.watches) {
            if (!watch.recursive || watch.path !== manager)
                continue;
            const meta = {};
            const notify = {};
            for (const iface of Object.keys(added)) {
                if (watch.interface !== undefined && iface !== watch.interface)
                    continue;
                if (!state.knownInterfaces.has(iface)) {
                    state.knownInterfaces.add(iface);
                    meta[iface] = metaFor(bus, objectPath, iface);
                    state.cache.set(iface, meta[iface]);
                }
                (notify[objectPath] ??= {})[iface] = plainProps(tree(bus).get(objectPath).get(iface).props);
            }
            sendJson(state.id, { meta });
            sendJson(state.id, { notify });
        }
    }
    const variants = Object.fromEntries(Object.keys(added).map(iface =>
        [iface, Object.fromEntries(tree(bus).get(objectPath).get(iface).props)]));
    emitSignal(bus, manager, OBJECT_MANAGER, "InterfacesAdded", [objectPath, variants], sender);
}

function emitInterfacesRemoved(bus, objectPath, removed, sender) {
    const manager = managerOf(bus, objectPath);
    if (!manager)
        return;
    for (const state of dbusChannels(bus)) {
        if (!hears(state, sender))
            continue;
        for (const watch of state.watches)
            if (watch.recursive && watch.path === manager)
                sendJson(state.id, { notify: { [objectPath]: Object.fromEntries(removed.map(iface => [iface, null])) } });
    }
    emitSignal(bus, manager, OBJECT_MANAGER, "InterfacesRemoved", [objectPath, removed], sender);
}

/** Change the property values in the tree and announce it. */
function changeProperties(bus, path, iface, values, invalidated, sender) {
    if (!tree(bus).get(path)?.has(iface))
        addInterface(bus, path, iface);
    const props = tree(bus).get(path).get(iface).props;
    const changed = {};
    for (const [name, value] of Object.entries(values)) {
        const variant = toVariant(value, props.get(name)?.t);
        props.set(name, variant);
        changed[name] = variant;
    }
    emitPropertiesChanged(bus, path, iface, changed, invalidated ?? [], sender);
}

function setOwner(bus, name, owner) {
    (owners[bus] ??= {})[name] = owner;
    for (const state of dbusChannels(bus)) {
        // cockpit.js relies on never seeing the same owner twice in a row.
        if (state.name === name && state.owner !== owner) {
            state.owner = owner;
            sendJson(state.id, { owner });
        }
    }
}

// ---- effects ---------------------------------------------------------------

const busOf = (effect, context) => effect.bus ?? context.bus ?? "system";
const senderOf = (effect, context) => effect.sender ?? context.sender;

effectKinds.signal = (effect, context) => {
    const [path, iface, member, args = []] = effect.signal;
    emitSignal(busOf(effect, context), path, iface, member, args, senderOf(effect, context));
};

effectKinds.properties = (effect, context) => {
    const [path, iface, values] = effect.properties;
    changeProperties(busOf(effect, context), path, iface, values, effect.invalidated, senderOf(effect, context));
};

effectKinds.added = (effect, context) => {
    const bus = busOf(effect, context);
    const [path, interfaces] = effect.added;
    for (const [iface, def] of Object.entries(interfaces))
        addInterface(bus, path, iface, isInterfaceDef(def) ? def : { properties: def ?? {} });
    emitInterfacesAdded(bus, path, interfaces, senderOf(effect, context));
};

effectKinds.removed = (effect, context) => {
    const bus = busOf(effect, context);
    const [path, names] = effect.removed;
    const object = tree(bus).get(path);
    const removed = names ?? [...(object?.keys() ?? [])];
    for (const iface of removed)
        object?.delete(iface);
    if (object && object.size === 0)
        tree(bus).delete(path);
    emitInterfacesRemoved(bus, path, removed, senderOf(effect, context));
};

effectKinds.owner = (effect, context) => {
    const [name, owner] = effect.owner;
    setOwner(busOf(effect, context), name, owner);
};

// ---- the channel -----------------------------------------------------------

export const dbusjson3 = {
    open(state) {
        const { bus, address, name } = state.options;
        if (address !== undefined && bus !== undefined && bus !== "none") {
            finish(state, { message: 'only one of "bus" and "address" can be specified', problem: "protocol-error" });
            return;
        }
        if (address === undefined && bus !== undefined && !["system", "session", "internal"].includes(bus)) {
            finish(state, { message: `invalid bus "${bus}"`, problem: "protocol-error" });
            return;
        }
        state.bus = address ?? bus ?? "system";
        state.name = name ?? null;
        state.matches = [];
        state.watches = [];
        state.knownInterfaces = new Set(); // InterfaceCache.old
        state.cache = new Map();           // InterfaceCache.cache: interface -> meta
        state.injected = new Set();        // ... of which the client's own "meta"
        state.open = true;

        if (state.name === null) {
            control.ready(state.id);
            return;
        }
        const owner = ownerOf(state.bus, state.name);
        state.owner = owner;
        sendJson(state.id, { owner });
        if (owner === null)
            finish(state, { problem: "not-found" });
        else
            control.ready(state.id, { "unique-name": owner });
    },

    data(state, payload) {
        // json.loads(data): exactly one JSON document, or the bridge is wedged.
        let message;
        try {
            message = JSON.parse(payload.toString("utf8"));
        } catch (error) {
            wedge(`dbus-json3 channel ${state.id} got a frame that is not one JSON document ` +
                  `(dbus.py do_data(): json.loads raised: ${error.message}); send each message in its own frame`);
            return;
        }
        if (message === null || typeof message !== "object") {
            wedge(`dbus-json3 channel ${state.id} got ${JSON.stringify(message)}, which is not an object ` +
                  "(dbus.py do_data(): 'call' in message raised TypeError)");
            return;
        }
        if (Array.isArray(message)) {
            diagnostic(`channel ${state.id}: ignoring a dbus-json3 message that is an array, not an object`);
            return;
        }
        if (Object.hasOwn(message, "call")) {
            call(state, message).catch(error => {
                // What the real do_call() answers for an unexpected exception.
                diagnostic(`channel ${state.id}: ${error?.stack || error}`);
                sendError(state, message, ["python.error", [String(error?.stack || error)]]);
            });
        } else if (Object.hasOwn(message, "add-match")) {
            addMatch(state, message["add-match"]);
        } else if (Object.hasOwn(message, "watch")) {
            watch(state, message);
        } else if (Object.hasOwn(message, "meta")) {
            // InterfaceCache.inject(): signatures for later calls.
            if (isPlainObject(message.meta)) {
                for (const [iface, meta] of Object.entries(message.meta)) {
                    state.cache.set(iface, meta);
                    state.injected.add(iface);
                }
            }
        }
        // "remove-match", "unwatch", "signal": ignored, like the real one.
    },

    clientClose(state) {
        state.open = false;
        finish(state, {});
    },
};

function stillOpen(state) {
    return channels.get(state.id) === state;
}

function sendReply(state, message, body, type) {
    if (!stillOpen(state) || message.timedOut)
        return;
    clearTimeout(message.timer);
    sendJson(state.id, {
        reply: [body],
        id: message.id ?? null,
        flags: message.flags !== undefined && message.flags !== null ? "<" : null,
        type: type ?? body.map(signatureOf).join(""),
    });
}

function sendError(state, message, error) {
    if (!stillOpen(state) || message.timedOut)
        return;
    clearTimeout(message.timer);
    const [name, detail] = error;
    sendJson(state.id, { error: [name, Array.isArray(detail) ? detail : [detail ?? ""]], id: message.id ?? null });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * InterfaceCache.get_signature(): the cache first, else introspect the
 * call's path (and keep everything found there). null when not available.
 */
function introspectedSignature(state, path, iface, method) {
    let meta = state.cache.get(iface);
    if (!meta) {
        // Introspect fails (and is ignored) where there is no object or no owner.
        const found = state.name !== null && state.owner === null ? null : introspect(state.bus, path);
        for (const [name, entry] of Object.entries(found ?? {}))
            if (entry)
                state.cache.set(name, entry);
        meta = state.cache.get(iface);
    }
    const info = meta?.methods?.[method];
    return info ? (info.in ?? []).join("") : null;
}

async function call(state, message) {
    const parts = message.call;
    if (!Array.isArray(parts) || parts.length !== 4) {
        // path, iface, method, args = message['call'] raises in the task: no answer.
        diagnostic(`channel ${state.id}: a "call" needs [path, interface, method, args]; the real bridge never answers this one`);
        return;
    }
    const [path, iface, method] = parts;
    let args = parts[3];
    if (typeof args === "string")
        args = [...args]; // Python iterates a string
    else if (isPlainObject(args))
        args = Object.keys(args);

    if (typeof message.timeout === "number") {
        // sd-bus: 0 means its default of 25 s.
        message.timer = setTimeout(() => {
            sendError(state, message, ["org.freedesktop.DBus.Error.NoReply", ["Method call timed out"]]);
            message.timedOut = true;
        }, message.timeout > 0 ? message.timeout : 25000);
    }

    let signature = typeof message.type === "string" ? message.type : null;
    if (signature === null) {
        if (!Array.isArray(args)) {
            diagnostic(`channel ${state.id}: call args ${JSON.stringify(args)} without a "type": ` +
                       "len(args) raises in the real bridge, which never answers");
            clearTimeout(message.timer);
            return;
        }
        if (args.length === 0) {
            signature = "";
        } else {
            signature = introspectedSignature(state, path, iface, method);
            if (signature === null) {
                sendError(state, message, ["org.freedesktop.DBus.Error.UnknownMethod",
                    [`Introspection data for method ${iface} ${method} not available`]]);
                return;
            }
            // A scripted method that does not declare "in" takes anything,
            // unless the client injected the interface's meta itself.
            const declared = expectedSignature(state.bus, path, iface, method);
            if (declared === null && !STANDARD_META[iface] && !state.injected.has(iface))
                signature = null;
        }
    } else if (!Array.isArray(args)) {
        sendError(state, message, ["python.error",
            [`${DO_CALL}TypeError: message_new_method_call() argument after * must be an iterable, not ${pyTypeName(args)}\n`]]);
        return;
    }

    if (signature !== null) {
        const error = marshalArgs(signature, args);
        if (error) {
            sendError(state, message, ["python.error", [error]]);
            return;
        }
    }

    if (state.name !== null && state.owner === null) {
        sendError(state, message, ["org.freedesktop.DBus.Error.ServiceUnknown",
            [`The name ${state.name} was not provided by any .service files`]]);
        return;
    }
    await service(state, message, path, iface, method, args, signature);
}

/** The receiving service: an sd-bus object tree (or systemd_ctypes on the internal bus). */
async function service(state, message, path, iface, method, args, signature) {
    const object = tree(state.bus).get(path);
    if (!object) {
        sendError(state, message, ["org.freedesktop.DBus.Error.UnknownObject", [`Unknown object '${path}'.`]]);
        return;
    }
    const python = pythonService(state.bus);
    const unknownMethod = () => sendError(state, message, ["org.freedesktop.DBus.Error.UnknownMethod",
        [`Unknown method ${method} or interface ${iface}.`]]);

    // The signature the method expects, where the scenario says.
    const expected = expectedSignature(state.bus, path, iface, method);
    const known = (STANDARD_META[iface] && (iface !== OBJECT_MANAGER || object.has(OBJECT_MANAGER))
                   && STANDARD_META[iface].methods[method])
        || (object.get(iface) && (Object.hasOwn(object.get(iface).methods, method)
                                  || object.get(iface).meta?.methods?.[method]));
    if (known && expected !== null && signature !== null && signature !== expected) {
        if (python) {
            unknownMethod(); // systemd_ctypes leaves the message unhandled
        } else if (iface === PROPERTIES) {
            sendError(state, message, ["org.freedesktop.DBus.Error.InvalidArgs",
                [method === "GetAll" ? "Expected interface parameter" : "Expected interface and member parameters"]]);
        } else if (iface === INTROSPECTABLE) {
            sendError(state, message, ["org.freedesktop.DBus.Error.InvalidArgs", ["Expected no parameters"]]);
        } else {
            sendError(state, message, ["org.freedesktop.DBus.Error.InvalidArgs",
                [`Invalid arguments '${signature}' to call ${iface}.${method}(), expecting '${expected}'.`]]);
        }
        return;
    }

    if (state.bus === "internal" && path === "/superuser" && iface === "cockpit.Superuser") {
        superuserCall(state, message, method, args);
        return;
    }

    const def = object.get(iface);
    if (def && Object.hasOwn(def.methods, method)) {
        await scripted(state, message, def.methods[method] ?? {}, args);
        return;
    }
    if (iface === PROPERTIES && ["Get", "GetAll", "Set"].includes(method)) {
        properties(state, message, object, method, args);
        return;
    }
    if (iface === OBJECT_MANAGER && method === "GetManagedObjects" && object.has(OBJECT_MANAGER)) {
        const result = {};
        for (const [p, interfaces] of tree(state.bus))
            if (p !== path && inNamespace(p, path))
                result[p] = Object.fromEntries([...interfaces].map(([name, d]) => [name, Object.fromEntries(d.props)]));
        sendReply(state, message, [result], "a{oa{sa{sv}}}");
        return;
    }
    if (iface === PEER && method === "Ping") {
        sendReply(state, message, [], "");
        return;
    }
    if (iface === PEER && method === "GetMachineId") {
        sendReply(state, message, [MACHINE_ID], "s");
        return;
    }
    if (iface === INTROSPECTABLE && method === "Introspect") {
        sendReply(state, message, [introspectionXml(state.bus, path)], "s");
        return;
    }
    unknownMethod();
}

/** A scripted method: reply/error/effects, optionally chosen by the arguments. */
async function scripted(state, message, spec, args) {
    const outcome = (spec.byArgs ?? []).find(entry => deepEqual(entry.args, args)) ?? spec;
    const effects = outcome.effects ?? [];
    const context = { bus: state.bus, sender: state.name ?? undefined };

    // Effects a service performs before it replies arrive before the reply.
    for (const effect of effects.filter(e => e.beforeReply)) {
        if (effect.delayMs)
            await sleep(effect.delayMs);
        applyEffect(effect, context);
    }
    const delay = outcome.delayMs ?? spec.delayMs;
    if (delay)
        await sleep(delay);

    if (outcome.error)
        sendError(state, message, outcome.error);
    else
        sendReply(state, message, outcome.reply ?? [], outcome.type ?? spec.type ?? spec.out?.join(""));

    applyEffects(effects.filter(e => !e.beforeReply), context);
}

/** org.freedesktop.DBus.Properties against the tree, with sd-bus's errors. */
function properties(state, message, object, method, args) {
    const [ifaceName, name, value] = args;
    const def = object.get(ifaceName);
    if (method === "GetAll") {
        if (!def) {
            sendError(state, message, ["org.freedesktop.DBus.Error.UnknownInterface", [`Unknown interface '${ifaceName}'.`]]);
            return;
        }
        sendReply(state, message, [Object.fromEntries(def.props)], "a{sv}");
        return;
    }
    const unknownProperty = () => sendError(state, message, ["org.freedesktop.DBus.Error.UnknownProperty",
        [`Unknown interface ${ifaceName} or property ${name}.`]]);
    if (!def || !def.props.has(name)) {
        unknownProperty();
        return;
    }
    if (method === "Get") {
        sendReply(state, message, [def.props.get(name)], "v");
        return;
    }
    // Set.
    const current = def.props.get(name);
    if (!def.writable.has(name)) {
        if (pythonService(state.bus))
            unknownProperty(); // systemd_ctypes: no setter, the message is left unhandled
        else
            sendError(state, message, ["org.freedesktop.DBus.Error.PropertyReadOnly", [`Property '${name}' is not writable.`]]);
        return;
    }
    if (isVariant(value) && value.t !== current.t) {
        if (pythonService(state.bus))
            unknownProperty();
        else
            sendError(state, message, ["org.freedesktop.DBus.Error.InvalidArgs",
                [`Incorrect parameters for property '${name}', expected '${current.t}', got '${value.t}'.`]]);
        return;
    }
    // sd-bus emits PropertiesChanged before the method return.
    changeProperties(state.bus, message.call[0], ifaceName, { [name]: value }, [], state.name ?? undefined);
    sendReply(state, message, [], "");
}

function addMatch(state, rule) {
    const copy = { ...rule };
    // The real bridge drops path_namespace='/' (dbus-broker rejects it); it
    // matches everything anyway.
    if (copy.path_namespace === "/")
        delete copy.path_namespace;
    state.matches.push(copy);
}

function watch(state, message) {
    const spec = message.watch ?? {};
    const id = message.id;
    const path = spec.path || spec.path_namespace;
    const recursive = path === spec.path_namespace;

    if (!path || id === undefined || id === null) {
        sendJson(state.id, { error: ["x.y.z", ["Not Implemented"]], id: id ?? null });
        sendJson(state.id, { reply: [], id: id ?? null });
        return;
    }

    // setup_path_watch(): introspect first. No object there (or no owner): only an error.
    const objects = tree(state.bus);
    const root = objects.get(path);
    const introspected = state.name !== null && state.owner === null ? null : introspect(state.bus, path);
    if (!introspected) {
        sendJson(state.id, { error: ["org.freedesktop.DBus.Error.UnknownObject", [`Unknown object '${path}'.`]], id });
        return;
    }
    for (const [name, entry] of Object.entries(introspected))
        state.cache.set(name, entry);

    const meta = spec.interface !== undefined ? { [spec.interface]: introspected[spec.interface] ?? null } : introspected;
    const notify = {};
    for (const iface of Object.keys(meta))
        if (!iface.startsWith("org.freedesktop.DBus.") && root.has(iface))
            (notify[path] ??= {})[iface] = plainProps(root.get(iface).props);

    // PropertiesChanged under the path is watched from here on -- even when
    // the ObjectManager step below fails.
    state.watches.push({ path, recursive, interface: spec.interface });

    if (recursive) {
        if (!root.has(OBJECT_MANAGER)) {
            sendError(state, message, ["org.freedesktop.DBus.Error.UnknownMethod",
                [`Unknown method GetManagedObjects or interface ${OBJECT_MANAGER}.`]]);
            return;
        }
        for (const [objectPath, interfaces] of objects) {
            if (objectPath === path || !inNamespace(objectPath, path))
                continue;
            for (const [iface, def] of interfaces) {
                if (spec.interface !== undefined && iface !== spec.interface)
                    continue;
                if (!state.knownInterfaces.has(iface)) {
                    state.knownInterfaces.add(iface);
                    meta[iface] = metaFor(state.bus, objectPath, iface);
                    state.cache.set(iface, meta[iface]);
                }
                (notify[objectPath] ??= {})[iface] = plainProps(def.props);
            }
        }
    }

    sendJson(state.id, { meta });
    sendJson(state.id, { notify });
    sendJson(state.id, { reply: [], id });
}

// ---- cockpit.Superuser on the internal bus -----------------------------------

/*
 * Stateful, because the flow under test is a conversation: Start emits Prompt,
 * the client replies with Answer, and only then does Start return. Scenario:
 *
 *   "superuserFlow": {
 *     "prompts": [ { "prompt": "Password for alice: ", "error": "" } ],
 *     "password": "s3cr3t",
 *     "peerExitAfterMs": 500,            // optional: the root bridge dies on its own
 *     "bridges": ["sudo", "pkexec"]      // or {"name": "sudo", "label": null}
 *   }
 *
 * The real Methods property is keyed by each config's label and lists only
 * configs that have one (often none: {}). A plain string bridge keeps the
 * mock's original {"<name>": {"label": "Password" | name}} entry, which
 * existing tests rely on; give {"name", "label"} objects for the real shape.
 */

/** The real bridge's introspection of /superuser, captured. */
const SUPERUSER_META = {
    methods: { Start: { in: ["s"], out: [] }, Stop: { in: [], out: [] }, Answer: { in: ["s"], out: [] } },
    properties: {
        Bridges: { flags: "r", type: "as" },
        Current: { flags: "r", type: "s" },
        Methods: { flags: "r", type: "a{sv}" },
    },
    signals: { Prompt: { in: ["s", "s", "s", "b", "s"] } },
};

const flow = scenario.superuserFlow || {};
const bridgeConfigs = (flow.bridges || ["sudo"]).map(entry => (typeof entry === "string"
    ? { name: entry, legacyLabel: entry === "sudo" ? "Password" : entry }
    : { name: entry.name, label: entry.label ?? null }));
const bridges = bridgeConfigs.map(config => config.name);

function methodsProperty() {
    const methods = {};
    for (const config of bridgeConfigs) {
        if (config.legacyLabel !== undefined)
            methods[config.name] = { t: "a{sv}", v: { label: { t: "s", v: config.legacyLabel } } };
        else if (config.label)
            methods[config.label] = { t: "a{sv}", v: { label: { t: "s", v: config.label } } };
    }
    return methods;
}

if (user.uid === 0)
    privilege.current = "root"; // a root session's bridge is already privileged

addInterface("internal", "/superuser", "cockpit.Superuser", {
    properties: {
        Bridges: { t: "as", v: bridges },
        Current: { t: "s", v: privilege.current },
        Methods: { t: "a{sv}", v: methodsProperty() },
    },
    meta: SUPERUSER_META,
});

const superuserState = { pending: null, round: 0, initCookie: null, nextCookie: 0 };

function setCurrent(value) {
    privilege.current = value;
    changeProperties("internal", "/superuser", "cockpit.Superuser", { Current: { t: "s", v: value } }, [], undefined);
}

/*
 * The privileged peer going away -- Stop, or the peer dying -- closes every
 * channel routed through it, with "terminated", before anything else is
 * said (peer.py; upstream test_bridge.py checks the closes precede the Stop
 * reply). Channels of a session that is root anyway stay.
 */
function closePrivilegedChannels(message) {
    if (user.uid === 0 || scenario.superuser === true)
        return;
    for (const state of [...channels.values()]) {
        if (state.privileged && state.options?.superuser)
            finish(state, { problem: "terminated", ...(message ? { message } : {}) });
    }
}

/** superuserFlow.peerExitAfterMs: the escalated bridge dies on its own. */
function schedulePeerExit() {
    if (typeof flow.peerExitAfterMs !== "number")
        return;
    setTimeout(() => {
        if (["none", "init", "root"].includes(privilege.current))
            return;
        closePrivilegedChannels("Peer exited with status 1");
        setCurrent("none");
    }, flow.peerExitAfterMs);
}

function emitPrompt(prompt) {
    emitSignal("internal", "/superuser", "cockpit.Superuser", "Prompt", [
        prompt.message || "",
        prompt.prompt || "Password: ",
        prompt.default || "",
        prompt.echo ?? false,
        prompt.error || "",
    ], undefined);
}

function superuserCall(state, message, method, args) {
    const prompts = flow.prompts || [];

    if (method === "Start") {
        if (privilege.current !== "none") {
            sendError(state, message, ["cockpit.Superuser.Error", ["Superuser bridge already running"]]);
            return;
        }
        const config = bridgeConfigs.find(c => c.name === args[0] || args[0] === "any");
        if (!config) {
            sendError(state, message, ["cockpit.Superuser.Error", [`Unknown superuser bridge type "${args[0]}"`]]);
            return;
        }
        superuserState.round = 0;
        superuserState.pending = { state, message, name: config.name };
        setCurrent("init");
        if (prompts.length === 0) {
            // Passwordless sudo: straight to success.
            setCurrent(config.name);
            sendReply(state, message, [], "");
            superuserState.pending = null;
            schedulePeerExit();
            return;
        }
        emitPrompt(prompts[0]);
        return;
    }

    if (method === "Answer") {
        const pending = superuserState.pending;
        if (!pending || superuserState.initCookie !== null) {
            sendReply(state, message, [], ""); // "got Answer, but no prompt pending"
            return;
        }
        if (args[0] !== (flow.password ?? "s3cr3t")) {
            superuserState.round += 1;
            const next = prompts[superuserState.round];
            if (next) {
                // The Answer's reply comes first; sudo asks again after.
                sendReply(state, message, [], "");
                emitPrompt({ ...next, error: "Sorry, try again." });
                return;
            }
            setCurrent("none");
            sendReply(state, message, [], "");
            sendError(pending.state, pending.message, ["cockpit.Superuser.Error", ["sudo says: Sorry, try again."]]);
            superuserState.pending = null;
            return;
        }
        setCurrent(pending.name);
        sendReply(state, message, [], "");
        sendReply(pending.state, pending.message, [], "");
        superuserState.pending = null;
        schedulePeerExit();
        return;
    }

    if (method === "Stop") {
        const pending = superuserState.pending;
        superuserState.pending = null;
        if (privilege.current !== "root") {
            closePrivilegedChannels();
            setCurrent("none");
        }
        sendReply(state, message, [], "");
        if (pending?.message)
            sendError(pending.state, pending.message, ["cockpit.Superuser.Error.Cancelled", ["Operation aborted"]]);
        return;
    }

    sendError(state, message, ["org.freedesktop.DBus.Error.UnknownMethod",
        [`Unknown method ${method} or interface cockpit.Superuser.`]]);
}

/*
 * Escalation requested by the client's init ("superuser": {"id": ...}):
 * SuperuserRoutingRule.init() with an AuthorizeResponder, which asks once,
 * through a transport-level authorize challenge, and gives up on a second
 * prompt. A transport-level "superuser-init-done" follows either way.
 */
export function superuserInit(params) {
    const done = () => sendControl({ command: "superuser-init-done" });
    const id = params.id ?? "any";
    if (typeof id !== "string")
        return; // a JsonError the real bridge swallows: nothing at all happens
    if (privilege.current !== "none") {
        done();
        return;
    }
    const config = bridgeConfigs.find(c => c.name === id || id === "any");
    if (!config) {
        done();
        return;
    }
    setCurrent("init");
    if ((flow.prompts || []).length === 0) {
        setCurrent(config.name);
        done();
        return;
    }
    const cookie = String(superuserState.nextCookie++);
    superuserState.initCookie = cookie;
    superuserState.pending = { name: config.name, done };
    const hexuser = Buffer.from(user.name, "ascii").toString("hex");
    sendControl({ command: "authorize", challenge: `plain1:${hexuser}`, cookie });
}

/** The client's {"command": "authorize", "cookie", "response"}. */
export function superuserAuthorize(message) {
    if (typeof message.cookie !== "string" || message.cookie !== superuserState.initCookie) {
        diagnostic("no matching authorize request");
        return;
    }
    const pending = superuserState.pending;
    superuserState.initCookie = null;
    superuserState.pending = null;
    // An empty response means "no password"; a wrong one fails, since the
    // AuthorizeResponder does not ask twice.
    if (typeof message.response === "string" && message.response !== "" && message.response === (flow.password ?? "s3cr3t"))
        setCurrent(pending.name);
    else
        setCurrent("none");
    pending.done();
}
