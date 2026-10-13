/*
 * Podman actions: start, stop, restart, pause and resume a container, delete
 * one, delete an image -- upstream's calls (cockpit-podman 121, src/client.ts:
 * postContainer, delContainer, delImage), and reading a container's log.
 *
 * Each runs on a connection of its own at the owner's privilege (the user's
 * socket as the user, the system's with administrative access), closed when
 * it is over, so it is not cut short by the user leaving the page. The lists
 * follow by themselves: every one of these makes podman emit events.
 *
 * Deleting a container that still runs is a forced delete, as upstream's
 * dialog does it (it says so first). Deleting an image is never forced:
 * podman refuses while a container uses it, and its reason is shown.
 *
 * The log is read with `podman logs`, not the API: the API's log stream is
 * a binary multiplexing of stdout and stderr that the CLI already undoes.
 */
import cockpit from "../../cockpit.js";
import { run } from "../../tui/hooks.js";
import { connect, isSystem, privileges, type Owner } from "./rest.js";
import { isActive, type Container, type ContainerAction, type Image } from "./model.js";

const PAST: Readonly<Record<ContainerAction, string>> = {
    start: "Started", stop: "Stopped", restart: "Restarted", pause: "Paused", unpause: "Resumed", remove: "Deleted",
};

async function call(owner: Owner, method: string, name: string, params: Record<string, string | number | boolean> = {}): Promise<void> {
    const connection = connect(owner);
    try {
        await connection.call(method, name, params);
    } finally {
        connection.close();
    }
}

export async function containerAction(container: Container, action: ContainerAction): Promise<string> {
    const id = encodeURIComponent(container.id);
    if (action === "remove")
        await call(container.owner, "DELETE", `libpod/containers/${id}`, { force: isActive(container) });
    else
        await call(container.owner, "POST", `libpod/containers/${id}/${action}`);
    return `${PAST[action]} ${container.name}`;
}

export async function removeImage(image: Image): Promise<string> {
    await call(image.owner, "DELETE", `libpod/images/${encodeURIComponent(image.id)}`, { force: false });
    return `Deleted ${image.name}`;
}

/** Lines of log kept on screen. */
export const LOG_LINES = 500;

/** The last lines a container wrote to stdout and stderr, as text. */
export async function containerLog(container: Container, signal?: AbortSignal): Promise<string> {
    const uid = cockpit.info?.user?.uid;
    return run(["podman", "logs", "--tail", String(LOG_LINES), container.id], {
        err: "out",
        ...(isSystem(container.owner)
            ? privileges(container.owner)
            : { environ: [`XDG_RUNTIME_DIR=/run/user/${typeof uid === "number" ? uid : 0}`] }),
    }, signal);
}
