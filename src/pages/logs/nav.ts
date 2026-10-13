/*
 * Selection and scrolling over the log list.
 *
 * Unlike the shared useListNav, the rows here mix entries with day headers,
 * "Reboot" separators and a trailer that cannot be selected, and the list
 * grows at both ends while it is on screen: following prepends, "load
 * earlier" appends. So the selection is kept as a row key plus the index
 * and scroll offset it had when it was last moved, and resolved against the
 * current rows at each render:
 *
 *   - At the top (the newest entry selected) the selection stays on the
 *     newest entry as new ones arrive, the way tail -f keeps the end in view.
 *   - Elsewhere it stays on its entry, and the view shifts with it by the
 *     rows inserted above, so the screen does not jump while you read.
 *   - An entry that has since been folded into a run of repeats (a repeat
 *     arrived above it) is found in that run's row: keys resolve through
 *     every entry's cursor, not just the row keys.
 *
 * Moving keeps the separators just above the selection in view (the day an
 * entry belongs to) and, at the last entry, the trailer below it.
 */
import type { Row } from "./model.js";

export interface NavState {
    readonly key: string | null;
    readonly index: number;
    readonly offset: number;
    /** Pinned to the newest entry. */
    readonly top: boolean;
}

export const TOP: NavState = { key: null, index: 0, offset: 0, top: true };

/** The rows as navigation sees them; the trailer is the row after the last. */
export interface NavModel {
    /** All rows, including the trailer if there is one. */
    readonly count: number;
    /** Index of the first and last entry rows, -1 when there are none. */
    readonly first: number;
    readonly last: number;
    isEntry(index: number): boolean;
    /** The row with this key, or the entry row holding the entry with this cursor; -1 if none. */
    indexOf(key: string): number;
    keyAt(index: number): string | null;
}

export function navModel(rows: readonly Row[], trailer: boolean): NavModel {
    const index = new Map<string, number>();
    let first = -1;
    let last = -1;
    rows.forEach((row, i) => {
        index.set(row.key, i);
        if (row.kind === "entry") {
            // Separator keys are prefixed ("day:", "boot:"), so cursors never collide with them.
            for (const cursor of row.cursors)
                index.set(cursor, i);
            if (first < 0)
                first = i;
            last = i;
        }
    });
    return {
        count: rows.length + (trailer ? 1 : 0),
        first,
        last,
        isEntry: i => rows[i]?.kind === "entry",
        indexOf: key => index.get(key) ?? -1,
        keyAt: i => rows[i]?.key ?? null,
    };
}

export interface Resolved {
    /** The selected row, -1 when there are no entries. */
    readonly index: number;
    /** The first row in view. */
    readonly offset: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** The entry row nearest to `index`, looking down first. */
function nearestEntry(model: NavModel, index: number): number {
    for (let i = index; i <= model.last; i++)
        if (model.isEntry(i))
            return i;
    for (let i = Math.min(index, model.last); i >= model.first; i--)
        if (model.isEntry(i))
            return i;
    return model.first;
}

/** Where the selection and the view are now, given the rows as they are now. */
export function resolve(model: NavModel, state: NavState, visible: number): Resolved {
    const rows = Math.max(1, visible);
    if (model.first < 0)
        return { index: -1, offset: 0 };
    let index: number;
    let offset: number;
    if (state.top) {
        index = model.first;
        offset = 0;
    } else {
        const byKey = state.key === null ? -1 : model.indexOf(state.key);
        if (byKey >= 0 && model.isEntry(byKey)) {
            index = byKey;
            // Rows inserted above moved the selection down: move the view too.
            offset = state.offset + (byKey - state.index);
        } else {
            index = nearestEntry(model, clamp(state.index, model.first, model.last));
            offset = state.offset;
        }
    }
    offset = clamp(offset, 0, Math.max(0, model.count - rows));
    if (index < offset)
        offset = index;
    else if (index >= offset + rows)
        offset = index - rows + 1;
    return { index, offset };
}

/**
 * Select the entry row `target`, scrolling the view by `scroll` rows first
 * (a page key moves the view and the selection together).
 */
export function moveTo(model: NavModel, current: Resolved, target: number, visible: number, scroll = 0): NavState {
    const rows = Math.max(1, visible);
    let offset = clamp(current.offset + scroll, 0, Math.max(0, model.count - rows));
    if (target < offset)
        offset = target;
    else if (target >= offset + rows)
        offset = target - rows + 1;
    // The separators right above the selection say which day (and boot) it
    // belongs to: keep them in view when the selection is at the top edge.
    let above = target;
    while (above > 0 && !model.isEntry(above - 1))
        above--;
    if (offset > above && offset <= target)
        offset = Math.max(above, target - rows + 1);
    // At the last entry, show the trailer ("L loads earlier entries").
    if (target === model.last)
        offset = Math.max(offset, Math.min(target, model.count - rows));
    return { key: model.keyAt(target), index: target, offset, top: target === model.first };
}

/** The next entry row after `index` (step 1) or before it (step -1), or -1. */
export function stepEntry(model: NavModel, index: number, step: 1 | -1): number {
    for (let i = index + step; i >= model.first && i <= model.last; i += step)
        if (model.isEntry(i))
            return i;
    return -1;
}

/** Handle a navigation key; returns the new state, or null if it was not one. */
export function navKey(
    model: NavModel, current: Resolved, visible: number,
    key: "up" | "down" | "pageUp" | "pageDown" | "home" | "end",
): NavState | null {
    if (model.first < 0 || current.index < 0)
        return null;
    const page = Math.max(1, visible - 1);
    switch (key) {
    case "up": {
        const target = stepEntry(model, current.index, -1);
        return moveTo(model, current, target < 0 ? current.index : target, visible);
    }
    case "down": {
        const target = stepEntry(model, current.index, 1);
        return moveTo(model, current, target < 0 ? current.index : target, visible);
    }
    case "pageUp": {
        const wanted = Math.max(model.first, current.index - page);
        let target = wanted;
        while (target > model.first && !model.isEntry(target))
            target--;
        return moveTo(model, current, target, visible, -page);
    }
    case "pageDown": {
        const wanted = Math.min(model.last, current.index + page);
        let target = wanted;
        while (target < model.last && !model.isEntry(target))
            target++;
        return moveTo(model, current, target, visible, page);
    }
    case "home":
        return { ...moveTo(model, current, model.first, visible), offset: 0, top: true };
    case "end":
        return moveTo(model, current, model.last, visible);
    }
}
