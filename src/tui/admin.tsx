/*
 * The administrative access dialog: the TUI's version of upstream's
 * "Limited access" / "Administrative access" switch
 * (pkg/lib/superuser-dialogs.tsx).
 *
 * Turning access on starts escalation at once, as upstream does, and shows
 * whatever sudo or polkit asks -- the lecture, the password prompt, "Sorry,
 * try again" -- in the dialog. Passwordless sudo succeeds without a prompt.
 * Esc cancels at any point, including while sudo is still thinking.
 * Turning access off asks first, because it closes every privileged channel;
 * the page is taken down before Stop() so none of that reaches the user as an
 * error.
 *
 * Either way the privilege provider sees the change and the shell remounts
 * the current page, so its channels reopen against the right bridge.
 */
import { useEffect, useRef, useState } from "react";
import { Box, Text } from "./ink.js";
import { Buttons, Dialog, DialogText, useArea, useDialogWidth, dialogInnerWidth } from "./components/Dialog.js";
import { TextInput } from "./components/TextInput.js";
import { Spinner } from "./components/Spinner.js";
import { useListNav } from "./components/Table.js";
import { usePrivilege, type Privilege } from "./privilege.js";
import { errorText, useStatus } from "./status.js";
import { clean, cleanBlock, fit, width as textWidth } from "./text.js";
import { colors, glyphs, unicode } from "./theme.js";
import { EscalationCancelled, type SuperuserPrompt } from "../superuser.js";

type Phase =
    | { kind: "unavailable", reason: string }
    | { kind: "root" }
    | { kind: "choose", choices: [string, string][] }
    | { kind: "starting", method: string | undefined }
    | { kind: "prompt", prompt: SuperuserPrompt }
    | { kind: "verifying" }
    | { kind: "failed", title: string, message: string }
    | { kind: "drop" }
    | { kind: "dropping" };

function initialPhase(privilege: Privilege): Phase {
    const superuser = privilege.superuser;
    if (!superuser)
        return { kind: "unavailable", reason: "This bridge does not support administrative access." };
    if (privilege.isRoot)
        return { kind: "root" };
    if (privilege.allowed)
        return { kind: "drop" };
    if (privilege.bridges.length === 0) {
        return {
            kind: "unavailable",
            reason: "No methods to gain administrative access are available on this host " +
                "(no installed Cockpit package declares sudo, pkexec or similar).",
        };
    }
    if (superuser.chooseMethod() === null)
        return { kind: "choose", choices: superuser.methodChoices() };
    return { kind: "starting", method: undefined };
}

export function AdminDialog({ onClose }: { onClose: () => void }) {
    const privilege = usePrivilege();
    const { notify } = useStatus();
    const area = useArea();
    const width = useDialogWidth(66);
    const inner = dialogInnerWidth(width);
    const [phase, setPhase] = useState<Phase>(() => initialPhase(privilege));
    const [answer, setAnswer] = useState("");
    const responder = useRef<((answer: string | null) => void) | null>(null);
    const started = useRef(false);
    const closed = useRef(false);

    const close = () => {
        if (closed.current)
            return;
        closed.current = true;
        onClose();
    };

    // Escalate as soon as there is a method.
    useEffect(() => {
        const superuser = privilege.superuser;
        if (phase.kind !== "starting" || started.current || !superuser)
            return;
        started.current = true;
        superuser.start((prompt, signal) => new Promise<string | null>(resolve => {
            responder.current = resolve;
            // Escalation ended while this prompt was showing: drop it.
            signal.addEventListener("abort", () => {
                if (responder.current === resolve)
                    responder.current = null;
                resolve(null);
            }, { once: true });
            setAnswer(prompt.default);
            setPhase({ kind: "prompt", prompt });
        }), phase.method).then(
            () => {
                responder.current = null;
                notify("Administrative access is on", "success");
                close();
            },
            (error: unknown) => {
                responder.current = null;
                if (error instanceof EscalationCancelled) {
                    close();
                    return;
                }
                if (!closed.current)
                    setPhase({ kind: "failed", title: "Problem becoming administrator", message: cleanBlock(errorText(error)) });
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase]);

    // Never leave sudo waiting on an answer nobody can give.
    useEffect(() => () => {
        closed.current = true;
        const respond = responder.current;
        responder.current = null;
        respond?.(null);
    }, []);

    const cancel = () => {
        const respond = responder.current;
        if (respond) {
            responder.current = null;
            setPhase({ kind: "verifying" });
            respond(null); // Superuser.start() calls Stop() and rejects as cancelled
        } else if (phase.kind === "starting" || phase.kind === "verifying") {
            // Still waiting on sudo: Stop() interrupts Start(), which then
            // rejects as cancelled and closes the dialog.
            privilege.superuser?.stop().catch(() => {});
        } else {
            close();
        }
    };

    const submit = () => {
        const respond = responder.current;
        if (!respond)
            return;
        responder.current = null;
        setPhase({ kind: "verifying" });
        setAnswer("");
        respond(answer);
    };

    const drop = () => {
        const superuser = privilege.superuser;
        if (!superuser)
            return;
        if (privilege.allowed !== true) {
            // Access already ended while this dialog was open (the privileged
            // bridge died): nothing left to stop, and no change will come to
            // clear a settling flag.
            close();
            return;
        }
        setPhase({ kind: "dropping" });
        // Unmount the page first: Stop() closes its privileged channels.
        privilege.setSettling(true);
        superuser.stop().then(
            () => {
                // Normally already cleared by the Current change, which the
                // bridge sends before Stop's reply; make sure regardless.
                privilege.setSettling(false);
                notify("Switched to limited access", "info");
                close();
            },
            (error: unknown) => {
                privilege.setSettling(false);
                setPhase({ kind: "failed", title: "Problem switching to limited access", message: cleanBlock(errorText(error)) });
            });
    };

    switch (phase.kind) {
    case "unavailable":
        return (
            <Dialog title="Administrative access" width={width} onCancel={close} onConfirm={close}
                    hints={[["enter/esc", "close"]]}>
                <DialogText width={width}>{phase.reason}</DialogText>
            </Dialog>
        );

    case "root":
        return (
            <Dialog title="Administrative access" width={width} onCancel={close} onConfirm={close}
                    hints={[["enter/esc", "close"]]}>
                <DialogText width={width}>The bridge is running as root, so administrative access is always on.</DialogText>
            </Dialog>
        );

    case "choose":
        return (
            <MethodPicker
                width={width}
                choices={phase.choices}
                onPick={method => setPhase({ kind: "starting", method })}
                onCancel={close}
            />
        );

    case "drop":
        return (
            <Dialog title="Switch to limited access" width={width} onCancel={close} onConfirm={drop}
                    hints={[["enter", "limit access"], ["esc", "cancel"]]}>
                <DialogText width={width}>
                    Limited access mode restricts administrative privileges. Some pages will have reduced functionality.
                </DialogText>
                <Box marginTop={1}><Buttons confirm="Limit access" /></Box>
            </Dialog>
        );

    case "dropping":
        return (
            <Dialog title="Switch to limited access" width={width} hints={[]}>
                <Box marginTop={1}><Spinner label="Turning off administrative access" /></Box>
            </Dialog>
        );

    case "failed":
        return (
            <Dialog title={phase.title} width={width} tone="error" onCancel={close} onConfirm={close}
                    hints={[["enter/esc", "close"]]}>
                <DialogText width={width} color={colors.error}>{phase.message}</DialogText>
            </Dialog>
        );

    case "starting":
    case "verifying":
        return (
            <Dialog title="Switch to administrative access" width={width} onCancel={cancel}
                    hints={[["esc", "cancel"]]}>
                <Box marginTop={1}>
                    <Spinner label={phase.kind === "starting" ? "Starting" : "Authenticating"} />
                </Box>
            </Dialog>
        );

    case "prompt": {
        const { prompt } = phase;
        // Upstream's defaults: polkit sends empty prompts.
        const message = prompt.message.trim() || (prompt.prompt.trim() ? "" : "Please authenticate to gain administrative access");
        const label = clean(prompt.prompt.trim()) || "Password";
        const labelText = /[:：]$/.test(label) ? label : `${label}:`;
        const labelWidth = Math.min(Math.max(10, Math.floor(inner / 2)), textWidth(labelText) + 1);
        const fieldWidth = Math.max(4, inner - labelWidth);
        // Keep the password row on screen: the lecture is long, screens may
        // be short. Border, title, margins and the prompt row take 7 lines.
        const textLines = Math.max(1, area.height - 7 - (message ? 2 : 0));
        // sudo's first message is the lecture, a warning; later ones are failures.
        const errorColor = prompt.attempt === 0 ? colors.warning : colors.error;
        return (
            <Dialog title="Switch to administrative access" width={width} onCancel={cancel}
                    hints={[["enter", "authenticate"], ["esc", "cancel"]]}>
                {message ? <DialogText width={width} maxLines={1}>{cleanBlock(message)}</DialogText> : null}
                {prompt.error.trim()
                    ? <DialogText width={width} color={errorColor} maxLines={textLines}>
                        {cleanBlock(prompt.error.trim())}
                    </DialogText>
                    : null}
                <Box marginTop={1}>
                    <Box width={labelWidth}><Text wrap="truncate">{labelText}</Text></Box>
                    <Box width={fieldWidth}>
                        <TextInput
                            value={answer}
                            onChange={setAnswer}
                            onSubmit={submit}
                            onCancel={cancel}
                            mask={prompt.echo ? undefined : unicode ? "•" : "*"}
                            width={fieldWidth}
                        />
                    </Box>
                </Box>
            </Dialog>
        );
    }
    }
}

function MethodPicker({ width, choices, onPick, onCancel }: {
    width: number, choices: [string, string][], onPick: (method: string) => void, onCancel: () => void,
}) {
    // Driven through the dialog's onKey: a useKeys() here would sit outside
    // the dialog's key scope.
    const nav = useListNav(choices.map(([name]) => name), choices.length, { active: false });
    const inner = dialogInnerWidth(width);
    return (
        <Dialog title="Switch to administrative access" width={width} onCancel={onCancel}
                onKey={nav.handleKey}
                onConfirm={() => { if (nav.key) onPick(nav.key) }}
                hints={[[glyphs.updown, "method"], ["enter", "authenticate"], ["esc", "cancel"]]}>
            <DialogText width={width}>Method</DialogText>
            <Box flexDirection="column">
                {choices.map(([name, label], i) => (
                    <Text key={name} inverse={i === nav.index} wrap="truncate">
                        {fit(`${i === nav.index ? glyphs.pointer : " "} ${clean(label)}`, inner)}
                    </Text>
                ))}
            </Box>
        </Dialog>
    );
}
