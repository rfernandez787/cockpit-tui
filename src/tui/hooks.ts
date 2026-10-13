/*
 * React bindings for the cockpit API.
 *
 * Each hook owns the channels it opens and closes them on unmount. Pages are
 * remounted when privilege changes (see privilege.tsx), so a hook never needs
 * to reopen anything itself: a channel's lifetime is its component's.
 *
 * Anything from the host that reaches the screen must go through text.ts
 * clean() -- these hooks hand back raw data.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type DependencyList } from "react";
import cockpit from "../cockpit.js";

// ---- generic async -----------------------------------------------------------

export interface AsyncState<T> {
    readonly value: T | undefined;
    readonly error: unknown;
    readonly loading: boolean;
    /** Run again, keeping the current value visible until the new one lands. */
    readonly reload: () => void;
}

/**
 * Run `fn` whenever `deps` change (or reload() is called). Results from a
 * superseded run are dropped. The signal aborts when the run is superseded or
 * the component unmounts; use it to close channels. When deps change, the
 * previous value is cleared; reload() keeps it visible until the new one.
 */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: DependencyList): AsyncState<T> {
    const [state, setState] = useState<{ value: T | undefined, error: unknown, loading: boolean }>(
        { value: undefined, error: null, loading: true });
    const [nonce, reload] = useReducer((n: number) => n + 1, 0);
    const fnRef = useRef(fn);
    fnRef.current = fn;
    const lastNonce = useRef(nonce);

    useEffect(() => {
        const controller = new AbortController();
        // reload() keeps the old value on screen until the new one lands; new
        // deps are a different question, whose old answer must not show.
        const reloading = lastNonce.current !== nonce;
        lastNonce.current = nonce;
        setState(previous => reloading
            ? (previous.loading ? previous : { ...previous, loading: true })
            : (previous.value === undefined && previous.error === null && previous.loading
                ? previous : { value: undefined, error: null, loading: true }));
        let promise: Promise<T>;
        try {
            promise = Promise.resolve(fnRef.current(controller.signal));
        } catch (error) {
            promise = Promise.reject(error);
        }
        promise.then(
            value => {
                if (!controller.signal.aborted)
                    setState({ value, error: null, loading: false });
            },
            (error: unknown) => {
                if (!controller.signal.aborted)
                    setState(previous => ({ value: previous.value, error, loading: false }));
            });
        return () => controller.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, nonce]);

    return { ...state, reload };
}

/** Call `callback` every `ms`; null pauses. The latest callback is always used. */
export function useInterval(callback: () => void, ms: number | null): void {
    const ref = useRef(callback);
    ref.current = callback;
    useEffect(() => {
        if (ms === null)
            return;
        const timer = setInterval(() => {
            try {
                ref.current();
            } catch (error) {
                console.error("interval callback:", error);
            }
        }, ms);
        return () => clearInterval(timer);
    }, [ms]);
}

/** The current time, refreshed every `ms`. For "since" and uptime displays. */
export function useNow(ms = 1000): number {
    const [now, setNow] = useState(() => Date.now());
    useInterval(() => setNow(Date.now()), ms);
    return now;
}

/** Track whether the component is still mounted, for async callbacks. */
export function useMounted(): () => boolean {
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false };
    }, []);
    return useCallback(() => mounted.current, []);
}

// ---- processes -----------------------------------------------------------------

/** Spawn options for text processes; binary output has no use in these helpers. */
export type SpawnOptions = Omit<cockpit.SpawnOptions, "binary">;

/**
 * Every helper defaults to `err: "message"`: stderr comes back in the close
 * message (the ProcessError's `message` on failure). That is also the
 * bridge's own default, but only an explicit `err` stops the vendored channel
 * from console.warn-ing the text.
 */
function withDefaults(options: SpawnOptions): SpawnOptions {
    return { err: "message", ...options };
}

/**
 * The vendored Deferred runs callbacks from a timer and does not turn a throw
 * into a rejection: an exception there is uncaught and fatal. Callbacks into
 * our code from library promises and streams go through this.
 */
function guarded<A extends unknown[]>(what: string, fn: (...args: A) => void): (...args: A) => void {
    return (...args: A) => {
        try {
            fn(...args);
        } catch (error) {
            console.error(`${what}:`, error);
        }
    };
}

export interface ProcessResult {
    readonly stdout: string;
    /** stderr of a successful run (with the default `err: "message"`). */
    readonly stderr: string;
}

/**
 * cockpit.spawn as a plain promise. Rejections are the library's ProcessError:
 * `problem` for protocol failures ("not-found", "access-denied",
 * "cancelled"), `exit_status` / `exit_signal` for the process itself, and
 * `message` holding stderr.
 *
 * Aborting the signal closes the channel, which ends the process.
 */
export function runFull(argv: string[], options: SpawnOptions = {}, signal?: AbortSignal): Promise<ProcessResult> {
    const proc = cockpit.spawn(argv, withDefaults(options));
    // A block body, deliberately: close() returns the spawn's own promise, and
    // Node's EventTarget treats a listener's returned thenable as a promise and
    // re-raises its rejection ("cancelled") as an uncaught exception.
    const onAbort = () => {
        proc.close("cancelled");
    };
    if (signal) {
        if (signal.aborted)
            onAbort();
        else
            signal.addEventListener("abort", onAbort, { once: true });
    }
    return new Promise<ProcessResult>((resolve, reject) => {
        proc.done((stdout, message) => {
            signal?.removeEventListener("abort", onAbort);
            resolve({ stdout, stderr: message ?? "" });
        });
        proc.fail((error, output) => {
            signal?.removeEventListener("abort", onAbort);
            reject(withOutput(error, output));
        });
    });
}

/**
 * With `err: "out"` stderr is merged into stdout, the close message carries
 * an empty `message`, and the text arrives only as the failure's second
 * argument. Put it where callers look.
 */
function withOutput(error: unknown, output: unknown): unknown {
    const e = error as { message?: unknown } | null;
    if (e && typeof e === "object" && !(typeof e.message === "string" && e.message.trim()) &&
        typeof output === "string" && output.trim()) {
        try {
            e.message = output.trim();
        } catch { /* frozen: leave it */ }
    }
    return error;
}

/** runFull(), for just stdout. */
export async function run(argv: string[], options: SpawnOptions = {}, signal?: AbortSignal): Promise<string> {
    return (await runFull(argv, options, signal)).stdout;
}

/** Feed `input` to a process's stdin, then close it; resolves with stdout. */
export function runWithInput(argv: string[], input: string, options: SpawnOptions = {}): Promise<string> {
    const proc = cockpit.spawn(argv, withDefaults(options));
    proc.input(input);
    return new Promise<string>((resolve, reject) => {
        proc.done(stdout => resolve(stdout));
        proc.fail((error, output) => reject(withOutput(error, output)));
    });
}

export interface LineStream {
    /** Stop the process (closes its channel). No callbacks fire afterwards. */
    close(): void;
}

/**
 * Run a process and deliver its stdout line by line as it arrives, e.g.
 * `journalctl --follow`. The bridge splits output at arbitrary points, so a
 * partial line is held until its newline (or the end of the stream).
 *
 * `onClose` gets (null, stderr) on a clean exit and (ProcessError, "") on a
 * failure; it is not called after close(). Exceptions thrown by either
 * callback are logged, never fatal.
 */
export function streamLines(
    argv: string[],
    options: SpawnOptions,
    onLines: (lines: string[]) => void,
    onClose?: (error: unknown, stderr: string) => void,
): LineStream {
    const proc = cockpit.spawn(argv, withDefaults(options));
    let closed = false;
    const deliver = guarded("line stream consumer", onLines);
    const finish = guarded("line stream close handler", (error: unknown, stderr: string) => onClose?.(error, stderr));

    proc.stream(data => {
        if (closed)
            return data.length;
        const end = data.lastIndexOf("\n");
        if (end < 0)
            return 0; // keep buffering until a full line arrives
        deliver(data.slice(0, end).split("\n"));
        return end + 1;
    });
    proc.done((rest, message) => {
        if (closed)
            return;
        closed = true;
        // Whatever the stream callback did not consume: a last line that
        // had no trailing newline.
        if (rest)
            deliver([rest]);
        finish(null, message ?? "");
    });
    proc.fail(error => {
        if (closed)
            return;
        closed = true;
        finish(error, "");
    });
    return {
        close() {
            if (closed)
                return;
            closed = true;
            proc.close("cancelled");
        },
    };
}

// ---- D-Bus ---------------------------------------------------------------------

export type DBusClient = cockpit.DBusClient;

export interface DBusClientOptions {
    bus?: "system" | "session" | "internal" | "none";
    address?: string;
    superuser?: "try" | "require";
}

/**
 * A D-Bus client for the component's lifetime. Options are read once; to
 * change them, remount (e.g. via a key).
 */
export function useDBusClient(name: string | null, options: DBusClientOptions = { bus: "system" }): DBusClient {
    // Always a private channel. cockpit.dbus(null, { bus }) would otherwise
    // hand back the library's shared client, which ignores close(): every
    // proxy and signal subscription would then outlive the component, and the
    // bridge (which ignores remove-match) would deliver each signal once per
    // past visit. An extra key -- `track: false`, which the library consumes
    // and does not send -- is what makes it not shared.
    const [client] = useState(() => cockpit.dbus(name, { ...options, track: false } as cockpit.DBusOptions));
    useEffect(() => () => {
        client.close();
    }, [client]);
    return client;
}

/** The parts of a library DBusProxy the hooks use. */
export interface ProxyLike {
    readonly valid: boolean;
    readonly data: Record<string, unknown>;
    readonly path: string;
    readonly iface: string;
    wait(): Promise<void>;
    call(method: string, args?: unknown[], options?: cockpit.DBusCallOptions): Promise<unknown[]>;
    addEventListener(event: string, handler: (...args: never[]) => void): void;
    removeEventListener(event: string, handler: (...args: never[]) => void): void;
}

export interface ProxyState {
    readonly proxy: ProxyLike;
    /** Cached properties; mutated in place by the library, re-read each render. */
    readonly data: Record<string, unknown>;
    /** The object exists and its properties have arrived. */
    readonly valid: boolean;
    /** wait() has settled, successfully or not. */
    readonly loaded: boolean;
    readonly error: unknown;
}

/**
 * A watched D-Bus object's properties, re-rendering on every change.
 *
 * The library has no per-proxy close, and the Python bridge does not
 * implement `unwatch`, so a proxy's watch lasts as long as its client. Keep
 * `path` stable, or give the component a key and let it remount with a fresh
 * client.
 */
export function useProxy(client: DBusClient, iface: string, path: string): ProxyState {
    const proxy = useMemo(() => client.proxy(iface, path) as unknown as ProxyLike, [client, iface, path]);
    const [, bump] = useReducer((n: number) => n + 1, 0);
    const [status, setStatus] = useState<{ loaded: boolean, error: unknown }>({ loaded: false, error: null });

    useEffect(() => {
        let live = true;
        setStatus({ loaded: false, error: null });
        const onChanged = () => bump();
        proxy.addEventListener("changed", onChanged as never);
        proxy.wait().then(
            () => { if (live) setStatus({ loaded: true, error: null }) },
            (error: unknown) => { if (live) setStatus({ loaded: true, error }) });
        return () => {
            live = false;
            proxy.removeEventListener("changed", onChanged as never);
        };
    }, [proxy]);

    return { proxy, data: proxy.data, valid: proxy.valid, loaded: status.loaded, error: status.error };
}

export interface SignalMatch {
    path?: string;
    path_namespace?: string;
    interface?: string;
    member?: string;
    arg0?: string;
}

export type SignalHandler = (path: string, iface: string, signal: string, args: unknown[]) => void;

/**
 * Receive D-Bus signals matching `match` for the component's lifetime. The
 * latest handler is always used; a throw in it is logged, not fatal.
 *
 * Unsubscribing only stops delivery here: the Python bridge ignores
 * remove-match, so the rule lasts until the client closes.
 */
export function useSignal(client: DBusClient, match: SignalMatch, handler: SignalHandler): void {
    const ref = useRef(handler);
    ref.current = handler;
    const key = JSON.stringify(match);
    useEffect(() => {
        const subscription = client.subscribe(JSON.parse(key) as SignalMatch,
            guarded("signal handler", (path: string, iface: string, signal: string, args: unknown[]) =>
                ref.current(path, iface, signal, args)));
        return () => subscription.remove();
    }, [client, key]);
}

/**
 * One method call on a client opened just for it, then closed: upstream's
 * pattern for actions (pkg/lib/service.js), so each action runs at the
 * current privilege level without any reconnect logic. With
 * `superuser: "try"` it runs privileged if administrative access is on.
 */
export async function callOnce(
    name: string,
    options: DBusClientOptions,
    path: string,
    iface: string,
    method: string,
    args: unknown[] = [],
    callOptions?: cockpit.DBusCallOptions,
): Promise<unknown[]> {
    const client = cockpit.dbus(name, { ...options } as cockpit.DBusOptions);
    try {
        return await client.call(path, iface, method, args, callOptions);
    } finally {
        client.close();
    }
}

/** Unwrap a D-Bus variant ({t, v}) if it is one. */
export function unvariant<T = unknown>(value: unknown): T {
    if (value && typeof value === "object" && "v" in value && "t" in value)
        return (value as { v: T }).v;
    return value as T;
}

// ---- files -----------------------------------------------------------------------

export interface FileState {
    /** undefined while loading; null when the file does not exist. */
    readonly content: string | null | undefined;
    readonly tag: string | null;
    readonly error: unknown;
    readonly loading: boolean;
}

/**
 * A file's contents, kept current as it changes on disk. Missing files read
 * as null, not as an error.
 */
export function useFile(path: string, options: { superuser?: "try" | "require", max_read_size?: number } = {}): FileState {
    const [state, setState] = useState<FileState>({ content: undefined, tag: null, error: null, loading: true });
    const superuser = options.superuser;
    const maxReadSize = options.max_read_size;

    useEffect(() => {
        setState(previous => (previous.content === undefined && previous.loading && !previous.error
            ? previous
            : { content: undefined, tag: null, error: null, loading: true }));
        const file = cockpit.file(path, {
            ...(superuser ? { superuser } : {}),
            ...(maxReadSize ? { max_read_size: maxReadSize } : {}),
        });
        const handle = file.watch((content, tag, error) => {
            if (error)
                setState(previous => ({ ...previous, error, loading: false }));
            else
                setState({ content, tag, error: null, loading: false });
        });
        return () => {
            handle.remove();
            file.close();
        };
    }, [path, superuser, maxReadSize]);

    return state;
}
