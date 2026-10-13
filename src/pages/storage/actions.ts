/*
 * Storage actions: mount and unmount, unlock and lock, swap on and off, and
 * formatting -- upstream's calls (pkg/storaged, cockpit 356):
 *
 *   mount     filesystem/mounting-dialog.jsx, client.js mount_at
 *   unmount   the same dialog in "unmount" mode, client.js unmount_at
 *   unlock    crypto/actions.jsx unlock, Encrypted.Unlock
 *   lock      crypto/actions.jsx lock, Encrypted.Lock
 *   swap      swap/swap.jsx, Swapspace.Start / Stop
 *   format    block/format-dialog.jsx, Block.Format
 *
 * As upstream, a mount is a line in fstab: mounting writes (or updates) the
 * line through UDisks2 and then mounts by it; unmounting leaves the line but
 * marks it "noauto", so the filesystem stays unmounted across a reboot.
 * systemd is reloaded before and after, so that it neither acts on a stale
 * fstab nor misses the new one.
 *
 * Where this knowingly does less than upstream:
 *
 *  - Nothing is torn down on the user's behalf. Upstream unmounts, stops and
 *    locks whatever is in the way of a lock or a format; here the action is
 *    refused and says what to undo first (model.ts activeUsage).
 *  - crypttab is left alone: unlocking and locking do not change whether the
 *    device is unlocked at boot, and mounting a filesystem inside an
 *    encrypted device does not rewrite the container's options. For that
 *    reason such a filesystem is only offered the boot choices that cannot
 *    hold up a boot ("ignore failure", or not at all).
 *  - Starting swap does not add an fstab line; an existing one has its
 *    "noauto" kept in step, as upstream does.
 *  - A passphrase is always asked for; a key file named in crypttab is not
 *    tried first.
 *
 * Each action runs on a client of its own at the current privilege level,
 * closed when it is over (hooks.ts callOnce), so it is not cut short by the
 * user leaving the page. Every call carries its signature: nothing depends
 * on introspection.
 */
import cockpit from "../../cockpit.js";
import { run } from "../../tui/hooks.js";
import {
    blockName, decodeFilename, encodeFilename, I, MANAGER_PATH, mountEntry, mountOptions, mountPointsOf, swapEntry, UDISKS, withNoauto,
    type ConfigItem, type FstabEntry, type Interfaces, type MountSettings,
} from "./model.js";
import { CLIENT_OPTIONS } from "./store.js";

const CONFIG_ITEM = "(sa{sv})";

/** Formatting (with or without overwriting) and unlocking can outlast D-Bus's default 25 seconds. */
const LONG_TIMEOUT_MS = 24 * 3600 * 1000;

/** One D-Bus call on its own client, as a native promise. */
async function call(path: string, iface: string, method: string, args: unknown[], type: string, timeout?: number): Promise<unknown[]> {
    const client = cockpit.dbus(UDISKS, { ...CLIENT_OPTIONS });
    try {
        return await Promise.resolve(client.call(path, iface, method, args, { type, ...(timeout ? { timeout } : {}) }));
    } finally {
        client.close();
    }
}

/** utils.js reload_systemd. */
function reloadSystemd(): Promise<string> {
    return run(["systemctl", "daemon-reload"], { superuser: "require" });
}

function fstabItem(old: FstabEntry | null, dir: string, options: string): ConfigItem {
    const fields: Record<string, unknown> = {
        dir: { t: "ay", v: encodeFilename(dir) },
        type: { t: "ay", v: encodeFilename("auto") },
        opts: { t: "ay", v: encodeFilename(options) },
        freq: { t: "i", v: 0 },
        passno: { t: "i", v: 0 },
        // UDisks2 writes the device itself (by UUID) for a new line...
        "track-parents": { t: "b", v: !old },
    };
    // ...and an existing line keeps the name it has.
    if (old?.item[1].fsname !== undefined)
        fields.fsname = old.item[1].fsname;
    return ["fstab", fields];
}

/** An existing line with other options: every other field as it is. */
function withOptions(entry: FstabEntry, options: string): ConfigItem {
    return ["fstab", { ...entry.item[1], opts: { t: "ay", v: encodeFilename(options) } }];
}

export interface BlockTarget {
    /** The block device's object path. */
    readonly path: string;
    /** Its interfaces, as the store had them when the action was asked for. */
    readonly interfaces: Interfaces;
}

function deviceOf(target: BlockTarget): string {
    return blockName(target.interfaces[I.block]);
}

/**
 * Mount a filesystem at `settings.dir`: write its fstab line, then mount by
 * it. If the mount fails the line is put back as it was.
 */
export async function mount(target: BlockTarget, settings: MountSettings): Promise<string> {
    const block = target.interfaces[I.block];
    const old = mountEntry(block);
    const options = mountOptions(settings);
    const item = fstabItem(old, settings.dir, options);

    await reloadSystemd();
    if (old)
        await call(target.path, I.block, "UpdateConfigurationItem", [old.item, item, {}], `${CONFIG_ITEM}${CONFIG_ITEM}a{sv}`);
    else
        await call(target.path, I.block, "AddConfigurationItem", [item, {}], `${CONFIG_ITEM}a{sv}`);
    try {
        // The kernel's name (/dev/dm-3), as upstream: the preferred one may be a symlink not made yet.
        const device = decodeFilename(block?.Device);
        await run(["sh", "-ec", 'mkdir -p "$2"; mount "$1" "$2" -o "$3"', "--", device, settings.dir, options],
                  { superuser: "require" });
    } catch (error) {
        try {
            if (old)
                await call(target.path, I.block, "UpdateConfigurationItem", [item, old.item, {}], `${CONFIG_ITEM}${CONFIG_ITEM}a{sv}`);
            else
                await call(target.path, I.block, "RemoveConfigurationItem", [item, {}], `${CONFIG_ITEM}a{sv}`);
        } catch (undo) {
            console.warn("storage: putting the fstab line back failed:", undo);
        }
        throw error;
    }
    await reloadSystemd();
    return `Mounted ${deviceOf(target)} at ${settings.dir}`;
}

/** Unmount a filesystem everywhere it is mounted, and keep it unmounted at boot. */
export async function unmount(target: BlockTarget): Promise<string> {
    const block = target.interfaces[I.block];
    const mountPoints = mountPointsOf(target.interfaces[I.filesystem]);
    const entry = mountEntry(block);

    await reloadSystemd();
    // The last one mounted first: it may sit on top of an earlier one.
    for (const dir of [...mountPoints].reverse())
        await run(["umount", dir], { superuser: "require" });
    if (entry) {
        const options = withNoauto(entry.options, true);
        if (options !== entry.options) {
            await call(target.path, I.block, "UpdateConfigurationItem", [entry.item, withOptions(entry, options), {}],
                       `${CONFIG_ITEM}${CONFIG_ITEM}a{sv}`);
        }
    }
    await reloadSystemd();
    return `Unmounted ${deviceOf(target)}`;
}

export async function unlock(target: BlockTarget, passphrase: string): Promise<string> {
    await call(target.path, I.encrypted, "Unlock", [passphrase, {}], "sa{sv}", LONG_TIMEOUT_MS);
    return `Unlocked ${deviceOf(target)}`;
}

export async function lock(target: BlockTarget): Promise<string> {
    await call(target.path, I.encrypted, "Lock", [{}], "a{sv}");
    return `Locked ${deviceOf(target)}`;
}

/** Start or stop swapping on a device; an fstab line for it follows suit. */
export async function setSwap(target: BlockTarget, active: boolean): Promise<string> {
    await call(target.path, I.swap, active ? "Start" : "Stop", [{}], "a{sv}");
    const entry = swapEntry(target.interfaces[I.block]);
    if (entry) {
        const options = withNoauto(entry.options, !active);
        if (options !== entry.options) {
            await call(target.path, I.block, "UpdateConfigurationItem", [entry.item, withOptions(entry, options), {}],
                       `${CONFIG_ITEM}${CONFIG_ITEM}a{sv}`);
        }
    }
    return `${active ? "Started" : "Stopped"} swap on ${deviceOf(target)}`;
}

export interface FormatSettings {
    /** A filesystem type, "swap", or "empty" to only wipe. */
    readonly type: string;
    readonly label: string;
    /** Overwrite the whole device with zeros first. */
    readonly erase: boolean;
}

/**
 * Format a block device. "tear-down" has UDisks2 remove the fstab and
 * crypttab lines of what was on it, as upstream asks for.
 */
export async function format(target: BlockTarget, settings: FormatSettings): Promise<string> {
    const options: Record<string, unknown> = { "tear-down": { t: "b", v: true } };
    if (settings.label && settings.type !== "empty")
        options.label = { t: "s", v: settings.label };
    if (settings.erase)
        options.erase = { t: "s", v: "zero" };

    await reloadSystemd();
    await call(target.path, I.block, "Format", [settings.type, options], "sa{sv}", LONG_TIMEOUT_MS);
    await reloadSystemd();
    return settings.type === "empty" ? `Wiped ${deviceOf(target)}` : `Formatted ${deviceOf(target)} as ${settings.type}`;
}

/** Which of `types` this host can actually make (Manager.CanFormat: the mkfs tool is installed). */
export async function usableFormats(types: readonly string[]): Promise<Set<string>> {
    const client = cockpit.dbus(UDISKS, { ...CLIENT_OPTIONS });
    try {
        const usable = new Set<string>();
        await Promise.all(types.map(async type => {
            try {
                const [reply] = await Promise.resolve(client.call(MANAGER_PATH, I.manager, "CanFormat", [type], { type: "s" }));
                if (Array.isArray(reply) && reply[0] === true)
                    usable.add(type);
            } catch {
                /* cannot tell: not offered */
            }
        }));
        return usable;
    } finally {
        client.close();
    }
}
