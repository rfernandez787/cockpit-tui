/*
 * Text from the managed host, made safe to show. Shared by the pages that
 * print host strings on one line (Services, Storage).
 */
import { clean as cleanControls } from "../tui/text.js";

/*
 * Bidirectional controls can make text read as something it is not ("from
 * 10.0.0.<RLO>7.6.5" shows as 10.0.0.5.6.7): Unicode's whole Bidi_Control
 * set, the Arabic letter mark included, as the Logs page removes them.
 */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;

/**
 * Host text made safe for one line of the screen: control characters made
 * visible (text.ts clean()), and bidirectional controls removed. Every
 * string from the host -- unit names, descriptions, journal lines, systemd's
 * errors -- goes through this before it is shown.
 */
export function clean(text: string): string {
    return cleanControls(text.replace(BIDI, ""));
}
