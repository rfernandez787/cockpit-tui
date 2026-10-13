/*
 * Networking actions: switching an interface on and off, "connect
 * automatically", and the firewall -- upstream's calls (pkg/networkmanager,
 * cockpit 356):
 *
 *   switch on     network-interface.jsx connect(): Manager.ActivateConnection
 *   switch off    disconnect(): Device.Disconnect
 *   autoconnect   settings_applier: Settings.Connection.Update
 *   firewall      firewall-client.js enable()/disable(): the unit enabled and
 *                 started, or disabled and stopped
 *
 * Switching an interface can cut off the very connection this runs over. As
 * upstream (interfaces.js with_checkpoint), the two switches are made under
 * a NetworkManager checkpoint: NetworkManager is asked to remember the
 * device as it is and to put it back by itself after ROLLBACK_SECONDS unless
 * told otherwise. If the change went through and this side can still talk
 * to NetworkManager a moment later, the checkpoint is destroyed and the
 * change stays. If the connection was lost, nobody destroys it, and
 * NetworkManager rolls the change back: the machine comes back by itself.
 * A change that broke the connection is then reported as that, and can be
 * made again without the safety net -- the user's explicit choice.
 *
 * Unlike upstream, no transport "hint" is sent to pause its health check: a
 * bare bridge drops the connection on one (see the README's protocol notes),
 * and no transport here times out in less than the rollback takes.
 *
 * Each action runs on a client of its own, closed when it is over, with
 * every call's signature given: nothing depends on introspection.
 */
import cockpit from "../../cockpit.js";
import { I, NM, NM_PATH, withAutoconnect, type Settings } from "./model.js";
import { CLIENT_OPTIONS, FIREWALL_UNIT } from "./store.js";

/** How long NetworkManager waits before undoing an unconfirmed change (interfaces.js rollback_time). */
export const ROLLBACK_SECONDS = 7;
/** How long the change is given to show its effect before it is confirmed (settle_time). */
export const SETTLE_MS = 1000;

/** What an action is timed with; tests shorten the wait. */
export const actionSettings = { settleMs: SETTLE_MS };

/** The change broke the connection to NetworkManager, which then undid it. */
export class RolledBackError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RolledBackError";
    }
}

type Client = ReturnType<typeof cockpit.dbus>;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Make `change` under a checkpoint on `device`, as described above. With
 * `checkpoint` false it is made directly: "do it anyway".
 */
async function withCheckpoint(device: string, checkpoint: boolean, change: (client: Client) => Promise<unknown>): Promise<void> {
    const client = cockpit.dbus(NM, { ...CLIENT_OPTIONS });
    try {
        let created: string | null = null;
        if (checkpoint) {
            try {
                const [path] = await Promise.resolve(client.call(NM_PATH, NM, "CheckpointCreate", [[device], ROLLBACK_SECONDS, 0], { type: "aouu" }));
                created = typeof path === "string" ? path : null;
            } catch (error) {
                // A NetworkManager without checkpoints: the change is made without one, as upstream does.
                if ((error as { name?: unknown } | null)?.name !== "org.freedesktop.DBus.Error.UnknownMethod")
                    throw error;
            }
        }
        try {
            await change(client);
        } catch (error) {
            // Nothing changed, so there is nothing to roll back: a rollback would reconnect the device for nothing.
            if (created)
                await Promise.resolve(client.call(NM_PATH, NM, "CheckpointDestroy", [created], { type: "o" })).catch(() => {});
            throw error;
        }
        if (!created)
            return;
        await sleep(actionSettings.settleMs);
        try {
            await Promise.resolve(client.call(NM_PATH, NM, "CheckpointDestroy", [created], { type: "o" }));
        } catch {
            // It could not be confirmed: the connection went with the change, or the checkpoint has
            // already expired. Either way NetworkManager puts the device back.
            throw new RolledBackError("The change broke the connection to the server, and NetworkManager is undoing it");
        }
    } finally {
        client.close();
    }
}

export interface Target {
    /** The device's object path. */
    readonly device: string;
    /** The interface's name, for what is said about it. Raw host text. */
    readonly name: string;
}

/** Switch an interface on with one of its connections. */
export async function activate(target: Target, connection: string, checkpoint = true): Promise<string> {
    await withCheckpoint(target.device, checkpoint, client =>
        Promise.resolve(client.call(NM_PATH, NM, "ActivateConnection", [connection, target.device, "/"], { type: "ooo" })));
    return `Switched on ${target.name}`;
}

/** Switch an interface off: it stays off until it is switched on again. */
export async function deactivate(target: Target, checkpoint = true): Promise<string> {
    await withCheckpoint(target.device, checkpoint, client =>
        Promise.resolve(client.call(target.device, I.device, "Disconnect", [], { type: "" })));
    return `Switched off ${target.name}`;
}

/** Set a connection's "connect automatically", leaving the rest of its settings as they are. */
export async function setAutoconnect(target: Target, connection: string, settings: Settings, value: boolean): Promise<string> {
    const client = cockpit.dbus(NM, { ...CLIENT_OPTIONS });
    try {
        await Promise.resolve(client.call(connection, I.settings, "Update", [withAutoconnect(settings, value)], { type: "a{sa{sv}}" }));
    } finally {
        client.close();
    }
    return value ? `${target.name} connects automatically` : `${target.name} no longer connects automatically`;
}

/** Switch the firewall on (enabled and started) or off (disabled and stopped), as upstream's switch does. */
export async function setFirewall(on: boolean): Promise<string> {
    const client = cockpit.dbus("org.freedesktop.systemd1", { ...CLIENT_OPTIONS });
    const manager = "org.freedesktop.systemd1.Manager";
    const path = "/org/freedesktop/systemd1";
    try {
        if (on) {
            await Promise.resolve(client.call(path, manager, "EnableUnitFiles", [[FIREWALL_UNIT], false, false], { type: "asbb" }));
            await Promise.resolve(client.call(path, manager, "Reload", [], { type: "" }));
            await Promise.resolve(client.call(path, manager, "StartUnit", [FIREWALL_UNIT, "replace"], { type: "ss" }));
        } else {
            await Promise.resolve(client.call(path, manager, "DisableUnitFiles", [[FIREWALL_UNIT], false], { type: "asb" }));
            await Promise.resolve(client.call(path, manager, "Reload", [], { type: "" }));
            await Promise.resolve(client.call(path, manager, "StopUnit", [FIREWALL_UNIT, "replace"], { type: "ss" }));
        }
    } finally {
        client.close();
    }
    return on ? "Switched the firewall on" : "Switched the firewall off";
}
