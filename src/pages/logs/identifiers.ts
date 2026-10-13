/*
 * The identifier picker's list: the distinct SYSLOG_IDENTIFIERs among the
 * entries the other filters select (the identifier filter itself is left
 * out, so the picker offers the alternatives).
 *
 * This is lib/journal.ts listIdentifiers() made page-local, with the same
 * journalctl arguments (spec 7.3), for three reasons:
 *
 *  - It can be stopped. The scan reads the whole time range -- on a large
 *    persistent journal that can take minutes -- and closing the picker
 *    should end it. Closing a channel makes the bridge SIGTERM only the
 *    process it spawned, here the shell, never the pipeline under it, so
 *    the script traps TERM and stops the pipeline itself: every process of
 *    it is a child of the shell (pkill -P $$). Killing only the last one
 *    ($!, kept for a host without pkill) is not enough: journalctl would
 *    die of SIGPIPE at its next write, but with a --grep that matches
 *    nothing it never writes, and reads the whole range regardless. (`kill
 *    0` would be wrong: spawned processes share the bridge's own process
 *    group.)
 *    listIdentifiers() takes an AbortSignal, but aborting it raises an
 *    uncaught exception (hooks.ts runFull(); see the page's report).
 *  - A failure is reported instead of reading as "no identifiers".
 *  - It needs no `set -o pipefail`, which /bin/sh lacks where it is dash
 *    (Debian before 0.5.11): the older systemd form extracts with
 *    `sed -n s/...//p`, which succeeds whether or not anything matched.
 *    Without pipefail a journalctl failure exits 0, so anything on stderr
 *    means the list is not to be trusted (spec 7.3 notes).
 *
 * The journalctl arguments reach the shell positionally ("$@"), never
 * interpolated into the script.
 */
import { classifyExit, journalArgs, JOURNAL_SPAWN, type Capabilities, type JournalFilter } from "../../lib/journal.js";
import { streamLines } from "../../tui/hooks.js";
import { sortNames } from "./model.js";

/** Run the pipeline in the background so a TERM can reach it, and stop all of it then (see above). */
const WRAP = (pipeline: string) => `trap 'kill $! 2>/dev/null; pkill -P $$ 2>/dev/null; exit 143' TERM\n${pipeline} &\nwait $!`;

/** systemd 246 and later: one identifier per line, entries without one skipped. */
export const SCAN_SCRIPT = WRAP('journalctl "$@" | sort -u');

/** Older systemd: pick the field out of the verbose output. */
export const SCAN_SCRIPT_VERBOSE = WRAP('journalctl "$@" | sed -n "s/^    SYSLOG_IDENTIFIER=//p" | sort -u');

/** The argv of the scan for a filter. */
export function identifierScanArgv(filter: JournalFilter, caps: Pick<Capabilities, "outputFields">): string[] {
    const args = journalArgs({ ...filter, identifier: undefined }, { kind: "page", lines: 1 })
        .slice(1) // "journalctl" is in the script
        .filter(arg => !arg.startsWith("--lines=") && arg !== "--reverse" && arg !== "--output=json");
    const separator = args.indexOf("--");
    const options = separator >= 0 ? args.slice(0, separator) : args;
    const matches = separator >= 0 ? args.slice(separator + 1) : [];
    return caps.outputFields
        ? ["/bin/sh", "-c", SCAN_SCRIPT, "--", ...options, "--no-tail", "--output=cat", "--output-fields=SYSLOG_IDENTIFIER", "--", ...matches]
        : ["/bin/sh", "-c", SCAN_SCRIPT_VERBOSE, "--", ...options, "--no-tail", "--output=verbose", "--", ...matches];
}

export interface ScanResult {
    /** Sorted case-insensitively; raw host text. */
    readonly names: string[];
    /** Why the list is missing or incomplete; raw host text. */
    readonly error: string | null;
}

export interface IdentifierScan {
    /** Stop the scan (and the journalctl under it). No result is delivered afterwards. */
    close(): void;
}

/** Start a scan; `onDone` gets the result once, unless closed first. */
export function scanIdentifiers(
    filter: JournalFilter,
    caps: Pick<Capabilities, "outputFields">,
    host: string,
    onDone: (result: ScanResult) => void,
): IdentifierScan {
    const names = new Set<string>();
    return streamLines(identifierScanArgv(filter, caps), JOURNAL_SPAWN, lines => {
        for (const line of lines) {
            const name = line.trim();
            if (name)
                names.add(name);
        }
    }, (error, stderr) => {
        const found = sortNames(names);
        if (!error) {
            onDone({ names: found, error: stderr.trim() || null });
        } else if ((error as { problem?: unknown }).problem === "not-found") {
            // classifyExit() would blame journalctl; what is missing is the shell.
            onDone({ names: found, error: `/bin/sh is not available on ${host}` });
        } else {
            const outcome = classifyExit(error, "", host);
            onDone({ names: found, error: outcome.kind === "error" ? outcome.message : null });
        }
    });
}
