/*
 * The viewer's own settings, kept on the machine cockpit-tui runs on (not on
 * the managed host): today, the colour scheme the picker last chose.
 *
 *   $COCKPIT_TUI_CONFIG, else $XDG_CONFIG_HOME/cockpit-tui/config.json,
 *   else ~/.config/cockpit-tui/config.json
 *
 * A small JSON object. Reading never fails: a missing or broken file is an
 * empty configuration. Writing merges into what is there and reports failure
 * to the caller, who decides whether it matters (a read-only home directory
 * should not stop anyone from changing the colours for this run).
 * COCKPIT_TUI_CONFIG set to the empty string means no file at all.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
    /** A colour scheme's name (theme.ts). */
    theme?: unknown;
    /** The viewer's own colour schemes, by name (the Colours page). */
    schemes?: unknown;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string | null {
    if (env.COCKPIT_TUI_CONFIG !== undefined)
        return env.COCKPIT_TUI_CONFIG || null;
    const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(base, "cockpit-tui", "config.json");
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const path = configPath(env);
    if (!path)
        return {};
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Config : {};
    } catch {
        return {};
    }
}

/** Merge `changes` into the file. Throws when it cannot be written. */
export function writeConfig(changes: Config, env: NodeJS.ProcessEnv = process.env): void {
    const path = configPath(env);
    if (!path)
        return;
    const next = { ...readConfig(env), ...changes };
    mkdirSync(dirname(path), { recursive: true });
    // Written beside it and renamed: a reader never sees half a file.
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
}
