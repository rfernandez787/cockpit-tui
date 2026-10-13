/*
 * The Storage page's pure half: decoding, sizes, mount options, the device
 * tree, what each row can do, and its details.
 */
import { describe, it, expect } from "vitest";
import {
    activeUsage, buildRows, decodeFilename, detailSections, encodeFilename, formatCandidates, formatSize, I, labelProblem,
    mountEntry, mountOptions, mountPointProblem, mountPointUsers, mountSettings, parseManagedObjects, rowActions, withNoauto,
} from "../../src/pages/storage/model.js";
import { B, D, L, objects } from "./storage.fixture.js";

describe("values", () => {
    it("decodes the bridge's base64, NUL-terminated file names and encodes them back", () => {
        expect(decodeFilename("L2Rldi9zZGEA")).toBe("/dev/sda");
        expect(decodeFilename({ t: "ay", v: "L21udC9kaXNrMgA=" })).toBe("/mnt/disk2");
        expect(encodeFilename("/dev/sda")).toBe("L2Rldi9zZGEA");
        expect(decodeFilename(undefined)).toBe("");
        expect(decodeFilename(42)).toBe("");
    });

    it("unwraps one level of variants and survives junk", () => {
        const parsed = parseManagedObjects({
            "/a": { "x.Y": { Size: { t: "t", v: 5 }, Conf: { t: "a(sa{sv})", v: [["fstab", { dir: { t: "ay", v: "Lw==" } }]] } } },
            "/b": null,
            "/c": [1, 2],
        });
        expect([...parsed.keys()]).toEqual(["/a"]);
        expect(parsed.get("/a")!["x.Y"]).toEqual({ Size: 5, Conf: [["fstab", { dir: { t: "ay", v: "Lw==" } }]] });
        expect(parseManagedObjects("nonsense").size).toBe(0);
    });

    it("writes sizes in decimal units with three digits", () => {
        expect(formatSize(0)).toBe("0 B");
        expect(formatSize(999)).toBe("999 B");
        expect(formatSize(1000)).toBe("1.00 kB");
        expect(formatSize(629_145_600)).toBe("629 MB");
        expect(formatSize(1_000_204_886_016)).toBe("1.00 TB");
        expect(formatSize(999_950_000)).toBe("1.00 GB");
        expect(formatSize(14_000_519_643_136)).toBe("14.0 TB");
        expect(formatSize(Number.NaN)).toBe("?");
    });
});

describe("mount options", () => {
    it("reads an fstab line in the dialog's terms", () => {
        const o = objects();
        const entry = mountEntry(o.get(`${B}/dm_2d3`)![I.block]);
        expect(entry).toMatchObject({ dir: "/mnt/disk", type: "auto", options: "nofail" });
        expect(mountSettings(entry)).toEqual({ dir: "/mnt/disk", readOnly: false, atBoot: "nofail", extra: "" });
        expect(mountSettings(null)).toEqual({ dir: "", readOnly: false, atBoot: "nofail", extra: "" });
        expect(mountSettings({ item: ["fstab", {}], dir: "/x", type: "auto", options: "noauto,ro,x-cockpit-never-auto,uid=5" }))
                .toEqual({ dir: "/x", readOnly: true, atBoot: "never", extra: "uid=5" });
        expect(mountSettings({ item: ["fstab", {}], dir: "/x", type: "auto", options: "defaults" }).atBoot).toBe("local");
    });

    it("writes them back in upstream's order", () => {
        expect(mountOptions({ dir: "/x", readOnly: false, atBoot: "local", extra: "" })).toBe("defaults");
        expect(mountOptions({ dir: "/x", readOnly: true, atBoot: "nofail", extra: "uid=5" })).toBe("ro,nofail,uid=5");
        expect(mountOptions({ dir: "/x", readOnly: true, atBoot: "never", extra: "" })).toBe("noauto,ro,x-cockpit-never-auto");
        expect(mountOptions({ dir: "/x", readOnly: false, atBoot: "netdev", extra: "" })).toBe("_netdev");
    });

    it("sets and clears noauto", () => {
        expect(withNoauto("defaults", true)).toBe("noauto");
        expect(withNoauto("nofail,ro", true)).toBe("noauto,nofail,ro");
        expect(withNoauto("noauto,nofail", true)).toBe("noauto,nofail");
        expect(withNoauto("noauto", false)).toBe("defaults");
        expect(withNoauto("noauto,ro", false)).toBe("ro");
    });

    it("checks a mount point", () => {
        expect(mountPointProblem("")).toMatch(/empty/);
        expect(mountPointProblem("mnt/x")).toMatch(/absolute/);
        expect(mountPointProblem("/mnt/my disk")).toMatch(/whitespace/);
        expect(mountPointProblem("/mnt/x")).toBeNull();
        const o = objects();
        expect(mountPointUsers(o, "/mnt/disk", `${B}/sda2`)).toEqual(["/dev/mapper/luks-b"]);
        expect(mountPointUsers(o, "/mnt/disk", `${B}/dm_2d3`)).toEqual([]);
    });
});

describe("the device tree", () => {
    const rows = buildRows(objects());
    const row = (name: string) => rows.find(r => r.name === name)!;

    it("lists drives with what is inside them, then volume groups", () => {
        expect(rows.map(r => `${"  ".repeat(r.depth)}${r.name} | ${r.contentText} | ${r.location}`)).toEqual([
            "ACME Disk One (SER1) | Partitions (gpt) | ",
            "  sda1 | vfat filesystem | /boot/efi",
            "  sda2 | xfs filesystem | not mounted",
            "  sda3 | LVM2 physical volume | vg0",
            "ACME Disk Two (SER2) | Encrypted (LUKS2) | unlocked",
            "  luks-b | xfs filesystem | /mnt/disk",
            "ACME Disk Three (SER3) | Encrypted (LUKS2) | locked",
            "ACME Disk Four (SER4) | Unformatted | ",
            "vg0 | LVM2 volume group | 315 GB free",
            "  root | xfs filesystem | /",
            "  swap | Swap | active",
        ]);
    });

    it("orders partitions by offset, not by the table's list", () => {
        expect(rows.filter(r => r.kind === "partition").map(r => r.name)).toEqual(["sda1", "sda2", "sda3"]);
    });

    it("keys a drive by its drive object and a volume by its volume object, each with its block device", () => {
        expect(row("ACME Disk One (SER1)")).toMatchObject({ id: `${D}/one`, block: `${B}/sda`, device: "/dev/sda", kind: "drive" });
        expect(row("root")).toMatchObject({ id: `${L}/vg0/root`, block: `${B}/dm_2d0`, device: "/dev/vg0/root", kind: "lvol" });
        expect(row("vg0")).toMatchObject({ block: null, kind: "vgroup" });
        expect(row("luks-b")).toMatchObject({ kind: "cleartext", lasts: [true] });
    });

    it("marks last children for the tree lines", () => {
        expect(row("sda1").lasts).toEqual([false]);
        expect(row("sda3").lasts).toEqual([true]);
    });

    it("shows a drive without media, an inactive volume and a leftover block device", () => {
        const o = new Map(objects());
        o.set(`${D}/reader`, { [I.drive]: { Vendor: "", Model: "Card Reader", Serial: "", WWN: "", Size: 0, SortKey: "01hotplug/1" } });
        o.set(`${L}/vg0/idle`, { [I.logicalVolume]: { VolumeGroup: `${L}/vg0`, Name: "idle", Active: false, Size: 5e9, Type: "block", BlockDevice: "/" } });
        o.set(`${B}/md0`, { [I.block]: { Device: encodeFilename("/dev/md0"), PreferredDevice: encodeFilename("/dev/md0"), Size: 1e9, Drive: "/", CryptoBackingDevice: "/", IdUsage: "filesystem", IdType: "ext4" } });
        o.set(`${B}/loop0`, { [I.block]: { Device: encodeFilename("/dev/loop0"), Size: 0, Drive: "/", CryptoBackingDevice: "/" } });
        const all = buildRows(o);
        expect(all.find(r => r.name === "Card Reader")).toMatchObject({ contentText: "No media", block: null });
        expect(all.find(r => r.name === "idle")).toMatchObject({ contentText: "Inactive logical volume", block: null, depth: 1 });
        expect(all.at(-1)).toMatchObject({ name: "md0", kind: "block", contentText: "ext4 filesystem" });
        expect(all.some(r => r.name === "loop0")).toBe(false);
    });

    it("builds nothing from nothing", () => {
        expect(buildRows(new Map())).toEqual([]);
    });
});

describe("actions", () => {
    const o = objects();
    const rows = buildRows(o);
    const actions = (name: string) => rowActions(o, rows.find(r => r.name === name)!).map(a => [a.id, a.blocked]);

    it("offers what applies to each row, and says what is in the way", () => {
        expect(actions("sda2")).toEqual([["mount", null], ["format", null]]);
        expect(actions("sda1")).toEqual([
            ["unmount", "/boot/efi is needed by the running system"], ["format", "/dev/sda1 is mounted at /boot/efi"],
        ]);
        expect(actions("luks-b")).toEqual([["unmount", null], ["format", "/dev/mapper/luks-b is mounted at /mnt/disk"]]);
        expect(actions("ACME Disk Two (SER2)")).toEqual([
            ["lock", "/dev/mapper/luks-b is mounted at /mnt/disk"], ["format", "/dev/sdb is unlocked"],
        ]);
        expect(actions("ACME Disk Three (SER3)")).toEqual([["unlock", null], ["format", null]]);
        expect(actions("ACME Disk Four (SER4)")).toEqual([["format", null]]);
        expect(actions("swap")).toEqual([["swapoff", null], ["format", "/dev/vg0/swap is active swap"]]);
        expect(actions("sda3")).toEqual([["format", "/dev/sda3 is a physical volume of vg0"]]);
        expect(actions("vg0")).toEqual([]);
    });

    it("finds what keeps a whole disk busy", () => {
        expect(activeUsage(o, `${B}/sda`)).toEqual([
            "/dev/sda1 is mounted at /boot/efi", "/dev/sda3 is a physical volume of vg0",
        ]);
        expect(activeUsage(o, `${B}/sdd`)).toEqual([]);
    });

    it("offers the filesystems UDisks2 supports, in a fixed order", () => {
        expect(formatCandidates(o).map(t => t.value)).toEqual(["xfs", "ext4", "vfat", "swap"]);
        expect(formatCandidates(new Map())).toEqual([]);
    });

    it("limits a label by type", () => {
        expect(labelProblem("thirteen-char", "xfs")).toMatch(/12 bytes/);
        expect(labelProblem("twelve-chars", "xfs")).toBeNull();
        expect(labelProblem("x", "empty")).not.toBeNull();
        expect(labelProblem("", "empty")).toBeNull();
    });
});

describe("details", () => {
    const o = objects();
    const rows = buildRows(o);
    const fields = (name: string, usage: { used: number, total: number } | null = null) =>
        Object.fromEntries(detailSections(o, rows.find(r => r.name === name)!, usage)
                .flatMap(s => s.fields.map(f => [`${s.title}/${f.label}`, f.value])));

    it("describes a drive, with its health", () => {
        expect(fields("ACME Disk One (SER1)")).toMatchObject({
            "Drive/Model": "Disk One", "Drive/Serial number": "SER1", "Drive/Capacity": "500 GB", "Drive/Type": "Solid-state",
            "Drive/Assessment": "Disk is OK", "Drive/Temperature": "36.0 °C", "Drive/Power on hours": "10",
            "Device/Device": "/dev/sda", "Content/Content": "Partitions (gpt)", "Content/Partitions": "3",
        });
        expect(fields("ACME Disk Two (SER2)")["Drive/Type"]).toBe("Hard disk, 7200 rpm");
    });

    it("describes a filesystem, with its usage and fstab line", () => {
        expect(fields("luks-b", { used: 39e11, total: 40e11 })).toMatchObject({
            "Device/Device": "/dev/mapper/luks-b", "Content/Content": "xfs filesystem", "Content/Name": "disk",
            "Content/Mounted at": "/mnt/disk", "Content/Used": "3.90 TB of 4.00 TB (98%)", "Content/Mount point": "/mnt/disk",
            "Content/Mount options": "nofail", "Content/At boot": "Without waiting, ignore failure",
        });
        expect(fields("sda2")).toMatchObject({ "Content/Mounted at": "not mounted", "Content/Mount point": "not configured" });
    });

    it("describes volume groups, volumes, swap and encrypted devices", () => {
        expect(fields("vg0")).toMatchObject({
            "LVM2 volume group/Capacity": "399 GB", "LVM2 volume group/Free": "315 GB",
            "LVM2 volume group/Physical volumes": "/dev/sda3", "LVM2 volume group/Logical volumes": "2",
        });
        expect(fields("swap")).toMatchObject({
            "LVM2 logical volume/Volume group": "vg0", "Content/State": "active", "Content/At boot": "started",
        });
        expect(fields("ACME Disk Two (SER2)")).toMatchObject({ "Content/State": "unlocked", "Content/Stored name": "luks-b", "Content/Options": "nofail" });
        expect(fields("ACME Disk Three (SER3)")["Content/State"]).toBe("locked");
    });
});
