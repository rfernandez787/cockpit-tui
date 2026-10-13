/*
 * Terminal page: the user's login shell, in a window of the page.
 *
 * As upstream, the shell runs in a terminal emulator (xterm.js; see
 * store.ts), and the page draws the emulator's screen inside a panel. The
 * TUI stays on screen around it: the header, the page menu and the help line
 * are where they always are.
 *
 * A shell needs every key -- Tab, digits, q and Ctrl+C mean something to it
 * -- and so does the TUI. So the keyboard is in one of two places:
 *
 *   on the page   Enter starts the shell, or goes into it; k kills it, r
 *                 starts a new one, PgUp/PgDn read back through its output.
 *                 Digits, Tab, A, ? and q are the shell's, as on any page.
 *   in the shell  every key goes to the shell. Ctrl+] comes back to the page
 *                 (telnet's and `virsh console`'s escape); from there, ]
 *                 sends the shell a literal Ctrl+].
 *
 * Unlike upstream, visiting the page does not start anything or take the
 * keyboard by itself: Tab cycles through every page, and landing in a shell
 * on the way, with no visible way out, would be a trap.
 *
 * The shell outlives the page. Leaving the page leaves it running, and its
 * output is still parsed; quitting asks first.
 *
 * What the keyboard cannot do here: Ink has parsed every key before the
 * page sees it, which loses the modifiers on arrows and function keys, and
 * the function keys themselves (keys.ts). The mouse is not passed on.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Box, InkText, Text } from "../../tui/ink.js";
import cockpit from "../../cockpit.js";
import { Layer, useKeys, type Hint } from "../../tui/keyboard.js";
import { captureKeyboard } from "../../tui/page.js";
import { useSession } from "../../tui/session-context.js";
import { useStatus } from "../../tui/status.js";
import { ConfirmDialog } from "../../tui/components/Dialog.js";
import { Panel, PANEL_EDGE, panelled } from "../../tui/components/Panel.js";
import { clean, fit, formatTimestamp, truncate } from "../../tui/text.js";
import { colors, glyphs, palette, styled, unicode } from "../../tui/theme.js";
import type { PageProps } from "../../tui/page.js";
import { describeEnding, isFailure, noBidi } from "./describe.js";
import { keyBytes } from "./keys.js";
import { screenRows, scrolledLines, type Row, type Run } from "./screen.js";
import { terminal, type TerminalSnapshot } from "./store.js";
import { windowSize, type WindowSize } from "./window.js";

/**
 * The kill question ignores Enter this long after it opens: a key typed for
 * the shell just as the keyboard came back must not answer it.
 */
export const KILL_ARM_MS = 500;

/** Ctrl+], as Ink reports it (a letter with ctrl) or as the byte itself. */
const DETACH = "\x1d";

/** Host text for the screen: no controls, no bidi reordering. */
function shown(text: string): string {
    return clean(noBidi(text));
}

/** "14:32" today, "2026-10-01 14:32" on another day. */
function at(ms: number): string {
    const stamp = formatTimestamp(ms, false);
    return stamp.slice(0, 10) === formatTimestamp(Date.now(), false).slice(0, 10) ? stamp.slice(11) : stamp;
}

/** What the shell is doing, in a few words: the panel's note, the status line. */
function stateText(s: TerminalSnapshot): { text: string, color?: string } {
    switch (s.phase) {
    case "idle":
        return { text: "Not started", color: colors.dim };
    case "starting":
        return { text: `Starting${glyphs.ellipsis}`, color: colors.warning };
    case "running":
        return { text: s.pid !== null ? `Running, pid ${s.pid}` : "Running", color: colors.ok };
    case "ended": {
        const ending = s.ending ?? { kind: "ended" as const };
        const when = s.endedAt !== null ? ` at ${at(s.endedAt)}` : "";
        return {
            text: shown(describeEnding(ending, s.launch?.shell ?? null, s.launch?.home ?? null)) + when,
            color: isFailure(ending) ? colors.error : colors.dim,
        };
    }
    }
}

function killMessage(s: TerminalSnapshot, busy: boolean | null): string {
    const shell = s.launch ? shown(s.launch.shell) : "The shell";
    const who = s.pid !== null ? `${shell} (pid ${s.pid})` : shell;
    if (busy === true)
        return `A program is still running in ${who}. Killing the shell ends the session, and the programs in it get SIGHUP.`;
    if (busy === false)
        return `${who} is waiting at its prompt. Killing it ends the session.`;
    return `Killing ${who} ends the session; any program running in it gets SIGHUP.`;
}

// ---- the screen ---------------------------------------------------------------------

/** One run of cells in its colours. Without colour, only what a monochrome terminal has. */
function RunText({ run }: { run: Run }) {
    const attributes = {
        ...(run.bold ? { bold: true } : {}),
        ...(run.dim ? { dimColor: true } : {}),
        ...(run.italic ? { italic: true } : {}),
        ...(run.underline ? { underline: true } : {}),
    };
    if (!styled)
        return <InkText {...attributes} {...(run.inverse ? { inverse: true } : {})}>{run.text}</InkText>;
    // Swapped by hand: Ink's own `inverse` would swap the terminal's colours, not the window's.
    const fg = run.inverse ? run.bg ?? palette.window.bg : run.fg ?? palette.window.fg;
    const bg = run.inverse ? run.fg ?? palette.window.fg : run.bg;
    return <InkText {...attributes} color={fg} {...(bg ? { backgroundColor: bg } : {})}>{run.text}</InkText>;
}

function ScreenRow({ row }: { row: Row }) {
    return (
        <InkText wrap="truncate">
            {row.length === 0 ? " " : row.map((run, i) => <RunText key={i} run={run} />)}
        </InkText>
    );
}

// ---- before the first shell -----------------------------------------------------------

function IdleView({ snapshot, width, height, subtitle }: {
    snapshot: TerminalSnapshot, width: number, height: number, subtitle: string,
}) {
    const boxed = panelled(width, height);
    const inner = Math.max(1, width - 2 - (boxed ? PANEL_EDGE : 0));
    const state = stateText(snapshot);
    const fields: [string, string, string?][] = [
        ["State", snapshot.connectionLost ? "The connection is gone" : state.text, snapshot.connectionLost ? colors.error : state.color],
        ["Shell", snapshot.launch ? shown(snapshot.launch.shell) : glyphs.ellipsis],
        ["Directory", snapshot.launch ? shown(snapshot.launch.home ?? "the bridge's own") : glyphs.ellipsis],
    ];
    if (snapshot.error)
        fields.push(["Error", shown(snapshot.error), colors.error]);
    const keys: [string, string][] = snapshot.connectionLost
        ? [["q", "quit"]]
        : [
            ["Enter", `start ${snapshot.launch ? shown(snapshot.launch.shell) : "the shell"} here`],
            ["Ctrl+]", "come back to the page from the shell"],
        ];
    const field = ([label, value, color]: [string, string, string?], i: number) => (
        <Text key={`f${i}`} wrap="truncate">
            <Text color={colors.dim}>{fit(label, 11)}</Text>
            <Text color={color}>{truncate(value, Math.max(1, inner - 11))}</Text>
        </Text>
    );
    const keyLine = ([name, text]: [string, string], i: number) => (
        <Text key={`k${i}`} wrap="truncate">
            <Text bold color={colors.accent}>{fit(name, 9)}</Text>
            {truncate(text, Math.max(1, inner - 9))}
        </Text>
    );
    if (boxed) {
        return (
            <Box flexDirection="column" width={width} height={height}>
                <Panel title="Session" detail={subtitle} width={width} height={fields.length + PANEL_EDGE}>
                    <Box flexDirection="column" paddingX={1}>{fields.map(field)}</Box>
                </Panel>
                <Panel title="Keys" width={width} height={keys.length + PANEL_EDGE}>
                    <Box flexDirection="column" paddingX={1}>{keys.map(keyLine)}</Box>
                </Panel>
            </Box>
        );
    }
    return (
        <Box flexDirection="column" width={width} height={height} paddingX={1}>
            {fields.map(field)}
            <Text> </Text>
            {keys.map(keyLine)}
        </Box>
    );
}

// ---- the page ---------------------------------------------------------------------------

export default function TerminalPage({ width, height }: PageProps) {
    const snapshot = useSyncExternalStore(terminal.subscribe, terminal.getSnapshot);
    const { session, hostname } = useSession();
    const { notify } = useStatus();
    const [focused, setFocused] = useState(false);
    const [killing, setKilling] = useState<{ busy: boolean | null, openedAt: number } | null>(null);
    const probe = useRef(0);

    useEffect(() => {
        terminal.prepare(session?.transport ?? null);
    }, [session]);

    // The room the screen has: inside the panel, or under a status line.
    const boxed = panelled(width, height);
    const cols = Math.max(1, boxed ? width - PANEL_EDGE : width);
    const rows = Math.max(1, boxed ? height - PANEL_EDGE : height - 1);
    const room: WindowSize = windowSize(rows, cols) ?? { rows: 24, cols: 80 };
    useEffect(() => {
        terminal.resize({ rows, cols });
    }, [rows, cols]);

    const alive = snapshot.phase === "starting" || snapshot.phase === "running";
    // The shell ended: there is nobody to type to, and nothing left to ask.
    useEffect(() => {
        if (!alive) {
            setFocused(false);
            setKilling(null);
        }
    }, [alive]);

    // While the shell has the keyboard, Ctrl+C is its too (page.ts).
    const inShell = focused && alive && killing === null;
    useEffect(() => {
        captureKeyboard(inShell);
        return () => captureKeyboard(false);
    }, [inShell]);

    const start = () => {
        terminal.start(room);
        setFocused(true);
    };

    const askKill = () => {
        const token = ++probe.current;
        setKilling({ busy: null, openedAt: Date.now() });
        void terminal.busy().then(busy => {
            if (probe.current === token)
                setKilling(current => (current ? { ...current, busy } : current));
        });
    };

    // ---- the keyboard in the shell: everything goes there ------------------------------
    useKeys((input, key) => {
        if ((key.ctrl && input === "]") || input === DETACH) {
            setFocused(false);
            return true;
        }
        const modes = terminal.modes;
        // A run of text with a line break in it is a paste: typed, every
        // Enter arrives as a key of its own (keyboard.tsx splitInput).
        // Programs that ask for pastes to be marked get those marked, so a
        // pasted newline is text and not a command run. A run without one may
        // just be fast typing, and goes as typed.
        if (input.length > 1 && /[\r\n]/.test(input) && !key.ctrl && !key.meta && modes.bracketedPaste)
            terminal.type(`\x1b[200~${input.replace(/\r?\n/g, "\r")}\x1b[201~`);
        else
            terminal.type(keyBytes(input.length > 1 ? input.replace(/\r?\n/g, "\r") : input, key, modes));
        return true;
    }, {
        layer: Layer.input,
        trap: true,
        active: inShell,
        hints: [["ctrl+]", "back to the page"]],
        help: [["ctrl+]", "give the keyboard back to the page; every other key goes to the shell"]],
    });

    // ---- the keyboard on the page -------------------------------------------------------
    const hasScreen = snapshot.phase !== "idle" && terminal.emulator !== null;
    const hints: Hint[] = snapshot.connectionLost && !alive ? []
        : snapshot.phase === "idle" ? [["enter", "start shell"]]
        : alive ? [["enter", "type in the shell"], ["k", "kill"], ["PgUp PgDn", "scroll"], ["]", "send ^]"]]
        // After a kill only r: the Enter that answered the question may come twice.
        : snapshot.ending?.kind === "killed" ? [["r", "new shell"], ["PgUp PgDn", "scroll"]]
        : [["enter r", "new shell"], ["PgUp PgDn", "scroll"]];

    useKeys((input, key) => {
        const s = terminal.getSnapshot();
        const live = s.phase === "starting" || s.phase === "running";
        if (key.return) {
            if (live)
                setFocused(true);
            // Not after a kill: a second Enter on the heels of the one that
            // confirmed it (a key repeat) would start a shell nobody asked for.
            else if (!s.connectionLost && s.ending?.kind !== "killed")
                start();
            return true;
        }
        if (hasScreen && (key.pageUp || key.pageDown || key.upArrow || key.downArrow || key.home || key.end)) {
            const page = Math.max(1, rows - 1);
            if (key.home)
                terminal.scroll(-1_000_000);
            else if (key.end)
                terminal.scrollToBottom();
            else
                terminal.scroll(key.pageUp ? -page : key.pageDown ? page : key.upArrow ? -1 : 1);
            return true;
        }
        if (key.ctrl || key.meta)
            return false;
        if (input === "k" && live) {
            askKill();
            return true;
        }
        if (input === "r" && s.phase === "ended" && !s.connectionLost) {
            start();
            return true;
        }
        if (input === "]" && live) {
            terminal.type(DETACH);
            setFocused(true);
            return true;
        }
        return false;
    }, { active: !inShell && killing === null, hints });

    const user = clean(cockpit.info?.user?.name ?? "");
    const subtitle = user ? `${user}@${clean(hostname)}` : clean(hostname);
    const emulator = terminal.emulator;

    let body;
    if (!hasScreen || !emulator) {
        body = <IdleView snapshot={snapshot} width={width} height={height} subtitle={subtitle} />;
    } else {
        // `snapshot.version` is why this is read again: the emulator is mutated in place.
        const lines = screenRows(emulator, { cursor: inShell, ascii: !unicode }).slice(0, rows);
        const back = scrolledLines(emulator);
        const state = stateText(snapshot);
        const note = inShell ? "Ctrl+] back to the page"
            : back > 0 ? `${back} line${back === 1 ? "" : "s"} up`
            : alive ? "Enter to type here" : state.text;
        const title = snapshot.title ? shown(snapshot.title) : subtitle;
        const screen = (
            <Box flexDirection="column" width={cols} height={rows} overflow="hidden">
                {lines.map((row, i) => <ScreenRow key={i} row={row} />)}
            </Box>
        );
        body = boxed
            ? (
                <Panel title={truncate(title, Math.max(8, cols - note.length - 8))} detail={note} width={width} height={height}>
                    {screen}
                </Panel>
            )
            : (
                <Box flexDirection="column" width={width} height={height}>
                    <Text wrap="truncate">
                        <Text bold color={colors.accent}>{truncate(title, Math.max(8, width - note.length - 3))}</Text>
                        <Text color={inShell ? colors.accent : alive ? colors.dim : state.color}>{`  ${note}`}</Text>
                    </Text>
                    {screen}
                </Box>
            );
    }

    return (
        <Box flexDirection="column" width={width} height={height}>
            {body}
            {killing && alive && (
                <ConfirmDialog
                    title="Kill the shell?"
                    message={killMessage(snapshot, killing.busy)}
                    confirmLabel="Kill"
                    danger
                    onConfirm={() => {
                        if (Date.now() - killing.openedAt < KILL_ARM_MS)
                            return; // typed on, not an answer (see KILL_ARM_MS)
                        const pid = terminal.getSnapshot().pid;
                        terminal.kill();
                        setKilling(null);
                        notify(pid !== null ? `Closed the shell (pid ${pid})` : "Closed the shell", "success");
                    }}
                    onCancel={() => setKilling(null)}
                />
            )}
        </Box>
    );
}
