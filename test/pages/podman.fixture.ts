/*
 * A made-up host's podman for the Podman tests, in the shapes podman 5.8's
 * REST API sends through cockpit-bridge 356 (captured once, read-only; no
 * real names are kept): the user's service with four containers and three
 * images, and the system's with one of each.
 */
import type { HttpRoute, MockScenario } from "../mock-bridge/harness.js";

export const USER_SOCK = "/run/user/1000/podman/podman.sock";
export const SYSTEM_SOCK = "/run/podman/podman.sock";
export const V = "/v3.4.0/libpod";
export const EVENTS = `GET ${V}/events`;
export const CONTAINERS = `GET ${V}/containers/json?all=true`;
export const IMAGES = `GET ${V}/images/json`;

const NOW = Math.floor(Date.now() / 1000);

export function container(name: string, o: {
    id?: string, image?: string, imageId?: string, state?: string, health?: string, exitCode?: number,
    ports?: [number, number, string?, string?][], pod?: string, command?: string[],
} = {}): Record<string, unknown> {
    const state = o.state ?? "running";
    return {
        Id: o.id ?? `${name}-id`.padEnd(64, "0"), Names: [name], Image: o.image ?? `registry.example/${name}:latest`,
        ImageID: o.imageId ?? `${name}-image`, Command: o.command ?? null, State: state, Status: o.health ?? "",
        ExitCode: o.exitCode ?? 0, Exited: state === "exited", Created: new Date((NOW - 40 * 86400) * 1000).toISOString(),
        StartedAt: NOW - 3 * 86400, ExitedAt: NOW - 7200, IsInfra: false, Pod: o.pod ? `${o.pod}-id` : "", PodName: o.pod ?? "",
        Ports: (o.ports ?? []).map(([host, inside, protocol, ip]) => ({
            host_ip: ip ?? "", container_port: inside, host_port: host, range: 1, protocol: protocol ?? "tcp",
        })),
        Restarts: 0, Labels: {}, Mounts: [], Networks: [],
    };
}

export function image(name: string, o: { id?: string, size?: number, containers?: number, tags?: string[] } = {}): Record<string, unknown> {
    return {
        Id: o.id ?? `${name}-image`, RepoTags: o.tags ?? [`registry.example/${name}:latest`], Created: NOW - 90 * 86400,
        Size: o.size ?? 250_000_000, Containers: o.containers ?? 1, Labels: {},
    };
}

export const WEB = container("web", { ports: [[8081, 80], [8443, 8443]], health: "healthy" });
export const DB = container("db", { state: "paused", ports: [[5432, 5432, "tcp", "127.0.0.1"]] });
export const BUILDER = container("builder", { state: "exited", exitCode: 1 });
export const CACHE = container("cache", { state: "created", pod: "apps" });
export const ROUTER = container("router", { ports: [[53, 53, "udp"]] });

export function inspect(name: string): Record<string, unknown> {
    return {
        Id: `${name}-id`, Name: name,
        State: { Status: "running", Error: "", OOMKilled: false },
        Config: { Entrypoint: ["/docker-entrypoint.sh"], Cmd: ["nginx", "-g", "daemon off;"], Env: ["PATH=/usr/bin", "SECRET_TOKEN=hunter2"] },
        HostConfig: { RestartPolicy: { Name: "always" } },
        NetworkSettings: { Networks: { podman: { IPAddress: "10.88.0.5" } } },
        Mounts: [
            { Type: "bind", Source: "/srv/www", Destination: "/usr/share/nginx/html", RW: false },
            { Type: "volume", Name: "webdata", Source: "/var/lib/x/_data", Destination: "/data", RW: true },
        ],
    };
}

const stats = (entries: [string, number, number][]) => `${JSON.stringify({
    Error: null,
    Stats: entries.map(([name, cpu, memory]) => ({ ContainerID: `${name}-id`.padEnd(64, "0"), Name: name, CPU: cpu, MemUsage: memory, MemLimit: 8_000_000_000 })),
})}\n`;

export function userRoutes(extra: Record<string, HttpRoute> = {}): Record<string, HttpRoute> {
    return {
        [`GET ${V}/info`]: { body: { version: { Version: "5.8.2" }, host: { security: { rootless: true } } } },
        [CONTAINERS]: { body: [WEB, DB, BUILDER, CACHE] },
        [IMAGES]: {
            body: [
                image("web", { size: 62_400_000 }), image("db", { size: 431_000_000 }),
                image("old", { containers: 0, tags: [], id: "0123456789abcdef0123" }),
            ],
        },
        [EVENTS]: { keepOpen: true },
        [`GET ${V}/containers/stats?stream=true&interval=5`]: { keepOpen: true, chunks: [{ data: stats([["web", 1.26, 12_400_000]]) }] },
        [`GET ${V}/containers/${WEB.Id as string}/json`]: { body: inspect("web") },
        ...extra,
    };
}

export function systemRoutes(extra: Record<string, HttpRoute> = {}): Record<string, HttpRoute> {
    return {
        [`GET ${V}/info`]: { body: { version: { Version: "5.8.2" } } },
        [CONTAINERS]: { body: [ROUTER] },
        [IMAGES]: { body: [image("router")] },
        [EVENTS]: { keepOpen: true },
        [`GET ${V}/containers/stats?stream=true&interval=5`]: { keepOpen: true },
        ...extra,
    };
}

/** An event line as podman writes it. */
export function event(type: string, action: string, name = "web"): string {
    return `${JSON.stringify({ Type: type, Action: action, Actor: { ID: `${name}-id`, Attributes: { name } } })}\n`;
}

export function scenario(user: Record<string, HttpRoute> = {}, extra: Partial<MockScenario> = {}): MockScenario {
    return { http: { [USER_SOCK]: userRoutes(user) }, ...extra } as MockScenario;
}
