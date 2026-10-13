/*
 * Unit actions: start, stop, restart, reload, enable, disable, mask, unmask
 * and clearing the failed state -- upstream's calls, in upstream's order
 * (service-details.jsx:313-380), with two corrections:
 *
 *  - Chains stop at the first error. Upstream swallows a failed step and
 *    runs the next one anyway (a failed Stop still disables).
 *  - Jobs are followed to their end. StartUnit() and friends return as soon
 *    as the job is queued; the outcome only arrives later, in JobRemoved.
 *    A oneshot service never even shows "active" -- the result is the only
 *    way to tell success from failure.
 *
 * Each action runs on a client of its own, opened at the current privilege
 * level and closed when the action is over (the callOnce pattern; upstream's
 * pkg/lib/service.js does the same). Its lifetime is the action's, not the
 * page's: a chain such as stop + disable + daemon-reload is not cut in half
 * because the user went to another page in the middle of it.
 *
 * The JobRemoved rule is added before the first call, and results that
 * arrive before the reply naming their job are kept until it does. A job
 * that disappears without a JobRemoved (which should not happen, but would
 * leave the user waiting forever) is noticed by polling the job object.
 *
 * Unit-file changes only touch files; Reload() (daemon-reload) is what makes
 * systemd see them, so every file action is followed by one, as upstream and
 * systemctl do.
 */
import { glyphs } from "../../tui/theme.js";
import cockpit from "../../cockpit.js";
import type { DBusClient } from "../../tui/hooks.js";
import { expectDisconnect, setQuitGuard } from "../../tui/page.js";
import { errorText } from "../../tui/status.js";
import { actionProgress, isActive, jobResultText, type ActionId, type Owner } from "./model.js";
import { alreadySubscribed, callManager, clientOptions, closeReason, JOB, MANAGER, PROPERTIES, SYSTEMD } from "./store.js";
import { clean } from "./format.js";

export interface ActionTarget {
    /** The unit's primary name (upstream acts on Names[0]). */
    readonly name: string;
    readonly activeState: string;
    readonly unitFileState: string;
    /**
     * Starting this unit takes the machine down (reboot.target, ...): what to
     * tell the shell before the start is asked for, so that the connection
     * dropping is reported as that and not as a failure. Null for any other.
     */
    readonly disconnect?: string | null;
}

/** A failure, with a message that already says what failed. */
export class ActionError extends Error {
    /** The connection to systemd closed: whatever was asked for may be happening. */
    readonly lost: boolean;

    constructor(message: string, options: { lost?: boolean } = {}) {
        super(message);
        this.name = "ActionError";
        this.lost = options.lost ?? false;
    }
}

export interface ActionResult {
    /** "Started crond.service". */
    readonly message: string;
    /** Something worth a second look, e.g. a unit without an [Install] section. */
    readonly note: string | null;
}

export interface JobTimings {
    /** How often to check that a job we are waiting for still exists. */
    readonly pollMs: number;
    /** After the job object is gone, how long to wait for its JobRemoved anyway. */
    readonly graceMs: number;
}

const DEFAULT_JOB_TIMINGS: JobTimings = { pollMs: 2000, graceMs: 500 };

/** Results kept for jobs nobody waits for (yet); far more than one action produces. */
const FINISHED_LIMIT = 64;

/** A client for one action, with job tracking. */
export class ActionSession {
    readonly client: DBusClient;
    readonly timings: JobTimings;
    #finished = new Map<string, string>();
    #waiters = new Map<string, { resolve: (result: string) => void, reject: (error: Error) => void }>();
    #closed = false;

    constructor(owner: Owner, timings: Partial<JobTimings> = {}) {
        this.timings = { ...DEFAULT_JOB_TIMINGS, ...timings };
        this.client = cockpit.dbus(SYSTEMD, clientOptions(owner));
        this.client.subscribe({ interface: MANAGER, member: "JobRemoved" }, (_path, _iface, _member, args) => {
            try {
                const [, job, , result] = Array.isArray(args) ? args : [];
                if (typeof job !== "string")
                    return;
                const text = typeof result === "string" ? result : "unknown";
                const waiter = this.#waiters.get(job);
                if (waiter) {
                    waiter.resolve(text);
                    return;
                }
                this.#finished.set(job, text);
                if (this.#finished.size > FINISHED_LIMIT)
                    this.#finished.delete(this.#finished.keys().next().value!);
            } catch (error) {
                console.error("services: JobRemoved handler failed:", error);
            }
        });
        this.client.addEventListener("close", ((_event: unknown, options: { problem?: string, message?: string } | undefined) => {
            if (this.#closed)
                return;
            const reason = closeReason(owner, options);
            for (const waiter of [...this.#waiters.values()])
                waiter.reject(new ActionError(`The connection to systemd closed: ${reason}`, { lost: true }));
        }) as never);
    }

    /** Signals flow only to subscribed connections; this one may be new. */
    async subscribe(): Promise<void> {
        try {
            await callManager(this.client, "Subscribe", []);
        } catch (error) {
            if (!alreadySubscribed(error))
                throw error;
        }
    }

    call(method: string, args: unknown[], type?: string): Promise<unknown[]> {
        return callManager(this.client, method, args, type);
    }

    /** Call a method that queues a job, and wait for the job's result ("done", "failed", ...). */
    async job(method: string, args: unknown[], type: string): Promise<string> {
        const [job] = await this.call(method, args, type);
        if (typeof job !== "string" || !job.startsWith("/"))
            throw new Error(`${method} returned no job`);
        return this.wait(job);
    }

    /** The result of a job, from JobRemoved; "unknown" if it vanished without one. */
    wait(job: string): Promise<string> {
        const finished = this.#finished.get(job);
        if (finished !== undefined) {
            this.#finished.delete(job);
            return Promise.resolve(finished);
        }
        if (this.#closed)
            return Promise.reject(new ActionError("The action was cancelled"));
        return new Promise<string>((resolve, reject) => {
            let grace: NodeJS.Timeout | null = null;
            const poll = setInterval(() => {
                Promise.resolve(this.client.call(job, PROPERTIES, "Get", [JOB, "State"], { type: "ss" })).catch((error: unknown) => {
                    // A channel problem is reported by the close handler; a D-Bus
                    // error means the job object is gone.
                    if (grace || !this.#waiters.has(job) || (error as { problem?: unknown }).problem)
                        return;
                    grace = setTimeout(() => this.#waiters.get(job)?.resolve("unknown"), this.timings.graceMs);
                });
            }, this.timings.pollMs);
            const finish = () => {
                clearInterval(poll);
                if (grace)
                    clearTimeout(grace);
                this.#waiters.delete(job);
            };
            this.#waiters.set(job, {
                resolve: result => { finish(); resolve(result) },
                reject: error => { finish(); reject(error) },
            });
        });
    }

    close(): void {
        if (this.#closed)
            return;
        this.#closed = true;
        for (const waiter of [...this.#waiters.values()])
            waiter.reject(new ActionError("The action was cancelled"));
        this.client.close();
    }
}

/**
 * Run one step; a failure says which step failed and why. A failure with a
 * channel problem (rather than systemd's answer) means the connection went.
 */
async function step<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        if (error instanceof ActionError)
            throw error;
        const lost = !!(error as { problem?: unknown } | null)?.problem;
        throw new ActionError(`${what} failed: ${errorText(error)}`, { lost });
    }
}

/** Describe the (type, path, source) changes a unit-file method reports, for the log. */
export function describeChanges(changes: unknown): string[] {
    if (!Array.isArray(changes))
        return [];
    return changes.flatMap(change => {
        if (!Array.isArray(change))
            return [];
        const [type, path, source] = change as unknown[];
        if (type === "symlink")
            return [`Created symlink ${String(path)} ${glyphs.arrow} ${String(source)}`];
        if (type === "unlink")
            return [`Removed ${String(path)}`];
        return [`${String(type)} ${String(path)}${source ? ` ${String(source)}` : ""}`];
    });
}

export interface PerformOptions {
    readonly timings?: Partial<JobTimings>;
}

// ---- actions in flight -------------------------------------------------------------

/*
 * The actions running right now, by unit: the list and the details show them
 * ("Stopping…") until they end, and a second action on a unit that has one
 * running is refused rather than racing it (with job mode "fail" systemd
 * would refuse a conflicting job anyway, with a less helpful message).
 *
 * Module state, because an action outlives the view -- and the page -- that
 * started it: a dialog sent to the background keeps its action running.
 */
export interface RunningAction {
    readonly owner: Owner;
    readonly name: string;
    readonly action: ActionId;
    /** "Stopping and disabling", for display. */
    readonly progress: string;
}

const running = new Map<string, RunningAction>();
const runningListeners = new Set<() => void>();
let runningVersion = 0;

function runningKey(owner: Owner, name: string): string {
    return `${owner}\n${name}`;
}

function runningChanged(): void {
    runningVersion += 1;
    for (const listener of [...runningListeners]) {
        try {
            listener();
        } catch (error) {
            console.error("services: running-actions listener failed:", error);
        }
    }
}

export const runningActions = {
    /** The action running on this unit (by primary name), if any. */
    get(owner: Owner, name: string): RunningAction | undefined {
        return running.get(runningKey(owner, name));
    },
    /** For useSyncExternalStore. */
    subscribe(listener: () => void): () => void {
        runningListeners.add(listener);
        return () => runningListeners.delete(listener);
    },
    version(): number {
        return runningVersion;
    },
};

/**
 * performAction(), registered as running on the unit until it ends. While it
 * runs, quitting asks first: a chain cut off half way (stopped, but not yet
 * disabled) is worse than either end of it.
 */
export function trackAction(owner: Owner, target: ActionTarget, action: ActionId,
                            options: PerformOptions = {}): Promise<ActionResult> {
    const key = runningKey(owner, target.name);
    if (running.has(key))
        return Promise.reject(new ActionError(`An action on ${target.name} is still running`));
    const progress = actionProgress(action, isActive(target.activeState));
    running.set(key, { owner, name: target.name, action, progress });
    // The shell shows this as it is: the name is host text.
    setQuitGuard(`services:${key}`, `${progress} ${clean(target.name)} is still running; quitting now may leave it half done.`);
    runningChanged();
    return performAction(owner, target, action, options).finally(() => {
        running.delete(key);
        setQuitGuard(`services:${key}`, null);
        runningChanged();
    });
}

/**
 * Do `action` to the unit, waiting for every job it queues. Resolves with
 * what happened; rejects with an ActionError that says what failed.
 */
export async function performAction(owner: Owner, target: ActionTarget, action: ActionId,
                                    options: PerformOptions = {}): Promise<ActionResult> {
    const session = new ActionSession(owner, options.timings);
    const name = target.name;
    const active = isActive(target.activeState);
    const failed = target.activeState === "failed";

    /** A job method: anything but "done" (or a vanished job) is a failure. */
    const job = async (method: string, what: string) => {
        const result = await step(what, () => session.job(method, [name, "fail"], "ss"));
        if (result !== "done" && result !== "unknown")
            throw new ActionError(`${what} failed: ${jobResultText(result)}`);
    };
    /**
     * StartUnit. For a target that takes the machine down, the shell is told
     * first; if systemd refuses or the job fails, nothing is going down after
     * all and it is told so. A connection that closed meanwhile may well be
     * the reboot itself: that is left as expected.
     */
    const startJob = async () => {
        const disconnect = target.disconnect ?? null;
        if (disconnect)
            expectDisconnect(disconnect);
        try {
            await job("StartUnit", `Starting ${name}`);
        } catch (error) {
            if (disconnect && !(error instanceof ActionError && error.lost))
                expectDisconnect(null);
            throw error;
        }
    };
    const daemonReload = () => step("Reloading the systemd configuration", () => session.call("Reload", []));
    const resetFailed = () => step(`Clearing the failed state of ${name}`, () => session.call("ResetFailedUnit", [name], "s"));
    const fileAction = async (what: string, method: string, args: unknown[], type: string) => {
        const reply = await step(what, () => session.call(method, args, type));
        // EnableUnitFiles returns (carries_install_info, changes); the others just the changes.
        const changes = method === "EnableUnitFiles" ? reply[1] : reply[0];
        for (const line of describeChanges(changes))
            console.info(`services: ${line}`);
        return reply;
    };

    try {
        await step("Connecting to systemd", () => session.subscribe());
        switch (action) {
        case "start":
            await startJob();
            return { message: `Started ${name}`, note: null };
        case "stop":
            await job("StopUnit", `Stopping ${name}`);
            return { message: `Stopped ${name}`, note: null };
        case "restart":
            await job("RestartUnit", `Restarting ${name}`);
            return { message: `Restarted ${name}`, note: null };
        case "reload":
            await job("ReloadUnit", `Reloading ${name}`);
            return { message: `Reloaded ${name}`, note: null };
        case "reset":
            await resetFailed();
            return { message: `Cleared the failed state of ${name}`, note: null };
        case "enable": {
            const [carriesInstallInfo] = await fileAction(`Enabling ${name}`, "EnableUnitFiles", [[name], false, false], "asbb");
            await daemonReload();
            if (!active)
                await startJob();
            return {
                message: active ? `Enabled ${name}` : `Enabled and started ${name}`,
                note: carriesInstallInfo === false ? "This unit is not designed to be enabled explicitly." : null,
            };
        }
        case "disable":
            if (active)
                await job("StopUnit", `Stopping ${name}`);
            else if (failed)
                await resetFailed();
            await fileAction(`Disabling ${name}`, "DisableUnitFiles", [[name], false], "asb");
            await daemonReload();
            return { message: active ? `Stopped and disabled ${name}` : `Disabled ${name}`, note: null };
        case "mask":
            await fileAction(`Masking ${name}`, "MaskUnitFiles", [[name], false, false], "asbb");
            // Upstream clears a failed state along with masking (testResetFailed).
            if (failed)
                await resetFailed();
            await daemonReload();
            return { message: `Masked ${name}`, note: null };
        case "unmask":
            await fileAction(`Unmasking ${name}`, "UnmaskUnitFiles", [[name], false], "asb");
            await daemonReload();
            return { message: `Unmasked ${name}`, note: null };
        default:
            throw new ActionError(`Unknown action ${String(action)}`);
        }
    } finally {
        session.close();
    }
}
