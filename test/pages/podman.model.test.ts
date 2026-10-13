/*
 * The Podman page's pure half: reading podman's lists, states and their
 * words, ports, what each state allows, details, and which events matter.
 */
import { describe, it, expect } from "vitest";
import {
    containerActions, containerRows, containerSections, eventEffect, formatAge, formatPort, formatSize, imageRows, imageSections,
    imageUsers, isActive, parseContainer, parseContainers, parseImages, parseStats, stateText, stateTone,
} from "../../src/pages/podman/model.js";
import { BUILDER, CACHE, container, DB, image, inspect, ROUTER, WEB } from "./podman.fixture.js";

const NOW = Math.floor(Date.now() / 1000);
const user = parseContainers("user", [WEB, DB, BUILDER, CACHE]);
const [web, db, builder, cache] = user as [ReturnType<typeof parseContainer> & object, ...never[]] as never as ReturnType<typeof parseContainers>;

describe("reading podman's lists", () => {
    it("takes a container's name, image, state, health, ports and pod", () => {
        expect(web).toMatchObject({
            key: `user:${WEB.Id as string}`, owner: "user", name: "web", image: "registry.example/web:latest", state: "running",
            health: "healthy", pod: "", isInfra: false,
        });
        expect(web!.ports).toEqual([
            { hostIp: "", hostPort: 8081, containerPort: 80, range: 1, protocol: "tcp" },
            { hostIp: "", hostPort: 8443, containerPort: 8443, range: 1, protocol: "tcp" },
        ]);
        expect(cache).toMatchObject({ podName: "apps", state: "created" });
        expect(typeof web!.created).toBe("number");
    });

    it("survives junk: this is host data", () => {
        expect(parseContainers("user", "nonsense")).toEqual([]);
        expect(parseContainers("user", [null, 5, {}, { Id: "" }, { Id: "abcdef0123456789", Names: [7], Ports: [{}, "x"] }]))
                .toMatchObject([{ id: "abcdef0123456789", name: "abcdef012345", ports: [], state: "unknown" }]);
        expect(parseImages("user", [{}, { Id: "x", RepoTags: null }])).toMatchObject([{ id: "x", name: "<none> x", tags: [] }]);
        expect(parseStats({ Error: { message: "no" }, Stats: [] })).toBeNull();
        expect(parseStats("x")).toEqual(new Map());
    });

    it("reads images, naming an untagged one by its id", () => {
        const images = parseImages("system", [image("web", { size: 62_400_000 }), image("old", { tags: ["<none>:<none>"], id: "0123456789abcdef0123", containers: 0 })]);
        expect(images[0]).toMatchObject({ key: "system:web-image", name: "registry.example/web:latest", size: 62_400_000, containers: 1 });
        expect(images[1]).toMatchObject({ name: "<none> 0123456789ab", tags: [], containers: 0 });
    });

    it("reads a stats line by container id", () => {
        const stats = parseStats({ Error: null, Stats: [{ ContainerID: "a", CPU: 1.5, MemUsage: 100, MemLimit: 1000 }, { CPU: 3 }] });
        expect([...stats!]).toEqual([["a", { cpu: 1.5, memory: 100, memoryLimit: 1000 }]]);
    });
});

describe("words", () => {
    it("writes ports as podman's -p takes them", () => {
        expect(web!.ports.map(formatPort)).toEqual(["8081:80/tcp", "8443:8443/tcp"]);
        expect(formatPort(db!.ports[0]!)).toBe("127.0.0.1:5432:5432/tcp");
        expect(formatPort({ hostIp: "", hostPort: 8000, containerPort: 9000, range: 3, protocol: "udp" })).toBe("8000-8002:9000-9002/udp");
        expect(formatPort({ hostIp: "", hostPort: 0, containerPort: 80, range: 1, protocol: "tcp" })).toBe("80/tcp");
    });

    it("says a state, with the exit code or the health when they matter", () => {
        expect(stateText(web!)).toBe("Running");
        expect(stateText(builder!)).toBe("Exited (1)");
        expect(stateText(parseContainer("user", container("x", { health: "unhealthy" }))!)).toBe("Running, unhealthy");
        expect(stateText(parseContainer("user", container("x", { state: "exited" }))!)).toBe("Exited");
        expect([web, db, builder, cache].map(c => stateTone(c!))).toEqual(["ok", "warning", "error", "dim"]);
        expect(stateTone(parseContainer("user", container("x", { health: "unhealthy" }))!)).toBe("error");
    });

    it("formats sizes and ages", () => {
        expect(formatSize(62_400_000)).toBe("62.4 MB");
        expect(formatSize(999_950_000)).toBe("1.00 GB");
        expect(formatSize(12)).toBe("12 B");
        expect(formatAge(30)).toBe("less than a minute");
        expect(formatAge(3 * 86400 + 5)).toBe("3 days");
        expect(formatAge(3600)).toBe("1 hour");
        expect(formatAge(400 * 86400)).toBe("1 year");
    });
});

describe("the lists", () => {
    const all = [...parseContainers("system", [ROUTER]), ...user];

    it("puts the user's containers first, by pod and name, and filters", () => {
        expect(containerRows(all, "all", "").map(c => `${c.owner}:${c.name}`))
                .toEqual(["user:builder", "user:db", "user:web", "user:cache", "system:router"]);
        expect(containerRows(all, "running", "").map(c => c.name)).toEqual(["web", "router"]);
        expect(containerRows(all, "all", "WEB").map(c => c.name)).toEqual(["web"]);
        expect(containerRows(all, "all", "apps").map(c => c.name)).toEqual(["cache"]);
        expect(containerRows(all, "all", "registry.example/db").map(c => c.name)).toEqual(["db"]);
    });

    it("sorts and searches images, and finds what uses one", () => {
        const images = parseImages("user", [image("web"), image("db"), image("old", { tags: [], id: "0123456789abcdef" })]);
        expect(imageRows(images, "").map(i => i.name)).toEqual(["<none> 0123456789ab", "registry.example/db:latest", "registry.example/web:latest"]);
        expect(imageRows(images, "web").map(i => i.id)).toEqual(["web-image"]);
        expect(imageRows(images, "0123").map(i => i.id)).toEqual(["0123456789abcdef"]);
        expect(imageUsers(images[0]!, all).map(c => c.name)).toEqual(["web"]);
        // Another owner's container with the same image id does not count.
        expect(imageUsers(parseImages("system", [image("web")])[0]!, all)).toEqual([]);
    });
});

describe("what a state allows", () => {
    const keys = (c: (typeof user)[number]) => containerActions(c).map(a => `${a.key} ${a.label}`);

    it("offers stop, restart and pause for a running container, start for one that is not", () => {
        expect(keys(web!)).toEqual(["S stop", "r restart", "p pause", "d delete"]);
        expect(keys(db!)).toEqual(["p resume", "S stop", "d delete"]);
        expect(keys(builder!)).toEqual(["s start", "d delete"]);
        expect(keys(cache!)).toEqual(["s start", "d delete"]);
        expect([web, db, builder, cache].map(c => isActive(c!))).toEqual([true, true, false, false]);
    });
});

describe("details", () => {
    const fields = (sections: { title: string, fields: { label: string, value: string }[] }[]) =>
        sections.flatMap(s => s.fields.map(f => `${s.title}/${f.label}=${f.value}`));

    it("describes a container from the list alone, then with its inspection", () => {
        const bare = fields(containerSections(web!, undefined, null, NOW));
        expect(bare).toContain("Container/Name=web");
        expect(bare).toContain("Status/State=Running");
        expect(bare).toContain("Status/Up since=3 days ago");
        expect(bare).toContain("Status/Health=healthy");
        expect(bare).toContain("Integration/Ports=8081:80/tcp, 8443:8443/tcp");

        const full = fields(containerSections(web!, inspect("web"), { cpu: 1.26, memory: 12_400_000, memoryLimit: 8e9 }, NOW));
        expect(full).toContain("Container/Entrypoint=/docker-entrypoint.sh");
        expect(full).toContain("Container/Command=nginx -g daemon off;");
        expect(full).toContain("Status/Restart policy=always");
        expect(full).toContain("Status/CPU=1.3%");
        expect(full).toContain("Status/Memory=12.4 MB of 8.00 GB");
        expect(full).toContain("Integration/Network=podman (10.88.0.5)");
        expect(full).toContain("Integration/Volume=/srv/www (read-only) -> /usr/share/nginx/html");
        expect(full).toContain("Integration/Volume=webdata -> /data");
    });

    it("names environment variables without their values", () => {
        const full = fields(containerSections(web!, inspect("web"), null, NOW));
        expect(full).toContain("Environment/Variables=PATH, SECRET_TOKEN");
        expect(full.join("\n")).not.toContain("hunter2");
    });

    it("says when a stopped container exited, and why it failed", () => {
        const failed = fields(containerSections(builder!, { State: { Error: "crun: no such file", OOMKilled: true } }, null, NOW));
        expect(failed).toContain("Status/State=Exited (1)");
        expect(failed).toContain("Status/Exited=2 hours ago");
        expect(failed).toContain("Status/Error=crun: no such file");
        expect(failed).toContain("Status/Out of memory=killed by the kernel");
    });

    it("describes an image and what uses it", () => {
        const [img] = parseImages("user", [image("web", { size: 62_400_000 })]);
        expect(fields(imageSections(img!, [web!], NOW))).toEqual([
            "Image/ID=web-image", "Image/Owner=user", "Image/Tags=registry.example/web:latest", "Image/Size=62.4 MB",
            "Image/Created=3 months ago", "Image/Used by=web",
        ]);
        expect(fields(imageSections(img!, [], NOW)).at(-1)).toBe("Image/Used by=no container");
    });
});

describe("events", () => {
    it("re-reads the containers for what changes a row, and nothing for what does not", () => {
        for (const action of ["start", "died", "stop", "pause", "unpause", "health_status", "rename", "cleanup"])
            expect(eventEffect({ Type: "container", Action: action })).toEqual({ containers: true, images: false });
        for (const action of ["exec", "attach", "mount", "kill", "exec_died", "sync"])
            expect(eventEffect({ Type: "container", Action: action })).toEqual({ containers: false, images: false });
        expect(eventEffect({ Type: "container", Action: "remove" })).toEqual({ containers: true, images: true });
        expect(eventEffect({ Type: "image", Action: "pull" })).toEqual({ containers: false, images: true });
        expect(eventEffect({ Type: "pod", Action: "start" })).toEqual({ containers: true, images: false });
        expect(eventEffect({ Type: "volume", Action: "create" })).toEqual({ containers: false, images: false });
        expect(eventEffect(null)).toEqual({ containers: false, images: false });
    });
});
