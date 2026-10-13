/*
 * The shell: header, page menu, the current page, and the footer.
 *
 *    host                                      user · Limited access
 *    ┌──────────────────────┤ Overview ├───────────────────────────┐
 *    │┌─┤ Pages ├──┐ ┌─┤ Health ├───────┐ ┌─┤ Usage ├───────────┐  │▒
 *    ││›1 Overview │▒│  the current page, in panels of its own   │▒ │▒
 *    ││ 2 Logs     │▒└──────────────────┘▒└─────────────────────┘▒ │▒
 *    │└────────────┘▒ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ │▒
 *    │ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒                                              │▒
 *    └─────────────────────────────────────────────────────────────┘▒
 *      ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
 *    key hints, or the latest status message
 *
 * It is dressed as newt draws nmtui: root text and a help line on a blue
 * root, and between them one grey window with a shadow. Inside it the page
 * menu and the parts of the page are panels (components/Panel.tsx): small
 * windows with shadows of their own. A terminal too small to spare the rows and columns gets
 * the window without its border, and the page without its panels.
 *
 * Only the current page is mounted. Its key includes the privilege
 * generation, so a change of administrative access remounts it and every
 * channel it holds is reopened against the right bridge.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useApp } from "ink";
import { Box, InkText, SurfaceProvider, Text } from "./ink.js";
import { useTerminalSize } from "./size.js";
import { useFooterHints, useKeyboard, useKeys, Layer, isPlain, type Hint } from "./keyboard.js";
import { usePrivilege } from "./privilege.js";
import { usePersistentStore, useSession } from "./session-context.js";
import { NavigationProvider, paramsKey, type Navigation } from "./navigation.js";
import { errorText, useStatus, useStatusMessage } from "./status.js";
import { AreaProvider, ConfirmDialog, Dialog, DialogText, dialogInnerWidth, useArea, useDialogWidth } from "./components/Dialog.js";
import { ScrollView } from "./components/ScrollView.js";
import { ErrorBoundary, Notice } from "./components/misc.js";
import { AdminDialog } from "./admin.js";
import { PAGES } from "./pages.js";
import { expectedDisconnectReason, keyboardCaptured, quitGuards } from "./page.js";
import { clean, cleanLines, fit, formatTimestamp, truncate, width as textWidth, wrap } from "./text.js";
import { colors, glyphs, palette, rootColors, listThemes, setTheme, styled, subscribeTheme, themeName, themeVersion, type ThemeName } from "./theme.js";
import { writeConfig } from "../config.js";
import { Window } from "./components/Window.js";
import { Panel, PANEL_EDGE, panelled, panelsEnabled } from "./components/Panel.js";
import { logEntries, onInternalError, onLog, record } from "./log.js";
import cockpit from "../cockpit.js";

export const MIN_COLUMNS = 50;
export const MIN_ROWS = 12;
/** Below this width the page menu folds away; pages stay reachable by number. */
const SIDEBAR_MIN_COLUMNS = 72;
const SIDEBAR_WIDTH = 14;
/** Below this size the window's border and shadow give their room to the page. */
const FRAME_MIN_COLUMNS = 60;
const FRAME_MIN_ROWS = 16;
/** What the frame takes: a margin, the border and the shadow; the border and the shadow's row. */
const FRAME_COLUMNS = 5;
const FRAME_ROWS = 3;

export interface ExitResult {
    readonly code: number;
    /** Printed after the terminal is restored. */
    readonly message?: string;
}

type Modal = null | "help" | "log" | "theme" | "admin" | "quit";

export interface AppProps {
    readonly initialPage?: number;
    /** Open the administrative access dialog straight away (--admin). */
    readonly requestAdmin?: boolean;
}

export function App({ initialPage = 0, requestAdmin = false }: AppProps) {
    const { exit } = useApp();
    const { columns, rows } = useTerminalSize();
    const { session, hostname } = useSession();
    const privilege = usePrivilege();
    const { notify } = useStatus();
    // Re-render the shell when the colour scheme changes (theme.ts changes the palette in place).
    // The version changes when the scheme in use is edited as well (the Colours page); only
    // another scheme, by name, remounts the page.
    useSyncExternalStore(subscribeTheme, themeVersion);
    const scheme = themeName();
    const [current, setCurrent] = useState(() => Math.max(0, Math.min(PAGES.length - 1, initialPage)));
    const [modal, setModal] = useState<Modal>(requestAdmin ? "admin" : null);
    // A connection that dropped before this mounted would never fire "close"
    // at us: start from the transport's own record.
    const [lost, setLost] = useState<string | null>(() => session?.transport.closedProblem ?? null);
    // Bumped by navigation.go(), so the target remounts and reads its params
    // even when it is the page already showing.
    const [visit, setVisit] = useState(0);
    const store = usePersistentStore();
    const keyboard = useKeyboard();
    // The page's own keys, taken when help opens (the dialog hides them).
    const [pageHints, setPageHints] = useState<readonly Hint[]>([]);

    const navigation = useMemo<Navigation>(() => ({
        go(pageId, params) {
            const index = PAGES.findIndex(page => page.id === pageId);
            if (index < 0)
                return;
            if (params)
                store?.set(paramsKey(pageId), params);
            setCurrent(index);
            setVisit(n => n + 1);
        },
    }), [store]);

    // Bugs that escaped a handler or timer: shown, logged, survived (run.tsx).
    useEffect(() => onInternalError(error => {
        notify(`Internal error: ${clean(errorText(error))} (press ? then l for the log)`, "error");
    }), [notify]);

    // The connection dropping ends the session: there is no reconnect, since
    // every channel and the cockpit library's own state went with it.
    useEffect(() => {
        if (!session)
            return;
        const closed = session.transport.closedProblem;
        if (closed !== null) {
            setModal(null);
            setLost(closed);
            return;
        }
        return session.transport.on("close", problem => {
            record("error", `connection closed: ${problem ?? "disconnected"}`);
            setModal(null);
            setLost(problem ?? "disconnected");
        });
    }, [session]);

    const quit = (result: ExitResult = { code: 0 }) => exit(result);

    // After a requested reboot or power-off the dropped connection is the
    // expected outcome, not a failure.
    const lostResult = (): ExitResult => {
        const expected = expectedDisconnectReason();
        return expected
            ? { code: 0, message: `cockpit-tui: ${expected}` }
            : { code: 1, message: `cockpit-tui: connection lost (${lost})` };
    };

    const requestQuit = () => {
        if (lost) {
            quit(lostResult());
            return;
        }
        if (quitGuards().length > 0)
            setModal("quit");
        else
            quit();
    };

    const tooSmall = columns < MIN_COLUMNS || rows < MIN_ROWS;

    // Ctrl+C quits from anywhere, dialogs included -- but like q it asks first
    // while something would be lost (a running shell); a second Ctrl+C in that
    // question quits. When the terminal is too small to show the question, it
    // quits at once, as the size notice says.
    useKeys((input, key) => {
        if (!(key.ctrl && input === "c"))
            return false;
        // A focused shell gets its Ctrl+C (page.ts); not when nothing of it can be seen.
        if (keyboardCaptured() && !lost && !tooSmall && modal === null)
            return false;
        if (!lost && !tooSmall && modal !== "quit" && quitGuards().length > 0)
            setModal("quit");
        else
            quit(lost ? lostResult() : { code: 0 });
        return true;
    }, { layer: Layer.system });

    // While too small, nothing is visible to act on: swallow every other key
    // so that typing blind cannot reach the hidden page or dialog.
    useKeys(() => true, { layer: Layer.system, active: tooSmall });

    useKeys((input, key) => {
        if (key.tab) {
            const step = key.shift ? -1 : 1;
            setCurrent(index => (index + step + PAGES.length) % PAGES.length);
            return true;
        }
        if (!isPlain(input, key))
            return false;
        if (/^[1-9]$/.test(input)) {
            const index = Number(input) - 1;
            if (index < PAGES.length)
                setCurrent(index);
            return true;
        }
        if (input === "q") {
            requestQuit();
            return true;
        }
        if (input === "?") {
            setPageHints(keyboard.helpHints());
            setModal("help");
            return true;
        }
        if (input === "A" && !lost) {
            setModal("admin");
            return true;
        }
        return false;
    }, {
        layer: Layer.global,
        active: modal === null,
        hints: lost ? [["q", "quit"]] : [[`1-${PAGES.length}`, "pages"], ["A", "admin"], ["?", "help"], ["q", "quit"]],
    });

    // Too small: keep everything mounted but hidden, laid out at the last
    // size that fit. Unmounting would cancel an open dialog -- a sudo prompt
    // would restart on its own once the terminal grew back -- and drop the
    // page's state; rendering at the tiny size would hand pages nonsense.
    const good = useRef({ columns: Math.max(columns, MIN_COLUMNS), rows: Math.max(rows, MIN_ROWS) });
    if (!tooSmall)
        good.current = { columns, rows };
    const width = good.current.columns;
    const height = good.current.rows;

    const showSidebar = width >= SIDEBAR_MIN_COLUMNS;
    const framed = width >= FRAME_MIN_COLUMNS && height >= FRAME_MIN_ROWS;
    const bodyHeight = height - 2 - (framed ? FRAME_ROWS : 0);
    const bodyWidth = width - (framed ? FRAME_COLUMNS : 0);
    // The page menu is a panel when the page beside it draws panels of its
    // own (the same test, so the two never disagree); otherwise a column and
    // a rule. In the window it takes a panel's width either way, or giving
    // the column back would make the page wide enough to change its mind.
    const sidebarWidth = showSidebar ? SIDEBAR_WIDTH + (framed && panelsEnabled() ? PANEL_EDGE : 1) : 0;
    const pageWidth = bodyWidth - sidebarWidth;
    const menuPanel = framed && panelled(pageWidth, bodyHeight);
    const page = PAGES[current]!;
    const Page = page.component;
    const host = clean(hostname);

    return (
        <>
        {tooSmall && (
            <Box width={columns} height={rows}>
                <InkText wrap="wrap">
                    {`The terminal is ${columns}x${rows}; cockpit-tui needs at least ${MIN_COLUMNS}x${MIN_ROWS}. ` +
                     "Enlarge it, or press Ctrl+C to quit."}
                </InkText>
            </Box>
        )}
        <Box display={tooSmall ? "none" : "flex"}>
        <AreaProvider area={{ width, height }}>
            <Box flexDirection="column" width={width} height={height}
                 {...(styled ? { backgroundColor: palette.root.bg } : {})}>
                <SurfaceProvider fg={palette.root.fg}>
                    <Header width={width} hostname={host} pageTitle={showSidebar ? null : page.title} />
                </SurfaceProvider>
                <Body framed={framed} title={page.title} width={bodyWidth} height={bodyHeight}>
                    {showSidebar && <Sidebar current={current} height={bodyHeight} width={sidebarWidth} panel={menuPanel} />}
                    <Box width={pageWidth} height={bodyHeight} overflow="hidden" flexDirection="column">
                        <AreaProvider area={{ width: pageWidth, height: bodyHeight }}>
                            {lost
                                ? expectedDisconnectReason()
                                    ? <Notice width={pageWidth} height={bodyHeight}>
                                        {`${expectedDisconnectReason()} The connection to ${host} has closed. Press q to quit.`}
                                    </Notice>
                                    : <Notice width={pageWidth} height={bodyHeight} color={colors.error}>
                                        {`Disconnected from ${host}: ${clean(lost)}. Press q to quit.`}
                                    </Notice>
                                : privilege.transitioning
                                    // No page, so no page channels, while access changes:
                                    // see privilege.tsx for what the bridge does meanwhile.
                                    ? <Notice width={pageWidth} height={bodyHeight} loading>Switching access</Notice>
                                : <ErrorBoundary
                                    // A new colour scheme remounts the page, as a change of access
                                    // does: pages bake colours into what they memoize.
                                    key={`${page.id}:${privilege.generation}:${visit}:${scheme}`}
                                    name={page.title}
                                    width={pageWidth}
                                    height={bodyHeight}
                                    onError={error => {
                                        record("error", `${page.id} page crashed: ${String((error as Error)?.stack ?? error)}`);
                                        notify(`The ${page.title} page failed`, "error");
                                    }}
                                >
                                    <NavigationProvider value={navigation}>
                                        <Page width={pageWidth} height={bodyHeight} />
                                    </NavigationProvider>
                                </ErrorBoundary>}
                        </AreaProvider>
                    </Box>
                </Body>
                <SurfaceProvider fg={palette.root.fg}>
                    <Footer width={width} />
                </SurfaceProvider>
                {/* The shell's dialogs centre on the screen between the header and
                    the help line, which shows their keys: neither is ever covered,
                    not even by a shadow. */}
                {modal !== null && (
                    <Box position="absolute" top={1} left={0} width={width} height={height - 2}>
                        <AreaProvider area={{ width, height: height - 2 }}>
                        {modal === "help" && <HelpDialog pageTitle={page.title} pageHints={pageHints}
                                                          onClose={() => setModal(null)} onLog={() => setModal("log")}
                                                          onTheme={() => setModal("theme")} />}
                        {modal === "theme" && <ThemeDialog onClose={() => setModal(null)} />}
                        {modal === "log" && <LogDialog onClose={() => setModal(null)} />}
                        {modal === "admin" && <AdminDialog onClose={() => setModal(null)} />}
                        {modal === "quit" && (
                            <ConfirmDialog
                                title="Quit cockpit-tui?"
                                message={quitGuards().join(" ")}
                                confirmLabel="Quit"
                                danger
                                armMs={600}
                                onConfirm={() => quit()}
                                onCancel={() => setModal(null)}
                            />
                        )}
                        </AreaProvider>
                    </Box>
                )}
            </Box>
        </AreaProvider>
        </Box>
        </>
    );
}

/**
 * The window between the header and the help line, holding the page menu and
 * the page. `width` and `height` are what is left inside it.
 */
function Body({ framed, title, width, height, children }: {
    framed: boolean, title: string, width: number, height: number, children: ReactNode,
}) {
    if (!framed) {
        return (
            <Box flexDirection="row" width={width} height={height}
                 {...(styled ? { backgroundColor: palette.window.bg } : {})}>
                {children}
            </Box>
        );
    }
    return (
        <Box height={height + FRAME_ROWS} paddingLeft={1} flexShrink={0}>
            <Window title={title} width={width + 2} height={height + 2} paddingX={0} shadowOn={palette.root.bg}>
                <Box flexDirection="row" width={width} height={height}>{children}</Box>
            </Window>
        </Box>
    );
}

function accessLabel(privilege: ReturnType<typeof usePrivilege>): { text: string, color?: string } {
    if (!privilege.superuser)
        return { text: "" };
    if (privilege.isRoot)
        return { text: "root", color: rootColors.warning };
    if (privilege.allowed === null)
        return { text: "Changing access" + glyphs.ellipsis, color: rootColors.dim };
    if (privilege.allowed)
        return { text: "Administrative access", color: rootColors.warning };
    return { text: "Limited access", color: rootColors.dim };
}

function Header({ width, hostname, pageTitle }: { width: number, hostname: string, pageTitle: string | null }) {
    const privilege = usePrivilege();
    const { session } = useSession();
    const access = accessLabel(privilege);

    // Right side: "user · Limited access". When space is short the user name
    // goes first; the access state is the part that matters.
    const dot = ` ${glyphs.dot} `;
    let user = clean(cockpit.info.user?.name ?? "");
    const rightMax = Math.max(0, Math.floor(width / 2) - 2);
    const join = (u: string) => [u, access.text].filter(Boolean).join(dot);
    if (textWidth(join(user)) > rightMax)
        user = "";
    const accessText = truncate(access.text, rightMax);
    const rightWidth = textWidth([user, accessText].filter(Boolean).join(dot));

    // The host name gives way before the page title (which is the only place
    // the page is named when the menu is folded away).
    const via = session && session.mode !== "local" ? ` (${session.mode})` : "";
    const leftWidth = Math.max(0, width - rightWidth - 4);
    const title = pageTitle ? ` ${glyphs.separator} ${pageTitle}` : "";
    const left = truncate(hostname + via, Math.max(1, leftWidth - textWidth(title))) + title;

    return (
        <Box width={width} height={1}>
            <InkText {...(styled ? { color: palette.root.fg } : { inverse: true })} wrap="truncate">
                {" "}
                <Text bold color={rootColors.accent}>{fit(left, leftWidth)}</Text>
                {"  "}
                {user}
                {user && accessText ? dot : ""}
                <Text color={access.color}>{accessText}</Text>
                {" "}
            </InkText>
        </Box>
    );
}

function Sidebar({ current, height, width, panel }: { current: number, height: number, width: number, panel: boolean }) {
    const items = PAGES.map((page, i) => {
        const selected = i === current;
        const label = `${selected ? glyphs.pointer : " "}${i + 1} ${page.title}`;
        return (
            <Text key={page.id} inverse={selected} bold={selected} wrap="truncate">
                {fit(label, SIDEBAR_WIDTH)}
            </Text>
        );
    });
    if (panel)
        return <Panel title="Pages" width={width} height={height}>{items}</Panel>;
    return (
        <Box flexDirection="row" width={width} height={height}>
            <Box flexDirection="column" width={SIDEBAR_WIDTH} height={height}>
                {items}
            </Box>
            <Box flexDirection="column" width={1} height={height}>
                {Array.from({ length: height }, (_, i) => <Text key={i} color={colors.dim}>{glyphs.separator}</Text>)}
            </Box>
        </Box>
    );
}

function Footer({ width }: { width: number }) {
    const { local, global } = useFooterHints();
    const message = useStatusMessage();

    if (message) {
        const glyph = message.severity === "error" ? glyphs.cross
            : message.severity === "success" ? glyphs.check
            : message.severity === "warning" ? glyphs.warning : glyphs.bullet;
        const color = message.severity === "error" ? rootColors.error
            : message.severity === "success" ? rootColors.ok
            : message.severity === "warning" ? rootColors.warning : rootColors.accent;
        return (
            <Box width={width} height={1}>
                <Text wrap="truncate">
                    <Text color={color}>{glyph} </Text>
                    {fit(clean(message.text), Math.max(0, width - 2))}
                </Text>
            </Box>
        );
    }

    // The shell's own hints (pages, admin, help, quit) are always there, on
    // the right; the page's or dialog's fill the rest from the left, innermost
    // first. Whole hints are dropped, never halves.
    const cost = ([key, label]: readonly [string, string]) => textWidth(key) + 1 + textWidth(label);
    const take = (hints: readonly (readonly [string, string])[], room: number) => {
        const out: (readonly [string, string])[] = [];
        let used = 0;
        for (const hint of hints) {
            const next = used + cost(hint) + (out.length ? 2 : 0);
            if (next > room)
                break;
            out.push(hint);
            used = next;
        }
        return { out, used };
    };
    const right = take(global, Math.max(0, width - 2));
    const left = take(local, Math.max(0, width - 2 - right.used - (right.used ? 3 : 0)));
    const gap = Math.max(right.used ? 3 : 0, width - 1 - left.used - right.used);

    const render = (hints: (readonly [string, string])[]) => hints.map(([key, label], i) => (
        <Text key={i}>
            {i > 0 ? "  " : ""}
            <Text bold color={rootColors.accent}>{key}</Text>
            {" " + label}
        </Text>
    ));

    return (
        <Box width={width} height={1}>
            <Text wrap="truncate">
                {" "}
                {render(left.out)}
                {right.out.length ? " ".repeat(gap) : ""}
                {render(right.out)}
            </Text>
        </Box>
    );
}

/**
 * Rows a shell dialog may give its scrolling list. The dialog's area is the
 * screen between the header and the footer; of that one row is left for its
 * shadow, and the rest is border, the margins above the list and the note,
 * and the note itself.
 */
function listRoom(areaHeight: number, inner: number, note: string): number {
    return areaHeight - 1 - 4 - wrap(note, inner).length;
}

function LogDialog({ onClose }: { onClose: () => void }) {
    const area = useArea();
    const width = useDialogWidth(Math.max(60, area.width - 4));
    const [, bump] = useState(0);
    useEffect(() => onLog(() => bump(n => n + 1)), []);
    const inner = dialogInnerWidth(width);
    const note = process.env.COCKPIT_TUI_LOG
        ? `Also written to ${process.env.COCKPIT_TUI_LOG}.`
        : "Set COCKPIT_TUI_LOG=<file> to keep this log in a file.";
    const height = Math.max(4, listRoom(area.height, inner, note));
    const lines = logEntries().flatMap(entry => {
        const stamp = formatTimestamp(entry.time);
        const color = entry.level === "error" ? colors.error : entry.level === "warn" ? colors.warning : undefined;
        return cleanLines(entry.text).map((text, i) => ({
            text: i === 0 ? `${stamp} ${entry.level.padEnd(6)} ${text}` : `${" ".repeat(stamp.length + 8)}${text}`,
            ...(color ? { color } : {}),
        }));
    });
    return (
        <Dialog title="Log" width={width} onCancel={onClose} hints={[[`${glyphs.updown} PgUp PgDn`, "scroll"], ["esc", "close"]]}>
            {lines.length === 0
                ? <DialogText width={width}>Nothing has been logged.</DialogText>
                : <LogLines lines={lines} width={inner} height={height} />}
            <DialogText width={width} color={colors.dim}>{note}</DialogText>
        </Dialog>
    );
}

/** Starts scrolled to the newest entries. */
function LogLines({ lines, width, height }: { lines: { text: string, color?: string }[], width: number, height: number }) {
    const visible = Math.min(height, lines.length);
    return <Box marginTop={1}><ScrollView lines={lines} width={width} height={visible} startAtEnd hints={[]} /></Box>;
}

/**
 * Pick the colour scheme. Moving through the list shows each one at once;
 * Enter keeps it and remembers it for the next start (config.ts), Esc goes
 * back to the one that was in use.
 */
function ThemeDialog({ onClose }: { onClose: () => void }) {
    const width = useDialogWidth(58);
    const inner = dialogInnerWidth(width);
    const { notify } = useStatus();
    const [original] = useState<ThemeName>(() => themeName());
    // The viewer's own schemes (the Colours page) are listed after the built-in ones.
    const [THEMES] = useState(() => listThemes());
    const [cursor, setCursor] = useState(() => Math.max(0, THEMES.findIndex(t => t.name === themeName())));

    const move = (step: number) => {
        const next = Math.max(0, Math.min(THEMES.length - 1, cursor + step));
        if (next === cursor)
            return;
        setCursor(next);
        setTheme(THEMES[next]!.name);
    };
    const keep = () => {
        const chosen = THEMES[cursor]!;
        try {
            writeConfig({ theme: chosen.name });
            notify(`Colour scheme: ${chosen.label}`, "success");
        } catch (error) {
            notify(`Colour scheme: ${chosen.label}, for this run only (it could not be saved: ${clean(errorText(error))})`, "warning");
        }
        onClose();
    };
    const cancel = () => {
        setTheme(original);
        onClose();
    };
    const labelWidth = Math.max(...THEMES.map(t => textWidth(t.label))) + 2;
    return (
        <Dialog title="Colour scheme" width={width} onCancel={cancel} onConfirm={keep}
                onKey={(input, key) => {
                    if (key.upArrow || input === "k") { move(-1); return true }
                    if (key.downArrow || input === "j") { move(1); return true }
                    if (key.home) { move(-THEMES.length); return true }
                    if (key.end) { move(THEMES.length); return true }
                    return false;
                }}
                hints={[[glyphs.updown, "try"], ["enter", "keep"], ["esc", "cancel"]]}>
            <Box flexDirection="column" marginTop={1}>
                {THEMES.map((theme, i) => (
                    <Text key={theme.name} inverse={i === cursor} wrap="truncate">
                        {fit(`${i === cursor ? glyphs.pointer : " "} ${fit(theme.label, labelWidth)}${theme.description}`, inner)}
                    </Text>
                ))}
            </Box>
            <DialogText width={width} color={colors.dim}>
                {styled
                    ? "Each one is shown as you move. Enter keeps it, also for the next time; --theme NAME picks one for a single run. Make your own on the Colours page."
                    : "Colours are switched off here (NO_COLOR, or a terminal without them): the choice is kept for where they are on."}
            </DialogText>
        </Dialog>
    );
}

function HelpDialog({ onClose, onLog: openLog, onTheme: openTheme, pageTitle, pageHints }: {
    onClose: () => void, onLog: () => void, onTheme: () => void, pageTitle: string, pageHints: readonly Hint[],
}) {
    const area = useArea();
    const width = useDialogWidth(66);
    const lines: [string, string][] = [
        ...(pageHints.length ? [[`${pageTitle} page`, ""] as [string, string], ...pageHints.map(([k, l]) => [k, l] as [string, string]), ["", ""] as [string, string]] : []),
        [`1-${PAGES.length}`, "jump to a page: " + PAGES.map((p, i) => `${i + 1} ${p.title}`).join(", ")],
        ["Tab, Shift+Tab", "next / previous page"],
        ["A", "administrative access (sudo)"],
        ["?", "this help"],
        ["q, Ctrl+C", "quit"],
        ["", ""],
        [`${glyphs.updown} PgUp PgDn`, "move through lists"],
        ["Home End", "first / last row"],
        ["Enter", "open the selected item"],
        ["Esc", "back, or close a dialog"],
        ["/", "search, on pages that list things"],
    ];
    const keyWidth = 16;
    const inner = dialogInnerWidth(width);
    const note = "The bottom line shows the keys that work at any moment. Press t to choose the colour scheme, l for the diagnostic log.";
    // On a short screen the key list scrolls instead of pushing the dialog off it.
    const room = Math.max(2, listRoom(area.height, inner, note));
    const scrolls = lines.length > room;
    const rendered = lines.map(([key, text]) => fit(key, keyWidth) + truncate(text, Math.max(0, inner - keyWidth)));
    return (
        <Dialog title="Keys" width={width} onCancel={onClose} onConfirm={onClose}
                onKey={input => {
                    if (input === "l") {
                        openLog();
                        return true;
                    }
                    if (input === "t") {
                        openTheme();
                        return true;
                    }
                    return false;
                }}
                hints={[...(scrolls ? [[glyphs.updown, "scroll"] as const] : []), ["t", "colours"], ["l", "log"], ["esc", "close"]]}>
            <Box flexDirection="column" marginTop={1}>
                {scrolls
                    ? <ScrollView lines={rendered} width={inner} height={room} hints={[]} />
                    : lines.map(([key, text], i) => (
                        <Text key={i} wrap="truncate">
                            <Text bold color={colors.accent}>{fit(key, keyWidth)}</Text>
                            {truncate(text, Math.max(0, inner - keyWidth))}
                        </Text>
                    ))}
            </Box>
            <DialogText width={width} color={colors.dim}>{note}</DialogText>
        </Dialog>
    );
}
