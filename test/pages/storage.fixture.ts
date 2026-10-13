/*
 * A made-up host's UDisks2 tree for the Storage tests, in the shapes a real
 * udisks2 2.9.4 sends through cockpit-bridge 356 (captured once, read-only;
 * no real device names or serials are kept here):
 *
 *   ACME Disk One (SER1)      sda   gpt: sda1 vfat /boot/efi, sda2 xfs (not mounted), sda3 PV of vg0
 *   ACME Disk Two (SER2)      sdb   LUKS2, unlocked -> dm-3 xfs /mnt/disk
 *   ACME Disk Three (SER3)    sdc   LUKS2, locked
 *   ACME Disk Four (SER4)     sdd   unformatted
 *   vg0                             root (dm-0, xfs /), swap (dm-1, active swap)
 */
import { parseManagedObjects, type Objects } from "../../src/pages/storage/model.js";
import type { InterfaceSpec, MethodSpec, MockScenario } from "../mock-bridge/harness.js";

export const U = "org.freedesktop.UDisks2";
export const ROOT = "/org/freedesktop/UDisks2";
export const B = `${ROOT}/block_devices`;
export const D = `${ROOT}/drives`;
export const L = `${ROOT}/lvm`;

export function ay(text: string): { t: "ay", v: string } {
    return { t: "ay", v: Buffer.from(`${text}\0`).toString("base64") };
}

export function fstab(fsname: string, dir: string, type: string, opts: string): unknown[] {
    return ["fstab", { fsname: ay(fsname), dir: ay(dir), type: ay(type), opts: ay(opts), freq: { t: "i", v: 0 }, passno: { t: "i", v: 0 } }];
}

type Tree = Record<string, Record<string, InterfaceSpec>>;

interface BlockOptions {
    preferred?: string;
    size: number;
    drive?: string;
    usage?: string;
    type?: string;
    version?: string;
    label?: string;
    uuid?: string;
    backing?: string;
    config?: unknown[][];
    readOnly?: boolean;
}

export function block(device: string, o: BlockOptions): Record<string, unknown> {
    return {
        Device: ay(device), PreferredDevice: ay(o.preferred ?? device), Symlinks: { t: "aay", v: [] },
        Id: `by-id-${device.replace(/\W/g, "-")}`, Size: { t: "t", v: o.size }, ReadOnly: o.readOnly ?? false,
        Drive: { t: "o", v: o.drive ?? "/" }, MDRaid: { t: "o", v: "/" }, MDRaidMember: { t: "o", v: "/" },
        IdUsage: o.usage ?? "", IdType: o.type ?? "", IdVersion: o.version ?? "", IdLabel: o.label ?? "", IdUUID: o.uuid ?? "",
        Configuration: { t: "a(sa{sv})", v: o.config ?? [] }, CryptoBackingDevice: { t: "o", v: o.backing ?? "/" },
        HintSystem: true, HintIgnore: false,
    };
}

function drive(model: string, serial: string, size: number, sortKey: string, rate = 7200): Record<string, unknown> {
    return {
        Vendor: "ACME", Model: model, Revision: "1.0", Serial: serial, WWN: "", Size: { t: "t", v: size },
        RotationRate: { t: "i", v: rate }, Removable: false, SortKey: sortKey,
    };
}

function part(table: string, number: number, offset: number, size: number): Record<string, unknown> {
    return {
        Number: { t: "u", v: number }, Type: "0fc63daf-8483-4772-8e79-3d69d8477de4", Offset: { t: "t", v: offset },
        Size: { t: "t", v: size }, Name: "", UUID: `part-uuid-${number}`, Table: { t: "o", v: table },
    };
}

const GB = 1_000_000_000;

export interface Methods {
    /** Methods by "<block name>.<Interface>" (e.g. "sda2.Block"), merged over the defaults. */
    readonly [key: string]: Record<string, MethodSpec | null>;
}

const props = (properties: Record<string, unknown>, methods?: Record<string, MethodSpec | null>): InterfaceSpec =>
    ({ properties, ...(methods ? { methods } : {}) }) as InterfaceSpec;

export function tree(methods: Methods = {}): Tree {
    const m = (key: string) => methods[key];
    return {
        [ROOT]: { "org.freedesktop.DBus.ObjectManager": {} },
        [`${ROOT}/Manager`]: {
            [`${U}.Manager`]: props({
                Version: "2.9.4", SupportedFilesystems: { t: "as", v: ["ext4", "vfat", "xfs", "swap", "minix"] },
            }, {
                CanFormat: {
                    in: ["s"], out: ["(bs)"], reply: [[true, ""]],
                    byArgs: [{ args: ["vfat"], reply: [[false, "mkfs.vfat"]] }],
                },
                ...m("Manager"),
            }),
            [`${U}.Manager.LVM2`]: {},
        },

        [`${D}/one`]: {
            [`${U}.Drive`]: props(drive("Disk One", "SER1", 500 * GB, "00coldplug/00fixed/sd____a", 0)),
            [`${U}.Drive.Ata`]: props({
                SmartSupported: true, SmartEnabled: true, SmartFailing: false, SmartTemperature: 309.15,
                SmartPowerOnSeconds: { t: "t", v: 36000 }, SmartNumBadSectors: { t: "x", v: 0 }, SmartNumAttributesFailing: 0,
            }),
        },
        [`${D}/two`]: { [`${U}.Drive`]: props(drive("Disk Two", "SER2", 4000 * GB, "00coldplug/00fixed/sd____b")) },
        [`${D}/three`]: { [`${U}.Drive`]: props(drive("Disk Three", "SER3", 8000 * GB, "00coldplug/00fixed/sd____c")) },
        [`${D}/four`]: { [`${U}.Drive`]: props(drive("Disk Four", "SER4", 2000 * GB, "00coldplug/00fixed/sd____d")) },

        [`${B}/sda`]: {
            [`${U}.Block`]: props(block("/dev/sda", { size: 500 * GB, drive: `${D}/one` }), m("sda.Block")),
            [`${U}.PartitionTable`]: props({ Type: "gpt", Partitions: { t: "ao", v: [`${B}/sda2`, `${B}/sda1`, `${B}/sda3`] } }),
        },
        [`${B}/sda1`]: {
            [`${U}.Block`]: props(block("/dev/sda1", {
                size: 600_000_000, drive: `${D}/one`, usage: "filesystem", type: "vfat", version: "FAT32", uuid: "AAAA-0001",
                config: [fstab("UUID=AAAA-0001", "/boot/efi", "vfat", "umask=0077")],
            }), m("sda1.Block")),
            [`${U}.Partition`]: props(part(`${B}/sda`, 1, 1_048_576, 600_000_000)),
            [`${U}.Filesystem`]: props({ MountPoints: { t: "aay", v: [ay("/boot/efi").v] }, Size: { t: "t", v: 0 } }),
        },
        [`${B}/sda2`]: {
            [`${U}.Block`]: props(block("/dev/sda2", {
                size: 100 * GB, drive: `${D}/one`, usage: "filesystem", type: "xfs", label: "data", uuid: "uuid-sda2",
            }), m("sda2.Block")),
            [`${U}.Partition`]: props(part(`${B}/sda`, 2, 700_000_000, 100 * GB)),
            [`${U}.Filesystem`]: props({ MountPoints: { t: "aay", v: [] }, Size: { t: "t", v: 100 * GB } }),
        },
        [`${B}/sda3`]: {
            [`${U}.Block`]: props(block("/dev/sda3", {
                size: 399 * GB, drive: `${D}/one`, usage: "raid", type: "LVM2_member", version: "LVM2 001", uuid: "pv-uuid",
            }), m("sda3.Block")),
            [`${U}.Partition`]: props(part(`${B}/sda`, 3, 101 * GB, 399 * GB)),
            [`${U}.PhysicalVolume`]: props({ VolumeGroup: { t: "o", v: `${L}/vg0` }, Size: { t: "t", v: 399 * GB }, FreeSize: { t: "t", v: 315 * GB } }),
        },

        [`${B}/sdb`]: {
            [`${U}.Block`]: props(block("/dev/sdb", {
                size: 4000 * GB, drive: `${D}/two`, usage: "crypto", type: "crypto_LUKS", version: "2", uuid: "luks-b",
                config: [["crypttab", { name: ay("luks-b"), device: ay("UUID=luks-b"), options: ay("nofail") }]],
            }), m("sdb.Block")),
            [`${U}.Encrypted`]: props({ CleartextDevice: { t: "o", v: `${B}/dm_2d3` }, HintEncryptionType: "LUKS" }, m("sdb.Encrypted") ?? { Lock: null }),
        },
        [`${B}/dm_2d3`]: {
            [`${U}.Block`]: props(block("/dev/dm-3", {
                preferred: "/dev/mapper/luks-b", size: 4000 * GB - 16_000_000, usage: "filesystem", type: "xfs", label: "disk",
                uuid: "uuid-disk", backing: `${B}/sdb`, config: [fstab("UUID=uuid-disk", "/mnt/disk", "auto", "nofail")],
            }), m("dm_2d3.Block") ?? { UpdateConfigurationItem: null }),
            [`${U}.Filesystem`]: props({ MountPoints: { t: "aay", v: [ay("/mnt/disk").v] }, Size: { t: "t", v: 4000 * GB - 16_000_000 } }),
        },

        [`${B}/sdc`]: {
            [`${U}.Block`]: props(block("/dev/sdc", {
                size: 8000 * GB, drive: `${D}/three`, usage: "crypto", type: "crypto_LUKS", version: "2", uuid: "luks-c",
            }), m("sdc.Block")),
            [`${U}.Encrypted`]: props({ CleartextDevice: { t: "o", v: "/" }, HintEncryptionType: "LUKS" }, m("sdc.Encrypted")),
        },
        [`${B}/sdd`]: {
            [`${U}.Block`]: props(block("/dev/sdd", { size: 2000 * GB, drive: `${D}/four` }), m("sdd.Block")),
        },

        [`${L}/vg0`]: {
            [`${U}.VolumeGroup`]: props({ Name: "vg0", UUID: "vg-uuid", Size: { t: "t", v: 399 * GB }, FreeSize: { t: "t", v: 315 * GB } }),
        },
        [`${L}/vg0/root`]: {
            [`${U}.LogicalVolume`]: props({
                VolumeGroup: { t: "o", v: `${L}/vg0` }, Name: "root", Active: true, Size: { t: "t", v: 80 * GB }, Type: "block",
                BlockDevice: { t: "o", v: `${B}/dm_2d0` },
            }),
        },
        [`${L}/vg0/swap`]: {
            [`${U}.LogicalVolume`]: props({
                VolumeGroup: { t: "o", v: `${L}/vg0` }, Name: "swap", Active: true, Size: { t: "t", v: 4 * GB }, Type: "block",
                BlockDevice: { t: "o", v: `${B}/dm_2d1` },
            }),
        },
        [`${B}/dm_2d0`]: {
            [`${U}.Block`]: props(block("/dev/dm-0", {
                preferred: "/dev/vg0/root", size: 80 * GB, usage: "filesystem", type: "xfs", uuid: "uuid-root",
                config: [fstab("/dev/mapper/vg0-root", "/", "xfs", "defaults")],
            })),
            [`${U}.Block.LVM2`]: props({ LogicalVolume: { t: "o", v: `${L}/vg0/root` } }),
            [`${U}.Filesystem`]: props({ MountPoints: { t: "aay", v: [ay("/").v] }, Size: { t: "t", v: 80 * GB } }),
        },
        [`${B}/dm_2d1`]: {
            [`${U}.Block`]: props(block("/dev/dm-1", {
                preferred: "/dev/vg0/swap", size: 4 * GB, usage: "other", type: "swap", version: "1", uuid: "uuid-swap",
                config: [fstab("/dev/mapper/vg0-swap", "none", "swap", "defaults")],
            }), m("dm_2d1.Block") ?? { UpdateConfigurationItem: null }),
            [`${U}.Block.LVM2`]: props({ LogicalVolume: { t: "o", v: `${L}/vg0/swap` } }),
            [`${U}.Swapspace`]: props({ Active: true }, m("dm_2d1.Swapspace") ?? { Stop: null, Start: null }),
        },
    };
}

/** The tree as the page's model sees it after GetManagedObjects. */
export function objects(methods: Methods = {}): Objects {
    const managed: Record<string, Record<string, unknown>> = {};
    for (const [path, interfaces] of Object.entries(tree(methods))) {
        if (path === ROOT)
            continue;
        managed[path] = Object.fromEntries(Object.entries(interfaces).map(([iface, spec]) => [iface, spec.properties ?? {}]));
    }
    return parseManagedObjects(managed);
}

export function scenario(methods: Methods = {}, extra: Partial<MockScenario> = {}): MockScenario {
    return {
        dbus: { system: tree(methods) },
        metrics: {
            "mount.used": { instances: ["/", "/boot/efi", "/mnt/disk"], samples: [[20 * GB, 6_000_000, 3900 * GB]] },
            "mount.total": { instances: ["/", "/boot/efi", "/mnt/disk"], samples: [[80 * GB, 600_000_000, 4000 * GB]] },
        },
        spawn: { "systemctl daemon-reload": {} },
        // The bridge has a root bridge running, as after turning administrative access on.
        superuser: true,
        ...extra,
    } as MockScenario;
}
