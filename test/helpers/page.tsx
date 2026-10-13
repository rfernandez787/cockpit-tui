/*
 * Render one page the way the shell does, without the shell: every provider
 * a page may use, an area of the given size, and either a fixed privilege
 * state or a live one from a Superuser.
 *
 *   const session = await mockSession(scenario);
 *   const r = renderPage(ServicesPage, { columns: 100, rows: 30, allowed: true });
 *   await r.waitFor("sshd.service");
 *
 * The page gets the whole area (no header, menu or footer). Status messages
 * the page posts appear on an extra last line, prefixed "status: ", so tests
 * can assert on them; navigation requests are recorded in `navigations`.
 * With `showHints`, one more line lists the active key hints ("hints: ...").
 * The page is drawn as plain lines unless `panels` is set: most tests assert
 * on those lines, which are also what a small terminal gets.
 *
 * Like the shell, the page is unmounted while administrative access is
 * changing and remounted (fresh channels) whenever it settles differently.
 */
import type { ComponentType } from "react";
import { Box, Text } from "ink";
import { KeyboardProvider, useHints } from "../../src/tui/keyboard.js";
import { Notice } from "../../src/tui/components/misc.js";
import { StatusProvider, useStatusMessage } from "../../src/tui/status.js";
import { PrivilegeProvider, StaticPrivilege, usePrivilege } from "../../src/tui/privilege.js";
import { PersistentStateProvider, SessionProvider, usePersistentStore } from "../../src/tui/session-context.js";
import { NavigationProvider, paramsKey } from "../../src/tui/navigation.js";
import { AreaProvider } from "../../src/tui/components/Dialog.js";
import { setPanels } from "../../src/tui/components/Panel.js";
import type { PageProps } from "../../src/tui/page.js";
import type { Superuser } from "../../src/superuser.js";
import type { Session } from "../../src/session.js";
import { renderInk, type Rendered } from "./ink.js";

export interface PageHarnessOptions {
    columns?: number;
    rows?: number;
    /** Fixed privilege for the page. Ignored when `superuser` is given. */
    allowed?: boolean;
    /** Live privilege from the bridge's cockpit.Superuser. */
    superuser?: Superuser | null;
    session?: Session | null;
    hostname?: string;
    /** Params as if another page had called navigation.go(page, params). */
    params?: { pageId: string, value: object };
    /** Persistent state as an earlier visit would have left it (usePersistentState keys). */
    seed?: Record<string, unknown>;
    /** Add a line listing the active key hints, as "hints: k label | k label". */
    showHints?: boolean;
    /** Frame the page's content in panels where it has the room, as the shell does. Off: plain lines. */
    panels?: boolean;
}

export interface RenderedPage extends Rendered {
    /** Every navigation.go() the page made: [pageId, params]. */
    readonly navigations: [string, object | undefined][];
}

function StatusLine({ width }: { width: number }) {
    const message = useStatusMessage();
    return <Text wrap="truncate">{message ? `status: ${message.severity}: ${message.text}`.slice(0, width) : ""}</Text>;
}

function SeedParams({ params, seed }: { params?: { pageId: string, value: object }, seed?: Record<string, unknown> }) {
    const store = usePersistentStore();
    if (store && !store.has("seeded:")) {
        store.set("seeded:", true);
        for (const [key, value] of Object.entries(seed ?? {}))
            store.set(key, value);
        if (params)
            store.set(paramsKey(params.pageId), params.value);
    }
    return null;
}

function HintsLine({ width }: { width: number }) {
    const hints = useHints();
    return <Text wrap="truncate">{`hints: ${hints.map(([k, l]) => `${k} ${l}`).join(" | ")}`.slice(0, width)}</Text>;
}

/** The shell's page mount: none while access changes, a fresh one per generation. */
function PageMount({ Page, width, height }: { Page: ComponentType<PageProps>, width: number, height: number }) {
    const privilege = usePrivilege();
    if (privilege.transitioning)
        return <Notice width={width} height={height} loading>Switching access</Notice>;
    return <Page key={privilege.generation} width={width} height={height} />;
}

export function renderPage(Page: ComponentType<PageProps>, options: PageHarnessOptions = {}): RenderedPage {
    const columns = options.columns ?? 100;
    const rows = options.rows ?? 30;
    setPanels(options.panels ?? false);
    const height = rows - 1 - (options.showHints ? 1 : 0);
    const navigations: [string, object | undefined][] = [];
    const navigation = { go: (pageId: string, params?: object) => { navigations.push([pageId, params]) } };

    const page = (
        <AreaProvider area={{ width: columns, height }}>
            <Box flexDirection="column" width={columns} height={rows}>
                <Box width={columns} height={height} overflow="hidden" flexDirection="column">
                    <NavigationProvider value={navigation}>
                        <PageMount Page={Page} width={columns} height={height} />
                    </NavigationProvider>
                </Box>
                {options.showHints ? <HintsLine width={columns} /> : null}
                <StatusLine width={columns} />
            </Box>
        </AreaProvider>
    );

    const privileged = options.superuser !== undefined
        ? <PrivilegeProvider superuser={options.superuser}>{page}</PrivilegeProvider>
        : <StaticPrivilege allowed={options.allowed ?? false}>{page}</StaticPrivilege>;

    const tree = (
        <SessionProvider value={{ session: options.session ?? null, hostname: options.hostname ?? "localhost" }}>
            <KeyboardProvider>
                <StatusProvider>
                    <PersistentStateProvider>
                        <SeedParams {...(options.params ? { params: options.params } : {})}
                                    {...(options.seed ? { seed: options.seed } : {})} />
                        {privileged}
                    </PersistentStateProvider>
                </StatusProvider>
            </KeyboardProvider>
        </SessionProvider>
    );

    const rendered = renderInk(tree, { columns, rows });
    return Object.assign(rendered, { navigations });
}
