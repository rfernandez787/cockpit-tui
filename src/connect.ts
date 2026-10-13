/*
 * Choosing a transport.
 *
 * The three modes differ only in how bytes reach a bridge, so everything above
 * this file is written once and works with all of them.
 */
import "./shim/dom.js";

import { localTransport, sshTransport, type StreamTransportOptions } from "./transport/stream.js";
import { WsTransport, type WsTransportOptions, type AuthPrompt } from "./transport/ws.js";
import type { BaseTransport } from "./transport/base.js";

export type { AuthPrompt };

export type ConnectOptions =
    /** Spawn cockpit-bridge on this machine. */
    | ({ mode: "local" } & StreamTransportOptions & { command?: string })
    /** Spawn cockpit-bridge on another machine over ssh. */
    | ({ mode: "ssh", host: string } & StreamTransportOptions & { user?: string, sshArgs?: string[] })
    /** Attach to a cockpit-ws already serving the web console. */
    | ({ mode: "ws" } & WsTransportOptions);

/**
 * Connect and install as the transport backing the cockpit API.
 *
 * Resolves once the init handshake is complete, at which point `cockpit.dbus`,
 * `cockpit.spawn`, `cockpit.file` and the rest are usable.
 */
export async function connect(options: ConnectOptions): Promise<BaseTransport> {
    switch (options.mode) {
    case "local": {
        const transport = localTransport(options);
        transport.install();
        return await transport.connect();
    }
    case "ssh": {
        const transport = sshTransport(options.host, options);
        transport.install();
        return await transport.connect();
    }
    case "ws": {
        const transport = new WsTransport(options);
        transport.install();
        return await transport.connect();
    }
    }
}

/**
 * Parse the connection target from a command line.
 *
 *   (nothing)                  -> local bridge
 *   --host box / user@box      -> ssh
 *   --ws https://box:9090      -> attach to cockpit-ws
 */
export function parseTarget(argv: string[]): ConnectOptions {
    const flag = (name: string): string | undefined => {
        const index = argv.indexOf(`--${name}`);
        return index >= 0 ? argv[index + 1] : undefined;
    };

    const ws = flag("ws");
    if (ws) {
        const user = flag("user");
        if (!user)
            throw new Error("--ws requires --user (and a password, which is prompted for)");
        return { mode: "ws", url: ws, user, password: "" };
    }

    const host = flag("host");
    if (host) {
        const [maybeUser, maybeHost] = host.includes("@") ? host.split("@", 2) : [undefined, host];
        return { mode: "ssh", host: maybeHost!, ...(maybeUser ? { user: maybeUser } : {}) };
    }

    return { mode: "local" };
}
