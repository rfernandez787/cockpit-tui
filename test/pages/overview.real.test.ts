/*
 * The overview's data sources against a real cockpit-bridge, checked against
 * what this machine says about itself through other routes (Node's os
 * module, /proc and /sys read directly, systemctl).
 *
 * Strictly read-only: only reads, watches, Get/GetAll/List* calls and
 * systemd's Subscribe (which changes nothing but what this connection is
 * sent). No Set* call, no shutdown, no key that acts. Opening the hostname1
 * and timedate1 channels may D-Bus-activate those daemons, exactly as viewing
 * the page in Cockpit does; they exit again when idle.
 *
 * Skips without a bridge, and each check that needs systemd, DMI or a
 * particular file skips itself when the machine lacks it (a container).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import cockpit from "../../src/cockpit.js";
import { initInfo } from "../../src/session.js";
import { localTransport, type StreamTransport } from "../../src/transport/stream.js";
import { run, runFull, unvariant } from "../../src/tui/hooks.js";
import OverviewPage from "../../src/pages/overview/index.js";
import { readFile } from "../../src/pages/overview/data.js";
import { listTimezones } from "../../src/pages/overview/dialogs.js";
import {
    Decompressor, MACHINE_INFO_ARGV, USAGE_METRICS, VIRTUAL_NET_ARGV, parseMachineInfo, parseNameList, usageModel,
    type Sample,
} from "../../src/pages/overview/metrics.js";
import {
    DATE_ARGV, DMI_ARGV, DMI_ENVIRON, SCHEDULE_FILE, UNAME_ARGV, countsAsFailed, hostnameText, manualTimeArgv, parseDate,
    parseDmi, parseUname, parseUptime,
} from "../../src/pages/overview/system.js";
import { renderPage } from "../helpers/page.js";
import { cleanup } from "../helpers/ink.js";

const haveBridge = spawnSync("cockpit-bridge", ["--version"], { stdio: "ignore" }).status === 0;
const haveSystemd = existsSync("/run/systemd/system");
const haveDmi = existsSync("/sys/class/dmi/id");
const haveGerman = (spawnSync("locale", ["-a"], { encoding: "utf8" }).stdout ?? "").split("\n")
    .some(name => /^de_DE\.utf-?8$/i.test(name.trim()));

let active: StreamTransport | null = null;

async function connect(): Promise<void> {
    const transport = localTransport({ onStderr: () => {} });
    transport.install();
    active = transport;
    await transport.connect();
    await initInfo();
}

afterEach(() => {
    cleanup();
    active?.close();
    active = null;
});

/** A watched proxy's properties, once they have arrived. */
async function properties(name: string, path: string): Promise<{ data: Record<string, unknown>, client: cockpit.DBusClient }> {
    const client = cockpit.dbus(name, { bus: "system" });
    const proxy = client.proxy(name, path) as unknown as { wait(): Promise<void>, data: Record<string, unknown> };
    await proxy.wait();
    return { data: { ...proxy.data }, client };
}

/** Every message of a metrics1 channel until `count` data rows have arrived. */
function metricsRows(count: number, interval: number): Promise<{ meta: unknown, rows: Sample[] }> {
    return new Promise((resolve, reject) => {
        const decompressor = new Decompressor();
        const rows: Sample[] = [];
        const channel = cockpit.channel({
            payload: "metrics1", source: "internal", interval, metrics: USAGE_METRICS.map(m => ({ ...m })),
        });
        channel.addEventListener("message", (_event, data) => {
            rows.push(...decompressor.push(JSON.parse(data)));
            if (rows.length >= count) {
                channel.close();
                resolve({ meta: decompressor.meta, rows });
            }
        });
        channel.addEventListener("close", ((_event: unknown, options: Record<string, unknown>) => {
            if (rows.length < count)
                reject(new Error(`metrics channel closed: ${JSON.stringify(options)}`));
        }) as never);
    });
}

describe.skipIf(!haveBridge)("the overview's data sources against a real bridge", () => {
    it.skipIf(!haveSystemd)("reads the host names and OS from hostname1", async () => {
        await connect();
        const { data, client } = await properties("org.freedesktop.hostname1", "/org/freedesktop/hostname1");
        client.close();
        for (const key of ["Hostname", "StaticHostname", "PrettyHostname", "OperatingSystemPrettyName", "KernelRelease"])
            expect(typeof data[key], key).toBe("string");
        const text = hostnameText(String(data.PrettyHostname), String(data.StaticHostname), String(data.Hostname));
        expect(text).toContain(String(data.StaticHostname || data.Hostname));
        expect(data.Hostname).toBe(os.hostname());
        expect(data.KernelRelease).toBe(os.release());
    });

    it.skipIf(!haveSystemd)("reads the time settings from timedate1, and its zone list", async () => {
        await connect();
        const { data, client } = await properties("org.freedesktop.timedate1", "/org/freedesktop/timedate1");
        try {
            expect(typeof data.Timezone).toBe("string");
            expect(typeof data.NTP).toBe("boolean");
            expect(typeof data.CanNTP).toBe("boolean");
            // No change signal for this one: the page polls it like this.
            const [synced] = await client.call("/org/freedesktop/timedate1", "org.freedesktop.DBus.Properties", "Get",
                                               ["org.freedesktop.timedate1", "NTPSynchronized"]);
            expect(typeof unvariant(synced)).toBe("boolean");
            const zones = await listTimezones(client);
            expect(zones.length).toBeGreaterThan(100);
            expect(zones).toContain("UTC");
            if (data.Timezone && existsSync(`/usr/share/zoneinfo/${String(data.Timezone)}`) &&
                !String(data.Timezone).includes("US/"))
                expect(zones).toContain(data.Timezone);
        } finally {
            client.close();
        }
    });

    it.skipIf(!haveSystemd)("lists failed units the way the page counts them", async () => {
        await connect();
        const client = cockpit.dbus("org.freedesktop.systemd1", { bus: "system", superuser: "try" });
        try {
            const [rows] = await client.call("/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
                                             "ListUnitsFiltered", [["failed"]]);
            expect(Array.isArray(rows)).toBe(true);
            const counted = (rows as unknown[][])
                .filter(row => countsAsFailed(String(row[0]), String(row[2]), String(row[3])))
                .map(row => String(row[0]))
                .sort();
            for (const row of rows as unknown[][]) {
                expect(row).toHaveLength(10);
                expect(String(row[6])).toMatch(/^\/org\/freedesktop\/systemd1\/unit\//);
            }
            // The same set as systemctl reports, by the same rule.
            const listed = spawnSync("systemctl", ["list-units", "--state=failed", "--all", "--plain", "--no-legend",
                                                   "--no-pager"], { encoding: "utf8" });
            if (listed.status === 0) {
                const expected = listed.stdout.split("\n")
                    .map(line => line.trim().split(/\s+/))
                    .filter(parts => parts[0] && countsAsFailed(parts[0], parts[1], parts[2]))
                    .map(parts => parts[0]!)
                    .sort();
                expect(counted).toEqual(expected);
            }
        } finally {
            client.close();
        }
    });

    it.skipIf(!existsSync("/run/systemd") || existsSync(SCHEDULE_FILE))("sees no shutdown schedule file when none is scheduled", async () => {
        await connect();
        const file = cockpit.file(SCHEDULE_FILE);
        try {
            const first = await new Promise<{ content: unknown, tag: unknown }>(resolve => {
                const watch = file.watch((content, tag) => {
                    watch.remove();
                    resolve({ content, tag });
                });
            });
            expect(first.content).toBeNull();
            expect(first.tag).toBe("-");
        } finally {
            file.close();
        }
    });

    it("reads the totals and CPU count like upstream's machine_info", async () => {
        await connect();
        const info = parseMachineInfo(await run([...MACHINE_INFO_ARGV]));
        expect(info.cpus).toBe(os.cpus().length);
        expect(Math.abs(info.memTotal! - os.totalmem()) / os.totalmem()).toBeLessThan(0.01);
        const meminfo = readFileSync("/proc/meminfo", "utf8");
        const swapKb = Number(/^SwapTotal:\s*(\d+)/m.exec(meminfo)?.[1] ?? 0);
        expect(info.swapTotal).toBe(swapKb * 1024);
    });

    it("reads the kernel, the clock, uptime, machine id and interfaces", async () => {
        await connect();
        expect(parseUname(await run([...UNAME_ARGV]))).toEqual({ release: os.release(), arch: os.machine() });

        const before = Date.now();
        const clock = parseDate(await run([...DATE_ARGV]));
        expect(clock).not.toBeNull();
        expect(Math.abs(clock!.epoch * 1000 - before)).toBeLessThan(5000);
        // The host's own zone, as `date` reports it without a TZ.
        const env = { ...process.env };
        delete env.TZ;
        const hostZone = spawnSync("date", ["+%z"], { encoding: "utf8", env }).stdout.trim();
        expect(clock!.offset).toBe(parseDate(`0 ${hostZone}`)!.offset);
        expect(clock!.abbreviation).not.toBe("");

        const uptime = parseUptime(await readFile("/proc/uptime"));
        expect(Math.abs(uptime! - os.uptime())).toBeLessThan(5);

        if (existsSync("/etc/machine-id"))
            expect((await readFile("/etc/machine-id"))!.trim()).toMatch(/^[0-9a-f]{32}$/);

        expect(parseNameList(await run([...VIRTUAL_NET_ARGV])).has("lo")).toBe(true);
    });

    it("reads the host's zone, not one a TZ in the bridge's environment names", async () => {
        // A local bridge inherits our environment; a user's TZ (here one no
        // real host is in, UTC+14) must not stand in for the host's zone,
        // for the clock shown or for a manual time typed into the dialog.
        await connect();
        const plain = parseDate(await run([...DATE_ARGV]));
        const elsewhere = parseDate(await run([...DATE_ARGV], { environ: ["TZ=Pacific/Kiritimati"] }));
        expect(elsewhere!.offset).toBe(plain!.offset);
        expect(elsewhere!.abbreviation).toBe(plain!.abbreviation);
        const typed = "2026-10-02 21:30:00";
        expect(await run(manualTimeArgv(typed), { environ: ["TZ=Pacific/Kiritimati"] }))
            .toBe(await run(manualTimeArgv(typed)));
    });

    it.skipIf(!haveDmi || !haveGerman)("knows the serial is root's whatever the bridge's locale", async () => {
        let serialReadable = true;
        try {
            accessSync("/sys/class/dmi/id/product_serial", constants.R_OK);
        } catch {
            serialReadable = false;
        }
        if (serialReadable)
            return; // running as root: nothing is denied
        await connect();
        // A bridge in a German session: grep says "Keine Berechtigung"...
        const german = ["LANG=de_DE.UTF-8", "LANGUAGE=de"];
        const translated = await runFull([...DMI_ARGV], { superuser: "try", environ: german });
        expect(parseDmi(translated.stdout, translated.stderr).assetTagDenied).toBe(false);
        // ...unless the page's environment for the spawn puts it in the C locale.
        const { stdout, stderr } = await runFull([...DMI_ARGV], { superuser: "try", environ: [...german, ...DMI_ENVIRON] });
        expect(parseDmi(stdout, stderr).assetTagDenied).toBe(true);
    });

    it.skipIf(!haveDmi)("reads DMI unprivileged, and knows when the serial is root's", async () => {
        await connect();
        const { stdout, stderr } = await runFull([...DMI_ARGV], { superuser: "try", environ: [...DMI_ENVIRON] });
        const hardware = parseDmi(stdout, stderr);
        expect(hardware.vendor || hardware.model).not.toBe("");
        let serialReadable = true;
        try {
            accessSync("/sys/class/dmi/id/product_serial", constants.R_OK);
        } catch {
            serialReadable = false;
        }
        if (!serialReadable)
            expect(hardware.assetTagDenied || hardware.assetTag !== "").toBe(true);
    });

    it("decodes a real metrics1 channel", async () => {
        await connect();
        const { meta, rows } = await metricsRows(3, 200);
        // Rates have no previous sample the first time.
        expect(rows[0]!.slice(0, 3)).toEqual([false, false, false]);
        expect(typeof rows[1]![0]).toBe("number");
        const info = parseMachineInfo(await run([...MACHINE_INFO_ARGV]));
        const virtual = parseNameList(await run([...VIRTUAL_NET_ARGV]));
        const model = usageModel(rows[2]!, meta as never, info, virtual);
        expect(model.cpuPercent).toBeGreaterThanOrEqual(0);
        expect(model.cpuPercent).toBeLessThanOrEqual(100);
        expect(model.memUsed).toBeGreaterThan(0);
        expect(model.memUsed).toBeLessThanOrEqual(info.memTotal!);
        expect(model.diskRead).toBeGreaterThanOrEqual(0);
        // Every interface /proc/net/dev lists is an instance.
        const devices = readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)
            .map(line => line.split(":")[0]!.trim()).filter(Boolean).sort();
        const instances = (meta as { metrics: { name: string, instances?: string[] }[] }).metrics
            .find(m => m.name === "network.interface.rx")!.instances!;
        expect([...instances].sort()).toEqual(devices);
    });

    it("renders the page from this host without acting on it", async () => {
        await connect();
        const r = renderPage(OverviewPage, { columns: 105, rows: 35 });
        const frame = await r.waitFor(f => f.includes(`of ${os.cpus().length} CPU`) && f.includes(os.release()) &&
                                          /failed (unit|service)/.test(f) && !f.includes("Checking for failed units"), 10_000);
        expect(frame).toContain(os.hostname().split(".")[0]!);
        expect(frame).toMatch(/up (\d+ days?, )?\d+(:\d\d| min)/);
        expect(frame).toMatch(/Architecture\s+\S+/);
        expect(frame).not.toContain("Internal error");
        expect(frame.split("\n")).toHaveLength(35);
        // Nothing was asked of the host but reads: no privileged channel was
        // opened (superuser "try" without access stays unprivileged), and no
        // dialog is showing.
        expect(frame).not.toMatch(/Restart |Shut down |Change /);
    });
});
