/*
 * Networking: the pure half. NetworkManager's objects as they arrive, and
 * the interfaces the page lists.
 * Upstream: pkg/networkmanager/interfaces.js, network-main.jsx (cockpit 356).
 *
 * One row per network device, as upstream: the loopback is left out, and so
 * are the ports of a bond, bridge or team (they are listed with it). Devices
 * NetworkManager does not manage are listed apart, and cannot be changed.
 *
 * Addresses, routes and name servers are read from the *Data properties
 * (aa{sv}: plain strings inside variants), never from the legacy ones, which
 * are integers in network byte order.
 */
import { unvariant, type Interfaces, type Objects, type Props } from "../../lib/objects.js";

export const NM = "org.freedesktop.NetworkManager";
/** Where NetworkManager's ObjectManager lives: one level above its own objects. */
export const ROOT = "/org/freedesktop";
export const NM_PATH = "/org/freedesktop/NetworkManager";

export const I = {
    manager: NM,
    device: `${NM}.Device`,
    wired: `${NM}.Device.Wired`,
    active: `${NM}.Connection.Active`,
    settings: `${NM}.Settings.Connection`,
    ip4: `${NM}.IP4Config`,
    ip6: `${NM}.IP6Config`,
} as const;

function str(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** An object path property; "/" (NetworkManager's "none") reads as null. */
function ref(value: unknown): string | null {
    return typeof value === "string" && value !== "/" && value !== "" ? value : null;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// ---- names ---------------------------------------------------------------------

/** NM_DEVICE_TYPE_*, as the connection.type they go with (interfaces.js device_type_to_symbol). */
const DEVICE_TYPES: Readonly<Record<number, string>> = {
    1: "ethernet", 2: "wifi", 5: "bluetooth", 8: "modem", 9: "infiniband", 10: "bond", 11: "vlan", 12: "adsl",
    13: "bridge", 14: "generic", 15: "team", 16: "tun", 17: "ip-tunnel", 18: "macvlan", 19: "vxlan", 20: "veth",
    21: "macsec", 22: "dummy", 23: "ppp", 29: "wireguard", 30: "wifi-p2p", 31: "vrf", 32: "loopback",
};

const TYPE_LABELS: Readonly<Record<string, string>> = {
    ethernet: "Ethernet", wifi: "Wi-Fi", bond: "Bond", vlan: "VLAN", bridge: "Bridge", team: "Team", tun: "TUN/TAP",
    veth: "Virtual Ethernet", wireguard: "WireGuard", loopback: "Loopback", dummy: "Dummy", generic: "Generic",
};

/** NM_DEVICE_STATE_*, in upstream's words (interfaces.js device_state_to_text). */
export function deviceStateText(state: number | null): string {
    switch (state) {
    case 0: return "?";
    case 10: return "";
    case 20: return "Not available";
    case 30: return "Inactive";
    case 40: return "Preparing";
    case 50: return "Configuring";
    case 60: return "Authenticating";
    case 70: return "Configuring IP";
    case 80: return "Checking IP";
    case 90: return "Waiting";
    case 100: return "Active";
    case 110: return "Deactivating";
    case 120: return "Failed";
    default: return "";
    }
}

// ---- interfaces ------------------------------------------------------------------

export interface Iface {
    /** The device's object path. */
    readonly path: string;
    /** Raw host text, as everything below: clean before showing. */
    readonly name: string;
    /** "ethernet", "bridge", ...; "unknown" for a type this does not name. */
    readonly type: string;
    readonly typeLabel: string;
    /** NM_DEVICE_STATE_*. */
    readonly state: number;
    /** The state in words, with upstream's exceptions (no carrier; an unmanaged device with nothing on it). */
    readonly stateText: string;
    /** NetworkManager looks after it: it can be switched on and off here. */
    readonly managed: boolean;
    /** Null where the device has no such thing (a bridge, a tunnel). */
    readonly carrier: boolean | null;
    /** Mb/s; null when unknown. */
    readonly speed: number | null;
    readonly mac: string;
    readonly mtu: number | null;
    readonly driver: string;
    /** The connection that is active on it. */
    readonly connection: { readonly path: string, readonly id: string, readonly settings: string | null } | null;
    /** The settings objects it could be switched on with, as NetworkManager lists them. */
    readonly available: readonly string[];
    /** "192.168.1.5/24". */
    readonly addresses4: readonly string[];
    /** Without the link-local ones, as upstream's list leaves them out. */
    readonly addresses6: readonly string[];
    readonly linkLocal6: readonly string[];
    readonly gateway4: string;
    readonly gateway6: string;
    readonly dns: readonly string[];
    /** The interfaces that are its ports (a bridge's, a bond's), by name. */
    readonly ports: readonly string[];
    /** Whether traffic is worth showing: active (or unmanaged) with a carrier (network-main.jsx show_traffic). */
    readonly showTraffic: boolean;
}

/** [{address: {v}, prefix: {v}}] -> ["a/24"]. */
function addressData(value: unknown): string[] {
    return (Array.isArray(value) ? value : []).flatMap(entry => {
        const e = record(entry);
        const address = str(unvariant(e.address));
        const prefix = num(unvariant(e.prefix));
        return address ? [prefix === null ? address : `${address}/${prefix}`] : [];
    });
}

function nameservers(config: Props | undefined): string[] {
    return (Array.isArray(config?.NameserverData) ? config.NameserverData : []).flatMap(entry => {
        const address = str(unvariant(record(entry).address));
        return address ? [address] : [];
    });
}

/** fe80::/10 (interfaces.js is_ipv6_link_local). */
export function isLinkLocal6(address: string): boolean {
    return /^fe[89ab]/i.test(address);
}

function isManaged(device: Props): boolean {
    // Never the loopback: nothing good can come from that (interfaces.js is_managed).
    return num(device.State) !== 10 && num(device.DeviceType) !== 32 && str(device.Interface) !== "lo";
}

/** A device's controller, when it is a port of a bond, bridge or team: that device's path. */
function controllerOf(objects: Objects, device: Props): string | null {
    const active = ref(device.ActiveConnection);
    const connection = active ? objects.get(active)?.[I.active] : undefined;
    return ref(connection?.Controller) ?? ref(connection?.Master);
}

export interface InterfaceLists {
    readonly managed: Iface[];
    readonly unmanaged: Iface[];
}

function parseIface(objects: Objects, path: string, interfaces: Interfaces): Iface | null {
    const device = interfaces[I.device];
    const name = str(device?.Interface);
    if (!device || !name)
        return null;
    const type = DEVICE_TYPES[num(device.DeviceType) ?? 0] ?? "unknown";
    const state = num(device.State) ?? 0;
    const managed = isManaged(device);
    const wired = interfaces[I.wired];
    // The carrier is on the type's own interface: Device.Wired, but Device.Bridge, .Bond, .Vlan too.
    const typed = Object.entries(interfaces).find(([name, props]) => name.startsWith(`${I.device}.`) && typeof props.Carrier === "boolean");
    const carrier = typed ? typed[1].Carrier as boolean : null;

    const activePath = ref(device.ActiveConnection);
    const active = activePath ? objects.get(activePath)?.[I.active] : undefined;
    // The active connection's own IP configuration where there is one, else the device's.
    const ip4 = objects.get(ref(active?.Ip4Config) ?? ref(device.Ip4Config) ?? "")?.[I.ip4];
    const ip6 = objects.get(ref(active?.Ip6Config) ?? ref(device.Ip6Config) ?? "")?.[I.ip6];
    const addresses4 = addressData(ip4?.AddressData);
    const all6 = addressData(ip6?.AddressData);

    let stateText = deviceStateText(state);
    if (state === 100 && carrier === false)
        stateText = "No carrier";
    else if (!managed && !active && addresses4.length === 0 && all6.length === 0)
        stateText = "Inactive";

    const ports = [...objects].flatMap(([otherPath, other]) => {
        const otherDevice = other[I.device];
        return otherDevice && otherPath !== path && controllerOf(objects, otherDevice) === path ? [str(otherDevice.Interface)] : [];
    }).filter(Boolean).sort();

    return {
        path, name, type, typeLabel: TYPE_LABELS[type] ?? type, state, stateText, managed, carrier,
        speed: num(wired?.Speed) || null,
        mac: str(device.HwAddress), mtu: num(device.Mtu) || null, driver: str(device.Driver),
        connection: active && activePath ? { path: activePath, id: str(active.Id), settings: ref(active.Connection) } : null,
        available: (Array.isArray(device.AvailableConnections) ? device.AvailableConnections : []).filter((p): p is string => typeof p === "string"),
        addresses4,
        addresses6: all6.filter(a => !isLinkLocal6(a)),
        linkLocal6: all6.filter(isLinkLocal6),
        gateway4: str(ip4?.Gateway), gateway6: str(ip6?.Gateway),
        dns: [...nameservers(ip4), ...nameservers(ip6)],
        ports,
        showTraffic: (state === 100 || state === 10) && carrier !== false,
    };
}

/** The interfaces the page lists, by name: NetworkManager's own, and the ones it leaves alone. */
export function buildInterfaces(objects: Objects): InterfaceLists {
    const collator = new Intl.Collator("en", { numeric: true });
    const managed: Iface[] = [];
    const unmanaged: Iface[] = [];
    for (const [path, interfaces] of objects) {
        const device = interfaces[I.device];
        if (!device)
            continue;
        // Skip the loopback, and the ports of a group (network-main.jsx).
        if (str(device.Interface) === "lo" || num(device.DeviceType) === 32 || controllerOf(objects, device))
            continue;
        const iface = parseIface(objects, path, interfaces);
        if (iface)
            (iface.managed ? managed : unmanaged).push(iface);
    }
    const byName = (a: Iface, b: Iface) => collator.compare(a.name, b.name);
    return { managed: managed.sort(byName), unmanaged: unmanaged.sort(byName) };
}

/** What the list says an interface's addresses are: IPv4, then IPv6 without the link-local ones. */
export function addressText(iface: Iface): string {
    return [...iface.addresses4, ...iface.addresses6].join(", ");
}

// ---- settings --------------------------------------------------------------------

/** A connection's settings as GetSettings returns them: a{sa{sv}}, the inner values still variants. */
export type Settings = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

function setting(settings: Settings | undefined, group: string, key: string): unknown {
    return unvariant(settings?.[group]?.[key]);
}

/** "Connect automatically": NetworkManager's default is yes. */
export function autoconnect(settings: Settings | undefined): boolean {
    return setting(settings, "connection", "autoconnect") !== false;
}

export function connectionId(settings: Settings | undefined): string {
    return str(setting(settings, "connection", "id"));
}

const METHODS4: Readonly<Record<string, string>> = {
    auto: "Automatic (DHCP)", manual: "Manual", "link-local": "Link local", shared: "Shared", disabled: "Disabled",
};
const METHODS6: Readonly<Record<string, string>> = {
    auto: "Automatic", dhcp: "Automatic (DHCP only)", manual: "Manual", "link-local": "Link local", ignore: "Ignore",
    disabled: "Disabled", shared: "Shared",
};

export function methodText(settings: Settings | undefined, family: 4 | 6): string {
    const method = str(setting(settings, family === 4 ? "ipv4" : "ipv6", "method"));
    return (family === 4 ? METHODS4 : METHODS6)[method] ?? method;
}

/**
 * The settings with "connect automatically" set: everything else exactly as
 * received, which is what Settings.Connection.Update must be given back.
 */
export function withAutoconnect(settings: Settings, value: boolean): Settings {
    return { ...settings, connection: { ...(settings.connection ?? {}), autoconnect: { t: "b", v: value } } };
}

/**
 * The connection an interface is switched on with, or has "connect
 * automatically" on: the active one, else the most recently used of those
 * NetworkManager says fit the device (upstream's MainConnection).
 */
export function mainConnection(iface: Iface, settings: ReadonlyMap<string, Settings>): string | null {
    if (iface.connection?.settings)
        return iface.connection.settings;
    const stamp = (path: string) => num(setting(settings.get(path), "connection", "timestamp")) ?? 0;
    return [...iface.available].sort((a, b) => stamp(b) - stamp(a))[0] ?? null;
}

// ---- what an interface can do --------------------------------------------------------

export type ActionId = "activate" | "deactivate" | "autoconnect";

export interface ActionInfo {
    readonly id: ActionId;
    readonly key: string;
    readonly label: string;
}

export function ifaceActions(iface: Iface, settings: ReadonlyMap<string, Settings>): ActionInfo[] {
    if (!iface.managed)
        return [];
    const actions: ActionInfo[] = [];
    const main = mainConnection(iface, settings);
    // Anything between "preparing" and "active" is on, or on its way.
    if (iface.state >= 40 && iface.state <= 100)
        actions.push({ id: "deactivate", key: "d", label: "switch off" });
    else if (main && iface.state >= 30)
        actions.push({ id: "activate", key: "a", label: "switch on" });
    if (main && settings.has(main))
        actions.push({ id: "autoconnect", key: "o", label: autoconnect(settings.get(main)) ? "no auto-connect" : "auto-connect" });
    return actions;
}

// ---- details ---------------------------------------------------------------------

export interface DetailField {
    readonly label: string;
    /** Raw host text. */
    readonly value: string;
    readonly tone?: "ok" | "warning" | "error";
}

export interface Section {
    readonly title: string;
    readonly fields: DetailField[];
}

export function ifaceSections(iface: Iface, settings: ReadonlyMap<string, Settings>): Section[] {
    const main = mainConnection(iface, settings);
    const conf = main ? settings.get(main) : undefined;
    const status: DetailField[] = [
        {
            label: "State", value: iface.stateText || (iface.managed ? "Unknown" : "Not managed"),
            ...(iface.state === 100 && iface.carrier !== false ? { tone: "ok" as const }
                : iface.state === 120 ? { tone: "error" as const }
                : iface.stateText === "No carrier" ? { tone: "warning" as const } : {}),
        },
    ];
    if (iface.carrier !== null)
        status.push({ label: "Carrier", value: iface.carrier ? (iface.speed ? `${iface.speed} Mbps` : "yes") : "no" });
    status.push({ label: "Type", value: iface.typeLabel });
    if (iface.mac)
        status.push({ label: "MAC address", value: iface.mac });
    if (iface.mtu)
        status.push({ label: "MTU", value: `${iface.mtu}` });
    if (iface.driver)
        status.push({ label: "Driver", value: iface.driver });
    if (iface.ports.length)
        status.push({ label: "Ports", value: iface.ports.join(", ") });
    if (!iface.managed)
        status.push({ label: "Managed", value: "not by NetworkManager: it cannot be changed here", tone: "warning" });

    const sections: Section[] = [{ title: "Interface", fields: status }];

    const address: DetailField[] = [];
    if (iface.addresses4.length)
        address.push({ label: "IPv4", value: iface.addresses4.join(", ") });
    if (iface.gateway4)
        address.push({ label: "IPv4 gateway", value: iface.gateway4 });
    if (iface.addresses6.length || iface.linkLocal6.length)
        address.push({ label: "IPv6", value: [...iface.addresses6, ...iface.linkLocal6].join(", ") });
    if (iface.gateway6)
        address.push({ label: "IPv6 gateway", value: iface.gateway6 });
    if (iface.dns.length)
        address.push({ label: "DNS", value: iface.dns.join(", ") });
    if (address.length)
        sections.push({ title: "Addresses", fields: address });

    if (iface.managed) {
        const connection: DetailField[] = [];
        const id = iface.connection?.id || connectionId(conf);
        connection.push({ label: "Connection", value: id || "none" });
        if (conf) {
            connection.push({ label: "General", value: autoconnect(conf) ? "Connect automatically" : "Do not connect automatically" });
            if (methodText(conf, 4))
                connection.push({ label: "IPv4", value: methodText(conf, 4) });
            if (methodText(conf, 6))
                connection.push({ label: "IPv6", value: methodText(conf, 6) });
        }
        sections.push({ title: "Settings", fields: connection });
    }
    return sections;
}

// ---- firewall --------------------------------------------------------------------

export interface Firewall {
    /** firewalld is installed (its unit exists). */
    readonly installed: boolean;
    /** The unit is active: the firewall is on. */
    readonly active: boolean;
    /** The unit is enabled: it comes up at boot. */
    readonly enabled: boolean;
    /** Null when it could not be asked (off, or not allowed). */
    readonly defaultZone: string | null;
    /** Active zones with the interfaces in them. */
    readonly zones: readonly { readonly name: string, readonly interfaces: readonly string[] }[];
}

export const NO_FIREWALL: Firewall = { installed: false, active: false, enabled: false, defaultZone: null, zones: [] };

/** getActiveZones' a{sa{sas}}: {zone: {interfaces: [...], sources: [...]}}. */
export function parseActiveZones(value: unknown): Firewall["zones"] {
    return Object.entries(record(value)).map(([name, entry]) => ({
        name,
        interfaces: (Array.isArray(record(entry).interfaces) ? record(entry).interfaces as unknown[] : []).filter((i): i is string => typeof i === "string"),
    })).sort((a, b) => a.name.localeCompare(b.name));
}

/** "on, 2 active zones: libvirt (virbr0), public (enp1s0)". */
export function firewallText(firewall: Firewall): string {
    if (!firewall.installed)
        return "firewalld is not installed";
    if (!firewall.active)
        return firewall.enabled ? "off (it is enabled: it comes on at the next boot)" : "off";
    const zones = firewall.zones.map(zone => (zone.interfaces.length ? `${zone.name} (${zone.interfaces.join(", ")})` : zone.name));
    const count = `${zones.length} active zone${zones.length === 1 ? "" : "s"}`;
    return `on${firewall.enabled ? "" : " (not at boot)"}${zones.length ? `, ${count}: ${zones.join(", ")}` : ""}`;
}

/** A rate in bits per second, as upstream writes them: "1.2 Mbps", "640 Kbps". */
export function formatBitRate(bitsPerSecond: number): string {
    if (!Number.isFinite(bitsPerSecond) || bitsPerSecond < 0)
        return "?";
    const units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
    let value = bitsPerSecond;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    return `${unit === 0 ? Math.round(value) : value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`;
}
