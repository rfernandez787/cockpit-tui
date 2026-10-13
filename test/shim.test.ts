import { describe, it, expect } from "vitest";
import cockpit from "../src/cockpit.js";
import { transport_globals } from "cockpit/_internal/transport";

describe("loading the vendored cockpit library under Node", () => {
    it("evaluates without a DOM and exposes the public API", () => {
        // If the shim were wrong this whole module would have thrown at import.
        expect(cockpit).toBeTypeOf("object");
        const api = cockpit as unknown as Record<string, unknown>;
        for (const name of ["channel", "dbus", "spawn", "file", "http", "metrics", "user", "permission"])
            expect(api[name], name).toBeTypeOf("function");
    });

    it("exposes the transport seam we inject into", () => {
        expect(transport_globals).toBeTypeOf("object");
        // Nothing has forced a connection, so no real Transport exists yet.
        expect(transport_globals.default_transport).toBeFalsy();
    });

    it("did not construct a WebSocket while loading", () => {
        // Node 22+ ships a native global WebSocket, so its mere presence proves
        // nothing. What matters is that none was constructed: the library only
        // builds one inside `new Transport()`, which we avoid by pre-assigning
        // default_transport before any ensure_transport call.
        const real = globalThis.WebSocket;
        let constructed = 0;
        try {
            // @ts-expect-error -- deliberately replacing the global for the probe
            globalThis.WebSocket = class { constructor() { constructed++ } };
            // Touching the API must not reach for a socket on its own.
            cockpit.format_bytes(1024);
            expect(constructed).toBe(0);
        } finally {
            globalThis.WebSocket = real;
        }
    });

    it("took the direct-transport branch, not the iframe branch", () => {
        // transport.ts picks ParentWebSocket when window.parent !== window.
        const win = globalThis as unknown as { window: Record<string, unknown> };
        expect(win.window.parent).toBe(win.window);
    });

    it("survives the unguarded window.localStorage.test_l10n read", () => {
        // cockpit.js:2271 reads this bare, outside any try/catch.
        const win = globalThis as unknown as { window: { localStorage: Record<string, unknown> } };
        expect(() => win.window.localStorage.test_l10n).not.toThrow();
    });

    it("provides formatting helpers we get for free", () => {
        expect(cockpit.format("$0 and $1", "a", "b")).toBe("a and b");
        expect(cockpit.format_bytes(1e6)).toMatch(/MB/);
    });

    it("maps problem codes to human strings", () => {
        expect(cockpit.message("access-denied")).toBeTypeOf("string");
        expect(cockpit.message("access-denied").length).toBeGreaterThan(0);
    });
});
