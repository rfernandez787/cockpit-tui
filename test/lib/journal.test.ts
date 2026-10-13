import { describe, it, expect } from "vitest";
import {
    journalArgs, matchArgs, parseEntry, fieldText, classifyExit, parseVersion, parseBoots, entryUnit,
} from "../../src/lib/journal.js";

describe("journalctl argv", () => {
    it("pages newest-first, bounded on the server", () => {
        expect(journalArgs({ priority: "err", since: "-24hours" }, { kind: "page", lines: 1000 })).toEqual([
            "journalctl", "-q", "--lines=1000", "--output=json", "--since=-24hours", "--priority=err", "--reverse", "--",
        ]);
    });

    it("loads earlier entries strictly before a cursor, past the time filter", () => {
        expect(journalArgs({ priority: "info", since: "-24hours", boot: "abc" }, { kind: "page", lines: 500, before: "s=1" }))
            .toEqual(["journalctl", "-q", "--lines=500", "--output=json", "--boot=abc", "--since=-24hours",
                      "--after-cursor=s=1", "--priority=info", "--reverse", "--"]);
    });

    it("follows after the newest shown entry, without boot or since", () => {
        expect(journalArgs({ priority: "err", since: "-24hours", boot: "0", grep: "fail" }, { kind: "follow", after: "s=9" }))
            .toEqual(["journalctl", "-q", "--no-tail", "--output=json", "--after-cursor=s=9", "--priority=err",
                      "--grep=fail", "--follow", "--"]);
    });

    it("follows only new entries when nothing was shown", () => {
        expect(journalArgs({}, { kind: "follow" })).toEqual(["journalctl", "-q", "--lines=0", "--output=json", "--follow", "--"]);
    });

    it("fetches one entry by cursor, optionally with full values", () => {
        expect(journalArgs({ priority: "err" }, { kind: "entry", cursor: "s=5", all: true }))
            .toEqual(["journalctl", "-q", "--lines=1", "--output=json", "--all", "--cursor=s=5", "--"]);
    });

    it("filters by identifier with --identifier, not a positional match", () => {
        const argv = journalArgs({ identifier: "sshd", unit: { name: "sshd.service" } }, { kind: "page", lines: 10 });
        expect(argv).toContain("--identifier=sshd");
        expect(argv.some(arg => arg.startsWith("SYSLOG_IDENTIFIER="))).toBe(false);
    });

    it("passes hostile values as single arguments, never through a shell", () => {
        const argv = journalArgs({ boot: "0;touch /tmp/pwned;", grep: "$(id)" }, { kind: "page", lines: 1 });
        expect(argv).toContain("--boot=0;touch /tmp/pwned;");
        expect(argv).toContain("--grep=$(id)");
    });
});

describe("match structure", () => {
    it("ORs the three unit fields", () => {
        expect(matchArgs({ unit: { name: "sshd.service" } }))
            .toEqual(["_SYSTEMD_UNIT=sshd.service", "+", "COREDUMP_UNIT=sshd.service", "+", "UNIT=sshd.service"]);
    });

    it("uses the user-unit fields for user units, scoped to their owner", () => {
        expect(matchArgs({ unit: { name: "podman.service", user: true, uid: 1000 } })).toEqual([
            "_SYSTEMD_USER_UNIT=podman.service", "_UID=1000", "+",
            "COREDUMP_USER_UNIT=podman.service", "COREDUMP_UID=1000", "+",
            "USER_UNIT=podman.service", "_UID=1000",
        ]);
    });

    it("distributes extra matches into every branch, so they are ANDed with the whole group", () => {
        expect(matchArgs({ unit: { name: "u" }, matches: ["_PID=1"] }))
            .toEqual(["_SYSTEMD_UNIT=u", "_PID=1", "+", "COREDUMP_UNIT=u", "_PID=1", "+", "UNIT=u", "_PID=1"]);
        expect(matchArgs({ matches: ["_PID=1", "_UID=0"] })).toEqual(["_PID=1", "_UID=0"]);
    });
});

describe("entries", () => {
    const line = JSON.stringify({
        __CURSOR: "s=ae71;i=20906", __REALTIME_TIMESTAMP: "1790983795733197", _BOOT_ID: "6941",
        PRIORITY: "6", SYSLOG_IDENTIFIER: "podman", _COMM: "podman", MESSAGE: "GET /v3.4.0/libpod",
    });

    it("parses the fields the list needs", () => {
        const entry = parseEntry(line)!;
        expect(entry.cursor).toBe("s=ae71;i=20906");
        expect(entry.time).toBeCloseTo(1790983795733.197, 3);
        expect(entry.bootId).toBe("6941");
        expect(entry.priority).toBe(6);
        expect(entry.identifier).toBe("podman");
        expect(entry.message).toBe("GET /v3.4.0/libpod");
    });

    it("decodes a byte-array MESSAGE, leaving control characters for the display layer to clean", () => {
        const bytes = [...Buffer.from("\x1b[37mDEBU\x1b[0m done\r\n", "utf8")];
        const entry = parseEntry(JSON.stringify({ __CURSOR: "c", MESSAGE: bytes, _COMM: "conmon" }))!;
        expect(entry.message).toBe("\x1b[37mDEBU\x1b[0m done\r\n");
        expect(entry.identifier).toBe("conmon");
        expect(entry.priority).toBeNull();
    });

    it("renders multi-value, null and invalid UTF-8 values", () => {
        expect(fieldText(["/dev/a", "/dev/b"])).toBe("/dev/a\n/dev/b");
        expect(fieldText(null)).toBe("[no data]");
        expect(fieldText([0xff, 0x41])).toBe("�A");
        expect(fieldText(undefined)).toBe("");
    });

    it("skips lines that are not entries", () => {
        expect(parseEntry("")).toBeNull();
        expect(parseEntry("-- Boot 123 --")).toBeNull();
        expect(parseEntry("{not json")).toBeNull();
        expect(parseEntry(JSON.stringify({ MESSAGE: "no cursor" }))).toBeNull();
    });

    it("finds the unit an entry belongs to, preferring user units", () => {
        const sys = parseEntry(JSON.stringify({ __CURSOR: "c", _SYSTEMD_UNIT: "sshd.service" }))!;
        expect(entryUnit(sys)).toEqual({ name: "sshd.service" });
        const user = parseEntry(JSON.stringify({ __CURSOR: "c", _SYSTEMD_UNIT: "user@1000.service", _SYSTEMD_USER_UNIT: "podman.service" }))!;
        expect(entryUnit(user)).toEqual({ name: "podman.service", user: true });
        const scope = parseEntry(JSON.stringify({ __CURSOR: "c", _SYSTEMD_UNIT: "session-3.scope" }))!;
        expect(entryUnit(scope)).toBeNull();
    });
});

describe("exit classification", () => {
    it("tells an empty grep from an error by stderr alone", () => {
        expect(classifyExit(null)).toEqual({ kind: "ok", notice: null });
        expect(classifyExit(null, "Specifying boot ID or boot offset has no effect, no persistent journal was found.\n"))
            .toEqual({ kind: "ok", notice: "Specifying boot ID or boot offset has no effect, no persistent journal was found." });
        expect(classifyExit({ exit_status: 1, message: "" })).toEqual({ kind: "empty" });
        expect(classifyExit({ exit_status: 1, message: "Failed to parse timestamp: garbage\n" }))
            .toEqual({ kind: "error", message: "Failed to parse timestamp: garbage" });
        expect(classifyExit({ exit_status: 2, message: "" })).toEqual({ kind: "error", message: "journalctl exited with code 2" });
        expect(classifyExit({ problem: "cancelled" })).toEqual({ kind: "cancelled" });
        expect(classifyExit({ problem: "not-found" }, "", "box"))
            .toEqual({ kind: "error", message: "journalctl is not installed on box" });
    });
});

describe("capabilities and boots", () => {
    it("reads the systemd version and features", () => {
        const caps = parseVersion("systemd 252 (252-67.el9_8.4)\n+PAM +AUDIT +PCRE2 -PWQUALITY\n");
        expect(caps).toEqual({ systemd: 252, grep: true, bootsJson: true, outputFields: true });
        expect(parseVersion("systemd 239\n+PAM -PCRE2\n")).toEqual({ systemd: 239, grep: false, bootsJson: false, outputFields: false });
    });

    it("parses --list-boots JSON, newest first", () => {
        const boots = parseBoots(JSON.stringify([
            { index: -1, boot_id: "old", first_entry: 1000000, last_entry: 2000000 },
            { index: 0, boot_id: "now", first_entry: 3000000, last_entry: 4000000 },
        ]));
        expect(boots.map(b => b.id)).toEqual(["now", "old"]);
        expect(boots[0]!.first).toBe(3000);
        expect(parseBoots("not json")).toEqual([]);
    });
});
