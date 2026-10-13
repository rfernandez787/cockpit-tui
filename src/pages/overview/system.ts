/*
 * Parsers and rules for the overview's host data. Pure functions only, so
 * every one of them is tested without a bridge; the hooks that fetch the
 * inputs live in data.ts.
 */
import { clean } from "../../tui/text.js";

// ---- scheduled shutdown ----------------------------------------------------------

/*
 * logind writes /run/systemd/shutdown/scheduled (mode 0644) whenever a
 * shutdown is scheduled and removes it when the schedule is cancelled or
 * carried out (systemd v252 logind-dbus.c update_schedule_file(),
 * reset_scheduled_shutdown()), and re-reads it on restart. Its ScheduledShutdown
 * property has no change signal, which is why upstream watches this file and
 * re-reads the property on every change; the file itself carries the same
 * facts, so it is read directly:
 *
 *   USEC=1791000000000000      realtime microseconds
 *   WARN_WALL=1
 *   MODE=reboot                poweroff, reboot, halt, kexec; older systemd
 *                              wrote "dry-reboot" etc. for `shutdown -k`
 *   UID=0
 *   TTY=pts/0                  optional
 *   WALL_MESSAGE=...           optional, C-escaped (systemd cescape())
 */
export const SCHEDULE_FILE = "/run/systemd/shutdown/scheduled";

export interface ScheduledShutdown {
    /** "reboot", "poweroff", "halt", "kexec", or whatever a newer systemd writes. */
    readonly mode: string;
    /** A `shutdown -k` style dry run: nothing will actually go down. */
    readonly dryRun: boolean;
    /** Milliseconds since the epoch, by the host's clock; null if unreadable. */
    readonly when: number | null;
    /** The wall message logged-in users get, decoded; "" if none. */
    readonly message: string;
}

/**
 * Undo systemd's cescape(): \a \b \f \n \r \t \v \\ \" \' and octal (or hex)
 * escapes for everything else, byte by byte, so multi-byte UTF-8 comes back
 * whole. Unknown escapes keep their character.
 */
export function cunescape(text: string): string {
    const bytes: number[] = [];
    const encoder = new TextEncoder();
    const simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
    // Walk by code point, so a character outside the BMP is never split.
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i]!;
        if (c !== "\\" || i + 1 >= chars.length) {
            bytes.push(...encoder.encode(c));
            continue;
        }
        const next = chars[i + 1]!;
        const ahead = chars.slice(i + 1, i + 4).join("");
        const octal = /^[0-7]{3}$/.exec(ahead);
        const hex = /^x([0-9a-fA-F]{2})$/.exec(ahead);
        if (octal) {
            bytes.push(parseInt(octal[0], 8) & 0xff);
            i += 3;
        } else if (hex) {
            bytes.push(parseInt(hex[1]!, 16));
            i += 3;
        } else if (next in simple) {
            bytes.push(simple[next]!);
            i += 1;
        } else {
            bytes.push(...encoder.encode(next));
            i += 1;
        }
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

/** Parse the schedule file; null for no file, an empty one, or one without a MODE. */
export function parseSchedule(text: string | null | undefined): ScheduledShutdown | null {
    if (!text)
        return null;
    const fields: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const eq = line.indexOf("=");
        if (eq <= 0)
            continue;
        let value = line.slice(eq + 1);
        // parse_env_file() accepts quoted values; logind writes them bare.
        if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]!))
            value = value.slice(1, -1);
        fields[line.slice(0, eq).trim()] = value;
    }
    const rawMode = fields.MODE?.trim();
    if (!rawMode)
        return null;
    const dryRun = rawMode.startsWith("dry-");
    const usec = Number(fields.USEC);
    return {
        mode: dryRun ? rawMode.slice(4) : rawMode,
        dryRun,
        when: Number.isFinite(usec) && usec > 0 ? usec / 1000 : null,
        message: fields.WALL_MESSAGE ? cunescape(fields.WALL_MESSAGE) : "",
    };
}

/**
 * "Restart", "Shutdown", ... for a schedule mode. Safe to show: a mode this
 * does not know is the host's text, and comes back clean()ed.
 */
export function scheduleNoun(mode: string): string {
    switch (mode) {
    case "reboot": return "Restart";
    case "poweroff": return "Shutdown";
    case "halt": return "Halt";
    case "kexec": return "Restart (kexec)";
    default: return `Shutdown (${clean(mode)})`;
    }
}

// ---- failed units ------------------------------------------------------------------

/*
 * Which failed units count: the system manager's units of the five types the
 * Services page lists, excluding units whose file is gone (LoadState
 * "not-found"). The same rule as upstream's services page, which is what
 * publishes the overview's "N services have failed" (services.jsx:575-601),
 * so the count matches what Enter leads to.
 */
const COUNTED_SUFFIX = /\.(service|target|socket|timer|path)$/;

export function countsAsFailed(id: string, loadState: string | undefined, activeState: string | undefined): boolean {
    return activeState === "failed" && loadState !== "not-found" && COUNTED_SUFFIX.test(id);
}

// ---- hardware (DMI) ----------------------------------------------------------------

/*
 * Upstream's machine_info.dmi_info(): `grep -r . /sys/class/dmi/id || true`
 * through cockpit.script(), i.e. /bin/sh -c with "--" appended. With
 * superuser "try" it runs as root once administrative access is on; without
 * it the serial numbers are unreadable (0400 root) and grep says so on
 * stderr, which is how "requires administrative access" is told apart from
 * "the firmware has no serial number".
 */
export const DMI_ARGV = ["/bin/sh", "-c", "grep -r . /sys/class/dmi/id || true", "--"] as const;

/**
 * The C locale for that spawn: the "Permission denied" parseDmi() looks for
 * is grep's message, which a bridge running in another locale (a local one
 * inherits ours; ssh forwards LANG and LC_*) would print translated.
 */
export const DMI_ENVIRON = ["LC_ALL=C"] as const;

/** Values firmware ships when nobody filled the field in. */
const DMI_PLACEHOLDER = /^(to be filled by o\.?e\.?m\.?|default string|not specified|not applicable|system manufacturer|system product name|system serial number|0123456789|none|n\/a)$/i;

export interface HardwareInfo {
    readonly vendor: string;
    readonly model: string;
    /** product_serial, else chassis_serial (upstream's "Asset tag"). */
    readonly assetTag: string;
    /** No asset tag because the serial files were unreadable, not because they are empty. */
    readonly assetTagDenied: boolean;
}

export function parseDmi(stdout: string, stderr: string): HardwareInfo {
    const fields: Record<string, string> = {};
    for (const line of stdout.split("\n")) {
        const sep = line.indexOf(":");
        if (sep < 0)
            continue;
        const path = line.slice(0, sep);
        const key = path.slice(path.lastIndexOf("/") + 1);
        // Only the files directly in the directory; grep also descends into
        // power/ and friends.
        if (path !== `/sys/class/dmi/id/${key}`)
            continue;
        const value = line.slice(sep + 1).trim();
        fields[key] = DMI_PLACEHOLDER.test(value) ? "" : value;
    }
    const byProduct = Boolean(fields.product_name);
    const assetTag = fields.product_serial || fields.chassis_serial || "";
    return {
        vendor: (byProduct ? fields.sys_vendor : fields.board_vendor) ?? "",
        model: (byProduct ? fields.product_name : fields.board_name) ?? "",
        assetTag,
        assetTagDenied: !assetTag && /\/(product_serial|chassis_serial): Permission denied/.test(stderr),
    };
}

/** A NUL-terminated device-tree string (/proc/device-tree/model). */
export function deviceTreeString(bytes: Uint8Array | null | undefined): string {
    if (!bytes)
        return "";
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0)
        end--;
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, end)).replace(/\0/g, " ").trim();
}

// ---- kernel, uptime ----------------------------------------------------------------

export const UNAME_ARGV = ["uname", "-r", "-m"] as const;

/** `uname -r -m` prints "<release> <machine>" whatever the option order. */
export function parseUname(text: string): { release: string, arch: string } | null {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2 || !parts[0])
        return null;
    return { release: parts[0], arch: parts[parts.length - 1]! };
}

/** Seconds since boot from /proc/uptime ("1061506.61 16887714.04"). */
export function parseUptime(text: string | null | undefined): number | null {
    const value = parseFloat((text ?? "").trim().split(/\s+/)[0] ?? "");
    return Number.isFinite(value) && value >= 0 ? value : null;
}

// ---- the host's clock ----------------------------------------------------------------

/*
 * `date '+%s %z %Z'`: the host's clock, its current UTC offset and zone
 * abbreviation in one spawn. Upstream's ServerTime runs `date +%s:%z` for
 * the same reason: the host's clock may differ from ours, and so may its
 * zone. %z is parsed with its sign kept apart, so "-0030" is -30 minutes
 * (upstream's parseInt("-00") would lose the sign).
 *
 * Run as `env -u TZ date`, a deviation from upstream: the question is the
 * HOST's zone (/etc/localtime, what timedated sets), and a TZ in the
 * bridge's environment would answer for another one. A local bridge
 * inherits our environment, TZ included, and over ssh a TZ set in the
 * user's shell startup files reaches it as well; cockpit-ws starts its
 * bridge without one, which is what upstream relies on.
 */
const HOST_ZONE_DATE = ["env", "-u", "TZ", "date"] as const;

export const DATE_ARGV = [...HOST_ZONE_DATE, "+%s %z %Z"] as const;

/**
 * The epoch seconds of a manual time typed into the time dialog, parsed by
 * the host's own `date` in the host's zone (see DATE_ARGV for the TZ).
 * `manual` is parseManualTime()'s normalised "YYYY-MM-DD HH:MM:SS".
 */
export function manualTimeArgv(manual: string): string[] {
    return [...HOST_ZONE_DATE, `--date=${manual}`, "+%s"];
}

export interface HostClock {
    /** Seconds since the epoch when `date` ran. */
    readonly epoch: number;
    /** Minutes east of UTC. */
    readonly offset: number;
    /** "MDT", "CEST", "UTC", or a numeric one like "+0530" from some zones. */
    readonly abbreviation: string;
}

export function parseDate(text: string): HostClock | null {
    const match = /^\s*(-?\d+)\s+([+-])(\d\d)(\d\d)\s*(\S*)/.exec(text);
    if (!match)
        return null;
    const sign = match[2] === "-" ? -1 : 1;
    return {
        epoch: Number(match[1]),
        offset: sign * (Number(match[3]) * 60 + Number(match[4])),
        abbreviation: match[5] ?? "",
    };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD HH:MM" of an instant, in a zone `offset` minutes east of UTC. */
export function formatInOffset(ms: number, offset: number): string {
    const date = new Date(ms + offset * 60000);
    if (Number.isNaN(date.getTime()))
        return "";
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
        `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

/**
 * "YYYY-MM-DD HH:MM" of an instant in a named zone, from our own tz data
 * (Node's ICU), or null when we do not know the zone. Only for suggesting a
 * value to edit: the host parses what is typed with its own tz data.
 */
export function formatInZone(ms: number, zone: string): string | null {
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", hourCycle: "h23",
        }).formatToParts(new Date(ms));
        const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
        const text = `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
        return /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(text) ? text : null;
    } catch {
        return null; // RangeError: a zone ICU does not have
    }
}

/** "UTC", "UTC+02:00", "UTC-06:00", "UTC+05:30". */
export function formatUtcOffset(offset: number): string {
    if (offset === 0)
        return "UTC";
    const sign = offset < 0 ? "-" : "+";
    const abs = Math.abs(offset);
    return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Our own UTC offset at an instant, in minutes east. */
export function localOffset(ms: number): number {
    return -new Date(ms).getTimezoneOffset();
}

/** Our own zone's short name at an instant ("CEST", or "GMT+2" where ICU has none). */
export function localZoneName(ms: number): string {
    try {
        const part = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
            .formatToParts(new Date(ms)).find(p => p.type === "timeZoneName");
        return part?.value ?? "";
    } catch {
        return "";
    }
}

/**
 * Parse what someone typed as a new system time: "YYYY-MM-DD HH:MM" with
 * optional ":SS" (a "T" separator is fine too). Returns the normalised text
 * for `date --date=`, or an error. The host interprets it in its own zone.
 */
export function parseManualTime(text: string): { value: string } | { error: string } {
    const match = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(text);
    if (!match)
        return { error: "Use the form YYYY-MM-DD HH:MM" };
    const [year, month, day, hour, minute, second] = match.slice(1).map(v => Number(v ?? 0)) as
        [number, number, number, number, number, number];
    const check = new Date(Date.UTC(year, month - 1, day));
    if (month < 1 || month > 12 || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day)
        return { error: "No such date" };
    if (hour > 23 || minute > 59 || second > 59)
        return { error: "No such time of day" };
    if (year < 1970)
        return { error: "The time cannot be before 1970" };
    return { value: `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}` };
}

/**
 * Time zones matching what was typed: case-insensitive, spaces as "_" (so
 * "new york" finds America/New_York). An exact name first, then zones whose
 * city (or any path component) starts with the text, then the rest; each
 * group keeps timedated's alphabetical order.
 */
export function filterZones(zones: readonly string[], query: string): string[] {
    const q = query.trim().toLowerCase().replace(/\s+/g, "_");
    if (!q)
        return [...zones];
    const exact: string[] = [];
    const prefix: string[] = [];
    const rest: string[] = [];
    for (const zone of zones) {
        const lower = zone.toLowerCase();
        if (lower === q)
            exact.push(zone);
        else if (lower.split("/").some(part => part.startsWith(q)) || lower.startsWith(q))
            prefix.push(zone);
        else if (lower.includes(q))
            rest.push(zone);
    }
    return [...exact, ...prefix, ...rest];
}

// ---- host names --------------------------------------------------------------------

/**
 * What the header and the configuration row call the host, upstream's
 * hostname_text(): "Pretty (static)" when both exist and differ, else the
 * static name, else the transient one.
 */
export function hostnameText(pretty: string, staticName: string, transient: string): string {
    if (pretty && staticName && pretty !== staticName)
        return `${pretty} (${staticName})`;
    return staticName || transient || pretty || "";
}

/**
 * The static host name a pretty name suggests, while the user has not typed
 * one themselves (configurationCard.jsx:221-239): lower case, quotes and dots
 * dropped, every other run of non-alphanumerics a hyphen, at most 64
 * characters, and the old name's domain kept. Leading and trailing hyphens
 * are trimmed as well, which upstream does not do: systemd rejects them.
 */
export function deriveHostname(pretty: string, oldStatic: string): string {
    const dot = oldStatic.indexOf(".");
    const domain = dot >= 0 ? oldStatic.slice(dot) : "";
    const label = pretty
        .toLowerCase()
        .replace(/['".]+/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 64)
        .replace(/^-+|-+$/g, "");
    return label + domain;
}

/**
 * Why a static host name would be refused, or null. Upstream's rule (lower
 * case letters, digits, hyphens and dots; at most 64 characters) plus
 * systemd's hostname_is_valid() structure, so the error appears while typing
 * rather than as "Invalid static hostname" from hostnamed afterwards.
 */
export function hostnameError(name: string): string | null {
    if (name === "")
        return "Enter a host name";
    if (name.length > 64)
        return "A host name can have at most 64 characters";
    if (!/^[a-z0-9.-]+$/.test(name))
        return "Use only lower-case letters, digits, hyphens and dots";
    if (name.startsWith(".") || name.endsWith(".") || name.includes(".."))
        return "Dots must separate non-empty parts";
    if (name.split(".").some(label => label.startsWith("-") || label.endsWith("-")))
        return "Parts cannot start or end with a hyphen";
    return null;
}

/** Why a pretty host name would be refused, or null. */
export function prettyHostnameError(name: string): string | null {
    // hostnamed refuses control characters (string_is_safe()); the text
    // field never produces them, but a value read back from the host could.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(name))
        return "Control characters are not allowed";
    if (new TextEncoder().encode(name).length > 255)
        return "A pretty name can have at most 255 bytes";
    return null;
}

// ---- message of the day --------------------------------------------------------------

/** Expand tabs to 8-column stops, so ASCII art in /etc/motd stays aligned. */
export function expandTabs(line: string): string {
    if (!line.includes("\t"))
        return line;
    let out = "";
    for (const char of line) {
        if (char === "\t")
            out += " ".repeat(8 - (out.length % 8));
        else
            out += char;
    }
    return out;
}

/** The motd's lines with blank lines trimmed from both ends; [] when there is nothing to show. */
export function motdLines(text: string | null | undefined): string[] {
    if (!text)
        return [];
    const lines = text.replace(/\r\n/g, "\n").split("\n").map(line => expandTabs(line).trimEnd());
    while (lines.length && !lines[0]!.trim())
        lines.shift();
    while (lines.length && !lines[lines.length - 1]!.trim())
        lines.pop();
    return lines;
}
