/*
 * Minimal DOM shim so Cockpit's browser client library loads under Node.
 *
 * This exists to satisfy module-evaluation-time reads in the vendored code. It
 * is deliberately not jsdom: the surface actually touched is small and well
 * understood, and a real DOM would invite the library to take browser paths we
 * do not want.
 *
 * Importing this module installs the shim as a side effect. It MUST be fully
 * evaluated before `vendor/cockpit.js`. Do not import "cockpit" directly
 * anywhere in the app -- import `src/cockpit.ts`, which orders the two.
 *
 * What the vendored closure needs, verified by grepping it:
 *
 *   window.location.origin        location-utils.ts, read at module load
 *   document.head.querySelector   location-utils.ts, read at module load
 *   HTMLMetaElement               location-utils.ts `instanceof` -- a missing
 *                                 global here is a TypeError, not undefined
 *   window.localStorage           cockpit.js:2271 reads `.test_l10n` bare,
 *                                 outside any try/catch
 *   window.sessionStorage         common.ts, cockpit.js debugging setup
 *   document.cockpit_transport_globals   transport.ts stashes state here
 *   window.parent                 transport.ts -- must === window so the
 *                                 ParentWebSocket (iframe) branch is skipped
 *   window.addEventListener       transport.ts, cockpit.js
 *   document.addEventListener     cockpit.js page-visibility wiring
 *   document.hidden               cockpit.js
 *   window.onerror                cockpit.js oops() handler
 *   window.cockpit                cockpit.js:3012 assigns itself here
 *
 * Node 22+ already provides CustomEvent, TextEncoder/Decoder, atob/btoa and
 * structuredClone, so none of those are shimmed.
 */

/** In-memory Web Storage. Cockpit's own caching layer is unused by the TUI. */
class MemoryStorage {
    #data = new Map<string, string>();

    get length(): number {
        return this.#data.size;
    }

    getItem(key: string): string | null {
        return this.#data.get(String(key)) ?? null;
    }

    setItem(key: string, value: string): void {
        this.#data.set(String(key), String(value));
    }

    removeItem(key: string): void {
        this.#data.delete(String(key));
    }

    clear(): void {
        this.#data.clear();
    }

    key(index: number): string | null {
        return [...this.#data.keys()][index] ?? null;
    }
}

/**
 * Stand-in for the `<meta name="url-root">` lookup. Nothing is ever an
 * instance of it, which is the point: `get_url_root()` then falls through to
 * its localStorage path and returns null.
 */
class HTMLMetaElementStub {}

export interface ShimOptions {
    /**
     * Origin reported as `cockpit.transport.origin`. Cosmetic in normal use --
     * we inject our own transport, so the library never derives a socket URL --
     * but set it for accurate diagnostics when attaching to cockpit-ws.
     *
     * Captured by the vendored code at module load, so this only has effect if
     * applied before `vendor/cockpit.js` evaluates.
     */
    origin?: string;
}

let installed = false;

export function installDomShim(options: ShimOptions = {}): void {
    if (installed)
        return;
    installed = true;

    const origin = options.origin ?? "http://localhost";
    const { host, protocol } = (() => {
        try {
            const u = new URL(origin);
            return { host: u.host, protocol: u.protocol };
        } catch {
            return { host: "localhost", protocol: "http:" };
        }
    })();

    const g = globalThis as Record<string, unknown>;

    // window === globalThis gives us setTimeout/setInterval/clearInterval,
    // btoa/atob, Uint8Array and ArrayBuffer for free -- all of which the
    // vendored code reaches for as `window.*`.
    g.window = globalThis;
    const win = globalThis as Record<string, unknown>;

    // Must be identical to `window` so transport.ts takes the direct branch
    // rather than constructing a ParentWebSocket for a shell iframe.
    win.parent = globalThis;
    win.name = "";

    win.location = {
        origin, host, protocol,
        href: origin + "/",
        pathname: "/",
        hash: "",
        search: "",
        toString() { return origin + "/"; },
        reload() { /* no page to reload */ },
    };

    win.localStorage = new MemoryStorage();
    win.sessionStorage = new MemoryStorage();

    // The library registers unload/storage/message listeners we have no
    // analogue for. Accept and drop them.
    win.addEventListener ??= () => {};
    win.removeEventListener ??= () => {};
    win.dispatchEvent ??= () => true;
    win.onerror = null;

    g.HTMLMetaElement = HTMLMetaElementStub;

    g.document = {
        // transport.ts stores its singleton here; must stay writable.
        cockpit_transport_globals: undefined,
        head: { querySelector: () => null },
        body: { addEventListener() {}, removeEventListener() {} },
        hidden: false,
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => true,
        createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
        createEvent: () => ({ initEvent() {} }),
    };
}

installDomShim();
