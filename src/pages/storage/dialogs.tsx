/*
 * The Storage page's dialogs: one per action. Each asks first, shows
 * progress while its calls run, closes on success (the footer says what was
 * done) and stays open with the host's reason on failure.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../tui/components/Dialog.js";
import { FormDialog, type FormField } from "../../tui/components/Form.js";
import { useMounted } from "../../tui/hooks.js";
import { errorText, useStatus } from "../../tui/status.js";
import { glyphs } from "../../tui/theme.js";
import { clean } from "../../lib/hosttext.js";
import {
    AT_BOOT_LABELS, blockName, FORMAT_EMPTY, formatCandidates, formatSize, I, labelProblem, mountEntry, mountPointProblem,
    mountPointUsers, mountPointsOf, mountSettings, partitionCount, shortName,
    type ActionId, type AtBoot, type FormatType, type Objects,
} from "./model.js";
import { format, lock, mount, setSwap, unlock, unmount, usableFormats, type BlockTarget } from "./actions.js";

/** How long a question is up before Enter answers it: see services/dialogs.tsx. */
export const CONFIRM_ARM_MS = 300;

export interface ActionDialogProps {
    readonly action: ActionId;
    readonly objects: Objects;
    /** The block device acted on. */
    readonly path: string;
    readonly onClose: () => void;
}

/** Run one action: busy while it runs, the error if it fails, the footer and onClose when it worked. */
function useRunner(onClose: () => void) {
    const { notify } = useStatus();
    const mounted = useMounted();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const running = useRef(false);

    const start = useCallback((action: () => Promise<string>) => {
        if (running.current)
            return;
        running.current = true;
        setBusy(true);
        setError(null);
        action().then(message => {
            notify(clean(message), "success");
            if (mounted())
                onClose();
        }, (failure: unknown) => {
            running.current = false;
            const text = clean(errorText(failure));
            if (mounted()) {
                setBusy(false);
                setError(text);
            } else {
                notify(text, "error");
            }
        });
    }, [notify, mounted, onClose]);

    return { busy, error, start };
}

function useTarget(objects: Objects, path: string): BlockTarget {
    // What the device was when the dialog opened: the action is about that,
    // whatever signals arrive while the question is on screen.
    const [target] = useState<BlockTarget>(() => ({ path, interfaces: objects.get(path) ?? {} }));
    return target;
}

function MountDialog({ objects, path, onClose }: ActionDialogProps) {
    const target = useTarget(objects, path);
    const block = target.interfaces[I.block];
    const [initial] = useState(() => mountSettings(mountEntry(block)));
    const [dir, setDir] = useState(initial.dir);
    const [readOnly, setReadOnly] = useState(initial.readOnly);
    const [atBoot, setAtBoot] = useState<AtBoot>(initial.atBoot);
    const [problem, setProblem] = useState<string | null>(null);
    const runner = useRunner(onClose);

    // A filesystem inside an encrypted device waits for an unlock that this
    // page does not arrange at boot: only the choices that cannot hold it up.
    const encrypted = typeof block?.CryptoBackingDevice === "string" && block.CryptoBackingDevice !== "/";
    const choices: AtBoot[] = encrypted ? ["nofail", "never"] : ["nofail", "local", "netdev", "never"];
    const boot = choices.includes(atBoot) ? atBoot : "nofail";

    const submit = () => {
        const where = dir.trim();
        const users = mountPointUsers(objects, where, path);
        const invalid = mountPointProblem(where) ?? (users.length ? `Mount point is already used for ${users.join(", ")}` : null);
        setProblem(invalid);
        if (invalid)
            return;
        runner.start(() => mount(target, { dir: where, readOnly, atBoot: boot, extra: initial.extra }));
    };

    const fields: FormField[] = [
        { id: "dir", kind: "text", label: "Mount point", value: dir, placeholder: "/mnt/data", error: problem },
        { id: "ro", kind: "checkbox", label: "Mount read only", value: readOnly },
        {
            id: "boot", kind: "select", label: "At boot", value: boot,
            options: choices.map(value => ({ value, label: AT_BOOT_LABELS[value] })),
            ...(encrypted ? { help: "The device is encrypted: it is mounted at boot only if it is unlocked by then." } : {}),
        },
    ];

    return (
        <FormDialog
            title={clean(`Mount ${blockName(block)}`)}
            intro="The mount point is saved in /etc/fstab."
            fields={fields}
            submitLabel="Mount"
            busy={runner.busy}
            busyText={`Mounting${glyphs.ellipsis}`}
            error={runner.error}
            onChange={(id, value) => {
                if (id === "dir") {
                    setDir(String(value));
                    setProblem(null);
                } else if (id === "ro") {
                    setReadOnly(value === true);
                } else if (id === "boot") {
                    setAtBoot(value as AtBoot);
                }
            }}
            onSubmit={submit}
            onCancel={onClose}
        />
    );
}

function Confirm({ title, message, label, danger, progress, action, onClose }: {
    title: string, message: string, label: string, danger?: boolean, progress: string,
    action: () => Promise<string>, onClose: () => void,
}) {
    const runner = useRunner(onClose);
    return (
        <ConfirmDialog
            title={clean(title)}
            message={clean(message)}
            confirmLabel={label}
            danger={danger ?? false}
            busy={runner.busy}
            busyText={`${progress}${glyphs.ellipsis}`}
            error={runner.error}
            armMs={CONFIRM_ARM_MS}
            onConfirm={() => runner.start(action)}
            onCancel={onClose}
        />
    );
}

function UnlockDialog({ objects, path, onClose }: ActionDialogProps) {
    const target = useTarget(objects, path);
    const [passphrase, setPassphrase] = useState("");
    const [problem, setProblem] = useState<string | null>(null);
    const runner = useRunner(onClose);
    return (
        <FormDialog
            title={clean(`Unlock ${blockName(target.interfaces[I.block])}`)}
            fields={[{ id: "passphrase", kind: "password", label: "Passphrase", value: passphrase, error: problem }]}
            submitLabel="Unlock"
            busy={runner.busy}
            busyText={`Unlocking${glyphs.ellipsis}`}
            error={runner.error}
            onChange={(_id, value) => {
                setPassphrase(String(value));
                setProblem(null);
            }}
            onSubmit={() => {
                if (!passphrase)
                    setProblem("Passphrase cannot be empty");
                else
                    runner.start(() => unlock(target, passphrase));
            }}
            onCancel={onClose}
        />
    );
}

function FormatDialog({ objects, path, onClose }: ActionDialogProps) {
    const target = useTarget(objects, path);
    const block = target.interfaces[I.block];
    const name = shortName(block);
    const [types, setTypes] = useState<FormatType[] | null>(null);
    const [type, setType] = useState("");
    const [label, setLabel] = useState("");
    const [erase, setErase] = useState(false);
    const [typed, setTyped] = useState("");
    const [problems, setProblems] = useState<{ label?: string | null, typed?: string | null }>({});
    const runner = useRunner(onClose);

    useEffect(() => {
        let live = true;
        const candidates = formatCandidates(objects);
        usableFormats(candidates.map(c => c.value)).then(usable => {
            if (!live)
                return;
            const offered = [...candidates.filter(c => usable.has(c.value)), FORMAT_EMPTY];
            setTypes(offered);
            setType(offered[0]!.value);
        }, () => {
            if (live) {
                setTypes([FORMAT_EMPTY]);
                setType(FORMAT_EMPTY.value);
            }
        });
        return () => { live = false };
        // Asked once, when the dialog opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const partitions = partitionCount(objects, path);
    const size = typeof block?.Size === "number" ? formatSize(block.Size) : "";
    const lost = partitions > 0
        ? `its ${partitions} partition${partitions === 1 ? "" : "s"} and everything on them`
        : "everything on it";
    const intro = clean(`Formatting ${blockName(block)}${size ? ` (${size})` : ""} destroys ${lost}. This cannot be undone.`);

    const submit = () => {
        // The types are still being asked for: nothing to format as yet. Esc works throughout.
        if (types === null)
            return;
        const next = {
            label: labelProblem(label, type),
            typed: typed.trim() === name ? null : `Type ${name} to confirm`,
        };
        setProblems(next);
        if (next.label || next.typed)
            return;
        runner.start(() => format(target, { type, label, erase }));
    };

    const loading = types === null;
    const fields: FormField[] = [
        {
            id: "type", kind: "select", label: "Type", value: type, options: types ?? [], disabled: loading,
            ...(loading ? { help: `Checking what this host can format${glyphs.ellipsis}` } : {}),
        },
        { id: "label", kind: "text", label: "Name", value: label, error: problems.label ?? null, disabled: loading || type === "empty" },
        {
            id: "erase", kind: "checkbox", label: "Overwrite with zeros", value: erase, disabled: loading,
            help: "Overwriting takes a long time on a large device.",
        },
        {
            id: "typed", kind: "text", label: "Confirm", value: typed, disabled: loading,
            error: problems.typed ?? null, help: clean(`Type ${name} to confirm.`),
        },
    ];

    return (
        <FormDialog
            title={clean(`Format ${blockName(block)}`)}
            tone="error"
            intro={intro}
            fields={fields}
            submitLabel="Format"
            busy={runner.busy}
            busyText={`Formatting${glyphs.ellipsis}`}
            error={runner.error}
            onChange={(id, value) => {
                if (id === "type")
                    setType(String(value));
                else if (id === "label")
                    setLabel(String(value));
                else if (id === "erase")
                    setErase(value === true);
                else if (id === "typed")
                    setTyped(String(value));
                setProblems({});
            }}
            onSubmit={submit}
            onCancel={onClose}
        />
    );
}

/** The dialog for `action` on the block device at `path`. */
export function ActionDialog(props: ActionDialogProps) {
    const { action, objects, path, onClose } = props;
    const target = useTarget(objects, path);
    const name = blockName(target.interfaces[I.block]);

    switch (action) {
    case "mount":
        return <MountDialog {...props} />;
    case "unlock":
        return <UnlockDialog {...props} />;
    case "format":
        return <FormatDialog {...props} />;
    case "unmount": {
        const dirs = mountPointsOf(target.interfaces[I.filesystem]);
        const kept = mountEntry(target.interfaces[I.block])
            ? " It will stay unmounted after a reboot until it is mounted here again."
            : "";
        return (
            <Confirm title={`Unmount ${name}`} label="Unmount" danger progress="Unmounting"
                     message={`Unmount the filesystem on ${name} from ${dirs.join(", ")}? Programs using it lose access to their files.${kept}`}
                     action={() => unmount(target)} onClose={onClose} />
        );
    }
    case "lock":
        return (
            <Confirm title={`Lock ${name}`} label="Lock" danger progress="Locking"
                     message={`Lock ${name}? Its contents cannot be read again until it is unlocked with its passphrase.`}
                     action={() => lock(target)} onClose={onClose} />
        );
    case "swapon":
        return (
            <Confirm title={`Start swap on ${name}`} label="Start" progress="Starting swap"
                     message={`Start swapping on ${name}?`}
                     action={() => setSwap(target, true)} onClose={onClose} />
        );
    case "swapoff":
        return (
            <Confirm title={`Stop swap on ${name}`} label="Stop" danger progress="Stopping swap"
                     message={`Stop swapping on ${name}? What is swapped out there has to fit back into memory.`}
                     action={() => setSwap(target, false)} onClose={onClose} />
        );
    }
}
