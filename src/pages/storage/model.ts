/*
 * Storage: the pure half. UDisks2's objects as they arrive, the indices
 * upstream builds over them (pkg/storaged/client.js update_indices, cockpit
 * 356), and the device tree the page shows:
 *
 *   Samsung SSD 970 EVO Plus 1TB (S6S1…)   nvme0n1    Partitions (gpt)
 *   ├─nvme0n1p1                                       vfat filesystem      /boot/efi
 *   └─nvme0n1p3                                       LVM2 physical volume rhel
 *   ST14000NT001 (K3S05SM2)                sda        Encrypted (LUKS2)    unlocked
 *   └─luks-e3e11fe0…                                  xfs filesystem       /mnt/disk2
 *   rhel                                              LVM2 volume group
 *   ├─root                                            xfs filesystem       /
 *   └─swap                                            Swap                 active
 *
 * One row per device: a drive and its block device are one row, as are a
 * logical volume and its block device. What is on a device (a filesystem,
 * swap, an encrypted container, a partition table, a physical volume) is a
 * column of its row, not a row of its own.
 *
 * Byte strings ('ay': device names, mount points, fstab fields) arrive from
 * the bridge as base64 with a trailing NUL (utils.js decode_filename).
 */

import { unvariant, type Interfaces, type Objects, type Props } from "../../lib/objects.js";

export const UDISKS = "org.freedesktop.UDisks2";
export const ROOT = "/org/freedesktop/UDisks2";
export const MANAGER_PATH = `${ROOT}/Manager`;
const PREFIX = `${UDISKS}.`;

export const I = {
    manager: `${PREFIX}Manager`,
    managerLvm2: `${PREFIX}Manager.LVM2`,
    block: `${PREFIX}Block`,
    blockLvm2: `${PREFIX}Block.LVM2`,
    partition: `${PREFIX}Partition`,
    partitionTable: `${PREFIX}PartitionTable`,
    filesystem: `${PREFIX}Filesystem`,
    encrypted: `${PREFIX}Encrypted`,
    swap: `${PREFIX}Swapspace`,
    physicalVolume: `${PREFIX}PhysicalVolume`,
    drive: `${PREFIX}Drive`,
    driveAta: `${PREFIX}Drive.Ata`,
    volumeGroup: `${PREFIX}VolumeGroup`,
    logicalVolume: `${PREFIX}LogicalVolume`,
    mdraid: `${PREFIX}MDRaid`,
} as const;

export type { Interfaces, Objects, Props } from "../../lib/objects.js";

// ---- values ------------------------------------------------------------------

export { isVariant, parseManagedObjects, plainProps, unvariant } from "../../lib/objects.js";

/** An 'ay' file name as the bridge sends it (base64, NUL-terminated) -> text. */
export function decodeFilename(value: unknown): string {
    const encoded = unvariant(value);
    if (typeof encoded !== "string")
        return "";
    const text = Buffer.from(encoded, "base64").toString("utf8");
    const end = text.indexOf("\0");
    return end < 0 ? text : text.slice(0, end);
}

export function encodeFilename(text: string): string {
    return Buffer.from(`${text}\0`, "utf8").toString("base64");
}

function str(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** An object path property; "/" (UDisks2's "none") reads as null. */
function ref(value: unknown): string | null {
    return typeof value === "string" && value !== "/" && value !== "" ? value : null;
}

// ---- sizes -------------------------------------------------------------------

const UNITS = ["B", "kB", "MB", "GB", "TB", "PB", "EB"];

/** A size the way upstream's storage page writes it: decimal units, three significant digits. */
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
    // 999.6 would round to "1000": that is the next unit's 1.00.
    if (Number(value.toPrecision(3)) >= 1000 && unit < UNITS.length - 1) {
        value /= 1000;
        unit++;
    }
    return `${value.toPrecision(3)} ${UNITS[unit]}`;
}

/**
 * "5.8 / 14 TB": how much of a filesystem is used, both numbers in the
 * total's unit and to two digits, as upstream's storage overview writes it.
 */
export function formatUsage(used: number, total: number): string {
    if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0 || used < 0)
        return "?";
    let unit = 0;
    let scale = 1;
    while (total / scale >= 1000 && unit < UNITS.length - 1) {
        scale *= 1000;
        unit++;
    }
    const digits = (value: number) => (value >= 99.5 ? String(Math.round(value)) : value === 0 ? "0" : value.toPrecision(2));
    return `${digits(used / scale)} / ${digits(total / scale)} ${UNITS[unit]}`;
}

// ---- mount options -----------------------------------------------------------

export function parseOptions(options: string): string[] {
    return options.split(",").map(s => s.trim()).filter(s => s !== "");
}

/** Remove `option` from `split` in place; whether it was there. */
export function extractOption(split: string[], option: string): boolean {
    const at = split.indexOf(option);
    if (at < 0)
        return false;
    split.splice(at, 1);
    return true;
}

/** A configuration item as UDisks2 holds it: ["fstab", {dir: {t: "ay", v: base64}, ...}]. */
export type ConfigItem = readonly [string, Readonly<Record<string, unknown>>];

export interface FstabEntry {
    /** The item exactly as received: what Update/RemoveConfigurationItem must be given back. */
    readonly item: ConfigItem;
    readonly dir: string;
    readonly type: string;
    /** "defaults" when the field is absent, as util-linux reads it. */
    readonly options: string;
}

function configItems(block: Props | undefined, kind: string): ConfigItem[] {
    const list = block?.Configuration;
    if (!Array.isArray(list))
        return [];
    return list.filter((item): item is ConfigItem =>
        Array.isArray(item) && item[0] === kind && !!item[1] && typeof item[1] === "object");
}

export function fstabEntries(block: Props | undefined): FstabEntry[] {
    return configItems(block, "fstab").map(item => ({
        item,
        dir: decodeFilename(item[1].dir),
        type: decodeFilename(item[1].type),
        options: item[1].opts === undefined ? "defaults" : decodeFilename(item[1].opts) || "defaults",
    }));
}

/** The fstab line that mounts this block somewhere (not its swap line). */
export function mountEntry(block: Props | undefined): FstabEntry | null {
    return fstabEntries(block).find(entry => entry.type !== "swap" && entry.dir.startsWith("/")) ?? null;
}

export function swapEntry(block: Props | undefined): FstabEntry | null {
    return fstabEntries(block).find(entry => entry.type === "swap") ?? null;
}

/** When a filesystem is mounted at boot: upstream's four choices (mounting-dialog.jsx). */
export type AtBoot = "local" | "nofail" | "netdev" | "never";

export const AT_BOOT_LABELS: Readonly<Record<AtBoot, string>> = {
    local: "Before services start",
    nofail: "Without waiting, ignore failure",
    netdev: "After the network, ignore failure",
    never: "Do not mount at boot",
};

export interface MountSettings {
    readonly dir: string;
    readonly readOnly: boolean;
    readonly atBoot: AtBoot;
    /** Options this page does not manage, kept as they are. */
    readonly extra: string;
}

/** What an fstab line's options say, in the mount dialog's terms. */
export function mountSettings(entry: FstabEntry | null): MountSettings {
    if (!entry)
        return { dir: "", readOnly: false, atBoot: "nofail", extra: "" };
    const split = parseOptions(entry.options);
    extractOption(split, "noauto");
    extractOption(split, "defaults");
    const never = extractOption(split, "x-cockpit-never-auto");
    const readOnly = extractOption(split, "ro");
    const nofail = extractOption(split, "nofail");
    const netdev = extractOption(split, "_netdev");
    return {
        dir: entry.dir,
        readOnly,
        atBoot: never ? "never" : netdev ? "netdev" : nofail ? "nofail" : "local",
        extra: split.join(","),
    };
}

/** The options a mount writes to fstab, in upstream's order. */
export function mountOptions(settings: MountSettings): string {
    const options: string[] = [];
    if (settings.atBoot === "never")
        options.push("noauto");
    if (settings.readOnly)
        options.push("ro");
    if (settings.atBoot === "never")
        options.push("x-cockpit-never-auto");
    if (settings.atBoot === "nofail")
        options.push("nofail");
    if (settings.atBoot === "netdev")
        options.push("_netdev");
    options.push(...parseOptions(settings.extra));
    return options.join(",") || "defaults";
}

/** An fstab line's options with "noauto" set or cleared: what unmounting and stopping swap leave behind. */
export function withNoauto(options: string, noauto: boolean): string {
    const split = parseOptions(options);
    extractOption(split, "noauto");
    if (noauto) {
        extractOption(split, "defaults");
        split.unshift("noauto");
    }
    return split.join(",") || "defaults";
}

/** Why `dir` cannot be a mount point; null when it can. */
export function mountPointProblem(dir: string): string | null {
    if (dir === "")
        return "Mount point cannot be empty";
    if (!dir.startsWith("/"))
        return "Mount point must be an absolute path";
    if (/[\0\n]/.test(dir) || /\s/.test(dir))
        return "Mount point cannot contain whitespace";
    return null;
}

/** Who else has an fstab line for `dir`: the device names, for "already used for ...". */
export function mountPointUsers(objects: Objects, dir: string, self: string): string[] {
    const users: string[] = [];
    for (const [path, interfaces] of objects) {
        const block = interfaces[I.block];
        if (!block || path === self)
            continue;
        if (fstabEntries(block).some(entry => entry.dir === dir))
            users.push(blockName(block));
    }
    return users;
}

// ---- names -------------------------------------------------------------------

/** /dev/mapper/rhel-root rather than /dev/dm-0 (utils.js block_name). */
export function blockName(block: Props | undefined): string {
    return decodeFilename(block?.PreferredDevice) || decodeFilename(block?.Device);
}

export function shortName(block: Props | undefined): string {
    return blockName(block).replace(/^\/dev\/(mapper\/)?/, "");
}

/** "Vendor Model (Serial)" (utils.js drive_name). */
export function driveName(drive: Props): string {
    let name = [str(drive.Vendor), str(drive.Model)].filter(Boolean).join(" ");
    const tag = str(drive.Serial) || str(drive.WWN);
    if (tag)
        name += name ? ` (${tag})` : tag;
    return name || "Drive";
}

const FILESYSTEM_NAMES: Readonly<Record<string, string>> = {
    crypto_LUKS: "Encrypted",
    LVM2_member: "LVM2 physical volume",
    linux_raid_member: "MDRAID member",
    swap: "Swap",
};

// ---- the tree ----------------------------------------------------------------

export type RowKind = "drive" | "partition" | "cleartext" | "vgroup" | "lvol" | "block";

export type ContentKind =
    | "filesystem" | "swap" | "encrypted" | "ptable" | "pvol" | "vgroup" | "inactive" | "raid-member"
    | "other" | "empty" | "none";

export interface Row {
    /** The object's path: a drive, a block device, a volume group or a logical volume. */
    readonly id: string;
    readonly kind: RowKind;
    readonly depth: number;
    /** For each level above this row's own, whether that ancestor was a last child (tree drawing). */
    readonly lasts: readonly boolean[];
    /** Raw host text: clean before showing. */
    readonly name: string;
    /** /dev/..., or "" for a row with no block device (a volume group, an inactive volume, a drive without media). */
    readonly device: string;
    /** The block device's object path, when there is one. */
    readonly block: string | null;
    readonly content: ContentKind;
    /** "xfs filesystem", "Encrypted (LUKS2)", "Partitions (gpt)". */
    readonly contentText: string;
    /** Mount points, "not mounted", "locked", the volume group's name. */
    readonly location: string;
    /** Something is off or inactive: shown dim. */
    readonly idle: boolean;
    readonly size: number;
    readonly mountPoints: readonly string[];
    readonly readOnly: boolean;
}

interface Indices {
    readonly objects: Objects;
    /** Partition block paths by partition table block path, in offset order. */
    readonly partitions: Map<string, string[]>;
    /** Cleartext block path by encrypted block path. */
    readonly cleartext: Map<string, string>;
    /** Block path by logical volume path. */
    readonly lvolBlock: Map<string, string>;
    /** Logical volume paths by volume group path, by name. */
    readonly vgroupLvols: Map<string, string[]>;
    /** The block device of each drive (multipath: the first seen). */
    readonly driveBlock: Map<string, string>;
}

function buildIndices(objects: Objects): Indices {
    const partitions = new Map<string, string[]>();
    const cleartext = new Map<string, string>();
    const lvolBlock = new Map<string, string>();
    const vgroupLvols = new Map<string, string[]>();
    const driveBlock = new Map<string, string>();

    const blockPaths = [...objects.keys()].filter(path => objects.get(path)![I.block]).sort(comparePaths(objects));
    for (const path of blockPaths) {
        const interfaces = objects.get(path)!;
        const block = interfaces[I.block]!;
        const part = interfaces[I.partition];
        const table = ref(part?.Table);
        if (part && table) {
            const list = partitions.get(table) ?? [];
            list.push(path);
            partitions.set(table, list);
        }
        const backing = ref(block.CryptoBackingDevice);
        if (backing)
            cleartext.set(backing, path);
        const lvol = ref(interfaces[I.blockLvm2]?.LogicalVolume);
        if (lvol)
            lvolBlock.set(lvol, path);
        // A drive's own block device: not a partition, and not an eMMC boot
        // area, which also point at the drive (client.js is_toplevel_drive).
        const drive = ref(block.Drive);
        if (drive && !part && !/\/dev\/mmcblk[0-9]boot[0-9]$/.test(decodeFilename(block.Device)) && !driveBlock.has(drive))
            driveBlock.set(drive, path);
    }
    for (const list of partitions.values())
        list.sort((a, b) => num(objects.get(a)![I.partition]!.Offset) - num(objects.get(b)![I.partition]!.Offset));

    for (const [path, interfaces] of objects) {
        const lvol = interfaces[I.logicalVolume];
        const vgroup = ref(lvol?.VolumeGroup);
        if (!lvol || !vgroup)
            continue;
        const list = vgroupLvols.get(vgroup) ?? [];
        list.push(path);
        vgroupLvols.set(vgroup, list);
    }
    for (const list of vgroupLvols.values())
        list.sort((a, b) => str(objects.get(a)![I.logicalVolume]!.Name).localeCompare(str(objects.get(b)![I.logicalVolume]!.Name)));

    return { objects, partitions, cleartext, lvolBlock, vgroupLvols, driveBlock };
}

/** Device names in natural order: sda2 before sda10. */
function comparePaths(objects: Objects) {
    const collator = new Intl.Collator("en", { numeric: true });
    return (a: string, b: string) =>
        collator.compare(decodeFilename(objects.get(a)?.[I.block]?.Device) || a, decodeFilename(objects.get(b)?.[I.block]?.Device) || b);
}

interface Content {
    readonly content: ContentKind;
    readonly contentText: string;
    readonly location: string;
    readonly idle: boolean;
    readonly mountPoints: string[];
}

export function mountPointsOf(filesystem: Props | undefined): string[] {
    const list = filesystem?.MountPoints;
    return Array.isArray(list) ? list.map(decodeFilename).filter(Boolean) : [];
}

/** What is on a block device. */
function describeContent(index: Indices, path: string): Content {
    const interfaces = index.objects.get(path) ?? {};
    const block = interfaces[I.block] ?? {};
    const type = str(block.IdType);
    const usage = str(block.IdUsage);
    const base = { idle: false, mountPoints: [] as string[], location: "" };

    if (interfaces[I.partitionTable]) {
        const tableType = str(interfaces[I.partitionTable]!.Type);
        return { ...base, content: "ptable", contentText: tableType ? `Partitions (${tableType})` : "Partitions" };
    }
    if (interfaces[I.encrypted] || usage === "crypto") {
        const version = str(block.IdVersion);
        const luks = type === "crypto_LUKS" ? `LUKS${version}` : type;
        const unlocked = index.cleartext.has(path);
        return {
            ...base, content: "encrypted", contentText: luks ? `Encrypted (${luks})` : "Encrypted",
            location: unlocked ? "unlocked" : "locked", idle: !unlocked,
        };
    }
    if (interfaces[I.physicalVolume] || type === "LVM2_member") {
        const vgroup = ref(interfaces[I.physicalVolume]?.VolumeGroup);
        const name = vgroup ? str(index.objects.get(vgroup)?.[I.volumeGroup]?.Name) : "";
        return { ...base, content: "pvol", contentText: "LVM2 physical volume", location: name };
    }
    if (interfaces[I.swap] || type === "swap") {
        const active = interfaces[I.swap]?.Active === true;
        return { ...base, content: "swap", contentText: "Swap", location: active ? "active" : "inactive", idle: !active };
    }
    if (interfaces[I.filesystem] || usage === "filesystem") {
        const mountPoints = mountPointsOf(interfaces[I.filesystem]);
        const configured = mountEntry(block)?.dir ?? "";
        return {
            ...base, content: "filesystem", contentText: `${type || "unknown"} filesystem`, mountPoints,
            location: mountPoints.length ? mountPoints.join(", ") : configured ? `${configured} (not mounted)` : "not mounted",
            idle: mountPoints.length === 0,
        };
    }
    if (ref(block.MDRaidMember) || type === "linux_raid_member")
        return { ...base, content: "raid-member", contentText: "MDRAID member" };
    if (usage || type)
        return { ...base, content: "other", contentText: FILESYSTEM_NAMES[type] ?? (type || usage) };
    return { ...base, content: "empty", contentText: "Unformatted", idle: true };
}

/** The device tree, flattened in display order. */
export function buildRows(objects: Objects): Row[] {
    const index = buildIndices(objects);
    const rows: Row[] = [];
    const seen = new Set<string>();

    const blockRow = (path: string, kind: RowKind, name: string, lasts: readonly boolean[], id = path): void => {
        const interfaces = objects.get(path);
        const block = interfaces?.[I.block];
        if (!block)
            return;
        seen.add(path);
        const content = describeContent(index, path);
        rows.push({
            id, kind, depth: lasts.length, lasts, name, block: path, device: blockName(block),
            size: num(block.Size), readOnly: block.ReadOnly === true, ...content,
        });
        children(path, lasts);
    };

    /** The devices inside a block device: its partitions, or its cleartext device. */
    const children = (path: string, lasts: readonly boolean[]): void => {
        const below = [
            // An extended partition's logical partitions are in the same table: flat, as lsblk lists them.
            ...(index.partitions.get(path) ?? []).map(child => ({ path: child, kind: "partition" as const })),
            ...(index.cleartext.has(path) ? [{ path: index.cleartext.get(path)!, kind: "cleartext" as const }] : []),
        ];
        below.forEach((child, i) => {
            const block = objects.get(child.path)?.[I.block];
            blockRow(child.path, child.kind, shortName(block), [...lasts, i === below.length - 1]);
        });
    };

    // Drives, in UDisks2's own order (fixed before removable, then by name).
    const drives = [...objects].filter(([, interfaces]) => interfaces[I.drive])
            .sort(([, a], [, b]) => str(a[I.drive]!.SortKey).localeCompare(str(b[I.drive]!.SortKey)));
    for (const [path, interfaces] of drives) {
        const drive = interfaces[I.drive]!;
        const blockPath = index.driveBlock.get(path);
        if (blockPath) {
            blockRow(blockPath, "drive", driveName(drive), [], path);
        } else {
            // No block device: an empty card reader or optical drive.
            rows.push({
                id: path, kind: "drive", depth: 0, lasts: [], name: driveName(drive), block: null, device: "",
                content: "none", contentText: "No media", location: "", idle: true, size: num(drive.Size),
                mountPoints: [], readOnly: false,
            });
        }
    }

    // Volume groups and their logical volumes.
    const vgroups = [...objects].filter(([, interfaces]) => interfaces[I.volumeGroup])
            .sort(([, a], [, b]) => str(a[I.volumeGroup]!.Name).localeCompare(str(b[I.volumeGroup]!.Name)));
    for (const [path, interfaces] of vgroups) {
        const vgroup = interfaces[I.volumeGroup]!;
        const free = num(vgroup.FreeSize);
        rows.push({
            id: path, kind: "vgroup", depth: 0, lasts: [], name: str(vgroup.Name), block: null, device: "",
            content: "vgroup", contentText: "LVM2 volume group", location: `${formatSize(free)} free`, idle: false,
            size: num(vgroup.Size), mountPoints: [], readOnly: false,
        });
        const lvols = index.vgroupLvols.get(path) ?? [];
        lvols.forEach((lvolPath, i) => {
            const lvol = objects.get(lvolPath)![I.logicalVolume]!;
            const lasts = [i === lvols.length - 1];
            const blockPath = index.lvolBlock.get(lvolPath) ?? ref(lvol.BlockDevice);
            if (blockPath && objects.get(blockPath)?.[I.block]) {
                blockRow(blockPath, "lvol", str(lvol.Name), lasts, lvolPath);
            } else {
                const pool = str(lvol.Type) === "pool";
                rows.push({
                    id: lvolPath, kind: "lvol", depth: 1, lasts, name: str(lvol.Name), block: null, device: "",
                    content: pool ? "other" : "inactive",
                    contentText: pool ? "Pool for thin logical volumes" : "Inactive logical volume",
                    location: "", idle: !pool, size: num(lvol.Size), mountPoints: [], readOnly: false,
                });
            }
        });
    }

    // Whatever is left and worth showing: MD RAID devices, loop devices with
    // a backing file, device-mapper devices nothing above accounts for.
    const others = [...objects.keys()].filter(path => {
        const block = objects.get(path)![I.block];
        return block && !seen.has(path) && num(block.Size) > 0 && !ref(block.CryptoBackingDevice) &&
            !objects.get(path)![I.partition];
    }).sort(comparePaths(objects));
    for (const path of others) {
        if (!seen.has(path))
            blockRow(path, "block", shortName(objects.get(path)![I.block]), []);
    }

    return rows;
}

// ---- what a row can do ---------------------------------------------------------

export type ActionId = "mount" | "unmount" | "unlock" | "lock" | "swapon" | "swapoff" | "format";

export interface ActionInfo {
    readonly id: ActionId;
    readonly key: string;
    /** Footer and help: "mount". */
    readonly label: string;
    /** Why it cannot be done now, when it applies to this row but must wait. Raw host text. */
    readonly blocked: string | null;
}

export const ACTION_KEYS: Readonly<Record<ActionId, string>> = {
    mount: "m", unmount: "u", unlock: "o", lock: "l", swapon: "s", swapoff: "x", format: "f",
};

const ACTION_LABELS: Readonly<Record<ActionId, string>> = {
    mount: "mount", unmount: "unmount", unlock: "unlock", lock: "lock", swapon: "start swap", swapoff: "stop swap", format: "format",
};

/** Mount points nothing here will unmount: the system does not survive it. */
const SYSTEM_MOUNTS = new Set(["/", "/usr", "/boot", "/boot/efi", "/var", "/etc"]);

/**
 * What keeps a block device busy, itself or anything inside it: mounted
 * filesystems, active swap, an unlocked container, membership of a volume
 * group. Upstream tears these down for the user (utils.js get_active_usage);
 * here each is named and left to the user to undo first.
 */
export function activeUsage(objects: Objects, path: string): string[] {
    const index = buildIndices(objects);
    const usage: string[] = [];
    const visit = (at: string): void => {
        const interfaces = objects.get(at);
        const block = interfaces?.[I.block];
        if (!interfaces || !block)
            return;
        const name = blockName(block);
        for (const dir of mountPointsOf(interfaces[I.filesystem]))
            usage.push(`${name} is mounted at ${dir}`);
        if (interfaces[I.swap]?.Active === true)
            usage.push(`${name} is active swap`);
        const vgroup = ref(interfaces[I.physicalVolume]?.VolumeGroup);
        if (vgroup)
            usage.push(`${name} is a physical volume of ${str(objects.get(vgroup)?.[I.volumeGroup]?.Name) || "a volume group"}`);
        if (ref(block.MDRaidMember))
            usage.push(`${name} is a member of an MDRAID device`);
        const clear = index.cleartext.get(at);
        if (clear) {
            usage.push(`${name} is unlocked`);
            visit(clear);
        }
        for (const part of index.partitions.get(at) ?? [])
            visit(part);
    };
    visit(path);
    return usage;
}

/** The actions that apply to a row, in footer order. */
export function rowActions(objects: Objects, row: Row): ActionInfo[] {
    const actions: ActionInfo[] = [];
    const add = (id: ActionId, blocked: string | null = null) =>
        actions.push({ id, key: ACTION_KEYS[id], label: ACTION_LABELS[id], blocked });
    if (!row.block)
        return actions;
    const interfaces = objects.get(row.block) ?? {};
    const index = buildIndices(objects);

    switch (row.content) {
    case "filesystem":
        if (!interfaces[I.filesystem])
            break;
        if (row.mountPoints.length) {
            const system = row.mountPoints.find(dir => SYSTEM_MOUNTS.has(dir));
            add("unmount", system ? `${system} is needed by the running system` : null);
        } else {
            add("mount");
        }
        break;
    case "swap":
        if (!interfaces[I.swap])
            break;
        add(interfaces[I.swap]!.Active === true ? "swapoff" : "swapon");
        break;
    case "encrypted": {
        if (!interfaces[I.encrypted])
            break;
        const clear = index.cleartext.get(row.block);
        if (clear) {
            const usage = activeUsage(objects, clear);
            add("lock", usage[0] ?? null);
        } else {
            add("unlock");
        }
        break;
    }
    default:
        break;
    }

    // Formatting: any block device that is not just a view of another one's
    // contents being used.
    const usage = activeUsage(objects, row.block);
    add("format", row.readOnly ? `${row.device} is read-only` : usage[0] ?? null);
    return actions;
}

/** What formatting destroys beyond the device's own contents: its partitions. */
export function partitionCount(objects: Objects, path: string): number {
    const partitions = objects.get(path)?.[I.partitionTable]?.Partitions;
    return Array.isArray(partitions) ? partitions.length : 0;
}

// ---- formatting --------------------------------------------------------------

export interface FormatType {
    readonly value: string;
    readonly label: string;
}

/** The types offered, in upstream's order (format-dialog.jsx), when UDisks2 supports them. */
const FORMAT_TYPES: readonly FormatType[] = [
    { value: "xfs", label: "XFS" },
    { value: "ext4", label: "ext4" },
    { value: "btrfs", label: "Btrfs" },
    { value: "vfat", label: "VFAT" },
    { value: "exfat", label: "exFAT" },
    { value: "ntfs", label: "NTFS" },
    { value: "swap", label: "Swap" },
];

export const FORMAT_EMPTY: FormatType = { value: "empty", label: "No filesystem (wipe only)" };

/** Candidates from the manager's SupportedFilesystems; each still has to pass CanFormat. */
export function formatCandidates(objects: Objects): FormatType[] {
    const supported = objects.get(MANAGER_PATH)?.[I.manager]?.SupportedFilesystems;
    const names = new Set(Array.isArray(supported) ? supported.filter((s): s is string => typeof s === "string") : []);
    return FORMAT_TYPES.filter(type => names.has(type.value));
}

/** Why `label` cannot be this type's label (utils.js validate_fsys_label); null when it can. */
export function labelProblem(label: string, type: string): string | null {
    const limits: Readonly<Record<string, number>> = { xfs: 12, ext4: 16, vfat: 11, exfat: 15, ntfs: 128, btrfs: 256, swap: 15 };
    const limit = limits[type];
    if (limit !== undefined && Buffer.byteLength(label, "utf8") > limit)
        return `Name cannot be longer than ${limit} ${type === "vfat" ? "characters" : "bytes"}`;
    if (type === "empty" && label)
        return "A device without a filesystem has no name";
    return null;
}

// ---- details -----------------------------------------------------------------

export interface DetailField {
    readonly label: string;
    /** Raw host text. */
    readonly value: string;
    readonly tone?: "ok" | "warning" | "error";
}

export interface Usage {
    readonly used: number;
    readonly total: number;
}

function smartFields(ata: Props): DetailField[] {
    if (ata.SmartSupported !== true)
        return [];
    if (ata.SmartEnabled !== true)
        return [{ label: "Assessment", value: "SMART is not enabled" }];
    const fields: DetailField[] = [];
    const failing = ata.SmartFailing === true;
    fields.push({ label: "Assessment", value: failing ? "Disk is failing" : "Disk is OK", tone: failing ? "error" : "ok" });
    const kelvin = num(ata.SmartTemperature);
    if (kelvin > 0)
        fields.push({ label: "Temperature", value: `${(kelvin - 273.15).toFixed(1)} °C` });
    const seconds = num(ata.SmartPowerOnSeconds);
    if (seconds > 0)
        fields.push({ label: "Power on hours", value: `${Math.round(seconds / 3600)}` });
    const bad = num(ata.SmartNumBadSectors);
    if (bad > 0)
        fields.push({ label: "Bad sectors", value: `${bad}`, tone: "warning" });
    const failed = num(ata.SmartNumAttributesFailing);
    if (failed > 0)
        fields.push({ label: "Failing attributes", value: `${failed}`, tone: "error" });
    return fields;
}

/** Everything known about a row, as labelled lines grouped under headings. */
export function detailSections(objects: Objects, row: Row, usage: Usage | null): { title: string, fields: DetailField[] }[] {
    const sections: { title: string, fields: DetailField[] }[] = [];
    const own = objects.get(row.id) ?? {};

    if (own[I.drive]) {
        const drive = own[I.drive]!;
        const fields: DetailField[] = [];
        const push = (label: string, value: string) => { if (value) fields.push({ label, value }) };
        push("Vendor", str(drive.Vendor));
        push("Model", str(drive.Model));
        push("Firmware version", str(drive.Revision));
        push("Serial number", str(drive.Serial));
        push("World wide name", str(drive.WWN));
        push("Capacity", num(drive.Size) ? formatSize(num(drive.Size)) : "");
        const rate = num(drive.RotationRate);
        push("Type", rate > 0 ? `Hard disk, ${rate} rpm` : rate === 0 && drive.RotationRate !== undefined ? "Solid-state" : "");
        if (drive.Removable === true)
            push("Removable", "yes");
        fields.push(...smartFields(own[I.driveAta] ?? {}));
        sections.push({ title: "Drive", fields });
    }

    if (own[I.volumeGroup]) {
        const vgroup = own[I.volumeGroup]!;
        const index = buildIndices(objects);
        const pvols = [...objects].filter(([, interfaces]) => ref(interfaces[I.physicalVolume]?.VolumeGroup) === row.id)
                .map(([path]) => blockName(objects.get(path)![I.block]));
        sections.push({
            title: "LVM2 volume group",
            fields: [
                { label: "Name", value: str(vgroup.Name) },
                { label: "UUID", value: str(vgroup.UUID) },
                { label: "Capacity", value: formatSize(num(vgroup.Size)) },
                { label: "Free", value: formatSize(num(vgroup.FreeSize)) },
                { label: "Physical volumes", value: pvols.join(", ") || "none" },
                { label: "Logical volumes", value: `${(index.vgroupLvols.get(row.id) ?? []).length}` },
            ],
        });
    }

    if (own[I.logicalVolume]) {
        const lvol = own[I.logicalVolume]!;
        const vgroup = ref(lvol.VolumeGroup);
        sections.push({
            title: "LVM2 logical volume",
            fields: [
                { label: "Name", value: str(lvol.Name) },
                { label: "Volume group", value: vgroup ? str(objects.get(vgroup)?.[I.volumeGroup]?.Name) : "" },
                { label: "Size", value: formatSize(num(lvol.Size)) },
                { label: "State", value: lvol.Active === true ? "active" : "inactive" },
                ...(str(lvol.Type) && str(lvol.Type) !== "block" ? [{ label: "Type", value: str(lvol.Type) }] : []),
            ],
        });
    }

    const interfaces = row.block ? objects.get(row.block) ?? {} : {};
    const block = interfaces[I.block];
    if (block) {
        const part = interfaces[I.partition];
        const fields: DetailField[] = [
            { label: "Device", value: blockName(block) },
            { label: "Size", value: `${formatSize(num(block.Size))} (${num(block.Size)} bytes)` },
        ];
        if (block.ReadOnly === true)
            fields.push({ label: "Read-only", value: "yes", tone: "warning" });
        if (part) {
            fields.push({ label: "Partition", value: `${num(part.Number)}` });
            if (str(part.Name))
                fields.push({ label: "Partition name", value: str(part.Name) });
            fields.push({ label: "Partition type", value: str(part.Type) });
            fields.push({ label: "Partition UUID", value: str(part.UUID) });
        }
        sections.push({ title: "Device", fields });

        const content: DetailField[] = [{ label: "Content", value: row.contentText }];
        if (str(block.IdLabel))
            content.push({ label: "Name", value: str(block.IdLabel) });
        if (str(block.IdUUID))
            content.push({ label: "UUID", value: str(block.IdUUID) });
        switch (row.content) {
        case "filesystem": {
            const entry = mountEntry(block);
            content.push({
                label: "Mounted at",
                value: row.mountPoints.join(", ") || "not mounted",
                ...(row.mountPoints.length ? {} : { tone: "warning" as const }),
            });
            if (usage && usage.total > 0) {
                content.push({
                    label: "Used",
                    value: `${formatSize(usage.used)} of ${formatSize(usage.total)} (${Math.round(usage.used / usage.total * 100)}%)`,
                });
            }
            content.push({ label: "Mount point", value: entry ? entry.dir : "not configured" });
            if (entry) {
                content.push({ label: "Mount options", value: entry.options });
                content.push({ label: "At boot", value: AT_BOOT_LABELS[mountSettings(entry).atBoot] });
            }
            break;
        }
        case "swap": {
            const entry = swapEntry(block);
            content.push({ label: "State", value: row.location });
            content.push({ label: "At boot", value: !entry ? "not configured" : parseOptions(entry.options).includes("noauto") ? "not started" : "started" });
            break;
        }
        case "encrypted": {
            content.push({ label: "State", value: row.location, ...(row.idle ? { tone: "warning" as const } : {}) });
            const crypttab = configItems(block, "crypttab")[0];
            if (crypttab) {
                content.push({ label: "Stored name", value: decodeFilename(crypttab[1].name) });
                content.push({ label: "Options", value: decodeFilename(crypttab[1].options) || "none" });
            }
            break;
        }
        case "pvol": {
            const pvol = interfaces[I.physicalVolume];
            content.push({ label: "Volume group", value: row.location || "none" });
            if (pvol)
                content.push({ label: "Free", value: formatSize(num(pvol.FreeSize)) });
            break;
        }
        case "ptable":
            content.push({ label: "Partitions", value: `${partitionCount(objects, row.block!)}` });
            break;
        default:
            break;
        }
        sections.push({ title: "Content", fields: content });
    }

    return sections.filter(section => section.fields.length > 0);
}
