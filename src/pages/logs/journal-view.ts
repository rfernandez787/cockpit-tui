/*
 * The journal behind the Logs list: one page query, then following, plus
 * "load earlier" on demand. All of it is journalctl over stream channels,
 * opened with superuser "try" (JOURNAL_SPAWN): privileged when administrative
 * access is on. The shell remounts the page when access changes, which
 * closes every channel here and reopens it at the new level (spec G30).
 *
 *   page     --lines=N --reverse <filter>: the newest N entries, newest
 *            first. Fewer than N means the time range is exhausted.
 *   follow   once the page is in: --after-cursor=<newest shown> --follow, or
 *            --lines=0 --follow when nothing was shown, so it never replays
 *            history (upstream's fallback does: spec G11). Pausing closes
 *            it; resuming starts again after the newest entry shown, so
 *            nothing logged in between is lost.
 *   earlier  older than the oldest entry shown: first the rest of the time
 *            range (when the page was full), then, like upstream, past it,
 *            from its cursor -- every other filter still applies (see
 *            model.ts earlierQuery() for why the range needs --until).
 *
 * Paging is bounded on the server with --lines; upstream's client-side caps
 * overshoot by thousands of entries (spec G24). In memory the view keeps at
 * most limits.max entries: following past that drops the oldest, which
 * "load earlier" can bring back. Which query brings them back depends on
 * whether any entries from before the time range survived the trim (the
 * store's `boundary`): if so, loading continues past the range from the
 * oldest; if not, the range itself is incomplete again. Asking for the range
 * with an oldest entry from before it would combine --since with an earlier
 * --until, which journalctl refuses.
 *
 * Every outcome is classified by stderr (lib/journal.ts classifyExit): exit 1
 * with nothing on stderr means "no entries" (a --grep that matched nothing),
 * exit 1 with text is an error to show, and exit 0 with text is a notice to
 * show (spec G4). journalctl missing reads "journalctl is not installed on
 * <host>" rather than upstream's bare "not-found" (G28).
 *
 * Streams deliver batches from bridge callbacks, so the entries live in a
 * ref -- the one place a cursor's presence is checked, which keeps the page,
 * follow and earlier streams from ever showing an entry twice -- and a
 * counter re-renders. Every callback checks the query it belongs to, so a
 * late batch from a superseded query is dropped.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
    JOURNAL_SPAWN, classifyExit, journalArgs, streamJournal,
    type JournalEntry, type JournalFilter, type JournalStream,
} from "../../lib/journal.js";
import { runFull } from "../../tui/hooks.js";
import { earlierQuery, limits } from "./model.js";

/** Entries reach React at most this often: a burst renders once. */
const PAGE_BATCH_MS = 100;
/** Followed entries trickle; a slower cadence is kinder to a serial line. */
const FOLLOW_BATCH_MS = 250;
/** journalctl's refusal of a range that ends before it starts (systemd 252: "--since= must be before --until="). */
export const SINCE_AFTER_UNTIL = /--since=.*must be before.*--until=/;

export interface ViewOptions {
    readonly filter: JournalFilter;
    /** A new value starts a new query (the filter changed). */
    readonly queryKey: string;
    /** Bump to run the same query again. */
    readonly reload: number;
    /** Follow new entries: wanted by the user and possible for the filter. */
    readonly follow: boolean;
    /** For error texts ("journalctl is not installed on <host>"). */
    readonly host: string;
}

interface Meta {
    readonly query: number;
    /** The query key and reload count the query was started for. */
    readonly key: string;
    /** The page query is running. */
    readonly loading: boolean;
    readonly pageDone: boolean;
    /** The page query failed. */
    readonly error: string | null;
    /** journalctl succeeded but said something (exit 0 with stderr). */
    readonly notice: string | null;
    /** Following ended on its own; following stays off until retried. */
    readonly followError: string | null;
    readonly loadingEarlier: boolean;
    readonly earlierError: string | null;
    /** No more entries within the time range (a query returned fewer than asked). */
    readonly windowDone: boolean;
    /** Entries from before the time range are shown. */
    readonly beyond: boolean;
    /** Nothing earlier matches the filters at all. */
    readonly reachedStart: boolean;
}

function initialMeta(query: number, key: string): Meta {
    return {
        query, key, loading: true, pageDone: false, error: null, notice: null, followError: null,
        loadingEarlier: false, earlierError: null, windowDone: false, beyond: false, reachedStart: false,
    };
}

export type EarlierResult =
    /** A query was started. */
    | "started"
    /** Something is still loading. */
    | "busy"
    /** There is nothing earlier to load. */
    | "none"
    /** The view holds as many entries as it may. */
    | "full";

export interface JournalView extends Omit<Meta, "query" | "key" | "pageDone"> {
    /** Newest first. A new array whenever the entries change. */
    readonly entries: readonly JournalEntry[];
    /** The cursor of the newest entry shown from before the time range, if any. */
    readonly boundary: string | null;
    /** A follow stream is open. */
    readonly following: boolean;
    /** Load entries older than the oldest shown. */
    loadEarlier(): EarlierResult;
    /** Start following again after it stopped on an error. */
    retryFollow(): void;
}

interface Store {
    /** Newest first. */
    entries: JournalEntry[];
    cursors: Set<string>;
    /** The newest entry loaded from before the time range, if any. */
    boundary: string | null;
}

const emptyStore = (): Store => ({ entries: [], cursors: new Set(), boundary: null });

export function useJournalView(options: ViewOptions): JournalView {
    const { queryKey, reload, follow } = options;
    const store = useRef<Store>(emptyStore());
    const [, bump] = useReducer((n: number) => n + 1, 0);
    const [meta, setMeta] = useState<Meta>(() => initialMeta(0, ""));
    // The render after the filter changed or a reload, before the query
    // starts (in an effect): the entries are the previous query's, still to
    // be replaced. That is loading, not settled -- the page sizes columns
    // from settled entries.
    const key = `${queryKey}\n${reload}`;
    const stale = meta.key !== key;
    const queryRef = useRef(0);
    // The "load earlier" query in flight. A handle object rather than the
    // stream itself, so a completion can tell whether it is still current
    // even if it arrives before streamJournal() has returned.
    const earlierRef = useRef<{ stream: JournalStream | null } | null>(null);

    // Read at the time a stream starts: the filter is captured with its
    // query key, and the host name may arrive later without re-querying.
    const filterRef = useRef(options.filter);
    filterRef.current = options.filter;
    const hostRef = useRef(options.host);
    hostRef.current = options.host;

    /** Add a batch at one end of the list; returns the entries that were new, newest first. */
    const add = useCallback((query: number, batch: readonly JournalEntry[], where: "top" | "bottom"): JournalEntry[] => {
        if (query !== queryRef.current)
            return [];
        const s = store.current;
        const fresh: JournalEntry[] = [];
        for (const entry of batch) {
            if (!s.cursors.has(entry.cursor)) {
                s.cursors.add(entry.cursor);
                fresh.push(entry);
            }
        }
        if (fresh.length === 0)
            return [];
        // Following delivers oldest first; the list is newest first.
        if (where === "top")
            fresh.reverse();
        let entries = where === "top" ? [...fresh, ...s.entries] : [...s.entries, ...fresh];
        if (where === "top" && entries.length > limits.max) {
            // Keep the newest. What was dropped can be loaded again; a load
            // in flight would leave a gap, so it is abandoned.
            for (const dropped of entries.slice(limits.max))
                s.cursors.delete(dropped.cursor);
            entries = entries.slice(0, limits.max);
            earlierRef.current?.stream?.close();
            earlierRef.current = null;
            // Entries from before the time range still shown: the range
            // is complete above them, and loading continues past it. All
            // of them gone: the range is missing its oldest entries again.
            if (s.boundary !== null && !s.cursors.has(s.boundary))
                s.boundary = null;
            const past = s.boundary !== null;
            setMeta(m => ({ ...m, loadingEarlier: false, windowDone: past, beyond: past, reachedStart: false }));
        }
        s.entries = entries;
        bump();
        return fresh;
    }, []);

    // The page query, again whenever the filter changes or on reload.
    useEffect(() => {
        const query = ++queryRef.current;
        store.current = emptyStore();
        bump();
        setMeta(initialMeta(query, `${queryKey}\n${reload}`));
        let received = 0;
        const filter = filterRef.current;
        const argv = journalArgs(filter, { kind: "page", lines: limits.page });
        const stream = streamJournal(argv, batch => {
            received += batch.length;
            add(query, batch, "bottom");
        }, outcome => {
            if (query !== queryRef.current)
                return;
            const windowDone = received < limits.page;
            setMeta(m => ({
                ...m,
                loading: false,
                pageDone: true,
                error: outcome.kind === "error" ? outcome.message : null,
                notice: outcome.kind === "ok" ? outcome.notice : null,
                windowDone,
                // A range without a start (only an end, or none at all)
                // that came back short holds everything up to the start
                // of the journal: there is nothing earlier.
                reachedStart: windowDone && !filter.since && filter.boot === undefined,
            }));
        }, { host: hostRef.current, batchMs: PAGE_BATCH_MS });
        return () => {
            stream.close();
            earlierRef.current?.stream?.close();
            earlierRef.current = null;
        };
    }, [queryKey, reload, add]);

    // Following, once the page is in. Pausing, a new query or unmounting
    // closes it (the effect's cleanup).
    const followActive = follow && meta.pageDone && meta.error === null && meta.followError === null;
    useEffect(() => {
        if (!followActive)
            return;
        const query = queryRef.current;
        const newest = store.current.entries[0]?.cursor;
        const argv = journalArgs(filterRef.current, newest ? { kind: "follow", after: newest } : { kind: "follow" });
        const stream = streamJournal(argv, batch => add(query, batch, "top"), outcome => {
            if (query !== queryRef.current)
                return;
            // journalctl --follow ends on its own only when something broke.
            setMeta(m => ({
                ...m,
                followError: outcome.kind === "error" ? outcome.message : "journalctl stopped following",
            }));
        }, { host: hostRef.current, batchMs: FOLLOW_BATCH_MS });
        return () => stream.close();
    }, [followActive, meta.query, add]);

    const loadEarlier = (): EarlierResult => {
        if (meta.loading || meta.loadingEarlier)
            return "busy";
        if (meta.error !== null || meta.reachedStart)
            return "none";
        const s = store.current;
        if (s.entries.length >= limits.max)
            return "full";
        const query = queryRef.current;
        const lines = Math.min(limits.page, limits.max - s.entries.length);
        const earlier = earlierQuery(filterRef.current, s.entries.at(-1), meta.windowDone, lines);
        if (!earlier) {
            setMeta(m => ({ ...m, reachedStart: true }));
            return "none";
        }
        const within = earlier.within;
        let received = 0;
        let fresh = 0;
        const handle: { stream: JournalStream | null } = { stream: null };
        earlierRef.current = handle;
        handle.stream = streamJournal(earlier.argv, batch => {
            received += batch.length;
            const added = add(query, batch, "bottom");
            fresh += added.length;
            // The first entry from before the time range marks where they start.
            if (!within && added.length > 0 && store.current.boundary === null)
                store.current.boundary = added[0]!.cursor;
        }, outcome => {
            if (query !== queryRef.current || earlierRef.current !== handle)
                return;
            earlierRef.current = null;
            setMeta(m => {
                // journalctl reads a relative start ("-24hours", "today") again
                // on every run: once it has moved past the oldest entry shown,
                // the range holds nothing older, and journalctl refuses to say
                // so politely. That is the end of the range, not an error; the
                // next "load earlier" continues past it.
                if (outcome.kind === "error" && within && SINCE_AFTER_UNTIL.test(outcome.message))
                    return { ...m, loadingEarlier: false, earlierError: null, windowDone: true };
                if (outcome.kind === "error")
                    return { ...m, loadingEarlier: false, earlierError: outcome.message };
                // Fewer than asked for: nothing more there. (A full page of
                // nothing new can only be duplicates sharing one timestamp;
                // treat it as the end too, rather than ask again forever.)
                const exhausted = received < lines || fresh === 0;
                return {
                    ...m,
                    loadingEarlier: false,
                    earlierError: null,
                    windowDone: m.windowDone || (within && exhausted),
                    beyond: m.beyond || (!within && fresh > 0),
                    reachedStart: !within && exhausted,
                    notice: outcome.kind === "ok" && outcome.notice ? outcome.notice : m.notice,
                };
            });
        }, { host: hostRef.current, batchMs: PAGE_BATCH_MS });
        // A completion may already have arrived (and cleared the handle).
        if (earlierRef.current === handle)
            setMeta(m => ({ ...m, loadingEarlier: true, earlierError: null }));
        return "started";
    };

    const retryFollow = () => setMeta(m => ({ ...m, followError: null }));

    return {
        entries: store.current.entries,
        boundary: store.current.boundary,
        loading: meta.loading || stale,
        error: meta.error,
        notice: meta.notice,
        followError: meta.followError,
        loadingEarlier: meta.loadingEarlier,
        earlierError: meta.earlierError,
        windowDone: meta.windowDone,
        beyond: meta.beyond,
        reachedStart: meta.reachedStart,
        following: followActive,
        loadEarlier,
        retryFollow,
    };
}

/**
 * Ask journalctl whether it accepts some arguments, without reading
 * anything: --lines=0 parses the times and compiles a --grep pattern, then
 * shows nothing. Resolves with journalctl's complaint, or null (also when
 * `signal` stopped it first).
 */
export async function checkArguments(args: readonly string[], host: string, signal?: AbortSignal): Promise<string | null> {
    try {
        await runFull(["journalctl", "-q", "--lines=0", ...args], JOURNAL_SPAWN, signal);
        return null;
    } catch (error) {
        const outcome = classifyExit(error, "", host);
        return outcome.kind === "error" ? outcome.message : null;
    }
}
