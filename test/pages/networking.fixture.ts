/*
 * A made-up host's NetworkManager for the Networking tests, in the shapes
 * NetworkManager 1.54 sends through cockpit-bridge 356 (captured once,
 * read-only; no real addresses are kept):
 *
 *   eth0    ethernet, active, 10.0.0.5/24, "Wired" (auto-connects)
 *   eth1    ethernet, disconnected, could use "Spare" (does not auto-connect)
 *   br0     bridge, active, 192.168.100.1/24, no carrier; vnet0 is its port
 *   lo      loopback
 *   docker0 bridge, not managed by NetworkManager
 */
import { parseManagedObjects, type Objects } from "../../src/lib/objects.js";
import type { InterfaceSpec, MethodSpec, MockScenario } from "../mock-bridge/harness.js";

export const NM = "org.freedesktop.NetworkManager";
export const P = "/org/freedesktop/NetworkManager";
export const D = `${P}/Devices`;
export const S = `${P}/Settings`;
export const A = `${P}/ActiveConnection`;
export const SYSTEMD = "org.freedesktop.systemd1";
export const FW_UNIT = "/org/freedesktop/systemd1/unit/firewalld_2eservice";

type Tree = Record<string, Record<string, InterfaceSpec>>;
const props = (properties: Record<string, unknown>, methods?: Record<string, MethodSpec | null>): InterfaceSpec =>
    ({ properties, ...(methods ? { methods } : {}) }) as InterfaceSpec;
const o = (path: string) => ({ t: "o", v: path });
const u = (value: number) => ({ t: "u", v: value });

export function device(name: string, type: number, state: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        Interface: name, DeviceType: u(type), State: u(state), Managed: state !== 10, HwAddress: "52:54:00:00:00:01",
        Mtu: u(1500), Driver: type === 1 ? "virtio_net" : "", ActiveConnection: o("/"), Ip4Config: o("/"), Ip6Config: o("/"),
        AvailableConnections: { t: "ao", v: [] }, ...extra,
    };
}

function active(id: string, settings: string, dev: string, controller = "/"): Record<string, unknown> {
    return {
        Id: id, Connection: o(settings), Devices: { t: "ao", v: [dev] }, State: u(2), Ip4Config: o("/"), Ip6Config: o("/"),
        Controller: o(controller), Master: o(controller),
    };
}

function ip4(addresses: [string, number][], gateway = "", dns: string[] = []): Record<string, unknown> {
    return {
        AddressData: { t: "aa{sv}", v: addresses.map(([address, prefix]) => ({ address: { t: "s", v: address }, prefix: u(prefix) })) },
        Gateway: gateway,
        NameserverData: { t: "aa{sv}", v: dns.map(address => ({ address: { t: "s", v: address } })) },
    };
}

export function settings(id: string, iface: string, autoconnect: boolean | null, timestamp = 0): Record<string, Record<string, unknown>> {
    return {
        connection: {
            id: { t: "s", v: id }, "interface-name": { t: "s", v: iface }, type: { t: "s", v: "802-3-ethernet" },
            uuid: { t: "s", v: `uuid-${id}` }, timestamp: { t: "t", v: timestamp },
            ...(autoconnect === null ? {} : { autoconnect: { t: "b", v: autoconnect } }),
        },
        ipv4: { method: { t: "s", v: "auto" } },
        ipv6: { method: { t: "s", v: "ignore" } },
    };
}

const connection = (s: Record<string, Record<string, unknown>>, methods: Record<string, MethodSpec | null> = {}): InterfaceSpec =>
    props({ Unsaved: false, Filename: "/etc/NetworkManager/system-connections/x.nmconnection" },
          { GetSettings: { out: ["a{sa{sv}}"], reply: [s] }, ...methods });

export const WIRED = settings("Wired", "eth0", null, 200);
export const SPARE = settings("Spare", "eth1", false, 100);

export interface Methods {
    readonly manager?: Record<string, MethodSpec | null>;
    readonly eth0?: Record<string, MethodSpec | null>;
    readonly eth1?: Record<string, MethodSpec | null>;
    readonly wired?: Record<string, MethodSpec | null>;
    readonly spare?: Record<string, MethodSpec | null>;
}

export function tree(methods: Methods = {}): Tree {
    return {
        "/org/freedesktop": { "org.freedesktop.DBus.ObjectManager": {} },
        [P]: { [NM]: props({ Version: "1.54.3", NetworkingEnabled: true, State: u(70) }, methods.manager ?? {}) },
        [`${D}/1`]: { [`${NM}.Device`]: props(device("lo", 32, 100, { ActiveConnection: o(`${A}/1`) })) },
        [`${D}/2`]: {
            [`${NM}.Device`]: props(device("eth0", 1, 100, {
                ActiveConnection: o(`${A}/2`), Ip4Config: o(`${P}/IP4Config/2`), Ip6Config: o(`${P}/IP6Config/2`),
                AvailableConnections: { t: "ao", v: [`${S}/1`] },
            }), methods.eth0 ?? {}),
            [`${NM}.Device.Wired`]: props({ Carrier: true, Speed: u(1000) }),
        },
        [`${D}/3`]: {
            [`${NM}.Device`]: props(device("eth1", 1, 30, { AvailableConnections: { t: "ao", v: [`${S}/2`] }, HwAddress: "52:54:00:00:00:02" }), methods.eth1 ?? {}),
            [`${NM}.Device.Wired`]: props({ Carrier: true, Speed: u(100) }),
        },
        [`${D}/4`]: {
            [`${NM}.Device`]: props(device("br0", 13, 100, { ActiveConnection: o(`${A}/3`), Ip4Config: o(`${P}/IP4Config/3`) })),
            // A bridge's carrier is on its own interface, not Device.Wired.
            [`${NM}.Device.Bridge`]: props({ Carrier: false, HwAddress: "52:54:00:00:00:03" }),
        },
        [`${D}/5`]: { [`${NM}.Device`]: props(device("vnet0", 16, 100, { ActiveConnection: o(`${A}/4`) })) },
        [`${D}/6`]: { [`${NM}.Device`]: props(device("docker0", 13, 10, { Ip4Config: o(`${P}/IP4Config/6`) })) },
        [`${A}/1`]: { [`${NM}.Connection.Active`]: props(active("lo", `${S}/9`, `${D}/1`)) },
        [`${A}/2`]: {
            [`${NM}.Connection.Active`]: props({
                ...active("Wired", `${S}/1`, `${D}/2`), Ip4Config: o(`${P}/IP4Config/2`), Ip6Config: o(`${P}/IP6Config/2`),
            }),
        },
        [`${A}/3`]: { [`${NM}.Connection.Active`]: props({ ...active("br0", `${S}/3`, `${D}/4`), Ip4Config: o(`${P}/IP4Config/3`) }) },
        [`${A}/4`]: { [`${NM}.Connection.Active`]: props(active("vnet0", `${S}/4`, `${D}/5`, `${D}/4`)) },
        [`${P}/IP4Config/2`]: { [`${NM}.IP4Config`]: props(ip4([["10.0.0.5", 24]], "10.0.0.1", ["10.0.0.1", "1.1.1.1"])) },
        [`${P}/IP6Config/2`]: {
            [`${NM}.IP6Config`]: props({
                ...ip4([["fd00::5", 64], ["fe80::5054:ff:fe00:1", 64]]), Nameservers: { t: "aay", v: [] },
            }),
        },
        [`${P}/IP4Config/3`]: { [`${NM}.IP4Config`]: props(ip4([["192.168.100.1", 24]])) },
        [`${P}/IP4Config/6`]: { [`${NM}.IP4Config`]: props(ip4([["172.17.0.1", 16]])) },
        [`${S}/1`]: { [`${NM}.Settings.Connection`]: connection(WIRED, methods.wired) },
        [`${S}/2`]: { [`${NM}.Settings.Connection`]: connection(SPARE, methods.spare) },
        [`${S}/3`]: { [`${NM}.Settings.Connection`]: connection(settings("br0", "br0", null)) },
    };
}

/** The tree as the page's model sees it after GetManagedObjects. */
export function objects(): Objects {
    const managed: Record<string, Record<string, unknown>> = {};
    for (const [path, interfaces] of Object.entries(tree())) {
        if (path === "/org/freedesktop")
            continue;
        managed[path] = Object.fromEntries(Object.entries(interfaces).map(([iface, spec]) => [iface, spec.properties ?? {}]));
    }
    return parseManagedObjects(managed);
}

/** systemd with firewalld's unit, and firewalld itself answering what an unprivileged caller may ask. */
export function firewallTree(state: { active: boolean, enabled: boolean }, manager: Record<string, MethodSpec | null> = {}): Tree {
    return {
        "/org/freedesktop/systemd1": {
            [`${SYSTEMD}.Manager`]: props({ Version: "252" }, {
                Subscribe: null,
                LoadUnit: { in: ["s"], out: ["o"], reply: [FW_UNIT] },
                ...manager,
            }),
        },
        [FW_UNIT]: {
            [`${SYSTEMD}.Unit`]: props({
                Id: "firewalld.service", LoadState: "loaded", ActiveState: state.active ? "active" : "inactive",
                UnitFileState: state.enabled ? "enabled" : "disabled",
            }),
        },
        "/org/fedoraproject/FirewallD1": {
            "org.fedoraproject.FirewallD1": props({}, { getDefaultZone: { out: ["s"], reply: ["public"] } }),
            "org.fedoraproject.FirewallD1.zone": props({}, {
                getActiveZones: { out: ["a{sa{sas}}"], reply: [{ public: { interfaces: ["eth0"] }, internal: { interfaces: ["br0"], sources: [] } }] },
            }),
        },
    };
}

const MBIT = 125_000; // bytes per second in one megabit per second

export function scenario(methods: Methods = {}, extra: Partial<MockScenario> = {}, firewall = { active: true, enabled: true },
                         systemd: Record<string, MethodSpec | null> = {}): MockScenario {
    return {
        dbus: { system: { ...tree(methods), ...firewallTree(firewall, systemd) } },
        metrics: {
            // Counters, sampled every 100 ms in tests: eth0 sends 2 Mbps and receives 8; lo and vnet0 are not counted.
            "network.interface.tx": { samples: [0, 1, 2, 3, 4, 5, 6].map(n => ({ eth0: n * 2 * MBIT / 10, lo: n * 99 * MBIT, vnet0: n * 50 * MBIT, br0: 0 })) },
            "network.interface.rx": { samples: [0, 1, 2, 3, 4, 5, 6].map(n => ({ eth0: n * 8 * MBIT / 10, lo: n * 99 * MBIT, vnet0: n * 50 * MBIT, br0: 0 })) },
        },
        superuser: true,
        ...extra,
    } as MockScenario;
}
