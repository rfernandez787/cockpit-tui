/*
 * One unit: its state, where it comes from, what it relates to, what can be
 * done to it, and its most recent log entries.
 *
 * The unit is resolved with LoadUnit() -- an alias opens its primary unit --
 * and read with GetAll on the Unit interface plus the type's own (Service,
 * Socket or Timer). It is read again, debounced, when:
 *
 *   - its own PropertiesChanged arrives,
 *   - a job *for this unit* ends (JobRemoved's unit argument; upstream
 *     re-reads on every job of every unit). Failed conditions are visible
 *     only right after a start attempt, before the unit is garbage-collected,
 *   - systemd finished reloading (unit files may have changed).
 *
 * All three subscriptions are client-side on the page's systemd client (see
 * store.ts): opening a hundred units adds nothing on the bridge.
 * MemoryCurrent is never signalled, so it is polled every 30 seconds while
 * the unit runs, as upstream does.
 *
 * Note that LoadUnit/GetAll load a unit systemd had not loaded; it unloads
 * it again shortly (UnitNew, then UnitRemoved). The list copes with that, and
 * nothing here re-reads on UnitNew, which could loop.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text } from "../../tui/ink.js";
import { useKeys } from "../../tui/keyboard.js";
import { useScroll } from "../../tui/components/ScrollView.js";
import { Heading, Notice } from "../../tui/components/misc.js";
import { useNow } from "../../tui/hooks.js";
import { usePrivilege } from "../../tui/privilege.js";
import { useSession } from "../../tui/session-context.js";
import { useNavigation } from "../../tui/navigation.js";
import { errorText, useStatus } from "../../tui/status.js";
import { fit, formatTimestamp, truncate, width as textWidth, wrap } from "../../tui/text.js";
import { colors, glyphs } from "../../tui/theme.js";
import type { JournalEntry } from "../../lib/journal.js";
import {
    ACTIONS, actionInfo, actionLabel, actionProgress, availableActions, isActive, mainExit, nextRun, parseUnitDetails,
    RELATIONSHIPS, startEffect, statusLines, unavailableReason, unitType, unmetConditions, validUsec, lastTrigger,
    type ActionId, type Owner, type StartEffect, type Tone, type UnitDetails, type UnitType,
} from "./model.js";
import { callManager, getAll, MANAGER, PROPERTIES, TIMER, UNIT, type UnitStore } from "./store.js";
import { useUnitLogs, LOG_LINES, type UnitLogs } from "./logs.js";
import { ActionDialog, type ActionRequest } from "./dialogs.js";
import { runningActions } from "./actions.js";
import { clean, describeTime, fitText, formatBytes, sentence } from "./format.js";

const SERVICE = "org.freedesktop.systemd1.Service";
const SOCKET = "org.freedesktop.systemd1.Socket";

const TYPE_INTERFACES: Partial<Record<UnitType, string>> = { service: SERVICE, socket: SOCKET, timer: TIMER };

/** Debounce for re-reading the unit after a signal. */
const REFRESH_MS = 200;
/** MemoryCurrent is not signalled: poll it while the unit runs (upstream's METRICS_POLL_DELAY). */
const MEMORY_POLL_MS = 30_000;

// ---- data ------------------------------------------------------------------------

export interface DetailsState {
    readonly unit: UnitDetails | null;
    readonly path: string | null;
    readonly error: string | null;
    readonly loading: boolean;
}

export function useUnitDetails(store: UnitStore, id: string, options: { refreshMs?: number } = {}): DetailsState & { refresh: () => void } {
    const [state, setState] = useState<DetailsState>({ unit: null, path: null, error: null, loading: true });
    const refreshRef = useRef<() => void>(() => {});
    const refreshMs = options.refreshMs ?? REFRESH_MS;
    const type = unitType(id);
    const typeIface = type ? TYPE_INTERFACES[type] : undefined;

    useEffect(() => {
        let live = true;
        let path: string | null = null;
        let resolvedId = id;
        let timer: NodeJS.Timeout | null = null;
        let fetching = false;
        let again = false;
        const subscriptions: { remove(): void }[] = [];
        setState({ unit: null, path: null, error: null, loading: true });

        const fetch = async () => {
            if (!live || path === null)
                return;
            if (fetching) {
                again = true;
                return;
            }
            fetching = true;
            const at = path;
            try {
                const [unitProps, extra] = await Promise.all([
                    getAll(store.client, at, UNIT),
                    // The type's own interface is extra detail: its absence is not an error.
                    typeIface ? getAll(store.client, at, typeIface).catch(() => null) : Promise.resolve(null),
                ]);
                if (!live)
                    return;
                const unit = parseUnitDetails(unitProps, extra, type);
                if (unit.id)
                    resolvedId = unit.id;
                setState({ unit, path: at, error: null, loading: false });
            } catch (error) {
                if (live)
                    setState(previous => ({ ...previous, error: errorText(error), loading: false }));
            } finally {
                fetching = false;
                if (again && live) {
                    again = false;
                    schedule(0);
                }
            }
        };

        const schedule = (ms = refreshMs) => {
            if (!live || timer)
                return;
            timer = setTimeout(() => {
                timer = null;
                void fetch();
            }, ms);
        };
        refreshRef.current = () => schedule(0);

        subscriptions.push(
            store.onSignal({ interface: MANAGER, member: "JobRemoved" }, (_path, _iface, _member, args) => {
                if (args[2] === resolvedId || args[2] === id)
                    schedule();
            }),
            store.onSignal({ interface: MANAGER, member: "Reloading" }, (_path, _iface, _member, args) => {
                if (args[0] === false)
                    schedule();
            }),
        );

        void (async () => {
            try {
                const [resolved] = await callManager(store.client, "LoadUnit", [id], "s");
                if (!live)
                    return;
                if (typeof resolved !== "string")
                    throw new Error("systemd returned no object path");
                path = resolved;
                subscriptions.push(store.onSignal({ path: resolved, interface: PROPERTIES, member: "PropertiesChanged" },
                                                  () => schedule()));
                await fetch();
            } catch (error) {
                if (live)
                    setState({ unit: null, path: null, error: errorText(error), loading: false });
            }
        })();

        return () => {
            live = false;
            if (timer)
                clearTimeout(timer);
            for (const subscription of subscriptions)
                subscription.remove();
        };
    }, [store, id, refreshMs, type, typeIface]);

    // MemoryCurrent: never signalled, so polled while the unit runs.
    const pollMemory = !!state.path && !!state.unit && isActive(state.unit.activeState) &&
        (type === "service" || type === "socket");
    useEffect(() => {
        if (!pollMemory || !state.path || !typeIface)
            return;
        const path = state.path;
        let live = true;
        const timer = setInterval(() => {
            Promise.resolve(store.client.call(path, PROPERTIES, "Get", [typeIface, "MemoryCurrent"], { type: "ss" }))
                .then(([value]) => {
                    const bytes = (value as { v?: unknown } | undefined)?.v;
                    if (!live)
                        return;
                    setState(previous => (previous.unit
                        ? { ...previous, unit: { ...previous.unit, memory: validUsec(bytes) ? bytes : null } }
                        : previous));
                }, () => { /* the next full read will tell */ });
        }, MEMORY_POLL_MS);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [store, pollMemory, state.path, typeIface]);

    return { ...state, refresh: () => refreshRef.current() };
}

// ---- lines -----------------------------------------------------------------------

export interface Segment {
    readonly text: string;
    readonly color?: string | undefined;
    readonly bold?: boolean;
}

export type Line = readonly Segment[];

function toneColor(tone: Tone): string | undefined {
    switch (tone) {
    case "ok": return colors.ok;
    case "error": return colors.error;
    case "warning": return colors.warning;
    case "dim": return colors.dim;
    case "accent": return colors.accent;
    default: return undefined;
    }
}

function statusGlyph(kind: string): string {
    switch (kind) {
    case "running":
    case "enabled": return glyphs.bullet;
    case "failed": return glyphs.cross;
    case "readonly":
    case "masked": return glyphs.warning;
    default: return glyphs.hollow;
    }
}

export interface DetailInput {
    readonly unit: UnitDetails;
    /** The name the details were opened with (may be an alias). */
    readonly requestedId: string;
    readonly width: number;
    readonly now: number;
    /** Name the time zone after times (remote sessions). */
    readonly zone: boolean;
    readonly readOnly: boolean;
    readonly readOnlyHint: string;
    readonly actions: readonly ActionId[];
    readonly showRelationships: boolean;
    readonly monotonicBase: number | null;
    /** An action running in the background, if any. */
    readonly pending?: string | null;
    /** Why what is shown may be out of date (a refresh failed); raw host text. */
    readonly stale?: string | null;
}

const LABEL_WIDTH = 14;

/**
 * Wrap a status detail ("failed (Result: exit-code) since 2026-10-02
 * 18:45:43 (1 hour ago)") between its phrases -- before "since" and before
 * a parenthesis -- so a time and its "(1 hour ago)" stay whole; a phrase too
 * long for a line is word-wrapped.
 */
export function wrapPhrases(text: string, width: number): string[] {
    const lines: string[] = [];
    let line = "";
    for (const phrase of text.split(/ (?=since )| (?=\()/)) {
        const joined = line ? `${line} ${phrase}` : phrase;
        if (textWidth(joined) <= width) {
            line = joined;
            continue;
        }
        if (line)
            lines.push(line);
        const wrapped = textWidth(phrase) <= width ? [phrase] : wrap(phrase, width);
        lines.push(...wrapped.slice(0, -1));
        line = wrapped.at(-1) ?? "";
    }
    if (line)
        lines.push(line);
    return lines;
}

/**
 * The details as lines of styled segments, wrapped to `width`: what the
 * scrolling body shows. Every host string is cleaned here.
 */
export function detailLines(input: DetailInput): Line[] {
    const { unit, width, now } = input;
    const lines: Line[] = [];
    const labelWidth = Math.min(LABEL_WIDTH, Math.max(8, Math.floor(width / 4)));
    const valueWidth = Math.max(8, width - labelWidth);
    // A label column always ends in a space, even when a long label is cut.
    const labelText = (label: string) => fit(label, labelWidth - 1) + " ";

    const field = (label: string, value: string, color?: string) => {
        const wrapped = wrap(clean(value), valueWidth);
        wrapped.forEach((text, i) => {
            lines.push([{ text: labelText(i === 0 ? label : ""), color: colors.dim }, { text, color }]);
        });
    };
    const list = (label: string, values: readonly string[], color?: string) => {
        if (values.length)
            field(label, values.join(", "), color);
    };

    if (input.stale) {
        for (const text of wrap(clean(input.stale), Math.max(1, width - 2)))
            lines.push([{ text: `${lines.length === 0 ? glyphs.warning : " "} ${text}`, color: colors.warning }]);
    }

    // A unit that failed to load: upstream shows only the error. A unit that
    // does not exist has no state worth listing either; one with a bad
    // setting still has its file states and its path, which help to fix it.
    const notFound = unit.loadState === "not-found";
    if (unit.loadState !== "loaded" && unit.loadState !== "masked") {
        const reason = unit.loadError?.[1] || "Failed to load unit";
        wrap(clean(reason), Math.max(1, valueWidth - 2)).forEach((text, i) => {
            lines.push([
                { text: labelText(i === 0 ? "Error" : ""), color: colors.dim },
                { text: `${i === 0 ? glyphs.cross : " "} ${text}`, color: colors.error, bold: true },
            ]);
        });
        if (unit.loadState)
            field("", `Load state: ${unit.loadState}`, colors.dim);
    }

    const status = notFound ? [] : statusLines(unit, {
        readOnly: input.readOnly,
        readOnlyHint: input.readOnlyHint,
        since: usec => describeTime(usec / 1000, now, { zone: input.zone }),
    });
    // "● Running  active (running) since <when>": the detail follows the
    // state, and wraps under itself rather than losing its end (the "12
    // days ago") on a narrow screen. With too little room beside the state
    // for a timestamp, it goes on lines of its own.
    status.forEach((line, i) => {
        const color = toneColor(line.tone);
        const head = `${statusGlyph(line.kind)} ${line.text}`;
        const headSegment = { text: head, color: color === colors.dim ? undefined : color, bold: line.kind !== "readonly" && line.kind !== "static" };
        const label = { text: labelText(i === 0 ? "Status" : ""), color: colors.dim };
        const blank = { text: fit("", labelWidth) };
        const detail = line.detail ? clean(line.detail) : "";
        const room = valueWidth - textWidth(head) - 2;
        if (!detail) {
            lines.push([label, headSegment]);
        } else if (room >= 24) {
            wrapPhrases(detail, room).forEach((text, j) => {
                lines.push(j === 0
                    ? [label, headSegment, { text: "  " + text, color: colors.dim }]
                    : [blank, { text: " ".repeat(textWidth(head) + 2) + text, color: colors.dim }]);
            });
        } else {
            lines.push([label, headSegment]);
            for (const text of wrapPhrases(detail, Math.max(1, valueWidth - 2)))
                lines.push([blank, { text: "  " + text, color: colors.dim }]);
        }
    });
    if (unit.jobId)
        field("Job", `#${unit.jobId} in progress`, colors.warning);
    if (input.pending)
        field("Action", input.pending, colors.warning);

    if (unit.fragmentPath)
        field("Path", unit.fragmentPath);
    else if (unit.sourcePath)
        field("Source", unit.sourcePath);
    for (const [i, dropIn] of unit.dropInPaths.entries())
        field(i === 0 ? "Drop-ins" : "", dropIn);
    const aliases = unit.names.filter(name => name !== unit.id);
    list("Aliases", aliases, colors.dim);
    if (input.requestedId !== unit.id && unit.id)
        field("Opened as", `${input.requestedId} (an alias of ${unit.id})`, colors.dim);

    if (unit.mainPid)
        field("Main PID", String(unit.mainPid));
    const exit = mainExit(unit);
    if (exit && unit.activeState !== "active")
        field("Main exit", exit, unit.activeState === "failed" ? colors.error : undefined);
    if (unit.restarts > 0)
        field("Restarts", String(unit.restarts));
    if (unit.memory !== null)
        field("Memory", formatBytes(unit.memory));
    for (const [i, [kind, address]] of unit.listen.entries())
        field(i === 0 ? "Listen" : "", `${address} (${kind})`);

    if (unit.timer) {
        const next = nextRun(unit.timer, input.monotonicBase);
        const last = lastTrigger(unit.timer);
        // No next elapse: stopped, or elapsing right now (both read 0 or UINT64_MAX).
        field("Next run", next !== null ? describeTime(next, now, { zone: input.zone }) : "not scheduled");
        field("Last trigger", last !== null ? describeTime(last, now, { zone: input.zone }) : "never");
        for (const [i, spec] of unit.timer.schedule.entries())
            field(i === 0 ? "Schedule" : "", spec);
        // Its Unit= is normally also its Triggers=, listed below.
        if (unit.timer.unit && !unit.triggers.includes(unit.timer.unit))
            field("Activates", unit.timer.unit);
    }

    for (const [i, condition] of unmetConditions(unit).entries())
        field(i === 0 ? "Condition" : "", condition, colors.error);
    list("Triggers", unit.triggers);
    list("Triggered by", unit.triggeredBy);

    // What can be done, with the keys that do it.
    if (input.readOnly) {
        field("Actions", "none without administrative access", colors.dim);
    } else if (input.actions.length === 0) {
        field("Actions", notFound ? "none for a unit that does not exist" : "none for a unit in this state", colors.dim);
    } else {
        const segments: Segment[] = [{ text: labelText("Actions"), color: colors.dim }];
        const running = isActive(unit.activeState);
        let used = 0;
        for (const id of input.actions) {
            const key = actionInfo(id).key;
            const label = actionLabel(id, running);
            const itemWidth = textWidth(key) + 1 + textWidth(label);
            if (used > 0 && used + 2 + itemWidth > valueWidth) {
                lines.push(segments.splice(0));
                segments.push({ text: fit("", labelWidth) });
                used = 0;
            }
            segments.push({ text: (used ? "  " : "") + key, color: colors.accent, bold: true });
            segments.push({ text: " " + label });
            used += (used ? 2 : 0) + itemWidth;
        }
        lines.push(segments);
    }

    // Relationships: upstream's 18 lists, folded away until asked for.
    const relationships = RELATIONSHIPS.filter(([property]) => (unit.relationships.get(property)?.length ?? 0) > 0);
    if (relationships.length) {
        lines.push([]);
        if (!input.showRelationships) {
            lines.push([
                { text: labelText("Relationships"), color: colors.dim },
                { text: `${relationships.length} kind${relationships.length === 1 ? "" : "s"} (` },
                { text: "g", color: colors.accent, bold: true },
                { text: " to show)" },
            ]);
        } else {
            const relLabel = Math.min(Math.max(...relationships.map(([, label]) => textWidth(label))) + 2, Math.floor(width / 2));
            const relValue = Math.max(8, width - relLabel);
            for (const [property, label] of relationships) {
                const units = unit.relationships.get(property) ?? [];
                wrap(clean(units.join(", ")), relValue).forEach((text, i) => {
                    lines.push([{ text: fit(i === 0 ? label : "", relLabel), color: colors.dim }, { text }]);
                });
            }
        }
    }
    return lines;
}

/** One journal line: time, identifier, message; errors stand out. */
export function logLine(entry: JournalEntry, width: number, now: number): Line {
    const today = new Date(now).toDateString() === new Date(entry.time).toDateString();
    const stamp = formatTimestamp(entry.time);
    const time = width >= 100 || !today ? stamp : stamp.slice(11);
    const priority = entry.priority;
    const color = priority !== null && priority <= 3 ? colors.error : priority === 4 ? colors.warning : undefined;
    const marker = priority !== null && priority <= 4 ? glyphs.warning : " ";
    const ident = entry.identifier ? clean(entry.identifier) + ": " : "";
    const first = clean(entry.message.split("\n")[0] ?? "") + (entry.message.includes("\n") ? ` ${glyphs.ellipsis}` : "");
    return [
        { text: marker + " ", color },
        { text: time + " ", color: colors.dim },
        { text: truncate(ident + first, Math.max(0, width - textWidth(time) - 3)), color },
    ];
}

function LineView({ line, width }: { line: Line, width: number }) {
    let used = 0;
    return (
        <Text wrap="truncate">
            {line.map((segment, i) => {
                const room = Math.max(0, width - used);
                const text = truncate(segment.text, room);
                used += textWidth(text);
                return <Text key={i} color={segment.color} bold={segment.bold}>{text}</Text>;
            })}
            {used < width ? " ".repeat(width - used) : ""}
        </Text>
    );
}

// ---- the view ----------------------------------------------------------------------

export interface DetailsViewProps {
    readonly store: UnitStore;
    readonly owner: Owner;
    readonly id: string;
    readonly width: number;
    readonly height: number;
    readonly showRelationships: boolean;
    readonly onToggleRelationships: () => void;
    readonly onBack: () => void;
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Unit-file changes take effect through a daemon-reload, which every file action ends with. */
const RELOADS = "This also reloads systemd's configuration (daemon-reload).";

/** What starting one of the special targets does, said after the question: "This restarts web1." */
function effectText(effect: StartEffect, host: string, lead: string): string {
    switch (effect) {
    case "restart": return `${lead} restarts ${host}.`;
    case "poweroff": return `${lead} shuts down ${host}.`;
    case "halt": return `${lead} halts ${host}.`;
    case "exit": return `${lead} stops all of your user units and ends your user service manager, which can end your desktop session.`;
    }
}

/** For the shell, once such a start has been asked for: the connection dropping is then the expected outcome. */
function disconnectText(effect: StartEffect, host: string): string | null {
    switch (effect) {
    case "restart": return `${host} is restarting.`;
    case "poweroff":
    case "halt": return `${host} is shutting down.`;
    default: return null; // the user's own manager: the connection stays
    }
}

/**
 * An action on this unit, with the words for it: the dialog title, the
 * progress line, and exactly what will happen, asked before anything is
 * done. It acts on the unit's primary name (upstream: Names[0]), so an alias
 * opened from the list acts on the unit it points to. Starting one of the
 * targets that take the machine (or the user's manager) down says so, and
 * tells the shell to expect the connection to drop.
 */
export function actionRequest(action: ActionId, unit: UnitDetails, dependents: readonly string[],
                              options: { owner?: Owner, host?: string } = {}): ActionRequest {
    const name = unit.names[0] || unit.id;
    const host = options.host || "this machine";
    const running = isActive(unit.activeState);
    const starts = action === "start" || (action === "enable" && !running);
    const effect = starts ? startEffect(options.owner ?? "system", unit.names.length ? unit.names : [unit.id]) : null;
    const target = {
        name, activeState: unit.activeState, unitFileState: unit.unitFileState,
        disconnect: effect ? disconnectText(effect, host) : null,
    };
    const label = capitalized(actionLabel(action, running));
    const base = {
        action, target, title: `${label} ${name}`, progress: `${actionProgress(action, running)} ${name}`, confirmLabel: label,
        dependents: null, after: "", danger: effect !== null,
    };
    const stops = (verb: string) => (dependents.length ? { verb, names: dependents } : null);
    switch (action) {
    case "start":
        return { ...base, question: `Start ${name} now?${effect ? " " + effectText(effect, host, "This") : ""}` };
    case "stop":
        return { ...base, question: `Stop ${name} now?`, dependents: stops("stopped"), danger: true };
    case "restart":
        return { ...base, question: `Restart ${name} now? It is stopped and started again.`, dependents: stops("restarted") };
    case "reload":
        return { ...base, question: `Reload ${name} now? It reloads its configuration and keeps running.` };
    case "enable":
        return {
            ...base,
            question: running
                ? `Enable ${name}? From now on it starts automatically.`
                : `Enable and start ${name}? ${effect ? effectText(effect, host, "Starting it") : "It starts now, and from now on automatically."}`,
            after: RELOADS,
        };
    case "disable":
        return running
            ? {
                ...base, question: `Stop and disable ${name}? It is stopped now, and no longer starts automatically.`,
                dependents: stops("stopped"), after: RELOADS, danger: true,
            }
            : { ...base, question: `Disable ${name}? It will no longer start automatically.`, after: RELOADS, danger: true };
    case "mask":
        return {
            ...base,
            // Upstream's warning (service-details.jsx:171-186).
            question: `Mask ${name}? Masking service prevents all dependent units from running. ` +
                      "This can have bigger impact than anticipated. Please confirm that you want to mask this unit." +
                      (unit.activeState === "failed" ? " Its failed state is cleared as well." : ""),
            after: RELOADS,
            danger: true,
        };
    case "unmask":
        return { ...base, question: `Unmask ${name}? It can be started again.`, after: RELOADS };
    case "reset":
        return { ...base, question: `Clear the failed state of ${name}? It shows as not running, and the record of its failure is reset.` };
    }
}

export function DetailsView({ store, owner, id, width, height, showRelationships, onToggleRelationships, onBack }: DetailsViewProps) {
    useSyncExternalStore(store.subscribe, store.getVersion);
    useSyncExternalStore(runningActions.subscribe, runningActions.version);
    const details = useUnitDetails(store, id);
    // A monotonic timer (OnBootSec=, OnUnitInactiveSec=) has a next run only
    // as a monotonic time: the host's clocks date it.
    useEffect(() => {
        if (unitType(id) === "timer")
            store.wantClocks();
    }, [store, id]);
    const privilege = usePrivilege();
    const { session, hostname } = useSession();
    const navigation = useNavigation();
    const { notify } = useStatus();
    const now = useNow(10_000);
    const [request, setRequest] = useState<ActionRequest | null>(null);
    const unit = details.unit;
    const resolvedId = unit?.id || null;
    // Actions name the unit by its primary name (Names[0]), and so does the registry of running ones.
    const primaryName = unit ? unit.names[0] || unit.id : null;
    const pending = primaryName ? runningActions.get(owner, primaryName) : undefined;
    const logs = useUnitLogs(resolvedId ? { name: resolvedId, user: owner === "user" } : null, hostname);

    // System units need administrative access; the user's own units never do.
    const canAct = owner === "user" || privilege.allowed === true;
    const readOnlyHint = privilege.configured
        ? "Requires administrative access to edit (press A)"
        : "Requires administrative access to edit";
    const actions = unit ? availableActions(unit) : [];
    const running = unit ? isActive(unit.activeState) : false;

    // Units that a stop or restart takes along: Requires=, BindsTo= and PartOf= point back here.
    const dependents = useMemo(() => {
        if (!unit)
            return [];
        const names = new Set([
            ...unit.relationships.get("RequiredBy") ?? [],
            ...unit.relationships.get("BoundBy") ?? [],
            ...unit.relationships.get("ConsistsOf") ?? [],
        ]);
        // Only the running ones are affected; units the list does not track may be.
        return [...names].filter(name => {
            const path = store.pathById.get(name);
            const known = path ? store.units.get(path) : undefined;
            return !known || isActive(known.activeState);
        }).sort();
    }, [unit, store, store.version]);

    const zone = !!session && session.mode !== "local";
    const bodyWidth = Math.max(10, width);
    const pendingText = pending && primaryName ? `${pending.progress} ${primaryName}${glyphs.ellipsis}` : null;
    // Why the unit could not be read (again): a closed channel, or a failed GetAll.
    const failure = store.fatal ? store.error : details.error;

    const lines = useMemo(() => (unit
        ? detailLines({
            unit, requestedId: id, width: bodyWidth - 2, now, zone,
            readOnly: !canAct, readOnlyHint, actions, showRelationships,
            monotonicBase: store.monotonicBase, pending: pendingText,
            stale: failure ? `Not up to date: ${failure}` : null,
        })
        : []), [unit, id, bodyWidth, now, zone, canAct, readOnlyHint, actions.join(), showRelationships,
                store.monotonicBase, pendingText, failure]);

    const canEscalate = privilege.allowed === false && privilege.configured === true;
    const logLines = logPanelLines(logs, width, now, canEscalate);

    // Height: the heading, the body sized to its lines, a blank line, then
    // the logs. A long body scrolls and leaves the logs about 40%; while the
    // journal is still being read the logs keep room for a full panel, so
    // the body does not jump about. Below 9 lines there is room for the body
    // only (the logs are a key away: l).
    const available = Math.max(1, height - 1);
    let bodyHeight = available;
    let logsHeight = 0;
    if (available >= 9) {
        const logsWanted = 1 + (logs.loading && logs.entries.length === 0 ? LOG_LINES : Math.max(1, logLines.length));
        const logsMin = Math.min(logsWanted, Math.max(3, Math.floor(available * 0.4)));
        bodyHeight = Math.max(1, Math.min(lines.length, available - logsMin - 1));
        logsHeight = Math.min(logsWanted, available - bodyHeight - 1);
    }
    const scroll = useScroll(lines.length, bodyHeight);

    const act = (action: ActionId) => {
        if (!unit || !primaryName)
            return;
        const label = actionLabel(action, running);
        const name = clean(primaryName);
        if (!canAct) {
            notify(`To ${label} ${name}, turn on administrative access${privilege.configured ? " (press A)" : ""}`, "warning");
            return;
        }
        if (pending) {
            notify(`${pending.progress} ${name} is still running`, "warning");
            return;
        }
        if (!actions.includes(action)) {
            notify(`Cannot ${label} ${name}: ${clean(unavailableReason(action, unit))}`, "warning");
            return;
        }
        setRequest(actionRequest(action, unit, dependents, { owner, host: hostname }));
    };

    const actionHints = canAct && unit && !pending
        ? actions.slice(0, 3).map(a => [actionInfo(a).key, actionLabel(a, running)] as const)
        : [];

    useKeys((input, key) => {
        if (key.escape || key.backspace) {
            onBack();
            return true;
        }
        if (scroll.handleKey(input, key))
            return true;
        if (input === "j" || input === "k") {
            scroll.handleKey("", { ...key, downArrow: input === "j", upArrow: input === "k" });
            return true;
        }
        if (key.ctrl && input === "r") {
            details.refresh();
            return true;
        }
        if (key.ctrl || key.meta)
            return false;
        if (input === "l") {
            if (resolvedId)
                navigation.go("logs", { unit: { name: resolvedId, user: owner === "user" }, priority: "debug" });
            return true;
        }
        if (input === "g") {
            onToggleRelationships();
            return true;
        }
        const action = ACTIONS.find(a => a.key === input);
        if (action) {
            act(action.id);
            return true;
        }
        return false;
    }, {
        active: request === null,
        // l works once the unit is known (its logs are by its name).
        hints: [["esc", "back"], ...actionHints, ...(resolvedId ? [["l", "logs"] as const] : [])],
    });

    const title = clean(unit?.id || id);
    const heading = (
        <Box width={width} height={1}>
            <Box flexGrow={1}>
                <Heading title={title} width={Math.max(1, width - 8)}
                         detail={unit && unit.description !== unit.id ? clean(unit.description) : undefined} />
            </Box>
            <Text color={colors.dim}>{fit(owner === "user" ? "user" : "system", 7, "right")}</Text>
        </Box>
    );

    if (failure && !unit) {
        // A closed systemd channel says why itself ("Connecting to systemd failed: ...").
        const text = store.fatal ? clean(failure) : `Loading ${clean(id)} failed: ${clean(failure)}`;
        // Notice: padding of 2 on each side and a blank line above; it does not clip.
        return (
            <Box flexDirection="column" width={width} height={height}>
                {heading}
                <Notice width={width} height={height - 1} color={colors.error}>
                    {fitText(sentence(text), width - 4, height - 2, "Press Esc to go back.")}
                </Notice>
            </Box>
        );
    }
    if (!unit) {
        return (
            <Box flexDirection="column" width={width} height={height}>
                {heading}
                <Notice width={width} height={height - 1} loading>{`Loading ${clean(id)}`}</Notice>
            </Box>
        );
    }

    const shown = lines.slice(scroll.top, scroll.top + bodyHeight);
    const more = scroll.max > 0;
    const lineWidth = more ? width - 2 : width;

    return (
        <Box flexDirection="column" width={width} height={height}>
            {heading}
            <Box flexDirection="row" width={width} height={bodyHeight}>
                <Box flexDirection="column" width={lineWidth} height={bodyHeight}>
                    {shown.map((line, i) => <LineView key={scroll.top + i} line={line} width={lineWidth} />)}
                </Box>
                {more && (
                    <Box flexDirection="column" width={2} height={bodyHeight} alignItems="flex-end">
                        <Text color={colors.dim}>{scroll.top > 0 ? glyphs.up : " "}</Text>
                        <Box flexGrow={1} />
                        <Text color={colors.dim}>{scroll.top < scroll.max ? glyphs.down : " "}</Text>
                    </Box>
                )}
            </Box>
            {logsHeight > 0 && (
                <Box flexDirection="column" width={width} height={logsHeight} marginTop={1}>
                    <Heading title="Recent logs" detail={logs.notice ? clean(logs.notice) : "l: view all logs"} width={width} />
                    {logLines.slice(0, logsHeight - 1).map((line, i) => <LineView key={i} line={line} width={width} />)}
                </Box>
            )}
            {request && <ActionDialog owner={owner} request={request} onClose={() => setRequest(null)} />}
        </Box>
    );
}

/**
 * The log panel's lines: why there are none, or the entries newest first
 * with a marker where a reboot lies between two of them. A read error comes
 * first, so it stays visible above whatever had been shown.
 */
export function logPanelLines(logs: UnitLogs, width: number, now: number, canEscalate: boolean): Line[] {
    const out: Line[] = [];
    if (logs.error) {
        const hint = canEscalate ? " Administrative access may show more (press A)." : "";
        for (const text of wrap(clean(logs.error) + hint, Math.max(1, width)))
            out.push([{ text, color: colors.error }]);
    }
    if (logs.entries.length === 0) {
        if (!logs.error)
            out.push([{ text: logs.loading ? `Reading the journal${glyphs.ellipsis}` : "No log entries", color: colors.dim }]);
        return out;
    }
    logs.entries.forEach((entry, i) => {
        const older = logs.entries[i + 1];
        out.push(logLine(entry, width, now));
        if (older && older.bootId && entry.bootId && older.bootId !== entry.bootId)
            out.push([{ text: "-- Reboot --", color: colors.dim }]);
    });
    return out;
}
