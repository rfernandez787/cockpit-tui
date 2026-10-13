/*
 * The systemd journal, read through journalctl over the bridge.
 *
 * Shared by the Logs page and the unit logs on Services. Modelled on
 * upstream's pkg/lib/journal.js, with the corrections verified against
 * systemd 252 / bridge 356 (see the README's protocol notes):
 *
 *  - Paging is bounded on the server with --lines=N --reverse; upstream's
 *    client-side caps overshoot by thousands of entries.
 *  - Following starts *after* the newest cursor already shown, or with
 *    --lines=0 when nothing was shown, so it never replays history.
 *  - Exit status 1 means both "--grep matched nothing" and every real error;
 *    only stderr tells them apart (classifyExit).
 *  - An identifier filter uses --identifier=, and extra FIELD=VALUE matches
 *    are distributed into every branch of a unit's OR group: positional
 *    matches parse as A + B + C D = A OR B OR (C AND D).
 *  - Values journalctl could not print as UTF-8 text arrive as byte arrays;
 *    they are decoded here, but are still raw text: run anything shown on
 *    screen through text.ts clean().
 */
import cockpit from "../cockpit.js";
import { runFull, streamLines, type LineStream, type SpawnOptions } from "../tui/hooks.js";

export const PRIORITIES = ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"] as const;
export type Priority = typeof PRIORITIES[number];

/** Upstream's labels for the priority filter (logs.jsx). */
export const PRIORITY_LABELS: Record<Priority, string> = {
    emerg: "Only emergency",
    alert: "Alert and above",
    crit: "Critical and above",
    err: "Error and above",
    warning: "Warning and above",
    notice: "Notice and above",
    info: "Info and above",
    debug: "Debug and above",
};

/** Short names for a priority number, as shown in a list. */
export const PRIORITY_BADGES = ["EMERG", "ALERT", "CRIT", "ERR", "WARN", "NOTICE", "INFO", "DEBUG"] as const;

export interface JournalEntry {
    readonly cursor: string;
    /** Milliseconds since the epoch. */
    readonly time: number;
    readonly bootId: string;
    /** 0 (emerg) .. 7 (debug); null for the rare entry without PRIORITY. */
    readonly priority: number | null;
    /** SYSLOG_IDENTIFIER, else _COMM, else "". */
    readonly identifier: string;
    /** MESSAGE decoded to text: raw, may hold newlines and control characters. */
    readonly message: string;
    /** Every field as journalctl sent it. */
    readonly fields: Readonly<Record<string, unknown>>;
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

export function isByteArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.every(item => typeof item === "number");
}

/**
 * Text for one field value. journalctl sends a string; a byte array when the
 * value is not printable UTF-8; an array of those when the field repeats;
 * null when the value was too long to include (re-fetch with --all).
 */
export function fieldText(value: unknown): string {
    if (value === undefined)
        return "";
    if (value === null)
        return "[no data]";
    if (typeof value === "string")
        return value;
    if (isByteArray(value))
        return utf8.decode(Uint8Array.from(value));
    if (Array.isArray(value))
        return value.map(item => fieldText(item)).join("\n");
    return String(value);
}

/** One line of `journalctl --output=json`, or null if it is not an entry. */
export function parseEntry(line: string): JournalEntry | null {
    // "-- Boot ..." and "-- No entries --" appear only without -q; harmless to skip.
    if (!line || line.startsWith("-- "))
        return null;
    let fields: Record<string, unknown>;
    try {
        fields = JSON.parse(line) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (!fields || typeof fields !== "object" || typeof fields.__CURSOR !== "string")
        return null;
    const realtime = Number(fieldText(fields.__REALTIME_TIMESTAMP));
    const priority = fields.PRIORITY === undefined ? null : Number(fieldText(fields.PRIORITY));
    return {
        cursor: fields.__CURSOR,
        time: Number.isFinite(realtime) ? realtime / 1000 : 0,
        bootId: fieldText(fields._BOOT_ID),
        priority: priority !== null && Number.isInteger(priority) && priority >= 0 && priority <= 7 ? priority : null,
        identifier: fieldText(fields.SYSLOG_IDENTIFIER) || fieldText(fields._COMM),
        message: fieldText(fields.MESSAGE),
        fields,
    };
}

export interface UnitMatch {
    readonly name: string;
    /** A user unit (systemd --user), matched with the _USER_ field variants. */
    readonly user?: boolean;
    /**
     * Whose user unit. Unit names repeat across users (every user manager has
     * a dbus-broker.service), so a user unit is matched together with its
     * owner: the session's own user unless given.
     */
    readonly uid?: number;
}

export interface JournalFilter {
    /** Show this priority and above. Omitted: no --priority at all. */
    readonly priority?: Priority;
    /** A boot id, or an offset such as "0" or "-1". */
    readonly boot?: string;
    /** journalctl time specifications: "-24hours", "today", "2026-10-02 12:00", "@1700000000". */
    readonly since?: string;
    readonly until?: string;
    /** SYSLOG_IDENTIFIER, via --identifier=. */
    readonly identifier?: string;
    /** --grep pattern (needs a PCRE2 build; see capabilities()). */
    readonly grep?: string;
    readonly unit?: UnitMatch;
    /** Extra FIELD=VALUE matches, all of which must hold. */
    readonly matches?: readonly string[];
}

/** The positional match arguments for a filter, with correct AND/OR structure. */
export function matchArgs(filter: Pick<JournalFilter, "unit" | "matches">): string[] {
    const extra = [...(filter.matches ?? [])];
    if (!filter.unit)
        return extra;
    const u = filter.unit.name;
    const uid = filter.unit.user ? filter.unit.uid ?? cockpit.info?.user?.uid : undefined;
    // A coredump is logged by systemd-coredump, as root: its owner is in COREDUMP_UID.
    const owner = (field: string) => (typeof uid === "number" ? [`${field}=${uid}`] : []);
    const branches: string[][] = filter.unit.user
        ? [[`_SYSTEMD_USER_UNIT=${u}`, ...owner("_UID")], [`COREDUMP_USER_UNIT=${u}`, ...owner("COREDUMP_UID")],
           [`USER_UNIT=${u}`, ...owner("_UID")]]
        : [[`_SYSTEMD_UNIT=${u}`], [`COREDUMP_UNIT=${u}`], [`UNIT=${u}`]];
    const out: string[] = [];
    branches.forEach((branch, i) => {
        if (i > 0)
            out.push("+");
        out.push(...branch, ...extra);
    });
    return out;
}

export type JournalMode =
    /** The newest `lines` entries, newest first; with `before`, strictly older than that cursor. */
    | { readonly kind: "page", readonly lines: number, readonly before?: string }
    /** New entries as they arrive: after `after` if given, otherwise only from now on. */
    | { readonly kind: "follow", readonly after?: string }
    /** Exactly the entry at `cursor` (check the returned cursor matches). */
    | { readonly kind: "entry", readonly cursor: string, readonly all?: boolean };

/** The journalctl argv for a filter and mode. Arguments only; nothing is quoted or interpolated. */
export function journalArgs(filter: JournalFilter, mode: JournalMode): string[] {
    const argv = ["journalctl", "-q"];

    if (mode.kind === "page")
        argv.push(`--lines=${Math.max(1, Math.floor(mode.lines))}`);
    else if (mode.kind === "entry")
        argv.push("--lines=1");
    else if (mode.after)
        argv.push("--no-tail");
    else
        argv.push("--lines=0");

    argv.push("--output=json");
    if (mode.kind === "entry") {
        if (mode.all)
            argv.push("--all");
        argv.push(`--cursor=${mode.cursor}`, "--");
        return argv;
    }

    // A follow is anchored on a cursor (or on now), so boot and since do not apply to it.
    if (mode.kind === "page") {
        if (filter.boot !== undefined && filter.boot !== "")
            argv.push(`--boot=${filter.boot}`);
        if (filter.since)
            argv.push(`--since=${filter.since}`);
    }
    if (filter.until)
        argv.push(`--until=${filter.until}`);
    if (mode.kind === "page" && mode.before)
        argv.push(`--after-cursor=${mode.before}`);
    if (mode.kind === "follow" && mode.after)
        argv.push(`--after-cursor=${mode.after}`);
    if (filter.priority)
        argv.push(`--priority=${filter.priority}`);
    if (filter.identifier)
        argv.push(`--identifier=${filter.identifier}`);
    if (filter.grep)
        argv.push(`--grep=${filter.grep}`);
    argv.push(mode.kind === "page" ? "--reverse" : "--follow");
    argv.push("--", ...matchArgs(filter));
    return argv;
}

/** Spawn options for every journal read: privileged if access is on, plain otherwise. */
export const JOURNAL_SPAWN: SpawnOptions = { superuser: "try", err: "message" };

export type Outcome =
    | { readonly kind: "ok", readonly notice: string | null }
    | { readonly kind: "empty" }
    | { readonly kind: "cancelled" }
    | { readonly kind: "error", readonly message: string };

/**
 * What a finished journalctl run means. `error` is the spawn's rejection, or
 * null for exit 0; `stderr` is a successful run's stderr.
 *
 *   exit 0, no stderr      ok
 *   exit 0, stderr         ok with a notice ("... no persistent journal was found")
 *   exit 1, no stderr      empty (--grep matched nothing)
 *   exit 1, stderr         error ("Failed to parse timestamp: ...")
 */
export function classifyExit(error: unknown, stderr = "", host = "the host"): Outcome {
    if (!error) {
        const notice = stderr.trim();
        return { kind: "ok", notice: notice || null };
    }
    const e = error as { problem?: string | null, exit_status?: number | null, message?: string };
    if (e.problem === "cancelled")
        return { kind: "cancelled" };
    if (e.problem === "not-found")
        return { kind: "error", message: `journalctl is not installed on ${host}` };
    if (e.problem)
        return { kind: "error", message: e.message?.trim() || e.problem };
    const message = (e.message ?? "").trim();
    if (e.exit_status === 1 && !message)
        return { kind: "empty" };
    if (message)
        return { kind: "error", message };
    if (typeof e.exit_status === "number")
        return { kind: "error", message: `journalctl exited with code ${e.exit_status}` };
    return { kind: "error", message: "journalctl failed" };
}

export interface JournalStream {
    close(): void;
}

/**
 * Run journalctl and deliver parsed entries in batches (at most one batch per
 * `batchMs`, and a final one at the end), then the outcome. Lines that are not
 * entries are skipped. Nothing is delivered after close().
 */
export function streamJournal(
    argv: string[],
    onEntries: (entries: JournalEntry[]) => void,
    onDone?: (outcome: Outcome) => void,
    options: { batchMs?: number, host?: string, spawn?: SpawnOptions } = {},
): JournalStream {
    const batchMs = options.batchMs ?? 100;
    let pending: JournalEntry[] = [];
    let timer: NodeJS.Timeout | null = null;
    let closed = false;

    const flush = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (closed || pending.length === 0)
            return;
        const batch = pending;
        pending = [];
        // This runs from a timer: a throw here would be uncaught.
        try {
            onEntries(batch);
        } catch (error) {
            console.error("journal consumer:", error);
        }
    };

    const stream: LineStream = streamLines(argv, options.spawn ?? JOURNAL_SPAWN, lines => {
        for (const line of lines) {
            const entry = parseEntry(line);
            if (entry)
                pending.push(entry);
        }
        if (pending.length && !timer)
            timer = setTimeout(flush, batchMs);
    }, (error, stderr) => {
        flush();
        if (!closed) {
            try {
                onDone?.(classifyExit(error, stderr, options.host));
            } catch (failure) {
                console.error("journal close handler:", failure);
            }
        }
    });

    return {
        close() {
            closed = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            pending = [];
            stream.close();
        },
    };
}

export interface Capabilities {
    /** systemd version number, if it could be read. */
    readonly systemd: number | null;
    /** journalctl --grep is available (PCRE2 build, systemd 237+). */
    readonly grep: boolean;
    /** --list-boots --output=json works (systemd 251+). */
    readonly bootsJson: boolean;
    /** --output-fields works (systemd 246+). */
    readonly outputFields: boolean;
}

export function parseVersion(text: string): Capabilities {
    const match = /^systemd (\d+)/m.exec(text);
    const systemd = match ? Number(match[1]) : null;
    const pcre2 = /(^|\s)\+PCRE2(\s|$)/m.test(text);
    return {
        systemd,
        grep: pcre2 && (systemd === null || systemd >= 237),
        bootsJson: systemd !== null && systemd >= 251,
        outputFields: systemd !== null && systemd >= 246,
    };
}

/** What this host's journalctl can do. Never rejects; unknown means "no". */
export async function capabilities(signal?: AbortSignal): Promise<Capabilities> {
    try {
        const { stdout } = await runFull(["journalctl", "--version"], { err: "message" }, signal);
        return parseVersion(stdout);
    } catch {
        return { systemd: null, grep: false, bootsJson: false, outputFields: false };
    }
}

export interface Boot {
    /** 0 is the current boot; older boots are negative. */
    readonly index: number;
    readonly id: string;
    /** Milliseconds since the epoch. */
    readonly first: number;
    readonly last: number;
}

export function parseBoots(json: string): Boot[] {
    let rows: unknown;
    try {
        rows = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(rows))
        return [];
    const boots: Boot[] = [];
    for (const row of rows) {
        const r = row as { index?: unknown, boot_id?: unknown, first_entry?: unknown, last_entry?: unknown };
        if (typeof r.index !== "number" || typeof r.boot_id !== "string")
            continue;
        boots.push({
            index: r.index,
            id: r.boot_id,
            first: Number(r.first_entry) / 1000,
            last: Number(r.last_entry) / 1000,
        });
    }
    // Newest first.
    return boots.sort((a, b) => b.index - a.index);
}

/**
 * The boots in the journal, newest first. Needs systemd 251+ for JSON; older
 * hosts get just the current boot. A volatile journal has only one.
 */
export async function listBoots(caps: Capabilities, signal?: AbortSignal): Promise<Boot[]> {
    if (!caps.bootsJson)
        return [];
    try {
        const { stdout } = await runFull(["journalctl", "-q", "--list-boots", "--output=json"], JOURNAL_SPAWN, signal);
        return parseBoots(stdout);
    } catch {
        return [];
    }
}

/**
 * The distinct SYSLOG_IDENTIFIERs among entries matching the filter (minus
 * its own identifier, so the list offers the alternatives). The arguments go
 * to the shell positionally ("$@"), never interpolated.
 */
export async function listIdentifiers(filter: JournalFilter, caps: Capabilities, signal?: AbortSignal): Promise<string[]> {
    const args = journalArgs({ ...filter, identifier: undefined }, { kind: "page", lines: 1 })
        .slice(1) // drop "journalctl"
        .filter(arg => !arg.startsWith("--lines=") && arg !== "--reverse" && arg !== "--output=json");
    const separator = args.indexOf("--");
    const options = separator >= 0 ? args.slice(0, separator) : args;
    const matches = separator >= 0 ? args.slice(separator + 1) : [];

    let script: string;
    let scriptArgs: string[];
    if (caps.outputFields) {
        script = 'journalctl "$@" | sort -u';
        scriptArgs = [...options, "--no-tail", "--output=cat", "--output-fields=SYSLOG_IDENTIFIER", "--", ...matches];
    } else {
        // No pipefail: /bin/sh may be dash, which rejects it. A journalctl
        // failure still shows, as stderr (checked below).
        script = 'journalctl "$@" | sed -n "s/^    SYSLOG_IDENTIFIER=//p" | sort -u';
        scriptArgs = [...options, "--no-tail", "--output=verbose", "--", ...matches];
    }
    try {
        const { stdout, stderr } = await runFull(["/bin/sh", "-c", script, "--", ...scriptArgs], JOURNAL_SPAWN, signal);
        // Without pipefail a journalctl error still exits 0: any stderr means
        // the list is not trustworthy.
        if (stderr.trim())
            return [];
        return stdout.split("\n").map(line => line.trim()).filter(Boolean)
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    } catch {
        return [];
    }
}

/** The unit an entry belongs to, if it is one a Services page could show. */
export function entryUnit(entry: JournalEntry): UnitMatch | null {
    const f = entry.fields;
    const user = fieldText(f.USER_UNIT) || fieldText(f.COREDUMP_USER_UNIT) || fieldText(f._SYSTEMD_USER_UNIT);
    const system = fieldText(f.UNIT) || fieldText(f.COREDUMP_UNIT) || fieldText(f._SYSTEMD_UNIT);
    const name = user || system;
    if (!name || !/\.(service|target|socket|timer|path)$/.test(name))
        return null;
    return user ? { name, user: true } : { name };
}
