/*
 * Overview: the host at a glance, and the few things worth doing from here.
 *
 *   Server Box (server-box)                                  up 12 days, 6:51
 *   Red Hat Enterprise Linux 9.8 (Plow)                since 2026-09-20 10:43
 *
 *   Health                            Usage
 *   › ✗ 2 failed units: a, b            CPU      [██░░░░░░]  3% of 16 CPUs
 *     ! Restart scheduled in 4 min      Memory   [█████░░░]  14.8 / 58.5 GiB
 *         at 2026-10-02 18:45  "msg"    ...
 *
 *   System information                Configuration  h host name, t time
 *     Vendor        ...                 Host name    Server Box (server-box)
 *     ...                               System time  2026-10-02 18:41 MDT
 *
 *   Message of the day  /etc/motd
 *
 * Upstream's cards (pkg/systemd/overview.jsx and overview-cards/*), cut to
 * what a terminal admin uses: health (failed units, a scheduled shutdown),
 * live usage, system information, host name and time configuration, the
 * message of the day, and restart / shut down. Two columns when there is
 * room, one otherwise, and the whole page scrolls when it does not fit.
 * A page with room to spare (Panel.tsx) frames each section in a panel, its
 * heading in the border, and the host's lines in one titled Host.
 *
 * Keys: ↑↓ select an actionable row, Enter acts on it; PgUp/PgDn/Home/End
 * scroll; h host name, t time, c cancel a scheduled shutdown, and R restart
 * and S shut down (administrative access). Tab stays the shell's. The power
 * keys are capitals on purpose: lower-case r is "reload" on other pages, and
 * reaching for it out of habit must not open a restart dialog.
 *
 * Data, each with its own loading and error state (specs/overview.md §2):
 *   hostname1 and timedate1 properties (watched), NTPSynchronized (polled,
 *   it has no change signal), the host's clock from `date`, /proc/uptime,
 *   failed units from systemd (data.ts), the logind schedule file and
 *   /etc/motd (watched), DMI via grep, /etc/machine-id, `uname -r -m`, and
 *   a metrics1 channel for usage (metrics.ts).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box } from "../../tui/ink.js";
import cockpit from "../../cockpit.js";
import type { PageProps } from "../../tui/page.js";
import { isPlain, useKeys, type Hint } from "../../tui/keyboard.js";
import {
    run, runFull, useAsync, useDBusClient, useFile, useNow, useProxy,
} from "../../tui/hooks.js";
import { usePrivilege } from "../../tui/privilege.js";
import { useNavigation } from "../../tui/navigation.js";
import { usePersistentState, useSession } from "../../tui/session-context.js";
import { errorText, useStatus } from "../../tui/status.js";
import { clean, fit, formatTimestamp, width as textWidth } from "../../tui/text.js";
import { colors, glyphs, unicode } from "../../tui/theme.js";
import { PANEL_EDGE, panelled } from "../../tui/components/Panel.js";
import {
    readBinaryFile, readFile, useFailedUnits, useHostClock, usePolledProperty, useUptime, useUsage,
} from "./data.js";
import {
    CancelScheduleDialog, HOSTNAME1, HOSTNAME1_PATH, HostnameDialog, PowerDialog, TIMEDATE1, TIMEDATE1_PATH,
    TimeDialog, scheduleGone, type PowerAction,
} from "./dialogs.js";
import { formatBytes, formatBytesPair, formatIn, formatRate, formatUptime, plural } from "./format.js";
import {
    blankLine, fitSegs, meterSegs, panelLines, renderLine, singleColumn, twoColumns, twoPanels,
    type Cell, type FocusId, type Line, type Seg, type Segs,
} from "./layout.js";
import {
    DMI_ARGV, DMI_ENVIRON, SCHEDULE_FILE, UNAME_ARGV, deviceTreeString, formatInOffset, formatUtcOffset, hostnameText,
    localOffset, localZoneName, motdLines, parseDmi, parseSchedule, parseUname, scheduleNoun, type ScheduledShutdown,
} from "./system.js";

const COLUMN_GAP = 3;
/*
 * The narrowest the right column, Usage, may be: a rate row is 40 columns
 * ("Network  in   33.9 kB/s  out    183 kB/s") plus the 2-column indent, and
 * must not lose its unit.
 */
const MIN_USAGE_COLUMN = 42;
/** Page width from which the sections sit in two columns: the right one gets ceil((width - gap) / 2). */
const TWO_COLUMNS_FROM = 2 * MIN_USAGE_COLUMN + COLUMN_GAP - 1;
/** The same for sections drawn as panels: side by side, each with its border and shadow around the column. */
const PANEL_GAP = 0;
const TWO_PANELS_FROM = 2 * (MIN_USAGE_COLUMN + PANEL_EDGE) + PANEL_GAP - 1;

/*
 * Which dialog is open. A dialog's own state is the only thing that closes
 * it: the cancel dialog keeps the schedule it was opened for, rather than
 * being rendered only while one exists, because the cancellation itself makes
 * the schedule vanish (logind removes its file) before `shutdown -c` has
 * even returned -- a dialog unmounted by that would never report back, and
 * the page's keys would stay switched off for the dialog that was gone.
 */
type DialogState =
    | { kind: "power", action: PowerAction }
    | { kind: "cancel", schedule: ScheduledShutdown, when: string }
    | { kind: "hostname" }
    | { kind: "time" }
    | null;

/*
 * The page's own shortcut keys. Several characters arriving at once -- a
 * paste, or keys typed faster than they were read -- are never taken as
 * shortcuts: a pasted "Server is down for maintenance now" and its newline
 * would otherwise open the shut-down dialog and confirm it. The keyboard
 * offers such a run whole before splitting it into single keys, so a run
 * with one of these in it ends here, with a note. (Its newline still
 * arrives as Enter, which acts on the selected row: it opens a dialog or
 * the Services page, never anything more. The shell will do this properly
 * once it asks the terminal for bracketed paste.)
 */
const SHORTCUT_KEYS = /[RShtc]/;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

// ---- cell builders ------------------------------------------------------------------

function heading(key: string, title: string, detail?: string): Cell {
    return {
        key,
        flush: true,
        heading: { title, ...(detail ? { detail } : {}) },
        content: () => [
            { text: title, color: colors.accent, bold: true },
            ...(detail ? [{ text: `  ${detail}`, color: colors.dim }] : []),
        ],
    };
}

/** "Label   value" with the label in a fixed column. */
function field(key: string, label: string, labelWidth: number, value: Segs, focus?: FocusId): Cell {
    return {
        key,
        ...(focus ? { focus } : {}),
        content: () => [{ text: fit(label, labelWidth) }, ...value],
    };
}

const dimText = (text: string): Segs => [{ text, color: colors.dim }];
const LOADING = dimText(glyphs.ellipsis);
/*
 * A value that is not known yet (the first rate sample, a total that could
 * not be read). Plain "-" without Unicode, like every glyph in theme.ts: a
 * serial console without a UTF-8 locale would show an em dash as debris.
 */
const NONE = unicode ? "\u2014" : "-";
/** "↑↓" for footer hints, ASCII "^v" without Unicode. */
const UP_DOWN = `${glyphs.up}${glyphs.down}`;

/** Left text, and right text pushed to the far end when both fit. */
function spread(left: Segs, right: Segs, width: number): Segs {
    const rightWidth = right.reduce((sum, seg) => sum + textWidth(seg.text), 0);
    const room = width - rightWidth - 2;
    if (rightWidth === 0 || room < Math.min(24, Math.floor(width / 2)))
        return left;
    return [...fitSegs(left, room), { text: "  " }, ...right];
}

const USAGE_LABEL = 9;
const USAGE_VALUE = 20;

function meterCell(key: string, label: string, fraction: number | null, value: string, stale: boolean): Cell {
    return {
        key,
        content: width => {
            const meter = Math.min(32, width - USAGE_LABEL - 2 - USAGE_VALUE);
            return [
                { text: fit(label, USAGE_LABEL) },
                ...(meter >= 6 ? [...meterSegs(fraction, meter, 0.8, 0.9, stale), { text: "  " }] : []),
                { text: value, ...(stale ? { color: colors.dim } : {}) },
            ];
        },
    };
}

function rateCell(key: string, label: string, first: string, a: number | null, second: string, b: number | null,
                  stale: boolean): Cell {
    const show = (rate: number | null) => fit(rate === null ? NONE : formatRate(rate), 9, "right");
    return {
        key,
        content: () => [
            { text: fit(label, USAGE_LABEL) },
            { text: `${first} ${show(a)}  ${second} ${show(b)}`, ...(stale ? { color: colors.dim } : {}) },
        ],
    };
}

// ---- the page -----------------------------------------------------------------------

export default function OverviewPage({ width, height }: PageProps) {
    const privilege = usePrivilege();
    const allowed = privilege.allowed === true;
    const { notify } = useStatus();
    const navigation = useNavigation();
    const { hostname: shellHostname, session } = useSession();
    const now = useNow(1000);

    const hostClient = useDBusClient(HOSTNAME1);
    const host = useProxy(hostClient, HOSTNAME1, HOSTNAME1_PATH);
    const timeClient = useDBusClient(TIMEDATE1);
    const timedate = useProxy(timeClient, TIMEDATE1, TIMEDATE1_PATH);

    const timezone = str(timedate.data.Timezone);
    const clock = useHostClock(timedate.valid ? timezone : null);
    const polledSync = usePolledProperty(timeClient, TIMEDATE1_PATH, TIMEDATE1, "NTPSynchronized", 10_000, timedate.valid);
    const uptime = useUptime();
    const failed = useFailedUnits();
    const scheduleFile = useFile(SCHEDULE_FILE);
    const schedule = useMemo(() => parseSchedule(scheduleFile.content), [scheduleFile.content]);
    const motdFile = useFile("/etc/motd");
    const motd = useMemo(() => motdLines(motdFile.content).map(line => clean(line)), [motdFile.content]);
    const usage = useUsage();
    // No abort signal is passed to run()/runFull(). Its abort listener is
    // `() => proc.close("cancelled")`, which returns the spawn's promise, and
    // Node's EventTarget re-throws a rejected promise returned by a listener
    // as an uncaught exception: unmounting mid-spawn would post "Internal
    // error: cancelled". These commands are quick, and useAsync drops their
    // results after unmount anyway.
    const machineId = useAsync(() => readFile("/etc/machine-id"), []);
    const dmi = useAsync(() => runFull([...DMI_ARGV], { superuser: "try", environ: [...DMI_ENVIRON] }), []);
    const uname = useAsync(() => run([...UNAME_ARGV]), []);

    const hardware = dmi.value ? parseDmi(dmi.value.stdout, dmi.value.stderr) : null;
    // The device tree names boards without DMI (ARM); only asked when
    // nothing else did.
    const needDeviceTree = !dmi.loading && !hardware?.model && host.loaded && !str(host.data.HardwareModel);
    const deviceTree = useAsync(async () => (needDeviceTree
        ? deviceTreeString(await readBinaryFile("/proc/device-tree/model"))
        : ""), [needDeviceTree]);

    const [dialog, setDialog] = useState<DialogState>(null);
    const [savedFocus, setFocus] = usePersistentState<FocusId | null>("overview:focus", null);
    const [top, setTop] = usePersistentState("overview:top", 0);

    // ---- what the rows say ----

    const pretty = str(host.data.PrettyHostname);
    const staticName = str(host.data.StaticHostname);
    const transient = str(host.data.Hostname);
    const hostName = clean(hostnameText(pretty, staticName, transient) || shellHostname);
    const shortHost = clean(staticName || transient || shellHostname);
    const osName = clean(cockpit.info?.os_release?.PRETTY_NAME || str(host.data.OperatingSystemPrettyName));

    /*
     * Instants are shown in our own time zone (formatTimestamp), labelled
     * with its name when the host's zone differs, so "since 10:43" never
     * passes for the host's wall clock. The offsets are compared now, not at
     * the instant shown: two machines in one zone differ at neither.
     */
    const zonesDiffer = clock.clock ? clock.clock.offset !== localOffset(now)
        : session !== null && session.mode !== "local";
    const localTime = (ms: number) => {
        const name = zonesDiffer ? localZoneName(ms) : "";
        return `${formatTimestamp(ms, false)}${name ? ` ${name}` : ""}`;
    };
    /*
     * The host's clock, not ours: logind schedules by the host's clock, and
     * boot time is the host's now minus its uptime. Our clock may be off
     * (another machine, over ssh); the skew is 0 until `date` has answered.
     */
    const hostNow = now + clock.skew;

    const failedUnits = failed.units;
    const failedCount = failedUnits?.length ?? 0;
    const scheduleWhen = schedule?.when ?? null;
    const scheduleText = scheduleWhen !== null ? localTime(scheduleWhen) : "";

    const ntp = bool(timedate.data.NTP);
    const canNtp = bool(timedate.data.CanNTP) !== false;
    const synchronized = bool(polledSync) ?? bool(timedate.data.NTPSynchronized);

    // Selectable rows, top to bottom in either layout.
    const focusOrder: FocusId[] = [
        ...(failedCount > 0 ? ["failed" as const] : []),
        ...(schedule ? ["schedule" as const] : []),
        "hostname",
        "time",
    ];
    /*
     * The selection stays where it is while rows come and go: a unit failing
     * must not move it, and with it what Enter does. Until the rows that
     * come and go (failed units, a schedule) have first loaded it is simply
     * the first row; from then on it is kept, and when its own row goes away
     * it moves to the nearest one still there, the one above it first.
     */
    const settled = (failedUnits !== null || failed.error !== null) && !scheduleFile.loading;
    const previousOrder = useRef(focusOrder);
    let focus: FocusId = focusOrder[0]!;
    if (savedFocus && focusOrder.includes(savedFocus)) {
        focus = savedFocus;
    } else if (savedFocus && settled) {
        const before = previousOrder.current;
        const at = before.indexOf(savedFocus);
        const nearest = at < 0 ? undefined
            : [...before.slice(0, at).reverse(), ...before.slice(at + 1)].find(id => focusOrder.includes(id));
        if (nearest)
            focus = nearest;
    }
    useEffect(() => {
        previousOrder.current = focusOrder;
    });
    useEffect(() => {
        if (settled && focus !== savedFocus)
            setFocus(focus);
    }, [settled, focus, savedFocus, setFocus]);

    // logind dropping its schedule before it was due: it was cancelled, so
    // a restart asked for here is no longer expected to end the connection.
    const hadSchedule = useRef(false);
    useEffect(() => {
        if (hadSchedule.current && !schedule)
            scheduleGone();
        hadSchedule.current = schedule !== null;
    }, [schedule]);

    // ---- sections ----

    const headerCells: Cell[] = [
        {
            key: "title",
            flush: true,
            content: w => spread(
                [{ text: hostName || shortHost || "this host", bold: true, color: colors.accent }],
                uptime.seconds !== null ? dimText(`up ${formatUptime(uptime.seconds)}`) : [],
                w),
        },
        {
            key: "os",
            flush: true,
            content: w => spread(
                osName ? [{ text: osName }] : [],
                uptime.bootTime !== null ? dimText(`since ${localTime(uptime.bootTime + clock.skew)}`) : [],
                w),
        },
    ];

    // The keys for what this section is about, as Configuration lists its
    // own: the footer drops hints that do not fit.
    const healthKeys = [
        ...(schedule && allowed ? ["c cancel"] : []),
        ...(allowed ? ["R restart", "S shut down"] : []),
    ].join(", ");
    const healthCells: Cell[] = [heading("health", "Health", healthKeys || undefined)];
    if (failedUnits === null) {
        if (failed.error) {
            // The reason on a line of its own, as for usage below.
            const reason = clean(failed.error);
            healthCells.push({ key: "failed", content: () => [{ text: `${glyphs.warning} Could not check for failed units`, color: colors.warning }] });
            healthCells.push({ key: "failed-reason", content: () => dimText(`  ${reason}`) });
        } else {
            healthCells.push({ key: "failed", content: () => dimText(`Checking for failed units${glyphs.ellipsis}`) });
        }
    } else if (failedCount === 0) {
        // Only the Services page's unit types are counted (data.ts), so the
        // all-clear says "services", as upstream's "N services have failed"
        // does: a mount or swap unit that failed is not covered by it.
        healthCells.push({ key: "failed", content: () => [{ text: `${glyphs.check} No failed services`, color: colors.ok }] });
    } else {
        healthCells.push({
            key: "failed",
            focus: "failed",
            content: () => [
                { text: `${glyphs.cross} ${plural(failedCount, "failed unit")}`, color: colors.error, bold: true },
                { text: `: ${failedUnits.map(clean).join(", ")}` },
            ],
        });
    }
    if (failed.error && failedUnits !== null)
        healthCells.push({ key: "failed-error", content: () => dimText(`  not updating: ${clean(failed.error!)}`) });
    if (schedule) {
        // The countdown first, where a half-width column cannot cut it off;
        // the time and the wall message on a dim line beneath.
        const noun = scheduleNoun(schedule.mode);
        const remaining = scheduleWhen !== null ? scheduleWhen - hostNow : null;
        const due = remaining === null ? "" : remaining <= 0 ? " now" : ` ${formatIn(remaining)}`;
        healthCells.push({
            key: "schedule",
            focus: "schedule",
            content: () => [
                { text: `${glyphs.warning} ${noun}${schedule.dryRun ? " (dry run)" : ""} scheduled${due}`, color: colors.warning, bold: true },
            ],
        });
        const details = [
            ...(scheduleText ? [`at ${scheduleText}`] : []),
            ...(schedule.message ? [`"${clean(schedule.message)}"`] : []),
        ];
        if (details.length > 0)
            healthCells.push({ key: "schedule-details", content: () => dimText(`  ${details.join("  ")}`) });
    } else if (scheduleFile.error) {
        // A missing file is "nothing scheduled" (content null, no error);
        // an error means we cannot tell, which must not read as the same.
        const reason = clean(errorText(scheduleFile.error));
        healthCells.push({ key: "schedule-error", content: () => [{ text: `${glyphs.warning} Cannot see scheduled shutdowns`, color: colors.warning }] });
        healthCells.push({ key: "schedule-reason", content: () => dimText(`  ${reason}`) });
    }

    const model = usage.model;
    const usageCells: Cell[] = [heading("usage", "Usage", usage.stale ? `updating${glyphs.ellipsis}` : undefined)];
    if (usage.error) {
        // Two lines: in a half-width column the bridge's message would
        // otherwise be cut off right where it starts saying something.
        const reason = clean(usage.error);
        usageCells.push({ key: "usage-error", content: () => [{ text: `${glyphs.warning} Usage is unavailable`, color: colors.warning }] });
        usageCells.push({ key: "usage-reason", content: () => dimText(`  ${reason}`) });
    } else {
        const cpus = model.cpus !== null ? ` of ${plural(model.cpus, "CPU")}` : "";
        usageCells.push(meterCell("cpu", "CPU",
                                  model.cpuPercent !== null ? model.cpuPercent / 100 : null,
                                  model.cpuPercent !== null ? `${Math.round(model.cpuPercent)}%${cpus}` : `${NONE}${cpus}`,
                                  usage.stale));
        const memFraction = model.memUsed !== null && model.memTotal ? model.memUsed / model.memTotal : null;
        usageCells.push(meterCell("memory", "Memory", memFraction,
                                  model.memUsed !== null && model.memTotal
                                      ? formatBytesPair(model.memUsed, model.memTotal)
                                      : model.memUsed !== null ? `${formatBytes(model.memUsed)} used` : NONE,
                                  usage.stale));
        if (model.swap) {
            const used = model.swap.used;
            usageCells.push(meterCell("swap", "Swap", used !== null ? used / model.swap.total : null,
                                      `${used !== null ? formatBytes(used) : NONE} / ${formatBytes(model.swap.total)}`,
                                      usage.stale));
        }
        usageCells.push(rateCell("disk", "Disk", "read", model.diskRead, "write", model.diskWrite, usage.stale));
        usageCells.push(rateCell("network", "Network", "in  ", model.netRx, "out  ", model.netTx, usage.stale));
    }

    const SYS_LABEL = 14;
    const vendor = hardware?.vendor || str(host.data.HardwareVendor);
    const hwModel = hardware?.model || str(host.data.HardwareModel) || deviceTree.value || "";
    const unameValue = uname.value ? parseUname(uname.value) : null;
    const kernel = unameValue?.release || str(host.data.KernelRelease);
    const machineIdText = machineId.value?.trim() ?? "";
    const sysCells: Cell[] = [heading("system", "System information")];
    if (dmi.loading)
        sysCells.push(field("vendor", "Vendor", SYS_LABEL, LOADING));
    else if (vendor)
        sysCells.push(field("vendor", "Vendor", SYS_LABEL, [{ text: clean(vendor) }]));
    sysCells.push(field("model", "Model", SYS_LABEL,
                        hwModel ? [{ text: clean(hwModel) }] : dmi.loading || deviceTree.loading ? LOADING : dimText("unknown")));
    if (hardware?.assetTag)
        sysCells.push(field("asset", "Asset tag", SYS_LABEL, [{ text: clean(hardware.assetTag) }]));
    else if (hardware?.assetTagDenied)
        sysCells.push(field("asset", "Asset tag", SYS_LABEL, dimText("requires administrative access")));
    sysCells.push(field("machine-id", "Machine ID", SYS_LABEL,
                        machineId.loading ? LOADING
                            : machineIdText ? [{ text: clean(machineIdText) }]
                            : dimText(machineId.error ? `unreadable: ${clean(errorText(machineId.error))}` : "not set")));
    sysCells.push(field("kernel", "Kernel", SYS_LABEL,
                        kernel ? [{ text: clean(kernel) }] : uname.loading ? LOADING : dimText("unknown")));
    sysCells.push(field("arch", "Architecture", SYS_LABEL,
                        unameValue ? [{ text: clean(unameValue.arch) }] : uname.loading ? LOADING : dimText("unknown")));

    const CONFIG_LABEL = 13;
    const hostClock = clock.clock;
    const configCells: Cell[] = [heading("config", "Configuration", "h host name, t time")];
    configCells.push(field("hostname", "Host name", CONFIG_LABEL,
                           hostName ? [{ text: hostName }] : host.loaded ? dimText("unknown") : LOADING, "hostname"));
    configCells.push(field("time", "System time", CONFIG_LABEL,
                           hostClock
                               ? [{ text: formatInOffset(now + clock.skew, hostClock.offset) },
                                  { text: hostClock.abbreviation ? ` ${clean(hostClock.abbreviation)}` : "", color: colors.dim }]
                               : clock.error ? dimText(`unknown: ${clean(errorText(clock.error))}`) : LOADING,
                           "time"));
    configCells.push(field("timezone", "Time zone", CONFIG_LABEL,
                           timezone || hostClock
                               ? [{ text: clean(timezone) || formatUtcOffset(hostClock!.offset) },
                                  ...(timezone && hostClock ? [{ text: ` (${formatUtcOffset(hostClock.offset)})`, color: colors.dim }] : [])]
                               : timedate.loaded ? dimText("unknown") : LOADING));
    let ntpText: Segs;
    if (!timedate.valid)
        ntpText = timedate.loaded ? dimText("unknown (timedated is not available)") : LOADING;
    else if (!canNtp)
        ntpText = dimText("not available (no NTP service installed)");
    else if (ntp)
        ntpText = synchronized
            ? [{ text: `${glyphs.check} on, synchronized`, color: colors.ok }]
            : [{ text: `${glyphs.warning} on, not synchronized yet`, color: colors.warning }];
    else
        ntpText = [{ text: "off" }];
    configCells.push(field("ntp", "NTP", CONFIG_LABEL, ntpText));

    const limited = privilege.allowed === false && privilege.configured === true;

    // ---- layout ----

    // Each section in a panel of its own while the page has the room
    // (Panel.tsx); below that, headings over indented rows.
    const boxed = panelled(width, height);
    const twoColumn = width >= (boxed ? TWO_PANELS_FROM : TWO_COLUMNS_FROM);

    const build = (contentWidth: number, spaced: boolean): Line[] => {
        const lines: Line[] = [];
        const gap = (key: string) => {
            if (spaced)
                lines.push(blankLine(key));
        };
        const section = (cells: readonly Cell[]) => (boxed
            ? panelLines(cells, contentWidth, focus)
            : singleColumn(cells, contentWidth, focus));
        // LimitedAccessBanner's line, as one of ours so the height adds up.
        const limitedCell: Cell = {
            key: "limited",
            flush: true,
            content: () => [{ text: `${glyphs.warning} Limited access: press A to turn on administrative access.`, color: colors.warning }],
        };
        const top = [...headerCells, ...(limited ? [limitedCell] : [])];
        lines.push(...(boxed ? panelLines([heading("host", "Host"), ...top], contentWidth, focus) : singleColumn(top, contentWidth, focus)));
        // Kept while there is room; compact, the headings' colour and the
        // indented rows beneath them separate the sections well enough, and
        // the line is worth more at 80x24 (where the page is 22 lines).
        // Panels separate themselves.
        const between = (key: string) => {
            if (!boxed)
                gap(key);
        };
        between("after-header");
        if (twoColumn && boxed) {
            const left = Math.floor((contentWidth - PANEL_GAP) / 2);
            const right = contentWidth - PANEL_GAP - left;
            lines.push(...twoPanels(healthCells, usageCells, left, PANEL_GAP, right, focus));
            lines.push(...twoPanels(sysCells, configCells, left, PANEL_GAP, right, focus));
        } else if (twoColumn) {
            const left = Math.floor((contentWidth - COLUMN_GAP) / 2);
            const right = contentWidth - COLUMN_GAP - left;
            lines.push(...twoColumns(healthCells, usageCells, left, COLUMN_GAP, right, focus, "band1"));
            gap("after-band1");
            lines.push(...twoColumns(sysCells, configCells, left, COLUMN_GAP, right, focus, "band2"));
        } else {
            lines.push(...section(healthCells));
            between("after-health");
            lines.push(...section(usageCells));
            between("after-usage");
            lines.push(...section(sysCells));
            between("after-system");
            lines.push(...section(configCells));
        }
        if (motd.length > 0) {
            between("before-motd");
            lines.push(...section([
                heading("motd", "Message of the day", "/etc/motd"),
                ...motd.map((line, i): Cell => ({ key: `motd${i}`, content: () => [{ text: line }] })),
            ]));
        }
        return lines;
    };

    // Blank lines between sections only while everything fits; past that
    // the page scrolls, with a column on the right saying which way.
    let lines = build(width, true);
    if (lines.length > height)
        lines = build(width, false);
    const scrollable = lines.length > height;
    if (scrollable)
        lines = build(Math.max(1, width - 2), false);
    const maxTop = Math.max(0, lines.length - height);
    const shownTop = Math.min(top, maxTop);
    const lineOf = (id: FocusId) => lines.findIndex(line => line.focus === id);
    const focusLine = lineOf(focus);
    const selectionShown = focusLine >= shownTop && focusLine < shownTop + height;

    /** Scroll just enough to show line `index`, and its section heading when that fits. */
    const reveal = (index: number) => {
        if (index < 0)
            return;
        setTop(current => {
            const from = Math.min(current, maxTop);
            if (index < from)
                return Math.max(0, index - 1);
            if (index >= from + height)
                return Math.min(maxTop, index - height + 1);
            return from;
        });
    };

    // ---- actions ----

    const needsAdmin = (what: string) => notify(privilege.configured
        ? `${what} needs administrative access: press A to turn it on`
        : `${what} needs administrative access, which is not available in this session`, "warning");

    const power = (action: PowerAction) => {
        if (!allowed)
            needsAdmin(action === "restart" ? "Restarting" : "Shutting down");
        else
            setDialog({ kind: "power", action });
    };

    const activate = (id: FocusId) => {
        switch (id) {
        case "failed":
            if (failedCount > 0)
                // The count is the system manager's: say so, or Services keeps the owner
                // it was last left on (possibly the user manager).
                navigation.go("services", { filter: "failed", user: false });
            break;
        case "schedule":
            if (!schedule)
                break;
            if (!allowed)
                needsAdmin("Cancelling a scheduled shutdown");
            else
                setDialog({ kind: "cancel", schedule, when: scheduleText });
            break;
        // `valid` (the properties are here) rather than `loaded` (wait()
        // has settled): the data arrives with the watch's notify, and the
        // library settles wait() two timer hops later, which on a busy
        // first render is long enough for a key to land in between.
        case "hostname":
            if (host.valid)
                setDialog({ kind: "hostname" });
            else if (!host.loaded)
                notify(`Still reading the host name${glyphs.ellipsis}`);
            else
                notify(`The host name cannot be changed: hostnamed is not available (${clean(errorText(host.error ?? "no hostname1 object"))})`, "error");
            break;
        case "time":
            if (timedate.valid)
                setDialog({ kind: "time" });
            else if (!timedate.loaded)
                notify(`Still reading the time settings${glyphs.ellipsis}`);
            else
                notify(`The time cannot be changed: timedated is not available (${clean(errorText(timedate.error ?? "no timedate1 object"))})`, "error");
            break;
        }
    };

    const select = (id: FocusId) => {
        setFocus(id);
        reveal(lineOf(id));
    };

    /*
     * Keep the selection in view when the page changes under it -- rows
     * arriving or going above it, the terminal resized -- if it was in view
     * before. Not when the user scrolled it out of view (PgDn, End), and
     * not on the first draw: a small terminal opens on the top of the page,
     * and the first arrow key or Enter brings the selection into view.
     */
    const layoutKey = `${focusLine}/${lines.length}/${width}x${height}`;
    const lastLayout = useRef<{ key: string, shown: boolean } | null>(null);
    useLayoutEffect(() => {
        const before = lastLayout.current;
        lastLayout.current = { key: layoutKey, shown: selectionShown };
        if (before && before.key !== layoutKey && before.shown && !selectionShown)
            reveal(focusLine);
    });

    const enterLabel: Record<FocusId, string> = {
        failed: "show failed",
        schedule: "cancel it",
        hostname: "host name",
        time: "time",
    };
    const cancelLabel = schedule?.mode === "reboot" || schedule?.mode === "kexec" ? "cancel restart" : "cancel shutdown";
    const hints: Hint[] = [
        ...(focusOrder.length > 1 || !selectionShown ? [[UP_DOWN, "select"] as const] : []),
        // Only for a row in view: Enter on an unseen one shows it first.
        ...(selectionShown ? [["enter", enterLabel[focus]] as const] : []),
        ...(schedule && allowed && !(selectionShown && focus === "schedule") ? [["c", cancelLabel] as const] : []),
        ...(allowed ? [["R", "restart"] as const, ["S", "shut down"] as const] : []),
    ];

    useKeys((input, key) => {
        if (isPlain(input, key) && SHORTCUT_KEYS.test(input)) {
            const count = [...segmenter.segment(input)].length;
            if (count > 1) {
                notify(`Ignored ${count} characters typed or pasted at once`, "info");
                return true;
            }
        }
        if ((key.upArrow || key.downArrow || key.return) && !selectionShown && focusLine >= 0) {
            // The selection is off screen (a small terminal, or scrolled
            // away): show it before moving it or acting on it.
            reveal(focusLine);
            return true;
        }
        if (key.upArrow || key.downArrow) {
            const next = focusOrder.indexOf(focus) + (key.downArrow ? 1 : -1);
            if (next >= 0 && next < focusOrder.length)
                select(focusOrder[next]!);
            else
                setTop(current => Math.max(0, Math.min(maxTop, Math.min(current, maxTop) + (key.downArrow ? 1 : -1))));
            return true;
        }
        if (key.pageUp || key.pageDown || key.home || key.end) {
            const page = Math.max(1, height - 1);
            const from = shownTop;
            const to = key.home ? 0 : key.end ? maxTop
                : Math.max(0, Math.min(maxTop, from + (key.pageDown ? page : -page)));
            setTop(to);
            // Keep the selection on screen if there is something to select there.
            const visible = (id: FocusId) => {
                const at = lineOf(id);
                return at >= to && at < to + height;
            };
            if (!visible(focus)) {
                const candidates = focusOrder.filter(visible);
                const pick = key.pageUp || key.home ? candidates.at(-1) : candidates[0];
                if (pick)
                    setFocus(pick);
            }
            return true;
        }
        if (key.return) {
            activate(focus);
            return true;
        }
        if (!isPlain(input, key))
            return false;
        switch (input) {
        case "R": power("restart"); return true;
        case "S": power("shutdown"); return true;
        case "h": select("hostname"); activate("hostname"); return true;
        case "t": select("time"); activate("time"); return true;
        case "c":
            if (!schedule)
                return false;
            select("schedule");
            activate("schedule");
            return true;
        default:
            return false;
        }
    }, { active: dialog === null, hints });

    const close = () => setDialog(null);
    const visible = lines.slice(shownTop, shownTop + height);
    const contentWidth = scrollable ? Math.max(1, width - 2) : width;

    return (
        <Box flexDirection="column" width={width} height={height}>
            {visible.map((line, i) => {
                if (!scrollable)
                    return renderLine(line);
                const arrow = i === 0 && shownTop > 0 ? glyphs.up
                    : i === visible.length - 1 && shownTop < maxTop ? glyphs.down : " ";
                return renderLine({
                    ...line,
                    segs: [...(line.segs.length ? line.segs : [{ text: " ".repeat(contentWidth) }]),
                           { text: ` ${arrow}`, color: colors.dim }] as Seg[],
                });
            })}
            {dialog?.kind === "power" && <PowerDialog action={dialog.action} host={shortHost} onClose={close} />}
            {dialog?.kind === "cancel" && (
                <CancelScheduleDialog schedule={dialog.schedule} when={dialog.when} stillScheduled={schedule !== null}
                                      onClose={close} />
            )}
            {dialog?.kind === "hostname" && (
                <HostnameDialog pretty={clean(pretty)} staticName={clean(staticName)} privileged={allowed} onClose={close} />
            )}
            {dialog?.kind === "time" && (
                <TimeDialog
                    client={timeClient}
                    timezone={timezone}
                    ntp={ntp ?? false}
                    canNtp={canNtp}
                    clock={hostClock}
                    skew={clock.skew}
                    privileged={allowed}
                    onClose={close}
                    onApplied={clock.reload}
                />
            )}
        </Box>
    );
}
