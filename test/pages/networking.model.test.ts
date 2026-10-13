/*
 * The Networking page's pure half: interfaces from NetworkManager's objects,
 * their state in words, settings, what each can do, details, and the firewall.
 */
import { describe, it, expect } from "vitest";
import {
    addressText, autoconnect, buildInterfaces, deviceStateText, firewallText, formatBitRate, I, ifaceActions, ifaceSections,
    isLinkLocal6, mainConnection, methodText, NO_FIREWALL, parseActiveZones, withAutoconnect, type Settings,
} from "../../src/pages/networking/model.js";
import { parsePorts, parseService, parseZone, portList, ruleRows } from "../../src/pages/networking/firewall.js";
import { D, device, NM, objects, S, SPARE, WIRED } from "./networking.fixture.js";

const lists = buildInterfaces(objects());
const iface = (name: string) => [...lists.managed, ...lists.unmanaged].find(i => i.name === name)!;
const settings = new Map<string, Settings>([[`${S}/1`, WIRED as Settings], [`${S}/2`, SPARE as Settings]]);

describe("the interfaces", () => {
    it("lists NetworkManager's own by name, the others apart; not the loopback, nor a bridge's ports", () => {
        expect(lists.managed.map(i => i.name)).toEqual(["br0", "eth0", "eth1"]);
        expect(lists.unmanaged.map(i => i.name)).toEqual(["docker0"]);
    });

    it("reads an active interface: connection, addresses without the link-local one, gateway, name servers", () => {
        expect(iface("eth0")).toMatchObject({
            path: `${D}/2`, type: "ethernet", typeLabel: "Ethernet", state: 100, stateText: "Active", managed: true,
            carrier: true, speed: 1000, mac: "52:54:00:00:00:01", mtu: 1500, driver: "virtio_net",
            connection: { id: "Wired", settings: `${S}/1` },
            addresses4: ["10.0.0.5/24"], addresses6: ["fd00::5/64"], linkLocal6: ["fe80::5054:ff:fe00:1/64"],
            gateway4: "10.0.0.1", dns: ["10.0.0.1", "1.1.1.1"], showTraffic: true,
        });
        expect(addressText(iface("eth0"))).toBe("10.0.0.5/24, fd00::5/64");
    });

    it("says no carrier for an active one without, lists a bridge's ports, and what an inactive one could use", () => {
        expect(iface("br0")).toMatchObject({ stateText: "No carrier", carrier: false, speed: null, ports: ["vnet0"], showTraffic: false });
        expect(iface("eth1")).toMatchObject({ state: 30, stateText: "Inactive", connection: null, available: [`${S}/2`], addresses4: [] });
    });

    it("shows an unmanaged device with what it has, as upstream does", () => {
        expect(iface("docker0")).toMatchObject({ managed: false, addresses4: ["172.17.0.1/16"], stateText: "", showTraffic: true });
        // With nothing on it at all: inactive.
        const bare = new Map(objects());
        bare.set(`${D}/7`, { [I.device]: Object.fromEntries(Object.entries(device("dummy0", 22, 10)).map(([k, v]) => [k, (v as { v?: unknown })?.v ?? v])) });
        expect(buildInterfaces(bare).unmanaged.find(i => i.name === "dummy0")).toMatchObject({ stateText: "Inactive", typeLabel: "Dummy" });
    });

    it("survives junk: this is host data", () => {
        const junk = new Map<string, Record<string, Record<string, unknown>>>([
            ["/a", { [I.device]: {} }],
            ["/b", { [I.device]: { Interface: "x0", DeviceType: "nonsense", State: null, AvailableConnections: "x", ActiveConnection: 5 } }],
            ["/c", { [`${NM}.Other`]: { Interface: "nope" } }],
        ]);
        const result = buildInterfaces(junk);
        expect([...result.managed, ...result.unmanaged].map(i => i.name)).toEqual(["x0"]);
        expect(result.managed[0]).toMatchObject({ type: "unknown", state: 0, available: [], connection: null });
    });

    it("names every device state in upstream's words", () => {
        expect([20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120].map(deviceStateText)).toEqual([
            "Not available", "Inactive", "Preparing", "Configuring", "Authenticating", "Configuring IP", "Checking IP",
            "Waiting", "Active", "Deactivating", "Failed",
        ]);
        expect(deviceStateText(10)).toBe("");
        expect(deviceStateText(null)).toBe("");
        expect(isLinkLocal6("fe80::1")).toBe(true);
        expect(isLinkLocal6("fd00::1")).toBe(false);
    });
});

describe("settings", () => {
    it("connect automatically unless they say not to", () => {
        expect(autoconnect(WIRED as Settings)).toBe(true);
        expect(autoconnect(SPARE as Settings)).toBe(false);
        expect(autoconnect(undefined)).toBe(true);
        expect(methodText(WIRED as Settings, 4)).toBe("Automatic (DHCP)");
        expect(methodText(WIRED as Settings, 6)).toBe("Ignore");
    });

    it("change that one key and nothing else, the rest exactly as received", () => {
        const changed = withAutoconnect(WIRED as Settings, false);
        expect(changed.connection!.autoconnect).toEqual({ t: "b", v: false });
        expect({ ...changed.connection, autoconnect: undefined }).toEqual({ ...WIRED.connection, autoconnect: undefined });
        expect(changed.ipv4).toBe(WIRED.ipv4);
        expect((WIRED as Settings).connection!.autoconnect).toBeUndefined();
    });

    it("pick the active connection, else the most recently used that fits", () => {
        expect(mainConnection(iface("eth0"), settings)).toBe(`${S}/1`);
        expect(mainConnection(iface("eth1"), settings)).toBe(`${S}/2`);
        const two = { ...iface("eth1"), available: [`${S}/2`, `${S}/1`] };
        expect(mainConnection(two, settings)).toBe(`${S}/1`);
        expect(mainConnection({ ...iface("eth1"), available: [] }, settings)).toBeNull();
    });
});

describe("what an interface can do", () => {
    const keys = (name: string) => ifaceActions(iface(name), settings).map(a => `${a.key} ${a.label}`);

    it("offers the switch that applies, and the auto-connect that is not set", () => {
        expect(keys("eth0")).toEqual(["d switch off", "o no auto-connect"]);
        expect(keys("eth1")).toEqual(["a switch on", "o auto-connect"]);
        // Its settings are not known (yet): no auto-connect to offer.
        expect(keys("br0")).toEqual(["d switch off"]);
    });

    it("offers nothing for a device NetworkManager does not manage, nor a switch-on with nothing to use", () => {
        expect(keys("docker0")).toEqual([]);
        expect(ifaceActions({ ...iface("eth1"), available: [] }, settings)).toEqual([]);
        expect(ifaceActions({ ...iface("eth1"), state: 20 }, settings).map(a => a.id)).toEqual(["autoconnect"]);
    });
});

describe("details", () => {
    const fields = (name: string) => ifaceSections(iface(name), settings).flatMap(s => s.fields.map(f => `${s.title}/${f.label}=${f.value}`));

    it("describes an active interface", () => {
        expect(fields("eth0")).toEqual([
            "Interface/State=Active", "Interface/Carrier=1000 Mbps", "Interface/Type=Ethernet", "Interface/MAC address=52:54:00:00:00:01",
            "Interface/MTU=1500", "Interface/Driver=virtio_net",
            "Addresses/IPv4=10.0.0.5/24", "Addresses/IPv4 gateway=10.0.0.1", "Addresses/IPv6=fd00::5/64, fe80::5054:ff:fe00:1/64",
            "Addresses/DNS=10.0.0.1, 1.1.1.1",
            "Settings/Connection=Wired", "Settings/General=Connect automatically", "Settings/IPv4=Automatic (DHCP)", "Settings/IPv6=Ignore",
        ]);
    });

    it("describes an inactive one by the connection it would use, a bridge with its ports, and an unmanaged one", () => {
        expect(fields("eth1")).toContain("Settings/Connection=Spare");
        expect(fields("eth1")).toContain("Settings/General=Do not connect automatically");
        expect(fields("br0")).toContain("Interface/Ports=vnet0");
        expect(fields("br0")).toContain("Interface/Carrier=no");
        expect(fields("docker0")).toContain("Interface/Managed=not by NetworkManager: it cannot be changed here");
        expect(fields("docker0").some(f => f.startsWith("Settings/"))).toBe(false);
    });
});

describe("the firewall", () => {
    it("reads firewalld's active zones", () => {
        expect(parseActiveZones({ public: { interfaces: ["eth0"] }, internal: { interfaces: ["br0", 5], sources: [] }, odd: null }))
                .toEqual([{ name: "internal", interfaces: ["br0"] }, { name: "odd", interfaces: [] }, { name: "public", interfaces: ["eth0"] }]);
        expect(parseActiveZones("x")).toEqual([]);
    });

    it("says its state in words", () => {
        expect(firewallText(NO_FIREWALL)).toBe("firewalld is not installed");
        const on = { installed: true, active: true, enabled: true, defaultZone: "public", zones: parseActiveZones({ public: { interfaces: ["eth0"] } }) };
        expect(firewallText(on)).toBe("on, 1 active zone: public (eth0)");
        expect(firewallText({ ...on, enabled: false, zones: [] })).toBe("on (not at boot)");
        expect(firewallText({ ...on, active: false })).toBe("off (it is enabled: it comes on at the next boot)");
        expect(firewallText({ ...on, active: false, enabled: false })).toBe("off");
    });
});

describe("rates", () => {
    it("are written in bits per second, decimal", () => {
        expect(formatBitRate(0)).toBe("0 bps");
        expect(formatBitRate(999)).toBe("999 bps");
        expect(formatBitRate(48_200)).toBe("48.2 Kbps");
        expect(formatBitRate(1_250_000)).toBe("1.25 Mbps");
        expect(formatBitRate(310_000_000)).toBe("310 Mbps");
        expect(formatBitRate(2.5e9)).toBe("2.50 Gbps");
        expect(formatBitRate(Number.NaN)).toBe("?");
    });
});

describe("firewall rules", () => {
    it("reads a zone's and a service's settings, whatever shape they come in", () => {
        expect(parseZone("public", {
            services: { t: "as", v: ["ssh", "cockpit", 5] }, ports: { t: "a(ss)", v: [["8080", "tcp"], ["x"], "junk"] },
            interfaces: { t: "as", v: ["eth0"] }, sources: { t: "as", v: [] },
        })).toEqual({ id: "public", interfaces: ["eth0"], sources: [], services: ["cockpit", "ssh"], ports: [{ port: "8080", protocol: "tcp" }] });
        expect(parseZone("x", null)).toEqual({ id: "x", interfaces: [], sources: [], services: [], ports: [] });
        expect(parseService("dns", { short: { t: "s", v: "DNS" }, ports: { t: "a(ss)", v: [["53", "tcp"], ["53", "udp"]] } }))
                .toEqual({ id: "dns", name: "DNS", description: "", ports: [{ port: "53", protocol: "tcp" }, { port: "53", protocol: "udp" }] });
        expect(portList([{ port: "80", protocol: "tcp" }, { port: "53", protocol: "udp" }, { port: "443", protocol: "tcp" }], "tcp")).toBe("80, 443");
    });

    it("takes ports as typed: single ones and ranges, checked", () => {
        expect(parsePorts("8080")).toEqual({ ports: ["8080"] });
        expect(parsePorts(" 80, 443 ,9000 - 9010, 80 ")).toEqual({ ports: ["80", "443", "9000-9010"] });
        expect(parsePorts("")).toEqual({ ports: [] });
        expect(parsePorts("5-5")).toEqual({ ports: ["5"] });
        expect(parsePorts("http")).toEqual({ error: "Not a port or a range of ports: http" });
        expect(parsePorts("0")).toEqual({ error: "Ports are numbers from 1 to 65535: 0" });
        expect(parsePorts("65536")).toEqual({ error: "Ports are numbers from 1 to 65535: 65536" });
        expect(parsePorts("90-80")).toEqual({ error: "A range goes from the lower port to the higher: 90-80" });
        expect(parsePorts("80;443")).toHaveProperty("error");
        expect(parsePorts("-1")).toHaveProperty("error");
    });

    it("lists each zone, then its services and its ports", () => {
        const ssh = { id: "ssh", name: "SSH", description: "", ports: [{ port: "22", protocol: "tcp" }] };
        const rows = ruleRows({
            zones: [{ id: "public", interfaces: ["eth0"], sources: [], services: ["ssh", "gone"], ports: [{ port: "8080", protocol: "tcp" }] }],
            services: new Map([["ssh", ssh]]),
        });
        expect(rows.map(row => row.key)).toEqual(["zone:public", "service:public:ssh", "service:public:gone", "port:public:8080/tcp"]);
        // A service firewalld no longer knows is still listed, to be removed.
        expect(rows[2]).toMatchObject({ kind: "service", service: { id: "gone", ports: [] } });
    });
});
