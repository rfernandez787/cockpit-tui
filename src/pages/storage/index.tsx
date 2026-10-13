/*
 * Storage: the host's drives, partitions, encrypted devices, LVM2 volumes,
 * filesystems and swap, from UDisks2 -- the device tree, one device's
 * details, and the everyday actions on what is already there.
 * Upstream: pkg/storaged (cockpit 356), the cockpit-storaged package.
 *
 * Covered: mount and unmount (with the fstab line upstream keeps), unlock
 * and lock, swap on and off, format. Not covered: creating or deleting
 * partitions and partition tables, creating, growing or removing LVM2, MDRAID
 * and Stratis devices, NFS mounts, iSCSI, VDO, Btrfs subvolumes, key slots
 * and Tang, SMART self-tests. actions.ts says where a covered action does
 * less than upstream's.
 *
 * The page holds one UDisks2 client (superuser "try", so privileged once
 * administrative access is on); the shell remounts the page when access
 * changes, which reopens it. Changing anything needs administrative access:
 * without it the action keys say so instead of failing halfway.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { PageProps } from "../../tui/page.js";
import { useKeys } from "../../tui/keyboard.js";
import { Notice } from "../../tui/components/misc.js";
import { usePrivilege } from "../../tui/privilege.js";
import { usePersistentState } from "../../tui/session-context.js";
import { useStatus } from "../../tui/status.js";
import { colors, glyphs } from "../../tui/theme.js";
import { clean } from "../../lib/hosttext.js";
import { buildRows, type ActionId, type ActionInfo, type Row } from "./model.js";
import { StorageStore } from "./store.js";
import { DeviceDetails, DeviceList } from "./views.js";
import { ActionDialog } from "./dialogs.js";

type View = { readonly kind: "list" } | { readonly kind: "details", readonly id: string };

const LIST: View = { kind: "list" };

const noSubscribe = () => () => {};
const noVersion = () => 0;

/** The page's store; a new `attempt` replaces it (the way back from a closed channel). */
function useStorageStore(attempt: number): StorageStore | null {
    const [store, setStore] = useState<StorageStore | null>(null);
    useEffect(() => {
        const next = new StorageStore();
        next.start();
        setStore(next);
        return () => {
            next.close();
            setStore(previous => (previous === next ? null : previous));
        };
    }, [attempt]);
    useSyncExternalStore(store ? store.subscribe : noSubscribe, store ? store.getVersion : noVersion);
    return store && !store.closed ? store : null;
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export default function StoragePage({ width, height }: PageProps) {
    const privilege = usePrivilege();
    const allowed = privilege.allowed === true;
    const { notify } = useStatus();
    const [view, setView] = usePersistentState<View>("storage:view", LIST);
    const [selection, setSelection] = usePersistentState<string | null>("storage:selection", null);
    const [attempt, setAttempt] = useState(0);
    const [dialog, setDialog] = useState<{ action: ActionId, path: string } | null>(null);
    const store = useStorageStore(attempt);

    const objects = store?.objects;
    const rows = useMemo(() => (objects ? buildRows(objects) : []), [objects]);

    if (!store || store.status === "loading")
        return <Notice width={width} height={height} loading>Reading the storage devices</Notice>;
    if (store.status === "absent") {
        return (
            <Notice width={width} height={height}>
                UDisks2 is not available on this host. The Storage page needs the udisks2 package and its service.
            </Notice>
        );
    }

    const onRefresh = () => {
        if (store.status === "error")
            setAttempt(n => n + 1);
        else
            store.reread();
    };

    if (store.status === "error") {
        return (
            <ErrorView width={width} height={height} text={`${clean(store.error ?? "Reading the storage devices failed")}. Press Ctrl+R to try again.`}
                       onRetry={onRefresh} />
        );
    }

    const onAction = (action: ActionInfo, row: Row) => {
        if (!row.block)
            return;
        if (!allowed) {
            notify(`To ${action.label}, turn on administrative access first: press A`, "warning");
            return;
        }
        if (action.blocked !== null) {
            notify(clean(`Cannot ${action.label}: ${action.blocked}`), "warning");
            return;
        }
        setDialog({ action: action.id, path: row.block });
    };

    const shared = {
        objects: store.objects, rows, usage: store.usage, throughput: store.throughput, allowed, width, height, onAction, onRefresh, busy: dialog !== null,
    };
    const detailed = view.kind === "details" ? rows.find(row => row.id === view.id) ?? null : null;
    const drives = rows.filter(row => row.kind === "drive").length;
    const summary = `${plural(drives, "drive")} ${glyphs.dot} ${plural(rows.length, "device")}`;

    return (
        <>
            {detailed
                ? (
                    <DeviceDetails {...shared} key={detailed.id} row={detailed}
                                   onBack={() => {
                                       setSelection(detailed.id);
                                       setView(LIST);
                                   }} />
                )
                : (
                    <DeviceList {...shared} initialSelection={selection} summary={summary} warning={store.warning}
                                onSelection={setSelection}
                                onOpen={id => {
                                    setSelection(id);
                                    setView({ kind: "details", id });
                                }} />
                )}
            {dialog && store.objects.has(dialog.path)
                ? <ActionDialog action={dialog.action} objects={store.objects} path={dialog.path} onClose={() => setDialog(null)} />
                : null}
        </>
    );
}


function ErrorView({ width, height, text, onRetry }: { width: number, height: number, text: string, onRetry: () => void }) {
    useKeys((input, key) => {
        if (key.ctrl && input === "r") {
            onRetry();
            return true;
        }
        return false;
    }, { hints: [["ctrl+r", "retry"]] });
    return <Notice width={width} height={height} color={colors.error}>{text}</Notice>;
}
