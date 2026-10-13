/*
 * The probe: connect, report what the bridge supports, and optionally test
 * privilege escalation.
 *
 * This is the foundation's self-check, and deliberately plain line output so
 * it works anywhere, including piped into a log. Run it against a new machine
 * to confirm the transport, handshake and escalation work there before
 * trusting any page built on top of them.
 */
import cockpit from "./cockpit.js";
import { connect } from "./connect.js";
import { Superuser } from "./superuser.js";
import { buildConnectOptions, initInfo } from "./session.js";
import { createPrompter } from "./prompter.js";
import type { CliArgs } from "./args.js";
import { clean, cleanBlock } from "./tui/text.js";
import { errorText } from "./tui/status.js";

/** Payloads the pages are built on; a bridge without one breaks those pages. */
export const REQUIRED_PAYLOADS = ["dbus-json3", "stream", "fsread1", "fsreplace1", "metrics1"];

export async function runProbe(args: CliArgs): Promise<number> {
    const { ask, close } = createPrompter();

    try {
        const options = await buildConnectOptions(args, {
            ask,
            print: line => console.log(line),
            onBridgeStderr: line => console.error(line),
        });
        process.stdout.write(`connecting (${options.mode}) ... `);
        await connect(options);
        console.log("ok");

        // Upstream's own bootstrap: awaits the transport, then fills
        // `cockpit.info` from the bridge's `info` channel.
        await initInfo();
        const info = cockpit.info;

        // Everything printed below came from the host: clean it first.
        const os = info.os_release ?? {};
        console.log(`\nhost      ${clean(os.PRETTY_NAME ?? os.NAME ?? "unknown")}`);
        if (info.user?.name)
            console.log(`user      ${clean(info.user.name)} (uid ${info.user.uid})`);
        if (info.user?.groups?.length)
            console.log(`groups    ${clean(info.user.groups.join(" "))}`);

        const channels = Object.keys(info.channels ?? {}).sort();
        console.log(`\npayloads supported by this bridge (${channels.length}):`);
        console.log(`  ${clean(channels.join("  ")) || "(bridge reported none)"}`);
        const missing = channels.length ? REQUIRED_PAYLOADS.filter(required => !channels.includes(required)) : [];
        for (const required of missing)
            console.log(`  ! ${required} is missing -- pages relying on it will not work`);

        const superuser = await Superuser.open();
        console.log(`\nadmin     current=${clean(superuser.current)} methods=${clean(superuser.bridges.join(",")) || "none"}`);

        if (args.admin && !superuser.isRoot) {
            await superuser.start(async prompt => {
                if (prompt.error)
                    console.log(`  ${cleanBlock(prompt.error)}`);
                return await ask(`  ${clean(prompt.prompt) || "Password: "}`, !prompt.echo);
            });
            console.log(`admin     escalated via ${clean(superuser.current)}`);
        }

        if (missing.length) {
            console.log(`\nfoundation incomplete: ${missing.length} required payload${missing.length === 1 ? "" : "s"} missing.`);
            return 1;
        }
        console.log("\nfoundation looks healthy.");
        return 0;
    } catch (error) {
        console.error(`\nfailed: ${cleanBlock(errorText(error))}`);
        return 1;
    } finally {
        close();
    }
}
