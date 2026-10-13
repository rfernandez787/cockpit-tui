/*
 * Privilege escalation.
 *
 * Cockpit offers two routes to root. The one used at init time hands a single
 * cached password to sudo and reports only success or failure; a wrong password
 * ends the attempt. This module uses the other one -- the `cockpit.Superuser`
 * object on the bridge's internal D-Bus -- which surfaces the real prompt text,
 * distinguishes sudo's lecture from a retry, and allows several attempts.
 *
 * It works identically across all three transports: the internal bus lives in
 * the bridge itself, and cockpit-ws is a transparent relay for channel payloads.
 *
 * What changes when privilege does (bridge 356, superuser.py / router.py):
 * escalating leaves every open channel where it was, on the unprivileged
 * bridge; dropping privileges closes every channel on the privileged peer with
 * problem "terminated", before Stop returns. The only notification either way
 * is the `Current` property, so callers reopen their channels on a settled
 * change (see src/tui/privilege.tsx).
 */
import cockpit from "./cockpit.js";

/** One challenge from sudo or polkit, relayed through the bridge. */
export interface SuperuserPrompt {
    /** Always empty from bridge 356; kept for older bridges. */
    message: string;
    /** The actual question, e.g. "Password for alice: ". Empty from polkit. */
    prompt: string;
    /** Pre-filled answer; always empty from bridge 356. */
    default: string;
    /**
     * True only for a yes/no confirmation. False -- the common case -- means
     * the answer is a secret and must not be echoed as it is typed.
     */
    echo: boolean;
    /**
     * sudo's stderr since the last prompt: the (multi-line) lecture on first
     * use, "Sorry, try again." after a wrong password. Trailing whitespace
     * trimmed, inner line breaks kept.
     */
    error: string;
    /** 0 for the first prompt of this attempt, then 1, 2, ... */
    attempt: number;
}

/**
 * Answer the prompt, or return null to cancel the escalation. The signal
 * aborts if escalation ends (fails, or is stopped elsewhere) while the
 * prompt is still waiting for an answer.
 */
export type PromptResponder = (prompt: SuperuserPrompt, signal: AbortSignal) => Promise<string | null>;

interface Variant<T = unknown> { t: string, v: T }

interface SuperuserDBusProxy {
    valid: boolean;
    Current?: string;
    Bridges?: string[];
    Methods?: Record<string, Variant<Record<string, Variant<string>>>>;
    wait(): Promise<void>;
    Start(method: string): Promise<void>;
    Stop(): Promise<void>;
    Answer(value: string): Promise<void>;
    addEventListener(event: string, handler: (...args: never[]) => void): void;
    removeEventListener(event: string, handler: (...args: never[]) => void): void;
}

/** The D-Bus error name the bridge uses when Stop() interrupts a Start(). */
const CANCELLED = "cockpit.Superuser.Error.Cancelled";

export class EscalationCancelled extends Error {
    constructor() {
        super("escalation cancelled");
        this.name = "EscalationCancelled";
    }
}

export class Superuser {
    #proxy: SuperuserDBusProxy;
    #listeners = new Set<() => void>();

    private constructor(proxy: SuperuserDBusProxy) {
        this.#proxy = proxy;
        proxy.addEventListener("changed", (() => {
            for (const listener of [...this.#listeners]) listener();
        }) as never);
    }

    /**
     * Rejects on a bridge without the cockpit.Superuser object (proxy never
     * valid), so callers can treat that as "administrative access is not
     * supported" rather than "changing" forever.
     */
    static async open(): Promise<Superuser> {
        // The shared internal-bus client: cached by the library, and a bare
        // close() on it is a no-op, so it is never ours to close.
        const client = cockpit.dbus(null, { bus: "internal" });
        const proxy = client.proxy("cockpit.Superuser", "/superuser") as unknown as SuperuserDBusProxy;
        await proxy.wait();
        if (!proxy.valid)
            throw new Error("the bridge has no cockpit.Superuser object");
        return new Superuser(proxy);
    }

    /**
     * "none" (unprivileged), "init" (escalating), "root" (the bridge is already
     * root, so there is nothing to do), or the name of the active bridge config.
     */
    get current(): string {
        return this.#proxy.Current ?? "none";
    }

    /** True if privileged, false if not, null while still initialising. */
    get allowed(): boolean | null {
        if (!this.#proxy.valid || this.current === "init")
            return null;
        return this.current !== "none";
    }

    /** Whether any escalation method exists; null while escalating. */
    get configured(): boolean | null {
        if (this.current === "init")
            return null;
        return this.bridges.length > 0;
    }

    /** True when the bridge is running as root and escalation is moot. */
    get isRoot(): boolean {
        return this.current === "root";
    }

    /** Names of the valid escalation configs, in priority order, e.g. ["sudo", "pkexec"]. */
    get bridges(): string[] {
        return this.#proxy.Bridges ?? [];
    }

    /**
     * Labelled escalation configs: label (which is also the name to Start) to
     * display label. Only configs with a manifest label appear, so this is
     * usually empty; see chooseMethod().
     */
    get methods(): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [name, variant] of Object.entries(this.#proxy.Methods ?? {}))
            out[name] = variant?.v?.label?.v ?? name;
        return out;
    }

    /**
     * Which method to Start, by upstream's rule (superuser-dialogs.tsx): a
     * single labelled method, else the first bridge. Returns null when the
     * user must pick, i.e. two or more labelled methods (see methodChoices()).
     */
    chooseMethod(): string | null {
        const labelled = Object.keys(this.methods);
        if (labelled.length >= 2)
            return null;
        if (labelled.length === 1)
            return labelled[0]!;
        return this.bridges[0] ?? null;
    }

    /** The picker's entries when chooseMethod() returns null: [name, label]. */
    methodChoices(): [string, string][] {
        return Object.entries(this.methods);
    }

    onChanged(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /**
     * Escalate, answering prompts through the callback.
     *
     * `method` defaults to chooseMethod(). Resolves once privileged (or at once
     * if already privileged); rejects with EscalationCancelled if the responder
     * returns null or stop() interrupts, otherwise with the polished error.
     */
    async start(responder: PromptResponder, method?: string): Promise<void> {
        if (this.allowed === true)
            return; // root, or already escalated: Start would only fail "already running"

        // A previous attempt that never finished leaves Current at "init" and
        // Start refusing; upstream's dialog clears that the same way.
        if (this.current === "init")
            await this.#proxy.Stop().catch(() => {});

        if (this.bridges.length === 0)
            throw new Error("no way to gain administrative access is configured on this host");
        const name = method ?? this.chooseMethod();
        if (!name)
            throw new Error("choose an escalation method: " + this.methodChoices().map(([, label]) => label).join(", "));

        let cancelled = false;
        let attempt = 0;
        const controller = new AbortController();

        const cancel = async () => {
            cancelled = true;
            await this.#proxy.Stop().catch(() => {});
        };

        const onPrompt = (
            _event: unknown, message: string, prompt: string, def: string, echo: boolean, error: string,
        ) => {
            const request: SuperuserPrompt = {
                message: polish(message),
                prompt: polish(prompt),
                default: def ?? "",
                echo: Boolean(echo),
                error: polish(error).trimEnd(),
                attempt: attempt++,
            };
            void (async () => {
                let answer: string | null;
                try {
                    answer = await responder(request, controller.signal);
                } catch {
                    // Never leave sudo waiting on an answer nobody will give.
                    answer = null;
                }
                if (controller.signal.aborted)
                    return;
                if (answer === null) {
                    await cancel();
                    return;
                }
                await this.#proxy.Answer(answer).catch(() => {});
            })();
        };

        this.#proxy.addEventListener("Prompt", onPrompt as never);
        try {
            await this.#proxy.Start(name);
        } catch (error) {
            const e = error as { name?: string, message?: string };
            if (cancelled || e.name === CANCELLED)
                throw new EscalationCancelled();
            throw new Error(polish(e.message ?? String(error)).trimEnd());
        } finally {
            controller.abort();
            this.#proxy.removeEventListener("Prompt", onPrompt as never);
        }
    }

    /**
     * Drop privileges (or abandon an escalation in progress).
     *
     * Every channel routed through the root bridge is closed with problem
     * "terminated" as a side effect, before this resolves.
     */
    async stop(): Promise<void> {
        await this.#proxy.Stop();
    }
}

/**
 * Tidy sudo's text for display, matching upstream's `sudo_polish`.
 *
 * Drops the "[sudo] " / "[sudo: authenticate] " prefix, which is noise once the
 * text is presented as a labelled prompt, and capitalises the result. Trailing
 * whitespace is deliberately preserved here: sudo's prompts end in a space, and
 * how to render that is the UI layer's decision, not this module's.
 */
function polish(text: string | undefined): string {
    if (!text)
        return "";
    const stripped = text.replace(/^\[sudo(: authenticate)?] /, "");
    return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}
