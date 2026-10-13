/*
 * The Services page's data model: pure functions, no I/O.
 *
 * The unit list is upstream's (pkg/systemd/services.jsx, cockpit 356):
 * ListUnits() says what systemd has loaded, ListUnitFiles() adds the inert
 * unit files nothing has loaded, and the two are merged per unit type with
 * upstream's exact rules -- loaded rows win, templates and "not-found" units
 * are hidden, aliases appear only as unit files, and template instances have
 * no unit file of their own (so no file state).
 *
 * Filters match by *label*, as upstream's do: "enabled-runtime" counts as
 * "Enabled" and "activating" as "Running", and a unit whose state has no
 * label (an alias has no run state, a template instance no file state)
 * passes every state filter. "Failed only" is ours and strict: it shows
 * exactly the rows drawn as failed.
 *
 * Everything here works on raw host strings. Lookups go through Maps, never
 * plain objects, so a hostile state name such as "constructor" cannot reach
 * Object.prototype; text for the screen still has to pass through clean().
 */

export type Owner = "system" | "user";

export const UNIT_TYPES = ["service", "target", "socket", "timer", "path"] as const;
export type UnitType = typeof UNIT_TYPES[number];

export const TYPE_LABELS: Readonly<Record<UnitType, string>> = {
    service: "Services",
    target: "Targets",
    socket: "Sockets",
    timer: "Timers",
    path: "Paths",
};

// ---- names and object paths -----------------------------------------------------

/** The unit type of an id ("sshd.service" -> "service"), if the page shows that type. */
export function unitType(id: string): UnitType | null {
    const dot = id.lastIndexOf(".");
    if (dot < 0)
        return null;
    const suffix = id.slice(dot + 1);
    return (UNIT_TYPES as readonly string[]).includes(suffix) ? suffix as UnitType : null;
}

/**
 * A template ("getty@.service") rather than a unit: `@` right before the type
 * suffix, or at the very end. Upstream's isTemplate (services.jsx:429-433).
 */
export function isTemplate(id: string): boolean {
    const at = id.indexOf("@");
    const dot = id.lastIndexOf(".");
    return at !== -1 && (at + 1 === dot || at + 1 === id.length);
}

export const UNIT_PATH_PREFIX = "/org/freedesktop/systemd1/unit/";

/**
 * Whether a unit object path belongs to a type the page shows. Object paths
 * escape every byte that is not alphanumeric as _xx, so ".service" appears
 * as "_2eservice".
 */
export function pathIsHandled(path: string): boolean {
    return /_2e(service|target|socket|timer|path)$/.test(path);
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

/** Undo sd_bus_path_encode() for one path label: "_2d" -> "-", a lone "_" is "". */
export function unescapePathLabel(label: string): string {
    if (label === "_")
        return "";
    const bytes: number[] = [];
    const encoder = new TextEncoder();
    for (let i = 0; i < label.length; i++) {
        const hex = label.slice(i + 1, i + 3);
        if (label[i] === "_" && /^[0-9a-fA-F]{2}$/.test(hex)) {
            bytes.push(parseInt(hex, 16));
            i += 2;
        } else {
            bytes.push(...encoder.encode(label[i]!));
        }
    }
    return utf8.decode(Uint8Array.from(bytes));
}

/** The unit id behind a unit object path, or null if it is not one. */
export function idFromPath(path: string): string | null {
    if (!path.startsWith(UNIT_PATH_PREFIX))
        return null;
    const label = path.slice(UNIT_PATH_PREFIX.length);
    if (!label || label.includes("/"))
        return null;
    return unescapePathLabel(label);
}

/**
 * A ListUnitsByPatterns() pattern matching exactly this name. systemd uses
 * fnmatch() with FNM_NOESCAPE, so backslashes are literal and the only way to
 * match a literal "*", "?" or "[" is a bracket expression.
 */
export function exactPattern(id: string): string {
    return id.replace(/[*?[]/g, c => `[${c}]`);
}

// ---- labels ----------------------------------------------------------------------

/* Upstream's label maps (services.jsx:202-243). */
const ACTIVE_LABELS = new Map<string, string>([
    ["active", "Running"],
    ["reloading", "Reloading"],
    ["inactive", "Not running"],
    ["failed", "Failed to start"],
    ["activating", "Running"],
    ["deactivating", "Not running"],
    ["maintenance", "Maintenance"],
]);

const LOAD_LABELS = new Map<string, string>([
    ["stub", "Stub"],
    ["loaded", ""],
    ["not-found", "Not found"],
    ["bad-setting", "Bad setting"],
    ["error", "Error"],
    ["merged", "Merged"],
    ["masked", ""], // shown through the file state instead
]);

const FILE_LABELS = new Map<string, string>([
    ["enabled", "Enabled"],
    ["enabled-runtime", "Enabled"],
    ["disabled", "Disabled"],
    ["linked", "Linked"],
    ["linked-runtime", "Linked"],
    ["alias", "Alias"],
    ["masked", "Masked"],
    ["masked-runtime", "Masked"],
    ["static", "Static"],
    ["invalid", "Invalid"],
    ["indirect", "Indirect"],
    ["generated", "Generated"],
    ["transient", "Transient"],
    ["bad", "Bad"],
]);

export function activeLabel(state: string | undefined): string | undefined {
    return state === undefined ? undefined : ACTIVE_LABELS.get(state);
}

export function fileLabel(state: string | undefined): string | undefined {
    return state === undefined ? undefined : FILE_LABELS.get(state);
}

function loadProblem(loadState: string | undefined): boolean {
    return !!loadState && loadState !== "loaded" && loadState !== "masked";
}

/** Upstream's HasFailed: failed to start, or failed to load. */
export function hasFailed(activeState: string | undefined, loadState: string | undefined): boolean {
    return activeState === "failed" || loadProblem(loadState);
}

/** Upstream's CombinedState: "Running", or "Not running (Bad setting)". Empty for aliases. */
export function combinedState(activeState: string | undefined, loadState: string | undefined): string {
    if (activeState === undefined)
        return "";
    let text = activeLabel(activeState) ?? activeState;
    if (loadProblem(loadState))
        text += ` (${LOAD_LABELS.get(loadState!) || loadState})`;
    return text;
}

// ---- the list --------------------------------------------------------------------

/** A unit systemd has loaded: one ListUnits() row, kept current by signals. */
export interface LoadedUnit {
    id: string;
    description: string;
    loadState: string;
    activeState: string;
    subState: string;
    path: string;
}

/** One ListUnitFiles() row. */
export interface UnitFile {
    readonly id: string;
    readonly state: string;
}

/** A timer's schedule state, from the Timer interface. Times in microseconds; null is unknown. */
export interface TimerInfo {
    lastTrigger: number | null;
    nextRealtime: number | null;
    nextMonotonic: number | null;
}

export interface UnitRow {
    readonly id: string;
    /** Only loaded units have one. */
    readonly description: string;
    readonly loaded: boolean;
    /** Undefined for aliases: an alias has no run state of its own. */
    readonly activeState: string | undefined;
    readonly subState: string | undefined;
    readonly loadState: string | undefined;
    /** Undefined for template instances, which have no unit file of their own. */
    readonly fileState: string | undefined;
    readonly hasFailed: boolean;
    readonly combinedState: string;
    /** The file state's label ("Enabled"), or the raw state if it has none. */
    readonly startup: string;
    /** Timers only, in milliseconds. */
    readonly nextRun?: number | null;
    readonly lastTrigger?: number | null;
}

export interface StateFilter {
    /** Only rows drawn as failed (strict; not upstream's label semantics). */
    readonly failedOnly: boolean;
    /** Active-state labels to show; empty shows all. */
    readonly active: readonly string[];
    /** File-state labels to show; empty shows all. */
    readonly file: readonly string[];
}

export const NO_FILTER: StateFilter = { failedOnly: false, active: [], file: [] };

export function filterIsEmpty(filter: StateFilter): boolean {
    return !filter.failedOnly && filter.active.length === 0 && filter.file.length === 0;
}

/** Valid 64-bit microsecond values: 0 means unset, UINT64_MAX (2**64 once in JS) means never. */
export function validUsec(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 2 ** 64;
}

/**
 * When a timer runs next, in milliseconds. Calendar timers report realtime;
 * monotonic ones (OnBootSec=, OnUnitInactiveSec=) report CLOCK_MONOTONIC,
 * which needs the host's realtime - monotonic offset to become a date. With
 * both kinds the timer fires at whichever comes first.
 */
export function nextRun(info: TimerInfo, monotonicBase: number | null): number | null {
    const candidates: number[] = [];
    if (validUsec(info.nextRealtime))
        candidates.push(info.nextRealtime);
    if (validUsec(info.nextMonotonic) && monotonicBase !== null)
        candidates.push(info.nextMonotonic + monotonicBase);
    return candidates.length ? Math.min(...candidates) / 1000 : null;
}

export function lastTrigger(info: TimerInfo): number | null {
    return validUsec(info.lastTrigger) ? info.lastTrigger / 1000 : null;
}

export interface RowsInput {
    readonly units: Iterable<LoadedUnit>;
    readonly files: ReadonlyMap<string, UnitFile> | null;
    readonly type: UnitType;
    readonly text?: string;
    readonly filter?: StateFilter;
    /** Timer info by object path (Timers tab). */
    readonly timers?: ReadonlyMap<string, TimerInfo>;
    readonly monotonicBase?: number | null;
}

/**
 * The rows of one tab, filtered and sorted: upstream's computeSelectedUnits
 * (services.jsx:604-653). Loaded units come first so they win over their own
 * unit file; failed rows sort to the top, then by name.
 */
export function buildRows(input: RowsInput): UnitRow[] {
    const suffix = "." + input.type;
    const needle = (input.text ?? "").trim().toLowerCase();
    const filter = input.filter ?? NO_FILTER;
    const files = input.files ?? new Map<string, UnitFile>();
    const seen = new Set<string>();
    const rows: UnitRow[] = [];

    const consider = (row: UnitRow) => {
        if (!row.id.endsWith(suffix) || seen.has(row.id))
            return;
        seen.add(row.id);
        if (needle && !row.id.toLowerCase().includes(needle) && !row.description.toLowerCase().includes(needle))
            return;
        if (filter.failedOnly && !row.hasFailed)
            return;
        const file = fileLabel(row.fileState);
        if (filter.file.length && file && !filter.file.includes(file))
            return;
        const active = activeLabel(row.activeState);
        if (filter.active.length && active && !filter.active.includes(active))
            return;
        rows.push(row);
    };

    for (const unit of input.units) {
        if (unit.loadState === "not-found")
            continue;
        const fileState = files.get(unit.id)?.state;
        let timer: Pick<UnitRow, "nextRun" | "lastTrigger"> = {};
        if (input.type === "timer") {
            const info = input.timers?.get(unit.path);
            timer = info
                ? { nextRun: nextRun(info, input.monotonicBase ?? null), lastTrigger: lastTrigger(info) }
                : {};
        }
        consider({
            id: unit.id,
            description: unit.description,
            loaded: true,
            activeState: unit.activeState,
            subState: unit.subState,
            loadState: unit.loadState,
            fileState,
            hasFailed: hasFailed(unit.activeState, unit.loadState),
            combinedState: combinedState(unit.activeState, unit.loadState),
            startup: fileLabel(fileState) ?? fileState ?? "",
            ...timer,
        });
    }

    for (const file of files.values()) {
        // Aliases have no run state of their own; other unloaded units are
        // simply not running (services.jsx:465-470).
        const activeState = file.state === "alias" ? undefined : "inactive";
        consider({
            id: file.id,
            description: "",
            loaded: false,
            activeState,
            subState: undefined,
            loadState: undefined,
            fileState: file.state,
            hasFailed: false,
            combinedState: combinedState(activeState, undefined),
            startup: fileLabel(file.state) ?? file.state,
        });
    }

    return rows.sort(compareRows);
}

export function compareRows(a: UnitRow, b: UnitRow): number {
    if (a.hasFailed !== b.hasFailed)
        return a.hasFailed ? -1 : 1;
    return a.id.localeCompare(b.id);
}

/**
 * The unit files the list uses: handled types only, templates dropped, keyed
 * by name (the file's basename).
 */
export function unitFilesFrom(rows: readonly (readonly [string, string])[]): Map<string, UnitFile> {
    const files = new Map<string, UnitFile>();
    for (const [path, state] of rows) {
        const id = path.slice(path.lastIndexOf("/") + 1);
        if (!unitType(id) || isTemplate(id))
            continue;
        files.set(id, { id, state });
    }
    return files;
}

/** Units failed to start, per type: upstream's tab markers and page status count. */
export function failedByType(units: Iterable<LoadedUnit>): Map<UnitType, number> {
    const counts = new Map<UnitType, number>();
    for (const unit of units) {
        if (unit.activeState !== "failed" || unit.loadState === "not-found")
            continue;
        const type = unitType(unit.id);
        if (type)
            counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return counts;
}

export interface FilterOptions {
    readonly active: readonly string[];
    readonly file: readonly string[];
}

/**
 * The labels the state filter offers: the common ones always, plus any other
 * state actually present (upstream's dropdown options, services.jsx:678-696),
 * plus whatever is currently selected so it can be unselected again.
 */
export function filterOptions(units: Iterable<LoadedUnit>, files: ReadonlyMap<string, UnitFile> | null,
                              selected: StateFilter = NO_FILTER): FilterOptions {
    const active = ["Running", "Not running"];
    const file = ["Enabled", "Disabled", "Static"];
    const add = (list: string[], label: string | undefined) => {
        if (label && !list.includes(label))
            list.push(label);
    };
    for (const unit of units) {
        if (unit.loadState === "not-found" || !unitType(unit.id))
            continue;
        add(active, activeLabel(unit.activeState));
    }
    for (const entry of files?.values() ?? [])
        add(file, fileLabel(entry.state));
    for (const label of selected.active)
        add(active, label);
    for (const label of selected.file)
        add(file, label);
    return { active, file };
}

// ---- unit details ----------------------------------------------------------------

/** Unwrap a D-Bus variant ({t, v}) if it is one. */
function plain(value: unknown): unknown {
    if (value && typeof value === "object" && !Array.isArray(value) && "t" in value && "v" in value)
        return (value as { v: unknown }).v;
    return value;
}

function str(value: unknown): string {
    const v = plain(value);
    return typeof v === "string" ? v : "";
}

function num(value: unknown): number | null {
    const v = plain(value);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strings(value: unknown): string[] {
    const v = plain(value);
    return Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : [];
}

function tuples(value: unknown): unknown[][] {
    const v = plain(value);
    return Array.isArray(v) ? v.filter((item): item is unknown[] => Array.isArray(item)) : [];
}

/** One Conditions/Asserts entry: (type, trigger, negate, parameter, state). */
export interface Condition {
    readonly type: string;
    readonly negate: boolean;
    readonly parameter: string;
    /** > 0 met, < 0 not met, 0 not tested. */
    readonly state: number;
}

/** The relationship lists upstream shows, in its order (service-details.jsx:634-653). */
export const RELATIONSHIPS: readonly (readonly [property: string, label: string])[] = [
    ["Requires", "Requires"],
    ["Requisite", "Requisite"],
    ["Wants", "Wants"],
    ["BindsTo", "Binds to"],
    ["PartOf", "Part of"],
    ["RequiredBy", "Required by"],
    ["RequisiteOf", "Requisite of"],
    ["WantedBy", "Wanted by"],
    ["BoundBy", "Bound by"],
    ["ConsistsOf", "Consists of"],
    ["Conflicts", "Conflicts"],
    ["ConflictedBy", "Conflicted by"],
    ["Before", "Before"],
    ["After", "After"],
    ["OnFailure", "On failure"],
    ["PropagatesReloadTo", "Propagates reload to"],
    ["ReloadPropagatedFrom", "Reload propagated from"],
    ["JoinsNamespaceOf", "Joins namespace of"],
];

export interface TimerDetails extends TimerInfo {
    /** The unit the timer activates. */
    readonly unit: string;
    /** "OnCalendar=*-*-* 03:00:00", "OnBootSec=10min", ... */
    readonly schedule: readonly string[];
}

export interface UnitDetails {
    readonly id: string;
    readonly names: readonly string[];
    readonly description: string;
    readonly loadState: string;
    /** [D-Bus error name, message]; null when the unit loaded fine. */
    readonly loadError: readonly [string, string] | null;
    readonly activeState: string;
    readonly subState: string;
    readonly unitFileState: string;
    readonly fragmentPath: string;
    readonly sourcePath: string;
    readonly dropInPaths: readonly string[];
    readonly canReload: boolean;
    /** Microseconds; 0 when it never happened. */
    readonly activeEnter: number;
    readonly activeExit: number;
    readonly inactiveEnter: number;
    readonly inactiveExit: number;
    readonly conditions: readonly Condition[];
    readonly asserts: readonly Condition[];
    /** The job pending on the unit, or 0. */
    readonly jobId: number;
    readonly triggers: readonly string[];
    readonly triggeredBy: readonly string[];
    readonly relationships: ReadonlyMap<string, readonly string[]>;
    // Service / socket
    readonly mainPid: number | null;
    readonly result: string;
    /** 1 exited, 2 killed, 3 dumped core (CLD_*); 0 when the main process has not ended. */
    readonly execMainCode: number;
    readonly execMainStatus: number;
    readonly restarts: number;
    readonly memory: number | null;
    readonly listen: readonly (readonly [type: string, address: string])[];
    readonly timer: TimerDetails | null;
}

function conditions(value: unknown): Condition[] {
    return tuples(value).map(([type, , negate, parameter, state]) => ({
        type: typeof type === "string" ? type : "",
        negate: negate === true,
        parameter: typeof parameter === "string" ? parameter : "",
        state: typeof state === "number" ? state : 0,
    }));
}

/** "OnUnitInactiveUSec" + 3600000000 -> "OnUnitInactiveSec=1h". */
function monotonicSpec(base: string, usec: number): string {
    const name = base.endsWith("USec") ? base.slice(0, -4) + "Sec" : base;
    return `${name}=${formatSpan(usec)}`;
}

/** A systemd-style time span: "1h 30min", "10min", "500ms". */
export function formatSpan(usec: number): string {
    if (!Number.isFinite(usec) || usec <= 0)
        return "0";
    const units: [number, string][] = [
        [365.25 * 86400e6, "y"], [30.44 * 86400e6, "month"], [7 * 86400e6, "w"], [86400e6, "d"],
        [3600e6, "h"], [60e6, "min"], [1e6, "s"], [1e3, "ms"], [1, "us"],
    ];
    const parts: string[] = [];
    let rest = Math.round(usec);
    for (const [size, name] of units) {
        if (rest >= size) {
            const n = Math.floor(rest / size);
            parts.push(`${n}${name}`);
            rest -= n * size;
            if (parts.length === 2)
                break;
        }
    }
    return parts.join(" ") || "0";
}

/** Properties.GetAll results (variants) for the Unit interface and the type's own interface. */
export function parseUnitDetails(unit: Record<string, unknown>, extra: Record<string, unknown> | null,
                                 type: UnitType | null): UnitDetails {
    const loadError = tuples([plain(unit.LoadError)])[0] ?? [];
    const [errorName, errorMessage] = loadError;
    const job = plain(unit.Job);
    const relationships = new Map<string, readonly string[]>();
    for (const [property] of RELATIONSHIPS)
        relationships.set(property, strings(unit[property]));

    const x = extra ?? {};
    let timer: TimerDetails | null = null;
    if (type === "timer" && extra) {
        const schedule = [
            ...tuples(x.TimersCalendar).map(([base, spec]) => `${String(base)}=${String(spec)}`),
            ...tuples(x.TimersMonotonic).map(([base, usec]) => monotonicSpec(String(base), Number(usec))),
        ];
        timer = {
            unit: str(x.Unit),
            schedule,
            lastTrigger: num(x.LastTriggerUSec),
            nextRealtime: num(x.NextElapseUSecRealtime),
            nextMonotonic: num(x.NextElapseUSecMonotonic),
        };
    }

    return {
        id: str(unit.Id),
        names: strings(unit.Names),
        description: str(unit.Description),
        loadState: str(unit.LoadState),
        loadError: typeof errorName === "string" && errorName
            ? [errorName, typeof errorMessage === "string" ? errorMessage : ""] : null,
        activeState: str(unit.ActiveState),
        subState: str(unit.SubState),
        unitFileState: str(unit.UnitFileState),
        fragmentPath: str(unit.FragmentPath),
        sourcePath: str(unit.SourcePath),
        dropInPaths: strings(unit.DropInPaths),
        canReload: plain(unit.CanReload) === true,
        activeEnter: num(unit.ActiveEnterTimestamp) ?? 0,
        activeExit: num(unit.ActiveExitTimestamp) ?? 0,
        inactiveEnter: num(unit.InactiveEnterTimestamp) ?? 0,
        inactiveExit: num(unit.InactiveExitTimestamp) ?? 0,
        conditions: conditions(unit.Conditions),
        asserts: conditions(unit.Asserts),
        jobId: Array.isArray(job) && typeof job[0] === "number" ? job[0] : 0,
        triggers: strings(unit.Triggers),
        triggeredBy: strings(unit.TriggeredBy),
        relationships,
        mainPid: type === "service" ? num(x.MainPID) : null,
        result: str(x.Result),
        execMainCode: num(x.ExecMainCode) ?? 0,
        execMainStatus: num(x.ExecMainStatus) ?? 0,
        restarts: num(x.NRestarts) ?? 0,
        memory: validUsec(num(x.MemoryCurrent)) ? num(x.MemoryCurrent) : null,
        listen: tuples(x.Listen).map(([kind, address]) => [String(kind), String(address)] as const),
        timer,
    };
}

/** active, activating and reloading count as running (upstream omits reloading). */
export function isActive(activeState: string | undefined): boolean {
    return activeState === "active" || activeState === "activating" || activeState === "reloading";
}

/**
 * The timestamp `systemctl status` puts after "since", for the current state:
 * entering active, entering inactive/failed, leaving inactive (activating),
 * or leaving active (deactivating). Microseconds; 0 when unknown.
 */
export function sinceTimestamp(u: Pick<UnitDetails, "activeState" | "activeEnter" | "activeExit" | "inactiveEnter" | "inactiveExit">): number {
    switch (u.activeState) {
    case "active":
    case "reloading":
        return u.activeEnter;
    case "inactive":
    case "failed":
        return u.inactiveEnter;
    case "activating":
        return u.inactiveExit;
    default:
        return u.activeExit;
    }
}

export type Tone = "ok" | "error" | "warning" | "dim" | "accent" | undefined;

export interface StatusLine {
    readonly kind: "readonly" | "static" | "masked" | "disabled" | "failed" | "running" | "stopped" | "enabled";
    readonly text: string;
    readonly detail: string;
    readonly tone: Tone;
}

/**
 * The status lines, in upstream's order (service-details.jsx:485-608):
 * read-only, static, masked, disabled, failed, running / not running,
 * automatically starts. `since` formats a microsecond timestamp.
 */
export function statusLines(u: UnitDetails, options: { readOnly: boolean, readOnlyHint?: string, since: (usec: number) => string }): StatusLine[] {
    const active = isActive(u.activeState);
    const enabled = u.unitFileState === "enabled";
    const isStatic = u.unitFileState !== "disabled" && !enabled;
    const failed = u.activeState === "failed";
    const masked = u.loadState === "masked";
    const state = u.subState ? `${u.activeState} (${u.subState})` : u.activeState;
    const when = sinceTimestamp(u);
    const since = validUsec(when) ? ` since ${options.since(when)}` : "";

    const lines: StatusLine[] = [];
    if (masked)
        lines.push({ kind: "masked", text: "Masked", detail: "Forbidden from running", tone: "warning" });
    if (!enabled && !active && !masked && !isStatic)
        lines.push({ kind: "disabled", text: "Disabled", detail: "", tone: "dim" });
    if (failed) {
        const result = u.result && u.result !== "success" ? `failed (Result: ${u.result})` : state;
        lines.push({ kind: "failed", text: "Failed to start", detail: result + since, tone: "error" });
    }
    if (lines.length === 0) {
        lines.push(active
            ? { kind: "running", text: "Running", detail: state + since, tone: "ok" }
            : { kind: "stopped", text: "Not running", detail: state + since, tone: "dim" });
    }
    if (isStatic && !masked) {
        const wantedBy = u.relationships.get("WantedBy") ?? [];
        lines.unshift({
            kind: "static", text: "Static",
            detail: wantedBy.length ? `Required by ${wantedBy.join(", ")}` : "", tone: "dim",
        });
    }
    if (options.readOnly)
        lines.unshift({ kind: "readonly", text: "Read-only", detail: options.readOnlyHint ?? "Requires administrative access to edit", tone: "warning" });
    if (enabled)
        lines.push({ kind: "enabled", text: "Automatically starts", detail: "", tone: "ok" });
    return lines;
}

/** "Condition PathExists=!/etc/foo was not met", for each unmet condition and failed assert. */
export function unmetConditions(u: Pick<UnitDetails, "conditions" | "asserts">): string[] {
    const out: string[] = [];
    for (const c of u.conditions)
        if (c.state < 0)
            out.push(`Condition ${c.type}=${c.negate ? "!" : ""}${c.parameter} was not met`);
    for (const a of u.asserts)
        if (a.state < 0)
            out.push(`Assertion ${a.type}=${a.negate ? "!" : ""}${a.parameter} failed`);
    return out;
}

const SIGNALS = new Map<number, string>([
    [1, "HUP"], [2, "INT"], [3, "QUIT"], [4, "ILL"], [5, "TRAP"], [6, "ABRT"], [7, "BUS"], [8, "FPE"],
    [9, "KILL"], [10, "USR1"], [11, "SEGV"], [12, "USR2"], [13, "PIPE"], [14, "ALRM"], [15, "TERM"],
]);

/** How the main process ended, the way `systemctl status` says it; "" while it runs. */
export function mainExit(u: Pick<UnitDetails, "execMainCode" | "execMainStatus">): string {
    const signal = SIGNALS.get(u.execMainStatus);
    switch (u.execMainCode) {
    case 1:
        return `exited, status=${u.execMainStatus}`;
    case 2:
        return `killed, signal=${signal ?? u.execMainStatus}`;
    case 3:
        return `dumped core, signal=${signal ?? u.execMainStatus}`;
    default:
        return "";
    }
}

// ---- actions ---------------------------------------------------------------------

export type ActionId = "start" | "stop" | "restart" | "reload" | "enable" | "disable" | "mask" | "unmask" | "reset";

/*
 * Every action asks first, saying what it will do (the dialogs): one key
 * press never changes a unit, and the user's own units need no
 * administrative access at all.
 */
export interface ActionInfo {
    readonly id: ActionId;
    readonly key: string;
    /** Footer and menu label. */
    readonly label: string;
    /** "Starting" -- while it runs. */
    readonly progress: string;
    /** "Started" -- when it worked. */
    readonly done: string;
}

export const ACTIONS: readonly ActionInfo[] = [
    { id: "start", key: "s", label: "start", progress: "Starting", done: "Started" },
    { id: "stop", key: "S", label: "stop", progress: "Stopping", done: "Stopped" },
    { id: "restart", key: "r", label: "restart", progress: "Restarting", done: "Restarted" },
    { id: "reload", key: "R", label: "reload", progress: "Reloading", done: "Reloaded" },
    { id: "enable", key: "e", label: "enable", progress: "Enabling", done: "Enabled" },
    { id: "disable", key: "d", label: "disable", progress: "Disabling", done: "Disabled" },
    { id: "mask", key: "m", label: "mask", progress: "Masking", done: "Masked" },
    { id: "unmask", key: "u", label: "unmask", progress: "Unmasking", done: "Unmasked" },
    { id: "reset", key: "x", label: "clear failed", progress: "Clearing the failed state of", done: "Cleared the failed state of" },
];

export function actionInfo(id: ActionId): ActionInfo {
    return ACTIONS.find(a => a.id === id)!;
}

/**
 * The action under way, as a list row's state shows it ("Disabling"): no
 * wider than a state, so the columns stay put while it runs.
 */
export function actionRowText(id: ActionId): string {
    return id === "reset" ? "Clearing" : actionInfo(id).progress;
}

/*
 * systemd's special targets that take something down when started
 * (systemd.special(7)): the system manager's reboot, kexec and soft-reboot
 * targets restart the machine; poweroff, and exit outside a container, shut
 * it down; halt halts it. The user manager's exit.target stops all of the
 * user's units and ends the manager. ctrl-alt-del.target is an alias of one
 * of these, which is why a unit's every name is checked.
 */
export type StartEffect = "restart" | "poweroff" | "halt" | "exit";

const SYSTEM_EFFECTS = new Map<string, StartEffect>([
    ["reboot.target", "restart"],
    ["kexec.target", "restart"],
    ["soft-reboot.target", "restart"],
    ["poweroff.target", "poweroff"],
    ["exit.target", "poweroff"],
    ["halt.target", "halt"],
]);

/** What starting the unit with these names does beyond starting it, if it is one of those targets. */
export function startEffect(owner: Owner, names: readonly string[]): StartEffect | null {
    if (owner === "user")
        return names.includes("exit.target") ? "exit" : null;
    for (const name of names) {
        const effect = SYSTEM_EFFECTS.get(name);
        if (effect)
            return effect;
    }
    return null;
}

/*
 * Enable and disable are upstream's on/off switch: enabling a stopped unit
 * also starts it, disabling a running one also stops it. The words say so,
 * so nobody is surprised by the second half.
 */

/** What the action is called for a unit that is (not) running: "enable and start". */
export function actionLabel(id: ActionId, running: boolean): string {
    if (id === "enable" && !running)
        return "enable and start";
    if (id === "disable" && running)
        return "stop and disable";
    return actionInfo(id).label;
}

/** The action under way: "Stopping and disabling". */
export function actionProgress(id: ActionId, running: boolean): string {
    if (id === "enable" && !running)
        return "Enabling and starting";
    if (id === "disable" && running)
        return "Stopping and disabling";
    return actionInfo(id).progress;
}

export type ActionUnit = Pick<UnitDetails, "loadState" | "activeState" | "unitFileState" | "canReload">;

/**
 * What can be done to a unit, upstream's kebab menu plus its on/off switch
 * (service-details.jsx:114-197, 704-713):
 *
 *   masked        unmask only
 *   active        reload (if it can), restart, stop
 *   otherwise     start
 *   failed        clear the failed state
 *   not masked    mask
 *   disabled      enable (and start)      -- the switch, which upstream
 *   enabled       disable (and stop)         shows only for exactly these
 *
 * A unit that failed to load (not found, bad setting) gets nothing: upstream
 * shows only the load error.
 */
export function availableActions(u: ActionUnit): ActionId[] {
    if (u.loadState !== "loaded" && u.loadState !== "masked")
        return [];
    if (u.loadState === "masked")
        return ["unmask"];
    const out: ActionId[] = [];
    if (isActive(u.activeState)) {
        if (u.canReload)
            out.push("reload");
        out.push("restart", "stop");
    } else {
        out.push("start");
    }
    if (u.unitFileState === "disabled")
        out.push("enable");
    if (u.unitFileState === "enabled")
        out.push("disable");
    if (u.activeState === "failed")
        out.push("reset");
    out.push("mask");
    return out;
}

/** Why an action is not on offer right now, for a key pressed anyway. */
export function unavailableReason(id: ActionId, u: ActionUnit): string {
    if (u.loadState !== "loaded" && u.loadState !== "masked")
        return "the unit is not loaded";
    if (u.loadState === "masked")
        return "the unit is masked";
    switch (id) {
    case "start": return "it is already running";
    case "stop":
    case "restart": return "it is not running";
    case "reload": return isActive(u.activeState) ? "it does not support reloading" : "it is not running";
    case "enable": return u.unitFileState === "enabled" ? "it is already enabled" : `it is ${u.unitFileState || "not a unit file"}, not disabled`;
    case "disable": return u.unitFileState === "disabled" ? "it is already disabled" : `it is ${u.unitFileState || "not a unit file"}, not enabled`;
    case "unmask": return "it is not masked";
    case "reset": return "it has not failed";
    default: return "not applicable";
    }
}

/** What a JobRemoved result means (systemd job.h), for "<verb> X failed: ...". */
export function jobResultText(result: string): string {
    switch (result) {
    case "done": return "done";
    case "canceled": return "the job was canceled";
    case "timeout": return "the job timed out";
    case "failed": return "the unit failed";
    case "dependency": return "a dependency failed";
    case "skipped": return "the job was skipped";
    case "invalid": return "the job does not apply to the unit's state";
    case "assert": return "an assertion failed";
    case "unsupported": return "the unit type is not supported here";
    case "collected": return "the job was garbage-collected";
    case "once": return "the unit can only be started once";
    default: return `result "${result}"`;
    }
}
