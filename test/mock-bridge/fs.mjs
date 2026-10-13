/*
 * The in-memory filesystem behind fsread1, fsreplace1, fswatch1 and fsinfo.
 *
 * Message shapes follow cockpit-bridge 356's channels/filesystem.py, confirmed
 * against frames captured from the real bridge:
 *
 *  - Ownership like a real host's: the session user's home belongs to the
 *    user, everything else to root:root; files 0644, directories 0755, /tmp
 *    and /var/tmp 01777, /root 0550. Scenario entries can say otherwise.
 *  - Unprivileged channels get the kernel's permission checks. Reading needs
 *    search (x) permission on every ancestor and read permission on the file.
 *    fsreplace1 creates a temp file in the target's DIRECTORY
 *    (tempfile.mkstemp(dir=...)), then renames (or, for tag "-", links) it
 *    over the target; deleting unlinks there. So writes and deletions need
 *    write+search permission on the directory, ownership of the target in a
 *    sticky directory, and a write with a tag fchown()s the temp file to the
 *    old owner, which only root may give away. PermissionError is
 *    "access-denied". Privileged channels act as root.
 *  - fsread1 text mode reads 16 KiB blocks and decodes each on its own with
 *    errors="ignore" after dropping NULs, so a character split across a
 *    block boundary is lost, exactly like the real one; a block that decodes
 *    to nothing still sends an (empty) frame.
 *  - fsreplace1 with "size" creates the temp file before ready, so a bad
 *    directory closes without ready; without "size" that happens at the
 *    first data frame.
 *  - Watch events are the inotify events the real operations cause: an
 *    fsreplace1 write shows up in a watched directory as created/changed
 *    for ".name-XXXXXXXX", attribute-changed/deleted for it (tag "-"), then
 *    changed/done-hint for the target; a watched file that is replaced gets
 *    "created" (a new identity) and one that is written in place "changed".
 *    fsinfo watches debounce by 100 ms and send JSON merge patches, with a
 *    reset when the watched path's identity changes.
 *  - Watching needs READ permission on the watched file or directory itself
 *    (inotify_add_watch()), stat() does not: fsinfo with "watch": true --
 *    cockpit.file().watch() -- on an unprivileged channel reports a 0000 file
 *    or an unreadable directory as {"error": {"problem": "access-denied",
 *    ...}} while watch: false gets its info, and neither fsinfo nor fswatch1
 *    sees in-place changes of it or entries coming and going in it. That it
 *    is replaced, deleted or created is still reported (a replacement by
 *    another unreadable file as the partial error/error pair).
 *  - Pseudo-files stat as the kernel says: size 0 under /proc, 4096 under
 *    /sys, whatever the content (fsinfo "size", fsread1's max_read_size check
 *    and "size-hint"); a scenario "size" overrides it. procfs reads come a
 *    page at a time, cut at a line end.
 *  - Flow control: with "flow-control", fsread1 stops after the 2 MiB window
 *    until the client's pong, like GeneratorChannel.
 *
 * Deliberate simplifications: no symlinks (fsinfo "target"/"targets" never
 * report anything); several data frames into one fsreplace1 produce a single
 * "changed" for its temp file (inotify may coalesce them, or not). The real
 * PathWatch notices a replacement only through a watch on the directory
 * above, which also needs read permission: a watched file in a directory
 * that is searchable but not readable (0711) stays on its old inode there,
 * silently; the mock always notices.
 */
import {
    scenario, channels, control, sendJson, writeFrame, finish, schedule,
    user, usersByName, groupsByName, isPlainObject, toBytes, effectKinds, deepEqual, sendAck,
} from "./core.mjs";

const BLOCK_SIZE = 16 * 1024;           // Channel.BLOCK_SIZE in the real bridge
const MAX_READ_SIZE = 16 * 1024 * 1024; // fsread1's default max_read_size

/** Wall-clock seconds as a float, like os.stat()'s st_mtime. */
function now() {
    return (performance.timeOrigin + performance.now()) / 1000;
}

/** Python's repr() of a float: integral values keep their ".0". */
function pyFloat(x) {
    return Number.isInteger(x) ? `${x}.0` : String(x);
}

let nextIno = 83885;

// ---- paths -----------------------------------------------------------------

function normalize(path) {
    const collapsed = path.replace(/\/+/g, "/");
    return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

function dirname(path) {
    const i = path.lastIndexOf("/");
    return i <= 0 ? "/" : path.slice(0, i);
}

function basename(path) {
    return path.slice(path.lastIndexOf("/") + 1);
}

function join(dir, name) {
    return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function inHome(path) {
    return path === user.home || path.startsWith(`${user.home}/`);
}

// ---- the tree --------------------------------------------------------------

/** path -> {content: Buffer, ino, mtime, mode, uid, gid} */
const files = new Map();
/** path -> {ino, mtime, mode, uid, gid}; every ancestor of a file is here. */
const dirs = new Map();

function nameOf(table, id) {
    const hit = Object.entries(table).find(([, value]) => value === id);
    return hit ? hit[0] : id;
}

/** Owner and mode from a scenario spec, with defaults for what it omits. */
function ownership(spec, defaults) {
    let uid = spec.uid;
    let gid = spec.gid;
    if (uid === undefined && spec.user !== undefined)
        uid = typeof spec.user === "number" ? spec.user : (usersByName[spec.user] ?? 0);
    if (gid === undefined && spec.group !== undefined)
        gid = typeof spec.group === "number" ? spec.group : (groupsByName[spec.group] ?? 0);
    return {
        uid: uid ?? defaults.uid,
        gid: gid ?? defaults.gid,
        mode: spec.mode ?? defaults.mode,
    };
}

/** Directories every host has, with their usual modes (all root-owned). */
const STANDARD_DIRS = {
    "/": 0o555, "/bin": 0o555, "/boot": 0o555, "/dev": 0o755, "/dev/shm": 0o1777, "/etc": 0o755,
    "/home": 0o755, "/lib": 0o555, "/lib64": 0o555, "/media": 0o755, "/mnt": 0o755, "/opt": 0o755,
    "/proc": 0o555, "/root": 0o550, "/run": 0o755, "/sbin": 0o555, "/srv": 0o755, "/sys": 0o555,
    "/tmp": 0o1777, "/usr": 0o755, "/usr/bin": 0o755, "/usr/lib": 0o755, "/usr/lib64": 0o755,
    "/usr/libexec": 0o755, "/usr/local": 0o755, "/usr/sbin": 0o755, "/usr/share": 0o755, "/var": 0o755,
    "/var/cache": 0o755, "/var/lib": 0o755, "/var/log": 0o755, "/var/tmp": 0o1777,
};

function defaultDirOwner(path) {
    if (inHome(path))
        return { uid: user.uid, gid: user.gid, mode: path === user.home ? 0o700 : 0o755 };
    return { uid: 0, gid: 0, mode: STANDARD_DIRS[path] ?? 0o755 };
}

function defaultFileOwner(path) {
    return inHome(path) ? { uid: user.uid, gid: user.gid, mode: 0o644 } : { uid: 0, gid: 0, mode: 0o644 };
}

function ensureDir(path) {
    if (path !== "/")
        ensureDir(dirname(path));
    if (!dirs.has(path))
        dirs.set(path, { ino: nextIno++, mtime: now(), ...defaultDirOwner(path) });
}

/** A scenario file spec -- "text", {"base64"} or {"content", "mode", "user", "size", ...}. */
function parseFileSpec(spec, defaults) {
    const object = isPlainObject(spec);
    return {
        content: object ? toBytes(spec.base64 !== undefined ? { base64: spec.base64 } : spec.content ?? "")
            : toBytes(spec),
        ...ownership(object ? spec : {}, defaults),
        ...(object && Number.isInteger(spec.size) ? { size: spec.size } : {}),
    };
}

/*
 * What stat() says a file's size is. Pseudo-files do not know their content's
 * length: procfs files say 0 and sysfs attributes a page (4096), while a read
 * still returns the content. fsinfo "size", fsread1's max_read_size check and
 * its "size-hint" all use this, as the real ones use st_size. A scenario's
 * "size" overrides it.
 */
function statSize(path, file) {
    if (file.size !== undefined)
        return file.size;
    if (path.startsWith("/proc/"))
        return 0;
    if (path.startsWith("/sys/"))
        return 4096;
    return file.content.length;
}

/*
 * The blocks read1(16 KiB) returns. procfs hands out at most a page per read,
 * and only whole records (seq_file): approximated as a page cut at a line end.
 */
function readBlocks(path, content) {
    const blocks = [];
    const proc = path.startsWith("/proc/");
    for (let start = 0; start < content.length;) {
        let end = Math.min(start + (proc ? 4096 : BLOCK_SIZE), content.length);
        if (proc && end < content.length) {
            const nl = content.lastIndexOf(0x0a, end - 1);
            if (nl >= start)
                end = nl + 1;
        }
        blocks.push(content.subarray(start, end));
        start = end;
    }
    return blocks;
}

for (const path of Object.keys(STANDARD_DIRS))
    ensureDir(path);
ensureDir(user.home);

for (const [rawPath, spec] of Object.entries(scenario.files ?? {})) {
    if (rawPath.endsWith("/")) {
        const path = normalize(rawPath);
        ensureDir(path);
        Object.assign(dirs.get(path), ownership(isPlainObject(spec) ? spec : {}, dirs.get(path)));
        continue;
    }
    if (spec === null)
        continue; // declared absent: documentation for the reader of the scenario
    const path = normalize(rawPath);
    ensureDir(dirname(path));
    files.set(path, { ino: nextIno++, mtime: now(), ...parseFileSpec(spec, defaultFileOwner(path)) });
}

function isDir(path) {
    return dirs.has(path);
}

function tagFor(node, isDirectory) {
    const type = isDirectory ? 0o40000 : 0o100000;
    return `1:${node.ino}-${pyFloat(node.mtime)}-${(type | node.mode).toString(8)}-${node.uid}-${node.gid}`;
}

function tagOf(path) {
    const file = files.get(path);
    if (file)
        return tagFor(file, false);
    const dir = dirs.get(path);
    return dir ? tagFor(dir, true) : "-";
}

// ---- permissions -------------------------------------------------------------

function userGids() {
    return [user.gid, ...user.groups.map(name => groupsByName[name]).filter(gid => gid !== undefined)];
}

/**
 * Unix permission check for the bridge's user, or root when privileged.
 * bits: 4 read, 2 write, 1 execute/search (or a combination).
 */
function permits(node, bits, privileged, isDirectory = false) {
    if (privileged || user.uid === 0) {
        // Root reads and writes anything; executes a file only if some x bit is set.
        return !(bits & 1) || isDirectory || Boolean(node.mode & 0o111);
    }
    let granted;
    if (node.uid === user.uid)
        granted = (node.mode >> 6) & 7;
    else if (userGids().includes(node.gid))
        granted = (node.mode >> 3) & 7;
    else
        granted = node.mode & 7;
    return (granted & bits) === bits;
}

/**
 * Path resolution like the kernel's: search permission on every directory on
 * the way. Returns {error: "ENOENT" | "ENOTDIR" | "EACCES"}, {dir} or {file}.
 */
function lookup(path, privileged) {
    let current = "/";
    for (const part of path.split("/").filter(Boolean)) {
        const dir = dirs.get(current);
        if (!dir)
            return { error: files.has(current) ? "ENOTDIR" : "ENOENT" };
        if (!permits(dir, 1, privileged, true))
            return { error: "EACCES" };
        current = join(current, part);
    }
    if (dirs.has(current))
        return { dir: dirs.get(current) };
    if (files.has(current))
        return { file: files.get(current) };
    return { error: "ENOENT" };
}

/** May the bridge's user unlink or rename over `target` in `parentDir` (the sticky bit)? */
function mayReplace(parentDir, target, privileged) {
    if (privileged || user.uid === 0 || !target || !(parentDir.mode & 0o1000))
        return true;
    return target.uid === user.uid || parentDir.uid === user.uid;
}

/** May an unprivileged fchown() give the file this owner? */
function mayChown(uid, gid, privileged) {
    return privileged || user.uid === 0 || (uid === user.uid && userGids().includes(gid));
}

/**
 * Where a stream channel's "directory" stands: "ok", "not-found",
 * "access-denied" or "not-directory" (subprocess.Popen's chdir).
 */
export function directoryStatus(rawPath, privileged) {
    const path = normalize(rawPath.startsWith("/") ? rawPath : join(user.home, rawPath));
    const found = lookup(path, privileged);
    if (found.error === "ENOENT")
        return "not-found";
    if (found.error === "EACCES")
        return "access-denied";
    if (found.error === "ENOTDIR" || found.file)
        return "not-directory";
    return permits(found.dir, 1, privileged, true) ? "ok" : "access-denied";
}

// ---- watch events ------------------------------------------------------------

/*
 * What the inotify events of a change look like to watchers. Each function
 * reports one kind of event; the write paths below call them in the order
 * the real operations produce them.
 */

function* watchers(payload) {
    for (const state of channels.values())
        if (state.payload === payload && (payload !== "fsinfo" || state.watch))
            yield state;
}

/*
 * What a watch's PathWatch holds: walk() resolves the path (search
 * permission on the way, like any lookup) to {node}, or fails with {errno}.
 * On the node it then adds an inotify watch of its own, and
 * inotify_add_watch() needs READ permission: for an unprivileged watch on a
 * 0000 file or a directory without "r" it fails (watched: false). Such a
 * watch gets none of the node's own events -- no in-place writes or
 * attribute changes, no entries of a directory coming and going -- and fsinfo
 * reports it as access-denied. Identity changes (the path replaced, deleted,
 * created) are seen from the directory above and are reported either way.
 */
function walk(state) {
    const found = lookup(state.path, state.privileged);
    if (found.error)
        return { errno: found.error };
    const node = found.file ?? found.dir;
    return { node, watched: permits(node, 4, state.privileged, Boolean(found.dir)) };
}

/** An event on `path` as seen by watchers of its directory (do_inotify_event with a name). */
function childEvent(path, event, { type = null, tag } = {}) {
    const dir = dirname(path);
    for (const state of watchers("fswatch1"))
        if (state.path === dir && state.target.watched)
            sendJson(state.id, { event, path, tag: tag ?? tagOf(path), type });
    for (const state of watchers("fsinfo"))
        if (state.path === dir && state.target.watched)
            fsinfoSchedule(state, basename(path));
}

/** The watched path may name a different file, or none now (PathWatch.invalidate()). */
function identityChanged(path) {
    for (const state of [...watchers("fswatch1"), ...watchers("fsinfo")]) {
        if (state.path !== path)
            continue;
        const before = state.target;
        const after = walk(state);
        // The same file still, or the same error again: nothing to report.
        if (after.node ? after.node === before.node : (!before.node && after.errno === before.errno))
            continue;
        state.target = after;
        if (state.payload === "fsinfo") {
            reportInitialState(state);
            continue;
        }
        // FsWatchChannel.do_identity_changed(): "created" with the new file's
        // tag, else "deleted" -- after the IN_ATTRIB its own watch on the
        // vanishing file sees (its link count drops), if it had one.
        if (after.node) {
            state.lastTag = tagOf(path);
            sendJson(state.id, { event: "created", path, tag: state.lastTag });
        } else {
            if (before.watched && state.lastTag !== "-")
                sendJson(state.id, { event: "attribute-changed", path, tag: "-", type: null });
            state.lastTag = "-";
            sendJson(state.id, { event: "deleted", path, tag: "-" });
        }
    }
}

/** The watched path's own file was written in place (IN_MODIFY, then IN_CLOSE_WRITE). */
function modifiedInPlace(path) {
    for (const state of watchers("fswatch1")) {
        if (state.path !== path || !state.target.watched)
            continue;
        const tag = tagOf(path);
        if (tag !== state.lastTag) // duplicate events are filtered by tag
            sendJson(state.id, { event: "changed", path, tag, type: null });
        state.lastTag = tag;
    }
    for (const state of watchers("fsinfo"))
        if (state.path === path && state.target.watched)
            fsinfoSchedule(state, "");
}

function touchDir(path, mtime = now()) {
    const dir = dirs.get(dirname(path));
    if (dir)
        dir.mtime = mtime;
}

// ---- changes made by others: the "files" effect ------------------------------

/** Replace path with a new inode (rename into place) holding content. */
function replaceFile(path, content, owned) {
    ensureDir(dirname(path));
    const entry = { content, ino: nextIno++, mtime: now(), ...owned };
    files.set(path, entry);
    touchDir(path, entry.mtime);
    // MOVED_TO reads as "changed" (mask_to_event_and_type), then the close.
    childEvent(path, "changed");
    childEvent(path, "done-hint");
    identityChanged(path);
}

/** Write content into path's existing inode, or create it in place (open, write, close). */
function writeInPlace(path, content, owned) {
    ensureDir(dirname(path));
    const existing = files.get(path);
    const mtime = now();
    if (existing) {
        Object.assign(existing, { content, mtime, ...owned });
        childEvent(path, "changed");
        childEvent(path, "done-hint");
        modifiedInPlace(path);
        return;
    }
    files.set(path, { content, ino: nextIno++, mtime, ...owned });
    touchDir(path, mtime);
    childEvent(path, "created", { type: "file" });
    childEvent(path, "changed");
    childEvent(path, "done-hint");
    identityChanged(path);
}

function unlinkFile(path) {
    if (!files.delete(path))
        return;
    touchDir(path);
    childEvent(path, "deleted", { tag: "-" });
    identityChanged(path);
}

/*
 * The "files" effect: something else (a command, a D-Bus service) changed
 * files behind the client's back. Runs as root: no permission or tag checks.
 */
effectKinds.files = effect => {
    for (const [rawPath, spec] of Object.entries(effect.files)) {
        const path = normalize(rawPath);
        if (spec === null) {
            unlinkFile(path);
            continue;
        }
        // An existing file keeps its owner and mode unless the spec says otherwise.
        const old = files.get(path);
        const { content, ...owned } = parseFileSpec(spec, old ?? defaultFileOwner(path));
        if (effect.inPlace)
            writeInPlace(path, content, owned);
        else
            replaceFile(path, content, owned);
    }
};

// ---- text handling ---------------------------------------------------------

/**
 * Length of the valid UTF-8 sequence at i: n > 0 valid, -k invalid where k is
 * the length of the maximal invalid subpart, 0 when truncated by the end.
 */
function utf8SequenceAt(bytes, i) {
    const b = bytes[i];
    if (b < 0x80)
        return 1;
    let need;
    let lo = 0x80;
    let hi = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) {
        need = 1;
    } else if (b >= 0xe0 && b <= 0xef) {
        need = 2;
        if (b === 0xe0) lo = 0xa0;
        if (b === 0xed) hi = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
        need = 3;
        if (b === 0xf0) lo = 0x90;
        if (b === 0xf4) hi = 0x8f;
    } else {
        return -1;
    }
    for (let k = 1; k <= need; k++) {
        if (i + k >= bytes.length)
            return 0;
        const c = bytes[i + k];
        if (c < lo || c > hi)
            return -k;
        lo = 0x80;
        hi = 0xbf;
    }
    return need + 1;
}

/**
 * What a text-mode fsread1 sends for one block: NULs removed, then invalid
 * UTF-8 dropped, i.e. data.replace(b'\0', b'').decode(errors='ignore').
 */
function textForRead(block) {
    const bytes = block.filter(b => b !== 0);
    const out = [];
    let i = 0;
    while (i < bytes.length) {
        const n = utf8SequenceAt(bytes, i);
        if (n > 0) {
            for (let k = 0; k < n; k++)
                out.push(bytes[i + k]);
            i += n;
        } else {
            i += n === 0 ? bytes.length - i : -n;
        }
    }
    return Buffer.from(out);
}

// ---- option validation (jsonutil's error wording) ---------------------------

class OptionError extends Error {}

function getStr(options, key, fallback) {
    if (!Object.hasOwn(options, key)) {
        if (fallback !== undefined)
            return fallback;
        throw new OptionError(`attribute '${key}' required`);
    }
    if (typeof options[key] !== "string")
        throw new OptionError(`attribute '${key}': must have type str`);
    return options[key];
}

function getInt(options, key, fallback) {
    if (!Object.hasOwn(options, key))
        return fallback;
    if (!Number.isInteger(options[key]))
        throw new OptionError(`attribute '${key}': must have type int`);
    return options[key];
}

/*
 * Run an open handler, turning bad options into a protocol-error close. The
 * key order differs by channel class: a JsonError inside an AsyncChannel's
 * task (fsreplace1) closes {problem, message}; elsewhere the router's
 * ChannelError gives {message, problem}.
 */
function withOptions(state, fn, problemFirst = false) {
    try {
        fn();
    } catch (error) {
        if (!(error instanceof OptionError))
            throw error;
        finish(state, problemFirst
            ? { problem: "protocol-error", message: error.message }
            : { message: error.message, problem: "protocol-error" });
    }
}

/** A close for an OSError the bridge reports as internal-error, with its traceback. */
function internalError(where, line, code, exception, message) {
    return {
        message,
        problem: "internal-error",
        cause: [
            "Traceback (most recent call last):\n",
            `  File "/usr/lib/python3.9/site-packages/cockpit/channels/filesystem.py", line ${line}, in ${where}\n    ${code}\n`,
            `${exception}: ${message}\n`,
        ],
    };
}

// ---- fsread1 ---------------------------------------------------------------

export const fsread1 = {
    open(state) {
        withOptions(state, () => {
            const rawPath = getStr(state.options, "path");
            const maxReadSize = getInt(state.options, "max_read_size", MAX_READ_SIZE);
            const path = normalize(rawPath);
            const binary = state.options.binary === "raw";

            const found = lookup(path, state.privileged);
            if (found.error === "ENOENT") {
                // No ready at all: the generator returns before ready().
                control.done(state.id);
                finish(state, { tag: "-" });
                return;
            }
            if (found.error === "EACCES" || (found.file && !permits(found.file, 4, state.privileged))) {
                finish(state, { problem: "access-denied" });
                return;
            }
            if (found.error === "ENOTDIR" || found.dir) {
                const [exception, message] = found.dir
                    ? ["IsADirectoryError", `[Errno 21] Is a directory: '${rawPath}'`]
                    : ["NotADirectoryError", `[Errno 20] Not a directory: '${rawPath}'`];
                finish(state, internalError("do_yield_data", 122, "with open(path, 'rb') as filep:", exception, message));
                return;
            }
            const file = found.file;
            const size = statSize(path, file);
            if (maxReadSize !== -1 && size > maxReadSize) {
                finish(state, { problem: "too-large" });
                return;
            }

            control.ready(state.id, binary ? { "size-hint": size } : {});
            const content = Buffer.from(file.content); // what open() saw
            const tag = tagOf(path);
            const blocks = readBlocks(path, content).map(block => (binary ? block : textForRead(block)));
            sendBlocks(state, blocks, 0, tag);
        });
    },
};

/** GeneratorChannel.do_resume_send(): send until the window is full, resume on pong. */
function sendBlocks(state, blocks, index, tag) {
    let i = index;
    while (i < blocks.length) {
        if (!writeFrame(state.id, blocks[i++])) {
            state.flow.resume = () => sendBlocks(state, blocks, i, tag);
            return;
        }
    }
    control.done(state.id);
    finish(state, { tag });
}

// ---- fsreplace1 ------------------------------------------------------------

function parseAttrs(state) {
    const attrs = state.options.attrs;
    if (attrs === undefined)
        return null;
    if (!isPlainObject(attrs))
        throw new OptionError("attribute 'attrs': must have type dict");
    const unsupported = Object.keys(attrs).filter(key => !["user", "group", "mode"].includes(key));
    if (unsupported.length) {
        finish(state, {
            message: `"attrs" contains unsupported key(s): ${unsupported.join(",")}`,
            "unsupported-attrs": unsupported,
            problem: "protocol-error",
        });
        return undefined;
    }
    const { user: owner, group, mode } = attrs;
    if (owner !== undefined && group === undefined) {
        finish(state, { message: '"group" attribute is empty while "user" is provided', problem: "protocol-error" });
        return undefined;
    }
    if (group !== undefined && owner === undefined) {
        finish(state, { message: '"user" attribute is empty while "group" is provided', problem: "protocol-error" });
        return undefined;
    }
    if (typeof owner === "string" && !(owner in usersByName)) {
        finish(state, { message: `uid not found for ${owner}`, problem: "not-found" });
        return undefined;
    }
    if (typeof group === "string" && !(group in groupsByName)) {
        finish(state, { message: `gid not found for ${group}`, problem: "not-found" });
        return undefined;
    }
    const uid = typeof owner === "string" ? usersByName[owner] : owner;
    const gid = typeof group === "string" ? groupsByName[group] : group;
    return { uid, gid, mode };
}

const TEMP_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_";

function tempName(path) {
    let suffix = "";
    for (let i = 0; i < 8; i++)
        suffix += TEMP_CHARS[Math.floor(Math.random() * TEMP_CHARS.length)];
    return join(dirname(path), `.${basename(path)}-${suffix}`);
}

export const fsreplace1 = {
    open(state) {
        withOptions(state, () => {
            const attrs = parseAttrs(state);
            if (attrs === undefined)
                return; // already closed
            state.rawPath = getStr(state.options, "path");
            state.path = normalize(state.rawPath);
            state.size = getInt(state.options, "size", undefined);
            state.tag = getStr(state.options, "tag", null);
            state.attrs = attrs;
            state.chunks = [];
            state.temp = null;
            // With "size" the temp file is created (and allocated) first,
            // and ready only follows if that worked.
            if (state.size !== undefined && !createTemp(state))
                return;
            control.ready(state.id);
        }, true);
    },

    data(state, payload) {
        // AsyncChannel.read() acknowledges a frame as it takes it, before
        // acting on it (even if that then fails).
        sendAck(state, payload);
        // Without "size", the first frame (even an empty one) creates the temp file.
        if (!state.temp && !createTemp(state))
            return;
        state.chunks.push(payload);
    },

    done(state) {
        // EOF with no data frame at all is a request to delete; an empty
        // frame first means "write an empty file".
        if (!state.temp)
            deleteFile(state);
        else
            writeFile(state);
    },

    // Aborted mid-way: nothing is written, the real bridge just closes.
    clientClose(state) {
        if (state.temp)
            dropTemp(state);
        finish(state, {});
    },
};

/** tempfile.mkstemp(dir=dirname): the directory decides. Closes the channel on failure. */
function createTemp(state) {
    const parent = dirname(state.path);
    const found = lookup(parent, state.privileged);
    if (found.error === "ENOENT") {
        finish(state, { problem: "not-found" });
        return false;
    }
    const name = tempName(state.path);
    if (found.error === "ENOTDIR" || found.file) {
        const message = `[Errno 20] Not a directory: '${name}'`;
        finish(state, internalError("set_contents", 189, "fd, tmpname = tempfile.mkstemp(dir=dirname, prefix=f'.{basename}-')",
                                    "NotADirectoryError", message));
        return false;
    }
    if (found.error === "EACCES" || !permits(found.dir, 3, state.privileged, true)) {
        finish(state, { problem: "access-denied" });
        return false;
    }
    const actor = state.privileged || user.uid === 0 ? { uid: 0, gid: 0 } : { uid: user.uid, gid: user.gid };
    state.temp = { name, ino: nextIno++, mtime: now(), mode: 0o600, ...actor };
    found.dir.mtime = state.temp.mtime;
    const tag = tagFor(state.temp, false);
    childEvent(name, "created", { type: "file", tag });
    childEvent(name, "changed", { tag });
    return true;
}

/** The temp file goes away without becoming the target (an error, or an abort). */
function dropTemp(state) {
    childEvent(state.temp.name, "deleted", { tag: "-" });
    touchDir(state.temp.name);
    state.temp = null;
}

function fail(state, args) {
    if (state.temp)
        dropTemp(state);
    finish(state, args);
}

function deleteFile(state) {
    const { path, tag } = state;
    if (tag !== null && tag !== tagOf(path)) {
        finish(state, { problem: "change-conflict" });
        return;
    }
    const parent = lookup(dirname(path), state.privileged);
    if (parent.error === "EACCES" || (parent.dir && files.has(path) && (
        !permits(parent.dir, 3, state.privileged, true) || !mayReplace(parent.dir, files.get(path), state.privileged)))) {
        finish(state, { problem: "access-denied" });
        return;
    }
    if (isDir(path)) {
        finish(state, { message: `[Errno 21] Is a directory: '${state.rawPath}'`, problem: "access-denied" });
        return;
    }
    control.done(state.id);
    unlinkFile(path); // idempotent, like the real one
    finish(state, { tag: "-" });
}

function writeFile(state) {
    const { path, tag, attrs, temp } = state;
    const privileged = state.privileged || user.uid === 0;
    const parentDir = dirs.get(dirname(path));
    const existing = files.get(path);

    // apply_file_mode() and chown_if_required() on the temp file.
    let owned;
    if (tag === null || tag === "-") {
        owned = { uid: temp.uid, gid: temp.gid, mode: attrs?.mode ?? 0o644 }; // 0o666 & ~umask
    } else {
        if (!existing && !isDir(path)) {
            fail(state, { problem: "not-found" });
            return;
        }
        const node = existing ?? dirs.get(path);
        if (!permits(node, 4, privileged, !existing)) { // os.open(path, O_RDONLY)
            fail(state, { problem: "access-denied" });
            return;
        }
        if (tag !== tagOf(path)) {
            fail(state, { problem: "change-conflict" });
            return;
        }
        owned = { uid: node.uid, gid: node.gid, mode: attrs?.mode ?? node.mode };
    }
    if (attrs?.uid !== undefined)
        Object.assign(owned, { uid: attrs.uid, gid: attrs.gid });
    if ((attrs?.uid !== undefined || (tag !== null && tag !== "-")) && !mayChown(owned.uid, owned.gid, privileged)) {
        fail(state, { problem: "access-denied" }); // fchown(): EPERM
        return;
    }

    const content = Buffer.concat(state.chunks);
    // fchmod (IN_ATTRIB): by the time the watcher looks, the temp name is gone.
    childEvent(temp.name, "attribute-changed", { tag: "-" });

    if (tag === "-") {
        // os.link(): refuses an existing target; the temp name is unlinked after.
        if (existing || isDir(path)) {
            fail(state, { problem: "change-conflict" });
            return;
        }
        control.done(state.id);
        files.set(path, { content, ino: temp.ino, mtime: temp.mtime, ...owned });
        childEvent(path, "created", { type: "file" });
        childEvent(temp.name, "done-hint", { tag: "-" });
        childEvent(temp.name, "deleted", { tag: "-" });
        state.temp = null;
        touchDir(path);
        identityChanged(path);
        finish(state, { tag: tagOf(path) });
        return;
    }

    // os.rename(tmpname, path)
    if (isDir(path)) {
        fail(state, { message: `[Errno 21] Is a directory: '${temp.name}' -> '${state.rawPath}'`, problem: "access-denied" });
        return;
    }
    if (!mayReplace(parentDir, existing, privileged)) {
        fail(state, { problem: "access-denied" });
        return;
    }
    control.done(state.id);
    files.set(path, { content, ino: temp.ino, mtime: temp.mtime, ...owned });
    state.temp = null;
    touchDir(path);
    childEvent(temp.name, "deleted", { tag: "-" }); // MOVED_FROM
    childEvent(path, "changed");                    // MOVED_TO
    childEvent(path, "done-hint");                  // close(fd), now under the new name
    identityChanged(path);
    finish(state, { tag: tagOf(path) });
}

// ---- fswatch1 --------------------------------------------------------------

export const fswatch1 = {
    open(state) {
        withOptions(state, () => {
            state.path = normalize(getStr(state.options, "path"));
            // No initial event: the C bridge never sent one and cockpit.js
            // calls read() for the initial state instead.
            state.target = walk(state);
            state.lastTag = state.target.node ? tagOf(state.path) : "-";
            control.ready(state.id);
        });
    },
};

// ---- fsinfo ----------------------------------------------------------------

/** fnmatch.fnmatch(): * and ? match anything (including "/"), [...] classes. */
function fnmatch(name, pattern) {
    let re = "";
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === "*") {
            re += "[\\s\\S]*";
        } else if (c === "?") {
            re += "[\\s\\S]";
        } else if (c === "[") {
            const close = pattern.indexOf("]", i + 2);
            if (close === -1) {
                re += "\\[";
            } else {
                let body = pattern.slice(i + 1, close).replace(/\\/g, "\\\\");
                if (body.startsWith("!"))
                    body = `^${body.slice(1)}`;
                re += `[${body}]`;
                i = close;
            }
        } else {
            re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
        }
    }
    return new RegExp(`^${re}$`).test(name);
}

function children(dir) {
    const names = [];
    for (const path of [...files.keys(), ...dirs.keys()])
        if (path !== dir && dirname(path) === dir)
            names.push(basename(path));
    return names;
}

function statAttrs(state, path) {
    const file = files.get(path);
    const dir = file ? null : dirs.get(path);
    const node = file ?? dir;
    if (!node)
        return null;
    const getters = {
        type: () => (file ? "reg" : "dir"),
        tag: () => tagOf(path),
        mode: () => node.mode,
        size: () => (file ? statSize(path, file) : 4096),
        uid: () => node.uid,
        gid: () => node.gid,
        mtime: () => node.mtime,
        user: () => nameOf(usersByName, node.uid),
        group: () => nameOf(groupsByName, node.gid),
        // os.access() as the bridge's user (or root, when privileged).
        "r-ok": () => permits(node, 4, state.privileged, Boolean(dir)),
        "w-ok": () => permits(node, 2, state.privileged, Boolean(dir)),
        "x-ok": () => permits(node, 1, state.privileged, Boolean(dir)),
    };
    const result = {};
    for (const attr of state.attrs)
        result[attr] = getters[attr] ? getters[attr]() : null;
    return result;
}

function fsinfoInteresting(state, name) {
    return name === "" || (state.effectiveFnmatch !== "" && fnmatch(name, state.effectiveFnmatch));
}

/** json_merge_and_filter_patch(): apply patch to current, drop no-ops from patch. */
function mergeAndFilter(current, patch) {
    for (const key of Object.keys(patch)) {
        const patchValue = patch[key];
        const currentValue = current[key] ?? null;
        if (isPlainObject(patchValue)) {
            if (!isPlainObject(currentValue)) {
                current[key] = {};
                mergeAndFilter(current[key], patchValue);
            } else {
                mergeAndFilter(currentValue, patchValue);
                if (Object.keys(patchValue).length === 0)
                    delete patch[key];
            }
        } else if (deepEqual(currentValue, patchValue ?? null)) {
            delete patch[key];
        } else if (patchValue !== null) {
            current[key] = patchValue;
        } else {
            delete current[key];
        }
    }
}

/** FsInfoChannel.send_update(): incremental JSON merge patches, with resets. */
function sendUpdate(state, updates, reset = false) {
    if (reset) {
        const currentKeys = Object.keys(state.current);
        if (currentKeys.some(key => Object.hasOwn(updates, key))) {
            // Overlap: retract everything first, flagged partial.
            sendJson(state.id, { ...Object.fromEntries(currentKeys.map(key => [key, null])), partial: true });
            state.current = { partial: true };
            updates.partial = null;
        } else {
            for (const key of currentKeys)
                updates[key] = null;
        }
    }
    mergeAndFilter(state.current, updates);
    if (Object.keys(updates).length)
        sendJson(state.id, updates);
}

function processUpdate(state, names, reset = false) {
    const entries = {};
    for (const name of names)
        entries[name] = statAttrs(state, name ? join(state.path, name) : state.path);
    const info = entries[""] ?? {};
    delete entries[""];
    if (state.effectiveFnmatch)
        info.entries = entries;
    sendUpdate(state, { info }, reset);
}

const ERRORS = {
    ENOENT: { problem: "not-found", message: "No such file or directory", errno: "ENOENT" },
    ENOTDIR: { problem: "not-directory", message: "Not a directory", errno: "ENOTDIR" },
    EACCES: { problem: "access-denied", message: "Permission denied", errno: "EACCES" },
};

function reportInitialState(state) {
    if (state.pending)
        state.pending.clear();
    const found = lookup(state.path, state.privileged);
    const wantsDir = state.rawPath.length > 1 && state.rawPath.endsWith("/");
    // A watch reports a node it cannot add its inotify watch to (no read
    // permission) as access-denied, even though stat() would work: watch:
    // false still gets its info.
    const unwatchable = state.watch && !found.error
        && !permits(found.file ?? found.dir, 4, state.privileged, Boolean(found.dir));
    const error = found.error ?? (unwatchable ? "EACCES" : found.file && wantsDir ? "ENOTDIR" : null);
    if (error) {
        sendUpdate(state, { error: { ...ERRORS[error] } }, true);
        return;
    }
    const names = [""];
    state.effectiveFnmatch = "";
    // os.listdir() needs read permission; without it nothing is listed.
    if (state.fnmatch && found.dir && permits(found.dir, 4, state.privileged, true)) {
        state.effectiveFnmatch = state.fnmatch;
        names.push(...children(state.path));
    }
    processUpdate(state, names.filter(name => fsinfoInteresting(state, name)), true);
}

export const fsinfo = {
    open(state) {
        withOptions(state, () => {
            state.rawPath = getStr(state.options, "path");
            if (!state.rawPath.startsWith("/"))
                throw new OptionError('"path" must be an absolute path');
            const attrs = state.options.attrs;
            if (!Array.isArray(attrs) || attrs.some(a => typeof a !== "string"))
                throw new OptionError(attrs === undefined ? "attribute 'attrs' required"
                    : "attribute 'attrs': must have type list");
            state.path = normalize(state.rawPath);
            state.attrs = attrs.filter(a => a !== "targets" && a !== "entries");
            state.fnmatch = state.options.fnmatch ?? (attrs.includes("entries") ? "*" : "");
            state.watch = state.options.watch ?? false;
            state.current = {};
            state.pending = null;
            if (state.watch)
                state.target = walk(state);

            control.ready(state.id);
            reportInitialState(state);
            if (!state.watch) {
                control.done(state.id);
                finish(state, {});
            }
        });
    },
};

/**
 * do_inotify_event(): schedule_update(name), and the directory itself for any
 * named change; debounced by 100 ms and only for interesting names.
 */
function fsinfoSchedule(state, name) {
    const add = changed => {
        if (!fsinfoInteresting(state, changed))
            return;
        if (state.pending === null) {
            state.pending = new Set();
            schedule(state, 100, () => {
                const pending = state.pending;
                state.pending = null;
                if (pending.size)
                    processUpdate(state, [...pending]);
            });
        }
        state.pending.add(changed);
    };
    add(name);
    if (name !== "")
        add("");
}
