/*
 * The Storage page against the mock bridge: the device tree, its details,
 * staying current from UDisks2's signals, and every action -- asserting the
 * exact D-Bus calls and commands each one sends, and that none is sent
 * without administrative access or before the question is answered.
 */
import { describe, it, expect, afterEach } from "vitest";
import StoragePage from "../../src/pages/storage/index.js";
import { storeSettings } from "../../src/pages/storage/store.js";
import { renderPage, type RenderedPage } from "../helpers/page.js";
import { cleanup, keys } from "../helpers/ink.js";
import { startMock, type JsonObject, type MockBridge, type MockScenario } from "../mock-bridge/harness.js";
import { initInfo } from "../../src/session.js";
import { ay, B, block, fstab, scenario, U } from "./storage.fixture.js";

let mock: MockBridge | null = null;

afterEach(() => {
    cleanup();
    mock?.close();
    mock = null;
});

async function start(s: MockScenario, options: { allowed?: boolean, columns?: number, rows?: number, showHints?: boolean, panels?: boolean } = {}): Promise<RenderedPage> {
    mock = await startMock(s);
    await initInfo();
    const r = renderPage(StoragePage, {
        columns: options.columns ?? 120, rows: options.rows ?? 30, allowed: options.allowed ?? false,
        ...(options.showHints ? { showHints: true } : {}), ...(options.panels ? { panels: true } : {}),
    });
    return r;
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
        out.push([path.replace(`${B}/`, ""), `${iface.replace(`${U}.`, "")}.${method}`, args, message.type as string | undefined]);
    }
    return out;
}

const READS = new Set(["org.freedesktop.DBus.ObjectManager.GetManagedObjects", "Manager.CanFormat", "Manager.EnableModule"]);

/** The calls that change something. */
function changes(): [string, string, unknown[], string | undefined][] {
    return calls().filter(call => !READS.has(call[1]));
}

function spawned(): { argv: string[], superuser: unknown }[] {
    return mock!.opened("stream").map(open => ({ argv: open.spawn as string[], superuser: open.superuser }));
}

/** Move the selection down to the row that starts with `name`. */
async function select(r: RenderedPage, name: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
        const line = r.lastFrame().split("\n").find(l => l.startsWith("›"));
        if (line?.includes(name))
            return;
        await r.press(keys.down);
    }
    throw new Error(`no row ${name}:\n${r.lastFrame()}`);
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("the device tree", () => {
    it("shows drives, what is in them, and volume groups", async () => {
        const r = await start(scenario());
        const frame = await r.waitFor("vg0");
        const lines = frame.split("\n").map(l => l.replace(/\s+/g, " ").trim());
        expect(lines).toContain("› ACME Disk One (SER1) sda Partitions (gpt) 500 GB");
        expect(lines).toContain("├─sda2 xfs filesystem not mounted 100 GB");
        expect(lines).toContain("└─sda3 LVM2 physical volume vg0 399 GB");
        expect(lines).toContain("ACME Disk Three (SER3) sdc Encrypted (LUKS2) locked 8.00 TB");
        expect(lines).toContain("ACME Disk Four (SER4) sdd Unformatted 2.00 TB");
        expect(lines).toContain("└─swap vg0/swap Swap active 4.00 GB");
    });

    it("shows how full mounted filesystems are", async () => {
        const r = await start(scenario());
        const frame = await r.waitFor("3.9 / 4.0 TB");
        const lines = frame.split("\n").map(l => l.replace(/\s+/g, " ").trim());
        // Used and total in the total's unit, and a bar: nearly full, and a quarter full.
        expect(lines).toContain("└─luks-b xfs filesystem /mnt/disk 3.9 / 4.0 TB ███████░");
        expect(lines).toContain("├─root vg0/root xfs filesystem / 20 / 80 GB ██░░░░░░");
        // What is not a mounted filesystem keeps its size alone.
        expect(lines).toContain("ACME Disk Three (SER3) sdc Encrypted (LUKS2) locked 8.00 TB");
    });

    it("reads everything with one call and one match rule, at the session's privilege", async () => {
        const r = await start(scenario());
        await r.waitFor("vg0");
        expect(calls().map(c => c[1])).toEqual(["org.freedesktop.DBus.ObjectManager.GetManagedObjects"]);
        const open = mock!.opened("dbus-json3")[0]!;
        expect(open).toMatchObject({ name: "org.freedesktop.UDisks2", bus: "system", superuser: "try" });
        const rules = mock!.received().filter(e => e.data?.includes("add-match")).map(e => JSON.parse(e.data!)["add-match"]);
        expect(rules).toEqual([{ path_namespace: "/org/freedesktop/UDisks2" }]);
    });

    it("asks for the lvm2 module when UDisks2 has not loaded it", async () => {
        const s = scenario({ Manager: { EnableModule: { in: ["s", "b"], reply: [] } } });
        delete (s.dbus!.system as Record<string, Record<string, unknown>>)["/org/freedesktop/UDisks2/Manager"]![`${U}.Manager.LVM2`];
        const r = await start(s);
        await r.waitFor("vg0");
        await mock!.waitForReceived(e => e.data?.includes("EnableModule") ?? false);
        expect(calls().find(c => c[1] === "Manager.EnableModule")).toEqual(["/org/freedesktop/UDisks2/Manager", "Manager.EnableModule", ["lvm2", true], "sb"]);
    });

    it("says so when UDisks2 is not there", async () => {
        const r = await start({ dbusOwners: { system: { "org.freedesktop.UDisks2": null } } });
        await r.waitFor("UDisks2 is not available on this host");
    });

    it("follows a mount, a new device and a removed one from signals", async () => {
        const s = scenario({
            "sdd.Block": {
                Rescan: {
                    reply: [],
                    effects: [
                        { properties: [`${B}/sda2`, `${U}.Filesystem`, { MountPoints: { t: "aay", v: [ay("/srv/data").v] } }] },
                        { added: [`${B}/sde`, { [`${U}.Block`]: block("/dev/sde", { size: 16_000_000_000, usage: "filesystem", type: "ext4" }) }] },
                        { removed: [`${B}/sdc`] },
                    ],
                },
            },
        });
        const r = await start(s);
        await r.waitFor("vg0");
        // Something on the host changes: here, set off through the mock.
        const cockpit = (await import("../../src/cockpit.js")).default;
        const client = cockpit.dbus("org.freedesktop.UDisks2", { bus: "system" });
        await client.call(`${B}/sdd`, `${U}.Block`, "Rescan", [{}], { type: "a{sv}" });
        client.close();
        const frame = await r.waitFor(f => f.includes("/srv/data") && f.includes("sde") && !f.includes("sdc"));
        expect(frame.replace(/ +/g, " ")).toContain("sde ext4 filesystem not mounted 16.0 GB");
    });

    it("gives every top-level device a panel of its own when there is room", async () => {
        const r = await start(scenario(), { panels: true, rows: 40 });
        const frame = await r.waitFor("vg0");
        const lines = frame.split("\n");
        // The plots, then one header line, its columns over the panels' own.
        const header = lines.findIndex(l => /^ {3}Name\s+Content\s+Location\s+Used \/ Size/.test(l));
        expect(header).toBeGreaterThan(0);
        const titles = lines.slice(header).filter(l => /^┌─┤ /.test(l)).map(l => l.match(/┤ (.+?) ├/)![1]);
        expect(titles).toEqual(["ACME Disk One (SER1)", "ACME Disk Two (SER2)", "ACME Disk Three (SER3)", "ACME Disk Four (SER4)", "vg0"]);
        // Inside a panel the top-level row is named by its device; its name is the title.
        expect(lines[header + 2]!.replace(/\s+/g, " ")).toBe("│› sda Partitions (gpt) 500 GB │");
        expect(lines[header + 3]!.replace(/\s+/g, " ")).toBe("│ ├─sda1 vfat filesystem /boot/efi 6.0 / 600 MB █░░░░░░░│");
        const vg = lines.findIndex(l => l.includes("┤ vg0 ├"));
        expect(lines[vg + 1]!.replace(/\s+/g, " ")).toBe("│ Volume group LVM2 volume group 315 GB free 399 GB │");
        // Columns line up from panel to panel.
        const at = (line: string, text: string) => line.indexOf(text);
        expect(at(lines[header + 2]!, "Partitions")).toBe(at(lines[vg + 1]!, "LVM2 volume group"));
        expect(at(lines[header]!, "Content")).toBe(at(lines[header + 2]!, "Partitions"));
    });

    it("moves through the panels as one list and scrolls them whole", async () => {
        const r = await start(scenario(), { panels: true, rows: 24, allowed: true, showHints: true });
        const frame = await r.waitFor("ACME Disk One");
        // Not everything fits under the plots: the last panels are out of sight.
        expect(frame).not.toContain("┤ vg0 ├");
        expect(frame).toMatch(/ACME Disk One \(SER1\) ├─+ 1\/11 ─┐/);
        for (let i = 0; i < 6; i++)
            await r.press(keys.down);
        const moved = await r.waitFor(f => (f.split("\n").find(l => l.includes("›")) ?? "").includes("sdc"));
        expect(moved).toMatch(/ACME Disk Three \(SER3\) ├─+ 7\/11 ─┐/);
        expect(moved).toMatch(/hints: enter details \| o unlock \| f format/);
        await r.press(keys.end);
        const last = await r.waitFor("┤ vg0 ├");
        expect(last).not.toContain("ACME Disk One");
        expect(last.split("\n").find(l => l.includes("›"))).toContain("swap");
        // Back up: the first panels return.
        await r.press(keys.home);
        const back = await r.waitFor("ACME Disk One");
        expect(back.split("\n").find(l => l.includes("›"))).toContain("sda");
    });

    it("plots what the drives read and write, adding up whole drives only", async () => {
        const MIB = 1024 * 1024;
        storeSettings.timings = { throughputMs: 100 };
        // Counters, sampled every 100 ms: sda reads 2 MiB/s then 6, sdb 1 then 2; sda1 and dm-3 repeat their drives' bytes.
        const step = (sda: number, sdb: number) => ({ sda: sda * MIB / 10, sda1: sda * MIB / 10, sdb: sdb * MIB / 10, "dm-3": sdb * MIB / 10, sr0: 0 });
        const s = scenario({}, {
            metrics: {
                "mount.used": { instances: ["/"], samples: [[1]] },
                "mount.total": { instances: ["/"], samples: [[2]] },
                "disk.dev.read": { samples: [step(0, 0), step(2, 1), step(8, 3), step(8, 3)] },
                "disk.dev.written": { samples: [step(0, 0), step(0, 0.5), step(0, 0.5), step(0, 0.5)] },
            },
        });
        try {
            const r = await start(s, { panels: true, rows: 40 });
            const frame = await r.waitFor(f => /MiB\/s Reading ├─+ 0 ─┐/.test(f) && f.includes("█"));
            const lines = frame.split("\n");
            expect(lines[0]).toMatch(/^┌─┤ MiB\/s Reading ├─+ 0 ─┐ +┌─┤ MiB\/s Writing ├─+ 0 ─┐/);
            // The peak was 6 + 2 = 8 MiB/s read (not 16: partitions and mapped devices are not added again).
            // Numbers down the left of each plot, and "0" at the foot beside the times.
            expect(lines.slice(1, 6).map(l => l.match(/^│ *([\d.]+) /)?.[1])).toEqual(["8", "6", "4", "2", "0"]);
            // Writing never passed 0.5 MiB/s: the scale stays at 1.
            expect(lines.slice(1, 6).map(l => l.match(/┐? +│ *([\d.]+) [^│]*│\s*$/)?.[1])).toEqual(["1", "0.75", "0.5", "0.25", "0"]);
            const open = mock!.opened("metrics1").find(o => JSON.stringify(o.metrics).includes("disk.dev.read"))!;
            expect(open.metrics).toEqual([
                { name: "disk.dev.read", units: "bytes", derive: "rate" },
                { name: "disk.dev.written", units: "bytes", derive: "rate" },
            ]);
        } finally {
            storeSettings.timings = {};
        }
    });

    it("says both rates on one line where there are no panels", async () => {
        storeSettings.timings = { throughputMs: 100 };
        const MIB = 1024 * 1024;
        const s = scenario({}, {
            metrics: {
                "mount.used": { instances: ["/"], samples: [[1]] },
                "mount.total": { instances: ["/"], samples: [[2]] },
                "disk.dev.read": { samples: [{ sda: 0 }, { sda: 0.3 * MIB }, { sda: 0.6 * MIB }] },
                "disk.dev.written": { samples: [{ sda: 0 }, { sda: 0 }, { sda: 0 }] },
            },
        });
        try {
            const r = await start(s);
            const frame = await r.waitFor("3.0 MiB/s");
            expect(frame.split("\n")[0]).toMatch(/^Reading 3\.0 MiB\/s .*Writing 0 B\/s/);
        } finally {
            storeSettings.timings = {};
        }
    });

    it("drops columns rather than names on a narrow terminal", async () => {
        const r = await start(scenario(), { columns: 60, rows: 20 });
        const frame = await r.waitFor("vg0");
        expect(frame).toContain("ACME Disk One (SER1)");
        expect(frame).toContain("/boot/efi");
        for (const line of frame.split("\n"))
            expect(line.length).toBeLessThanOrEqual(60);
    });
});

describe("details", () => {
    it("opens a device's details and goes back to the same row", async () => {
        const r = await start(scenario());
        await r.waitFor("vg0");
        await select(r, "luks-b");
        await r.press(keys.enter);
        const frame = await r.waitFor("Mount options");
        expect(frame).toMatch(/Device\s+\/dev\/mapper\/luks-b/);
        expect(frame).toMatch(/Mounted at\s+\/mnt\/disk/);
        expect(frame).toMatch(/Used\s+3\.90 TB of 4\.00 TB \(98%\)/);
        expect(frame).toContain("Changing storage requires administrative access: press A.");
        await r.press(keys.escape);
        const back = await r.waitFor("ACME Disk One");
        expect(back.split("\n").find(l => l.startsWith("›"))).toContain("luks-b");
    });

    it("says what is in the way of an action", async () => {
        const r = await start(scenario(), { allowed: true });
        await r.waitFor("vg0");
        await select(r, "ACME Disk Two");
        await r.press(keys.enter);
        const frame = await r.waitFor("Cannot lock");
        expect(frame).toContain("Cannot lock: /dev/mapper/luks-b is mounted at /mnt/disk.");
        expect(frame).toContain("Cannot format: /dev/sdb is unlocked.");
    });
});

describe("access", () => {
    it("offers no action without administrative access, and refuses the keys with the reason", async () => {
        const r = await start(scenario(), { showHints: true });
        await r.waitFor("vg0");
        await select(r, "sda2");
        expect(r.lastFrame()).toMatch(/hints: enter details \| ctrl\+r refresh/);
        await r.press("m");
        await r.waitFor("status: warning: To mount, turn on administrative access first: press A");
        await r.press("f");
        await r.waitFor("status: warning: To format, turn on administrative access first: press A");
        expect(changes()).toEqual([]);
        expect(spawned()).toEqual([]);
    });

    it("offers the selected row's actions with access", async () => {
        const r = await start(scenario(), { allowed: true, showHints: true });
        await r.waitFor("vg0");
        await select(r, "sda2");
        expect(r.lastFrame()).toMatch(/hints: enter details \| m mount \| f format \| ctrl\+r refresh/);
        await select(r, "ACME Disk Three");
        expect(r.lastFrame()).toMatch(/hints: enter details \| o unlock \| f format \| ctrl\+r refresh/);
    });

    it("refuses a blocked action with what is in the way", async () => {
        const r = await start(scenario(), { allowed: true });
        await r.waitFor("vg0");
        await select(r, "sda1");
        await r.press("u");
        await r.waitFor("status: warning: Cannot unmount: /boot/efi is needed by the running system");
        await r.press("f");
        await r.waitFor("status: warning: Cannot format: /dev/sda1 is mounted at /boot/efi");
        expect(changes()).toEqual([]);
    });
});

describe("mount and unmount", () => {
    const MOUNT = 'sh -ec mkdir -p "$2"; mount "$1" "$2" -o "$3" -- /dev/sda2 /srv/data nofail';

    it("writes the fstab line, then mounts by it, reloading systemd around both", async () => {
        const s = scenario({ "sda2.Block": { AddConfigurationItem: { reply: [] } } }, {
            spawn: { "systemctl daemon-reload": {}, [MOUNT]: {} },
        });
        const r = await start(s, { allowed: true });
        await r.waitFor("vg0");
        await select(r, "sda2");
        await r.press("m");
        await r.waitFor("The mount point is saved in /etc/fstab.");
        await r.press("/srv/data", keys.enter);
        await r.waitFor("status: success: Mounted /dev/sda2 at /srv/data");
        expect(changes()).toEqual([
            ["sda2", "Block.AddConfigurationItem", [["fstab", {
                dir: ay("/srv/data"), type: ay("auto"), opts: ay("nofail"), freq: { t: "i", v: 0 }, passno: { t: "i", v: 0 },
                "track-parents": { t: "b", v: true },
            }], {}], "(sa{sv})a{sv}"],
        ]);
        expect(spawned().map(p => p.argv.join(" "))).toEqual(["systemctl daemon-reload", MOUNT, "systemctl daemon-reload"]);
        expect(spawned().every(p => p.superuser === "require")).toBe(true);
    });

    it("checks the mount point before doing anything", async () => {
        const r = await start(scenario(), { allowed: true });
        await r.waitFor("vg0");
        await select(r, "sda2");
        await r.press("m");
        await r.waitFor("Mount point");
        await r.press(keys.enter);
        await r.waitFor("Mount point cannot be empty");
        await r.press("/mnt/disk", keys.enter);
        await r.waitFor("Mount point is already used for");
        expect(r.lastFrame()).toContain("/dev/mapper/luks-b");
        expect(changes()).toEqual([]);
        expect(spawned()).toEqual([]);
    });

    it("takes the fstab line back when the mount fails, and keeps the reason on screen", async () => {
        const s = scenario({ "sda2.Block": { AddConfigurationItem: { reply: [] }, RemoveConfigurationItem: { reply: [] } } }, {
            spawn: { "systemctl daemon-reload": {}, [MOUNT]: { "exit-status": 32, stderr: "mount: /srv/data: wrong fs type.\n" } },
        });
        const r = await start(s, { allowed: true });
        await r.waitFor("vg0");
        await select(r, "sda2");
        await r.press("m");
        await r.waitFor("Mount point");
        await r.press("/srv/data", keys.enter);
        await r.waitFor("mount: /srv/data: wrong fs type.");
        expect(changes().map(c => c[1])).toEqual(["Block.AddConfigurationItem", "Block.RemoveConfigurationItem"]);
        expect(changes()[1]![2]).toEqual(changes()[0]![2]);
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("wrong fs type"));
    });

    it("unmounts and marks the fstab line noauto", async () => {
        const s = scenario({}, { spawn: { "systemctl daemon-reload": {}, "umount /mnt/disk": {} } });
        const r = await start(s, { allowed: true });
        await r.waitFor("vg0");
        await select(r, "luks-b");
        await r.press("u");
        await r.waitFor("It will stay unmounted after a reboot");
        // Nothing yet: the question has only been asked.
        expect(spawned()).toEqual([]);
        await wait(350);
        await r.press(keys.enter);
        await r.waitFor("status: success: Unmounted /dev/mapper/luks-b");
        const old = fstab("UUID=uuid-disk", "/mnt/disk", "auto", "nofail");
        const next = fstab("UUID=uuid-disk", "/mnt/disk", "auto", "noauto,nofail");
        expect(changes()).toEqual([["dm_2d3", "Block.UpdateConfigurationItem", [old, next, {}], "(sa{sv})(sa{sv})a{sv}"]]);
        expect(spawned().map(p => p.argv.join(" "))).toEqual(["systemctl daemon-reload", "umount /mnt/disk", "systemctl daemon-reload"]);
    });

    it("does nothing when the question is cancelled", async () => {
        const r = await start(scenario(), { allowed: true });
        await r.waitFor("vg0");
        await select(r, "luks-b");
        await r.press("u");
        await r.waitFor("Programs using it lose access");
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Programs using it"));
        expect(changes()).toEqual([]);
        expect(spawned()).toEqual([]);
    });
});

describe("encrypted devices", () => {
    it("unlocks with a passphrase that is never shown", async () => {
        const s = scenario({
            "sdc.Encrypted": {
                Unlock: {
                    reply: [`${B}/dm_2d5`], out: ["o"],
                    effects: [
                        { added: [`${B}/dm_2d5`, { [`${U}.Block`]: block("/dev/dm-5", { preferred: "/dev/mapper/luks-c", size: 7_999_000_000_000, usage: "filesystem", type: "xfs", backing: `${B}/sdc` }) }] },
                        { properties: [`${B}/sdc`, `${U}.Encrypted`, { CleartextDevice: { t: "o", v: `${B}/dm_2d5` } }] },
                    ],
                },
            },
        });
        const r = await start(s, { allowed: true });
        await r.waitFor("vg0");
        await select(r, "ACME Disk Three");
        await r.press("o");
        await r.waitFor("Passphrase");
        await r.press(keys.enter);
        await r.waitFor("Passphrase cannot be empty");
        await r.press("s3cret");
        expect(r.lastFrame()).not.toContain("s3cret");
        await r.press(keys.enter);
        await r.waitFor("status: success: Unlocked /dev/sdc");
        const [path, method, args, type] = changes()[0]!;
        expect([path, method, args, type]).toEqual(["sdc", "Encrypted.Unlock", ["s3cret", {}], "sa{sv}"]);
        // The cleartext device appears under it.
        const frame = await r.waitFor("luks-c");
        expect(frame.replace(/ +/g, " ")).toContain("Encrypted (LUKS2) unlocked");
    });

    it("keeps the dialog open with UDisks2's reason when the passphrase is wrong", async () => {
        const s = scenario({
            "sdc.Encrypted": { Unlock: { error: ["org.freedesktop.UDisks2.Error.Failed", ["Error unlocking /dev/sdc: Failed to activate device: Incorrect passphrase."]] } },
        });
        const r = await start(s, { allowed: true });
        await r.waitFor("vg0");
        await select(r, "ACME Disk Three");
        await r.press("o");
        await r.waitFor("Passphrase");
        await r.press("wrong", keys.enter);
        await r.waitFor("Incorrect passphrase.");
        expect(r.lastFrame()).toContain("Unlock /dev/sdc");
    });

    it("locks a device nothing is using", async () => {
        const s = scenario();
        // Unmounted: nothing in the way.
        const fs = (s.dbus!.system as Record<string, Record<string, { properties: Record<string, unknown> }>>)[`${B}/dm_2d3`]![`${U}.Filesystem`]!;
        fs.properties.MountPoints = { t: "aay", v: [] };
        const r = await start(s, { allowed: true });
        await r.waitFor("vg0");
        await select(r, "ACME Disk Two");
        await r.press("l");
        await r.waitFor("Its contents cannot be read again");
        await wait(350);
        await r.press(keys.enter);
        await r.waitFor("status: success: Locked /dev/sdb");
        expect(changes()).toEqual([["sdb", "Encrypted.Lock", [{}], "a{sv}"]]);
    });
});

describe("swap", () => {
    it("stops swap and marks its fstab line noauto", async () => {
        const r = await start(scenario(), { allowed: true });
        await r.waitFor("vg0");
        await select(r, "swap");
        await r.press("x");
        await r.waitFor("has to fit back into memory");
        await wait(350);
        await r.press(keys.enter);
        await r.waitFor("status: success: Stopped swap on /dev/vg0/swap");
        expect(changes()).toEqual([
            ["dm_2d1", "Swapspace.Stop", [{}], "a{sv}"],
            ["dm_2d1", "Block.UpdateConfigurationItem", [
                fstab("/dev/mapper/vg0-swap", "none", "swap", "defaults"), fstab("/dev/mapper/vg0-swap", "none", "swap", "noauto"), {},
            ], "(sa{sv})(sa{sv})a{sv}"],
        ]);
    });
});

describe("format", () => {
    it("offers only what the host can make, and wants the device's name typed", async () => {
        const s = scenario({ "sdd.Block": { Format: { reply: [] } } });
        const r = await start(s, { allowed: true });
        await r.waitFor("vg0");
        await select(r, "ACME Disk Four");
        await r.press("f");
        const frame = await r.waitFor("< XFS >");
        expect(frame).toContain("Formatting /dev/sdd (2.00 TB) destroys everything on it.");
        // xfs, ext4 and swap pass CanFormat; vfat does not (no mkfs.vfat).
        expect(calls().filter(c => c[1] === "Manager.CanFormat").map(c => c[2]![0]).sort()).toEqual(["ext4", "swap", "vfat", "xfs"]);
        await r.press(keys.right);
        await r.waitFor("< ext4 >");
        await r.press(keys.right);
        await r.waitFor("< Swap >");
        await r.press(keys.right);
        await r.waitFor("< No filesystem (wipe only) >");
        await r.press(keys.right);
        await r.waitFor("< XFS >");

        // Enter without the name: nothing happens.
        await r.press(keys.enter);
        await r.waitFor("Type sdd to confirm");
        expect(changes()).toEqual([]);

        await r.press(keys.down, "backup", keys.down, keys.down, "sdd", keys.enter);
        await r.waitFor("status: success: Formatted /dev/sdd as xfs");
        expect(changes()).toEqual([
            ["sdd", "Block.Format", ["xfs", { "tear-down": { t: "b", v: true }, label: { t: "s", v: "backup" } }], "sa{sv}"],
        ]);
        expect(spawned().map(p => p.argv.join(" "))).toEqual(["systemctl daemon-reload", "systemctl daemon-reload"]);
    });

    it("can be cancelled while the host is still being asked what it can format", async () => {
        const s = scenario({ Manager: { CanFormat: { in: ["s"], out: ["(bs)"], reply: [[true, ""]], delayMs: 2000 } } });
        const r = await start(s, { allowed: true });
        await r.waitFor("vg0");
        await select(r, "ACME Disk Four");
        await r.press("f");
        await r.waitFor("Checking what this host can format");
        // Enter does nothing yet; Esc closes.
        await r.press(keys.enter);
        await r.press(keys.escape);
        await r.waitFor(f => !f.includes("Format /dev/sdd"));
        expect(changes()).toEqual([]);
        expect(spawned()).toEqual([]);
    });

    it("says how many partitions go with a disk", async () => {
        const s = scenario();
        const tree = s.dbus!.system as Record<string, Record<string, { properties: Record<string, unknown> }>>;
        tree[`${B}/sda1`]![`${U}.Filesystem`]!.properties.MountPoints = { t: "aay", v: [] };
        delete (tree[`${B}/sda3`] as Record<string, unknown>)[`${U}.PhysicalVolume`];
        tree[`${B}/sda3`]![`${U}.Block`]!.properties.IdType = "";
        tree[`${B}/sda3`]![`${U}.Block`]!.properties.IdUsage = "";
        const r = await start(s, { allowed: true });
        await r.waitFor("vg0");
        await r.press("f");
        await r.waitFor("destroys its 3 partitions");
    });
});
