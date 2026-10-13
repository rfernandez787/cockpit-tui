/*
 * One owner's podman: its containers and images, listed once and then kept
 * current by podman's event stream, and the running containers' CPU and
 * memory from its stats stream.
 * Upstream: cockpit-podman 121, src/app.jsx (init, handleEvent, updateContainerStats).
 *
 * Upstream patches single containers on each event. Here an event that
 * changes something the lists show schedules one re-read of the list it
 * touches, debounced: a `podman restart` is half a dozen events, and the
 * list endpoint already carries everything a row needs. A container's full
 * inspection is only fetched for its details.
 *
 * podman's API service is socket-activated and exits when idle. As upstream,
 * a socket that does not answer is started once (`systemctl start
 * podman.socket`, for the user's or the system's manager) before giving up;
 * the open event stream then keeps the service up for as long as the page
 * is shown.
 */
import cockpit from "../../cockpit.js";
import { run } from "../../tui/hooks.js";
import { errorText } from "../../tui/status.js";
import { connect, isSystem, PodmanError, privileges, type Connection, type Owner, type Stream } from "./rest.js";
import { eventEffect, parseContainers, parseImages, parseStats, type Container, type Image, type Stats } from "./model.js";

export type StoreStatus = "loading" | "ready" | "inactive" | "error";

export interface StoreTimings {
    /** Quiet period before a list is read again after events. */
    readonly refreshMs: number;
    /** Repaint at most this often. */
    readonly repaintMs: number;
    /** How long the first answer may take. */
    readonly infoTimeoutMs: number;
    /** Seconds between stats samples. */
    readonly statsInterval: number;
}

export const DEFAULT_TIMINGS: StoreTimings = { refreshMs: 150, repaintMs: 100, infoTimeoutMs: 10_000, statsInterval: 5 };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new PodmanError("podman did not answer in time")), ms);
        promise.then(value => { clearTimeout(timer); resolve(value) }, (error: unknown) => { clearTimeout(timer); reject(error) });
    });
}

export class PodmanStore {
    readonly owner: Owner;
    readonly timings: StoreTimings;

    containers: readonly Container[] = [];
    images: readonly Image[] = [];
    /** By container id; replaced, never mutated. */
    stats: ReadonlyMap<string, Stats> = new Map();
    /** podman's version, once it answered. */
    podmanVersion = "";
    /** A later re-read failed; what is shown is the last good state. */
    warning: string | null = null;
    version = 0;

    #connection: Connection | null = null;
    #status: StoreStatus = "loading";
    #error: string | null = null;
    #closed = false;
    #listeners = new Set<() => void>();
    #repaintTimer: NodeJS.Timeout | null = null;
    #lastRepaint = 0;
    #refreshTimer: NodeJS.Timeout | null = null;
    #wanted = { containers: false, images: false };
    #events: Stream | null = null;
    #statsStream: Stream | null = null;

    constructor(owner: Owner, timings: Partial<StoreTimings> = {}) {
        this.owner = owner;
        this.timings = { ...DEFAULT_TIMINGS, ...timings };
    }

    get status(): StoreStatus {
        return this.#status;
    }

    get error(): string | null {
        return this.#error;
    }

    get closed(): boolean {
        return this.#closed;
    }

    readonly subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };

    readonly getVersion = (): number => this.version;

    start(): void {
        void this.#init();
    }

    close(): void {
        if (this.#closed)
            return;
        this.#closed = true;
        for (const timer of [this.#repaintTimer, this.#refreshTimer])
            if (timer)
                clearTimeout(timer);
        this.#listeners.clear();
        this.#connection?.close();
        this.#connection = null;
    }

    /** Read both lists again: Ctrl+R. */
    refresh(): void {
        if (this.#closed || this.#status !== "ready")
            return;
        this.#wanted = { containers: true, images: true };
        void this.#reread();
    }

    /** A container's full inspection, for its details. */
    async inspect(id: string): Promise<unknown> {
        if (!this.#connection)
            throw new PodmanError("not connected to podman");
        return this.#connection.json("GET", `libpod/containers/${encodeURIComponent(id)}/json`);
    }

    async #info(connection: Connection): Promise<string> {
        const info = await withTimeout(connection.json("GET", "libpod/info"), this.timings.infoTimeoutMs) as
            { version?: { Version?: unknown } } | null;
        return typeof info?.version?.Version === "string" ? info.version.Version : "";
    }

    async #init(): Promise<void> {
        const connection = connect(this.owner);
        this.#connection = connection;
        try {
            try {
                this.podmanVersion = await this.#info(connection);
            } catch (error) {
                if (this.#closed)
                    return;
                // Nothing listens on the socket: podman.socket is not active. Start it, once.
                if (!(error instanceof PodmanError) || error.problem !== "not-found")
                    throw error;
                await this.#startService();
                if (this.#closed)
                    return;
                this.podmanVersion = await this.#info(connection);
            }
            if (this.#closed)
                return;
            const [containers, images] = await Promise.all([
                connection.json("GET", "libpod/containers/json", { all: true }),
                connection.json("GET", "libpod/images/json"),
            ]);
            if (this.#closed)
                return;
            this.containers = parseContainers(this.owner, containers);
            this.images = parseImages(this.owner, images);
            this.#status = "ready";
            this.#follow(connection);
        } catch (error) {
            if (this.#closed)
                return;
            const problem = error instanceof PodmanError ? error.problem : null;
            if (problem === "not-found") {
                this.#status = "inactive";
                this.#error = "the podman service is not active (podman.socket)";
            } else {
                this.#status = "error";
                this.#error = problem === "access-denied" ? "not permitted" : errorText(error);
            }
        }
        this.#changed();
    }

    /** app.jsx init(): `systemctl [--user] start podman.socket`. */
    async #startService(): Promise<void> {
        try {
            if (isSystem(this.owner)) {
                await run(["systemctl", "start", "podman.socket"], privileges(this.owner));
            } else {
                const uid = cockpit.info?.user?.uid;
                await run(["systemctl", "--user", "start", "podman.socket"],
                          { environ: [`XDG_RUNTIME_DIR=/run/user/${typeof uid === "number" ? uid : 0}`] });
            }
        } catch (error) {
            console.warn(`podman: starting podman.socket (${this.owner}) failed:`, errorText(error));
        }
    }

    #follow(connection: Connection): void {
        this.#events = connection.stream("libpod/events", {}, value => {
            const effect = eventEffect(value);
            if (!effect.containers && !effect.images)
                return;
            this.#wanted = {
                containers: this.#wanted.containers || effect.containers,
                images: this.#wanted.images || effect.images,
            };
            if (this.#closed || this.#refreshTimer)
                return;
            this.#refreshTimer = setTimeout(() => {
                this.#refreshTimer = null;
                void this.#reread();
            }, this.timings.refreshMs);
        }, error => {
            if (this.#closed)
                return;
            // Without events the lists go stale: say so rather than show them as current.
            this.#status = "error";
            this.#error = `the connection to podman closed${error ? `: ${errorText(error)}` : ""}`;
            this.#changed();
        });
        this.#statsStream = connection.stream("libpod/containers/stats", { stream: true, interval: this.timings.statsInterval }, value => {
            const stats = parseStats(value);
            if (stats) {
                this.stats = stats;
                this.#changed();
            }
        }, error => {
            // No cgroups v2, or nothing running: usage is just not shown.
            if (error && !this.#closed)
                console.warn(`podman: container stats (${this.owner}) are not available:`, errorText(error));
        });
    }

    async #reread(): Promise<void> {
        const connection = this.#connection;
        const wanted = this.#wanted;
        this.#wanted = { containers: false, images: false };
        if (!connection || this.#closed)
            return;
        try {
            const [containers, images] = await Promise.all([
                wanted.containers ? connection.json("GET", "libpod/containers/json", { all: true }) : null,
                wanted.images ? connection.json("GET", "libpod/images/json") : null,
            ]);
            if (this.#closed)
                return;
            if (wanted.containers)
                this.containers = parseContainers(this.owner, containers);
            if (wanted.images)
                this.images = parseImages(this.owner, images);
            this.warning = null;
        } catch (error) {
            if (this.#closed)
                return;
            this.warning = `Refreshing failed: ${errorText(error)}`;
        }
        this.#changed();
    }

    /** Schedule a repaint, at most one per `repaintMs`. */
    #changed(): void {
        if (this.#closed || this.#repaintTimer)
            return;
        const wait = Math.max(0, this.#lastRepaint + this.timings.repaintMs - Date.now());
        this.#repaintTimer = setTimeout(() => {
            this.#repaintTimer = null;
            this.#lastRepaint = Date.now();
            this.version += 1;
            for (const listener of [...this.#listeners]) {
                try {
                    listener();
                } catch (error) {
                    console.error("podman: store listener failed:", error);
                }
            }
        }, wait);
    }
}
