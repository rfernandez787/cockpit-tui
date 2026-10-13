/*
 * The overview's pure logic: formatting, the metrics decompressor and usage
 * model, and the parsers for what the host reports. Fixtures are the values
 * captured from a real RHEL 9.8 host in specs/overview.md and
 * specs/metrics.md, plus synthesized edge cases.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { powerArgv, type PowerAction } from "../../src/pages/overview/dialogs.js";
import {
    formatBytes, formatBytesPair, formatIn, formatRate, formatUptime, significant,
} from "../../src/pages/overview/format.js";
import {
    Decompressor, USAGE_METRICS, parseMachineInfo, parseNameList, usageModel, networkInstances,
    type Meta, type Sample,
} from "../../src/pages/overview/metrics.js";
import {
    countsAsFailed, cunescape, deriveHostname, deviceTreeString, expandTabs, filterZones, formatInOffset, formatInZone,
    formatUtcOffset, hostnameError, hostnameText, motdLines, parseDate, parseDmi, parseManualTime,
    parseSchedule, parseUname, parseUptime, prettyHostnameError, scheduleNoun,
} from "../../src/pages/overview/system.js";

describe("formatting", () => {
    it("uses three significant digits without exponents", () => {
        expect(significant(14.78)).toBe("14.8");
        expect(significant(1.2149)).toBe("1.21");
        expect(significant(183.2)).toBe("183");
        expect(significant(999.6)).toBe("1000");
        expect(significant(4)).toBe("4");
        expect(significant(Number.NaN)).toBe("?");
    });

    it("formats sizes in binary units", () => {
        expect(formatBytes(8126464)).toBe("7.75 MiB");
        expect(formatBytes(4194300 * 1024)).toBe("4.00 GiB");
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(0)).toBe("0 B");
    });

    it("labels memory in the total's unit", () => {
        // specs/metrics.md §5.1: 15866777600 of 61336584 kB.
        expect(formatBytesPair(15866777600, 61336584 * 1024)).toBe("14.8 / 58.5 GiB");
        expect(formatBytesPair(400 * 2 ** 20, 61336584 * 1024)).toBe("0.4 / 58.5 GiB");
        expect(formatBytesPair(1.5 * 2 ** 30, 3.84 * 2 ** 30)).toBe("1.50 / 3.84 GiB");
        expect(formatBytesPair(98 * 2 ** 30, 125 * 2 ** 30)).toBe("98 / 125 GiB");
        expect(formatBytesPair(1, 0)).toBe("?");
    });

    it("formats rates in decimal units and hides sub-byte and negative ones", () => {
        expect(formatRate(89997.8)).toBe("90.0 kB/s");
        expect(formatRate(33861.7)).toBe("33.9 kB/s");
        expect(formatRate(182799)).toBe("183 kB/s");
        expect(formatRate(1_210_000)).toBe("1.21 MB/s");
        expect(formatRate(0.4)).toBe("0 B/s");
        expect(formatRate(-5000)).toBe("0 B/s");
    });

    it("prints uptime like uptime(1)", () => {
        expect(formatUptime(30)).toBe("0 min");
        expect(formatUptime(41 * 60 + 5)).toBe("41 min");
        expect(formatUptime(3 * 3600 + 41 * 60)).toBe("3:41");
        expect(formatUptime(86400 + 5 * 60)).toBe("1 day, 0:05");
        expect(formatUptime(1061506.61)).toBe("12 days, 6:51");
    });

    it("counts down to a scheduled time", () => {
        expect(formatIn(-1)).toBe("now");
        expect(formatIn(30_000)).toBe("in 1 min");
        expect(formatIn(4 * 60_000)).toBe("in 4 min");
        expect(formatIn(65 * 60_000)).toBe("in 1 h 5 min");
        expect(formatIn(120 * 60_000)).toBe("in 2 h");
        expect(formatIn((51 * 60) * 60_000)).toBe("in 2 days 3 h");
    });
});

/** The meta the real bridge sends for USAGE_METRICS (instanced ones carry instances, no derive). */
function meta(instances: string[] = ["lo", "enp42s0", "virbr0", "vnet0"]): Meta {
    return {
        metrics: USAGE_METRICS.map(m => m.name.startsWith("network.")
            ? { name: m.name, units: "bytes", instances, semantics: "counter" }
            : { name: m.name, derive: m.derive ?? null, units: "bytes", semantics: "counter" }),
    };
}

describe("the metrics decompressor", () => {
    it("decodes complete (Python bridge) rows and keeps false as a value", () => {
        const d = new Decompressor();
        expect(d.push(meta())).toEqual([]);
        const [first] = d.push([[false, false, false, 15877967872, 8126464, false, false,
            [false, false, false, false], [false, false, false, false]]]);
        expect(first![0]).toBe(false);
        expect(first![3]).toBe(15877967872);
        expect(first![7]).toEqual([false, false, false, false]);
    });

    it("ignores data before the first meta", () => {
        const d = new Decompressor();
        expect(d.push([[1, 2, 3]])).toEqual([]);
    });

    it("fills C-bridge nulls and dropped trailing values from the previous row, by index", () => {
        const d = new Decompressor();
        d.push(meta(["lo", "eth0"]));
        d.push([[10, 20, 0, 1000, 5, 7, 8, [1, 2], [3, 4]]]);
        // Unchanged: user (null), everything after memory.used dropped, and
        // the instanced arrays short or empty.
        const [row] = d.push([[null, 25, null, 2000, null, null, null, [9], []]]);
        expect(row).toEqual([10, 25, 0, 2000, 5, 7, 8, [9, 2], [3, 4]]);
        const [short] = d.push([[11]]);
        expect(short).toEqual([11, 25, 0, 2000, 5, 7, 8, [9, 2], [3, 4]]);
    });

    it("never fills a false from the previous row", () => {
        const d = new Decompressor();
        d.push(meta(["lo"]));
        d.push([[1, 1, 1, 1, 1, 1, 1, [1], [1]]]);
        const [row] = d.push([[false, null, null, null, null, null, null, [false], null]]);
        expect(row![0]).toBe(false);
        expect(row![1]).toBe(1);
        expect(row![7]).toEqual([false]);
        expect(row![8]).toEqual([1]);
    });

    it("truncates instanced values to the new meta's instance list (no stale leak)", () => {
        // The vendored decompressor turns [7, 8] after [a, b, c] -> [a, b]
        // into [7, 8, 3]; the removed instance's value must not survive.
        const d = new Decompressor();
        d.push(meta(["a", "b", "c"]));
        d.push([[0, 0, 0, 0, 0, 0, 0, [1, 2, 3], [1, 2, 3]]]);
        d.push(meta(["a", "b"]));
        const [row] = d.push([[0, 0, 0, 0, 0, 0, 0, [7, 8], [7, 8]]]);
        expect(row![7]).toEqual([7, 8]);
    });

    it("pads instanced values when the meta grows, keeping compression across it", () => {
        const d = new Decompressor();
        d.push(meta(["a"]));
        d.push([[5, 5, 5, 5, 5, 5, 5, [1], [2]]]);
        d.push(meta(["a", "b"]));
        const [row] = d.push([[null, null, null, null, null, null, null, [null, false], [null, false]]]);
        expect(row).toEqual([5, 5, 5, 5, 5, 5, 5, [1, false], [2, false]]);
    });

    it("decodes every row of a message with several samples", () => {
        const d = new Decompressor();
        d.push(meta(["lo"]));
        const rows = d.push([[1, 1, 1, 1, 1, 1, 1, [1], [1]], [null, 2, null, null, null, null, null, [], []]]);
        expect(rows).toHaveLength(2);
        expect(rows[1]![1]).toBe(2);
        expect(rows[1]![0]).toBe(1);
    });

    it("treats junk values as missing rather than as numbers", () => {
        const d = new Decompressor();
        d.push(meta(["lo"]));
        const [row] = d.push([["1", true, Number.NaN, {}, 1, 1, 1, ["x"], [1]]]);
        expect(row!.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined]);
        expect(row![7]).toEqual([undefined]);
    });
});

const MEMINFO = "MemTotal:       61336584 kB\nMemFree:         1768148 kB\nMemAvailable:   45842120 kB\n" +
    "SwapTotal:       4194300 kB\nSwapFree:        4186364 kB\n";
const CPUINFO = Array.from({ length: 16 }, (_, i) =>
    `processor\t: ${i}\nvendor_id\t: AuthenticAMD\nmodel name\t: AMD Ryzen 7 5700G with Radeon Graphics\n`).join("\n");

describe("machine info", () => {
    it("parses totals and the CPU count", () => {
        expect(parseMachineInfo(MEMINFO + CPUINFO)).toEqual({
            memTotal: 61336584 * 1024, swapTotal: 4194300 * 1024, cpus: 16,
        });
    });

    it("counts s390x 'cpu number' lines and copes with no swap line", () => {
        const info = parseMachineInfo("MemTotal: 1024 kB\ncpu number      : 0\ncpu number      : 1\n");
        expect(info).toEqual({ memTotal: 1024 * 1024, swapTotal: null, cpus: 2 });
    });

    it("reads an interface list", () => {
        expect([...parseNameList("lo\nvirbr0\nvnet0\n\n")]).toEqual(["lo", "virbr0", "vnet0"]);
    });
});

describe("the usage model", () => {
    const info = parseMachineInfo(MEMINFO + CPUINFO);
    const virtual = new Set(["lo", "virbr0", "vnet0"]);
    // specs/metrics.md §5.1 and §5.2.
    const sample: Sample = [123.16201331464083, 59.91665512604148, 0.0, 15866777600, 8126464,
        89997.8264840313, 0.0,
        [479.4151193700274, 33861.68915000425, 231.71730769551326, 259.6831896587649],
        [479.4151193700274, 182798.9874527941, 275.6636936377658, 275.6636936377658]];

    it("computes CPU, memory, swap, disk and physical network traffic", () => {
        const model = usageModel(sample, meta(), info, virtual);
        expect(Math.round(model.cpuPercent!)).toBe(1);
        expect(model.cpus).toBe(16);
        expect(model.memUsed).toBe(15866777600);
        expect(model.memTotal).toBe(61336584 * 1024);
        expect(model.swap).toEqual({ used: 8126464, total: 4194300 * 1024 });
        expect(model.diskRead).toBeCloseTo(89997.83, 1);
        expect(model.diskWrite).toBe(0);
        expect(model.netRx).toBeCloseTo(33861.69, 1);
        expect(model.netTx).toBeCloseTo(182798.99, 1);
    });

    it("shows no CPU figure until the CPU count and real rates are known", () => {
        expect(usageModel(sample, meta(), null, virtual).cpuPercent).toBeNull();
        expect(usageModel(sample, meta(), { ...info, cpus: 0 }, virtual).cpuPercent).toBeNull();
        const first: Sample = [false, false, false, 15877967872, 8126464, false, false,
            [false, false, false, false], [false, false, false, false]];
        const model = usageModel(first, meta(), info, virtual);
        expect(model.cpuPercent).toBeNull();
        expect(model.memUsed).toBe(15877967872);
        expect(model.diskRead).toBeNull();
        expect(model.netRx).toBeNull();
    });

    it("clamps CPU at 100% and negative rates at zero", () => {
        const busy: Sample = [16000, 1000, 0, 1, 0, -5, -1, [0, -100, 0, 0], [0, 50, 0, 0]];
        const model = usageModel(busy, meta(), info, virtual);
        expect(model.cpuPercent).toBe(100);
        expect(model.diskRead).toBe(0);
        expect(model.netRx).toBe(0);
        expect(model.netTx).toBe(50);
    });

    it("waits for the interface classification, and skips a new interface's false", () => {
        expect(usageModel(sample, meta(), info, null).netRx).toBeNull();
        const fresh: Sample = [...sample.slice(0, 7), [1, 100, 1, 1, false], [1, 200, 1, 1, false]];
        const model = usageModel(fresh, meta(["lo", "enp42s0", "virbr0", "vnet0", "wlan0"]), info, virtual);
        expect(model.netRx).toBe(100);
        expect(model.netTx).toBe(200);
    });

    it("hides swap on a host without it", () => {
        expect(usageModel(sample, meta(), { ...info, swapTotal: 0 }, virtual).swap).toBeNull();
        expect(usageModel(null, null, { ...info, swapTotal: 0 }, virtual).swap).toBeNull();
        expect(usageModel(null, null, info, virtual).swap).toEqual({ used: null, total: 4194300 * 1024 });
    });

    it("lists the network instances of a meta", () => {
        expect(networkInstances(meta(["lo", "eth0"]))).toEqual(["lo", "eth0"]);
        expect(networkInstances(null)).toEqual([]);
    });
});

describe("the shutdown schedule file", () => {
    it("parses what logind writes", () => {
        const schedule = parseSchedule("USEC=1791000000000000\nWARN_WALL=1\nMODE=reboot\nUID=0\nTTY=pts/0\n" +
            "WALL_MESSAGE=Kernel update\\nback soon\n");
        expect(schedule).toEqual({ mode: "reboot", dryRun: false, when: 1791000000000, message: "Kernel update\nback soon" });
    });

    it("recognises older systemd's dry-run modes and quoted values", () => {
        expect(parseSchedule('USEC="1791000000000000"\nMODE=dry-poweroff\n')).toMatchObject({
            mode: "poweroff", dryRun: true, when: 1791000000000,
        });
    });

    it("is null for no file, an empty file or one without a mode", () => {
        expect(parseSchedule(null)).toBeNull();
        expect(parseSchedule("")).toBeNull();
        expect(parseSchedule("USEC=1\n")).toBeNull();
        expect(parseSchedule("MODE=halt\nUSEC=garbage\n")).toMatchObject({ mode: "halt", when: null });
    });

    it("decodes systemd's C escapes byte by byte", () => {
        expect(cunescape("Gr\\303\\274\\303\\237e")).toBe("Grüße");
        expect(cunescape("tab\\there \\\"quoted\\\" back\\\\slash \\x41")).toBe("tab\there \"quoted\" back\\slash A");
        expect(cunescape("plain 🙂 text")).toBe("plain 🙂 text");
        expect(cunescape("trailing\\")).toBe("trailing\\");
    });

    it("names the modes", () => {
        expect(scheduleNoun("reboot")).toBe("Restart");
        expect(scheduleNoun("poweroff")).toBe("Shutdown");
        expect(scheduleNoun("halt")).toBe("Halt");
        expect(scheduleNoun("soft-reboot")).toBe("Shutdown (soft-reboot)");
    });

    it("cleans a mode it does not know, which is the host's text", () => {
        // logind's file is root's, but a hostile or broken host can say anything.
        expect(scheduleNoun("evil\x1b]8;;http://x/\x07LINK\u009b2J\rCR")).toBe("Shutdown (evil^[]8;;http://x/^GLINK\\x9b2JCR)");
    });
});

/*
 * systemd 252's shutdown_parse_argv(): getopt_long() with this optstring and
 * these long options, which PERMUTES -- options are found anywhere, also
 * after the time. util-linux getopt(1) is the same parser, so it shows how
 * shutdown will read our command without running it.
 */
const getoptVersion = spawnSync("getopt", ["-V"], { encoding: "utf8" });
const haveGetopt = getoptVersion.status === 0 && /util-linux/.test(getoptVersion.stdout ?? "");

function shutdownParse(argv: string[]): { options: string[], operands: string[] } {
    const out = spawnSync("getopt", ["-o", "HPrhkKat:fFc", "-l", "help,halt,poweroff,reboot,kexec,no-wall,show",
                                     "-n", "shutdown", "--", ...argv.slice(1)], { encoding: "utf8" });
    expect(out.status).toBe(0);
    // " --reboot -- '+1' '-h'": options, then the operands, shell-quoted.
    const text = out.stdout.trim();
    const split = text.startsWith("-- ") ? 0 : text.indexOf(" -- ");
    const options = text.slice(0, Math.max(0, split)).trim().split(/\s+/).filter(Boolean);
    const rest = text.slice(split < 0 ? text.length : split + (text.startsWith("-- ") ? 3 : 4));
    const operands = (rest.match(/'(?:[^']|'\\'')*'/g) ?? []).map(q => q.slice(1, -1).replace(/'\\''/g, "'"));
    return { options, operands };
}

describe.skipIf(!haveGetopt)("the restart and shut-down command, as shutdown parses it", () => {
    it("never lets the message be taken for an option", () => {
        const messages = ["", "bye now", "-h", "-P", "-H", "-r", "-c", "-k", "--help", "--show", "--poweroff",
                          "-t 5", "it's -h time"];
        for (const action of ["restart", "shutdown"] as PowerAction[]) {
            for (const minutes of [0, 5]) {
                for (const message of messages) {
                    const parsed = shutdownParse(powerArgv(action, minutes, message));
                    expect(parsed, `${action} +${minutes} ${JSON.stringify(message)}`).toEqual({
                        options: [action === "restart" ? "--reboot" : "--poweroff"],
                        operands: [`+${minutes}`, message],
                    });
                }
            }
        }
    });
});

describe("failed units", () => {
    it("counts failed units of the five listed types that still have a unit file", () => {
        expect(countsAsFailed("foo.service", "loaded", "failed")).toBe(true);
        expect(countsAsFailed("bar.timer", "loaded", "failed")).toBe(true);
        expect(countsAsFailed("dev-sdb.mount", "loaded", "failed")).toBe(false);
        expect(countsAsFailed("gone.service", "not-found", "failed")).toBe(false);
        expect(countsAsFailed("ok.service", "loaded", "active")).toBe(false);
    });
});

describe("hardware", () => {
    const UNPRIVILEGED_OUT = [
        "/sys/class/dmi/id/sys_vendor:Micro-Star International Co., Ltd.",
        "/sys/class/dmi/id/product_name:MS-7C95",
        "/sys/class/dmi/id/board_name:B550M PRO-VDH WIFI (MS-7C95)",
        "/sys/class/dmi/id/chassis_asset_tag:To be filled by O.E.M.",
        "/sys/class/dmi/id/power/control:auto",
        "/sys/class/dmi/id/modalias:dmi:bvnAmerican:bvr2.D0:",
    ].join("\n") + "\n";
    const DENIED = "grep: /sys/class/dmi/id/board_serial: Permission denied\n" +
        "grep: /sys/class/dmi/id/product_serial: Permission denied\n" +
        "grep: /sys/class/dmi/id/chassis_serial: Permission denied\n";

    it("reads vendor and model, and knows when the serial was unreadable", () => {
        expect(parseDmi(UNPRIVILEGED_OUT, DENIED)).toEqual({
            vendor: "Micro-Star International Co., Ltd.", model: "MS-7C95", assetTag: "", assetTagDenied: true,
        });
    });

    it("reports the serial as the asset tag when readable, and blanks placeholders", () => {
        const root = UNPRIVILEGED_OUT + "/sys/class/dmi/id/product_serial:To be filled by O.E.M.\n" +
            "/sys/class/dmi/id/chassis_serial:XYZ123\n";
        expect(parseDmi(root, "")).toMatchObject({ assetTag: "XYZ123", assetTagDenied: false });
        expect(parseDmi(UNPRIVILEGED_OUT.replace("/sys/class/dmi/id/power/control:auto\n", ""), "")).toMatchObject({
            assetTag: "", assetTagDenied: false,
        });
    });

    it("falls back to the board when there is no product name", () => {
        const board = "/sys/class/dmi/id/board_vendor:ASUSTeK\n/sys/class/dmi/id/board_name:PRIME X570\n" +
            "/sys/class/dmi/id/product_name:System Product Name\n/sys/class/dmi/id/sys_vendor:System manufacturer\n";
        expect(parseDmi(board, "")).toMatchObject({ vendor: "ASUSTeK", model: "PRIME X570" });
        expect(parseDmi("", "")).toEqual({ vendor: "", model: "", assetTag: "", assetTagDenied: false });
    });

    it("reads a NUL-terminated device-tree string", () => {
        expect(deviceTreeString(new TextEncoder().encode("Raspberry Pi 4 Model B Rev 1.4\0"))).toBe("Raspberry Pi 4 Model B Rev 1.4");
        expect(deviceTreeString(null)).toBe("");
    });

    it("parses uname and /proc/uptime", () => {
        expect(parseUname("5.14.0-687.49.1.el9_8.x86_64 x86_64\n")).toEqual({
            release: "5.14.0-687.49.1.el9_8.x86_64", arch: "x86_64",
        });
        expect(parseUname("")).toBeNull();
        expect(parseUptime("1061506.61 16887714.04\n")).toBe(1061506.61);
        expect(parseUptime("garbage")).toBeNull();
    });
});

describe("the host's clock", () => {
    it("parses date's epoch, offset and zone", () => {
        expect(parseDate("1790984112 -0600 MDT\n")).toEqual({ epoch: 1790984112, offset: -360, abbreviation: "MDT" });
        expect(parseDate("1790984112 +0530 IST\n")).toEqual({ epoch: 1790984112, offset: 330, abbreviation: "IST" });
        // upstream's parseInt("-00") loses this sign
        expect(parseDate("1790984112 -0030 -0030\n")).toMatchObject({ offset: -30 });
        expect(parseDate("nonsense")).toBeNull();
    });

    it("formats an instant in the host's offset", () => {
        expect(formatInOffset(1790984112000, -360)).toBe("2026-10-02 17:35");
        expect(formatInOffset(1790984112000, 0)).toBe("2026-10-02 23:35");
        expect(formatUtcOffset(-360)).toBe("UTC-06:00");
        expect(formatUtcOffset(330)).toBe("UTC+05:30");
        expect(formatUtcOffset(0)).toBe("UTC");
    });

    it("formats an instant in a named zone, or says it cannot", () => {
        expect(formatInZone(1790984112000, "Europe/Berlin")).toBe("2026-10-03 01:35");
        expect(formatInZone(1790984112000, "America/Denver")).toBe("2026-10-02 17:35");
        expect(formatInZone(1790984112000, "Asia/Kolkata")).toBe("2026-10-03 05:05");
        expect(formatInZone(1790984112000, "UTC")).toBe("2026-10-02 23:35");
        expect(formatInZone(1790984112000, "Mars/Olympus")).toBeNull();
        expect(formatInZone(1790984112000, "")).toBeNull();
    });

    it("validates a typed date and time", () => {
        expect(parseManualTime("2026-10-02 18:41")).toEqual({ value: "2026-10-02 18:41:00" });
        expect(parseManualTime(" 2026-1-2T3:04:05 ")).toEqual({ value: "2026-01-02 03:04:05" });
        expect(parseManualTime("2026-02-30 10:00")).toEqual({ error: "No such date" });
        expect(parseManualTime("2026-10-02 24:00")).toEqual({ error: "No such time of day" });
        expect(parseManualTime("1969-12-31 23:59")).toEqual({ error: "The time cannot be before 1970" });
        expect(parseManualTime("tomorrow")).toHaveProperty("error");
    });

    it("finds time zones by name or city", () => {
        const zones = ["America/Denver", "America/New_York", "Asia/Kolkata", "Etc/UTC", "Europe/Berlin", "UTC"];
        expect(filterZones(zones, "utc")).toEqual(["UTC", "Etc/UTC"]);
        expect(filterZones(zones, "new york")).toEqual(["America/New_York"]);
        expect(filterZones(zones, "ber")).toEqual(["Europe/Berlin"]);
        expect(filterZones(zones, "America")).toEqual(["America/Denver", "America/New_York"]);
        expect(filterZones(zones, "kat")).toEqual(["Asia/Kolkata"]);
        expect(filterZones(zones, "")).toEqual(zones);
    });
});

describe("host names", () => {
    it("shows the pretty and static names like upstream", () => {
        expect(hostnameText("Server Box", "server-box", "server-box")).toBe("Server Box (server-box)");
        expect(hostnameText("server-box", "server-box", "x")).toBe("server-box");
        expect(hostnameText("", "server-box", "x")).toBe("server-box");
        expect(hostnameText("", "", "transient")).toBe("transient");
    });

    it("derives a static name from a pretty one, keeping the domain", () => {
        expect(deriveHostname("Server Box", "old")).toBe("server-box");
        expect(deriveHostname("Bob's \"Lab\" 2.0!", "old.example.com")).toBe("bobs-lab-20.example.com");
        expect(deriveHostname("  Ünïcode — box  ", "")).toBe("n-code-box");
        expect(deriveHostname("x".repeat(80), "")).toHaveLength(64);
    });

    it("validates static names the way systemd will", () => {
        expect(hostnameError("server-box")).toBeNull();
        expect(hostnameError("web1.example.com")).toBeNull();
        expect(hostnameError("")).toBe("Enter a host name");
        expect(hostnameError("Server")).toMatch(/lower-case/);
        expect(hostnameError("a..b")).toMatch(/Dots/);
        expect(hostnameError(".a")).toMatch(/Dots/);
        expect(hostnameError("-a")).toMatch(/hyphen/);
        expect(hostnameError("a-.b")).toMatch(/hyphen/);
        expect(hostnameError("a".repeat(65))).toMatch(/64/);
        expect(prettyHostnameError("Server Box ☃")).toBeNull();
        expect(prettyHostnameError("bad\x07")).toMatch(/Control/);
    });
});

describe("the message of the day", () => {
    it("trims blank lines around it and expands tabs", () => {
        expect(motdLines("\n\n  Welcome\n\tto\tthe box\n\n")).toEqual(["  Welcome", "        to      the box"]);
        expect(motdLines("\n \n")).toEqual([]);
        expect(motdLines(null)).toEqual([]);
        expect(expandTabs("ab\tc")).toBe("ab      c");
    });
});
