/*
 * The firewall's rules: firewalld's active zones with the services and ports
 * each lets in, and changing them.
 * Upstream: pkg/networkmanager/firewall-client.js, firewall.jsx (cockpit 356).
 *
 * A zone lets in *services* (firewalld's named sets of ports: "ssh",
 * "cockpit", "http") and single *ports*. Every change is made twice, as
 * upstream makes it: to the running firewall (the `zone` interface), so it
 * applies now, and to the permanent configuration (the zone's `config`
 * object), so it is still there after a reload or a reboot.
 *
 * Where this differs from upstream: custom ports are added to the zone as
 * ports. Upstream wraps them in a new firewalld service named "custom--..."
 * and reloads firewalld to make it known, which re-applies the whole rule
 * set; plain ports need no reload, and firewalld, firewall-cmd and upstream's
 * own page all show them.
 *
 * firewalld answers none of this to an unprivileged caller (polkit): the
 * rules are read and changed with administrative access only.
 */
import cockpit from "../../cockpit.js";
import { unvariant } from "../../lib/objects.js";
import { CLIENT_OPTIONS } from "./store.js";

const FIREWALLD = "org.fedoraproject.FirewallD1";
const PATH = "/org/fedoraproject/FirewallD1";
const CONFIG_PATH = `${PATH}/config`;

export interface PortSpec {
    /** "8080", or a range "9000-9010". */
    readonly port: string;
    /** "tcp", "udp", sometimes "sctp" or "dccp". */
    readonly protocol: string;
}

export interface ServiceInfo {
    readonly id: string;
    /** firewalld's short name for it ("SSH", "WWW (HTTP)"); raw host text. */
    readonly name: string;
    readonly description: string;
    readonly ports: readonly PortSpec[];
}

export interface ZoneInfo {
    readonly id: string;
    readonly interfaces: readonly string[];
    readonly sources: readonly string[];
    readonly services: readonly string[];
    readonly ports: readonly PortSpec[];
}

export interface Rules {
    readonly zones: readonly ZoneInfo[];
    /** What is known about the services the zones name, by id. */
    readonly services: ReadonlyMap<string, ServiceInfo>;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
    return (Array.isArray(value) ? value : []).filter((s): s is string => typeof s === "string");
}

/** a(ss): [["8080", "tcp"], ...]. */
function ports(value: unknown): PortSpec[] {
    return (Array.isArray(value) ? value : []).flatMap(entry =>
        (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string"
            ? [{ port: entry[0], protocol: entry[1] }] : []));
}

/** getZoneSettings2's a{sv}, checked as it is read. */
export function parseZone(id: string, value: unknown): ZoneInfo {
    const settings = record(value);
    return {
        id,
        interfaces: strings(unvariant(settings.interfaces)),
        sources: strings(unvariant(settings.sources)),
        services: strings(unvariant(settings.services)).sort(),
        ports: ports(unvariant(settings.ports)),
    };
}

/** getServiceSettings2's a{sv}. */
export function parseService(id: string, value: unknown): ServiceInfo {
    const settings = record(value);
    const short = unvariant(settings.short);
    const description = unvariant(settings.description);
    return {
        id,
        name: typeof short === "string" ? short : "",
        description: typeof description === "string" ? description : "",
        ports: ports(unvariant(settings.ports)),
    };
}

/** "22", "80, 443": a service's or a row's ports of one protocol. */
export function portList(list: readonly PortSpec[], protocol: string): string {
    return list.filter(p => p.protocol === protocol).map(p => p.port).join(", ");
}

/**
 * What the user typed as ports -- "8080", "80, 443", "9000-9010" -- as
 * firewalld takes them, or why not (upstream's validate()).
 */
export function parsePorts(text: string): { ports: string[] } | { error: string } {
    const out: string[] = [];
    for (const part of text.split(",").map(s => s.trim()).filter(Boolean)) {
        const range = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(part);
        if (!range)
            return { error: `Not a port or a range of ports: ${part}` };
        const from = Number(range[1]);
        const to = range[2] === undefined ? from : Number(range[2]);
        if (from < 1 || from > 65535 || to < 1 || to > 65535)
            return { error: `Ports are numbers from 1 to 65535: ${part}` };
        if (to < from)
            return { error: `A range goes from the lower port to the higher: ${part}` };
        out.push(to === from ? String(from) : `${from}-${to}`);
    }
    return { ports: [...new Set(out)] };
}

/** Services whose removal can lock the user out of the session they are in. */
export const LIFELINES: Readonly<Record<string, string>> = {
    ssh: "ssh logins, cockpit-tui over --host among them",
    cockpit: "Cockpit's port 9090, and with it cockpit-tui over --ws",
};

// ---- rows ------------------------------------------------------------------------

export type RuleRow =
    | { readonly key: string, readonly kind: "zone", readonly zone: ZoneInfo }
    | { readonly key: string, readonly kind: "service", readonly zone: ZoneInfo, readonly service: ServiceInfo }
    | { readonly key: string, readonly kind: "port", readonly zone: ZoneInfo, readonly port: PortSpec };

/** Each zone, then what it lets in: its services by name, then its single ports. */
export function ruleRows(rules: Rules): RuleRow[] {
    const rows: RuleRow[] = [];
    for (const zone of rules.zones) {
        rows.push({ key: `zone:${zone.id}`, kind: "zone", zone });
        for (const id of zone.services) {
            const service = rules.services.get(id) ?? { id, name: "", description: "", ports: [] };
            rows.push({ key: `service:${zone.id}:${id}`, kind: "service", zone, service });
        }
        for (const port of zone.ports)
            rows.push({ key: `port:${zone.id}:${port.port}/${port.protocol}`, kind: "port", zone, port });
    }
    return rows;
}

// ---- reading -----------------------------------------------------------------------

type Client = ReturnType<typeof cockpit.dbus>;

function call(client: Client, path: string, iface: string, method: string, args: unknown[], type: string): Promise<unknown[]> {
    return Promise.resolve(client.call(path, iface, method, args, { type }));
}

async function withClient<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const client = cockpit.dbus(FIREWALLD, { ...CLIENT_OPTIONS });
    try {
        return await work(client);
    } finally {
        client.close();
    }
}

async function serviceInfo(client: Client, id: string): Promise<ServiceInfo> {
    try {
        const [settings] = await call(client, PATH, FIREWALLD, "getServiceSettings2", [id], "s");
        return parseService(id, settings);
    } catch {
        // A service the zone names but firewalld no longer knows: listed by its id alone.
        return { id, name: "", description: "", ports: [] };
    }
}

/** The active zones with their rules, and the services they name. */
export function readRules(): Promise<Rules> {
    return withClient(async client => {
        const [active] = await call(client, PATH, `${FIREWALLD}.zone`, "getActiveZones", [], "");
        const ids = Object.keys(record(active)).sort();
        const zones = await Promise.all(ids.map(async id => {
            const [settings] = await call(client, PATH, `${FIREWALLD}.zone`, "getZoneSettings2", [id], "s");
            return parseZone(id, settings);
        }));
        const wanted = [...new Set(zones.flatMap(zone => zone.services))];
        const infos = await Promise.all(wanted.map(id => serviceInfo(client, id)));
        return { zones, services: new Map(infos.map(info => [info.id, info])) };
    });
}

/** Every service firewalld knows, for the "add services" list. */
export function readAvailableServices(): Promise<ServiceInfo[]> {
    return withClient(async client => {
        const [ids] = await call(client, PATH, FIREWALLD, "listServices", [], "");
        const infos = await Promise.all(strings(ids).map(id => serviceInfo(client, id)));
        return infos.sort((a, b) => a.id.localeCompare(b.id));
    });
}

// ---- changing ----------------------------------------------------------------------

/** The zone's object in the permanent configuration. */
async function configZone(client: Client, zone: string): Promise<string> {
    const [path] = await call(client, CONFIG_PATH, `${FIREWALLD}.config`, "getZoneByName", [zone], "s");
    if (typeof path !== "string")
        throw new Error(`firewalld has no permanent configuration for the zone ${zone}`);
    return path;
}

/** Let services in: now, and permanently. */
export function addServices(zone: string, services: readonly string[]): Promise<string> {
    return withClient(async client => {
        for (const service of services) {
            await call(client, PATH, `${FIREWALLD}.zone`, "addService", [zone, service, 0], "ssi");
            await call(client, await configZone(client, zone), `${FIREWALLD}.config.zone`, "addService", [service], "s");
        }
        return services.length === 1 ? `Added ${services[0]} to ${zone}` : `Added ${services.length} services to ${zone}`;
    });
}

export function removeService(zone: string, service: string): Promise<string> {
    return withClient(async client => {
        await call(client, PATH, `${FIREWALLD}.zone`, "removeService", [zone, service], "ss");
        await call(client, await configZone(client, zone), `${FIREWALLD}.config.zone`, "removeService", [service], "s");
        return `Removed ${service} from ${zone}`;
    });
}

/** Open single ports: now, and permanently. */
export function addPorts(zone: string, list: readonly PortSpec[]): Promise<string> {
    return withClient(async client => {
        for (const { port, protocol } of list) {
            await call(client, PATH, `${FIREWALLD}.zone`, "addPort", [zone, port, protocol, 0], "sssi");
            await call(client, await configZone(client, zone), `${FIREWALLD}.config.zone`, "addPort", [port, protocol], "ss");
        }
        return `Opened ${list.map(p => `${p.port}/${p.protocol}`).join(", ")} in ${zone}`;
    });
}

export function removePort(zone: string, port: PortSpec): Promise<string> {
    return withClient(async client => {
        await call(client, PATH, `${FIREWALLD}.zone`, "removePort", [zone, port.port, port.protocol], "sss");
        await call(client, await configZone(client, zone), `${FIREWALLD}.config.zone`, "removePort", [port.port, port.protocol], "ss");
        return `Closed ${port.port}/${port.protocol} in ${zone}`;
    });
}
