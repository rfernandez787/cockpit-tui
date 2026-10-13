/*
 * Moving between pages from inside one: "view this unit's logs" on Services,
 * "go to unit" on a journal entry.
 *
 * go(page, params) switches pages and leaves `params` for the target, which
 * picks them up once with usePageParams() when it mounts. Every go() remounts
 * the target, even if it is already showing, so the params always apply.
 */
import { createContext, useContext, useState, type ReactNode } from "react";
import { usePersistentStore } from "./session-context.js";

export interface Navigation {
    /** Switch to the page with this id, handing it `params`. */
    go(pageId: string, params?: object): void;
}

const NavigationContext = createContext<Navigation>({ go: () => {} });

export function NavigationProvider({ value, children }: { value: Navigation, children: ReactNode }) {
    return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): Navigation {
    return useContext(NavigationContext);
}

export function paramsKey(pageId: string): string {
    return `params:${pageId}`;
}

/**
 * The params another page passed to this one with go(), or null. Read once
 * at mount and then cleared, so returning to the page later starts clean.
 */
export function usePageParams<T extends object>(pageId: string): T | null {
    const store = usePersistentStore();
    const [params] = useState<T | null>(() => {
        const key = paramsKey(pageId);
        const value = (store?.get(key) as T | undefined) ?? null;
        store?.delete(key);
        return value;
    });
    return params;
}
