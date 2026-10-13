/*
 * Networking: the host's network interfaces as NetworkManager has them, what
 * they send and receive, and the firewall's state -- the list, one
 * interface's details, and its switch.
 * Upstream: pkg/networkmanager (cockpit 356).
 *
 *   ┌─┤ Kbps Sending ├──────── 48.2 ─┐ ┌─┤ Kbps Receiving ├────── 310 ─┐
 *   │ ...                            │ │ ...                          │
 *   Firewall  on, 1 active zone: public (enp1s0)
 *     Name      IP address          Sending    Receiving   State
 *   › enp1s0    192.168.1.5/24      48.2 Kbps  310 Kbps    Active
 *     virbr0    192.168.122.1/24                           No carrier
 *
 * `f` opens the firewall's rules (firewall-view.tsx): each active zone with
 * the services and ports it lets in, adding and removing them.
 *
 * Covered: switching an interface on and off (under NetworkManager's
 * checkpoint, so a switch that cuts off this very connection is undone by
 * itself; see actions.ts), "connect automatically", and the firewall on and
 * off. Not covered: changing addresses, DNS, routes, MTU or MAC; adding
 * bonds, bridges, teams, VLANs or WireGuard; adding, removing or reassigning
 * firewall zones; defining new firewalld services.
 *
 * Changing anything needs administrative access. NetworkManager's own policy
 * would let a user at the machine's console switch interfaces without it,
 * but a session over ssh or cockpit-ws is not that, and the page does not
 * guess.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text } from "../../tui/ink.js";
import { useKeys, type Hint } from "../../tui/keyboard.js";
import { useNavigation } from "../../tui/navigation.js";
import type { PageProps } from "../../tui/page.js";
import { Buttons, Dialog, DialogText, useDialogWidth } from "../../tui/components/Dialog.js";
import { Notice } from "../../tui/components/misc.js";
import { Panel, PANEL_EDGE, panelled } from "../../tui/components/Panel.js";
import { PLOT_EXTRA_ROWS, plotHeight, PlotPair } from "../../tui/components/Plot.js";
import { ScrollView, type LineLike } from "../../tui/components/ScrollView.js";
import { Spinner } from "../../tui/components/Spinner.js";
import { Table, useListNav, type Column } from "../../tui/components/Table.js";
import { useMounted } from "../../tui/hooks.js";
import { usePrivilege } from "../../tui/privilege.js";
import { usePersistentState } from "../../tui/session-context.js";
import { errorText, useStatus } from "../../tui/status.js";
import { fit, truncate, width as textWidth } from "../../tui/text.js";
import { colors, glyphs } from "../../tui/theme.js";
import { clean } from "../../lib/hosttext.js";
import { BIT_UNITS } from "../../lib/plot.js";
import { activate, deactivate, RolledBackError, ROLLBACK_SECONDS, setAutoconnect, setFirewall } from "./actions.js";
import {
    addressText, autoconnect, buildInterfaces, firewallText, formatBitRate, ifaceActions, ifaceSections, mainConnection,
    type ActionInfo, type Iface, type Settings,
} from "./model.js";
import { NetworkStore, type Traffic } from "./store.js";
import { FirewallRules } from "./firewall-view.js";

/** How long a question is up before Enter answers it: see services/dialogs.tsx. */
export const CONFIRM_ARM_MS = 300;

type View = { readonly kind: "list" } | { readonly kind: "details", readonly name: string } | { readonly kind: "firewall" };
const LIST: View = { kind: "list" };

const noSubscribe = () => () => {};
const noVersion = () => 0;

function useNetworkStore(attempt: number): NetworkStore | null {
    const [store, setStore] = useState<NetworkStore | null>(null);
    useEffect(() => {
        const next = new NetworkStore();
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

// ---- questions -------------------------------------------------------------------

type Question =
    | { readonly kind: "activate", readonly iface: Iface, readonly connection: string }
    | { readonly kind: "deactivate", readonly iface: Iface }
    | { readonly kind: "autoconnect", readonly iface: Iface, readonly connection: string, readonly settings: Settings, readonly value: boolean }
    | { readonly kind: "firewall", readonly on: boolean };

const SAFETY = `If this is the interface you are connected over, the connection is lost, and NetworkManager undoes the change by itself after ${ROLLBACK_SECONDS} seconds.`;

function questionSpec(q: Question): { title: string, message: string, label: string, progress: string, danger: boolean } {
    switch (q.kind) {
    case "activate":
        return {
            title: `Switch on ${q.iface.name}`, label: "Switch on", progress: "Switching on", danger: false,
            message: `Switch on ${q.iface.name}? ${SAFETY}`,
        };
    case "deactivate":
        return {
            title: `Switch off ${q.iface.name}`, label: "Switch off", progress: "Switching off", danger: true,
            message: `Switch off ${q.iface.name}? It stays off until it is switched on again. ${SAFETY}`,
        };
    case "autoconnect":
        return q.value
            ? {
                title: `Connect ${q.iface.name} automatically`, label: "Connect automatically", progress: "Saving", danger: false,
                message: `Have ${q.iface.name} connect by itself, at boot and whenever it can?`,
            }
            : {
                title: `Stop connecting ${q.iface.name} automatically`, label: "Stop", progress: "Saving", danger: true,
                message: `Stop ${q.iface.name} from connecting by itself? After a reboot it stays off until it is switched on by hand: on a machine reached over this interface, that means from its console.`,
            };
    case "firewall":
        return q.on
            ? {
                title: "Switch the firewall on", label: "Switch on", progress: "Switching the firewall on", danger: true,
                message: "Switch firewalld on, now and at every boot? Connections its rules do not allow are refused from then on: if they do not allow the one you are using (ssh, Cockpit's port 9090), you are locked out.",
            }
            : {
                title: "Switch the firewall off", label: "Switch off", progress: "Switching the firewall off", danger: true,
                message: "Switch firewalld off, now and at every boot? Every port a service listens on is then reachable from the network.",
            };
    }
}

/**
 * Ask, run, and say how it went. A switch that broke the connection (and was
 * undone by NetworkManager) is offered again without the safety net.
 */
function QuestionDialog({ question, onClose, onDone }: { question: Question, onClose: () => void, onDone: () => void }) {
    const width = useDialogWidth(64);
    const { notify } = useStatus();
    const mounted = useMounted();
    const [phase, setPhase] = useState<"ask" | "running" | "rolled-back" | "failed">("ask");
    const [error, setError] = useState<string | null>(null);
    const [armed, setArmed] = useState(false);
    const running = useRef(false);
    const spec = questionSpec(question);

    useEffect(() => {
        setArmed(false);
        const timer = setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
        return () => clearTimeout(timer);
    }, [phase]);

    const run = (checkpoint: boolean) => {
        if (running.current)
            return;
        running.current = true;
        setPhase("running");
        const target = "iface" in question ? { device: question.iface.path, name: question.iface.name } : null;
        const work = question.kind === "activate" ? activate(target!, question.connection, checkpoint)
            : question.kind === "deactivate" ? deactivate(target!, checkpoint)
            : question.kind === "autoconnect" ? setAutoconnect(target!, question.connection, question.settings, question.value)
            : setFirewall(question.on);
        work.then(message => {
            notify(clean(message), "success");
            onDone();
            if (mounted())
                onClose();
        }, (failure: unknown) => {
            running.current = false;
            onDone();
            if (!mounted()) {
                notify(clean(errorText(failure)), "error");
                return;
            }
            setError(clean(errorText(failure)));
            setPhase(failure instanceof RolledBackError ? "rolled-back" : "failed");
        });
    };

    if (phase === "running") {
        return (
            <Dialog title={clean(spec.title)} width={width} tone={spec.danger ? "error" : "info"} hints={[]}>
                <Box marginTop={1}><Spinner label={`${spec.progress}${glyphs.ellipsis}`} /></Box>
            </Dialog>
        );
    }
    if (phase === "failed") {
        return (
            <Dialog title={clean(spec.title)} width={width} tone="error" onCancel={onClose} onConfirm={onClose} hints={[["esc", "close"]]}>
                <DialogText width={width} color={colors.error}>{error ?? "It failed."}</DialogText>
                <Box marginTop={1}><Buttons confirm="Close" cancel={null} /></Box>
            </Dialog>
        );
    }
    const again = phase === "rolled-back";
    const label = again ? `${spec.label} anyway` : spec.label;
    const message = again
        ? `${spec.label === "Switch on" ? "Switching on" : "Switching off"} ${"iface" in question ? question.iface.name : "it"} broke the connection to the server, and NetworkManager has put it back as it was. Doing it anyway makes the change without that safety net: if it cuts you off, only the machine's console brings it back.`
        : spec.message;
    return (
        <Dialog title={clean(spec.title)} width={width} tone={spec.danger || again ? "error" : "info"}
                onCancel={onClose} onConfirm={armed ? () => run(!again) : undefined}
                hints={armed ? [["enter", label.toLowerCase()], ["esc", "cancel"]] : [["esc", "cancel"]]}>
            <DialogText width={width}>{clean(message)}</DialogText>
            <Box marginTop={1}><Buttons confirm={label} armed={armed} /></Box>
        </Dialog>
    );
}

// ---- views -----------------------------------------------------------------------

/** Managed first, then the rest: one list, one selection. */
interface Row {
    readonly iface: Iface;
}

function columnsFor(rows: readonly Row[], traffic: ReadonlyMap<string, Traffic>): Column<Row>[] {
    const widest = (texts: string[], min: number, max: number) =>
        Math.max(min, Math.min(max, Math.max(0, ...texts.map(t => textWidth(t)))));
    const rate = (row: Row, which: "rx" | "tx") => {
        const sample = row.iface.showTraffic ? traffic.get(row.iface.name) : undefined;
        return sample ? formatBitRate(sample[which] * 8) : "";
    };
    const state = (row: Row) => (row.iface.managed ? row.iface.stateText : `${row.iface.stateText || "Active"}, unmanaged`);
    return [
        {
            id: "glyph", title: "", width: 1,
            value: row => (row.iface.state === 100 && row.iface.carrier !== false ? glyphs.bullet : glyphs.hollow),
            color: row => (row.iface.state === 120 ? colors.error : row.iface.state === 100 && row.iface.carrier !== false ? colors.ok : colors.dim),
        },
        { id: "name", title: "Name", width: widest(rows.map(r => clean(r.iface.name)), 8, 16), value: row => clean(row.iface.name) },
        { id: "type", title: "Type", width: widest(rows.map(r => r.iface.typeLabel), 6, 16), dropPriority: 3, value: row => clean(row.iface.typeLabel), color: () => colors.dim },
        { id: "address", title: "IP address", grow: 1, minWidth: 16, value: row => clean(addressText(row.iface)) },
        { id: "tx", title: "Sending", width: 10, align: "right", dropPriority: 2, value: row => rate(row, "tx") },
        { id: "rx", title: "Receiving", width: 10, align: "right", dropPriority: 1, value: row => rate(row, "rx") },
        {
            id: "state", title: "State", width: widest(rows.map(state), 10, 22), value: row => clean(state(row)),
            color: row => (row.iface.state === 120 ? colors.error
                : !row.iface.managed ? colors.dim
                : row.iface.state === 100 && row.iface.carrier !== false ? undefined : colors.warning),
        },
    ];
}

function detailLines(iface: Iface, settings: ReadonlyMap<string, Settings>, traffic: Traffic | undefined, width: number): LineLike[] {
    const lines: LineLike[] = [];
    const sections = ifaceSections(iface, settings);
    const labels = Math.min(18, Math.max(0, ...sections.flatMap(s => s.fields.map(f => textWidth(f.label)))) + 2);
    const tones = { ok: colors.ok, warning: colors.warning, error: colors.error } as const;
    for (const section of sections) {
        if (lines.length)
            lines.push("");
        lines.push({ text: section.title, bold: true, color: colors.accent });
        for (const field of section.fields) {
            lines.push({
                text: truncate(`${fit(field.label, labels)}${clean(field.value)}`, width),
                ...(field.tone ? { color: tones[field.tone] } : {}),
            });
        }
        if (section.title === "Interface" && traffic && iface.showTraffic) {
            lines.push({ text: truncate(`${fit("Sending", labels)}${formatBitRate(traffic.tx * 8)}`, width) });
            lines.push({ text: truncate(`${fit("Receiving", labels)}${formatBitRate(traffic.rx * 8)}`, width) });
        }
    }
    return lines;
}

// ---- the page ------------------------------------------------------------------------

export default function NetworkingPage({ width, height }: PageProps) {
    const privilege = usePrivilege();
    const allowed = privilege.allowed === true;
    const navigation = useNavigation();
    const { notify } = useStatus();
    const [view, setView] = usePersistentState<View>("networking:view", LIST);
    const [selection, setSelection] = usePersistentState<string | null>("networking:selection", null);
    const [attempt, setAttempt] = useState(0);
    const [question, setQuestion] = useState<Question | null>(null);
    const store = useNetworkStore(attempt);

    const objects = store?.objects;
    const lists = useMemo(() => (objects ? buildInterfaces(objects) : { managed: [], unmanaged: [] }), [objects]);
    const rows = useMemo<Row[]>(() => [...lists.managed, ...lists.unmanaged].map(iface => ({ iface })), [lists]);
    const keys = useMemo(() => rows.map(row => row.iface.name), [rows]);
    const settings = store?.settings ?? EMPTY_SETTINGS;

    // Where there is room: the plots, the firewall's line, and the interfaces, each in a panel.
    const boxed = panelled(width, height);
    const inner = boxed ? width - PANEL_EDGE : width;
    const plotted = plotHeight(height);
    const headRows = boxed ? plotted + PLOT_EXTRA_ROWS + 1 + PANEL_EDGE : 2;
    const tableHeight = Math.max(2, height - headRows - (boxed ? PANEL_EDGE : 0));
    const listShown = view.kind === "list";
    const nav = useListNav(keys, tableHeight - 1, { active: listShown && question === null, initialKey: selection });
    const selected = nav.index >= 0 ? rows[nav.index]?.iface ?? null : null;
    const detailed = view.kind === "details" ? rows.find(row => row.iface.name === view.name)?.iface ?? null : null;
    const subject = listShown ? selected : detailed;
    const actions = subject ? ifaceActions(subject, settings) : [];
    const firewall = store?.firewall;

    const act = (action: ActionInfo, iface: Iface) => {
        if (!allowed) {
            notify(`To ${action.label}, turn on administrative access first: press A`, "warning");
            return;
        }
        const main = mainConnection(iface, settings);
        if (action.id === "deactivate")
            setQuestion({ kind: "deactivate", iface });
        else if (action.id === "activate" && main)
            setQuestion({ kind: "activate", iface, connection: main });
        else if (action.id === "autoconnect" && main && settings.has(main))
            setQuestion({ kind: "autoconnect", iface, connection: main, settings: settings.get(main)!, value: !autoconnect(settings.get(main)) });
    };

    const hints: Hint[] = [
        ...(listShown ? [["enter", "details"] as const] : [["esc", "back"] as const]),
        ...(allowed ? actions.map(a => [a.key, a.label] as const) : []),
        ...(firewall?.installed ? [["f", "firewall rules"] as const] : []),
        ...(allowed && firewall?.installed ? [["F", firewall.active ? "firewall off" : "firewall on"] as const] : []),
        ["l", "logs"],
    ];

    useKeys((input, key) => {
        if (listShown && key.return) {
            if (selected) {
                setSelection(selected.name);
                setView({ kind: "details", name: selected.name });
            }
            return true;
        }
        if (!listShown && (key.escape || key.backspace)) {
            if (detailed)
                setSelection(detailed.name);
            setView(LIST);
            return true;
        }
        if (key.ctrl && input === "r") {
            if (store?.status === "error")
                setAttempt(n => n + 1);
            else
                store?.reread();
            return true;
        }
        if (key.ctrl || key.meta)
            return false;
        if (listShown && (input === "j" || input === "k")) {
            nav.select(nav.index + (input === "j" ? 1 : -1));
            return true;
        }
        if (input === "l") {
            navigation.go("logs", { unit: { name: "NetworkManager.service" } });
            return true;
        }
        if (input === "f" && firewall?.installed) {
            if (selected)
                setSelection(selected.name);
            setView({ kind: "firewall" });
            return true;
        }
        if (input === "F" && firewall?.installed) {
            if (!allowed)
                notify("To switch the firewall, turn on administrative access first: press A", "warning");
            else
                setQuestion({ kind: "firewall", on: !firewall.active });
            return true;
        }
        const action = subject ? actions.find(a => a.key === input) : undefined;
        if (action && subject) {
            act(action, subject);
            return true;
        }
        return false;
    }, {
        active: question === null && store?.status === "ready" && view.kind !== "firewall",
        hints,
        help: [
            ["enter", "details"], ["a", "switch the interface on"], ["d", "switch it off"], ["o", "connect automatically, or not"],
            ["f", "the firewall's rules: zones, services, ports"], ["F", "firewall on or off"], ["l", "NetworkManager's log"],
            ["ctrl+r", "refresh"],
        ],
    });

    // What was open is gone (unplugged, deleted): back to the list.
    const gone = store?.status === "ready" && view.kind === "details" && !detailed;
    useEffect(() => {
        if (gone)
            setView(LIST);
    }, [gone, setView]);

    if (!store || store.status === "loading")
        return <Notice width={width} height={height} loading>Reading the network interfaces</Notice>;
    if (store.status === "absent") {
        return (
            <Notice width={width} height={height}>
                NetworkManager is not running on this host. The Networking page needs it.
            </Notice>
        );
    }
    if (store.status === "error") {
        return (
            <Retry width={width} height={height} onRetry={() => setAttempt(n => n + 1)}
                   text={`${clean(store.error ?? "Reading the network interfaces failed")}. Press Ctrl+R to try again.`} />
        );
    }

    const dialog = question
        ? <QuestionDialog question={question} onClose={() => setQuestion(null)} onDone={() => { void store.refreshFirewall() }} />
        : null;

    if (view.kind === "firewall") {
        return (
            <FirewallRules width={width} height={height} allowed={allowed} active={firewall?.active === true}
                           onBack={() => setView(LIST)} />
        );
    }

    if (detailed) {
        const lines = detailLines(detailed, settings, store.traffic.get(detailed.name), inner);
        if (actions.length && !allowed)
            lines.push("", { text: "Changing it requires administrative access: press A.", color: colors.warning });
        return (
            <>
                <Panel plain={!boxed} title={clean(detailed.name)} detail={clean(detailed.stateText)} width={width} height={height}>
                    <ScrollView lines={lines} width={inner} height={boxed ? height - PANEL_EDGE : height} active={question === null} />
                </Panel>
                {dialog}
            </>
        );
    }

    const throughput = store.throughput;
    const firewallLine = firewall ? clean(firewallText(firewall)) : `${glyphs.ellipsis}`;
    const firewallColor = !firewall?.installed ? colors.dim : firewall.active ? colors.ok : colors.warning;
    const table = (
        <Table rows={rows} columns={columnsFor(rows, store.traffic)} nav={nav} width={inner} height={tableHeight}
               focused={question === null} empty="No network interfaces." />
    );

    if (!boxed) {
        return (
            <Box flexDirection="column" width={width} height={height}>
                <Text wrap="truncate">
                    <Text color={colors.dim}>Sending </Text>{fit(throughput.tx === null ? glyphs.ellipsis : formatBitRate(throughput.tx), 11)}
                    <Text color={colors.dim}>Receiving </Text>{throughput.rx === null ? glyphs.ellipsis : formatBitRate(throughput.rx)}
                </Text>
                <Text wrap="truncate"><Text color={colors.dim}>Firewall </Text><Text color={firewallColor}>{firewallLine}</Text></Text>
                {table}
                {dialog}
            </Box>
        );
    }
    return (
        <Box flexDirection="column" width={width} height={height}>
            <PlotPair width={width} rows={plotted} times={throughput.times} units={BIT_UNITS}
                      left={{ title: "Sending", samples: throughput.txHistory, current: throughput.tx }}
                      right={{ title: "Receiving", samples: throughput.rxHistory, current: throughput.rx }} />
            <Panel title="Firewall" detail={firewall?.defaultZone ? `default zone ${clean(firewall.defaultZone)}` : ""} width={width} height={1 + PANEL_EDGE}>
                <Text color={firewallColor} wrap="truncate">{firewallLine}</Text>
            </Panel>
            <Panel title="Interfaces" detail={store.warning ? truncate(clean(store.warning), Math.max(0, inner - 20)) : store.nmVersion ? `NetworkManager ${clean(store.nmVersion)}` : ""}
                   width={width} height={tableHeight + PANEL_EDGE}>
                {table}
            </Panel>
            {dialog}
        </Box>
    );
}

const EMPTY_SETTINGS: ReadonlyMap<string, Settings> = new Map();

function Retry({ width, height, text, onRetry }: { width: number, height: number, text: string, onRetry: () => void }) {
    useKeys((input, key) => {
        if (key.ctrl && input === "r") {
            onRetry();
            return true;
        }
        return false;
    }, { hints: [["ctrl+r", "retry"]] });
    return <Notice width={width} height={height} color={colors.error}>{text}</Notice>;
}
