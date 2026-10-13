/*
 * Administrative access, as React state.
 *
 * Which bridge a channel reaches is decided when it opens (bridge 356,
 * superuser.py apply_rule):
 *
 *   - escalating leaves every open channel on the unprivileged bridge;
 *   - while escalation is in progress ("init"), new superuser channels queue
 *     on the privileged peer that is still starting, and are closed if it
 *     fails;
 *   - dropping privileges closes every privileged channel with problem
 *     "terminated" before Current changes.
 *
 * So the shell unmounts the page while access is changing (`transitioning`)
 * and remounts it once access has settled. `generation` changes on every
 * settled change; the shell keys the page on it, which is the TUI's version
 * of upstream's reload_page_on_change().
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Superuser } from "../superuser.js";
import { useStatus } from "./status.js";

export interface Privilege {
    /** Null when the bridge offers no cockpit.Superuser object at all. */
    readonly superuser: Superuser | null;
    /** "none", "init" while escalating, "root", or the active method. */
    readonly current: string;
    /** True if privileged, false if not, null while changing. */
    readonly allowed: boolean | null;
    /** Whether any way to escalate exists; null while changing. */
    readonly configured: boolean | null;
    /** The bridge itself runs as root; there is nothing to escalate. */
    readonly isRoot: boolean;
    /** Escalation methods on offer, e.g. ["sudo"]. Empty: escalation unavailable. */
    readonly bridges: readonly string[];
    readonly methods: Readonly<Record<string, string>>;
    /** Changes whenever privilege settles into a different state. */
    readonly generation: number;
    /** Access is changing: pages must not hold channels now. */
    readonly transitioning: boolean;
    /**
     * Mark a change we are about to make (dropping privileges), so the page is
     * gone before the bridge starts closing its channels. Cleared again once
     * privilege settles, or explicitly with false.
     */
    readonly setSettling: (settling: boolean) => void;
}

const PrivilegeContext = createContext<Privilege | null>(null);

interface State {
    /** The last settled `allowed`. */
    settled: boolean;
    generation: number;
    current: string;
    allowed: boolean | null;
    configured: boolean | null;
    isRoot: boolean;
    bridges: readonly string[];
    methods: Readonly<Record<string, string>>;
}

function read(superuser: Superuser | null, previous: Pick<State, "settled" | "generation">): State {
    if (!superuser) {
        return {
            ...previous, current: "none", allowed: false, configured: false, isRoot: false,
            bridges: [], methods: {},
        };
    }
    const allowed = superuser.allowed;
    let { settled, generation } = previous;
    // Transitions through null ("init") do not count: only a settled change
    // of privilege moves channels between bridges.
    if (allowed !== null && allowed !== settled) {
        settled = allowed;
        generation += 1;
    }
    return {
        settled, generation,
        current: superuser.current,
        allowed,
        configured: superuser.configured,
        isRoot: superuser.isRoot,
        bridges: [...superuser.bridges],
        methods: { ...superuser.methods },
    };
}

export function PrivilegeProvider({ superuser, children }: { superuser: Superuser | null, children: ReactNode }) {
    const { notify } = useStatus();
    const [state, setState] = useState<State>(() =>
        read(superuser, { settled: superuser?.allowed ?? false, generation: 0 }));
    const stateRef = useRef(state);
    const [settling, setSettlingState] = useState(false);
    const settlingRef = useRef(false);

    const setSettling = useCallback((value: boolean) => {
        settlingRef.current = value;
        setSettlingState(value);
    }, []);

    useEffect(() => {
        if (!superuser)
            return;
        // Runs from the proxy's "changed" event, never during a render, so it
        // may update other components (the status line) directly.
        const update = () => {
            const previous = stateRef.current;
            const next = read(superuser, previous);
            stateRef.current = next;
            if (next.generation !== previous.generation) {
                if (settlingRef.current) {
                    // Settled: the change we announced has happened.
                    settlingRef.current = false;
                    setSettlingState(false);
                } else if (previous.settled && !next.settled) {
                    // Privileges went away without us asking: the privileged
                    // bridge died, or the config providing it was removed.
                    notify("Administrative access ended", "warning");
                }
            }
            setState(next);
        };
        update();
        return superuser.onChanged(update);
    }, [superuser, notify]);

    const value = useMemo<Privilege>(() => ({
        superuser,
        current: state.current,
        allowed: state.allowed,
        configured: state.configured,
        isRoot: state.isRoot,
        bridges: state.bridges,
        methods: state.methods,
        generation: state.generation,
        transitioning: settling || state.current === "init",
        setSettling,
    }), [superuser, state, settling, setSettling]);

    return <PrivilegeContext.Provider value={value}>{children}</PrivilegeContext.Provider>;
}

export function usePrivilege(): Privilege {
    const privilege = useContext(PrivilegeContext);
    if (!privilege)
        throw new Error("usePrivilege() used outside <PrivilegeProvider>");
    return privilege;
}

/** A fixed privilege state, for tests and for pages rendered in isolation. */
export function StaticPrivilege({ allowed = false, children }: { allowed?: boolean, children: ReactNode }) {
    const value = useMemo<Privilege>(() => ({
        superuser: null, current: allowed ? "sudo" : "none", allowed, configured: true, isRoot: false,
        bridges: ["sudo"], methods: {}, generation: 0, transitioning: false, setSettling: () => {},
    }), [allowed]);
    return <PrivilegeContext.Provider value={value}>{children}</PrivilegeContext.Provider>;
}
