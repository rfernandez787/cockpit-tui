/*
 * The firewall's rules, as a view of the Networking page: each active zone
 * with the services and ports it lets in, adding services from firewalld's
 * list, opening custom ports, and removing either.
 * Upstream: pkg/networkmanager/firewall.jsx (cockpit 356).
 *
 *     Zone / service     TCP            UDP        Description
 *   › public             eth0
 *       cockpit          9090                      Cockpit
 *       ssh              22                        SSH
 *       8080/tcp         8080                      port
 *
 * Reading the rules needs administrative access (firewall.ts says why), and
 * so does changing them; without it the view says so.
 */
import { useMemo, useRef, useState } from "react";
import { Box, Text } from "../../tui/ink.js";
import { useKeys, type Hint, type KeyHandler } from "../../tui/keyboard.js";
import { ConfirmDialog, Dialog, dialogInnerWidth, useArea, useDialogWidth } from "../../tui/components/Dialog.js";
import { FormDialog } from "../../tui/components/Form.js";
import { Notice } from "../../tui/components/misc.js";
import { Panel, PANEL_EDGE, panelled } from "../../tui/components/Panel.js";
import { Spinner } from "../../tui/components/Spinner.js";
import { Table, useListNav, type Column } from "../../tui/components/Table.js";
import { useAsync, useMounted } from "../../tui/hooks.js";
import { errorText, useStatus } from "../../tui/status.js";
import { fit, truncate, width as textWidth } from "../../tui/text.js";
import { colors, glyphs } from "../../tui/theme.js";
import { clean } from "../../lib/hosttext.js";
import {
    addPorts, addServices, LIFELINES, parsePorts, portList, readAvailableServices, readRules, removePort, removeService, ruleRows,
    type PortSpec, type RuleRow, type ServiceInfo, type ZoneInfo,
} from "./firewall.js";

/** How long a question is up before Enter answers it: see services/dialogs.tsx. */
const CONFIRM_ARM_MS = 300;

/** Run a change: busy while it runs, the error if it fails; the footer and `onDone` when it worked. */
function useRunner(onDone: () => void) {
    const { notify } = useStatus();
    const mounted = useMounted();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const running = useRef(false);
    const start = (work: () => Promise<string>) => {
        if (running.current)
            return;
        running.current = true;
        setBusy(true);
        setError(null);
        work().then(message => {
            notify(clean(message), "success");
            if (mounted())
                onDone();
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
    return { busy, error, start };
}

// ---- dialogs -------------------------------------------------------------------------

/**
 * Pick services to let into a zone from all that firewalld knows. Typing
 * narrows the list; Space marks, Enter adds what is marked (or the one the
 * cursor is on).
 */
function ServicePicker({ zone, onDone, onClose }: { zone: ZoneInfo, onDone: () => void, onClose: () => void }) {
    const area = useArea();
    const width = useDialogWidth(72);
    const inner = dialogInnerWidth(width);
    const available = useAsync(() => readAvailableServices(), []);
    const [filter, setFilter] = useState("");
    const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
    const [cursorState, setCursor] = useState(0);
    const runner = useRunner(onDone);

    const shown = useMemo(() => {
        const needle = filter.toLowerCase();
        const taken = new Set(zone.services);
        return (available.value ?? []).filter(service => !taken.has(service.id) &&
            (!needle || service.id.toLowerCase().includes(needle) || service.name.toLowerCase().includes(needle) ||
             service.ports.some(p => p.port === needle)));
    }, [available.value, filter, zone.services]);
    const cursor = Math.max(0, Math.min(shown.length - 1, cursorState));
    const rows = Math.max(3, Math.min(12, area.height - 10));
    const top = Math.max(0, Math.min(Math.max(0, shown.length - rows), cursor - Math.floor(rows / 2)));

    const onKey: KeyHandler = (input, key) => {
        if (runner.busy)
            return true;
        if (key.upArrow) { setCursor(Math.max(0, cursor - 1)); return true }
        if (key.downArrow) { setCursor(Math.min(shown.length - 1, cursor + 1)); return true }
        if (key.pageUp) { setCursor(Math.max(0, cursor - rows)); return true }
        if (key.pageDown) { setCursor(Math.min(shown.length - 1, cursor + rows)); return true }
        if (key.return) {
            const chosen = marked.size ? [...marked] : shown[cursor] ? [shown[cursor]!.id] : [];
            if (chosen.length)
                runner.start(() => addServices(zone.id, chosen));
            return true;
        }
        if (key.backspace || key.delete) {
            setFilter(filter.slice(0, -1));
            setCursor(0);
            return true;
        }
        if (key.ctrl || key.meta || key.escape || key.tab)
            return false;
        if (input === " ") {
            const service = shown[cursor];
            if (service) {
                const next = new Set(marked);
                if (!next.delete(service.id))
                    next.add(service.id);
                setMarked(next);
            }
            return true;
        }
        if (input && !/\s/.test(input)) {
            setFilter(filter + input);
            setCursor(0);
            return true;
        }
        return false;
    };

    const idWidth = Math.max(12, Math.min(24, ...shown.map(s => textWidth(s.id) + 1)));
    let body;
    if (available.value === undefined && !available.error) {
        body = <Box marginTop={1}><Spinner label={`Asking firewalld what services it knows${glyphs.ellipsis}`} /></Box>;
    } else if (available.error && available.value === undefined) {
        body = <Text color={colors.error} wrap="truncate">{truncate(clean(errorText(available.error)), inner)}</Text>;
    } else {
        body = (
            <Box flexDirection="column" marginTop={1}>
                <Text wrap="truncate">
                    <Text color={colors.accent}>Filter: </Text>{clean(filter)}<Text color={colors.dim}>{filter ? "" : "type to narrow the list"}</Text>
                </Text>
                {shown.length === 0
                    ? <Text color={colors.dim}>No service matches.</Text>
                    : shown.slice(top, top + rows).map((service, i) => {
                        const index = top + i;
                        const tcp = portList(service.ports, "tcp");
                        const udp = portList(service.ports, "udp");
                        const what = [tcp ? `tcp ${tcp}` : "", udp ? `udp ${udp}` : ""].filter(Boolean).join("  ");
                        return (
                            <Text key={service.id} inverse={index === cursor} wrap="truncate">
                                {fit(`${index === cursor ? glyphs.pointer : " "}${marked.has(service.id) ? "[x]" : "[ ]"} ${fit(clean(service.id), idWidth)}${clean(what)}`, inner)}
                            </Text>
                        );
                    })}
                <Text color={colors.dim} wrap="truncate">
                    {`${shown.length} service${shown.length === 1 ? "" : "s"}${marked.size ? `, ${marked.size} marked` : ""}`}
                </Text>
            </Box>
        );
    }
    return (
        <Dialog title={clean(`Add services to ${zone.id}`)} width={width} onCancel={runner.busy ? undefined : onClose} onKey={onKey}
                hints={[["space", "mark"], ["enter", "add"], ["esc", "cancel"]]}>
            {body}
            {runner.error ? <Text color={colors.error} wrap="truncate">{truncate(runner.error, inner)}</Text> : null}
            <Box marginTop={1}>
                {runner.busy
                    ? <Spinner label={`Adding${glyphs.ellipsis}`} />
                    : <Text color={colors.dim} wrap="truncate">[Space] mark [Enter] add [Esc] cancel</Text>}
            </Box>
        </Dialog>
    );
}

/** Open ports that are not one of firewalld's services: TCP, UDP, or both. */
function PortsDialog({ zone, onDone, onClose }: { zone: ZoneInfo, onDone: () => void, onClose: () => void }) {
    const [tcp, setTcp] = useState("");
    const [udp, setUdp] = useState("");
    const [problems, setProblems] = useState<{ tcp?: string, udp?: string }>({});
    const runner = useRunner(onDone);

    const submit = () => {
        const t = parsePorts(tcp);
        const u = parsePorts(udp);
        const next = { ...("error" in t ? { tcp: t.error } : {}), ...("error" in u ? { udp: u.error } : {}) };
        if ("ports" in t && "ports" in u && t.ports.length + u.ports.length === 0)
            next.tcp = "Give at least one port";
        setProblems(next);
        if (next.tcp || next.udp || "error" in t || "error" in u)
            return;
        const list: PortSpec[] = [
            ...t.ports.map(port => ({ port, protocol: "tcp" })),
            ...u.ports.map(port => ({ port, protocol: "udp" })),
        ];
        runner.start(() => addPorts(zone.id, list));
    };

    return (
        <FormDialog
            title={clean(`Open ports in ${zone.id}`)}
            intro="Ports, comma-separated; a range as 9000-9010. They are open now and after a reboot."
            fields={[
                { id: "tcp", kind: "text", label: "TCP", value: tcp, placeholder: "8080, 9000-9010", error: problems.tcp ?? null },
                { id: "udp", kind: "text", label: "UDP", value: udp, placeholder: "53", error: problems.udp ?? null },
            ]}
            submitLabel="Open"
            busy={runner.busy}
            busyText={`Opening${glyphs.ellipsis}`}
            error={runner.error}
            onChange={(id, value) => {
                if (id === "tcp")
                    setTcp(String(value));
                else
                    setUdp(String(value));
                setProblems({});
            }}
            onSubmit={submit}
            onCancel={onClose}
        />
    );
}

function RemoveDialog({ row, onDone, onClose }: { row: RuleRow & { kind: "service" | "port" }, onDone: () => void, onClose: () => void }) {
    const runner = useRunner(onDone);
    const what = row.kind === "service" ? row.service.id : `${row.port.port}/${row.port.protocol}`;
    const lifeline = row.kind === "service" ? LIFELINES[row.service.id] : undefined;
    const ports = row.kind === "service"
        ? [portList(row.service.ports, "tcp") && `TCP ${portList(row.service.ports, "tcp")}`, portList(row.service.ports, "udp") && `UDP ${portList(row.service.ports, "udp")}`].filter(Boolean).join(", ")
        : "";
    const message = row.kind === "service"
        ? `Remove ${what} from the zone ${row.zone.id}? ${ports ? `Its ports (${ports}) are` : "It is"} then closed to ${row.zone.interfaces.join(", ") || "that zone"}, now and after a reboot.` +
          (lifeline ? ` This is what lets in ${lifeline}: if you are connected that way, you are locked out.` : "")
        : `Close port ${what} in the zone ${row.zone.id}, now and after a reboot?`;
    return (
        <ConfirmDialog
            title={clean(`Remove ${what}`)}
            message={clean(message)}
            confirmLabel="Remove"
            danger
            busy={runner.busy}
            busyText={`Removing${glyphs.ellipsis}`}
            error={runner.error}
            armMs={CONFIRM_ARM_MS}
            onConfirm={() => runner.start(() => (row.kind === "service" ? removeService(row.zone.id, row.service.id) : removePort(row.zone.id, row.port)))}
            onCancel={onClose}
        />
    );
}

// ---- the view ------------------------------------------------------------------------

type DialogState =
    | { readonly kind: "services", readonly zone: ZoneInfo }
    | { readonly kind: "ports", readonly zone: ZoneInfo }
    | { readonly kind: "remove", readonly row: RuleRow & { kind: "service" | "port" } };

const COLUMNS: Column<RuleRow>[] = [
    {
        id: "name", title: "Zone / service", grow: 2, minWidth: 18,
        value: row => (row.kind === "zone" ? clean(row.zone.id)
            : row.kind === "service" ? `  ${clean(row.service.id)}` : `  ${clean(row.port.port)}/${clean(row.port.protocol)}`),
        color: row => (row.kind === "zone" ? colors.accent : undefined),
    },
    {
        id: "tcp", title: "TCP", grow: 1, minWidth: 10,
        value: row => (row.kind === "zone" ? clean(row.zone.interfaces.join(", "))
            : row.kind === "service" ? clean(portList(row.service.ports, "tcp")) : row.port.protocol === "tcp" ? clean(row.port.port) : ""),
        color: row => (row.kind === "zone" ? colors.dim : undefined),
    },
    {
        id: "udp", title: "UDP", grow: 1, minWidth: 8,
        value: row => (row.kind === "service" ? clean(portList(row.service.ports, "udp")) : row.kind === "port" && row.port.protocol === "udp" ? clean(row.port.port) : ""),
    },
    {
        id: "description", title: "Description", grow: 2, minWidth: 12, dropPriority: 1,
        value: row => (row.kind === "zone" ? (row.zone.sources.length ? clean(`sources ${row.zone.sources.join(", ")}`) : "zone")
            : row.kind === "service" ? clean(row.service.name) : "custom port"),
        color: () => colors.dim,
    },
];

export function FirewallRules({ width, height, allowed, active, onBack }: {
    width: number, height: number,
    /** Administrative access is on. */
    allowed: boolean,
    /** firewalld is running. */
    active: boolean,
    onBack: () => void,
}) {
    const boxed = panelled(width, height);
    const inner = boxed ? width - PANEL_EDGE : width;
    const tableHeight = boxed ? height - PANEL_EDGE : height;
    const readable = allowed && active;
    const rules = useAsync(() => (readable ? readRules() : Promise.resolve(null)), [readable]);
    const [dialog, setDialog] = useState<DialogState | null>(null);
    const rows = useMemo(() => (rules.value ? ruleRows(rules.value) : []), [rules.value]);
    const keys = useMemo(() => rows.map(row => row.key), [rows]);
    const nav = useListNav(keys, Math.max(1, tableHeight - 1), { active: dialog === null && readable });
    const selected = nav.index >= 0 ? rows[nav.index] ?? null : null;

    const hints: Hint[] = [
        ["esc", "back"],
        ...(selected ? [["a", "add services"] as const, ["p", "open ports"] as const] : []),
        ...(selected && selected.kind !== "zone" ? [["d", "remove"] as const] : []),
        ["ctrl+r", "refresh"],
    ];

    useKeys((input, key) => {
        if (key.escape || key.backspace) {
            onBack();
            return true;
        }
        if (key.ctrl && input === "r") {
            rules.reload();
            return true;
        }
        if (key.ctrl || key.meta || !selected)
            return false;
        if (input === "j" || input === "k") {
            nav.select(nav.index + (input === "j" ? 1 : -1));
            return true;
        }
        if (input === "a") {
            setDialog({ kind: "services", zone: selected.zone });
            return true;
        }
        if (input === "p") {
            setDialog({ kind: "ports", zone: selected.zone });
            return true;
        }
        if (input === "d" && selected.kind !== "zone") {
            setDialog({ kind: "remove", row: selected });
            return true;
        }
        return false;
    }, { active: dialog === null, hints: readable ? hints : [["esc", "back"]] });

    const done = () => {
        setDialog(null);
        rules.reload();
    };

    let body;
    if (!allowed) {
        body = <Notice width={inner} height={tableHeight}>The firewall's rules can only be read and changed with administrative access: press A. Esc goes back.</Notice>;
    } else if (!active) {
        body = <Notice width={inner} height={tableHeight}>The firewall is off: there are no rules in force. Esc goes back; F there switches it on.</Notice>;
    } else if (rules.value === undefined && !rules.error) {
        body = <Notice width={inner} height={tableHeight} loading>Reading the firewall's rules</Notice>;
    } else if (rules.error && !rules.value) {
        body = <Notice width={inner} height={tableHeight} color={colors.error}>{`${clean(errorText(rules.error))}. Press Ctrl+R to try again.`}</Notice>;
    } else {
        body = (
            <Table rows={rows} columns={COLUMNS} nav={nav} width={inner} height={tableHeight} focused={dialog === null}
                   empty="No zone is active: no interface is assigned to one." />
        );
    }

    return (
        <Box flexDirection="column" width={width} height={height}>
            <Panel plain={!boxed} title="Firewall rules" detail={rules.value ? `${rules.value.zones.length} active zone${rules.value.zones.length === 1 ? "" : "s"}` : ""}
                   width={width} height={height}>
                {body}
            </Panel>
            {dialog?.kind === "services" && <ServicePicker zone={dialog.zone} onDone={done} onClose={() => setDialog(null)} />}
            {dialog?.kind === "ports" && <PortsDialog zone={dialog.zone} onDone={done} onClose={() => setDialog(null)} />}
            {dialog?.kind === "remove" && <RemoveDialog row={dialog.row} onDone={done} onClose={() => setDialog(null)} />}
        </Box>
    );
}
