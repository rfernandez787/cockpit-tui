/*
 * Types for the vendored Cockpit modules we import directly.
 *
 * The vendored sources are upstream browser code written against a DOM lib
 * config; typechecking them under this project's stricter settings produces
 * noise about code we have deliberately chosen not to modify. Declaring the
 * modules instead gives our own code full type safety at the boundary.
 *
 * Runtime resolution is separate: vitest aliases and esbuild `nodePaths` map
 * these specifiers to vendor/, mirroring upstream's own build.
 */

declare module "cockpit/event" {
    export class EventEmitter<EM extends { [E in keyof EM]: (...args: never[]) => void }> {
        on<E extends keyof EM>(event: E, listener: EM[E]): () => void;
        protected emit<E extends keyof EM>(event: E, ...args: Parameters<EM[E]>): void;
    }
}

declare module "cockpit/_internal/transport" {
    type JsonObject = Record<string, unknown>;

    // Mirrors the TransportGlobals class in
    // vendor/cockpit/_internal/transport.ts; keep the nullability identical, or
    // our code will be typechecked against a shape that does not exist.
    export const transport_globals: {
        default_transport: unknown;
        default_host: string | null;
        expect_disconnect: boolean;
        reload_after_disconnect: boolean;
        init_callback: ((options: JsonObject) => void) | null;
        process_hints: ((data: JsonObject) => void) | null;
        incoming_filters: ((message: string, channel: string, control: JsonObject | null) => boolean | undefined)[];
    };

    export function ensure_transport(callback: (transport: unknown) => void): void;
}

/*
 * Fill gaps in upstream's hand-written cockpit.d.ts. Ambient module
 * declarations merge, so these add to it rather than replacing it.
 */
declare module "cockpit" {
    interface Channel {
        addEventListener(event: string, handler: (...args: never[]) => void): void;
        removeEventListener(event: string, handler: (...args: never[]) => void): void;
        send(data: string | Uint8Array): void;
        close(options?: unknown): void;
    }

    interface Transport {
        /** Install an incoming frame filter. Returning false drops the frame. */
        filter(
            callback: (message: string, channel: string, control: JsonObject | null) => boolean | undefined,
        ): void;
        /**
         * Feed a raw `<channel>\n<payload>` frame in either direction.
         * `out` defaults to true (towards the bridge); false dispatches inward.
         */
        inject(message: string, out?: boolean): boolean;
    }

    /** Deprecated upstream, but still part of the session-control surface. */
    export function drop_privileges(): void;
}

/*
 * `cockpit.info` is an event target, which upstream's Info interface does not
 * say. It lives in the global scope because src/types/cockpit.d.ts is a script,
 * not a module -- see the header there.
 */
interface Info {
    addEventListener(event: "changed", handler: () => void): void;
    removeEventListener(event: "changed", handler: () => void): void;
}

/*
 * Ink's React reconciler instance (node_modules/ink/build/reconciler.js),
 * aliased in build.js and vitest.config.ts because Ink does not export it.
 */
declare module "ink-reconciler" {
    const reconciler: {
        /** Run fn with discrete (keyboard) event priority: its updates are synchronous. */
        discreteUpdates<T>(fn: () => T): T;
        /** Render and commit pending synchronous updates now. */
        flushSyncWork(): void;
    };
    export default reconciler;
}

/* Ink's registry of running instances, by stdout (aliased like ink-reconciler). */
declare module "ink-instances" {
    const instances: WeakMap<object, { isSuspended: boolean }>;
    export default instances;
}
