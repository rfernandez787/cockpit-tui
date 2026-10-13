/*
 * Services: systemd units -- the list, one unit's details, and the actions.
 * Upstream: pkg/systemd/services.jsx and friends (cockpit 356).
 *
 * The page holds one systemd client at a time, for the owner shown: the
 * system manager (superuser "try", so privileged once administrative access
 * is on) or the user's own manager on the session bus. The shell remounts
 * the page when access changes, which reopens the client at the new level;
 * what the user was looking at -- owner, tab, filters, selection, the open
 * unit -- lives in persistent state and survives that.
 *
 * Other pages can send the user here with navigation.go("services", params):
 *
 *   { unit: "sshd.service" }        that unit's details (user: true for a user unit)
 *   { filter: "failed" }            the failed units
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import cockpit from "../../cockpit.js";
import type { PageProps } from "../../tui/page.js";
import { Notice } from "../../tui/components/misc.js";
import { Panel, PANEL_EDGE, panelled } from "../../tui/components/Panel.js";
import { AreaProvider } from "../../tui/components/Dialog.js";
import { callOnce } from "../../tui/hooks.js";
import { usePageParams } from "../../tui/navigation.js";
import { usePersistentState } from "../../tui/session-context.js";
import { useStatus } from "../../tui/status.js";
import { failedByType, NO_FILTER, unitType, UNIT_TYPES, type Owner, type StateFilter, type UnitType } from "./model.js";
import { MANAGER, MANAGER_PATH, PROPERTIES, SYSTEMD, UnitStore } from "./store.js";
import { UnitList } from "./list.js";
import { DetailsView } from "./details.js";

export interface ServicesParams {
    /** Open this unit's details. */
    readonly unit?: string;
    /** The unit (or the list) is the user's own, not the system's. */
    readonly user?: boolean;
    /** Show only the failed units. */
    readonly filter?: "failed";
}

type View = { readonly kind: "list" } | { readonly kind: "details", readonly id: string };

const LIST: View = { kind: "list" };

const noSubscribe = () => () => {};
const noVersion = () => 0;

/**
 * The owner's store, for as long as the owner stays the same (null until
 * known). A new `attempt` replaces it: the way back from a closed channel.
 */
function useUnitStore(owner: Owner | null, attempt: number): UnitStore | null {
    const [store, setStore] = useState<UnitStore | null>(null);
    useEffect(() => {
        if (!owner)
            return;
        const next = new UnitStore(owner);
        next.start();
        setStore(next);
        return () => {
            next.close();
            setStore(previous => (previous === next ? null : previous));
        };
    }, [owner, attempt]);
    useSyncExternalStore(store ? store.subscribe : noSubscribe, store ? store.getVersion : noVersion);
    return store && store.owner === owner && !store.closed ? store : null;
}

/**
 * Whether the user's own systemd answers on the session bus: no session bus
 * (an ssh login without a user session), or no systemd --user, means no
 * owner toggle. Root has no "user units" view, as upstream.
 */
function useSessionBus(skip: boolean): boolean | null {
    const [state, setState] = useState<boolean | null>(skip ? false : null);
    useEffect(() => {
        if (skip) {
            setState(false);
            return;
        }
        let live = true;
        callOnce(SYSTEMD, { bus: "session" }, MANAGER_PATH, PROPERTIES, "Get", [MANAGER, "Version"], { type: "ss" })
            .then(() => { if (live) setState(true) }, () => { if (live) setState(false) });
        return () => { live = false };
    }, [skip]);
    return state;
}

function isParams(value: unknown): value is ServicesParams {
    return !!value && typeof value === "object";
}

export default function ServicesPage({ width, height }: PageProps) {
    const params = usePageParams<ServicesParams>("services");
    const { notify } = useStatus();
    const [owner, setOwner] = usePersistentState<Owner>("services:owner", "system");
    const [tab, setTab] = usePersistentState<UnitType>("services:tab", "service");
    const [text, setText] = usePersistentState("services:text", "");
    const [filter, setFilter] = usePersistentState<StateFilter>("services:filter", NO_FILTER);
    const [view, setView] = usePersistentState<View>("services:view", LIST);
    const [selection, setSelection] = usePersistentState<Readonly<Record<string, string>>>("services:selection", {});
    const [relationships, setRelationships] = usePersistentState("services:relationships", false);

    // Params from another page win over what was left here last time. They
    // are applied before the store opens, so no client is opened for nothing.
    // Without `user` they are about the system's units (Overview counts the
    // system's failed units), whichever owner was shown here last.
    const [ready, setReady] = useState(params === null);
    useEffect(() => {
        if (!isParams(params))
            return;
        const nextOwner: Owner = params.user === true ? "user" : "system";
        const name = typeof params.unit === "string" ? params.unit.trim() : "";
        setOwner(nextOwner);
        if (name) {
            // A bare name means a service, as for systemctl.
            const unit = name.includes(".") ? name : `${name}.service`;
            const type = unitType(unit);
            if (type)
                setTab(type);
            setSelection(previous => (type ? { ...previous, [`${nextOwner}:${type}`]: unit } : previous));
            setView({ kind: "details", id: unit });
            // A search or filter left from an earlier visit could hide this
            // unit from the list Esc goes back to.
            setText("");
            setFilter(NO_FILTER);
        } else {
            setView(LIST);
        }
        if (params.filter === "failed") {
            setText("");
            setFilter({ ...NO_FILTER, failedOnly: true });
        }
        setReady(true);
        // Params are read once, at mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const isRoot = cockpit.info?.user?.uid === 0;
    const sessionBus = useSessionBus(isRoot);
    const [attempt, setAttempt] = useState(0);
    const store = useUnitStore(ready ? owner : null, attempt);

    // Sent here for the failed units: once the list is in, show a tab that
    // has some, if the current one has none.
    const [seekFailed, setSeekFailed] = useState(isParams(params) && params.filter === "failed");
    const storeReady = store?.status === "ready";
    useEffect(() => {
        if (!seekFailed || !store || !storeReady)
            return;
        setSeekFailed(false);
        const failed = failedByType(store.units.values());
        if (!failed.get(tab)) {
            const first = UNIT_TYPES.find(type => (failed.get(type) ?? 0) > 0);
            if (first)
                setTab(first);
        }
    }, [seekFailed, store, storeReady, tab, setTab]);

    const selectionKey = `${owner}:${tab}`;
    const onSelection = useCallback((listOwner: Owner, listTab: UnitType, id: string) => {
        const key = `${listOwner}:${listTab}`;
        setSelection(previous => (previous[key] === id ? previous : { ...previous, [key]: id }));
    }, [setSelection]);

    const onOwner = useCallback(() => {
        if (owner === "system" && sessionBus !== true) {
            notify(isRoot
                ? "There are no user units to show for root"
                : sessionBus === null ? "Still checking for your user session" : "Your user session's systemd is not reachable",
                "warning");
            return;
        }
        setView(LIST);
        setOwner(owner === "system" ? "user" : "system");
    }, [owner, sessionBus, isRoot, notify, setOwner, setView]);

    if (!store) {
        return <Notice width={width} height={height} loading>Connecting to systemd</Notice>;
    }

    if (view.kind === "details") {
        // One panel around the details; its dialogs centre in what is inside.
        const boxed = panelled(width, height);
        const area = boxed ? { width: width - PANEL_EDGE, height: height - PANEL_EDGE } : { width, height };
        return (
            <Panel plain={!boxed} title="Unit" width={width} height={height}>
            <AreaProvider area={area}>
            <DetailsView
                key={`${owner}:${view.id}`}
                store={store}
                owner={owner}
                id={view.id}
                width={area.width}
                height={area.height}
                showRelationships={relationships}
                onToggleRelationships={() => setRelationships(shown => !shown)}
                onBack={() => {
                    const type = unitType(view.id);
                    if (type && UNIT_TYPES.includes(type)) {
                        setTab(type);
                        setSelection(previous => ({ ...previous, [`${owner}:${type}`]: view.id }));
                    }
                    setView(LIST);
                }}
            />
            </AreaProvider>
            </Panel>
        );
    }

    return (
        <UnitList
            key={`${owner}:${tab}`}
            store={store}
            owner={owner}
            tab={tab}
            text={text}
            filter={filter}
            initialSelection={selection[selectionKey] ?? null}
            canSwitchOwner={sessionBus === true}
            width={width}
            height={height}
            onTab={setTab}
            onText={setText}
            onFilter={setFilter}
            onSelection={onSelection}
            onOpen={id => setView({ kind: "details", id })}
            onOwner={onOwner}
            onReconnect={() => setAttempt(n => n + 1)}
        />
    );
}
