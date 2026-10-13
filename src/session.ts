/*
 * From command line to a live connection.
 *
 * Shared by the probe and the TUI. Everything that may need to ask the user
 * something -- the cockpit-ws password, a 2FA conversation, whether to trust
 * a self-signed certificate -- happens here, in line mode, before the TUI
 * owns the terminal. ssh asks its own questions on /dev/tty.
 */
import cockpit from "./cockpit.js";
import { connect, type ConnectOptions } from "./connect.js";
import { splitUserHost, type CliArgs } from "./args.js";
import type { Ask } from "./prompter.js";
import type { BaseTransport } from "./transport/base.js";
import { clean, cleanBlock } from "./tui/text.js";

export interface Session {
    readonly mode: ConnectOptions["mode"];
    /** The target as the user named it: "localhost", "admin@server", "https://server:9090". */
    readonly target: string;
    readonly transport: BaseTransport;
}

export interface ConnectHooks {
    ask: Ask;
    /** Where line-mode chatter goes (prompts' context, certificate details). */
    print: (line: string) => void;
    /** Where the bridge's own stderr goes. Switchable, so the TUI can take it over. */
    onBridgeStderr: (line: string) => void;
}

export async function buildConnectOptions(args: CliArgs, hooks: ConnectHooks): Promise<ConnectOptions> {
    const { ask, print, onBridgeStderr } = hooks;

    if (args.ws) {
        const user = args.user ?? await ask("user: ");
        if (!user)
            throw new Error("a user name is required to log in to cockpit-ws");
        const password = await ask(`password for ${user}: `, true);
        return {
            mode: "ws",
            url: args.ws,
            user,
            password,
            insecure: args.insecure,
            // Everything below comes from the server, before any trust is
            // established: clean it, so it cannot drive the terminal.
            onPrompt: async prompt => {
                if (prompt.message)
                    print(`  ${cleanBlock(prompt.message)}`);
                if (prompt.error)
                    print(`  ${cleanBlock(prompt.error)}`);
                return await ask(`  ${clean(prompt.prompt)}`, !prompt.echo);
            },
            onCertificate: async cert => {
                print("");
                print("TLS certificate is not signed by a known CA:");
                print(`  subject     ${clean(cert.subject)}`);
                print(`  issuer      ${clean(cert.issuer)}`);
                print(`  SHA-256     ${clean(cert.fingerprint256)}`);
                const answer = await ask("trust this certificate? [y/N] ");
                return /^y(es)?$/i.test(answer);
            },
        };
    }

    if (args.host) {
        const { user, host } = splitUserHost(args.host);
        const sshUser = user ?? args.user;
        if (!host)
            throw new Error(`no host name in '${args.host}'`);
        return {
            mode: "ssh",
            host,
            ...(sshUser ? { user: sshUser } : {}),
            onStderr: onBridgeStderr,
        };
    }

    return {
        mode: "local",
        ...(args.bridge ? { command: args.bridge } : {}),
        onStderr: onBridgeStderr,
    };
}

export function describeTarget(options: ConnectOptions): string {
    switch (options.mode) {
    case "local": return "localhost";
    case "ssh": return options.user ? `${options.user}@${options.host}` : options.host;
    case "ws": return options.url;
    }
}

/**
 * Connect, then run upstream's own bootstrap, which fills `cockpit.info`
 * from the bridge's `info` channel. Resolves once the cockpit API is usable.
 */
export async function openSession(options: ConnectOptions): Promise<Session> {
    const transport = await connect(options);
    try {
        await initInfo();
    } catch (error) {
        transport.close();
        throw error;
    }
    return { mode: options.mode, target: describeTarget(options), transport };
}

/**
 * `cockpit.init()`, tolerating bridges that predate the `info` channel.
 *
 * Upstream's fetch_info() rejects with the raw close message rather than an
 * Error. A "not-supported" close means an older bridge: rebuild the parts of
 * `cockpit.info` the TUI reads from the sources those bridges do have, the
 * cockpit.User object on the internal bus and /etc/os-release. Anything else
 * is a real failure.
 */
export async function initInfo(): Promise<void> {
    try {
        await cockpit.init();
        return;
    } catch (error) {
        const problem = (error as { problem?: unknown } | null)?.problem;
        if (problem !== "not-supported") {
            if (error instanceof Error)
                throw error;
            const detail = typeof problem === "string" ? cockpit.message(problem) : String(error);
            throw new Error(`could not read host information: ${detail}`);
        }
    }

    const [user, osRelease] = await Promise.all([
        cockpit.user().catch(() => null),
        cockpit.file("/etc/os-release").read()
            .then(text => text ?? cockpit.file("/usr/lib/os-release").read())
            .catch(() => null),
    ]);
    Object.assign(cockpit.info, {
        channels: {},
        os_release: parseOsRelease(osRelease ?? ""),
        ...(user
            ? {
                user: {
                    name: user.name, uid: user.id, gid: user.gid, fullname: user.full_name,
                    groups: [...user.groups], home: user.home, shell: user.shell, group: "",
                },
            }
            : {}),
    });
}

/** Parse os-release(5): KEY=value lines, values optionally quoted with shell escapes. */
export function parseOsRelease(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#"))
            continue;
        const eq = line.indexOf("=");
        if (eq <= 0)
            continue;
        const key = line.slice(0, eq);
        let value = line.slice(eq + 1);
        const quote = value[0];
        if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
            value = value.slice(1, -1);
            if (quote === '"')
                value = value.replace(/\\([$"\\`])/g, "$1");
        }
        out[key] = value;
    }
    return out;
}
