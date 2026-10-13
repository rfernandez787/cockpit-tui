/*
 * Podman: the pure half. What podman's API returns, checked as it is read
 * (it is host data), and what the page shows of it.
 * Upstream: cockpit-podman 121, src/Containers.jsx, src/Images.jsx, src/util.tsx.
 */
import { userIsRoot, type Owner } from "./rest.js";

function str(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

// ---- sizes and times -----------------------------------------------------------

const UNITS = ["B", "kB", "MB", "GB", "TB", "PB"];

/** A size in decimal units with three significant digits, as upstream writes image sizes. */
export function formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0)
        return "?";
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < UNITS.length - 1) {
        value /= 1000;
        unit++;
    }
    if (unit === 0)
        return `${value} B`;
    if (Number(value.toPrecision(3)) >= 1000 && unit < UNITS.length - 1) {
        value /= 1000;
        unit++;
    }
    return `${value.toPrecision(3)} ${UNITS[unit]}`;
}

/** "3 days", "5 hours", "just now": how long ago (or how long for). */
export function formatAge(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0)
        return "";
    const steps: [number, string][] = [[365 * 86400, "year"], [30 * 86400, "month"], [86400, "day"], [3600, "hour"], [60, "minute"]];
    for (const [size, name] of steps) {
        if (seconds >= size) {
            const n = Math.floor(seconds / size);
            return `${n} ${name}${n === 1 ? "" : "s"}`;
        }
    }
    return "less than a minute";
}

// ---- containers ----------------------------------------------------------------

export interface PortMapping {
    readonly hostIp: string;
    readonly hostPort: number;
    readonly containerPort: number;
    readonly range: number;
    readonly protocol: string;
}

export interface Container {
    /** `${owner}:${Id}`: an id is only unique per owner. */
    readonly key: string;
    readonly owner: Owner;
    readonly id: string;
    /** Raw host text, as everything below: clean before showing. */
    readonly name: string;
    readonly image: string;
    readonly imageId: string;
    readonly command: string;
    /** podman's state word: running, paused, exited, created, configured, stopped, stopping, restarting, ... */
    readonly state: string;
    /** The health check's verdict, when the container has one: healthy, unhealthy, starting. */
    readonly health: string;
    readonly exitCode: number | null;
    /** Seconds since the epoch; null when unknown. */
    readonly created: number | null;
    readonly startedAt: number | null;
    readonly exitedAt: number | null;
    readonly ports: readonly PortMapping[];
    readonly pod: string;
    readonly podName: string;
    readonly isInfra: boolean;
    readonly restarts: number;
}

function epoch(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value) && value > 0)
        return value;
    if (typeof value === "string" && value) {
        const ms = Date.parse(value);
        return Number.isNaN(ms) || ms <= 0 ? null : Math.floor(ms / 1000);
    }
    return null;
}

/** One entry of GET libpod/containers/json. */
export function parseContainer(owner: Owner, value: unknown): Container | null {
    const c = record(value);
    const id = str(c.Id);
    if (!id)
        return null;
    const names = list(c.Names).filter((n): n is string => typeof n === "string");
    const ports = list(c.Ports).flatMap((value): PortMapping[] => {
        const p = record(value);
        const containerPort = num(p.container_port);
        if (containerPort === null)
            return [];
        return [{
            hostIp: str(p.host_ip), hostPort: num(p.host_port) ?? 0, containerPort,
            range: Math.max(1, num(p.range) ?? 1), protocol: str(p.protocol) || "tcp",
        }];
    });
    return {
        key: `${owner}:${id}`, owner, id,
        name: names[0] ?? id.slice(0, 12),
        image: str(c.Image), imageId: str(c.ImageID),
        command: list(c.Command).filter((s): s is string => typeof s === "string").join(" "),
        state: str(c.State) || "unknown",
        health: str(c.Status),
        exitCode: num(c.ExitCode),
        created: epoch(c.Created), startedAt: epoch(c.StartedAt), exitedAt: epoch(c.ExitedAt),
        ports,
        pod: str(c.Pod), podName: str(c.PodName), isInfra: c.IsInfra === true,
        restarts: num(c.Restarts) ?? 0,
    };
}

export function parseContainers(owner: Owner, value: unknown): Container[] {
    return list(value).flatMap(entry => parseContainer(owner, entry) ?? []);
}

/** "8080:80/tcp", "192.168.1.2:53:53/udp", "8000-8010:8000-8010/tcp". */
export function formatPort(port: PortMapping): string {
    const span = (from: number) => (port.range > 1 ? `${from}-${from + port.range - 1}` : `${from}`);
    const host = port.hostPort ? `${port.hostIp ? `${port.hostIp}:` : ""}${span(port.hostPort)}:` : "";
    return `${host}${span(port.containerPort)}/${port.protocol}`;
}

const ACTIVE_STATES = new Set(["running", "paused", "restarting", "stopping"]);

/** The container has processes (so it can be stopped, and removing it needs force). */
export function isActive(container: Container): boolean {
    return ACTIVE_STATES.has(container.state);
}

/** The state as the list says it: "Running", "Exited (1)", "Running, unhealthy". */
export function stateText(container: Container): string {
    let text = container.state ? container.state[0]!.toUpperCase() + container.state.slice(1) : "Unknown";
    if ((container.state === "exited" || container.state === "stopped") && container.exitCode !== null && container.exitCode !== 0)
        text += ` (${container.exitCode})`;
    if (container.state === "running" && container.health && container.health !== "healthy")
        text += `, ${container.health}`;
    return text;
}

export type Tone = "ok" | "warning" | "error" | "dim";

export function stateTone(container: Container): Tone {
    switch (container.state) {
    case "running":
        return container.health === "unhealthy" ? "error" : container.health === "starting" ? "warning" : "ok";
    case "paused":
    case "restarting":
    case "stopping":
        return "warning";
    case "exited":
    case "stopped":
        return container.exitCode ? "error" : "dim";
    default:
        return "dim";
    }
}

export interface Stats {
    /** Percent of one CPU. */
    readonly cpu: number;
    readonly memory: number;
    /** 0 when there is no limit worth showing. */
    readonly memoryLimit: number;
}

/** One line of GET libpod/containers/stats?stream=true: {Error, Stats: [...]}, by container id. */
export function parseStats(value: unknown): Map<string, Stats> | null {
    const reply = record(value);
    if (reply.Error !== null && reply.Error !== undefined)
        return null;
    const stats = new Map<string, Stats>();
    for (const entry of list(reply.Stats)) {
        const s = record(entry);
        const id = str(s.ContainerID);
        if (id)
            stats.set(id, { cpu: num(s.CPU) ?? 0, memory: num(s.MemUsage) ?? 0, memoryLimit: num(s.MemLimit) ?? 0 });
    }
    return stats;
}

export type ContainerFilter = "all" | "running";

/** The containers shown, in upstream's order: by owner (the user's first), then by name. */
export function containerRows(containers: Iterable<Container>, filter: ContainerFilter, text: string): Container[] {
    const needle = text.trim().toLowerCase();
    return [...containers]
            .filter(c => filter === "all" || c.state === "running" || c.state === "restarting")
            .filter(c => !needle || c.name.toLowerCase().includes(needle) || c.image.toLowerCase().includes(needle) ||
                c.podName.toLowerCase().includes(needle))
            .sort((a, b) => (a.owner === b.owner ? 0 : a.owner === "user" ? -1 : 1) ||
                a.podName.localeCompare(b.podName) || a.name.localeCompare(b.name));
}

// ---- actions ---------------------------------------------------------------------

export type ContainerAction = "start" | "stop" | "restart" | "pause" | "unpause" | "remove";

export interface ActionInfo<T extends string> {
    readonly id: T;
    readonly key: string;
    /** Footer and help: "stop". */
    readonly label: string;
}

/** What can be done to a container in its state, in footer order (Containers.jsx's menu). */
export function containerActions(container: Container): ActionInfo<ContainerAction>[] {
    const actions: ActionInfo<ContainerAction>[] = [];
    const add = (id: ContainerAction, key: string, label: string = id) => actions.push({ id, key, label });
    switch (container.state) {
    case "running":
    case "restarting":
        add("stop", "S");
        add("restart", "r");
        add("pause", "p");
        break;
    case "paused":
        add("unpause", "p", "resume");
        add("stop", "S");
        break;
    case "stopping":
        add("stop", "S");
        break;
    default:
        add("start", "s");
        break;
    }
    add("remove", "d", "delete");
    return actions;
}

export type ImageAction = "remove";

// ---- images ----------------------------------------------------------------------

export interface Image {
    readonly key: string;
    readonly owner: Owner;
    readonly id: string;
    /** "docker.io/library/nginx:alpine"; the short id for an untagged image. Raw host text. */
    readonly name: string;
    readonly tags: readonly string[];
    readonly size: number;
    readonly created: number | null;
    /** How many containers use it, as podman counts them. */
    readonly containers: number;
}

export function parseImages(owner: Owner, value: unknown): Image[] {
    return list(value).flatMap((entry): Image[] => {
        const i = record(entry);
        const id = str(i.Id);
        if (!id)
            return [];
        const tags = list(i.RepoTags).filter((t): t is string => typeof t === "string" && t !== "<none>:<none>");
        return [{
            key: `${owner}:${id}`, owner, id, tags,
            name: tags[0] ?? `<none> ${id.slice(0, 12)}`,
            size: num(i.Size) ?? 0, created: epoch(i.Created), containers: num(i.Containers) ?? 0,
        }];
    });
}

export function imageRows(images: Iterable<Image>, text: string): Image[] {
    const needle = text.trim().toLowerCase();
    return [...images]
            .filter(i => !needle || i.tags.some(tag => tag.toLowerCase().includes(needle)) || i.id.startsWith(needle))
            .sort((a, b) => (a.owner === b.owner ? 0 : a.owner === "user" ? -1 : 1) || a.name.localeCompare(b.name));
}

/** The containers made from an image: what deleting it would break. */
export function imageUsers(image: Image, containers: Iterable<Container>): Container[] {
    return [...containers].filter(c => c.owner === image.owner && c.imageId === image.id);
}

// ---- details ---------------------------------------------------------------------

export interface DetailField {
    readonly label: string;
    /** Raw host text. */
    readonly value: string;
    readonly tone?: Tone;
}

export interface Section {
    readonly title: string;
    readonly fields: DetailField[];
}

const OWNER_NAMES: Readonly<Record<Owner, string>> = { user: "user", system: "system" };

/** "user" or "system"; root's own containers are the system's. */
export function ownerName(owner: Owner): string {
    return userIsRoot() ? OWNER_NAMES.system : OWNER_NAMES[owner];
}

/**
 * Everything known about a container: the list's entry, and what GET
 * libpod/containers/{id}/json adds once it has arrived (ContainerDetails.jsx
 * and the integration tab).
 */
export function containerSections(container: Container, inspect: unknown, stats: Stats | null, now: number): Section[] {
    const sections: Section[] = [];
    const data = record(inspect);
    const config = record(data.Config);
    const state = record(data.State);
    const host = record(data.HostConfig);

    const general: DetailField[] = [
        { label: "Name", value: container.name },
        { label: "ID", value: container.id },
        { label: "Owner", value: ownerName(container.owner) },
        { label: "Image", value: container.image },
    ];
    const command = list(config.Cmd).filter((s): s is string => typeof s === "string").join(" ") || container.command;
    const entrypoint = typeof config.Entrypoint === "string"
        ? config.Entrypoint
        : list(config.Entrypoint).filter((s): s is string => typeof s === "string").join(" ");
    if (entrypoint)
        general.push({ label: "Entrypoint", value: entrypoint });
    if (command)
        general.push({ label: "Command", value: command });
    if (container.podName)
        general.push({ label: "Pod", value: container.podName });
    if (container.created !== null)
        general.push({ label: "Created", value: `${formatAge(now - container.created)} ago` });
    sections.push({ title: "Container", fields: general });

    const status: DetailField[] = [{ label: "State", value: stateText(container), tone: stateTone(container) }];
    if (container.state === "running" && container.startedAt !== null)
        status.push({ label: "Up since", value: `${formatAge(now - container.startedAt)} ago` });
    if (!isActive(container) && container.exitedAt !== null && container.state !== "created" && container.state !== "configured")
        status.push({ label: "Exited", value: `${formatAge(now - container.exitedAt)} ago` });
    if (container.health)
        status.push({ label: "Health", value: container.health, tone: container.health === "healthy" ? "ok" : container.health === "unhealthy" ? "error" : "warning" });
    const error = str(state.Error);
    if (error)
        status.push({ label: "Error", value: error, tone: "error" });
    if (state.OOMKilled === true)
        status.push({ label: "Out of memory", value: "killed by the kernel", tone: "error" });
    if (container.restarts > 0)
        status.push({ label: "Restarts", value: `${container.restarts}` });
    const policy = str(record(host.RestartPolicy).Name);
    if (policy)
        status.push({ label: "Restart policy", value: policy });
    if (stats) {
        status.push({ label: "CPU", value: `${stats.cpu.toFixed(1)}%` });
        status.push({
            label: "Memory",
            value: stats.memoryLimit > 0 && stats.memoryLimit < 2 ** 60
                ? `${formatSize(stats.memory)} of ${formatSize(stats.memoryLimit)}`
                : formatSize(stats.memory),
        });
    }
    sections.push({ title: "Status", fields: status });

    const integration: DetailField[] = [];
    if (container.ports.length)
        integration.push({ label: "Ports", value: container.ports.map(formatPort).join(", ") });
    const networks = Object.entries(record(record(data.NetworkSettings).Networks));
    for (const [name, value] of networks) {
        const address = str(record(value).IPAddress);
        integration.push({ label: "Network", value: address ? `${name} (${address})` : name });
    }
    for (const value of list(data.Mounts)) {
        const mount = record(value);
        const source = str(mount.Type) === "volume" ? str(mount.Name) : str(mount.Source);
        const destination = str(mount.Destination);
        if (destination)
            integration.push({ label: "Volume", value: `${source} ${mount.RW === false ? "(read-only) " : ""}-> ${destination}` });
    }
    if (integration.length)
        sections.push({ title: "Integration", fields: integration });

    // Variables can hold secrets: their names only.
    const env = list(config.Env).filter((s): s is string => typeof s === "string").map(entry => entry.split("=")[0]!).filter(Boolean);
    if (env.length)
        sections.push({ title: "Environment", fields: [{ label: "Variables", value: env.join(", ") }] });

    return sections;
}

export function imageSections(image: Image, users: readonly Container[], now: number): Section[] {
    return [{
        title: "Image",
        fields: [
            { label: "ID", value: image.id },
            { label: "Owner", value: ownerName(image.owner) },
            { label: "Tags", value: image.tags.join(", ") || "none" },
            { label: "Size", value: formatSize(image.size) },
            ...(image.created !== null ? [{ label: "Created", value: `${formatAge(now - image.created)} ago` }] : []),
            { label: "Used by", value: users.length ? users.map(c => c.name).join(", ") : "no container" },
        ],
    }];
}

// ---- events ----------------------------------------------------------------------

/** What one line of GET libpod/events means for the lists (app.jsx handleEvent). */
export function eventEffect(value: unknown): { containers: boolean, images: boolean } {
    const event = record(value);
    const type = str(event.Type);
    const action = str(event.Action);
    if (type === "image")
        return { containers: false, images: true };
    if (type === "container") {
        // Upstream's list of actions that change nothing the page shows.
        const quiet = ["attach", "exec", "export", "import", "init", "kill", "mount", "prune", "sync", "unmount", "wait", "exec_died"];
        if (quiet.includes(action))
            return { containers: false, images: false };
        // A removed container changes its image's "used by"; a commit makes an image.
        return { containers: true, images: action === "remove" || action === "commit" || action === "create" };
    }
    if (type === "pod")
        return { containers: true, images: false };
    return { containers: false, images: false };
}
