/*
 * Words for how a shell session ended, and for sizes.
 *
 * A pty channel's close comes in two shapes (spec G7). The bridge reports a
 * finished process as {"exit-status": N, "message": ""}, with N negative for
 * a signal death (-9 is SIGKILL) and null when it tore down a process it
 * never reaped; a failure to start is {"problem", "message"?}. When the
 * client closes the channel itself, channel.js fires its close event locally
 * with neither, so who closed it has to be remembered by the caller.
 *
 * The transport fails every open channel with "disconnected" or "terminated"
 * when the connection goes: that is the connection ending, not the shell.
 * (It fails them with its own problem -- "timeout", "protocol-error" -- when
 * the connection breaks; the store tells those apart, since only it can ask
 * the transport.) A problem close after the shell was running is not a
 * failure to start either: the bridge tore down a live session.
 */

export type Ending =
    | { readonly kind: "exited", readonly status: number }
    | { readonly kind: "signal", readonly signal: string }
    | { readonly kind: "failed", readonly problem: string, readonly message: string }
    /** The bridge closed a shell that had been running, with a problem. */
    | { readonly kind: "aborted", readonly problem: string, readonly message: string }
    | { readonly kind: "killed" }
    | { readonly kind: "lost", readonly problem: string, readonly message: string }
    | { readonly kind: "ended" };

const CONNECTION_PROBLEMS = new Set(["disconnected", "terminated"]);

/** Linux signal numbers (the generic table, as on x86, arm and s390x). */
const SIGNALS = [
    "", "HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "BUS", "FPE", "KILL", "USR1", "SEGV", "USR2",
    "PIPE", "ALRM", "TERM", "STKFLT", "CHLD", "CONT", "STOP", "TSTP", "TTIN", "TTOU", "URG", "XCPU",
    "XFSZ", "VTALRM", "PROF", "WINCH", "IO", "PWR", "SYS",
];

export function signalName(signal: number): string {
    const name = SIGNALS[signal];
    return name ? `SIG${name}` : `signal ${signal}`;
}

/** Map a pty channel's close message to how the session ended. */
export function endingFromClose(message: Record<string, unknown>, closedByUs: boolean): Ending {
    if (closedByUs)
        return { kind: "killed" };
    const problem = typeof message.problem === "string" ? message.problem : "";
    const text = typeof message.message === "string" ? message.message : "";
    if (problem) {
        return CONNECTION_PROBLEMS.has(problem)
            ? { kind: "lost", problem, message: text }
            : { kind: "failed", problem, message: text };
    }
    const status = message["exit-status"];
    if (typeof status === "number" && Number.isInteger(status))
        return status < 0 ? { kind: "signal", signal: signalName(-status) } : { kind: "exited", status };
    // The legacy C bridge named the signal instead.
    const signal = message["exit-signal"];
    if (typeof signal === "string" && signal)
        return { kind: "signal", signal: signal.startsWith("SIG") ? signal : `SIG${signal}` };
    return { kind: "ended" };
}

function problemText(problem: string, message: string, shell: string | null, directory: string | null): string {
    switch (problem) {
    case "not-found":
        return `not found: ${shell ?? "the shell"}${directory ? ` or ${directory}` : ""} does not exist`;
    case "access-denied":
        return `permission denied for ${shell ?? "the shell"}${directory ? ` or ${directory}` : ""}`;
    case "timeout":
        return message || "it did not start in time";
    default:
        return message || problem;
    }
}

/** One line for the page: "Exited with status 7", "Killed by SIGKILL", ... (raw: clean() before display). */
export function describeEnding(ending: Ending, shell: string | null = null, directory: string | null = null): string {
    switch (ending.kind) {
    case "exited":
        return ending.status === 0 ? "Exited" : `Exited with status ${ending.status}`;
    case "signal":
        return `Killed by ${ending.signal}`;
    case "failed":
        return `Could not start: ${problemText(ending.problem, ending.message, shell, directory)}`;
    case "aborted":
        return `Ended: ${ending.message || ending.problem}`;
    case "killed":
        return "Closed from cockpit-tui";
    case "lost":
        return `Connection lost${ending.message ? `: ${ending.message}` : ""}`;
    case "ended":
        return "Ended";
    }
}

/** Is this ending a problem (shown in red), rather than a normal exit? */
export function isFailure(ending: Ending): boolean {
    switch (ending.kind) {
    case "exited":
        return ending.status !== 0;
    case "signal":
    case "failed":
    case "aborted":
    case "lost":
        return true;
    default:
        return false;
    }
}

/**
 * Bidirectional formatting characters (ALM, LRM, RLM, the embeddings and
 * overrides, the isolates). On terminals that implement bidi (VTE, Konsole,
 * mlterm) they reorder the rest of the line, which can disguise what it says.
 */
// eslint-disable-next-line no-misleading-character-class
export const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Host text with its bidi controls blanked; clean() it as usual afterwards. */
export function noBidi(text: string): string {
    return text.replace(BIDI_CONTROLS, " ");
}
