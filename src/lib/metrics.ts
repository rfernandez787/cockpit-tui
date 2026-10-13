/*
 * Decoding a raw metrics1 channel: the bridge's messages into complete
 * samples. Shared by Overview (live usage) and Storage (filesystem usage);
 * the wire format is described at the top of pages/overview/metrics.ts.
 */

/** What the bridge says about one metric in a meta message. */
export interface MetaMetric {
    readonly name: string;
    readonly units?: string;
    readonly derive?: string | null;
    readonly instances?: readonly string[];
    readonly semantics?: string;
}

export interface Meta {
    readonly metrics: readonly MetaMetric[];
    readonly interval?: number;
}

/** A decoded value: a number, false ("not yet"), or undefined (never received). */
export type Scalar = number | false | undefined;
export type Value = Scalar | Scalar[];
export type Sample = Value[];

export function isMeta(message: unknown): message is Meta {
    return typeof message === "object" && message !== null && !Array.isArray(message) &&
        Array.isArray((message as { metrics?: unknown }).metrics);
}

/** Only finite numbers and false are values; anything else is "no value". */
function scalar(value: unknown): Scalar {
    if (value === false)
        return false;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Turns the channel's messages into complete samples. One instance per
 * channel: a new channel starts from nothing (its first meta comes first).
 */
export class Decompressor {
    meta: Meta | null = null;
    private last: Sample | null = null;

    /** Feed one parsed message; returns the complete samples it carried (none for a meta). */
    push(message: unknown): Sample[] {
        if (isMeta(message)) {
            // Keep `last`: compression continues across a meta, by index.
            this.meta = message;
            return [];
        }
        if (!Array.isArray(message) || !this.meta)
            return [];
        const samples: Sample[] = [];
        for (const row of message) {
            if (!Array.isArray(row))
                continue;
            const sample = this.decode(row, this.meta);
            this.last = sample;
            samples.push(sample);
        }
        return samples;
    }

    private decode(row: readonly unknown[], meta: Meta): Sample {
        const last = this.last;
        return meta.metrics.map((metric, j) => {
            const raw = row[j];
            const previous = last?.[j];
            if (Array.isArray(metric.instances)) {
                // Instanced: exactly one value per instance the meta lists,
                // gaps (null, or past the end of a short array) from the
                // previous row at the same index.
                const values = Array.isArray(raw) ? raw : [];
                const before = Array.isArray(previous) ? previous : [];
                return metric.instances.map((_, i) => {
                    const value = values[i];
                    return value === null || value === undefined ? before[i] : scalar(value);
                });
            }
            if (raw === null || raw === undefined)
                return Array.isArray(previous) ? undefined : previous;
            return scalar(raw);
        });
    }
}
