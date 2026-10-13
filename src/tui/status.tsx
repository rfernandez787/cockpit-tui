/*
 * Transient status messages for the footer: "Started sshd.service",
 * "Permission denied", and so on. One message at a time; a newer one
 * replaces the old. Errors linger longer than confirmations.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Severity } from "./theme.js";

export interface StatusMessage {
    readonly id: number;
    readonly text: string;
    readonly severity: Severity;
}

interface StatusApi {
    notify(text: string, severity?: Severity, timeoutMs?: number): void;
    clear(): void;
}

const StatusApiContext = createContext<StatusApi | null>(null);
const StatusMessageContext = createContext<StatusMessage | null>(null);

const DEFAULT_TIMEOUT: Record<Severity, number> = {
    info: 5000,
    success: 5000,
    warning: 8000,
    error: 12000,
};

let nextId = 1;

export function StatusProvider({ children }: { children: ReactNode }) {
    const [message, setMessage] = useState<StatusMessage | null>(null);
    const timer = useRef<NodeJS.Timeout | null>(null);

    const clearTimer = () => {
        if (timer.current) {
            clearTimeout(timer.current);
            timer.current = null;
        }
    };

    useEffect(() => clearTimer, []);

    const notify = useCallback((text: string, severity: Severity = "info", timeoutMs?: number) => {
        clearTimer();
        const next = { id: nextId++, text, severity };
        setMessage(next);
        timer.current = setTimeout(() => {
            timer.current = null;
            setMessage(current => (current?.id === next.id ? null : current));
        }, timeoutMs ?? DEFAULT_TIMEOUT[severity]);
        timer.current.unref?.();
    }, []);

    const clear = useCallback(() => {
        clearTimer();
        setMessage(null);
    }, []);

    const api = useMemo(() => ({ notify, clear }), [notify, clear]);

    return (
        <StatusApiContext.Provider value={api}>
            <StatusMessageContext.Provider value={message}>
                {children}
            </StatusMessageContext.Provider>
        </StatusApiContext.Provider>
    );
}

/** Post messages to the footer. */
export function useStatus(): StatusApi {
    const api = useContext(StatusApiContext);
    if (!api)
        throw new Error("useStatus() used outside <StatusProvider>");
    return api;
}

/** The message currently shown, for the footer. */
export function useStatusMessage(): StatusMessage | null {
    return useContext(StatusMessageContext);
}

/**
 * Best-effort human text for whatever a cockpit call rejected with. Never
 * empty. Not cleaned: run it through text.ts clean() before display.
 */
export function errorText(error: unknown): string {
    if (error === null || error === undefined)
        return "unknown error";
    if (typeof error === "string")
        return error || "unknown error";
    const e = error as { message?: unknown, problem?: unknown, name?: unknown, exit_status?: unknown, exit_signal?: unknown };
    if (typeof e.message === "string" && e.message.trim())
        return e.message.trim();
    if (typeof e.problem === "string" && e.problem)
        return e.problem;
    // A ProcessError with no stderr. The Python bridge reports a signal
    // death as a negative exit status.
    if (typeof e.exit_signal === "string" || typeof e.exit_signal === "number")
        return `killed by signal ${e.exit_signal}`;
    if (typeof e.exit_status === "number")
        return e.exit_status < 0 ? `killed by signal ${-e.exit_status}` : `exited with status ${e.exit_status}`;
    if (typeof e.name === "string" && e.name)
        return e.name;
    const text = String(error);
    return text && text !== "[object Object]" ? text : "unknown error";
}
