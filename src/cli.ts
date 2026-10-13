/*
 * cockpit-tui entry point.
 *
 * The executable shebang is supplied by build.js's banner, not here.
 *
 *   cockpit-tui [options]          the TUI
 *   cockpit-tui probe [options]    line-mode connection check
 */
import "./shim/dom.js";

import { parseCli, usage, UsageError, type CliArgs } from "./args.js";
import { runProbe } from "./probe.js";
import { buildConnectOptions, describeTarget, openSession } from "./session.js";
import { createPrompter } from "./prompter.js";
import { PAGES, pageIndex } from "./tui/pages.js";
import { runTui } from "./tui/run.js";
import { isThemeName, listThemes, setTheme } from "./tui/theme.js";
import { record } from "./tui/log.js";
import { errorText } from "./tui/status.js";
import { clean, cleanBlock } from "./tui/text.js";
import packageJson from "../package.json" with { type: "json" };

async function startTui(args: CliArgs): Promise<number> {
    const initialPage = pageIndex(args.page);
    if (initialPage < 0)
        throw new UsageError(`unknown page '${args.page}' (pages: ${PAGES.map(p => p.id).join(", ")})`);
    if (args.theme !== undefined) {
        if (!isThemeName(args.theme))
            throw new UsageError(`unknown theme '${args.theme}' (themes: ${listThemes().map(t => t.name).join(", ")})`);
        // For this run only: the saved choice is the picker's to change.
        setTheme(args.theme);
    }

    // Ink needs a terminal on both ends: raw keyboard input and a screen to
    // draw on. Without them it would hang or print escape codes into a pipe.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error("cockpit-tui: the TUI needs an interactive terminal; " +
                      "for a non-interactive check use 'cockpit-tui probe'");
        return 2;
    }

    const { ask, close } = createPrompter();
    // Before the TUI starts, the bridge's stderr (ssh errors, mostly) is the
    // user's to see; once it runs, it would scribble over the screen.
    let bridgeStderr = (line: string) => console.error(clean(line));

    let session;
    try {
        const options = await buildConnectOptions(args, {
            ask,
            print: line => console.log(line),
            onBridgeStderr: line => bridgeStderr(line),
        });
        if (options.mode !== "local")
            console.error(`connecting to ${describeTarget(options)} ...`);
        session = await openSession(options);
    } catch (error) {
        console.error(`cockpit-tui: could not connect: ${cleanBlock(errorText(error))}`);
        return 1;
    } finally {
        // readline must let go of stdin before Ink puts it in raw mode.
        close();
    }

    bridgeStderr = line => record("bridge", line);
    const result = await runTui(session, { initialPage, requestAdmin: args.admin });
    session.transport.close();
    // The message can carry the bridge's own words (a close problem): clean.
    if (result.message)
        console.error(cleanBlock(result.message));
    return result.code;
}

async function main(): Promise<number> {
    let args: CliArgs;
    try {
        args = parseCli(process.argv.slice(2));
    } catch (error) {
        if (error instanceof UsageError) {
            console.error(`cockpit-tui: ${error.message}\n\n${usage(PAGES.map(p => p.id), listThemes().map(t => t.name))}`);
            return 2;
        }
        throw error;
    }

    if (args.help) {
        console.log(usage(PAGES.map(p => p.id), listThemes().map(t => t.name)));
        return 0;
    }
    if (args.version) {
        console.log(`cockpit-tui ${packageJson.version}`);
        return 0;
    }

    try {
        return args.command === "probe" ? await runProbe(args) : await startTui(args);
    } catch (error) {
        if (error instanceof UsageError) {
            console.error(`cockpit-tui: ${error.message}`);
            return 2;
        }
        throw error;
    }
}

const code = await main();
// The bridge exits when its stdin closes; nothing else may hold the loop, but
// a stray timer must not keep a finished session alive either.
process.exit(code);
