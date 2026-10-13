/*
 * Podman containers: the user's own (rootless) containers and images and,
 * with administrative access, the system's -- the lists, one container's
 * or image's details, a container's log, and the everyday actions.
 * Upstream: cockpit-podman 121.
 *
 *   [Containers]  Images    9 containers · 7 running · /web
 *     Name        Image                    State      CPU   Memory  Owner  Ports
 *   › ● nginx     docker.io/nginx:alpine   Running   0.1%  12.4 MB  user   8081:80/tcp
 *     ○ builder   localhost/builder        Exited (1)               user
 *
 * Covered: start, stop, restart, pause and resume, delete a container;
 * delete an image; details; logs. Not covered: creating and running
 * containers, pulling, searching and building images, a console inside a
 * container, commit, checkpoint and restore, renaming, pruning, creating
 * pods and acting on a pod as a whole, health check runs, quadlets.
 *
 * Two podman services may be in play (store.ts): the user's, always, and the
 * system's while administrative access is on -- the shell remounts the page
 * when access changes, which opens or drops it. The user's containers need
 * no administrative access for anything.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text } from "../../tui/ink.js";
import { useKeys, type Hint } from "../../tui/keyboard.js";
import type { PageProps } from "../../tui/page.js";
import { ConfirmDialog } from "../../tui/components/Dialog.js";
import { Notice, Tabs } from "../../tui/components/misc.js";
import { Panel, PANEL_EDGE, panelled } from "../../tui/components/Panel.js";
import { ScrollView, type LineLike } from "../../tui/components/ScrollView.js";
import { Table, useListNav, type Column } from "../../tui/components/Table.js";
import { TextInput } from "../../tui/components/TextInput.js";
import { useAsync, useMounted, useNow } from "../../tui/hooks.js";
import { usePrivilege } from "../../tui/privilege.js";
import { usePersistentState } from "../../tui/session-context.js";
import { errorText, useStatus } from "../../tui/status.js";
import { cleanLines, fit, truncate, width as textWidth } from "../../tui/text.js";
import { colors, glyphs } from "../../tui/theme.js";
import { clean } from "../../lib/hosttext.js";
import { containerAction, containerLog, LOG_LINES, removeImage } from "./actions.js";
import {
    containerActions, containerRows, containerSections, formatAge, formatPort, formatSize, imageRows, imageSections, imageUsers,
    isActive, ownerName, stateText, stateTone, type ActionInfo, type Container, type ContainerAction, type ContainerFilter,
    type Image, type Section, type Stats, type Tone,
} from "./model.js";
import { userIsRoot, type Owner } from "./rest.js";
import { PodmanStore } from "./store.js";

/** How long a question is up before Enter answers it: see services/dialogs.tsx. */
export const CONFIRM_ARM_MS = 300;

type Tab = "containers" | "images";
type View =
    | { readonly kind: "list" }
    | { readonly kind: "container", readonly key: string }
    | { readonly kind: "logs", readonly key: string }
    | { readonly kind: "image", readonly key: string };

const LIST: View = { kind: "list" };
/** A tone's colour, read when drawn: the colour scheme can change. */
const toneColor = (tone: Tone): string => colors[tone];

const noSubscribe = () => () => {};
const noVersion = () => 0;

/** An owner's store for as long as it is wanted; a new `attempt` replaces it. */
function usePodmanStore(owner: Owner, wanted: boolean, attempt: number): PodmanStore | null {
    const [store, setStore] = useState<PodmanStore | null>(null);
    useEffect(() => {
        if (!wanted)
            return;
        const next = new PodmanStore(owner);
        next.start();
        setStore(next);
        return () => {
            next.close();
            setStore(previous => (previous === next ? null : previous));
        };
    }, [owner, wanted, attempt]);
    useSyncExternalStore(store ? store.subscribe : noSubscribe, store ? store.getVersion : noVersion);
    return store && !store.closed ? store : null;
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---- questions -------------------------------------------------------------------

type Question =
    | { readonly kind: "container", readonly action: ContainerAction, readonly container: Container }
    | { readonly kind: "image", readonly image: Image, readonly users: readonly Container[] };

const QUESTIONS: Readonly<Record<ContainerAction, { title: string, label: string, progress: string, danger: boolean }>> = {
    start: { title: "Start", label: "Start", progress: "Starting", danger: false },
    stop: { title: "Stop", label: "Stop", progress: "Stopping", danger: true },
    restart: { title: "Restart", label: "Restart", progress: "Restarting", danger: true },
    pause: { title: "Pause", label: "Pause", progress: "Pausing", danger: false },
    unpause: { title: "Resume", label: "Resume", progress: "Resuming", danger: false },
    remove: { title: "Delete", label: "Delete", progress: "Deleting", danger: true },
};

function questionText(question: Question): string {
    if (question.kind === "image") {
        const users = question.users.map(c => c.name);
        return users.length
            ? `Delete the image ${question.image.name}? It is used by ${users.join(", ")}: podman will refuse while it is.`
            : `Delete the image ${question.image.name}? It has to be pulled or built again to be used.`;
    }
    const { action, container } = question;
    const name = container.name;
    switch (action) {
    case "start": return `Start the container ${name}?`;
    case "stop": return `Stop the container ${name}? Its processes are asked to end, and killed if they have not by its stop timeout (ten seconds unless it was given another).`;
    case "restart": return `Restart the container ${name}? Its processes are stopped and started again.`;
    case "pause": return `Pause the container ${name}? Its processes are frozen until it is resumed.`;
    case "unpause": return `Resume the container ${name}?`;
    case "remove":
        return isActive(container)
            ? `Delete the container ${name}? It is ${container.state}: it will be stopped by force and then deleted. Whatever it wrote outside its volumes is lost.`
            : `Delete the container ${name}? Whatever it wrote outside its volumes is lost.`;
    }
}

function QuestionDialog({ question, onClose }: { question: Question, onClose: () => void }) {
    const { notify } = useStatus();
    const mounted = useMounted();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const running = useRef(false);
    const spec = question.kind === "image" ? QUESTIONS.remove : QUESTIONS[question.action];
    const subject = question.kind === "image" ? question.image.name : question.container.name;

    const confirm = () => {
        if (running.current)
            return;
        running.current = true;
        setBusy(true);
        setError(null);
        const work = question.kind === "image" ? removeImage(question.image) : containerAction(question.container, question.action);
        work.then(message => {
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
    };

    return (
        <ConfirmDialog
            title={clean(`${spec.title} ${subject}`)}
            message={clean(questionText(question))}
            confirmLabel={spec.label}
            danger={spec.danger}
            busy={busy}
            busyText={`${spec.progress}${glyphs.ellipsis}`}
            error={error}
            armMs={CONFIRM_ARM_MS}
            onConfirm={confirm}
            onCancel={onClose}
        />
    );
}

// ---- details and logs ----------------------------------------------------------------

function sectionLines(sections: readonly Section[], width: number): LineLike[] {
    const lines: LineLike[] = [];
    const labels = Math.min(18, Math.max(0, ...sections.flatMap(s => s.fields.map(f => textWidth(f.label)))) + 2);
    for (const section of sections) {
        if (lines.length)
            lines.push("");
        lines.push({ text: section.title, bold: true, color: colors.accent });
        for (const field of section.fields) {
            lines.push({
                text: truncate(`${fit(field.label, labels)}${clean(field.value)}`, width),
                ...(field.tone && field.tone !== "dim" ? { color: toneColor(field.tone) } : {}),
            });
        }
    }
    return lines;
}

function ContainerDetails({ container, store, stats, width, height, active, onBack, onLogs, onAction }: {
    container: Container, store: PodmanStore | null, stats: Stats | null, width: number, height: number, active: boolean,
    onBack: () => void, onLogs: () => void, onAction: (action: ActionInfo<ContainerAction>) => void,
}) {
    const boxed = panelled(width, height);
    const inner = boxed ? width - PANEL_EDGE : width;
    const now = Math.floor(useNow(30_000) / 1000);
    // Read again when the container changes state: its inspection changed too.
    const inspect = useAsync(() => (store ? store.inspect(container.id) : Promise.resolve(null)),
                             [store, container.id, container.state]);
    const actions = containerActions(container);
    const lines = useMemo(() => {
        const out = sectionLines(containerSections(container, inspect.value, stats, now), inner);
        if (inspect.error)
            out.push("", { text: truncate(clean(`Reading its configuration failed: ${errorText(inspect.error)}`), inner), color: colors.error });
        return out;
    }, [container, inspect.value, inspect.error, stats, now, inner]);

    useKeys((input, key) => {
        if (key.escape || key.backspace) {
            onBack();
            return true;
        }
        if (key.ctrl || key.meta)
            return false;
        if (input === "l") {
            onLogs();
            return true;
        }
        const action = actions.find(a => a.key === input);
        if (action) {
            onAction(action);
            return true;
        }
        return false;
    }, { active, hints: [["esc", "back"], ["l", "logs"], ...actions.map(a => [a.key, a.label] as const)] });

    return (
        <Panel plain={!boxed} title={clean(container.name)} detail={clean(stateText(container))} width={width} height={height}>
            <ScrollView lines={lines} width={inner} height={boxed ? height - PANEL_EDGE : height} active={active} />
        </Panel>
    );
}

function ContainerLogs({ container, width, height, onBack }: {
    container: Container, width: number, height: number, onBack: () => void,
}) {
    const boxed = panelled(width, height);
    const inner = boxed ? width - PANEL_EDGE : width;
    const rows = boxed ? height - PANEL_EDGE : height;
    const log = useAsync(signal => containerLog(container, signal), [container.key]);

    useKeys((input, key) => {
        if (key.escape || key.backspace) {
            onBack();
            return true;
        }
        if (key.ctrl && input === "r") {
            log.reload();
            return true;
        }
        return false;
    }, { hints: [["esc", "back"], ["ctrl+r", "reload"]] });

    let body;
    if (log.error && log.value === undefined) {
        body = <Notice width={inner} height={rows} color={colors.error}>{clean(`Reading the log failed: ${errorText(log.error)}`)}</Notice>;
    } else if (log.value === undefined) {
        body = <Notice width={inner} height={rows} loading>Reading the log</Notice>;
    } else {
        // Host text: control characters made visible, line by line.
        const lines = cleanLines(log.value.replace(/\n$/, "")).map(line => truncate(line, inner));
        body = lines.length === 1 && lines[0] === ""
            ? <Notice width={inner} height={rows}>The container has written nothing.</Notice>
            : <ScrollView key={log.loading ? "loading" : "loaded"} lines={lines} width={inner} height={rows} startAtEnd />;
    }
    return (
        <Panel plain={!boxed} title={clean(`${container.name}: log`)} detail={`last ${LOG_LINES} lines`} width={width} height={height}>
            {body}
        </Panel>
    );
}

function ImageDetails({ image, users, width, height, active, onBack, onDelete }: {
    image: Image, users: readonly Container[], width: number, height: number, active: boolean,
    onBack: () => void, onDelete: () => void,
}) {
    const boxed = panelled(width, height);
    const inner = boxed ? width - PANEL_EDGE : width;
    const now = Math.floor(useNow(30_000) / 1000);
    const lines = useMemo(() => sectionLines(imageSections(image, users, now), inner), [image, users, now, inner]);
    useKeys((input, key) => {
        if (key.escape || key.backspace) {
            onBack();
            return true;
        }
        if (input === "d" && !key.ctrl && !key.meta) {
            onDelete();
            return true;
        }
        return false;
    }, { active, hints: [["esc", "back"], ["d", "delete"]] });
    return (
        <Panel plain={!boxed} title={clean(image.name)} detail={formatSize(image.size)} width={width} height={height}>
            <ScrollView lines={lines} width={inner} height={boxed ? height - PANEL_EDGE : height} active={active} />
        </Panel>
    );
}

// ---- the lists -----------------------------------------------------------------------

function containerColumns(rows: readonly Container[], stats: ReadonlyMap<string, Stats>, showOwner: boolean): Column<Container>[] {
    const widest = (texts: string[], min: number, max: number) =>
        Math.max(min, Math.min(max, Math.max(0, ...texts.map(t => textWidth(t)))));
    const name = (c: Container) => clean(c.podName ? `${c.podName}/${c.name}` : c.name);
    const stat = (c: Container) => (c.state === "running" ? stats.get(c.id) : undefined);
    return [
        {
            id: "glyph", title: "", width: 1,
            value: c => (isActive(c) ? glyphs.bullet : c.exitCode ? glyphs.cross : glyphs.hollow),
            color: c => toneColor(stateTone(c)),
        },
        { id: "name", title: "Name", grow: 1, minWidth: widest(rows.map(name), 8, 24), value: name },
        { id: "image", title: "Image", grow: 3, minWidth: 12, dropPriority: 2, value: c => clean(c.image), color: () => colors.dim },
        {
            id: "state", title: "State", width: widest(rows.map(c => stateText(c)), 8, 22),
            value: c => clean(stateText(c)), color: c => (stateTone(c) === "dim" ? undefined : toneColor(stateTone(c))),
        },
        { id: "cpu", title: "CPU", width: 6, align: "right", dropPriority: 4, value: c => (stat(c) ? `${stat(c)!.cpu.toFixed(1)}%` : "") },
        { id: "memory", title: "Memory", width: 8, align: "right", dropPriority: 3, value: c => (stat(c) ? formatSize(stat(c)!.memory) : "") },
        ...(showOwner ? [{ id: "owner", title: "Owner", width: 6, dropPriority: 5, value: (c: Container) => ownerName(c.owner) } satisfies Column<Container>] : []),
        {
            id: "ports", title: "Ports", grow: 2, minWidth: 10, dropPriority: 6,
            value: c => clean(c.ports.map(formatPort).join(", ")), color: () => colors.dim,
        },
    ];
}

function imageColumns(now: number, showOwner: boolean): Column<Image>[] {
    return [
        { id: "name", title: "Image", grow: 4, minWidth: 20, value: i => clean(i.name) },
        { id: "created", title: "Created", width: 14, dropPriority: 2, value: i => (i.created !== null ? `${formatAge(now - i.created)} ago` : ""), color: () => colors.dim },
        { id: "size", title: "Size", width: 8, align: "right", value: i => formatSize(i.size) },
        ...(showOwner ? [{ id: "owner", title: "Owner", width: 6, dropPriority: 3, value: (i: Image) => ownerName(i.owner) } satisfies Column<Image>] : []),
        { id: "used", title: "Used by", width: 13, dropPriority: 1, value: i => (i.containers ? plural(i.containers, "container") : "unused"), color: i => (i.containers ? undefined : colors.dim) },
    ];
}

// ---- the page ------------------------------------------------------------------------

export default function PodmanPage({ width, height }: PageProps) {
    const privilege = usePrivilege();
    const [tab, setTab] = usePersistentState<Tab>("podman:tab", "containers");
    const [view, setView] = usePersistentState<View>("podman:view", LIST);
    const [filter, setFilter] = usePersistentState<ContainerFilter>("podman:filter", "all");
    const [text, setText] = usePersistentState("podman:text", "");
    const [selection, setSelection] = usePersistentState<Readonly<Record<Tab, string | null>>>("podman:selection", { containers: null, images: null });
    const [editing, setEditing] = useState(false);
    const [question, setQuestion] = useState<Question | null>(null);
    const [attempt, setAttempt] = useState(0);

    const user = usePodmanStore("user", true, attempt);
    // Root's containers: only with administrative access (the socket is root's).
    // Not for a root session: there the user's own are the system's (rest.ts).
    const system = usePodmanStore("system", privilege.allowed === true && !privilege.isRoot && !userIsRoot(), attempt);
    const stores = [user, system].filter((s): s is PodmanStore => s !== null);
    const ready = stores.filter(s => s.status === "ready");
    const userVersion = user?.version ?? 0;
    const systemVersion = system?.version ?? 0;

    const containers = useMemo(() => ready.flatMap(s => s.containers),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [user, system, userVersion, systemVersion]);
    const images = useMemo(() => ready.flatMap(s => s.images),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [user, system, userVersion, systemVersion]);
    const stats = useMemo(() => new Map(ready.flatMap(s => [...s.stats])),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [user, system, userVersion, systemVersion]);
    const containerList = useMemo(() => containerRows(containers, filter, text), [containers, filter, text]);
    const imageList = useMemo(() => imageRows(images, text), [images, text]);
    const now = Math.floor(useNow(60_000) / 1000);

    // Two panels when there is room: the tabs with what is shown, and the table.
    const boxed = panelled(width, height);
    const inner = boxed ? width - PANEL_EDGE : width;
    const tableHeight = Math.max(2, (boxed ? height - 2 * PANEL_EDGE : height) - 2);
    const keys = useMemo(() => (tab === "containers" ? containerList.map(c => c.key) : imageList.map(i => i.key)),
                         [tab, containerList, imageList]);
    const listShown = view.kind === "list";
    const nav = useListNav(keys, tableHeight - 1, {
        active: listShown && !editing && question === null, initialKey: selection[tab],
    });
    // The other tab's rows have other keys: go back to the row that was left there.
    const shownTab = useRef(tab);
    useEffect(() => {
        if (shownTab.current === tab)
            return;
        shownTab.current = tab;
        const saved = selection[tab];
        if (saved !== null && keys.includes(saved))
            nav.selectKey(saved);
        else
            nav.select(0); // not wherever the other list's selection happened to be
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, keys]);
    const selectedContainer = tab === "containers" && nav.index >= 0 ? containerList[nav.index] ?? null : null;
    const selectedImage = tab === "images" && nav.index >= 0 ? imageList[nav.index] ?? null : null;
    const rowActions = selectedContainer ? containerActions(selectedContainer) : [];

    const remember = useCallback(() => {
        if (nav.key !== null)
            setSelection(previous => (previous[tab] === nav.key ? previous : { ...previous, [tab]: nav.key }));
    }, [nav.key, tab, setSelection]);

    const askContainer = (container: Container, action: ActionInfo<ContainerAction>) =>
        setQuestion({ kind: "container", action: action.id, container });
    const askImage = (image: Image) => setQuestion({ kind: "image", image, users: imageUsers(image, containers) });

    const hints: Hint[] = [
        ["enter", "details"],
        [glyphs.leftright, tab === "containers" ? "images" : "containers"],
        ...(tab === "containers"
            ? [...(selectedContainer ? [["l", "logs"] as const] : []), ...rowActions.map(a => [a.key, a.label] as const),
               ["f", filter === "all" ? "only running" : "show all"] as const]
            : selectedImage ? [["d", "delete"] as const] : []),
        ["/", "search"],
    ];

    useKeys((input, key) => {
        if (key.leftArrow || key.rightArrow) {
            remember();
            setTab(tab === "containers" ? "images" : "containers");
            return true;
        }
        if (key.return) {
            remember();
            if (selectedContainer)
                setView({ kind: "container", key: selectedContainer.key });
            else if (selectedImage)
                setView({ kind: "image", key: selectedImage.key });
            return true;
        }
        if (key.escape && text) {
            setText("");
            return true;
        }
        if (key.ctrl && input === "r") {
            if (stores.some(s => s.status !== "ready" && s.status !== "loading"))
                setAttempt(n => n + 1);
            else
                stores.forEach(s => s.refresh());
            return true;
        }
        if (key.ctrl || key.meta)
            return false;
        if (input === "j" || input === "k") {
            nav.select(nav.index + (input === "j" ? 1 : -1));
            return true;
        }
        if (input === "/") {
            setEditing(true);
            return true;
        }
        if (tab === "containers") {
            if (input === "f") {
                setFilter(filter === "all" ? "running" : "all");
                return true;
            }
            if (input === "l" && selectedContainer) {
                remember();
                setView({ kind: "logs", key: selectedContainer.key });
                return true;
            }
            const action = rowActions.find(a => a.key === input);
            if (action && selectedContainer) {
                askContainer(selectedContainer, action);
                return true;
            }
        } else if (input === "d" && selectedImage) {
            askImage(selectedImage);
            return true;
        }
        return false;
    }, {
        active: listShown && !editing && question === null,
        hints,
        help: [
            ["enter", "details"], [glyphs.leftright, "containers / images"], ["/", "search"], ["f", "only running, or all"],
            ["l", "a container's log"], ["s", "start"], ["S", "stop"], ["r", "restart"], ["p", "pause / resume"],
            ["d", "delete"], ["ctrl+r", "refresh"],
        ],
    });

    // What was open is gone (deleted): back to the list.
    const gone = ready.length > 0 && (
        ((view.kind === "container" || view.kind === "logs") && !containers.some(c => c.key === view.key)) ||
        (view.kind === "image" && !images.some(i => i.key === view.key)));
    useEffect(() => {
        if (gone)
            setView(LIST);
    }, [gone, setView]);

    // The user's service decides whether there is a page at all.
    if (!user || user.status === "loading")
        return <Notice width={width} height={height} loading>Connecting to podman</Notice>;
    if (ready.length === 0) {
        const reasons = stores.filter(s => s.error).map(s => `${ownerName(s.owner)}: ${s.error}`).join("; ");
        return <Unavailable width={width} height={height} text={clean(`Podman is not available (${reasons}).`)} onRetry={() => setAttempt(n => n + 1)} />;
    }

    const close = () => setQuestion(null);
    const dialog = question ? <QuestionDialog question={question} onClose={close} /> : null;
    const storeOf = (owner: Owner) => (owner === "user" ? user : system);

    if (view.kind === "container" || view.kind === "logs") {
        const container = containers.find(c => c.key === view.key);
        if (container) {
            return (
                <>
                    {view.kind === "logs"
                        ? <ContainerLogs container={container} width={width} height={height}
                                         onBack={() => setView(LIST)} />
                        : <ContainerDetails container={container} store={storeOf(container.owner)} stats={stats.get(container.id) ?? null}
                                            width={width} height={height} active={question === null}
                                            onBack={() => setView(LIST)}
                                            onLogs={() => setView({ kind: "logs", key: container.key })}
                                            onAction={action => askContainer(container, action)} />}
                    {dialog}
                </>
            );
        }
    }
    if (view.kind === "image") {
        const image = images.find(i => i.key === view.key);
        if (image) {
            return (
                <>
                    <ImageDetails image={image} users={imageUsers(image, containers)} width={width} height={height}
                                  active={question === null} onBack={() => setView(LIST)} onDelete={() => askImage(image)} />
                    {dialog}
                </>
            );
        }
    }
    // ---- the summary line --------------------------------------------------------
    const showOwner = system !== null;
    const running = containers.filter(c => c.state === "running").length;
    const parts: { text: string, color?: string }[] = tab === "containers"
        ? [
            { text: text || filter !== "all" ? `${containerList.length} of ${plural(containers.length, "container")}` : plural(containers.length, "container") },
            { text: `${running} running`, ...(running ? { color: colors.ok } : {}) },
            ...(filter === "running" ? [{ text: "only running", color: colors.accent }] : []),
        ]
        : [{ text: text ? `${imageList.length} of ${plural(images.length, "image")}` : plural(images.length, "image") }];
    if (text && !editing)
        parts.push({ text: `/${clean(text)}`, color: colors.accent });
    const troubles = stores.filter(s => s.status !== "ready" && s.status !== "loading")
            .map(s => `${ownerName(s.owner)} podman: ${s.error}`)
            .concat(stores.flatMap(s => (s.warning ? [s.warning] : [])));
    if (system?.status === "loading")
        parts.push({ text: `reading the system's${glyphs.ellipsis}`, color: colors.dim });
    else if (!system && privilege.allowed === false && privilege.configured === true)
        parts.push({ text: "the system's need administrative access (A)", color: colors.dim });
    for (const trouble of troubles)
        parts.push({ text: clean(trouble), color: colors.warning });

    const summary = editing
        ? (
            <Box width={inner} height={1}>
                <Text color={colors.accent}>Search: </Text>
                <TextInput value={text} width={Math.max(1, inner - 8)} placeholder="name or image"
                           onChange={setText} onSubmit={() => setEditing(false)}
                           onCancel={() => { setText(""); setEditing(false) }}
                           hints={[["enter", "done"], ["esc", "clear"]]} />
            </Box>
        )
        : (
            <Box width={inner} height={1}>
                <Text wrap="truncate">
                    {parts.map((part, i) => (
                        <Text key={i}>
                            {i ? <Text color={colors.dim}>{` ${glyphs.dot} `}</Text> : ""}
                            <Text color={part.color}>{part.text}</Text>
                        </Text>
                    ))}
                </Text>
            </Box>
        );

    const version = user.podmanVersion ? `podman ${clean(user.podmanVersion)}` : "";
    const focused = !editing && question === null;
    return (
        <Box flexDirection="column" width={width} height={height}>
            <Panel plain={!boxed} title="View" detail={version} width={width} height={2 + PANEL_EDGE}>
                <Tabs tabs={["Containers", "Images"]} current={tab === "containers" ? 0 : 1} width={inner} />
                {summary}
            </Panel>
            <Panel plain={!boxed} title={tab === "containers" ? "Containers" : "Images"} width={width} height={tableHeight + PANEL_EDGE}>
                {tab === "containers"
                    ? <Table rows={containerList} columns={containerColumns(containerList, stats, showOwner)} nav={nav}
                             width={inner} height={tableHeight} focused={focused}
                             empty={containers.length ? "No matching containers. Press f for all, Esc to clear the search." : "No containers."} />
                    : <Table rows={imageList} columns={imageColumns(now, showOwner)} nav={nav}
                             width={inner} height={tableHeight} focused={focused}
                             empty={images.length ? "No matching images. Esc clears the search." : "No images."} />}
            </Panel>
            {dialog}
        </Box>
    );
}

function Unavailable({ width, height, text, onRetry }: { width: number, height: number, text: string, onRetry: () => void }) {
    useKeys((input, key) => {
        if (key.ctrl && input === "r") {
            onRetry();
            return true;
        }
        return false;
    }, { hints: [["ctrl+r", "retry"]] });
    return <Notice width={width} height={height} color={colors.error}>{`${text} Press Ctrl+R to try again.`}</Notice>;
}
