/*
 * A D-Bus ObjectManager's objects as plain data: what GetManagedObjects,
 * InterfacesAdded and PropertiesChanged carry, with each property's variant
 * unwrapped one level (variants nested inside a value stay {t, v}). Shared
 * by the pages that keep such a tree (Storage: UDisks2; Networking:
 * NetworkManager).
 */

/** One interface's properties, variants unwrapped one level. */
export type Props = Readonly<Record<string, unknown>>;
/** One object's interfaces. */
export type Interfaces = Readonly<Record<string, Props>>;
/** Every object, by path. */
export type Objects = ReadonlyMap<string, Interfaces>;

export function isVariant(value: unknown): value is { t: string, v: unknown } {
    return !!value && typeof value === "object" && !Array.isArray(value) && "t" in value && "v" in value;
}

export function unvariant(value: unknown): unknown {
    return isVariant(value) ? value.v : value;
}

/** {prop: variant} as GetManagedObjects, InterfacesAdded and PropertiesChanged carry it -> {prop: value}. */
export function plainProps(props: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (props && typeof props === "object" && !Array.isArray(props)) {
        for (const [name, value] of Object.entries(props))
            out[name] = unvariant(value);
    }
    return out;
}

/** A GetManagedObjects reply, a{oa{sa{sv}}}, checked as it is copied: this is host data. */
export function parseManagedObjects(value: unknown): Map<string, Record<string, Record<string, unknown>>> {
    const objects = new Map<string, Record<string, Record<string, unknown>>>();
    if (!value || typeof value !== "object" || Array.isArray(value))
        return objects;
    for (const [path, interfaces] of Object.entries(value)) {
        if (!interfaces || typeof interfaces !== "object" || Array.isArray(interfaces))
            continue;
        const entry: Record<string, Record<string, unknown>> = {};
        for (const [iface, props] of Object.entries(interfaces))
            entry[iface] = plainProps(props);
        objects.set(path, entry);
    }
    return objects;
}

