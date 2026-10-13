/*
 * The Services page's pure logic: the list merge, labels, filters, sorting,
 * timers, paths, the details model, the action matrix and job results.
 */
import { describe, it, expect } from "vitest";
import {
    ACTIONS, actionLabel, actionProgress, actionRowText, activeLabel, availableActions, buildRows, combinedState, exactPattern,
    failedByType, fileLabel, filterOptions, formatSpan, hasFailed, idFromPath, isTemplate, jobResultText, lastTrigger, mainExit,
    nextRun, NO_FILTER, parseUnitDetails, pathIsHandled, sinceTimestamp, startEffect, statusLines, unavailableReason,
    unescapePathLabel, unitFilesFrom, unitType, unmetConditions, validUsec,
    type LoadedUnit, type UnitDetails,
} from "../../src/pages/services/model.js";
import { parseFileRows, parseUnitRows, timerFields, emptyTimer } from "../../src/pages/services/store.js";
import { describeChanges } from "../../src/pages/services/actions.js";
import { mergeNewest, unitJournalArgs } from "../../src/pages/services/logs.js";
import { actionRequest, detailLines, logLine, wrapPhrases } from "../../src/pages/services/details.js";
import { questionText } from "../../src/pages/services/dialogs.js";
import { clean, fitText, relativeTime } from "../../src/pages/services/format.js";
import type { JournalEntry } from "../../src/lib/journal.js";

const UINT64_MAX = 18446744073709551615; // as JSON.parse reads it: 2**64

function loaded(id: string, activeState = "active", loadState = "loaded", description = id + " desc"): LoadedUnit {
    return { id, description, loadState, activeState, subState: activeState === "active" ? "running" : "dead", path: `/p/${id}` };
}

function files(rows: [string, string][]) {
    return unitFilesFrom(rows.map(([id, state]) => [`/usr/lib/systemd/system/${id}`, state]));
}

describe("names and paths", () => {
    it("knows the five unit types and nothing else", () => {
        expect(unitType("sshd.service")).toBe("service");
        expect(unitType("multi-user.target")).toBe("target");
        expect(unitType("a.b.timer")).toBe("timer");
        expect(unitType("dev-sda.device")).toBeNull();
        expect(unitType("noext")).toBeNull();
    });

    it("recognises templates as upstream does", () => {
        expect(isTemplate("getty@.service")).toBe(true);
        expect(isTemplate("foo@")).toBe(true);
        expect(isTemplate("getty@tty1.service")).toBe(false);
        expect(isTemplate("crond.service")).toBe(false);
    });

    it("decodes escaped object path labels", () => {
        expect(unescapePathLabel("getty_40tty1_2eservice")).toBe("getty@tty1.service");
        expect(unescapePathLabel("dbus_2dbroker_2eservice")).toBe("dbus-broker.service");
        expect(unescapePathLabel("pmie_5ffarm_2eservice")).toBe("pmie_farm.service");
        expect(unescapePathLabel("_")).toBe("");
        expect(idFromPath("/org/freedesktop/systemd1/unit/crond_2eservice")).toBe("crond.service");
        expect(idFromPath("/org/freedesktop/systemd1/job/123")).toBeNull();
        expect(idFromPath("/org/freedesktop/systemd1/unit/a/b")).toBeNull();
    });

    it("decodes multi-byte names", () => {
        expect(unescapePathLabel("caf_c3_a9_2eservice")).toBe("café.service");
    });

    it("tells handled unit paths from others by their escaped suffix", () => {
        expect(pathIsHandled("/org/freedesktop/systemd1/unit/crond_2eservice")).toBe(true);
        expect(pathIsHandled("/org/freedesktop/systemd1/unit/sshd_2esocket")).toBe(true);
        expect(pathIsHandled("/org/freedesktop/systemd1/unit/var_2dtmp_2emount")).toBe(false);
        expect(pathIsHandled("/org/freedesktop/systemd1/unit/system_2eslice")).toBe(false);
        expect(pathIsHandled("/org/freedesktop/systemd1/job/12")).toBe(false);
    });

    it("makes exact fnmatch patterns (FNM_NOESCAPE: brackets, not backslashes)", () => {
        expect(exactPattern("crond.service")).toBe("crond.service");
        expect(exactPattern("a*b?c[d].service")).toBe("a[*]b[?]c[[]d].service");
        expect(exactPattern("systemd-cryptsetup@luks\\x2dabc.service")).toBe("systemd-cryptsetup@luks\\x2dabc.service");
    });
});

describe("labels and derived state", () => {
    it("maps states to upstream's labels", () => {
        expect(activeLabel("activating")).toBe("Running");
        expect(activeLabel("deactivating")).toBe("Not running");
        expect(activeLabel("failed")).toBe("Failed to start");
        expect(fileLabel("enabled-runtime")).toBe("Enabled");
        expect(fileLabel("masked-runtime")).toBe("Masked");
        expect(fileLabel("weird")).toBeUndefined();
    });

    it("never reaches Object.prototype through a hostile state name", () => {
        expect(activeLabel("constructor")).toBeUndefined();
        expect(fileLabel("__proto__")).toBeUndefined();
        expect(combinedState("toString", "loaded")).toBe("toString");
    });

    it("computes HasFailed and CombinedState", () => {
        expect(hasFailed("failed", "loaded")).toBe(true);
        expect(hasFailed("inactive", "bad-setting")).toBe(true);
        expect(hasFailed("inactive", "masked")).toBe(false);
        expect(hasFailed("active", undefined)).toBe(false);
        expect(combinedState("inactive", "bad-setting")).toBe("Not running (Bad setting)");
        expect(combinedState("active", "masked")).toBe("Running");
        expect(combinedState(undefined, undefined)).toBe("");
    });

    it("counts failed units per type, ignoring not-found ones and other types", () => {
        const counts = failedByType([
            loaded("a.service", "failed"), loaded("b.service", "failed"), loaded("c.socket", "failed"),
            loaded("d.service", "failed", "not-found"), loaded("e.mount", "failed"), loaded("f.service", "inactive", "bad-setting"),
        ]);
        expect(Object.fromEntries(counts)).toEqual({ service: 2, socket: 1 });
    });
});

describe("the merged list", () => {
    const units = [
        loaded("crond.service"),
        loaded("cups.service", "inactive", "masked", "cups.service"),
        loaded("syslog.service", "inactive", "not-found", "syslog.service"),
        loaded("getty@tty1.service"),
        loaded("broken.service", "failed"),
        loaded("multi-user.target"),
    ];
    const unitFiles = files([
        ["crond.service", "enabled"], ["cups.service", "masked"], ["foo.service", "disabled"],
        ["dbus.service", "alias"], ["getty@.service", "enabled"], ["broken.service", "enabled"],
        ["multi-user.target", "static"],
    ]);

    it("merges loaded units and unit files the way upstream does", () => {
        const rows = buildRows({ units, files: unitFiles, type: "service" });
        expect(rows.map(r => r.id)).toEqual([
            "broken.service", // failed first
            "crond.service", "cups.service", "dbus.service", "foo.service", "getty@tty1.service",
        ]);
        const byId = Object.fromEntries(rows.map(r => [r.id, r]));
        // Loaded units take their file state from the unit files...
        expect(byId["crond.service"]).toMatchObject({ loaded: true, fileState: "enabled", startup: "Enabled", combinedState: "Running" });
        // ...template instances have none, and templates and not-found units are hidden.
        expect(byId["getty@tty1.service"]!.fileState).toBeUndefined();
        expect(byId["getty@tty1.service"]!.startup).toBe("");
        // An alias has no run state of its own.
        expect(byId["dbus.service"]).toMatchObject({ loaded: false, activeState: undefined, combinedState: "", startup: "Alias" });
        // An unloaded unit file is simply not running.
        expect(byId["foo.service"]).toMatchObject({ loaded: false, activeState: "inactive", combinedState: "Not running", description: "" });
        expect(byId["broken.service"]).toMatchObject({ hasFailed: true, combinedState: "Failed to start" });
    });

    it("shows the unit file of a not-found unit rather than nothing", () => {
        const rows = buildRows({
            units: [loaded("new.service", "inactive", "not-found")],
            files: files([["new.service", "disabled"]]),
            type: "service",
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ loaded: false, fileState: "disabled" });
    });

    it("lists one type per tab", () => {
        expect(buildRows({ units, files: unitFiles, type: "target" }).map(r => r.id)).toEqual(["multi-user.target"]);
        expect(buildRows({ units, files: unitFiles, type: "timer" })).toEqual([]);
    });

    it("works before the unit files arrive", () => {
        expect(buildRows({ units, files: null, type: "service" }).map(r => r.id))
            .toEqual(["broken.service", "crond.service", "cups.service", "getty@tty1.service"]);
    });

    it("filters text on id and description, case-insensitively", () => {
        const rows = buildRows({ units, files: unitFiles, type: "service", text: "  CROND " });
        expect(rows.map(r => r.id)).toEqual(["crond.service"]);
        const byDescription = buildRows({
            units: [loaded("crond.service", "active", "loaded", "Command Scheduler"), loaded("atd.service")],
            files: null, type: "service", text: "scheduler",
        });
        expect(byDescription.map(r => r.id)).toEqual(["crond.service"]);
    });

    it("filters by label, letting units with an unknown label through", () => {
        const enabled = buildRows({ units, files: unitFiles, type: "service", filter: { ...NO_FILTER, file: ["Enabled"] } });
        // getty@tty1 has no file state: unknown passes, as upstream (G8).
        expect(enabled.map(r => r.id)).toEqual(["broken.service", "crond.service", "getty@tty1.service"]);
        const running = buildRows({ units, files: unitFiles, type: "service", filter: { ...NO_FILTER, active: ["Running"] } });
        // The alias (no active state) passes as well.
        expect(running.map(r => r.id)).toEqual(["crond.service", "dbus.service", "getty@tty1.service"]);
        const runningAndMasked = buildRows({
            units, files: unitFiles, type: "service", filter: { ...NO_FILTER, active: ["Running"], file: ["Masked"] },
        });
        expect(runningAndMasked.map(r => r.id)).toEqual(["getty@tty1.service"]);
    });

    it("matches activating and enabled-runtime by their labels", () => {
        const rows = buildRows({
            units: [loaded("a.service", "activating"), loaded("b.service", "inactive")],
            files: files([["a.service", "enabled-runtime"], ["b.service", "enabled"]]),
            type: "service", filter: { ...NO_FILTER, active: ["Running"], file: ["Enabled"] },
        });
        expect(rows.map(r => r.id)).toEqual(["a.service"]);
    });

    it("shows exactly the failed rows with 'failed only'", () => {
        const rows = buildRows({
            units: [...units, loaded("bad.service", "inactive", "bad-setting")],
            files: unitFiles, type: "service", filter: { ...NO_FILTER, failedOnly: true },
        });
        expect(rows.map(r => r.id)).toEqual(["bad.service", "broken.service"]);
    });

    it("offers the common filter labels plus the states present, and keeps selected ones", () => {
        const options = filterOptions(
            [loaded("a.service", "failed"), loaded("b.service", "reloading"), loaded("c.service", "inactive", "not-found")],
            files([["x.service", "masked"], ["y.service", "masked-runtime"], ["z.service", "enabled-runtime"]]),
            { ...NO_FILTER, active: ["Maintenance"] },
        );
        expect(options.active).toEqual(["Running", "Not running", "Failed to start", "Reloading", "Maintenance"]);
        expect(options.file).toEqual(["Enabled", "Disabled", "Static", "Masked"]);
    });

    it("drops templates and other types from the unit files", () => {
        const map = unitFilesFrom([
            ["/usr/lib/systemd/system/getty@.service", "enabled"],
            ["/usr/lib/systemd/system/a.mount", "static"],
            ["/etc/systemd/system/dbus.service", "alias"],
        ]);
        expect([...map.keys()]).toEqual(["dbus.service"]);
    });

    it("attaches timer times on the Timers tab", () => {
        const timer = loaded("dnf-makecache.timer");
        const rows = buildRows({
            units: [timer], files: null, type: "timer",
            timers: new Map([[timer.path, { lastTrigger: 1_790_979_796_239_992, nextRealtime: 0, nextMonotonic: 1_063_093_795_740 }]]),
            monotonicBase: 1_790_984_275_157_465 - 1_061_671_516_166,
        });
        expect(rows[0]!.lastTrigger).toBeCloseTo(1_790_979_796_239.992, 3);
        expect(rows[0]!.nextRun).toBeCloseTo((1_063_093_795_740 + 1_790_984_275_157_465 - 1_061_671_516_166) / 1000, 3);
    });
});

describe("timers", () => {
    it("treats 0 and UINT64_MAX as unknown", () => {
        expect(validUsec(0)).toBe(false);
        expect(validUsec(UINT64_MAX)).toBe(false);
        expect(validUsec(1_790_979_796_239_992)).toBe(true);
        expect(nextRun({ lastTrigger: null, nextRealtime: UINT64_MAX, nextMonotonic: UINT64_MAX }, 5)).toBeNull();
        expect(lastTrigger({ lastTrigger: 0, nextRealtime: null, nextMonotonic: null })).toBeNull();
    });

    it("uses realtime for calendar timers, and the clock offset for monotonic ones", () => {
        expect(nextRun({ lastTrigger: null, nextRealtime: 2_000_000, nextMonotonic: 0 }, null)).toBe(2000);
        expect(nextRun({ lastTrigger: null, nextRealtime: 0, nextMonotonic: 1_000_000 }, 5_000_000)).toBe(6000);
        // Without the host's clocks a monotonic timer has no date.
        expect(nextRun({ lastTrigger: null, nextRealtime: 0, nextMonotonic: 1_000_000 }, null)).toBeNull();
        // Both kinds: whichever fires first.
        expect(nextRun({ lastTrigger: null, nextRealtime: 9_000_000, nextMonotonic: 1_000_000 }, 5_000_000)).toBe(6000);
    });

    it("reads Timer props from GetAll and from PropertiesChanged", () => {
        const info = emptyTimer();
        timerFields(info, {
            LastTriggerUSec: { t: "t", v: 5 }, NextElapseUSecRealtime: { t: "t", v: UINT64_MAX }, Unit: { t: "s", v: "x" },
        });
        expect(info).toEqual({ lastTrigger: 5, nextRealtime: UINT64_MAX, nextMonotonic: null });
        timerFields(info, { NextElapseUSecMonotonic: { t: "t", v: 7 } });
        expect(info).toEqual({ lastTrigger: 5, nextRealtime: UINT64_MAX, nextMonotonic: 7 });
    });

    it("formats systemd time spans", () => {
        expect(formatSpan(3_600_000_000)).toBe("1h");
        expect(formatSpan(600_000_000)).toBe("10min");
        expect(formatSpan(5_400_000_000)).toBe("1h 30min");
        expect(formatSpan(1_500)).toBe("1ms 500us");
        expect(formatSpan(0)).toBe("0");
    });
});

describe("reply parsing", () => {
    it("parses ListUnits rows defensively", () => {
        expect(parseUnitRows([
            ["crond.service", "Command Scheduler", "loaded", "active", "running", "", "/org/freedesktop/systemd1/unit/crond_2eservice", 0, "", "/"],
            ["short"],
            [42, "x", "loaded", "active", "running", "", "/p", 0, "", "/"],
            "garbage",
        ])).toEqual([{
            id: "crond.service", description: "Command Scheduler", loadState: "loaded", activeState: "active",
            subState: "running", path: "/org/freedesktop/systemd1/unit/crond_2eservice",
        }]);
        expect(parseUnitRows(null)).toEqual([]);
    });

    it("parses ListUnitFiles rows defensively", () => {
        expect(parseFileRows([["/a.service", "enabled"], ["/b"], [1, 2]])).toEqual([["/a.service", "enabled"]]);
    });
});

function details(overrides: Partial<UnitDetails> = {}): UnitDetails {
    const base = parseUnitDetails({
        Id: { t: "s", v: "crond.service" },
        Names: { t: "as", v: ["crond.service"] },
        Description: { t: "s", v: "Command Scheduler" },
        LoadState: { t: "s", v: "loaded" },
        ActiveState: { t: "s", v: "active" },
        SubState: { t: "s", v: "running" },
        UnitFileState: { t: "s", v: "enabled" },
        CanReload: { t: "b", v: true },
        ActiveEnterTimestamp: { t: "t", v: 1_789_922_620_466_992 },
        LoadError: { t: "(ss)", v: ["", ""] },
        Job: { t: "(uo)", v: [0, "/"] },
        WantedBy: { t: "as", v: ["multi-user.target"] },
    }, null, "service");
    return { ...base, ...overrides };
}

describe("unit details", () => {
    it("parses GetAll replies (variants), tolerating missing and malformed props", () => {
        const unit = parseUnitDetails({
            Id: { t: "s", v: "cups.service" },
            LoadState: { t: "s", v: "masked" },
            LoadError: { t: "(ss)", v: ["org.freedesktop.systemd1.UnitMasked", "Unit cups.service is masked."] },
            Job: { t: "(uo)", v: [42, "/org/freedesktop/systemd1/job/42"] },
            Conditions: { t: "a(sbbsi)", v: [["ConditionPathExists", false, true, "/etc/x", -1], "junk"] },
            Names: { t: "as", v: ["cups.service", 7] },
        }, {
            MainPID: { t: "u", v: 1775 }, MemoryCurrent: { t: "t", v: UINT64_MAX }, ExecMainCode: { t: "i", v: 1 },
            ExecMainStatus: { t: "i", v: 125 }, Result: { t: "s", v: "exit-code" },
        }, "service");
        expect(unit).toMatchObject({
            id: "cups.service", names: ["cups.service"], loadState: "masked", jobId: 42, mainPid: 1775, memory: null,
            loadError: ["org.freedesktop.systemd1.UnitMasked", "Unit cups.service is masked."], result: "exit-code",
        });
        expect(unit.conditions).toEqual([{ type: "ConditionPathExists", negate: true, parameter: "/etc/x", state: -1 }]);
        expect(unmetConditions(unit)).toEqual(["Condition ConditionPathExists=!/etc/x was not met"]);
        expect(mainExit(unit)).toBe("exited, status=125");
        expect(mainExit({ execMainCode: 2, execMainStatus: 9 })).toBe("killed, signal=KILL");
        expect(mainExit({ execMainCode: 0, execMainStatus: 0 })).toBe("");
        expect(parseUnitDetails({}, null, null).loadError).toBeNull();
    });

    it("reads timer schedules and socket listeners", () => {
        const timer = parseUnitDetails({ Id: { t: "s", v: "dnf-makecache.timer" } }, {
            Unit: { t: "s", v: "dnf-makecache.service" },
            TimersMonotonic: { t: "a(stt)", v: [["OnUnitInactiveUSec", 3_600_000_000, 1], ["OnBootUSec", 600_000_000, 600_000_000]] },
            TimersCalendar: { t: "a(sst)", v: [["OnCalendar", "*-*-* 03:00:00", 5]] },
            NextElapseUSecRealtime: { t: "t", v: 0 },
            NextElapseUSecMonotonic: { t: "t", v: 1_063_093_795_740 },
            LastTriggerUSec: { t: "t", v: 1_790_979_796_239_992 },
        }, "timer");
        expect(timer.timer).toEqual({
            unit: "dnf-makecache.service",
            schedule: ["OnCalendar=*-*-* 03:00:00", "OnUnitInactiveSec=1h", "OnBootSec=10min"],
            lastTrigger: 1_790_979_796_239_992, nextRealtime: 0, nextMonotonic: 1_063_093_795_740,
        });
        const socket = parseUnitDetails({ Id: { t: "s", v: "cockpit.socket" } },
                                        { Listen: { t: "a(ss)", v: [["Stream", "[::]:9090"]] } }, "socket");
        expect(socket.listen).toEqual([["Stream", "[::]:9090"]]);
        expect(socket.mainPid).toBeNull();
    });

    it("picks the timestamp systemctl status would show", () => {
        const at = { activeEnter: 1, activeExit: 2, inactiveEnter: 3, inactiveExit: 4 };
        expect(sinceTimestamp({ ...at, activeState: "active" })).toBe(1);
        expect(sinceTimestamp({ ...at, activeState: "failed" })).toBe(3);
        expect(sinceTimestamp({ ...at, activeState: "activating" })).toBe(4);
        expect(sinceTimestamp({ ...at, activeState: "deactivating" })).toBe(2);
    });

    const since = () => "then";

    it("orders the status lines as upstream: enabled and running", () => {
        expect(statusLines(details(), { readOnly: false, since }).map(l => l.kind)).toEqual(["running", "enabled"]);
        expect(statusLines(details(), { readOnly: true, since }).map(l => l.kind)).toEqual(["readonly", "running", "enabled"]);
        expect(statusLines(details(), { readOnly: false, since })[0]!.detail).toBe("active (running) since then");
    });

    it("orders the status lines as upstream: static and running", () => {
        const lines = statusLines(details({ unitFileState: "static" }), { readOnly: false, since });
        expect(lines.map(l => l.kind)).toEqual(["static", "running"]);
        expect(lines[0]!.detail).toBe("Required by multi-user.target");
    });

    it("orders the status lines as upstream: disabled and failed", () => {
        const lines = statusLines(details({ unitFileState: "disabled", activeState: "failed", subState: "failed", result: "exit-code" }),
                                  { readOnly: false, since });
        expect(lines.map(l => l.kind)).toEqual(["disabled", "failed"]);
        expect(lines[1]!.detail).toBe("failed (Result: exit-code)");
    });

    it("orders the status lines as upstream: masked", () => {
        const lines = statusLines(details({ loadState: "masked", unitFileState: "masked", activeState: "inactive", subState: "dead" }),
                                  { readOnly: false, since });
        expect(lines.map(l => l.kind)).toEqual(["masked"]);
    });

    it("treats enabled-runtime and indirect as static, like upstream's details", () => {
        for (const state of ["enabled-runtime", "indirect", "generated", "transient", ""])
            expect(statusLines(details({ unitFileState: state }), { readOnly: false, since })[0]!.kind).toBe("static");
    });
});

describe("the action matrix", () => {
    const unit = (overrides: Partial<UnitDetails>) => details(overrides);

    it("offers only unmask for a masked unit", () => {
        expect(availableActions(unit({ loadState: "masked", unitFileState: "masked", activeState: "inactive" }))).toEqual(["unmask"]);
    });

    it("offers reload, restart and stop for a running unit (reload only if it can)", () => {
        expect(availableActions(unit({}))).toEqual(["reload", "restart", "stop", "disable", "mask"]);
        expect(availableActions(unit({ canReload: false }))).toEqual(["restart", "stop", "disable", "mask"]);
        expect(availableActions(unit({ activeState: "reloading" }))).toEqual(["reload", "restart", "stop", "disable", "mask"]);
    });

    it("offers start, enable and clearing the failed state for a failed disabled unit", () => {
        expect(availableActions(unit({ activeState: "failed", unitFileState: "disabled" }))).toEqual(["start", "enable", "reset", "mask"]);
    });

    it("offers no enable/disable for static-like states", () => {
        expect(availableActions(unit({ activeState: "inactive", unitFileState: "static" }))).toEqual(["start", "mask"]);
        expect(availableActions(unit({ activeState: "inactive", unitFileState: "enabled-runtime" }))).toEqual(["start", "mask"]);
    });

    it("offers nothing for a unit that failed to load", () => {
        expect(availableActions(unit({ loadState: "not-found" }))).toEqual([]);
        expect(availableActions(unit({ loadState: "bad-setting" }))).toEqual([]);
        expect(unavailableReason("start", unit({ loadState: "not-found" }))).toBe("the unit is not loaded");
    });

    it("explains why an action is not on offer", () => {
        expect(unavailableReason("start", unit({}))).toBe("it is already running");
        expect(unavailableReason("stop", unit({ activeState: "inactive" }))).toBe("it is not running");
        expect(unavailableReason("reload", unit({ canReload: false }))).toBe("it does not support reloading");
        expect(unavailableReason("enable", unit({ unitFileState: "static" }))).toBe("it is static, not disabled");
        expect(unavailableReason("unmask", unit({}))).toBe("it is not masked");
    });

    it("says exactly what a confirmed action will do", () => {
        const running = details({ relationships: new Map([["RequiredBy", ["a.service"]]]) });
        const stopped = details({ activeState: "inactive", unitFileState: "disabled" });
        const ask = (action: Parameters<typeof actionRequest>[0], unit: UnitDetails, dependents: string[] = []) =>
            questionText(actionRequest(action, unit, dependents));
        expect(ask("stop", running, ["a.service"])).toBe("Stop crond.service now? Units that depend on it are stopped as well: a.service.");
        expect(ask("restart", running)).toBe("Restart crond.service now? It is stopped and started again.");
        expect(ask("start", stopped)).toBe("Start crond.service now?");
        expect(ask("reload", running)).toBe("Reload crond.service now? It reloads its configuration and keeps running.");
        expect(ask("enable", stopped)).toBe("Enable and start crond.service? It starts now, and from now on automatically. " +
            "This also reloads systemd's configuration (daemon-reload).");
        expect(ask("enable", details({ unitFileState: "disabled" }))).toBe("Enable crond.service? From now on it starts automatically. " +
            "This also reloads systemd's configuration (daemon-reload).");
        expect(ask("disable", running, ["a.service"])).toBe("Stop and disable crond.service? It is stopped now, and no longer starts " +
            "automatically. Units that depend on it are stopped as well: a.service. This also reloads systemd's configuration (daemon-reload).");
        expect(ask("disable", details({ activeState: "inactive" }))).toBe("Disable crond.service? It will no longer start automatically. " +
            "This also reloads systemd's configuration (daemon-reload).");
        expect(ask("mask", running)).toContain("Masking service prevents all dependent units from running.");
        expect(ask("mask", details({ activeState: "failed" }))).toContain("Its failed state is cleared as well.");
        expect(ask("unmask", details({ loadState: "masked", unitFileState: "masked" }))).toBe("Unmask crond.service? It can be started again. " +
            "This also reloads systemd's configuration (daemon-reload).");
        expect(ask("reset", details({ activeState: "failed" })))
            .toBe("Clear the failed state of crond.service? It shows as not running, and the record of its failure is reset.");
        expect(actionRequest("disable", running, []).confirmLabel).toBe("Stop and disable");
        expect(actionRequest("stop", details({ names: ["dbus-broker.service", "dbus.service"], id: "dbus-broker.service" }), []).target.name)
            .toBe("dbus-broker.service");
        // Every action asks, in words.
        for (const { id } of ACTIONS)
            expect(ask(id, running).length).toBeGreaterThan(20);
        expect(actionRequest("stop", running, []).danger).toBe(true);
        expect(actionRequest("start", stopped, []).danger).toBe(false);
    });

    it("names fewer dependents when there is less room, and counts the rest", () => {
        const request = actionRequest("restart", details(), ["a.service", "b.service", "c.service"]);
        expect(questionText(request)).toBe("Restart crond.service now? It is stopped and started again. " +
            "Units that depend on it are restarted as well: a.service, b.service, c.service.");
        expect(questionText(request, 1)).toContain("restarted as well: a.service and 2 more.");
        expect(questionText(request, 0)).toContain("restarted as well: 3 units.");
    });

    it("says what starting a shutdown target does, and expects the connection to drop", () => {
        const target = (id: string, names = [id]) => details({ id, names, activeState: "inactive", unitFileState: "disabled" });
        expect(startEffect("system", ["reboot.target"])).toBe("restart");
        expect(startEffect("system", ["ctrl-alt-del.target", "poweroff.target"])).toBe("poweroff");
        expect(startEffect("system", ["kexec.target"])).toBe("restart");
        expect(startEffect("system", ["halt.target"])).toBe("halt");
        expect(startEffect("system", ["exit.target"])).toBe("poweroff");
        expect(startEffect("system", ["rescue.target"])).toBeNull();
        expect(startEffect("user", ["exit.target"])).toBe("exit");
        expect(startEffect("user", ["reboot.target"])).toBeNull();

        const reboot = actionRequest("start", target("reboot.target", ["reboot.target", "ctrl-alt-del.target"]), [], { owner: "system", host: "web1" });
        expect(questionText(reboot)).toBe("Start reboot.target now? This restarts web1.");
        expect(reboot.target.disconnect).toBe("web1 is restarting.");
        expect(reboot.danger).toBe(true);
        const poweroff = actionRequest("enable", target("poweroff.target"), [], { owner: "system", host: "web1" });
        expect(questionText(poweroff)).toMatch(/^Enable and start poweroff\.target\? Starting it shuts down web1\./);
        expect(poweroff.target.disconnect).toBe("web1 is shutting down.");
        // Already running (enable only), or the user's own manager: no drop to expect.
        expect(actionRequest("enable", details({ id: "poweroff.target", names: ["poweroff.target"], unitFileState: "disabled" }), [],
                             { owner: "system", host: "web1" }).target.disconnect).toBeNull();
        const exit = actionRequest("start", target("exit.target"), [], { owner: "user", host: "web1" });
        expect(questionText(exit)).toContain("This stops all of your user units and ends your user service manager");
        expect(exit.target.disconnect).toBeNull();
        expect(exit.danger).toBe(true);
    });

    it("says briefly on a list row what is under way, in no more room than a state", () => {
        expect(actionRowText("reset")).toBe("Clearing");
        expect(actionRowText("disable")).toBe("Disabling");
        for (const { id } of ACTIONS)
            expect(actionRowText(id).length).toBeLessThanOrEqual(10);
    });

    it("names enable and disable for what they do to a unit in its state", () => {
        expect(actionLabel("enable", false)).toBe("enable and start");
        expect(actionLabel("enable", true)).toBe("enable");
        expect(actionLabel("disable", true)).toBe("stop and disable");
        expect(actionLabel("disable", false)).toBe("disable");
        expect(actionLabel("reset", false)).toBe("clear failed");
        expect(actionProgress("disable", true)).toBe("Stopping and disabling");
        expect(actionProgress("start", false)).toBe("Starting");
        const request = actionRequest("enable", details({ activeState: "inactive", unitFileState: "disabled" }), []);
        expect(request).toMatchObject({ title: "Enable and start crond.service", progress: "Enabling and starting crond.service" });
    });

    it("describes job results", () => {
        expect(jobResultText("failed")).toBe("the unit failed");
        expect(jobResultText("dependency")).toBe("a dependency failed");
        expect(jobResultText("bogus")).toBe('result "bogus"');
    });

    it("describes unit-file changes the way systemctl does", () => {
        expect(describeChanges([["symlink", "/etc/a", "/usr/b"], ["unlink", "/etc/c", ""], "junk"]))
            .toEqual(["Created symlink /etc/a → /usr/b", "Removed /etc/c"]);
        expect(describeChanges(null)).toEqual([]);
    });
});

describe("rendering helpers", () => {
    const now = new Date(2026, 9, 2, 18, 0, 0).getTime();

    it("formats relative times", () => {
        expect(relativeTime(now + 23 * 60_000, now)).toBe("in 23 minutes");
        expect(relativeTime(now - 2 * 3600_000, now)).toBe("2 hours ago");
        expect(relativeTime(now + 1000, now)).toBe("now");
    });

    it("cleans host text in the details", () => {
        // (The description is not part of these lines: the heading shows it; the page's render tests cover that.)
        const unit = details({ fragmentPath: "/etc/x\x1b[2J\u202e", dropInPaths: ["/etc/d\x07.conf"] });
        const lines = detailLines({
            unit, requestedId: "crond.service", width: 80, now, zone: false, readOnly: false, readOnlyHint: "",
            actions: ["stop"], showRelationships: true, monotonicBase: null,
        });
        const text = lines.map(line => line.map(s => s.text).join("")).join("\n");
        expect(text).not.toContain("\x1b");
        expect(text).not.toContain("\u202e");
        expect(text).toContain("/etc/x^[[2J");
        expect(text).toContain("/etc/d^G.conf");
        expect(text).toContain("S stop");
        expect(text).toContain("Wanted by");
    });

    it("cleans host text of control characters and bidirectional controls", () => {
        expect(clean("a\x1b]0;x\x07b\u202ec\u2066d\u200fe\u061cf")).toBe("a^[]0;x^Gbcdef");
    });

    it("fits text into a number of lines, keeping a closing hint", () => {
        expect(fitText("short", 20, 3)).toBe("short");
        expect(fitText("one two three four five six seven eight", 10, 2)).toBe("one two\nthree fou…");
        expect(fitText("one two three four five six seven eight", 10, 3, "Press X.")).toBe("one two\nthree fou…\nPress X.");
        expect(fitText("one two", 10, 3, "Press X.")).toBe("one two\nPress X.");
    });

    it("wraps a status detail on a narrow screen rather than cutting it", () => {
        const lines = detailLines({
            unit: details(), requestedId: "crond.service", width: 48, now, zone: false, readOnly: true,
            readOnlyHint: "Requires administrative access to edit (press A)", actions: [], showRelationships: false,
            monotonicBase: null,
        });
        const texts = lines.map(line => line.map(s => s.text).join(""));
        for (const text of texts)
            expect(text.length).toBeLessThanOrEqual(48);
        const joined = texts.map(text => text.trim()).join(" ");
        expect(joined).toContain("(12 days ago)");
        expect(joined).toContain("(press A)");
        expect(joined).toMatch(/Relation\S*… 1 kind/);
        // Continuation lines line up under the detail.
        const running = texts.findIndex(text => text.includes("● Running"));
        expect(texts[running + 1]!.indexOf("2026") >= 0 || texts[running + 1]!.includes("(12 days ago)")).toBe(true);
        expect(texts[running + 1]!.search(/\S/)).toBe(texts[running]!.indexOf("active"));
    });

    it("wraps status details between phrases", () => {
        const detail = "failed (Result: exit-code) since 2026-10-02 18:45:43 (1 hour ago)";
        expect(wrapPhrases(detail, 80)).toEqual([detail]);
        expect(wrapPhrases(detail, 32)).toEqual(["failed (Result: exit-code)", "since 2026-10-02 18:45:43", "(1 hour ago)"]);
        // A phrase too long for a line is word-wrapped.
        expect(wrapPhrases("Required by a.service, b.service, c.service", 20))
            .toEqual(["Required by", "a.service,", "b.service, c.service"]);
    });

    it("shows a unit that does not exist as just that", () => {
        const unit = details({
            loadState: "not-found", activeState: "inactive", subState: "dead", unitFileState: "",
            loadError: ["org.freedesktop.systemd1.NoSuchUnit", "Unit syslog.service not found."],
        });
        const text = detailLines({
            unit, requestedId: "syslog.service", width: 80, now, zone: false, readOnly: false, readOnlyHint: "",
            actions: [], showRelationships: false, monotonicBase: null,
        }).map(line => line.map(s => s.text).join("")).join("\n");
        expect(text).toContain("Unit syslog.service not found.");
        expect(text).toContain("none for a unit that does not exist");
        expect(text).not.toContain("Static");
        expect(text).not.toContain("Not running");
    });

    it("folds the relationships away until asked", () => {
        const lines = detailLines({
            unit: details(), requestedId: "dbus.service", width: 80, now, zone: false, readOnly: true, readOnlyHint: "Requires administrative access",
            actions: [], showRelationships: false, monotonicBase: null,
        });
        const text = lines.map(line => line.map(s => s.text).join("")).join("\n");
        expect(text).toContain("Relationships 1 kind (g to show)");
        expect(text).not.toContain("Wanted by");
        expect(text).toContain("none without administrative access");
        expect(text).toContain("dbus.service (an alias of crond.service)");
    });

    it("renders journal lines with priority markers and no escapes", () => {
        const entry: JournalEntry = {
            cursor: "c", time: now - 1000, bootId: "b", priority: 3, identifier: "crond",
            message: "bad \x1b[31mthing\nsecond line", fields: {},
        };
        const text = logLine(entry, 80, now).map(s => s.text).join("");
        expect(text).toContain("crond: bad ^[[31mthing …");
        expect(text).not.toContain("\x1b");
        expect(text).toContain("17:59:59");
    });

    it("merges journal entries newest first without duplicates", () => {
        const e = (cursor: string) => ({ cursor } as JournalEntry);
        expect(mergeNewest([e("d"), e("c")], [e("c"), e("b"), e("a")], 3).map(x => x.cursor)).toEqual(["d", "c", "b"]);
    });

    it("matches a user unit's entries for its own user only, and a system unit's by name", () => {
        expect(unitJournalArgs({ name: "dbus-broker.service", user: true }, { kind: "follow", after: "c1" }, 1000)).toEqual([
            "journalctl", "-q", "--no-tail", "--output=json", "--after-cursor=c1", "--follow", "--",
            "_SYSTEMD_USER_UNIT=dbus-broker.service", "_UID=1000", "+",
            "COREDUMP_USER_UNIT=dbus-broker.service", "COREDUMP_UID=1000", "+",
            "USER_UNIT=dbus-broker.service", "_UID=1000",
        ]);
        // No uid known: by name, as upstream does.
        expect(unitJournalArgs({ name: "a.service", user: true }, { kind: "page", lines: 10 }, null).slice(-5)).toEqual([
            "_SYSTEMD_USER_UNIT=a.service", "+", "COREDUMP_USER_UNIT=a.service", "+", "USER_UNIT=a.service",
        ]);
        // System units are the system's: any uid.
        expect(unitJournalArgs({ name: "crond.service" }, { kind: "page", lines: 10 }, 1000).slice(-5)).toEqual([
            "_SYSTEMD_UNIT=crond.service", "+", "COREDUMP_UNIT=crond.service", "+", "UNIT=crond.service",
        ]);
    });
});
