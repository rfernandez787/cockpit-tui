/*
 * Layered keyboard dispatch.
 *
 * Ink hands every keypress to every active useInput hook. A TUI with dialogs
 * and text fields needs the opposite: the innermost thing that cares about a
 * key consumes it and nothing beneath sees it. This provider owns the one
 * useInput in the app and walks each key down an ordered list of handlers.
 *
 * Order is (scope, layer, registration):
 *
 *   scope   <KeyScope> nests: a dialog opens a deeper scope, so everything
 *           inside it -- its text fields, its lists, its own Enter/Esc --
 *           outranks everything outside it. A dialog's own handler traps,
 *           so keys never leak to the page or the app beneath it.
 *   layer   within a scope: input (a focused text field) > page (lists and
 *           page shortcuts) > global (page switching, help, quit).
 *   order   within a layer, earlier registrations first. React runs a
 *           child's effects before its parent's, so on mount a widget
 *           precedes the component that contains it.
 *
 * Layer.system (Ctrl+C) outranks every scope.
 *
 * A handler returns true when it consumed the key. Hints for the footer come
 * from the same registrations, so the footer always describes exactly the
 * keys that currently do something.
 *
 * Several keypresses can arrive in one read (fast typing over ssh, a held
 * key, a paste ending in a newline, typing ahead while the app is busy). Two
 * things go wrong unless handled here:
 *
 *  - Ink splits escape sequences and backspaces out of a read but leaves any
 *    other run of bytes -- "\r" and "\t" included -- as ONE input string, so
 *    "s3cr3t\r" would never press Enter and "4?" would match no shortcut.
 *    splitInput() turns control characters back into the keys they are, and
 *    a run of text is offered whole (a text field takes it in one go) and
 *    then, if nothing wanted it whole, one character at a time.
 *  - Ink hands the events over back-to-back before React re-renders, so every
 *    handler after the first would run with stale state. Events are therefore
 *    dispatched one at a time, each after React has committed the previous.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApp, useInput, usePaste, type Key } from "ink";
import { reportInternalError } from "./log.js";
import reconciler from "ink-reconciler";

export type { Key };
export type KeyHandler = (input: string, key: Key) => boolean | void;
/** A footer hint: the keys, then what they do. */
export type Hint = readonly [keys: string, label: string];

export const Layer = {
    global: 0,
    page: 10,
    input: 20,
    system: 100,
} as const;

interface Registration {
    readonly id: number;
    readonly scope: number;
    layer: number;
    active: boolean;
    trap: boolean;
    hints: readonly Hint[];
    help: readonly Hint[] | null;
    readonly handler: { current: KeyHandler };
}

export interface KeyboardApi {
    register(registration: Registration): () => void;
    /** Registration fields changed in a way the footer should reflect. */
    changed(): void;
    /** Hints in priority order, cut off below the first trap. */
    hints(): Hint[];
    /** The same, split into the shell's own global hints and everything else. */
    footerHints(): FooterHints;
    /**
     * What the help screen lists for the page: footerHints().local, but with
     * each handler's full `help` list where it gives one.
     */
    helpHints(): Hint[];
    /** Subscribe to hint changes; returns an unsubscribe function. */
    subscribe(listener: () => void): () => void;
    /** Run a keypress through the handlers, as if typed. */
    dispatch(input: string, key: Key): boolean;
    /** Whether a text field has the keys right now. */
    typing(): boolean;
}

export interface FooterHints {
    readonly local: readonly Hint[];
    readonly global: readonly Hint[];
}

const KeyboardContext = createContext<KeyboardApi | null>(null);

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A Key with everything off, then the given flags: what Ink reports for one key. */
export function makeKey(flags: Partial<Key> = {}): Key {
    return {
        upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
        pageDown: false, pageUp: false, home: false, end: false,
        return: false, escape: false, ctrl: false, shift: false, tab: false,
        backspace: false, delete: false, meta: false,
        super: false, hyper: false, capsLock: false, numLock: false,
        ...flags,
    };
}

interface KeyEvent {
    readonly input: string;
    readonly key: Key;
    /** Several characters of text, to be split up if nothing takes them whole. */
    readonly run?: boolean;
    /** Pasted text: only ever text for a field, never keys. */
    readonly paste?: boolean;
}

function textEvent(text: string): KeyEvent {
    const single = [...segmenter.segment(text)].length === 1;
    // Ink marks a lone capital letter as shifted; match it.
    return { input: text, key: makeKey(single && /^[A-Z]$/.test(text) ? { shift: true } : {}), run: !single };
}

/**
 * Undo Ink's coalescing of a multi-key read (see the header). Events Ink
 * already parsed as a special key pass through untouched.
 */
export function splitInput(input: string, key: Key): KeyEvent[] {
    // Two Escapes in one read reach us as one Meta+Escape.
    if (key.escape && key.meta && input === "")
        return [{ input: "", key: makeKey({ escape: true }) }, { input: "", key: makeKey({ escape: true }) }];
    const special = key.ctrl || key.meta || key.escape || key.tab || key.return || key.backspace ||
        key.delete || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow ||
        key.pageUp || key.pageDown || key.home || key.end;
    if (special || input.length <= 1)
        return [{ input, key }];

    const events: KeyEvent[] = [];
    let text = "";
    const flush = () => {
        if (text)
            events.push(textEvent(text));
        text = "";
    };
    for (let i = 0; i < input.length; i++) {
        const code = input.charCodeAt(i);
        if (code === 0x0d || code === 0x0a) {
            flush();
            if (code === 0x0a && input.charCodeAt(i - 1) === 0x0d)
                continue; // CR LF is one Enter
            events.push({ input: "", key: makeKey({ return: true }) });
        } else if (code === 0x09) {
            flush();
            events.push({ input: "", key: makeKey({ tab: true }) });
        } else if (code === 0x08 || code === 0x7f) {
            flush();
            events.push({ input: "", key: makeKey({ backspace: true }) });
        } else if (code >= 0x01 && code <= 0x1a) {
            flush();
            // Ctrl+letter, reported the way Ink reports it: the letter, with ctrl.
            events.push({ input: String.fromCharCode(code + 0x60), key: makeKey({ ctrl: true }) });
        } else if (code < 0x20) {
            flush(); // other C0 controls (NUL, Ctrl+\ ] ^ _) have no meaning here
        } else {
            text += input[i];
        }
    }
    flush();
    return events;
}
const ScopeContext = createContext(0);

function rank(registration: Registration): number {
    return registration.layer === Layer.system ? Number.MAX_SAFE_INTEGER : registration.scope;
}

function ordered(registrations: Iterable<Registration>): Registration[] {
    return [...registrations]
        .filter(registration => registration.active)
        .sort((a, b) => rank(b) - rank(a) || b.layer - a.layer || a.id - b.id);
}

export function createKeyboard(): KeyboardApi {
    const registrations = new Map<number, Registration>();
    const listeners = new Set<() => void>();
    const notify = () => {
        for (const listener of [...listeners])
            listener();
    };
    const collect = (pick: (registration: Registration) => readonly Hint[]): FooterHints => {
        const local: Hint[] = [];
        const global: Hint[] = [];
        const active = ordered(registrations.values()).filter(r => r.layer !== Layer.system);
        // A focused text field takes every printable key: of the shell's own
        // keys only Tab and Ctrl+C still get through, so offer just those.
        const typing = active[0]?.layer === Layer.input;
        for (const registration of active) {
            if (typing && registration.scope === 0 && registration.layer === Layer.global) {
                global.push(["tab", "pages"], ["ctrl+c", "quit"]);
                break;
            }
            // The outermost scope's global layer is the shell itself.
            (registration.scope === 0 && registration.layer === Layer.global ? global : local)
                .push(...pick(registration));
            if (registration.trap)
                break;
        }
        return { local, global };
    };
    const footerHints = () => collect(registration => registration.hints);

    return {
        register(registration) {
            registrations.set(registration.id, registration);
            notify();
            return () => {
                registrations.delete(registration.id);
                notify();
            };
        },
        changed: notify,
        hints() {
            const { local, global } = footerHints();
            return [...local, ...global];
        },
        footerHints,
        helpHints() {
            return [...collect(registration => registration.help ?? registration.hints).local];
        },
        typing() {
            const top = ordered(registrations.values()).find(r => r.layer !== Layer.system);
            return top?.layer === Layer.input;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        dispatch(input, key) {
            for (const registration of ordered(registrations.values())) {
                let consumed: boolean | void;
                try {
                    consumed = registration.handler.current(input, key);
                } catch (error) {
                    // A broken handler must not take keyboard input down with it.
                    reportInternalError(error);
                    return true;
                }
                if (consumed === true)
                    return true;
                if (registration.trap)
                    return true;
            }
            return false;
        },
    };
}

export function KeyboardProvider({ children, keyboard }: { children: ReactNode, keyboard?: KeyboardApi }) {
    const api = useMemo(() => keyboard ?? createKeyboard(), [keyboard]);
    const { waitUntilRenderFlush } = useApp();
    const queue = useRef<KeyEvent[]>([]);
    const draining = useRef(false);
    const alive = useRef(true);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            queue.current = [];
        };
    }, []);

    // Bracketed paste: the terminal marks pasted text, so a paste of "S" and a
    // newline is text, never a shortcut and Enter. A focused field gets it;
    // anywhere else it is dropped.
    const enqueue = (events: KeyEvent[]) => {
        queue.current.push(...events);
        if (!draining.current)
            drain();
    };
    usePaste(text => enqueue([{ input: text, key: makeKey(), paste: true }]));
    useInput((input, key) => enqueue(splitInput(input, key)));

    const drain = () => {
        draining.current = true;
        // Dispatch one key, then let React commit what it changed before the
        // next: waitUntilRenderFlush() yields and then flushes React's pending
        // synchronous work, so the next handler runs against fresh state.
        void (async () => {
            try {
                // Always wait after a key, even with nothing queued: Ink delivers
                // the rest of a burst only after this handler returns.
                while (alive.current && queue.current.length > 0) {
                    const event = queue.current.shift()!;
                    if (event.paste && !api.typing())
                        continue;
                    // As Ink's own useInput does: with discrete priority the
                    // updates a key causes are synchronous, and flushing commits
                    // them now. Without it they are ordinary, time-sliced work:
                    // a large page still mid-render would hand the next key
                    // stale state (a burst of Downs on Services lost half).
                    const consumed = reconciler.discreteUpdates(() => api.dispatch(event.input, event.key));
                    reconciler.flushSyncWork();
                    if (!consumed && event.run) {
                        // Nobody wanted the text whole (no field has focus): it
                        // was keys after all, typed faster than they were read.
                        const keys = Array.from(segmenter.segment(event.input), s => textEvent(s.segment));
                        queue.current.unshift(...keys);
                        continue;
                    }
                    await waitUntilRenderFlush();
                }
            } finally {
                draining.current = false;
            }
        })();
    };
    return <KeyboardContext.Provider value={api}>{children}</KeyboardContext.Provider>;
}

/** Everything inside outranks everything outside. Dialogs wrap their content in one. */
export function KeyScope({ children }: { children: ReactNode }) {
    const depth = useContext(ScopeContext);
    return <ScopeContext.Provider value={depth + 1}>{children}</ScopeContext.Provider>;
}

/** The keyboard itself, for the shell's own bookkeeping (the help dialog). */
export function useKeyboard(): KeyboardApi {
    const api = useContext(KeyboardContext);
    if (!api)
        throw new Error("useKeys() used outside <KeyboardProvider>");
    return api;
}

let nextId = 1;

export interface KeyOptions {
    /** One of Layer.*; defaults to Layer.page. */
    layer?: number;
    /** Inactive handlers neither receive keys nor contribute hints. */
    active?: boolean;
    /** Swallow every key that reaches this handler (a dialog's own handler). */
    trap?: boolean;
    hints?: readonly Hint[];
    /**
     * Every key, for the help screen, when `hints` is cut down to fit the
     * footer or uses terse labels. Defaults to `hints`.
     */
    help?: readonly Hint[];
}

function sameHints(a: readonly Hint[], b: readonly Hint[]): boolean {
    return a.length === b.length && a.every((hint, i) => hint[0] === b[i]![0] && hint[1] === b[i]![1]);
}

/**
 * Receive keypresses. The handler may change every render; the latest one is
 * always used. Return true to consume the key.
 */
export function useKeys(handler: KeyHandler, options: KeyOptions = {}): void {
    const api = useKeyboard();
    const scope = useContext(ScopeContext);
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    const layer = options.layer ?? Layer.page;
    const active = options.active ?? true;
    const trap = options.trap ?? false;
    const hints = options.hints ?? [];
    const help = options.help ?? null;

    const registrationRef = useRef<Registration | null>(null);

    useLayoutEffect(() => {
        const registration: Registration = {
            id: nextId++, scope, layer, active, trap, hints, help, handler: handlerRef,
        };
        registrationRef.current = registration;
        const unregister = api.register(registration);
        return () => {
            registrationRef.current = null;
            unregister();
        };
        // Registered once per mount (scope cannot change without a remount);
        // the effect below keeps the mutable fields current.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api, scope]);

    // A layout effect, so the fields are current as soon as React commits:
    // the next queued key must see a field that just became active.
    useLayoutEffect(() => {
        const registration = registrationRef.current;
        if (!registration)
            return;
        const changed = registration.layer !== layer || registration.active !== active ||
            registration.trap !== trap || !sameHints(registration.hints, hints);
        registration.layer = layer;
        registration.active = active;
        registration.trap = trap;
        registration.hints = hints;
        // Read only when the help screen opens, so no change notification.
        registration.help = help;
        if (changed)
            api.changed();
    });
}

/** The shell's global hints and everyone else's, apart, so the footer can always fit the former. */
export function useFooterHints(): FooterHints {
    const api = useKeyboard();
    const [hints, setHints] = useState<FooterHints>(() => api.footerHints());
    useEffect(() => {
        const update = () => {
            const next = api.footerHints();
            setHints(previous => (sameHints(previous.local, next.local) && sameHints(previous.global, next.global)
                ? previous : next));
        };
        update();
        return api.subscribe(update);
    }, [api]);
    return hints;
}

/** The hints the footer should show right now, in priority order. */
export function useHints(): Hint[] {
    const api = useKeyboard();
    const [hints, setHints] = useState<Hint[]>(() => api.hints());
    useEffect(() => {
        const update = () => {
            const next = api.hints();
            setHints(previous => (sameHints(previous, next) ? previous : next));
        };
        update();
        return api.subscribe(update);
    }, [api]);
    return hints;
}

/** True for a plain printable character with no Ctrl/Meta modifier. */
export function isPlain(input: string, key: Key): boolean {
    return input.length > 0 && !key.ctrl && !key.meta && !key.tab && !key.return && !key.escape &&
        !key.backspace && !key.delete;
}
