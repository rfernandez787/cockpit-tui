/*
 * The overview's dialogs: restart / shut down, cancelling a scheduled
 * shutdown, the host name, and the system time with its time zone picker.
 *
 * Every action runs on a short-lived channel at the current privilege level
 * (callOnce / run), the pattern upstream uses for actions, and every failure
 * stays in the dialog with the host's own words so it can be corrected and
 * retried.
 */
import { useState } from "react";
import { Box, Text } from "../../tui/ink.js";
import { FormDialog, type FormField } from "../../tui/components/Form.js";
import { Buttons, Dialog, DialogText, dialogInnerWidth, useArea, useDialogWidth } from "../../tui/components/Dialog.js";
import { Spinner } from "../../tui/components/Spinner.js";
import { TextInput } from "../../tui/components/TextInput.js";
import { useListNav } from "../../tui/components/Table.js";
import { callOnce, run, unvariant, useAsync, useMounted, type DBusClient } from "../../tui/hooks.js";
import type { Hint, Key } from "../../tui/keyboard.js";
import { isPlain } from "../../tui/keyboard.js";
import { expectDisconnect, expectedDisconnectReason } from "../../tui/page.js";
import { errorText, useStatus } from "../../tui/status.js";
import { clean, fit, truncate, width as textWidth, wrap } from "../../tui/text.js";
import { colors, glyphs } from "../../tui/theme.js";
import { plural } from "./format.js";
import {
    deriveHostname, filterZones, formatInOffset, formatInZone, hostnameError, manualTimeArgv, parseManualTime,
    prettyHostnameError, scheduleNoun, type HostClock, type ScheduledShutdown,
} from "./system.js";

export const HOSTNAME1 = "org.freedesktop.hostname1";
export const HOSTNAME1_PATH = "/org/freedesktop/hostname1";
export const TIMEDATE1 = "org.freedesktop.timedate1";
export const TIMEDATE1_PATH = "/org/freedesktop/timedate1";

/** A host error for display: the host's own words, made safe for the terminal. */
function hostError(error: unknown): string {
    return clean(errorText(error));
}

// ---- restart / shut down ----------------------------------------------------------

export type PowerAction = "restart" | "shutdown";

/** Upstream's delays (cockpit-components-shutdown.jsx), "No delay" being +0. */
export const POWER_DELAYS = [
    { value: "0", label: "Now" },
    { value: "1", label: "In 1 minute" },
    { value: "5", label: "In 5 minutes" },
    { value: "20", label: "In 20 minutes" },
    { value: "40", label: "In 40 minutes" },
    { value: "60", label: "In 60 minutes" },
] as const;

/**
 * Upstream's command, message included even when empty. Every delay, "+0"
 * too, goes through logind's ScheduleShutdown (systemd parses "+N" as now +
 * N minutes), so logged-in users get the wall message and a delayed one
 * stays cancellable. Never preceded by cockpit.hint("restart") as upstream
 * does: a bare bridge drops the connection on that control.
 *
 * One deviation: "--" before the time. systemd's shutdown parses its
 * arguments with getopt_long("HPrhkKat:fFc"), which permutes, so without it
 * a message such as "-h", "-c" or "-k" would be read as an option -- a
 * power-off instead of the restart confirmed, a cancel, a dry run -- and the
 * command would still exit 0.
 */
export function powerArgv(action: PowerAction, minutes: number, message: string): string[] {
    return ["shutdown", action === "restart" ? "--reboot" : "--poweroff", "--", `+${minutes}`, message];
}

function powerIntro(action: PowerAction, minutes: number): string {
    const restart = action === "restart";
    const what = restart ? "restarts" : "powers off";
    if (minutes === 0)
        return `The host ${what} right away and this connection closes.` +
            (restart ? "" : " It stays off until someone powers it on again.");
    return `The host ${what} in ${plural(minutes, "minute")}${restart ? "" : " and stays off until someone powers it on again"}. ` +
        `Logged-in users are warned, and the ${restart ? "restart" : "shutdown"} can be cancelled from this page until then.`;
}

/** The same in one line, for a dialog without room for the paragraph. */
function powerIntroShort(action: PowerAction, minutes: number): string {
    const what = action === "restart" ? "Restarts" : "Powers off";
    return minutes === 0
        ? `${what} now; this connection closes.`
        : `${what} in ${minutes} min; can be cancelled here.`;
}

// ---- the dropped connection after a restart or shutdown ----------------------------

/*
 * After a restart or shutdown asked for here, the connection dropping is what
 * was asked for (specs/overview.md gotcha 16): the shell then says so and
 * exits 0. An immediate one is expected from the moment it is requested; a
 * delayed one only from shortly before it falls due, so that a connection
 * lost for some other reason in the meantime is still reported as lost.
 * Module state, like the shell's expectation itself: the page may well have
 * been left by then. Cancelling forgets it again.
 */
export const powerSettings = { dueMarginMs: 15_000 };

let pending: { reason: string, due: number, timer: ReturnType<typeof setTimeout> | null } | null = null;

/** Treat the connection dropping as expected from shortly before `due` (our clock, ms) on. */
export function expectDisconnectFrom(reason: string, due: number): void {
    forgetExpectedDisconnect();
    const wait = due - powerSettings.dueMarginMs - Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (wait > 0) {
        timer = setTimeout(() => expectDisconnect(reason), wait);
        timer.unref?.();
    } else {
        expectDisconnect(reason);
    }
    pending = { reason, due, timer };
}

/** The restart or shutdown is off: a dropped connection is a failure again. */
export function forgetExpectedDisconnect(): void {
    if (!pending)
        return;
    if (pending.timer)
        clearTimeout(pending.timer);
    if (expectedDisconnectReason() === pending.reason)
        expectDisconnect(null);
    pending = null;
}

/**
 * logind no longer has a schedule. Before its time that means it was
 * cancelled (here or elsewhere); at its time logind removes it as it starts
 * carrying it out, and the connection is about to go -- keep expecting that.
 */
export function scheduleGone(): void {
    if (pending && pending.due - powerSettings.dueMarginMs > Date.now())
        forgetExpectedDisconnect();
}

type PowerField = "delay" | "message";

/*
 * The dialog's own form rather than the shared FormDialog, for the delay:
 * there, Space and ←/→ step a select round in a circle, from "In 60 minutes"
 * on to "Now". Here the delay stops at both ends and only ←/→ change it, so
 * a stray Space (or a burst of pasted text) can never turn a delayed,
 * cancellable restart into an immediate one: "Now" is one deliberate ←
 * from the default.
 */
export function PowerDialog({ action, host, onClose }: { action: PowerAction, host: string, onClose: () => void }) {
    const { notify } = useStatus();
    const mounted = useMounted();
    const area = useArea();
    const width = useDialogWidth(64);
    const inner = dialogInnerWidth(width);
    const [delayIndex, setDelayIndex] = useState(1); // "In 1 minute", upstream's default
    const [message, setMessage] = useState("");
    const [focus, setFocus] = useState<PowerField>("delay");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const restart = action === "restart";
    const delay = POWER_DELAYS[delayIndex]!;
    const minutes = Number(delay.value);
    const submitLabel = restart ? "Restart" : "Shut down";

    const submit = () => {
        if (busy)
            return;
        const reason = restart ? `${host} is restarting.` : `${host} is shutting down.`;
        const requested = Date.now();
        // An immediate one takes the connection with it: tell the shell first,
        // so the drop is reported as what was asked for.
        if (minutes === 0)
            expectDisconnectFrom(reason, requested);
        setBusy(true);
        setError(null);
        run(powerArgv(action, minutes, message), { superuser: "require" }).then(() => {
            if (minutes > 0) {
                expectDisconnectFrom(reason, requested + minutes * 60_000);
                notify(`${restart ? "Restart" : "Shutdown"} scheduled in ${plural(minutes, "minute")}`, "success");
            } else {
                notify(`${restart ? "Restarting" : "Shutting down"} ${host}${glyphs.ellipsis}`, "info");
            }
            if (mounted())
                onClose();
        }, (failure: unknown) => {
            if (minutes === 0)
                forgetExpectedDisconnect();
            if (!mounted())
                return;
            setBusy(false);
            setError(hostError(failure));
        });
    };

    const onKey = (_input: string, key: Key): boolean => {
        if (busy)
            return true;
        if (key.upArrow || key.downArrow || key.tab) {
            setFocus(current => (current === "delay" ? "message" : "delay"));
            return true;
        }
        if (key.return) {
            submit();
            return true;
        }
        if (focus === "delay" && (key.leftArrow || key.rightArrow)) {
            const step = key.leftArrow ? -1 : 1;
            setDelayIndex(at => Math.max(0, Math.min(POWER_DELAYS.length - 1, at + step)));
            return true;
        }
        // Anything else -- Space, letters -- does nothing; the dialog traps it.
        return false;
    };

    /*
     * Everything at its natural height, never squeezed (an overflowing
     * dialog would otherwise draw its lines over each other): with too
     * little room the intro shrinks to one line and an error to one line,
     * so the delay, the message and the buttons stay in view.
     */
    const labelWidth = 9;
    const valueWidth = Math.max(4, inner - labelWidth);
    const intro = powerIntro(action, minutes);
    // Border and title, the intro, the two fields, an error, the buttons.
    const full = 3 + (1 + wrap(intro, inner).length) + 3 + (error ? 1 + wrap(error, inner).length : 0) + 2;
    const compact = full > area.height;
    const label = (field: PowerField, text: string) => {
        const focused = focus === field && !busy;
        return (
            <Box width={labelWidth} flexShrink={0}>
                <Text color={focused ? colors.accent : undefined} bold={focused} wrap="truncate">
                    {fit(`${focused ? glyphs.pointer : " "}${text}`, labelWidth)}
                </Text>
            </Box>
        );
    };
    const delayFocused = focus === "delay" && !busy;
    const hints: Hint[] = busy ? [] : [
        [glyphs.updown, "field"],
        ...(delayFocused ? [[glyphs.leftright, "when"] as const] : []),
        ["enter", submitLabel.toLowerCase()],
        ["esc", "cancel"],
    ];

    return (
        <Dialog
            title={`${submitLabel} ${host}`}
            width={width}
            tone="error"
            onCancel={busy ? undefined : onClose}
            onKey={onKey}
            hints={hints}
        >
            <Box flexDirection="column" flexShrink={0}>
                {compact
                    ? <Text wrap="truncate">{truncate(powerIntroShort(action, minutes), inner)}</Text>
                    : <DialogText width={width}>{intro}</DialogText>}
            </Box>
            <Box flexDirection="column" marginTop={1} flexShrink={0}>
                <Box>
                    {label("delay", "When")}
                    <Text wrap="truncate">{truncate(delayFocused ? `< ${delay.label} >` : delay.label, valueWidth)}</Text>
                </Box>
                <Box>
                    {label("message", "Message")}
                    <Box width={valueWidth}>
                        <TextInput
                            value={message}
                            onChange={setMessage}
                            onSubmit={submit}
                            focus={focus === "message" && !busy}
                            width={valueWidth}
                            maxLength={256}
                            placeholder="optional, for logged-in users"
                        />
                    </Box>
                </Box>
            </Box>
            {error
                ? (compact
                    ? <Box flexShrink={0}><Text color={colors.error} wrap="truncate">{truncate(error, inner)}</Text></Box>
                    : <Box flexDirection="column" flexShrink={0}><DialogText width={width} color={colors.error}>{error}</DialogText></Box>)
                : null}
            <Box marginTop={1} flexShrink={0}>
                {busy
                    ? <Spinner label={minutes === 0 ? (restart ? "Restarting" : "Shutting down") : "Scheduling"} />
                    : <Buttons confirm={submitLabel} />}
            </Box>
        </Dialog>
    );
}

// ---- cancel a scheduled shutdown -------------------------------------------------

export const LOGIN1 = "org.freedesktop.login1";
export const LOGIN1_PATH = "/org/freedesktop/login1";
export const LOGIN1_MANAGER = "org.freedesktop.login1.Manager";

/**
 * Confirm, then logind's CancelScheduledShutdown, the call upstream makes
 * (shutdownStatus.tsx; superuser "try"). Not `shutdown -c`: that first calls
 * SetWallMessage("", true), which turns wall messages back on for a schedule
 * made with --no-wall (systemd 252 systemctl-logind.c). logind tells
 * logged-in users itself, when wall messages are on, and replies whether
 * there was anything to cancel.
 *
 * `schedule` is the one the dialog was opened for; `stillScheduled` is
 * whether logind still has it. Our own cancellation removes it before the
 * call returns, but if it goes away by other means (cancelled elsewhere, or
 * carried out) the dialog says so and only closes.
 */
export function CancelScheduleDialog({ schedule, when, stillScheduled, onClose }: {
    schedule: ScheduledShutdown, when: string, stillScheduled: boolean, onClose: () => void,
}) {
    const { notify } = useStatus();
    const mounted = useMounted();
    const area = useArea();
    const width = useDialogWidth(60);
    const inner = dialogInnerWidth(width);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const noun = scheduleNoun(schedule.mode).toLowerCase();
    const gone = !stillScheduled && !busy;

    const confirm = () => {
        if (busy)
            return;
        if (gone) {
            onClose();
            return;
        }
        setBusy(true);
        setError(null);
        callOnce(LOGIN1, { superuser: "try" }, LOGIN1_PATH, LOGIN1_MANAGER, "CancelScheduledShutdown", []).then(([cancelled]) => {
            if (cancelled === false) {
                // Nothing to cancel any more: carried out, or cancelled elsewhere.
                scheduleGone();
                notify(`The ${noun} was no longer scheduled`, "info");
            } else {
                forgetExpectedDisconnect();
                notify(`Scheduled ${noun} cancelled`, "success");
            }
            if (mounted())
                onClose();
        }, (failure: unknown) => {
            if (!mounted())
                return;
            setBusy(false);
            setError(hostError(failure));
        });
    };

    const at = when ? ` for ${when}` : "";
    const text = gone
        ? `The ${noun}${at} is no longer scheduled: it was cancelled elsewhere, or has begun.`
        : `The ${noun} scheduled${at} will not happen. Logged-in users are told it was cancelled.`;
    // As in PowerDialog: nothing squeezed; short of room, the error gets one line.
    const compact = 3 + (1 + wrap(text, inner).length) + (error ? 1 + wrap(error, inner).length : 0) + 2 > area.height;
    return (
        <Dialog
            title={`Cancel the scheduled ${noun}?`}
            width={width}
            tone="warning"
            onCancel={busy ? undefined : onClose}
            onConfirm={busy ? undefined : confirm}
            hints={busy ? [] : gone ? [["esc", "close"]] : [["enter", `cancel the ${noun}`], ["esc", "keep it"]]}
        >
            <Box flexDirection="column" flexShrink={0}>
                <DialogText width={width}>{text}</DialogText>
            </Box>
            {error
                ? (compact
                    ? <Box flexShrink={0}><Text color={colors.error} wrap="truncate">{truncate(error, inner)}</Text></Box>
                    : <Box flexDirection="column" flexShrink={0}><DialogText width={width} color={colors.error}>{error}</DialogText></Box>)
                : null}
            <Box marginTop={1} flexShrink={0}>
                {busy
                    ? <Spinner label="Cancelling" />
                    : <Text color={colors.dim} wrap="truncate">{gone ? "[Esc] Close" : `[Enter] Cancel the ${noun}   [Esc] Keep it`}</Text>}
            </Box>
        </Dialog>
    );
}

// ---- host name ---------------------------------------------------------------------

/**
 * Pretty and static host name, like upstream's dialog: while the static name
 * has not been typed in, it follows the pretty one. Only what changed is sent,
 * static first (it is the one that can be refused as invalid), each with
 * interactive=true; superuser "try" makes it root's call when administrative
 * access is on, and otherwise polkit decides, so its refusal is shown here
 * (upstream's dialog stays open and silent on errors).
 */
export function HostnameDialog({ pretty: initialPretty, staticName: initialStatic, privileged, onClose }: {
    pretty: string, staticName: string, privileged: boolean, onClose: () => void,
}) {
    const { notify } = useStatus();
    const mounted = useMounted();
    const area = useArea();
    const [pretty, setPretty] = useState(initialPretty);
    const [name, setName] = useState(initialStatic);
    const [follow, setFollow] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showErrors, setShowErrors] = useState(false);
    /*
     * The shared form lets an overflowing dialog draw its lines over each
     * other. Where the area is short (it needs 14 lines for the help line
     * and a wrapped error), keep it to what fits: no help line, and the
     * host's error alone, on one line.
     */
    const compact = area.height < 14;
    const inner = dialogInnerWidth(useDialogWidth(64));

    const nameChanged = name !== initialStatic;
    const prettyChanged = pretty !== initialPretty;
    const nameProblem = nameChanged ? hostnameError(name) : null;
    const prettyProblem = prettyChanged ? prettyHostnameError(pretty) : null;

    const submit = async () => {
        if (busy)
            return;
        if (nameProblem || prettyProblem) {
            setShowErrors(true);
            return;
        }
        if (!nameChanged && !prettyChanged) {
            onClose();
            return;
        }
        setBusy(true);
        setError(null);
        let what = "host name";
        try {
            if (nameChanged)
                await callOnce(HOSTNAME1, { superuser: "try" }, HOSTNAME1_PATH, HOSTNAME1, "SetStaticHostname", [name, true]);
            what = "pretty host name";
            if (prettyChanged)
                await callOnce(HOSTNAME1, { superuser: "try" }, HOSTNAME1_PATH, HOSTNAME1, "SetPrettyHostname", [pretty, true]);
            notify(`Host name changed to ${clean(nameChanged ? name : pretty || name)}`, "success");
            if (mounted())
                onClose();
        } catch (failure) {
            if (!mounted())
                return;
            setBusy(false);
            const hint = privileged ? "" : " Administrative access (A) may be needed.";
            setError(compact
                ? truncate(hostError(failure), inner)
                : `Could not change the ${what}: ${hostError(failure)}${hint}`);
        }
    };

    const fields: FormField[] = [
        { kind: "text", id: "pretty", label: "Pretty name", value: pretty, maxLength: 255,
          placeholder: "optional, e.g. Web Server 1", ...(showErrors || prettyChanged ? { error: prettyProblem } : {}) },
        { kind: "text", id: "name", label: "Host name", value: name, maxLength: 64,
          ...(compact ? {} : { help: "lower-case letters, digits, hyphens and dots" }),
          ...(nameChanged ? { error: nameProblem } : {}) },
    ];

    return (
        <FormDialog
            title="Change host name"
            fields={fields}
            onChange={(id, value) => {
                const text = String(value);
                // The host's error was about what was sent; editing moves on.
                setError(null);
                if (id === "pretty") {
                    setPretty(text);
                    // Follow the pretty name until the real one is edited;
                    // clearing the pretty name leaves the real one alone.
                    const derived = deriveHostname(text, name);
                    if (follow && derived && !derived.startsWith("."))
                        setName(derived);
                } else if (id === "name") {
                    setName(text);
                    setFollow(false);
                }
            }}
            onSubmit={() => void submit()}
            onCancel={onClose}
            submitLabel="Change"
            busy={busy}
            busyText="Changing the host name"
            error={error}
        />
    );
}

// ---- system time -----------------------------------------------------------------

/** How long to wait for timedated to report the NTP change it was asked for. */
export const timeSettings = { ntpTimeoutMs: 10_000, pollMs: 250 };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The zones timedated accepts: its ListTimezones() (systemd 246 and later),
 * else `timedatectl list-timezones` as upstream runs it.
 */
export async function listTimezones(client: DBusClient): Promise<string[]> {
    try {
        const [zones] = await client.call(TIMEDATE1_PATH, TIMEDATE1, "ListTimezones", []);
        if (Array.isArray(zones))
            return zones.filter((zone): zone is string => typeof zone === "string");
    } catch {
        // an older timedated: fall through
    }
    const text = await run(["timedatectl", "list-timezones"]);
    return text.split("\n").map(line => line.trim()).filter(Boolean);
}

/**
 * Wait until timedated reports NTP as `want`. SetNTP replies once it has
 * asked systemd to start or stop the NTP unit; the property follows when the
 * unit's state does. Upstream waits for a PropertiesChanged with no time
 * limit, and resolves even when SetNTP failed (serverTime.js:152-183), so a
 * lost signal hangs its dialog; this polls with a deadline instead.
 */
export async function waitForNtp(client: DBusClient, want: boolean): Promise<boolean> {
    const deadline = Date.now() + timeSettings.ntpTimeoutMs;
    for (;;) {
        try {
            const [value] = await client.call(TIMEDATE1_PATH, "org.freedesktop.DBus.Properties", "Get", [TIMEDATE1, "NTP"]);
            if (unvariant(value) === want)
                return true;
        } catch {
            // timedated restarting on activation: keep asking until the deadline
        }
        if (Date.now() >= deadline)
            return false;
        await sleep(timeSettings.pollMs);
    }
}

export interface TimeDialogProps {
    readonly client: DBusClient;
    readonly timezone: string;
    readonly ntp: boolean;
    readonly canNtp: boolean;
    readonly clock: HostClock | null;
    readonly skew: number;
    readonly privileged: boolean;
    readonly onClose: () => void;
    /** Settings changed: re-read the host's clock. */
    readonly onApplied: () => void;
}

type TimeField = "zone" | "ntp" | "time";
const TIME_FIELDS: readonly TimeField[] = ["zone", "ntp", "time"];
const ZONE_HINT = "  space: choose";

/**
 * Time zone, NTP on/off, and (with NTP off) a manual time. Applied in
 * upstream's order -- zone, then NTP, then the time -- because SetTime is
 * refused while NTP is on, and the typed time is parsed by the host's own
 * `date` after the zone change, so it means wall-clock time in the new zone.
 */
export function TimeDialog(props: TimeDialogProps) {
    const { notify } = useStatus();
    const mounted = useMounted();
    const zones = useAsync(() => listTimezones(props.client), [props.client]);
    /*
     * What to put in the time field while it has not been typed in: the
     * host's time now, as wall-clock time in `zoneName`. For the host's own
     * zone that is the host's own reading (its offset from `date`); for a
     * zone just picked it comes from our tz data, which is good enough for
     * a suggestion -- the host parses whatever is submitted itself.
     */
    const suggestTime = (zoneName: string): string => {
        const at = Date.now() + props.skew;
        if (props.clock && zoneName === props.timezone)
            return formatInOffset(at, props.clock.offset);
        return formatInZone(at, zoneName) ?? (props.clock ? formatInOffset(at, props.clock.offset) : "");
    };
    const [zone, setZone] = useState(props.timezone);
    const [ntp, setNtp] = useState(props.ntp);
    const [time, setTime] = useState(() => suggestTime(props.timezone));
    const [timeEdited, setTimeEdited] = useState(false);
    const [focus, setFocus] = useState<TimeField>("zone");
    const [picking, setPicking] = useState<{ query: string } | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<Partial<Record<TimeField, string>>>({});

    // Hooks before the picker's early return, so their order never changes.
    const area = useArea();
    const width = useDialogWidth(66);
    const enabled = TIME_FIELDS.filter(field => (field !== "ntp" || props.canNtp) && (field !== "time" || !ntp));

    const apply = async () => {
        if (busy)
            return;
        const errors: Partial<Record<TimeField, string>> = {};
        // Only a zone being changed to is checked: the host's current one
        // may be missing from the list (a link such as "US/Mountain", or a
        // zone tzdata has since dropped), and that must not block NTP.
        if (zone !== props.timezone && zones.value && !zones.value.includes(zone))
            errors.zone = "Not a time zone this host knows";
        let manual: string | null = null;
        if (!ntp && timeEdited) {
            const parsed = parseManualTime(time);
            if ("error" in parsed)
                errors.time = parsed.error;
            else
                manual = parsed.value;
        }
        setFieldErrors(errors);
        if (Object.keys(errors).length > 0)
            return;

        const zoneChanged = zone !== props.timezone;
        const ntpChanged = ntp !== props.ntp;
        if (!zoneChanged && !ntpChanged && manual === null) {
            props.onClose();
            return;
        }

        setError(null);
        let step = "";
        let warning: string | null = null;
        try {
            if (zoneChanged) {
                step = "set the time zone";
                setBusy("Setting the time zone");
                await callOnce(TIMEDATE1, { superuser: "try" }, TIMEDATE1_PATH, TIMEDATE1, "SetTimezone", [zone, true]);
            }
            if (ntpChanged) {
                step = ntp ? "turn on NTP" : "turn off NTP";
                setBusy(ntp ? "Turning on NTP" : "Turning off NTP");
                await callOnce(TIMEDATE1, { superuser: "try" }, TIMEDATE1_PATH, TIMEDATE1, "SetNTP", [ntp, true]);
                if (!await waitForNtp(props.client, ntp)) {
                    const seconds = Math.round(timeSettings.ntpTimeoutMs / 1000);
                    // The time cannot be set while NTP may still be on.
                    if (manual !== null)
                        throw new Error(`NTP was still on after ${seconds} seconds, so the time was not set.`);
                    warning = `NTP was turned ${ntp ? "on" : "off"}, but timedated had not confirmed it after ${seconds} seconds`;
                }
            }
            if (manual !== null) {
                step = "set the time";
                setBusy("Setting the time");
                const seconds = Number((await run(manualTimeArgv(manual))).trim());
                if (!Number.isInteger(seconds))
                    throw new Error(`the host could not read ${manual} as a time`);
                await callOnce(TIMEDATE1, { superuser: "try" }, TIMEDATE1_PATH, TIMEDATE1, "SetTime",
                               [seconds * 1_000_000, false, true]);
            }
            notify(warning ?? "System time settings changed", warning ? "warning" : "success");
            props.onApplied();
            if (mounted())
                props.onClose();
        } catch (failure) {
            if (!mounted())
                return;
            setBusy(null);
            const hint = props.privileged ? "" : " Administrative access (A) may be needed.";
            setError(`Could not ${step}: ${hostError(failure)}${hint}`);
        }
    };

    if (picking) {
        return (
            <ZonePicker
                zones={zones.value}
                loading={zones.loading}
                error={zones.error ? hostError(zones.error) : null}
                initialQuery={picking.query}
                current={zone}
                hostZone={props.timezone}
                onPick={picked => {
                    setZone(picked);
                    if (!timeEdited)
                        setTime(suggestTime(picked));
                    setFieldErrors(previous => ({ ...previous, zone: undefined }));
                    setPicking(null);
                }}
                onCancel={() => setPicking(null)}
            />
        );
    }

    const move = (step: number) => {
        const at = Math.max(0, enabled.indexOf(current));
        setFocus(enabled[(at + step + enabled.length) % enabled.length] ?? "zone");
    };

    // The focused field, or the first one still enabled if it was switched off.
    const current = enabled.includes(focus) ? focus : enabled[0] ?? "zone";

    const onKey = (input: string, key: Key): boolean => {
        if (busy)
            return true;
        if (key.downArrow || (key.tab && !key.shift)) { move(1); return true }
        if (key.upArrow || (key.tab && key.shift)) { move(-1); return true }
        if (key.return) { void apply(); return true }
        if (current === "zone" && (input === " " || key.rightArrow)) {
            setPicking({ query: "" });
            return true;
        }
        if (current === "zone" && isPlain(input, key)) {
            setPicking({ query: input });
            return true;
        }
        if (current === "ntp" && input === " " && props.canNtp) {
            const next = !ntp;
            setNtp(next);
            if (!next && !timeEdited)
                setTime(suggestTime(zone));
            return true;
        }
        return false;
    };
    const inner = dialogInnerWidth(width);
    const labelWidth = 12;
    const valueWidth = Math.max(4, inner - labelWidth);
    const hints: Hint[] = busy ? [] : [
        [`${glyphs.up}${glyphs.down}`, "field"],
        ...(current === "zone" ? [["space", "choose"] as const] : current === "ntp" ? [["space", "toggle"] as const] : []),
        ["enter", "change"],
        ["esc", "cancel"],
    ];

    // A fixed box, so a long value next to it can never squeeze the label.
    const label = (field: TimeField, text: string) => {
        const focused = current === field && !busy;
        const disabled = !enabled.includes(field);
        return (
            <Box width={labelWidth} flexShrink={0}>
                <Text color={disabled ? colors.dim : focused ? colors.accent : undefined} bold={focused} wrap="truncate">
                    {fit(`${focused ? glyphs.pointer : " "}${text}`, labelWidth)}
                </Text>
            </Box>
        );
    };
    // The zone's own name comes first; the inline hint only where both fit
    // (the footer says "space choose" as well).
    const zoneName = clean(zone) || "(not set)";
    const zoneHint = current === "zone" && !busy && textWidth(zoneName) + ZONE_HINT.length <= valueWidth;
    const note = (text: string | undefined, color: string) => (text
        ? <Box marginLeft={labelWidth}><Text color={color} wrap="truncate">{truncate(text, valueWidth)}</Text></Box>
        : null);
    /*
     * As in PowerDialog: nothing squeezed, and short of room an error from
     * the host gets one line, in place of the dim note under the time.
     */
    const rows = 3 + (fieldErrors.zone ? 1 : 0) + (props.canNtp ? 0 : 1) + (fieldErrors.time || !ntp ? 1 : 0);
    const compact = 3 + (1 + rows) + (error ? 1 + wrap(error, inner).length : 0) + 2 > area.height;
    const timeNote = fieldErrors.time
        ? note(fieldErrors.time, colors.error)
        : ntp || (compact && error) ? null : note("host's local time, in the zone above", colors.dim);

    return (
        <Dialog
            title="Change system time"
            width={width}
            onCancel={busy ? undefined : props.onClose}
            onKey={onKey}
            hints={hints}
        >
            <Box flexDirection="column" marginTop={1} flexShrink={0}>
                <Box>
                    {label("zone", "Time zone")}
                    <Text wrap="truncate">
                        {truncate(zoneName, valueWidth)}
                        {zoneHint ? <Text color={colors.dim}>{ZONE_HINT}</Text> : null}
                    </Text>
                </Box>
                {note(fieldErrors.zone, colors.error)}
                <Box>
                    {label("ntp", "NTP")}
                    <Text color={props.canNtp ? undefined : colors.dim} wrap="truncate">
                        {truncate(`${ntp ? "[x]" : "[ ]"} Synchronize automatically`, valueWidth)}
                    </Text>
                </Box>
                {props.canNtp ? null : note("No NTP service is installed on this host", colors.dim)}
                <Box>
                    {label("time", "Time")}
                    <Box width={valueWidth}>
                        {ntp
                            ? <Text color={colors.dim} wrap="truncate">{truncate("set automatically while NTP is on", valueWidth)}</Text>
                            : <TextInput
                                value={time}
                                onChange={value => {
                                    setTime(value);
                                    setTimeEdited(true);
                                }}
                                onSubmit={() => void apply()}
                                focus={current === "time" && !busy}
                                width={valueWidth}
                                maxLength={19}
                                placeholder="YYYY-MM-DD HH:MM"
                            />}
                    </Box>
                </Box>
                {timeNote}
            </Box>
            {error
                ? (compact
                    ? <Box flexShrink={0}><Text color={colors.error} wrap="truncate">{truncate(error, inner)}</Text></Box>
                    : <Box flexDirection="column" flexShrink={0}><DialogText width={width} color={colors.error}>{error}</DialogText></Box>)
                : null}
            <Box marginTop={1} flexShrink={0}>
                {busy
                    ? <Spinner label={busy} />
                    : <Buttons confirm="Change" />}
            </Box>
        </Dialog>
    );
}

/**
 * Type to filter, ↑↓ to choose, Enter to take it, Esc to go back. Opens on
 * the zone chosen so far (`current`); "(current)" marks the host's own.
 */
function ZonePicker({ zones, loading, error, initialQuery, current, hostZone, onPick, onCancel }: {
    zones: readonly string[] | undefined, loading: boolean, error: string | null, initialQuery: string,
    current: string, hostZone: string, onPick: (zone: string) => void, onCancel: () => void,
}) {
    const area = useArea();
    const width = useDialogWidth(50);
    const inner = dialogInnerWidth(width);
    const [query, setQuery] = useState(initialQuery);
    const matches = filterZones(zones ?? [], query);
    // Title, border, the field, the count line and margins take about 8 rows.
    const rows = Math.max(3, Math.min(12, area.height - 8));
    const nav = useListNav(matches, rows, { active: false, initialKey: query ? null : current });
    const shown = matches.slice(nav.offset, nav.offset + rows);

    return (
        <Dialog
            title="Time zone"
            width={width}
            onCancel={onCancel}
            onKey={(input, key) => nav.handleKey(input, key)}
            hints={[[`${glyphs.up}${glyphs.down}`, "select"], ["enter", "choose"], ["esc", "back"]]}
        >
            <Box marginTop={1}>
                <Text color={colors.dim}>{"Search "}</Text>
                <TextInput
                    value={query}
                    onChange={value => {
                        setQuery(value);
                        nav.select(0);
                    }}
                    onSubmit={() => {
                        if (nav.key)
                            onPick(nav.key);
                    }}
                    width={Math.max(4, inner - 7)}
                    placeholder="city or region"
                />
            </Box>
            <Box flexDirection="column" marginTop={1} height={rows}>
                {loading && !zones
                    ? <Spinner label="Loading time zones" />
                    : error && !zones
                        ? <Text color={colors.error} wrap="truncate">{truncate(`Could not list time zones: ${error}`, inner)}</Text>
                        : matches.length === 0
                            ? <Text color={colors.dim}>No matching time zone</Text>
                            : shown.map((zone, i) => {
                                const selected = nav.offset + i === nav.index;
                                return (
                                    <Text key={zone} inverse={selected} wrap="truncate">
                                        {fit(`${selected ? glyphs.pointer : " "} ${clean(zone)}${zone === hostZone ? "  (current)" : ""}`, inner)}
                                    </Text>
                                );
                            })}
            </Box>
            <Text color={colors.dim} wrap="truncate">
                {zones ? `${matches.length} of ${zones.length} zones` : " "}
            </Text>
        </Dialog>
    );
}
