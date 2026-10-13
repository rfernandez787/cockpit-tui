/*
 * Command line parsing, shared by the TUI and the probe.
 *
 * Strict: an unknown option or a stray argument is an error rather than
 * something silently ignored, because a mistyped `--hots` that fell back to
 * the local machine would be worse than no answer.
 */
import { parseArgs } from "node:util";

export type Command = "tui" | "probe";

export interface CliArgs {
    command: Command;
    help: boolean;
    version: boolean;
    /** ssh target, "host" or "user@host". */
    host?: string;
    /** cockpit-ws URL. */
    ws?: string;
    user?: string;
    bridge?: string;
    insecure: boolean;
    /** Probe: also test escalation. TUI: ask for administrative access at startup. */
    admin: boolean;
    /** TUI: the page to open first. */
    page?: string;
    /** TUI: the colour scheme for this run. */
    theme?: string;
}

export class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UsageError";
    }
}

export function parseCli(argv: string[]): CliArgs {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            allowPositionals: true,
            strict: true,
            options: {
                help: { type: "boolean", short: "h" },
                version: { type: "boolean", short: "V" },
                host: { type: "string" },
                ws: { type: "string" },
                user: { type: "string" },
                bridge: { type: "string" },
                insecure: { type: "boolean" },
                admin: { type: "boolean" },
                page: { type: "string" },
                theme: { type: "string" },
            },
        });
    } catch (error) {
        // parseArgs' messages are already good ("Unknown option '--x'"); keep
        // them, minus the hint about `--` that does not apply here.
        throw new UsageError((error as Error).message.replace(/\. To specify a positional.*$/s, ""));
    }

    const { values, positionals } = parsed;
    let command: Command = "tui";
    if (positionals.length > 0) {
        const [first, ...rest] = positionals;
        if (first === "probe")
            command = "probe";
        else if (first !== "tui")
            throw new UsageError(`unknown command '${first}'`);
        if (rest.length)
            throw new UsageError(`unexpected argument '${rest[0]}'`);
    }

    for (const name of ["host", "ws", "user", "bridge", "page", "theme"] as const) {
        if (values[name] !== undefined && values[name] === "")
            throw new UsageError(`--${name} needs a value`);
    }

    if (values.host !== undefined && values.ws !== undefined)
        throw new UsageError("--host and --ws are mutually exclusive");
    if (values.bridge !== undefined && (values.host !== undefined || values.ws !== undefined))
        throw new UsageError("--bridge applies only to a local bridge");
    if (values.insecure && values.ws === undefined)
        throw new UsageError("--insecure applies only to --ws");
    if (values.user !== undefined && values.host === undefined && values.ws === undefined)
        throw new UsageError("--user applies only to --ws or --host");
    if (values.host?.includes("@") && values.user !== undefined)
        throw new UsageError("give the ssh user either as user@host or with --user, not both");
    if (values.page !== undefined && command === "probe")
        throw new UsageError("--page applies only to the TUI");
    if (values.theme !== undefined && command === "probe")
        throw new UsageError("--theme applies only to the TUI");

    return {
        command,
        help: values.help ?? false,
        version: values.version ?? false,
        insecure: values.insecure ?? false,
        admin: values.admin ?? false,
        ...(values.host !== undefined ? { host: values.host } : {}),
        ...(values.ws !== undefined ? { ws: values.ws } : {}),
        ...(values.user !== undefined ? { user: values.user } : {}),
        ...(values.bridge !== undefined ? { bridge: values.bridge } : {}),
        ...(values.page !== undefined ? { page: values.page } : {}),
        ...(values.theme !== undefined ? { theme: values.theme } : {}),
    };
}

/** Split "user@host" into its parts; a bare host has no user. */
export function splitUserHost(target: string): { user?: string, host: string } {
    const at = target.lastIndexOf("@");
    if (at <= 0)
        return { host: at === 0 ? target.slice(1) : target };
    return { user: target.slice(0, at), host: target.slice(at + 1) };
}

export function usage(pages: readonly string[], themes: readonly string[] = []): string {
    return [
        "cockpit-tui -- a terminal frontend for Cockpit",
        "",
        "usage:",
        "  cockpit-tui [options]          open the TUI",
        "  cockpit-tui probe [options]    check the connection and report what the bridge supports",
        "",
        "where to connect (default: spawn cockpit-bridge on this machine):",
        "  --host [user@]server   run cockpit-bridge on server over ssh",
        "  --ws URL               attach to a running cockpit-ws, e.g. https://server:9090",
        "  --user NAME            login name for --ws (prompted for if omitted), or ssh user",
        "  --bridge PATH          run this instead of the cockpit-bridge on PATH (local only)",
        "  --insecure             accept any TLS certificate (--ws only)",
        "",
        "options:",
        "  --admin                TUI: ask for administrative access at startup",
        "                         probe: also test privilege escalation",
        `  --page NAME            TUI: open this page first (${pages.join(", ")})`,
        `  --theme NAME           TUI: the colour scheme for this run (${themes.join(", ")});`,
        "                         ? then t in the TUI picks one and remembers it;",
        "                         the Colours page makes new ones",
        "  -h, --help             show this help",
        "  -V, --version          show the version",
    ].join("\n");
}
