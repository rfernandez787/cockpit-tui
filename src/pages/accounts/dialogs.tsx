/*
 * The Accounts page's dialogs: create, delete, set password, edit groups,
 * add an SSH key, and a generic confirmation for the one-command actions.
 *
 * As upstream's (cockpit-components-dialog.jsx show_modal_dialog): the
 * action runs from the dialog, which shows progress, stays open with the
 * host's error text when it fails, and closes when it succeeds. Unlike
 * upstream's lock and log-out dialogs, failures are never swallowed.
 *
 * Every string from the host -- names, error messages -- is cleaned here
 * before it reaches the screen.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { Box, Text } from "../../tui/ink.js";
import { Buttons, Dialog, DialogText, dialogInnerWidth, useArea, useDialogWidth } from "../../tui/components/Dialog.js";
import { FormDialog, type FormField } from "../../tui/components/Form.js";
import { Spinner } from "../../tui/components/Spinner.js";
import { isPlain, type KeyHandler } from "../../tui/keyboard.js";
import { useMounted } from "../../tui/hooks.js";
import { errorText } from "../../tui/status.js";
import { clean, cleanBlock, fit, truncate, width as textWidth, wrap } from "../../tui/text.js";
import { colors, glyphs } from "../../tui/theme.js";
import {
    addKey, checkPasswordQuality, createAccount, CreateError, createGroup, deleteAccount, renameGroup, setMembership,
    setPassword, type CreateStep,
} from "./actions.js";
import {
    ADMIN_GROUPS, checkKeyText, hasProcessesState, isLoggedInState, nextGid, suggestUsername, validateFullName,
    validateGid, validateGroupName, validatePasswords, validateUsername,
    type Account, type AuthorizedKey, type GroupEntry, type GroupInfo, type LoginDefs, type PasswdEntry,
} from "./model.js";

/** Host error text, safe and single-paragraph for a dialog. */
export function hostError(error: unknown): string {
    return cleanBlock(errorText(error)).replace(/\s*\n\s*/g, " ").trim();
}

// ---- generic --------------------------------------------------------------------------

/*
 * Keys typed ahead into a confirmation.
 *
 * The list's action keys are plain letters, so someone who types a name
 * without "/" first ("Dave", "tom", "carol") opens a dialog with one of its
 * letters, and the Enter that ends the word would confirm what they never
 * saw: "Dave" + Enter deleted bob. Letters mean nothing to a confirmation,
 * so once any arrive the next Enter does not confirm: it says why, and only
 * an Enter after that (with nothing typed in between) decides.
 */
function useTypeAheadGuard() {
    const [state, setState] = useState<"clear" | "typed" | "warned">("clear");
    return {
        /** Keys arrived that the dialog has no use for. */
        typed: state === "typed",
        /** Enter was pressed after such keys: say what happened. */
        warned: state === "warned",
        onStrayKey: () => setState("typed"),
        /** On Enter: whether it may confirm; if not, it has just warned instead. */
        mayConfirm: (): boolean => {
            if (state !== "typed")
                return true;
            setState("warned");
            return false;
        },
    };
}

function typedAheadNotice(verb: string): string {
    return `The keys typed after this dialog opened were ignored. Press Enter again to ${verb}, or Esc to cancel.`;
}

/*
 * Lines for the paragraphs of a dialog that share `room` lines, each also
 * taking the blank line above it: every paragraph present gets one line, and
 * what is left goes to them in the order given (most important first). The
 * shared Dialog clips at the bottom only when its rows cannot shrink, so the
 * blocks that use these are flexShrink 0 and sized to fit.
 */
function shareLines(room: number, wanted: readonly number[]): number[] {
    const shown = wanted.map((n): number => (n > 0 ? 1 : 0));
    let left = room - wanted.reduce((sum, n) => sum + (n > 0 ? 2 : 0), 0);
    for (let i = 0; i < wanted.length && left > 0; i++) {
        const more = Math.min(left, (wanted[i] ?? 0) - (shown[i] ?? 0));
        if (more > 0) {
            shown[i] = (shown[i] ?? 0) + more;
            left -= more;
        }
    }
    return shown;
}

/** A wrapped paragraph that keeps its lines (cut to `maxLines`) instead of being squeezed. */
function Paragraph({ text, width, maxLines, color }: { text: string, width: number, maxLines: number, color?: string }) {
    return (
        <Box flexDirection="column" flexShrink={0}>
            <DialogText width={width} maxLines={Math.max(1, maxLines)} {...(color ? { color } : {})}>{text}</DialogText>
        </Box>
    );
}

function ButtonsLine({ busy, busyText, label }: { busy: boolean, busyText: string, label: string }) {
    return (
        <Box marginTop={1} flexShrink={0}>
            {busy
                ? <Spinner label={busyText} />
                : <Buttons confirm={label} />}
        </Box>
    );
}

/*
 * A confirmation that runs `run` itself: busy while it runs (Esc cannot
 * abandon a command half way), the host's error inline if it fails (Enter
 * tries again), closed when it succeeds. It looks like the shared
 * ConfirmDialog, but sees the keys typed into it (useTypeAheadGuard) and
 * fits its text to the screen.
 */
export function ConfirmAction(props: {
    title: string,
    message: string,
    confirmLabel: string,
    danger?: boolean,
    busyText: string,
    run: () => Promise<void>,
    onClose: () => void,
}) {
    const mounted = useMounted();
    const area = useArea();
    const width = useDialogWidth(64);
    const inner = dialogInnerWidth(width);
    const guard = useTypeAheadGuard();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const label = props.confirmLabel;

    const confirm = () => {
        if (busy || !guard.mayConfirm())
            return;
        setBusy(true);
        setError(null);
        props.run().then(
            () => {
                if (mounted())
                    props.onClose();
            },
            (failure: unknown) => {
                if (!mounted())
                    return;
                setBusy(false);
                setError(hostError(failure));
            });
    };

    const onKey: KeyHandler = (input, key) => {
        if (!isPlain(input, key))
            return false;
        if (!busy)
            guard.onStrayKey();
        return true;
    };

    const notice = guard.warned && !busy ? typedAheadNotice(label.toLowerCase()) : null;
    // Border, title and the buttons line take 5 lines; the error matters most, then the notice.
    const [errorLines, noticeLines, messageLines] = shareLines(area.height - 5, [
        error ? wrap(error, inner).length : 0,
        notice ? wrap(notice, inner).length : 0,
        wrap(props.message, inner).length,
    ]);
    return (
        <Dialog
            title={props.title}
            width={width}
            tone={props.danger ? "error" : "info"}
            onCancel={busy ? undefined : props.onClose}
            onConfirm={busy ? undefined : confirm}
            onKey={onKey}
            hints={busy ? [] : [["enter", label.toLowerCase()], ["esc", "cancel"]]}
        >
            <Paragraph text={props.message} width={width} maxLines={messageLines!} />
            {notice ? <Paragraph text={notice} width={width} maxLines={noticeLines!} color={colors.warning} /> : null}
            {error ? <Paragraph text={error} width={width} maxLines={errorLines!} color={colors.error} /> : null}
            <ButtonsLine busy={busy} busyText={props.busyText} label={label} />
        </Dialog>
    );
}

/** A message to acknowledge, for outcomes too important for the footer. */
export function MessageDialog({ title, message, tone = "info", onClose }: {
    title: string, message: string, tone?: "info" | "warning" | "error", onClose: () => void,
}) {
    const width = useDialogWidth(64);
    return (
        <Dialog title={title} width={width} tone={tone} onCancel={onClose} onConfirm={onClose} hints={[["enter", "ok"]]}>
            <DialogText width={width}>{message}</DialogText>
            <Box marginTop={1}><Buttons confirm="OK" cancel={null} /></Box>
        </Dialog>
    );
}

/** "Password quality check failed: ..." plus how to go on regardless. */
function weakMessage(message: string): string {
    return `${clean(message).replace(/[.\s]+$/, "")}. Press Enter again to use it anyway.`;
}

// ---- create ----------------------------------------------------------------------------

const STEP_TEXT: Record<CreateStep, string> = {
    useradd: "Creating the account",
    password: "Setting the password",
    lock: "Disallowing password login",
    expire: "Expiring the password",
};

/** What a failed step after useradd leaves behind, and what to do about it. */
export function partialCreateMessage(user: string, step: CreateStep, message: string): string {
    const name = clean(user);
    const consequence: Record<CreateStep, string> = {
        useradd: "",
        password: `${name} has no usable password yet: open the account and set one (p).`,
        lock: `Its password is set, but password login is still allowed: lock it from its details (l).`,
        expire: `Its password is set, but ${name} will not be asked to change it: use force change (f).`,
    };
    const text = cleanBlock(message).replace(/\s*\n\s*/g, " ").trim();
    return `The account ${name} was created, but ${STEP_TEXT[step].toLowerCase()} failed: ${text} ${consequence[step]}`;
}

interface CreateValues {
    fullName: string;
    user: string;
    password: string;
    confirm: string;
    admin: boolean;
    forceChange: boolean;
    lock: boolean;
}

/*
 * account-create-dialog.js, with the fields the TUI's v1 asks for: full
 * name, user name (suggested from the full name until edited, as
 * upstream), password twice, the administrator role, and either "must
 * change the password at first login" or "disallow password login" (the
 * two exclude each other, as upstream's radio and checkbox do).
 *
 * The password may be left empty when password login is disallowed: the
 * account then keeps useradd's disabled password, which is what "no
 * password login" means anyway (upstream insists on one regardless).
 */
export function CreateAccountDialog(props: {
    passwd: readonly PasswdEntry[],
    groups: readonly GroupEntry[],
    loginDefs: LoginDefs,
    adminGroup: string | null,
    onCreated: (user: string, warnings: string[]) => void,
    onPartial: (user: string, step: CreateStep, message: string) => void,
    onCancel: () => void,
}) {
    const mounted = useMounted();
    const area = useArea();
    const width = useDialogWidth(66);
    const [values, setValues] = useState<CreateValues>({
        fullName: "", user: "", password: "", confirm: "", admin: false, forceChange: false, lock: false,
    });
    const [userEdited, setUserEdited] = useState(false);
    const [errors, setErrors] = useState<Partial<Record<keyof CreateValues, string>>>({});
    const [busy, setBusy] = useState<string | null>(null);
    const [formError, setFormError] = useState<string | null>(null);
    // The password pwscore called weak, which a second Enter accepts.
    const [weakAccepted, setWeakAccepted] = useState<string | null>(null);

    const change = (id: string, value: string | boolean) => {
        setValues(previous => {
            const next = { ...previous, [id]: value } as CreateValues;
            if (id === "fullName" && !userEdited)
                next.user = suggestUsername(String(value));
            if (id === "forceChange" && value === true)
                next.lock = false;
            if (id === "lock" && value === true)
                next.forceChange = false;
            return next;
        });
        if (id === "user")
            setUserEdited(true);
        setErrors(previous => ({ ...previous, [id]: undefined, ...(id === "fullName" && !userEdited ? { user: undefined } : {}) }));
        setFormError(null);
    };

    const submit = () => {
        if (busy)
            return;
        void (async () => {
            const v = values;
            const found: Partial<Record<keyof CreateValues, string>> = {};
            const userError = validateUsername(v.user, props.passwd, props.groups, props.loginDefs.userGroups);
            if (userError)
                found.user = userError;
            const nameError = validateFullName(v.fullName);
            if (nameError)
                found.fullName = nameError;
            const passwordErrors = validatePasswords(v.password, v.confirm, !v.lock);
            if (passwordErrors.password)
                found.password = passwordErrors.password;
            if (passwordErrors.confirm)
                found.confirm = passwordErrors.confirm;
            if (Object.keys(found).length > 0) {
                setErrors(found);
                return;
            }
            if (v.password && weakAccepted !== v.password) {
                setBusy("Checking the password");
                const quality = await checkPasswordQuality(v.password);
                if (!mounted())
                    return;
                if (!quality.ok) {
                    setBusy(null);
                    setWeakAccepted(v.password);
                    setErrors({ password: weakMessage(quality.message) });
                    return;
                }
            }
            setBusy(STEP_TEXT.useradd);
            try {
                const warnings = await createAccount({
                    user: v.user,
                    fullName: v.fullName,
                    password: v.password,
                    adminGroup: v.admin ? props.adminGroup : null,
                    lock: v.lock,
                    forceChange: v.forceChange,
                }, step => {
                    if (mounted())
                        setBusy(STEP_TEXT[step]);
                });
                if (mounted())
                    props.onCreated(v.user, warnings);
            } catch (error) {
                if (!mounted())
                    return;
                if (error instanceof CreateError && error.created) {
                    props.onPartial(v.user, error.step, error.message);
                    return;
                }
                setBusy(null);
                setFormError(hostError(error));
            }
        })();
    };

    const help = {
        // Allowed, as upstream, but not what it looks like: "Smith, John" shows as "Smith".
        fullName: values.fullName.includes(",") ? "The name ends at the first comma." : null,
        password: values.lock && !values.password ? "optional: password login is off" : null,
    };
    let fields: FormField[] = [
        { kind: "text", id: "fullName", label: "Full name", value: values.fullName, maxLength: 256, error: errors.fullName ?? null },
        { kind: "text", id: "user", label: "User name", value: values.user, maxLength: 64, error: errors.user ?? null },
        {
            kind: "password", id: "password", label: "Password", value: values.password, maxLength: 1024,
            error: errors.password ?? null,
        },
        { kind: "password", id: "confirm", label: "Confirm password", value: values.confirm, maxLength: 1024, error: errors.confirm ?? null },
        ...(props.adminGroup
            ? [{ kind: "checkbox" as const, id: "admin", label: `Administrator (${clean(props.adminGroup)})`, value: values.admin }]
            : []),
        { kind: "checkbox", id: "forceChange", label: "Must change password", value: values.forceChange },
        { kind: "checkbox", id: "lock", label: "Disallow password login", value: values.lock },
    ];
    /*
     * The help lines only while the whole form fits: the shared form squeezes
     * its rows rather than clipping them when it is taller than the screen,
     * and then rows vanish and overlap (a field you can still move to).
     */
    const withHelp = fields.map(field => {
        const text = help[field.id as keyof typeof help];
        return text ? { ...field, help: text } : field;
    });
    const fit = fitForm(withHelp, width, area.height, formError, null);
    if (!fit.fits)
        return <TooSmallDialog title="Create new account" needed={fit.height} error={formError} onCancel={busy ? undefined : props.onCancel} />;
    fields = [...fit.fields];

    return (
        <FormDialog
            title="Create new account"
            fields={fields}
            onChange={change}
            onSubmit={submit}
            onCancel={props.onCancel}
            submitLabel="Create"
            busy={busy !== null}
            busyText={busy ?? ""}
            error={formError}
            width={66}
        />
    );
}

/*
 * The height of a FormDialog without an intro, laid out as Form.tsx does:
 * border, title, a blank line, the fields with their error or help lines,
 * the form's error with its blank line, and the buttons with theirs.
 */
function formHeight(fields: readonly FormField[], outer: number, error: string | null, intro: string | null = null): number {
    const inner = dialogInnerWidth(outer);
    const labelWidth = Math.min(Math.floor(inner / 2), Math.max(...fields.map(field => textWidth(field.label))) + 2);
    const fieldWidth = Math.max(4, inner - labelWidth);
    const extra = fields.reduce((sum, field) => {
        const text = field.error || field.help;
        return sum + (text ? wrap(text, fieldWidth).length : 0);
    }, 0);
    return 6 + fields.length + extra + (error ? 1 + wrap(error, inner).length : 0) + (intro ? 1 + wrap(intro, inner).length : 0);
}

/*
 * A form that fits: its help lines, then its intro, are left out when the
 * whole form would be taller than the screen (the shared form squeezes its
 * rows rather than clipping them, and then rows vanish and overlap).
 * `fits` is false when even the bare form is too tall.
 */
function fitForm(fields: readonly FormField[], outer: number, room: number, error: string | null, intro: string | null) {
    const bare = fields.map((field): FormField => {
        if (!field.help)
            return field;
        const { help: _help, ...rest } = field;
        return rest as FormField;
    });
    const tries: [readonly FormField[], string | null][] = [[fields, intro], [bare, intro], [bare, null]];
    for (const [shown, text] of tries)
        if (formHeight(shown, outer, error, text) <= room)
            return { fields: shown, intro: text, fits: true, height: 0 };
    return { fields: bare, intro: null, fits: false, height: formHeight(bare, outer, error, null) };
}

/* Instead of a form the screen cannot hold: rows squeezed together would show values next to the wrong labels. */
function TooSmallDialog({ title, needed, error, onCancel }: {
    title: string, needed: number, error: string | null, onCancel: (() => void) | undefined,
}) {
    const area = useArea();
    const width = useDialogWidth(50);
    // The host's refusal, if there was one, comes first: it is what happened.
    const text = `${error ? `${error} ` : ""}This form needs ${needed} lines; the screen has ${area.height}. Enlarge the terminal, or press Esc.`;
    return (
        <Dialog title={title} width={width} tone={error ? "error" : "warning"} {...(onCancel ? { onCancel } : {})} hints={[["esc", "cancel"]]}>
            <Paragraph width={width} maxLines={Math.max(1, area.height - 3)} text={text} {...(error ? { color: colors.error } : {})} />
        </Dialog>
    );
}

/*
 * Two Enters for a form whose every key is text: someone who types a word
 * and Enter without "/" first ("nginx" on the Groups tab) opens the dialog
 * with its first letter, fills the field with the rest, and the Enter would
 * submit what they never saw. The first Enter says what the second will do;
 * any edit in between takes it back.
 */
function useSecondEnter() {
    /*
     * State, not a ref, on purpose: a second Enter counts only once the
     * question is on screen. Two Enters in one burst reach the handler
     * before React renders, both see no question, and both only ask.
     */
    const [armed, setArmed] = useState<string | null>(null);
    return {
        /** The question the first Enter put, until an edit. */
        question: armed,
        /** On Enter with valid input: whether this is the second Enter for exactly `question`. */
        confirmed: (question: string): boolean => {
            if (armed === question)
                return true;
            setArmed(question);
            return false;
        },
        reset: () => setArmed(null),
    };
}

// ---- delete ----------------------------------------------------------------------------

/*
 * Why userdel would refuse right now, from logind's state of the account:
 * it does while any process of the account runs -- a session, a closing
 * session's leftovers, or a lingering user manager. Empty when none runs.
 */
export function processWarning(name: string, state: string | undefined): string {
    if (isLoggedInState(state))
        return `${name} is logged in, and userdel refuses while their processes run: terminate the sessions first (t).`;
    if (state === "lingering")
        return `${name}'s user services are running (lingering), and userdel refuses while any of their processes run: ` +
            "stop them first (t).";
    if (hasProcessesState(state))
        return `${name} has logged out, but programs of the closed sessions still run, and userdel refuses while any of ` +
            "their processes run: end them first (t).";
    return "";
}

/*
 * delete-account-dialog.js: one checkbox, "Delete files" (userdel -r).
 *
 * Built on Dialog rather than FormDialog for two reasons: it must see the
 * keys typed into it (useTypeAheadGuard: "Dave" + Enter deleted bob, and a
 * space typed ahead must not tick "Delete files"), and its text must fit
 * a small screen instead of being squeezed into overlapping rows.
 */
export function DeleteAccountDialog(props: {
    account: Account,
    /** logind's State for the account, for the warning that userdel will refuse. */
    loginState: string | undefined,
    onDeleted: (warnings: string) => void,
    onCancel: () => void,
}) {
    const { account } = props;
    const mounted = useMounted();
    const area = useArea();
    const width = useDialogWidth(64);
    const inner = dialogInnerWidth(width);
    const guard = useTypeAheadGuard();
    const [removeFiles, setRemoveFiles] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const name = clean(account.name);

    const submit = () => {
        if (busy || !guard.mayConfirm())
            return;
        setBusy(true);
        setError(null);
        deleteAccount(account.name, removeFiles).then(
            result => {
                if (mounted())
                    props.onDeleted(result.stderr.trim());
            },
            (failure: unknown) => {
                if (!mounted())
                    return;
                setBusy(false);
                setError(hostError(failure));
            });
    };

    const onKey: KeyHandler = (input, key) => {
        if (busy)
            return isPlain(input, key);
        // A space typed ahead with a name ("Dave Smith") is not a decision either.
        if (input === " " && !guard.typed) {
            setRemoveFiles(value => !value);
            return true;
        }
        if (!isPlain(input, key))
            return false;
        guard.onStrayKey();
        return true;
    };

    const who = account.fullName ? `${name} (${clean(account.fullName)})` : name;
    const warning = processWarning(name, props.loginState);
    // System accounts are listed only on request (h), and upstream never offers to delete them.
    const intro = `The account ${who}, UID ${account.uid}, will be deleted. This cannot be undone.` +
        (account.system ? ` ${name} is a system account: packages and services may depend on it.` : "") +
        (warning ? ` ${warning}` : "");
    const label = "Delete files";
    const labelWidth = Math.min(Math.floor(inner / 2), textWidth(label) + 2);
    const help = wrap(`${account.home ? clean(account.home) : "the home directory"} and the mail spool (userdel -r)`,
                      Math.max(4, inner - labelWidth));
    const notice = guard.warned && !busy ? typedAheadNotice("delete") : null;

    // Border, title, the checkbox and the buttons line (each with a blank line) take 7 lines.
    const room = area.height - 7;
    const [errorLines, noticeLines, introLines] = shareLines(room, [
        error ? wrap(error, inner).length : 0,
        notice ? wrap(notice, inner).length : 0,
        wrap(intro, inner).length,
    ]);
    const used = (error ? 1 + errorLines! : 0) + (notice ? 1 + noticeLines! : 0) + 1 + introLines!;
    const showHelp = room - used >= help.length;

    return (
        <Dialog
            title={`Delete ${name}`}
            width={width}
            tone="error"
            onCancel={busy ? undefined : props.onCancel}
            onConfirm={busy ? undefined : submit}
            onKey={onKey}
            hints={busy ? [] : [["space", "toggle"], ["enter", "delete"], ["esc", "cancel"]]}
        >
            <Paragraph text={intro} width={width} maxLines={introLines!} />
            <Box marginTop={1} flexShrink={0}>
                <Text wrap="truncate">
                    <Text color={busy ? undefined : colors.accent} bold={!busy}>
                        {fit(`${busy ? " " : glyphs.pointer}${label}`, labelWidth)}
                    </Text>
                    {removeFiles ? "[x]" : "[ ]"}
                </Text>
            </Box>
            {showHelp && help.map((line, i) => (
                <Box key={i} marginLeft={labelWidth} flexShrink={0}><Text color={colors.dim}>{line}</Text></Box>
            ))}
            {notice ? <Paragraph text={notice} width={width} maxLines={noticeLines!} color={colors.warning} /> : null}
            {error ? <Paragraph text={error} width={width} maxLines={errorLines!} color={colors.error} /> : null}
            <ButtonsLine busy={busy} busyText={`Deleting ${name}`} label="Delete" />
        </Dialog>
    );
}

// ---- password --------------------------------------------------------------------------

/*
 * password-dialogs.js set_password_dialog() as an administrator: chpasswd,
 * after the same checks (match, length, pwscore with "use it anyway").
 *
 * chpasswd writes a fresh hash, so a locked password ("!" in front of the
 * hash) does not stay locked: the dialog says so up front when it knows the
 * account is locked, rather than leaving the admin to discover it later.
 */
export function PasswordDialog(props: { account: Account, locked: boolean, onDone: () => void, onCancel: () => void }) {
    const { account } = props;
    const mounted = useMounted();
    const area = useArea();
    const width = useDialogWidth(60);
    const [password, setPasswordValue] = useState("");
    const [confirm, setConfirm] = useState("");
    const [errors, setErrors] = useState<{ password?: string | undefined, confirm?: string | undefined }>({});
    const [busy, setBusy] = useState<string | null>(null);
    const [formError, setFormError] = useState<string | null>(null);
    const [weakAccepted, setWeakAccepted] = useState<string | null>(null);

    const submit = () => {
        if (busy)
            return;
        void (async () => {
            const found = validatePasswords(password, confirm, true);
            if (found.password || found.confirm) {
                setErrors(found);
                return;
            }
            if (weakAccepted !== password) {
                setBusy("Checking the password");
                const quality = await checkPasswordQuality(password);
                if (!mounted())
                    return;
                if (!quality.ok) {
                    setBusy(null);
                    setWeakAccepted(password);
                    setErrors({ password: weakMessage(quality.message) });
                    return;
                }
            }
            setBusy("Setting the password");
            try {
                await setPassword(account.name, password);
                if (mounted())
                    props.onDone();
            } catch (error) {
                if (!mounted())
                    return;
                setBusy(null);
                setFormError(hostError(error));
            }
        })();
    };

    const fit = fitForm([
        { kind: "password", id: "password", label: "New password", value: password, maxLength: 1024, error: errors.password ?? null },
        { kind: "password", id: "confirm", label: "Confirm password", value: confirm, maxLength: 1024, error: errors.confirm ?? null },
    ], width, area.height, formError, props.locked
        ? `Password login is disallowed for ${clean(account.name)} (locked). A new password replaces the locked one, which normally allows password login again.`
        : null);
    return (
        <FormDialog
            title={`Set password for ${clean(account.name)}`}
            {...(fit.intro ? { intro: fit.intro } : {})}
            fields={fit.fields}
            onChange={(id, value) => {
                if (id === "password")
                    setPasswordValue(String(value));
                else
                    setConfirm(String(value));
                setErrors(previous => ({ ...previous, [id]: undefined }));
                setFormError(null);
            }}
            onSubmit={submit}
            onCancel={props.onCancel}
            submitLabel="Set password"
            busy={busy !== null}
            busyText={busy ?? ""}
            error={formError}
            width={60}
        />
    );
}

// ---- groups ----------------------------------------------------------------------------

/* Groups whose members get the administrator role (the root group does not: see model.ts). */
const GRANTS_ADMIN = ADMIN_GROUPS.filter(group => group !== "root");

interface GroupsView {
    /** Membership changes marked so far, by group: wanted or not. */
    readonly pending: ReadonlyMap<string, boolean>;
    readonly filter: string;
    readonly cursor: number;
    readonly top: number;
    readonly busy: string | null;
    readonly error: string | null;
    /** Enter was pressed once with these changes: the next Enter applies them. */
    readonly armed: boolean;
}

/*
 * Supplementary groups (account-details.js AccountGroupsSelect). Upstream
 * applies each add or remove at once, with an Undo; here changes are marked
 * first and applied together with Enter, one gpasswd per change, so a slip
 * of the space bar costs nothing. The primary group cannot be removed (it
 * is in /etc/passwd, not /etc/group), as upstream disables it.
 */
export function GroupsDialog(props: {
    account: Account,
    groups: readonly GroupEntry[],
    loggedIn: boolean,
    /** The account is the one using the TUI: dropping an administrator group may lock them out. */
    self?: boolean,
    onDone: (summary: string) => void,
    onCancel: () => void,
}) {
    const { account } = props;
    const area = useArea();
    const width = useDialogWidth(60);
    const inner = dialogInnerWidth(width);
    const mounted = useMounted();
    /*
     * Everything the keys change lives in one ref, updated at once and then
     * rendered: a burst of keys (a fast typist, key repeat, a paste) can reach
     * onKey several times before React renders, and each key must see what
     * the one before it did -- else Down Down Space marks the row above the
     * cursor, and a second Esc clears an already cleared filter.
     */
    const [view, setView] = useState<GroupsView>(() => ({
        pending: new Map(), filter: "", cursor: 0, top: 0, busy: null, error: null, armed: false,
    }));
    const viewRef = useRef(view);
    // Whether the "press Enter again" question has been rendered: only then may an Enter apply.
    const armedShown = useRef(false);
    useLayoutEffect(() => {
        armedShown.current = view.armed;
    }, [view.armed]);
    const update = (change: Partial<GroupsView> | ((current: GroupsView) => Partial<GroupsView>)) => {
        const current = viewRef.current;
        viewRef.current = { ...current, ...(typeof change === "function" ? change(current) : change) };
        setView(viewRef.current);
    };

    const member = new Set(account.groups);
    const names = [...new Set(props.groups.map(group => group.name))].sort((a, b) => a.localeCompare(b));

    /*
     * The list gets the lines the rest leaves: border, title, the filter,
     * the list's blank line, the summary and the buttons (each with a blank
     * line) take 9; then the "must log in again" line when it shows, and an
     * error with its blank line. Everything else keeps its height (flexShrink
     * 0): squeezed, Ink drops rows from the middle and draws lines over each
     * other -- a primary-group note on the wrong group, an unreadable error,
     * or a cursor on a row that is not on screen.
     */
    const layout = (v: GroupsView) => {
        const needle = v.filter.toLowerCase();
        const visible = names.filter(name => name.toLowerCase().includes(needle));
        const changes = [...v.pending].filter(([group, wanted]) => wanted !== member.has(group));
        const message = v.error ?? (v.armed && !v.busy ? armedMessage(changes) : null);
        const chrome = 9;
        const relogin = props.loggedIn && changes.length > 0 && area.height - chrome > 1;
        const room = area.height - chrome - (relogin ? 1 : 0);
        const messageWanted = message ? wrap(message, inner).length : 0;
        const messageLines = message
            ? Math.max(1, Math.min(messageWanted, room - 1 - Math.min(3, Math.max(1, visible.length)))) : 0;
        const listHeight = Math.max(1, Math.min(Math.max(1, visible.length), room - (message ? 1 + messageLines : 0)));
        const at = Math.min(v.cursor, Math.max(0, visible.length - 1));
        let first = Math.min(v.top, Math.max(0, visible.length - listHeight));
        if (at < first)
            first = at;
        else if (at >= first + listHeight)
            first = at - listHeight + 1;
        return { visible, changes, message, messageLines, relogin, listHeight, at, first };
    };

    /* What the first Enter says before anything is applied; the second Enter applies it. */
    const armedMessage = (changes: [string, boolean][]): string => {
        const lost = props.self
            ? changes.filter(([group, wanted]) => !wanted && GRANTS_ADMIN.includes(group)).map(([group]) => clean(group))
            : [];
        return (lost.length
            ? `This removes your own account from ${lost.join(", ")}: you may no longer be able to get administrative access. `
            : "") + "Press Enter again to apply, or Esc to cancel.";
    };

    const { visible, changes, message, messageLines, relogin, listHeight, at, first } = layout(view);
    const isMember = (group: string) => view.pending.get(group) ?? member.has(group);

    const move = (to: number) => {
        const now = layout(viewRef.current);
        const next = Math.max(0, Math.min(now.visible.length - 1, to));
        update({
            cursor: next,
            top: next < now.first ? next : next >= now.first + now.listHeight ? next - now.listHeight + 1 : now.first,
            armed: false,
        });
    };

    const setFilter = (filter: string) => update({ filter, cursor: 0, top: 0, armed: false });

    const toggle = () => {
        const now = layout(viewRef.current);
        const group = now.visible[now.at];
        if (!group)
            return;
        if (group === account.primaryGroup) {
            update({ error: `${clean(group)} is the primary group of ${clean(account.name)} and cannot be removed here.`, armed: false });
            return;
        }
        update(current => ({
            error: null,
            armed: false,
            pending: new Map(current.pending).set(group, !(current.pending.get(group) ?? member.has(group))),
        }));
    };

    /*
     * Enter marks nothing as decided on its own: a word typed ahead ("gw "
     * + Enter: g opens this, w filters to wheel, the space toggles it) would
     * otherwise apply what nobody saw. The first Enter shows what will
     * happen; only an Enter right after it applies.
     */
    const apply = () => {
        const now = viewRef.current;
        if (now.busy)
            return;
        const { changes: wanted } = layout(now);
        if (wanted.length === 0) {
            props.onCancel();
            return;
        }
        // A second Enter in the same burst as the first has not seen the question yet.
        if (!now.armed || !armedShown.current) {
            update({ armed: true, error: null });
            return;
        }
        update({ armed: false, error: null, busy: "Applying" });
        void (async () => {
            const done: string[] = [];
            for (const [i, [group, add]] of wanted.entries()) {
                if (mounted())
                    update({ busy: `${add ? "Adding to" : "Removing from"} ${clean(group)} (${i + 1}/${wanted.length})` });
                try {
                    await setMembership(account.name, group, add);
                } catch (failure) {
                    if (!mounted())
                        return;
                    update({ busy: null, error: `${add ? "Adding to" : "Removing from"} ${clean(group)} failed: ${hostError(failure)}` });
                    return;
                }
                done.push(`${add ? "+" : "-"}${clean(group)}`);
                if (mounted())
                    update(current => {
                        const pending = new Map(current.pending);
                        pending.delete(group);
                        return { pending };
                    });
            }
            if (mounted())
                props.onDone(done.join(" "));
        })();
    };

    const onKey: KeyHandler = (input, key) => {
        const now = viewRef.current;
        if (now.busy)
            return true;
        const { at: here, listHeight: rows, visible: shown } = layout(now);
        if (key.upArrow) move(here - 1);
        else if (key.downArrow) move(here + 1);
        else if (key.pageUp) move(here - Math.max(1, rows - 1));
        else if (key.pageDown) move(here + Math.max(1, rows - 1));
        else if (key.home) move(0);
        else if (key.end) move(shown.length - 1);
        else if (key.return) apply();
        else if (key.escape) {
            if (!now.filter)
                return false; // the dialog's own Esc: cancel
            setFilter("");
        } else if (key.backspace || key.delete) {
            setFilter(now.filter.slice(0, -1));
        } else if (input === " ") toggle();
        else if (input && !key.ctrl && !key.meta && !key.tab && /^[\x21-\x7e]+$/.test(input)) {
            setFilter(now.filter + input);
        } else return false;
        return true;
    };

    const { filter, busy, error } = view;
    const nameWidth = Math.max(8, Math.min(32, inner - 22));
    const summary = changes.length === 0
        ? "No changes."
        : `Will ${[
            changes.some(([, w]) => w) ? `add to ${changes.filter(([, w]) => w).map(([g]) => clean(g)).join(", ")}` : "",
            changes.some(([, w]) => !w) ? `remove from ${changes.filter(([, w]) => !w).map(([g]) => clean(g)).join(", ")}` : "",
        ].filter(Boolean).join("; ")}.`;

    return (
        <Dialog
            title={`Groups of ${clean(account.name)}`}
            width={width}
            onCancel={busy ? undefined : props.onCancel}
            onKey={onKey}
            hints={busy ? [] : [["space", "toggle"], ["enter", "apply"], ["esc", filter ? "clear filter" : "cancel"]]}
        >
            <Box flexShrink={0}>
                <Text wrap="truncate">
                    <Text color={colors.dim}>Filter: </Text>
                    {filter ? clean(filter) : <Text color={colors.dim}>type to filter</Text>}
                </Text>
            </Box>
            <Box flexDirection="column" marginTop={1} height={listHeight} flexShrink={0} overflow="hidden">
                {visible.length === 0
                    ? <Text color={colors.dim}>No group matches.</Text>
                    : visible.slice(first, first + listHeight).map((group, i) => {
                        const index = first + i;
                        const primary = group === account.primaryGroup;
                        const wanted = isMember(group);
                        const changed = !primary && wanted !== member.has(group);
                        const box = primary ? "[=]" : wanted ? "[x]" : "[ ]";
                        const note = primary ? "primary group"
                            : changed ? (wanted ? "will add" : "will remove")
                                : GRANTS_ADMIN.includes(group) ? "administrator role" : "";
                        const selected = index === at;
                        return (
                            <Text key={group} wrap="truncate" inverse={selected && !busy}>
                                {selected ? glyphs.pointer : " "} {box} {fit(clean(group), nameWidth)}{" "}
                                <Text color={changed ? colors.warning : colors.dim}>{truncate(note, Math.max(0, inner - nameWidth - 8))}</Text>
                            </Text>
                        );
                    })}
            </Box>
            <Box marginTop={1} flexShrink={0}>
                <Text color={changes.length ? colors.warning : colors.dim} wrap="truncate">{truncate(summary, inner)}</Text>
            </Box>
            {relogin && (
                <Box flexShrink={0}>
                    <Text color={colors.dim} wrap="truncate">
                        {truncate(`${clean(account.name)} must log out and back in for the change to take effect.`, inner)}
                    </Text>
                </Box>
            )}
            {message
                ? <Paragraph text={message} width={width} maxLines={messageLines} color={error ? colors.error : colors.warning} />
                : null}
            <Box marginTop={1} flexShrink={0}>
                {busy
                    ? <Spinner label={busy} />
                    : <Text color={colors.dim} wrap="truncate">[Space] Toggle   [Enter] Apply   [Esc] Cancel</Text>}
            </Box>
        </Dialog>
    );
}

// ---- SSH keys --------------------------------------------------------------------------

/*
 * authorized-keys-panel.js add_authorized_key_dialog(), one line at a time.
 * `self`: your own account, whose keys are added as yourself; anyone else's
 * as that account (actions.ts adderArgv()).
 */
export function AddKeyDialog(props: {
    account: Account, self: boolean, onDone: (key: AuthorizedKey) => void, onCancel: () => void,
}) {
    const { account } = props;
    const mounted = useMounted();
    const [text, setText] = useState("");
    const [fieldError, setFieldError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = () => {
        if (busy)
            return;
        const problem = checkKeyText(text);
        if (problem) {
            setFieldError(problem);
            return;
        }
        setBusy(true);
        setError(null);
        addKey(account.name, account.home, text, props.self).then(
            key => {
                if (mounted())
                    props.onDone(key);
            },
            (failure: unknown) => {
                if (!mounted())
                    return;
                setBusy(false);
                const message = hostError(failure);
                if (message === "The key you provided was not valid.")
                    setFieldError(message);
                else
                    setError(message);
            });
    };

    return (
        <FormDialog
            title={`Add SSH key for ${clean(account.name)}`}
            fields={[{
                kind: "text", id: "key", label: "Public key", value: text, maxLength: 16384,
                placeholder: `ssh-ed25519 AAAA${glyphs.ellipsis} user@host`, error: fieldError,
                help: "One key: the line from a .pub file.",
            }]}
            onChange={(_id, value) => {
                setText(String(value));
                setFieldError(null);
                setError(null);
            }}
            onSubmit={submit}
            onCancel={props.onCancel}
            submitLabel="Add key"
            busy={busy}
            busyText="Adding the key"
            error={error}
            width={72}
        />
    );
}

// ---- groups (the Groups tab) ---------------------------------------------------------------

/*
 * A group in full (Enter on the Groups tab): its members wrapped rather than
 * cut, as many lines as the screen has room for.
 */
export function GroupInfoDialog({ group, onClose }: { group: GroupInfo, onClose: () => void }) {
    const area = useArea();
    const width = useDialogWidth(66);
    const inner = dialogInnerWidth(width);
    const labelWidth = Math.min(18, Math.floor(inner / 3));
    const valueWidth = Math.max(8, inner - labelWidth);
    const kind = group.admin ? "administrator group: its members get the administrator role"
        : group.userCreated ? "user-created" : "system group";
    const members = group.members.map(name => clean(name));
    // "nobody" would read as the account of that name, which every host has.
    const rows: { label: string, value: string, dim?: boolean, list?: readonly string[] }[] = [
        { label: "Group ID", value: String(group.gid) },
        { label: "Kind", value: kind },
        { label: "Primary group of", ...(group.primary.length ? { value: group.primary.map(name => clean(name)).join(", ") } : { value: "none", dim: true }) },
        { label: "Members", ...(members.length ? { value: members.join(", "), list: members } : { value: "none", dim: true }) },
    ];
    /*
     * Border, title, two blank lines and the button line take 6 lines. Every
     * row gets its first line; the lines left over go to the rows in order.
     * A list cut short says how many it leaves out; other values end in an
     * ellipsis.
     */
    let spare = Math.max(0, area.height - 6 - rows.length);
    const lines: { label: string, text: string, dim: boolean }[] = [];
    for (const row of rows) {
        let wrapped = wrap(row.value, valueWidth);
        const take = Math.min(wrapped.length, 1 + spare);
        spare -= take - 1;
        if (take < wrapped.length)
            wrapped = row.list ? cutList(row.list, valueWidth, take) : [
                ...wrapped.slice(0, take - 1), truncate(`${wrapped[take - 1]} ${glyphs.ellipsis}`, valueWidth),
            ];
        wrapped.slice(0, take).forEach((text, i) => lines.push({ label: i === 0 ? row.label : "", text, dim: row.dim ?? false }));
    }
    return (
        <Dialog title={`Group ${clean(group.name)}`} width={width} onCancel={onClose} onConfirm={onClose} hints={[["esc", "close"]]}>
            <Box flexDirection="column" marginTop={1}>
                {lines.map((line, i) => (
                    <Text key={i} wrap="truncate">
                        <Text color={colors.dim}>{fit(line.label, labelWidth)}</Text>
                        {line.dim ? <Text color={colors.dim}>{line.text}</Text> : line.text}
                    </Text>
                ))}
            </Box>
            <Box marginTop={1}><Buttons cancel="Close" /></Box>
        </Dialog>
    );
}

/*
 * As many names of `list` as fit in `lines` lines of `width`, then how many
 * were left out: "alice, bob, … and 81 more".
 */
export function cutList(list: readonly string[], width: number, lines: number): string[] {
    const text = (shown: number) =>
        `${list.slice(0, shown).join(", ")}${shown > 0 ? ", " : ""}${glyphs.ellipsis} and ${list.length - shown} more`;
    let low = 0;
    let high = list.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (wrap(text(middle), width).length <= lines)
            low = middle;
        else
            high = middle - 1;
    }
    return wrap(text(low), width).slice(0, lines);
}

/*
 * group-create-dialog.js: a name and a GID, offered as what groupadd itself
 * would pick (model.ts nextGid()). Clearing the GID leaves the choice to
 * groupadd. Both are checked against all of /etc/group first.
 */
export function CreateGroupDialog(props: {
    groups: readonly GroupEntry[],
    loginDefs: LoginDefs,
    onCreated: (name: string) => void,
    onCancel: () => void,
}) {
    const mounted = useMounted();
    const area = useArea();
    const width = useDialogWidth(60);
    const [name, setName] = useState("");
    const [gid, setGid] = useState(() => String(nextGid(props.groups, props.loginDefs) ?? ""));
    const [errors, setErrors] = useState<{ name?: string | null, gid?: string | null }>({});
    const [busy, setBusy] = useState(false);
    const running = useRef(false);
    const [error, setError] = useState<string | null>(null);
    const second = useSecondEnter();

    const submit = () => {
        if (running.current)
            return;
        // A clashing GID's message names the group that has it, as /etc/group spells it.
        const gidError = validateGid(gid, props.groups);
        const found = { name: validateGroupName(name, props.groups), gid: gidError === null ? null : clean(gidError) };
        if (found.name || found.gid) {
            second.reset();
            setErrors(found);
            return;
        }
        const id = gid.trim();
        if (!second.confirmed(`Press Enter again to create ${clean(name)}${id ? ` (GID ${id})` : ""}.`))
            return;
        second.reset();
        running.current = true;
        setBusy(true);
        setError(null);
        createGroup(name, id).then(
            () => {
                if (mounted())
                    props.onCreated(name);
            },
            (failure: unknown) => {
                running.current = false;
                if (!mounted())
                    return;
                setBusy(false);
                setError(hostError(failure));
            });
    };

    const message = error ?? second.question;
    const fit = fitForm([
        { kind: "text", id: "name", label: "Name", value: name, maxLength: 64, error: errors.name ?? null },
        {
            kind: "text", id: "gid", label: "Group ID", value: gid, maxLength: 10, error: errors.gid ?? null,
            help: "Empty lets groupadd choose.",
        },
    ], width, area.height, message, null);
    return (
        <FormDialog
            title="Create new group"
            fields={fit.fields}
            onChange={(id, value) => {
                if (id === "name")
                    setName(String(value));
                else
                    setGid(String(value));
                setErrors(previous => ({ ...previous, [id]: null }));
                setError(null);
                second.reset();
            }}
            onSubmit={submit}
            onCancel={props.onCancel}
            submitLabel="Create"
            busy={busy}
            busyText={`Creating the group ${clean(name)}`}
            error={message}
            width={60}
        />
    );
}

/* rename-group-dialog.jsx, with its warning, and the name checked first. */
export function RenameGroupDialog(props: {
    group: GroupInfo,
    groups: readonly GroupEntry[],
    onRenamed: (name: string) => void,
    onCancel: () => void,
}) {
    const { group } = props;
    const mounted = useMounted();
    const area = useArea();
    const width = useDialogWidth(60);
    // The field shows its value as it is: the name from /etc/group goes in cleaned.
    const [name, setName] = useState(() => clean(group.name));
    const [fieldError, setFieldError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const running = useRef(false);
    const [error, setError] = useState<string | null>(null);
    const second = useSecondEnter();

    const submit = () => {
        if (running.current)
            return;
        const problem = name === group.name || name === clean(group.name)
            ? "Type the new name." : validateGroupName(name, props.groups);
        if (problem) {
            second.reset();
            setFieldError(problem);
            return;
        }
        if (!second.confirmed(`Press Enter again to rename ${clean(group.name)} to ${clean(name)}.`))
            return;
        second.reset();
        running.current = true;
        setBusy(true);
        setError(null);
        renameGroup(group.name, name).then(
            () => {
                if (mounted())
                    props.onRenamed(name);
            },
            (failure: unknown) => {
                running.current = false;
                if (!mounted())
                    return;
                setBusy(false);
                setError(hostError(failure));
            });
    };

    const message = error ?? second.question;
    const fit = fitForm([{ kind: "text", id: "name", label: "New name", value: name, maxLength: 64, error: fieldError }],
                        width, area.height, message,
                        "Renaming a group may affect sudo rules and similar configuration that refer to it by name.");
    return (
        <FormDialog
            title={`Rename group ${clean(group.name)}`}
            {...(fit.intro ? { intro: fit.intro } : {})}
            fields={fit.fields}
            onChange={(_id, value) => {
                setName(String(value));
                setFieldError(null);
                setError(null);
                second.reset();
            }}
            onSubmit={submit}
            onCancel={props.onCancel}
            submitLabel="Rename"
            busy={busy}
            busyText={`Renaming ${clean(group.name)}`}
            error={message}
            width={60}
        />
    );
}

/*
 * delete-group-dialog.js, said in full: groupdel refuses to delete a
 * group that is someone's primary group, so that takes -f ("Force delete"),
 * and those accounts keep a primary GID without a name -- as do files
 * owned by the group, which no tool cleans up.
 */
export function deleteGroupMessage(group: GroupInfo): string {
    const name = clean(group.name);
    const primary = group.primary.map(account => clean(account));
    const members = group.members.filter(member => !group.primary.includes(member)).map(member => clean(member));
    const text = [primary.length
        ? `${name} (GID ${group.gid}) is the primary group of ${primary.join(", ")}. Deleting it anyway (groupdel -f) ` +
          `leaves ${primary.length === 1 ? "that account" : "those accounts"} with GID ${group.gid} as a primary group without a name.`
        : `Delete the group ${name} (GID ${group.gid})?`];
    if (members.length)
        text.push(`Its members lose it: ${members.join(", ")}.`);
    text.push(`Files owned by the group keep GID ${group.gid}.`);
    return text.join(" ");
}
