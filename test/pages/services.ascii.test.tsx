/*
 * The Services page without Unicode (COCKPIT_TUI_ASCII=1, or a locale that
 * is not UTF-8: serial consoles, LANG=C): nothing it draws may need more than
 * ASCII. The glyph set is chosen when the theme module loads, so the
 * variable is set before anything is imported, in a file of its own.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

vi.hoisted(() => {
    process.env.COCKPIT_TUI_ASCII = "1";
});

import ServicesPage from "../../src/pages/services/index.js";
import { renderPage, type RenderedPage } from "../helpers/page.js";
import { cleanup, keys } from "../helpers/ink.js";
import { startMock, type MockBridge, type MockScenario } from "../mock-bridge/harness.js";
import { initInfo } from "../../src/session.js";
import { unicode } from "../../src/tui/theme.js";

const M = "/org/freedesktop/systemd1";
const MANAGER = "org.freedesktop.systemd1.Manager";
const UNIT = "org.freedesktop.systemd1.Unit";
const CROND = `${M}/unit/crond_2eservice`;
const BROKEN = `${M}/unit/broken_2eservice`;

function unit(id: string, description: string, active: string): Record<string, unknown> {
    return {
        Id: id, Names: { t: "as", v: [id] }, Description: description, LoadState: "loaded", ActiveState: active,
        SubState: active === "active" ? "running" : "failed", UnitFileState: "enabled",
        FragmentPath: `/usr/lib/systemd/system/${id}`, Job: { t: "(uo)", v: [0, "/"] },
        ActiveEnterTimestamp: { t: "t", v: 1_789_922_620_466_992 }, InactiveEnterTimestamp: { t: "t", v: 1_789_922_620_466_992 },
        RequiredBy: { t: "as", v: ["dependent.service"] },
    };
}

const SCENARIO: MockScenario = {
    dbus: {
        system: {
            [M]: {
                [MANAGER]: {
                    methods: {
                        Subscribe: { reply: [] },
                        ListUnits: {
                            reply: [[
                                ["crond.service", "Command Scheduler", "loaded", "active", "running", "", CROND, 0, "", "/"],
                                ["broken.service", "Broken Service", "loaded", "failed", "failed", "", BROKEN, 0, "", "/"],
                            ]],
                            out: ["a(ssssssouso)"],
                        },
                        ListUnitFiles: {
                            reply: [[["/usr/lib/systemd/system/crond.service", "enabled"], ["/usr/lib/systemd/system/broken.service", "enabled"]]],
                            out: ["a(ss)"],
                        },
                        LoadUnit: { byArgs: [{ args: ["crond.service"], reply: [CROND] }, { args: ["broken.service"], reply: [BROKEN] }] },
                        ListUnitsByPatterns: { reply: [[]], out: ["a(ssssssouso)"] },
                    },
                },
            },
            [CROND]: { [UNIT]: { properties: unit("crond.service", "Command Scheduler", "active") } },
            [BROKEN]: { [UNIT]: { properties: unit("broken.service", "Broken Service", "failed") } },
        },
    } as MockScenario["dbus"],
    dbusOwners: { session: { "org.freedesktop.systemd1": null } },
    spawnPatterns: [
        { match: "^journalctl .*--reverse", stdout: "" },
        { match: "^journalctl .*--follow", keepOpen: true },
    ],
};

let mock: MockBridge | null = null;

afterEach(() => {
    cleanup();
    mock?.close();
    mock = null;
});

async function start(): Promise<RenderedPage> {
    mock = await startMock(SCENARIO);
    await initInfo();
    return renderPage(ServicesPage, { columns: 100, rows: 24, allowed: true, showHints: true });
}

// eslint-disable-next-line no-control-regex
const NOT_ASCII = /[^\x00-\x7f]/;

describe("the Services page in ASCII", () => {
    it("draws the list, its key hints and the details in ASCII only", async () => {
        expect(unicode).toBe(false);
        const r = await start();
        let frame = await r.waitFor(f => f.includes("broken") && f.includes("crond") && f.includes("1 failed"));
        expect(frame).toMatch(/^2 services - 1 failed$/m);
        expect(frame).toContain("<-/-> type");
        expect(frame.match(NOT_ASCII)).toBeNull();

        // A filter on the summary line, and the details with an action asking first.
        await r.press("F");
        frame = await r.waitFor("failed only");
        expect(frame).toMatch(/^1 of 2 services - 1 failed - failed only$/m);
        expect(frame.match(NOT_ASCII)).toBeNull();
        await r.press(keys.down, keys.enter);
        frame = await r.waitFor(f => f.includes("Broken Service") && f.includes("Recent logs"));
        expect(frame.match(NOT_ASCII)).toBeNull();
        await r.press("x");
        frame = await r.waitFor("< Clear failed >");
        expect(frame.match(NOT_ASCII)).toBeNull();
        await r.press(keys.escape);
    });
});
