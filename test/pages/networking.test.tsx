/*
 * The Networking page against the mock bridge: the interfaces, their traffic
 * and the firewall's state, details, staying current from NetworkManager's
 * signals, and every action -- asserting the exact D-Bus calls each makes,
 * the checkpoint around a switch and what happens when it cannot be
 * confirmed, and that nothing is sent without administrative access or
 * before the question is answered.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import NetworkingPage, { CONFIRM_ARM_MS } from "../../src/pages/networking/index.js";
import { actionSettings } from "../../src/pages/networking/actions.js";
import { storeSettings } from "../../src/pages/networking/store.js";
import { renderPage, type RenderedPage } from "../helpers/page.js";
import { cleanup, keys } from "../helpers/ink.js";
import { startMock, type Effect, type JsonObject, type MockBridge, type MockScenario } from "../mock-bridge/harness.js";
import { initInfo } from "../../src/session.js";
import { A, D, FW_UNIT, NM, P, S, scenario, SPARE, SYSTEMD, WIRED } from "./networking.fixture.js";

let mock: MockBridge | null = null;

beforeEach(() => {
    storeSettings.timings = { trafficMs: 100 };
    actionSettings.settleMs = 20;
});

afterEach(() => {
    cleanup();
    mock?.close();
    mock = null;
    storeSettings.timings = {};
    actionSettings.settleMs = 1000;
});

async function start(s: MockScenario, options: { allowed?: boolean, columns?: number, rows?: number, showHints?: boolean, panels?: boolean } = {}): Promise<RenderedPage> {
    mock = await startMock(s);
    await initInfo();
    return renderPage(NetworkingPage, {
        columns: options.columns ?? 120, rows: options.rows ?? 30, allowed: options.allowed ?? false,
        ...(options.showHints ? { showHints: true } : {}), ...(options.panels ? { panels: true } : {}),
    });
}

/** Every D-Bus method call sent, in order: [object, "Interface.Method", args, signature]. */
function calls(): [string, string, unknown[], string | undefined][] {
    const dbus = new Set<string>();
    const out: [string, string, unknown[], string | undefined][] = [];
    for (const entry of mock!.received()) {
        if (entry.control?.command === "open" && entry.control.payload === "dbus-json3")
            dbus.add(String(entry.control.channel));
        if (entry.data === undefined || !dbus.has(entry.channel))
            continue;
        const message = JSON.parse(entry.data) as JsonObject;
        if (!Array.isArray(message.call))
            continue;
        const [path, iface, method, args] = message.call as [string, string, string, unknown[]];
        out.push([path.replace(`${P}/`, ""), `${iface.replace(`${NM}.`, "").replace(`${SYSTEMD}.`, "systemd.")}.${method}`, args, message.type as string | undefined]);
    }
    return out;
}

const READS = /GetManagedObjects|GetSettings|Subscribe|LoadUnit|GetAll|getDefaultZone|getActiveZones|getZoneSettings2|getServiceSettings2|listServices|getZoneByName/;

/** The calls that change something. */
function changes(): [string, string, unknown[], string | undefined][] {
    return calls().filter(call => !READS.test(call[1]));
}

async function select(r: RenderedPage, name: string): Promise<void> {
    for (let i = 0; i < 10; i++) {
        if (r.lastFrame().split("\n").find(l => l.startsWith("›"))?.includes(name))
            return;
        await r.press(keys.down);
    }
    throw new Error(`no row ${name}:\n${r.lastFrame()}`);
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const squash = (frame: string) => frame.split("\n").map(l => l.replace(/\s+/g, " ").trim());
/** The screen as running text: dialog borders dropped, wrapped lines joined. */
const flat = (frame: string) => frame.replace(/[│┌┐└┘─┤├]/g, " ").replace(/\s+/g, " ");
const CHECKPOINT = `${P}/Checkpoint/7`;

/** Answer the question on screen, once it may be answered. */
async function confirm(r: RenderedPage, question: string): Promise<void> {
    await r.waitFor(question);
    await wait(CONFIRM_ARM_MS + 50);
    await r.press(keys.enter);
}

describe("the list", () => {
    it("shows the interfaces with their addresses, traffic and state, the unmanaged ones marked", async () => {
        const r = await start(scenario());
        const frame = await r.waitFor("8.00 Mbps");
        const lines = squash(frame);
        expect(lines[0]).toBe("Sending 2.00 Mbps Receiving 8.00 Mbps");
        expect(lines[1]).toBe("Firewall on, 2 active zones: internal (br0), public (eth0)");
        expect(lines).toContain("› ○ br0 Bridge 192.168.100.1/24 No carrier");
        expect(lines).toContain("● eth0 Ethernet 10.0.0.5/24, fd00::5/64 2.00 Mbps 8.00 Mbps Active");
        expect(lines).toContain("○ eth1 Ethernet Inactive");
        expect(lines).toContain("○ docker0 Bridge 172.17.0.1/16 Active, unmanaged");
        // Not the loopback, nor the bridge's port.
        expect(frame).not.toMatch(/\blo\b/);
        expect(frame).not.toContain("vnet0");
    });

    it("plots what the listed interfaces send and receive, in bits per second", async () => {
        const r = await start(scenario(), { panels: true, rows: 40 });
        const frame = await r.waitFor(f => /Mbps Receiving ├─+ 8\.00 ─┐/.test(f));
        const lines = frame.split("\n");
        // Sending peaks at 2 Mbps, receiving at 8: lo's and vnet0's far larger figures are not added.
        expect(lines[0]).toMatch(/^┌─┤ Mbps Sending ├─+ 2\.00 ─┐ +┌─┤ Mbps Receiving ├─+ 8\.00 ─┐/);
        expect(lines.slice(1, 6).map(l => l.match(/^│ *([\d.]+) /)?.[1])).toEqual(["2", "1.5", "1", "0.5", "0"]);
        expect(frame).toMatch(/┤ Firewall ├─+ default zone public ─┐/);
        expect(frame).toMatch(/┤ Interfaces ├─+ NetworkManager 1\.54\.3 ─┐/);
        const open = mock!.opened("metrics1")[0]!;
        expect(open.metrics).toEqual([
            { name: "network.interface.rx", units: "bytes", derive: "rate" },
            { name: "network.interface.tx", units: "bytes", derive: "rate" },
        ]);
    });

    it("reads NetworkManager with one call and three match rules that do not overlap, and each connection's settings", async () => {
        const r = await start(scenario());
        await r.waitFor("eth0");
        await mock!.waitForReceived(e => e.data?.includes("getActiveZones") ?? false);
        const reads = calls().map(c => `${c[0]} ${c[1]}`);
        expect(reads.filter(c => c.includes("GetManagedObjects"))).toEqual(["/org/freedesktop org.freedesktop.DBus.ObjectManager.GetManagedObjects"]);
        expect(reads.filter(c => c.includes("GetSettings")).sort()).toEqual([
            "Settings/1 Settings.Connection.GetSettings", "Settings/2 Settings.Connection.GetSettings", "Settings/3 Settings.Connection.GetSettings",
        ]);
        const nm = mock!.opened("dbus-json3").find(o => o.name === NM)!;
        expect(nm).toMatchObject({ bus: "system", superuser: "try" });
        const rules = mock!.received().filter(e => e.channel === nm.channel && e.data?.includes("add-match")).map(e => JSON.parse(e.data!)["add-match"]);
        expect(rules).toEqual([
            { path: "/org/freedesktop", interface: "org.freedesktop.DBus.ObjectManager" },
            { path_namespace: P, interface: "org.freedesktop.DBus.Properties" },
            { path_namespace: P, interface: `${NM}.Settings.Connection` },
        ]);
        expect(changes()).toEqual([]);
    });

    it("says so when NetworkManager is not there", async () => {
        const r = await start({ dbusOwners: { system: { [NM]: null } } });
        await r.waitFor("NetworkManager is not running on this host");
    });

    it("says when the firewall is off, or not installed", async () => {
        const off = await start(scenario({}, {}, { active: false, enabled: false }));
        await off.waitFor("Firewall off");
        cleanup();
        mock!.close();
        const s = scenario();
        (s.dbus!.system![FW_UNIT] as Record<string, { properties: Record<string, unknown> }>)[`${SYSTEMD}.Unit`]!.properties.LoadState = "not-found";
        const none = await start(s);
        await none.waitFor("Firewall firewalld is not installed");
    });

    it("follows NetworkManager's signals: an interface that goes down, a device that appears", async () => {
        const s = scenario({
            manager: {
                Reload: {
                    reply: [],
                    effects: [
                        { properties: [`${D}/2`, `${NM}.Device`, { State: { t: "u", v: 30 }, ActiveConnection: { t: "o", v: "/" } }] },
                        { removed: [`${A}/2`] },
                        { added: [`${D}/9`, { [`${NM}.Device`]: { Interface: "wg0", DeviceType: { t: "u", v: 29 }, State: { t: "u", v: 30 }, Managed: true } }] },
                        // A checkpoint an action elsewhere made: not ours to show.
                        { added: [`${P}/Checkpoint/3`, { [`${NM}.Checkpoint`]: { Devices: { t: "ao", v: [] } } }] },
                    ],
                },
            },
        });
        const r = await start(s);
        await r.waitFor("8.00 Mbps");
        const cockpit = (await import("../../src/cockpit.js")).default;
        const client = cockpit.dbus(NM, { bus: "system" });
        await client.call(P, NM, "Reload", [0], { type: "u" });
        client.close();
        const frame = await r.waitFor(f => f.includes("wg0") && /eth0\s+Ethernet.*Inactive/.test(f));
        expect(squash(frame)).toContain("○ wg0 WireGuard Inactive");
    });

    it("keeps names and states when the terminal is narrow", async () => {
        const r = await start(scenario(), { columns: 60, rows: 20 });
        const frame = await r.waitFor("docker0");
        expect(frame).toContain("No carrier");
        for (const line of frame.split("\n"))
            expect(line.length).toBeLessThanOrEqual(60);
    });
});

describe("details", () => {
    it("shows an interface's details and goes back to its row", async () => {
        const r = await start(scenario());
        await r.waitFor("8.00 Mbps");
        await select(r, "eth0");
        await r.press(keys.enter);
        const frame = await r.waitFor("Connect automatically");
        expect(frame).toMatch(/Carrier\s+1000 Mbps/);
        expect(frame).toMatch(/IPv4 gateway\s+10\.0\.0\.1/);
        expect(frame).toMatch(/DNS\s+10\.0\.0\.1, 1\.1\.1\.1/);
        expect(frame).toMatch(/Connection\s+Wired/);
        expect(frame).toMatch(/Receiving\s+8\.00 Mbps/);
        expect(frame).toContain("Changing it requires administrative access: press A.");
        await r.press(keys.escape);
        const back = await r.waitFor("Firewall");
        expect(back.split("\n").find(l => l.startsWith("›"))).toContain("eth0");
    });

    it("goes to NetworkManager's log", async () => {
        const r = await start(scenario());
        await r.waitFor("eth0");
        await r.press("l");
        expect(r.navigations).toEqual([["logs", { unit: { name: "NetworkManager.service" } }]]);
    });
});

describe("access", () => {
    it("offers no action without administrative access, and refuses the keys with the reason", async () => {
        const r = await start(scenario(), { showHints: true });
        await r.waitFor("8.00 Mbps");
        await select(r, "eth0");
        expect(r.lastFrame()).toMatch(/hints: enter details \| f firewall rules \| l logs\s*$/m);
        await r.press("d");
        await r.waitFor("status: warning: To switch off, turn on administrative access first: press A");
        await r.press("F");
        await r.waitFor("status: warning: To switch the firewall, turn on administrative access first: press A");
        expect(changes()).toEqual([]);
    });

    it("offers what the selected interface can do with access, and nothing for an unmanaged one", async () => {
        const r = await start(scenario(), { allowed: true, showHints: true });
        await r.waitFor("8.00 Mbps");
        await select(r, "eth0");
        await r.waitFor(/hints: enter details \| d switch off \| o no auto-connect \| f firewall rules \| F firewall off \| l logs/);
        await select(r, "eth1");
        await r.waitFor(/hints: enter details \| a switch on \| o auto-connect \| f firewall rules \| F firewall off \| l logs/);
        await select(r, "docker0");
        await r.waitFor(/hints: enter details \| f firewall rules \| F firewall off \| l logs/);
        await r.press("d", "a", "o");
        await wait(100);
        expect(r.lastFrame()).not.toContain("Switch off docker0");
        expect(changes()).toEqual([]);
    });
});

describe("switching an interface", () => {
    const checkpointed = (extra: Record<string, unknown> = {}) => ({
        CheckpointCreate: { in: ["ao", "u", "u"], out: ["o"], reply: [CHECKPOINT] },
        CheckpointDestroy: { in: ["o"], reply: [] },
        ...extra,
    });

    it("switches off under a checkpoint that is destroyed once the change has settled", async () => {
        const s = scenario({
            manager: checkpointed(),
            eth0: { Disconnect: { reply: [], effects: [{ properties: [`${D}/2`, `${NM}.Device`, { State: { t: "u", v: 30 }, ActiveConnection: { t: "o", v: "/" } }] }] } },
        });
        const r = await start(s, { allowed: true });
        await r.waitFor("8.00 Mbps");
        await select(r, "eth0");
        await r.press("d");
        const question = await r.waitFor("Switch off eth0?");
        expect(flat(question)).toContain("NetworkManager undoes the change by itself after 7 seconds");
        // Asked, not done.
        expect(changes()).toEqual([]);
        await confirm(r, "Switch off eth0?");
        await r.waitFor("status: success: Switched off eth0");
        expect(changes()).toEqual([
            ["/org/freedesktop/NetworkManager", "org.freedesktop.NetworkManager.CheckpointCreate", [[`${D}/2`], 7, 0], "aouu"],
            ["Devices/2", "Device.Disconnect", [], ""],
            ["/org/freedesktop/NetworkManager", "org.freedesktop.NetworkManager.CheckpointDestroy", [CHECKPOINT], "o"],
        ]);
        await r.waitFor(/eth0\s+Ethernet.*Inactive/);
    });

    it("switches on with the connection that fits", async () => {
        const s = scenario({ manager: checkpointed({ ActivateConnection: { in: ["o", "o", "o"], out: ["o"], reply: [`${A}/8`] } }) });
        const r = await start(s, { allowed: true });
        await r.waitFor("8.00 Mbps");
        await select(r, "eth1");
        await r.press("a");
        await confirm(r, "Switch on eth1?");
        await r.waitFor("status: success: Switched on eth1");
        expect(changes().map(c => [c[1], c[2]])).toEqual([
            ["org.freedesktop.NetworkManager.CheckpointCreate", [[`${D}/3`], 7, 0]],
            ["org.freedesktop.NetworkManager.ActivateConnection", [`${S}/2`, `${D}/3`, "/"]],
            ["org.freedesktop.NetworkManager.CheckpointDestroy", [CHECKPOINT]],
        ]);
    });

    it("says when the switch broke the connection and was undone, and makes it anyway only when asked to", async () => {
        const s = scenario({
            manager: checkpointed({
                // The checkpoint is gone when it is to be confirmed: NetworkManager has rolled back.
                CheckpointDestroy: { error: ["org.freedesktop.NetworkManager.InvalidArguments", ["checkpoint /org/freedesktop/NetworkManager/Checkpoint/7 does not exist"]] },
            }),
            eth0: { Disconnect: { reply: [] } },
        });
        const r = await start(s, { allowed: true });
        await r.waitFor("8.00 Mbps");
        await select(r, "eth0");
        await r.press("d");
        await confirm(r, "Switch off eth0?");
        await r.waitFor(f => flat(f).includes("broke the connection to the server"));
        // The button is offered once the question has been up a moment.
        await r.waitFor("Switch off anyway");
        expect(changes().map(c => c[1].split(".").at(-1))).toEqual(["CheckpointCreate", "Disconnect", "CheckpointDestroy"]);

        // Esc leaves it at that.
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Switch off anyway"));
        expect(changes()).toHaveLength(3);

        // Anyway: the change alone, no checkpoint.
        await r.press("d");
        await confirm(r, "Switch off eth0?");
        await confirm(r, "Switch off anyway");
        await r.waitFor("status: success: Switched off eth0");
        expect(changes().slice(3).map(c => c[1].split(".").at(-1))).toEqual(["CheckpointCreate", "Disconnect", "CheckpointDestroy", "Disconnect"]);
    }, 15_000);

    it("destroys the checkpoint and keeps the reason on screen when the change itself is refused", async () => {
        const s = scenario({
            manager: checkpointed(),
            eth0: { Disconnect: { error: ["org.freedesktop.NetworkManager.Device.NotActive", ["Cannot disconnect an inactive device."]] } },
        });
        const r = await start(s, { allowed: true });
        await r.waitFor("8.00 Mbps");
        await select(r, "eth0");
        await r.press("d");
        await confirm(r, "Switch off eth0?");
        await r.waitFor("Cannot disconnect an inactive device.");
        // Nothing changed: no rollback, which would reconnect the device for nothing.
        expect(changes().map(c => c[1].split(".").at(-1))).toEqual(["CheckpointCreate", "Disconnect", "CheckpointDestroy"]);
        expect(r.lastFrame()).not.toContain("anyway");
    });

    it("makes the change without a checkpoint on a NetworkManager that has none", async () => {
        const s = scenario({
            manager: { CheckpointCreate: { error: ["org.freedesktop.DBus.Error.UnknownMethod", ["No such method CheckpointCreate"]] } },
            eth0: { Disconnect: { reply: [] } },
        });
        const r = await start(s, { allowed: true });
        await r.waitFor("8.00 Mbps");
        await select(r, "eth0");
        await r.press("d");
        await confirm(r, "Switch off eth0?");
        await r.waitFor("status: success: Switched off eth0");
        expect(changes().map(c => c[1].split(".").at(-1))).toEqual(["CheckpointCreate", "Disconnect"]);
    });

    it("does nothing when the question is cancelled, or answered by a key typed on", async () => {
        const r = await start(scenario(), { allowed: true });
        await r.waitFor("8.00 Mbps");
        await select(r, "eth0");
        await r.press("d", keys.enter);
        await r.waitFor("Switch off eth0?");
        await wait(100);
        expect(changes()).toEqual([]);
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Switch off eth0?"));
        expect(changes()).toEqual([]);
    });
});

describe("connect automatically", () => {
    it("writes the connection's settings back with that one key changed", async () => {
        const updated = { ...WIRED, connection: { ...WIRED.connection, autoconnect: { t: "b", v: false } } };
        const s = scenario({
            wired: {
                Update: {
                    reply: [],
                    effects: [{ signal: [`${S}/1`, `${NM}.Settings.Connection`, "Updated", []] }],
                },
            },
        });
        const r = await start(s, { allowed: true });
        await r.waitFor("8.00 Mbps");
        await select(r, "eth0");
        await r.press("o");
        await confirm(r, "Stop eth0 from connecting by itself?");
        await r.waitFor("status: success: eth0 no longer connects automatically");
        expect(changes()).toEqual([["Settings/1", "Settings.Connection.Update", [updated], "a{sa{sv}}"]]);
        // The settings are read again when NetworkManager says they changed.
        await mock!.waitForReceived(e => (e.data?.includes("GetSettings") ?? false) && calls().filter(c => c[0] === "Settings/1" && c[1].endsWith("GetSettings")).length === 2);
    });

    it("turns it on for a connection that has it off", async () => {
        const s = scenario({ spare: { Update: { reply: [] } } });
        const r = await start(s, { allowed: true });
        await r.waitFor("8.00 Mbps");
        await select(r, "eth1");
        await r.press("o");
        await confirm(r, "Have eth1 connect by itself");
        await r.waitFor("status: success: eth1 connects automatically");
        const [, , args] = changes()[0]!;
        expect((args[0] as typeof SPARE).connection!.autoconnect).toEqual({ t: "b", v: true });
        expect((args[0] as typeof SPARE).ipv4).toEqual(SPARE.ipv4);
    });
});

describe("the firewall", () => {
    it("is switched off by disabling and stopping its unit, and the page shows it", async () => {
        const off: Effect[] = [
            { properties: [FW_UNIT, `${SYSTEMD}.Unit`, { ActiveState: "inactive", UnitFileState: "disabled" }] },
        ];
        const s = scenario({}, {}, { active: true, enabled: true }, {
            DisableUnitFiles: { in: ["as", "b"], reply: [[]] },
            Reload: null,
            StopUnit: { in: ["s", "s"], out: ["o"], reply: ["/org/freedesktop/systemd1/job/5"], effects: off },
        });
        const r = await start(s, { allowed: true });
        await r.waitFor("Firewall on");
        await r.press("F");
        const question = await r.waitFor("Switch firewalld off, now and at every boot?");
        expect(flat(question)).toContain("Every port a service listens on is then reachable");
        expect(changes()).toEqual([]);
        await confirm(r, "Switch firewalld off");
        await r.waitFor("status: success: Switched the firewall off");
        expect(changes().map(c => [c[1], c[2], c[3]])).toEqual([
            ["systemd.Manager.DisableUnitFiles", [["firewalld.service"], false], "asb"],
            ["systemd.Manager.Reload", [], ""],
            ["systemd.Manager.StopUnit", ["firewalld.service", "replace"], "ss"],
        ]);
        await r.waitFor("Firewall off");
    });

    it("is switched on by enabling and starting it, with a warning about being locked out", async () => {
        const s = scenario({}, {}, { active: false, enabled: false }, {
            EnableUnitFiles: { in: ["as", "b", "b"], reply: [true, []] },
            Reload: null,
            StartUnit: { in: ["s", "s"], out: ["o"], reply: ["/org/freedesktop/systemd1/job/6"] },
        });
        const r = await start(s, { allowed: true });
        await r.waitFor("Firewall off");
        await r.press("F");
        const question = await r.waitFor("Switch firewalld on, now and at every boot?");
        expect(flat(question)).toContain("you are locked out");
        await confirm(r, "Switch firewalld on");
        await r.waitFor("status: success: Switched the firewall on");
        expect(changes().map(c => [c[1], c[2]])).toEqual([
            ["systemd.Manager.EnableUnitFiles", [["firewalld.service"], false, false]],
            ["systemd.Manager.Reload", []],
            ["systemd.Manager.StartUnit", ["firewalld.service", "replace"]],
        ]);
    });
});

describe("the firewall's rules", () => {
    const FW = "org.fedoraproject.FirewallD1";
    const FWP = "/org/fedoraproject/FirewallD1";
    const ZONE = `${FWP}/config/zone/0`;
    const service = (short: string, ports: [string, string][]) => ({ short: { t: "s", v: short }, description: { t: "s", v: "" }, ports: { t: "a(ss)", v: ports } });
    const SERVICES: Record<string, ReturnType<typeof service>> = {
        ssh: service("SSH", [["22", "tcp"]]),
        cockpit: service("Cockpit", [["9090", "tcp"]]),
        dns: service("DNS", [["53", "tcp"], ["53", "udp"]]),
        http: service("WWW (HTTP)", [["80", "tcp"]]),
        https: service("Secure WWW (HTTPS)", [["443", "tcp"]]),
    };
    const zoneSettings = (services: string[], ports: [string, string][], interfaces: string[]) => ({
        services: { t: "as", v: services }, ports: { t: "a(ss)", v: ports }, interfaces: { t: "as", v: interfaces }, sources: { t: "as", v: [] },
    });

    /** The scenario with firewalld answering as it does for root: zone settings, services, and the calls that change them. */
    function rules(zoneMethods: Record<string, unknown> = {}, configMethods: Record<string, unknown> = {}): MockScenario {
        const s = scenario();
        const tree = s.dbus!.system as Record<string, Record<string, { properties?: unknown, methods?: Record<string, unknown> }>>;
        tree[FWP]![FW]!.methods = {
            ...tree[FWP]![FW]!.methods,
            listServices: { out: ["as"], reply: [Object.keys(SERVICES)] },
            getServiceSettings2: {
                in: ["s"], out: ["a{sv}"],
                error: ["org.fedoraproject.FirewallD1.Exception", ["INVALID_SERVICE"]],
                byArgs: Object.entries(SERVICES).map(([id, settings]) => ({ args: [id], reply: [settings] })),
            },
        };
        tree[FWP]![`${FW}.zone`]!.methods = {
            ...tree[FWP]![`${FW}.zone`]!.methods,
            getZoneSettings2: {
                in: ["s"], out: ["a{sv}"],
                byArgs: [
                    { args: ["public"], reply: [zoneSettings(["ssh", "cockpit"], [["8080", "tcp"]], ["eth0"])] },
                    { args: ["internal"], reply: [zoneSettings(["dns"], [], ["br0"])] },
                ],
            },
            ...zoneMethods,
        };
        tree[`${FWP}/config`] = { [`${FW}.config`]: { methods: { getZoneByName: { in: ["s"], out: ["o"], reply: [ZONE] } } } };
        tree[ZONE] = { [`${FW}.config.zone`]: { methods: configMethods } };
        return s;
    }

    async function open(s: MockScenario, allowed = true): Promise<RenderedPage> {
        const r = await start(s, { allowed, showHints: true });
        await r.waitFor("Firewall on");
        await r.press("f");
        return r;
    }

    const fwChanges = () => changes().filter(c => c[0].includes("FirewallD1")).map(c => [c[0].replace(FWP, "fw"), c[1].replace(`${FW}.`, ""), c[2], c[3]]);

    it("lists each active zone with the services and ports it lets in", async () => {
        const r = await open(rules());
        const frame = await r.waitFor("cockpit");
        const lines = squash(frame);
        expect(lines).toContain("› internal br0 zone");
        expect(lines).toContain("dns 53 53 DNS");
        expect(lines).toContain("public eth0 zone");
        expect(lines).toContain("cockpit 9090 Cockpit");
        expect(lines).toContain("ssh 22 SSH");
        expect(lines).toContain("8080/tcp 8080 custom port");
        expect(frame).toMatch(/hints: esc back \| a add services \| p open ports \| ctrl\+r refresh/);
        // Read, not changed.
        expect(fwChanges()).toEqual([]);
        await r.press(keys.escape);
        await r.waitFor("Firewall on");
    });

    it("needs administrative access to read them, and says so", async () => {
        const r = await open(rules(), false);
        await r.waitFor("can only be read and changed with administrative access");
        expect(calls().some(c => c[1].includes("getZoneSettings2"))).toBe(false);
        await r.press("a", "p", "d");
        expect(fwChanges()).toEqual([]);
        await r.press(keys.escape);
        await r.waitFor("Firewall on");
    });

    it("says there are no rules in force when the firewall is off", async () => {
        const s = rules();
        const unit = (s.dbus!.system![FW_UNIT] as Record<string, { properties: Record<string, unknown> }>)[`${SYSTEMD}.Unit`]!;
        unit.properties.ActiveState = "inactive";
        const r = await start(s, { allowed: true });
        await r.waitFor("Firewall off");
        await r.press("f");
        await r.waitFor("The firewall is off: there are no rules in force.");
    });

    it("adds services picked from firewalld's list: to the running firewall and to its permanent configuration", async () => {
        const r = await open(rules({ addService: { in: ["s", "s", "i"], out: ["s"], reply: ["public"] } }, { addService: { in: ["s"], reply: [] } }));
        await r.waitFor("cockpit");
        await r.press(keys.down, keys.down, "a");
        const picker = await r.waitFor("Add services to public");
        await r.waitFor("https");
        // Only what the zone does not have yet.
        expect(picker.includes("[ ] ssh")).toBe(false);
        expect(r.lastFrame()).toMatch(/\[ \] dns\s+tcp 53 {2}udp 53/);
        // Typing narrows the list.
        await r.press("http");
        await r.waitFor("2 services");
        expect(r.lastFrame()).not.toContain("[ ] dns");
        await r.press(" ", keys.down, " ");
        await r.waitFor("2 marked");
        expect(fwChanges()).toEqual([]);
        await r.press(keys.enter);
        await r.waitFor("status: success: Added 2 services to public");
        expect(fwChanges()).toEqual([
            ["fw", "zone.addService", ["public", "http", 0], "ssi"],
            ["fw/config/zone/0", "config.zone.addService", ["http"], "s"],
            ["fw", "zone.addService", ["public", "https", 0], "ssi"],
            ["fw/config/zone/0", "config.zone.addService", ["https"], "s"],
        ]);
        // The rules are read again afterwards.
        expect(calls().filter(c => c[1].endsWith("getActiveZones")).length).toBeGreaterThanOrEqual(2);
    });

    it("opens custom ports, checked before anything is sent", async () => {
        const r = await open(rules({ addPort: { in: ["s", "s", "s", "i"], out: ["s"], reply: ["public"] } }, { addPort: { in: ["s", "s"], reply: [] } }));
        await r.waitFor("cockpit");
        await r.press(keys.down, keys.down, "p");
        await r.waitFor("Open ports in public");
        await r.press(keys.enter);
        await r.waitFor("Give at least one port");
        await r.press("80, x", keys.enter);
        await r.waitFor("Not a port or a range of ports: x");
        await r.press(...Array(5).fill(keys.backspace), "9000-9010, 8443", keys.down, "70000", keys.enter);
        await r.waitFor("Ports are numbers from 1 to 65535: 70000");
        expect(fwChanges()).toEqual([]);
        await r.press(...Array(5).fill(keys.backspace), "5353", keys.enter);
        await r.waitFor("status: success: Opened 9000-9010/tcp, 8443/tcp, 5353/udp in public");
        expect(fwChanges()).toEqual([
            ["fw", "zone.addPort", ["public", "9000-9010", "tcp", 0], "sssi"],
            ["fw/config/zone/0", "config.zone.addPort", ["9000-9010", "tcp"], "ss"],
            ["fw", "zone.addPort", ["public", "8443", "tcp", 0], "sssi"],
            ["fw/config/zone/0", "config.zone.addPort", ["8443", "tcp"], "ss"],
            ["fw", "zone.addPort", ["public", "5353", "udp", 0], "sssi"],
            ["fw/config/zone/0", "config.zone.addPort", ["5353", "udp"], "ss"],
        ]);
    }, 10_000);

    it("removes a service after asking, warning when it is what lets the user in", async () => {
        const r = await open(rules({ removeService: { in: ["s", "s"], out: ["s"], reply: ["public"] } }, { removeService: { in: ["s"], reply: [] } }));
        await r.waitFor("cockpit");
        for (let i = 0; i < 10 && !(r.lastFrame().split("\n").find(l => l.startsWith("›")) ?? "").includes("ssh"); i++)
            await r.press(keys.down);
        await r.waitFor(/hints: esc back \| a add services \| p open ports \| d remove/);
        await r.press("d");
        const question = await r.waitFor("Remove ssh from the zone public?");
        expect(flat(question)).toContain("Its ports (TCP 22) are then closed to eth0");
        expect(flat(question)).toContain("ssh logins, cockpit-tui over --host among them: if you are connected that way, you are locked out");
        expect(fwChanges()).toEqual([]);
        await wait(CONFIRM_ARM_MS + 50);
        await r.press(keys.enter);
        await r.waitFor("status: success: Removed ssh from public");
        expect(fwChanges()).toEqual([
            ["fw", "zone.removeService", ["public", "ssh"], "ss"],
            ["fw/config/zone/0", "config.zone.removeService", ["ssh"], "s"],
        ]);
    });

    it("closes a custom port, and keeps firewalld's reason on screen when it refuses", async () => {
        const r = await open(rules(
            { removePort: { in: ["s", "s", "s"], error: ["org.fedoraproject.FirewallD1.Exception", ["NOT_ENABLED: '8080:tcp' not in 'public'"]] } }));
        await r.waitFor("cockpit");
        await r.press(keys.end, "d");
        await r.waitFor("Close port 8080/tcp in the zone public");
        await wait(CONFIRM_ARM_MS + 50);
        await r.press(keys.enter);
        await r.waitFor("NOT_ENABLED: '8080:tcp' not in 'public'");
        expect(fwChanges()).toEqual([["fw", "zone.removePort", ["public", "8080", "tcp"], "sss"]]);
    });

    it("does not offer to remove a zone", async () => {
        const r = await open(rules());
        await r.waitFor("cockpit");
        await r.press("d");
        await wait(100);
        expect(r.lastFrame()).not.toContain("Remove");
        expect(fwChanges()).toEqual([]);
    });
});
