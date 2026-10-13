/*
 * A unit's most recent journal entries, kept current: upstream's "Service
 * logs" panel (service.jsx:123-152, logs-panel.jsx), on the shared journal
 * library.
 *
 * Upstream runs one `journalctl --lines=10 --follow`. The library bounds and
 * anchors its queries instead, so this is two steps: the newest entries
 * (newest first), then a follow that starts strictly after the newest one
 * shown -- or, when there was nothing to show, at "now" (--lines=0), so a
 * quiet unit's old history is never replayed into the panel.
 *
 * The matches are upstream's OR group, _SYSTEMD_UNIT= + COREDUMP_UNIT= +
 * UNIT= (the _USER_ variants for user units): systemd's own "Failed to
 * start ..." lines carry only UNIT=.
 *
 * A user unit's name is not unique on the machine: every user's manager
 * may run a dbus-broker.service (gdm's does), and whoever can read the
 * system journal -- wheel, adm, root with administrative access -- would get
 * all of them. So user units are matched for this user only: _UID= on the
 * unit's own lines and its manager's, COREDUMP_UID= on its core dumps
 * (systemd-coredump may log them as another user). Upstream does not do
 * this; it shows other users' entries as this unit's.
 */
import { useEffect, useState } from "react";
import cockpit from "../../cockpit.js";
import {
    journalArgs, streamJournal, type JournalEntry, type JournalMode, type JournalStream, type UnitMatch,
} from "../../lib/journal.js";

export const LOG_LINES = 10;

export interface UnitLogs {
    /** Newest first, at most LOG_LINES. */
    readonly entries: readonly JournalEntry[];
    readonly loading: boolean;
    /** Why the entries could not be read (or stopped following); raw host text. */
    readonly error: string | null;
    /** journalctl's stderr on success, e.g. a note about missing journal files; raw host text. */
    readonly notice: string | null;
}

const INITIAL: UnitLogs = { entries: [], loading: true, error: null, notice: null };

/** Newest first, without duplicates (by cursor), at most `limit`. */
export function mergeNewest(newer: readonly JournalEntry[], older: readonly JournalEntry[], limit = LOG_LINES): JournalEntry[] {
    const seen = new Set<string>();
    const out: JournalEntry[] = [];
    for (const entry of [...newer, ...older]) {
        if (seen.has(entry.cursor))
            continue;
        seen.add(entry.cursor);
        out.push(entry);
        if (out.length >= limit)
            break;
    }
    return out;
}

/**
 * The journalctl argv for a unit's entries. `uid` is the user whose manager
 * runs a user unit; without one (not known), a user unit is matched by
 * name alone.
 */
export function unitJournalArgs(unit: UnitMatch, mode: JournalMode, uid: number | null): string[] {
    if (!unit.user || uid === null || !Number.isInteger(uid) || uid < 0)
        return journalArgs({ unit }, mode);
    // No unit and no matches: the argv ends with its "--", ready for ours.
    const argv = journalArgs({}, mode);
    const name = unit.name;
    argv.push(
        `_SYSTEMD_USER_UNIT=${name}`, `_UID=${uid}`, "+",
        `COREDUMP_USER_UNIT=${name}`, `COREDUMP_UID=${uid}`, "+",
        `USER_UNIT=${name}`, `_UID=${uid}`,
    );
    return argv;
}

/** The login user's uid, as the bridge reports it; null if it does not. */
function loginUid(): number | null {
    const uid = (cockpit.info as { user?: { uid?: unknown } }).user?.uid;
    return typeof uid === "number" ? uid : null;
}

export function useUnitLogs(unit: UnitMatch | null, host?: string): UnitLogs {
    const [state, setState] = useState<UnitLogs>(INITIAL);
    const name = unit?.name ?? null;
    const user = unit?.user ?? false;

    useEffect(() => {
        setState(INITIAL);
        if (!name)
            return;
        const unit = { name, user };
        const uid = user ? loginUid() : null;
        let live = true;
        let follow: JournalStream | null = null;
        let shown: JournalEntry[] = [];
        const options = host ? { host } : {};

        const page = streamJournal(unitJournalArgs(unit, { kind: "page", lines: LOG_LINES }, uid), batch => {
            // --reverse: each batch continues further into the past.
            shown = mergeNewest(shown, batch);
            setState(previous => ({ ...previous, entries: shown }));
        }, outcome => {
            if (!live)
                return;
            if (outcome.kind === "error") {
                setState({ entries: shown, loading: false, error: outcome.message, notice: null });
                return;
            }
            if (outcome.kind === "cancelled")
                return;
            const notice = outcome.kind === "ok" ? outcome.notice : null;
            setState({ entries: shown, loading: false, error: null, notice });

            const newest = shown[0]?.cursor;
            follow = streamJournal(unitJournalArgs(unit, newest ? { kind: "follow", after: newest } : { kind: "follow" }, uid), batch => {
                // Following runs forward in time: newest last.
                shown = mergeNewest([...batch].reverse(), shown);
                setState(previous => ({ ...previous, entries: shown }));
            }, ended => {
                if (!live || ended.kind === "cancelled")
                    return;
                if (ended.kind === "error")
                    setState(previous => ({ ...previous, error: `Following the log stopped: ${ended.message}` }));
            }, options);
        }, options);

        return () => {
            live = false;
            page.close();
            follow?.close();
        };
    }, [name, user, host]);

    return state;
}
