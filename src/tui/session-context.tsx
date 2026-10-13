/*
 * App-wide context: the live session, and state that outlives a page.
 *
 * Pages unmount when you leave them and remount when privilege changes, which
 * closes their channels -- exactly what should happen to channels, and
 * exactly what should not happen to a search filter or a selected row.
 * usePersistentState keeps such values in a store owned by the shell.
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type { Session } from "../session.js";

export interface SessionInfo {
    readonly session: Session | null;
    /** The managed host's name, once known; the connection target until then. */
    readonly hostname: string;
}

const SessionContext = createContext<SessionInfo>({ session: null, hostname: "localhost" });

export function SessionProvider({ value, children }: { value: SessionInfo, children: ReactNode }) {
    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionInfo {
    return useContext(SessionContext);
}

type Store = Map<string, unknown>;

const StoreContext = createContext<Store | null>(null);

export function PersistentStateProvider({ children }: { children: ReactNode }) {
    const store = useRef<Store>(new Map());
    return <StoreContext.Provider value={store.current}>{children}</StoreContext.Provider>;
}

/** The raw store, for the shell's own bookkeeping (navigation params). */
export function usePersistentStore(): Map<string, unknown> | null {
    return useContext(StoreContext);
}

/**
 * useState whose value survives the component unmounting, keyed globally.
 * Use a "page:thing" key. Outside a provider it degrades to plain useState.
 */
export function usePersistentState<T>(key: string, initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] {
    const store = useContext(StoreContext);
    const [value, setValue] = useState<T>(() => {
        if (store?.has(key))
            return store.get(key) as T;
        const value = typeof initial === "function" ? (initial as () => T)() : initial;
        store?.set(key, value);
        return value;
    });
    // The latest value, for updaters. It tracks writes as they happen, not
    // renders, so two updates in a row compose.
    const latest = useRef(value);

    // The store is written here, not inside a setState updater: React drops
    // the update of a component that is unmounting -- e.g. a value saved by
    // the very render that leaves the page -- and the write would be lost.
    const set = useCallback((next: T | ((previous: T) => T)) => {
        const previous = store?.has(key) ? store.get(key) as T : latest.current;
        const value = typeof next === "function" ? (next as (previous: T) => T)(previous) : next;
        latest.current = value;
        store?.set(key, value);
        setValue(value);
    }, [store, key]);

    return [value, set];
}
