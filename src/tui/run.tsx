/*
 * Running the TUI over an open session.
 *
 * Ink takes the alternate screen (restored on exit, like vim or htop) and
 * the keyboard in raw mode. Ctrl+C is ours rather than Ink's, because a page
 * may need it. Console output is diverted to the log for the duration (see
 * log.ts), and failures that escape React are turned into a clean exit with
 * the terminal restored rather than a stack trace on the alternate screen.
 */
import { render, type Instance } from "ink";
import inkInstances from "ink-instances";
import { resizeNow } from "./size.js";
import { useEffect, useState } from "react";
import cockpit from "../cockpit.js";
import { Superuser } from "../superuser.js";
import type { Session } from "../session.js";
import { App, type ExitResult } from "./app.js";
import { KeyboardProvider } from "./keyboard.js";
import { PrivilegeProvider } from "./privilege.js";
import { PersistentStateProvider, SessionProvider } from "./session-context.js";
import { StatusProvider, errorText } from "./status.js";
import { captureConsole, logEntries, record, reportInternalError } from "./log.js";
import { clean } from "./text.js";
import { runShutdownHooks } from "./page.js";

export interface TuiOptions {
    /** Index into PAGES. */
    readonly initialPage?: number;
    readonly requestAdmin?: boolean;
}

/** The managed host's own name: what the header shows. */
export async function fetchHostname(): Promise<string | null> {
    try {
        const name = await cockpit.file("/proc/sys/kernel/hostname").read();
        if (name?.trim())
            return name.trim();
    } catch { /* fall through */ }
    try {
        const name = await cockpit.spawn(["uname", "-n"]);
        if (name.trim())
            return name.trim();
    } catch { /* fall through */ }
    return null;
}

/** The whole app: providers around the shell. Exported for tests. */
export function TuiRoot({ session, superuser, options }: { session: Session, superuser: Superuser | null, options: TuiOptions }) {
    const [hostname, setHostname] = useState(() => (session.mode === "local" ? "localhost" : session.target));
    useEffect(() => {
        let live = true;
        void fetchHostname().then(name => {
            // From the host: cleaned once here, for the shell and every page.
            if (live && name)
                setHostname(clean(name));
        });
        return () => { live = false };
    }, []);

    return (
        <SessionProvider value={{ session, hostname }}>
            <KeyboardProvider>
                <StatusProvider>
                    <PrivilegeProvider superuser={superuser}>
                        <PersistentStateProvider>
                            <App
                                {...(options.initialPage !== undefined ? { initialPage: options.initialPage } : {})}
                                requestAdmin={options.requestAdmin ?? false}
                            />
                        </PersistentStateProvider>
                    </PrivilegeProvider>
                </StatusProvider>
            </KeyboardProvider>
        </SessionProvider>
    );
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
        promise.then(
            value => { clearTimeout(timer); resolve(value) },
            (error: unknown) => { clearTimeout(timer); reject(error) });
    });
}

function describe(reason: unknown): string {
    if (reason instanceof Error)
        return reason.stack ?? reason.message;
    return errorText(reason);
}

/**
 * Internal errors were survived on screen, but whatever showed them is gone
 * with the alternate screen: mention them on the way out, for bug reports.
 */
function withErrorSummary(result: ExitResult): ExitResult {
    const errors = logEntries().filter(entry => entry.text.startsWith("internal error:"));
    if (errors.length === 0)
        return result;
    const first = errors[0]!.text.replace(/^internal error: /, "").split("\n")[0];
    const where = process.env.COCKPIT_TUI_LOG ? `; details in ${process.env.COCKPIT_TUI_LOG}` : "";
    const summary = `cockpit-tui: ${errors.length} internal error${errors.length === 1 ? "" : "s"} ` +
        `occurred (first: ${first})${where}`;
    return { ...result, message: [result.message, summary].filter(Boolean).join("\n") };
}

export async function runTui(session: Session, options: TuiOptions = {}): Promise<ExitResult> {
    const restoreConsole = captureConsole(process.env.COCKPIT_TUI_LOG);

    // A promise somebody forgot to handle is a bug, but not one worth
    // killing the session over: log it.
    const onRejection = (reason: unknown) => record("error", `unhandled rejection: ${describe(reason)}`);
    process.on("unhandledRejection", onRejection);

    let instance: Instance | null = null;
    let crashed: Error | null = null;
    // A throw from a timer or a library callback would otherwise kill the
    // process with the terminal still raw and on the alternate screen. One is
    // a bug in one place: log it, show it, carry on. A burst of them means
    // something is badly wrong, perhaps with input itself: then unmount, so
    // Ink restores the terminal, and exit with the error.
    const recent: number[] = [];
    const onUncaught = (error: Error) => {
        const now = Date.now();
        recent.push(now);
        while (recent.length && now - recent[0]! > 10_000)
            recent.shift();
        reportInternalError(error);
        if (recent.length >= 5) {
            crashed = error;
            if (instance)
                instance.unmount(error);
            else
                throw error;
        }
    };
    process.on("uncaughtException", onUncaught);

    let superuser: Superuser | null = null;
    try {
        superuser = await withTimeout(Superuser.open(), 10_000, "cockpit.Superuser");
    } catch (error) {
        record("warn", `administrative access unavailable: ${errorText(error)}`);
    }

    // Before Ink's own resize handler (registered by render(), after this):
    // commit the new size into React so Ink redraws the new layout, not the
    // old one (see size.ts); and when narrower, clear and home first, since
    // the terminal has re-wrapped what was on screen and Ink's line-by-line
    // erase would miscount. Not while a page has handed the terminal to a shell.
    let lastWidth = process.stdout.columns;
    const onResize = () => {
        const width = process.stdout.columns;
        if (inkInstances.get(process.stdout)?.isSuspended) {
            lastWidth = width;
            return;
        }
        if (width < lastWidth)
            process.stdout.write("\x1b[H\x1b[2J");
        lastWidth = width;
        resizeNow();
    };
    process.stdout.on("resize", onResize);

    try {
        instance = render(<TuiRoot session={session} superuser={superuser} options={options} />, {
            exitOnCtrlC: false,
            patchConsole: false,
            alternateScreen: true,
            // Rewrite only the lines that changed: a once-a-second figure then
            // costs a line, not the whole screen -- about 7x less output on
            // the Overview, which matters on a 9600-baud serial console.
            incrementalRendering: true,
        });
        const result = await instance.waitUntilExit() as ExitResult | undefined;
        return withErrorSummary(result ?? { code: 0 });
    } catch (error) {
        const failure = crashed ?? error;
        return withErrorSummary({
            code: 1, message: `cockpit-tui: ${failure instanceof Error ? failure.message : errorText(failure)}`,
        });
    } finally {
        process.stdout.off("resize", onResize);
        runShutdownHooks();
        process.off("unhandledRejection", onRejection);
        process.off("uncaughtException", onUncaught);
        restoreConsole();
    }
}
