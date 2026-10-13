/*
 * Colours: the colour schemes, and making your own.
 *
 * Not one of Cockpit's pages, and the only one that has nothing to do with
 * the managed host: it changes how cockpit-tui itself is painted, and what
 * it keeps is in the viewer's own settings file (config.ts), on the machine
 * cockpit-tui runs on.
 *
 *   Scheme   ‹ My dark ›   yours · 3 of 5
 *   Windows
 *   › Background                          #3a3a3a  ████
 *     Text and borders                    white    ████
 *
 * The scheme shown is the scheme in use: ← and → go through them, and the
 * whole program repaints. The built-in ones cannot be changed; `n` makes a
 * copy that can, under a name of your choosing. In a scheme of your own,
 * Enter on a colour opens a dialog that shows each choice as it is made;
 * keeping one writes the settings file at once -- there is nothing to save
 * and nothing to lose on quitting. `--theme NAME` and the picker under `?`
 * know your schemes by name like the built-in ones.
 *
 * A scheme of your own is one set of colours for every terminal: where the
 * terminal has only sixteen, a shade is shown as the nearest of those.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { Box, InkText, Text } from "../../tui/ink.js";
import { useKeys, type Hint } from "../../tui/keyboard.js";
import type { PageProps } from "../../tui/page.js";
import { ConfirmDialog } from "../../tui/components/Dialog.js";
import { FormDialog, type FormField } from "../../tui/components/Form.js";
import { Panel, PANEL_EDGE, panelled } from "../../tui/components/Panel.js";
import { useListNav } from "../../tui/components/Table.js";
import { usePersistentState } from "../../tui/session-context.js";
import { errorText, useStatus } from "../../tui/status.js";
import { clean, fit, truncate } from "../../tui/text.js";
import {
    applyScheme, BASIC_COLOURS, colors, customSchemes, glyphs, isBuiltinTheme, listThemes, registerScheme, removeScheme,
    schemeNameProblem, schemeOf, setTheme, styled, subscribeTheme, themeName, themeVersion, unicode, type Scheme,
} from "../../tui/theme.js";
import { writeConfig } from "../../config.js";
import { collisions, forkScheme, parseColour, slotValue, SLOTS, withSlot, type Slot } from "./model.js";

/** How long the delete question is up before Enter answers it. */
export const CONFIRM_ARM_MS = 300;

/** The select's last choice: a colour given as "#rrggbb" instead of by name. */
const OTHER = "other";

/** Write the viewer's schemes and which one is in use; say so when that fails. */
function useSave(): () => void {
    const { notify } = useStatus();
    return () => {
        try {
            writeConfig({ theme: themeName(), schemes: customSchemes() });
        } catch (error) {
            notify(`The colours are kept for this run only: the settings file could not be written (${clean(errorText(error))})`, "warning");
        }
    };
}

// ---- dialogs -------------------------------------------------------------------------

function ColourDialog({ name, scheme, slot, onClose }: { name: string, scheme: Scheme, slot: Slot, onClose: () => void }) {
    const save = useSave();
    const original = slotValue(scheme, slot.id);
    const named = BASIC_COLOURS.includes(original);
    const [choice, setChoice] = useState(named ? original : OTHER);
    const [hex, setHex] = useState(named ? "" : original);
    const [problem, setProblem] = useState<string | null>(null);

    /** The colour the fields say, or null while the hex is not one yet. */
    const picked = (nextChoice: string, nextHex: string) => (nextChoice === OTHER ? parseColour(nextHex, []) : nextChoice);
    // Each choice is shown at once, on the whole program.
    const preview = (nextChoice: string, nextHex: string) => {
        const colour = picked(nextChoice, nextHex);
        applyScheme(colour ? withSlot(scheme, slot.id, colour) : null);
    };

    const fields: FormField[] = [
        {
            id: "choice", kind: "select", label: "Colour", value: choice,
            options: [...BASIC_COLOURS.map(colour => ({ value: colour, label: colour })), { value: OTHER, label: "another: give it below" }],
        },
        {
            id: "hex", kind: "text", label: "As #rrggbb", value: hex, placeholder: "#3a3a3a", maxLength: 7,
            disabled: choice !== OTHER, error: problem,
            help: "Red, green and blue, two hex digits each. On a terminal with sixteen colours it is shown as the nearest of those.",
        },
    ];

    return (
        <FormDialog
            title={`${slot.group}: ${slot.label}`}
            intro={`Was ${original}. Each choice is shown as you make it.`}
            fields={fields}
            submitLabel="Keep"
            onChange={(id, value) => {
                const nextChoice = id === "choice" ? String(value) : choice;
                const nextHex = id === "hex" ? String(value) : hex;
                if (id === "choice")
                    setChoice(nextChoice);
                else
                    setHex(nextHex);
                setProblem(null);
                preview(nextChoice, nextHex);
            }}
            onSubmit={() => {
                const colour = picked(choice, hex);
                if (!colour) {
                    setProblem("Not a colour: six hex digits after #, like #1c1c1c");
                    return;
                }
                // Stored first: registering repaints from what is stored.
                registerScheme(name, withSlot(scheme, slot.id, colour));
                save();
                onClose();
            }}
            onCancel={() => {
                applyScheme(null);
                onClose();
            }}
        />
    );
}

function NameDialog({ title, intro, initial, submit, onDone, onClose }: {
    title: string, intro: string, initial: string, submit: string,
    onDone: (name: string) => void, onClose: () => void,
}) {
    const [name, setName] = useState(initial);
    const [problem, setProblem] = useState<string | null>(null);
    return (
        <FormDialog
            title={title}
            intro={intro}
            fields={[{
                id: "name", kind: "text", label: "Name", value: name, maxLength: 24, error: problem,
                help: "Lower-case letters, digits and dashes: it is also what --theme takes.",
            }]}
            submitLabel={submit}
            onChange={(_id, value) => {
                setName(String(value));
                setProblem(null);
            }}
            onSubmit={() => {
                const wanted = name.trim();
                const invalid = schemeNameProblem(wanted) ?? (listThemes().some(t => t.name === wanted) ? `There is a scheme called ${wanted} already` : null);
                if (invalid)
                    setProblem(invalid);
                else
                    onDone(wanted);
            }}
            onCancel={onClose}
        />
    );
}

// ---- the page ------------------------------------------------------------------------

type DialogState =
    | { readonly kind: "colour", readonly slot: Slot }
    | { readonly kind: "new" }
    | { readonly kind: "rename" }
    | { readonly kind: "delete" };

/** A row of the list: a group's heading, or a slot. */
type Line = { readonly heading: string } | { readonly slot: Slot };

/** A name not taken yet, to suggest for a copy of `from`. */
function suggestName(from: string): string {
    const taken = new Set(listThemes().map(t => t.name));
    const base = isBuiltinTheme(from) ? `my-${from}` : `${from}-copy`.slice(0, 24);
    if (!taken.has(base))
        return base;
    for (let n = 2; n < 100; n++) {
        const candidate = `${base.slice(0, 21)}-${n}`;
        if (!taken.has(candidate))
            return candidate;
    }
    return "";
}

export default function ColoursPage({ width, height }: PageProps) {
    // The list of schemes and their colours change under the page: on every change, look again.
    useSyncExternalStore(subscribeTheme, themeVersion);
    const { notify } = useStatus();
    const save = useSave();
    const [dialog, setDialog] = useState<DialogState | null>(null);
    const [selection, setSelection] = usePersistentState<string | null>("colours:slot", null);

    const themes = listThemes();
    const name = themeName();
    const at = Math.max(0, themes.findIndex(t => t.name === name));
    const info = themes[at]!;
    const scheme = schemeOf(name);
    const editable = info.custom;

    // Two panels when there is room: the scheme, and its colours.
    const boxed = panelled(width, height);
    const inner = boxed ? width - PANEL_EDGE : width;
    const unreadable = collisions(scheme);
    const headRows = 2 + (unreadable.length ? 1 : 0);
    const listRows = Math.max(2, (boxed ? height - 2 * PANEL_EDGE : height) - headRows);

    const lines = useMemo<Line[]>(() => {
        const out: Line[] = [];
        let group = "";
        for (const slot of SLOTS) {
            if (slot.group !== group) {
                group = slot.group;
                out.push({ heading: group });
            }
            out.push({ slot });
        }
        return out;
    }, []);
    const keys = useMemo(() => SLOTS.map(slot => slot.id), []);
    const nav = useListNav(keys, Math.max(1, listRows - 3), { active: dialog === null, initialKey: selection });
    const selected = nav.index >= 0 ? SLOTS[nav.index]! : null;

    const use = (next: string) => {
        setTheme(next);
        save();
    };

    const hints: Hint[] = [
        [glyphs.leftright, "scheme"],
        ...(editable ? [["enter", "change colour"] as const] : []),
        ["n", editable ? "copy" : "copy to change"],
        ...(editable ? [["r", "rename"] as const, ["d", "delete"] as const] : []),
    ];

    useKeys((input, key) => {
        if (key.leftArrow || key.rightArrow) {
            const next = themes[(at + (key.rightArrow ? 1 : -1) + themes.length) % themes.length]!;
            use(next.name);
            return true;
        }
        if (key.return) {
            if (!selected)
                return true;
            setSelection(selected.id);
            if (editable)
                setDialog({ kind: "colour", slot: selected });
            else
                notify(`${info.label} is built in and cannot be changed: press n to make a copy that can`, "info");
            return true;
        }
        if (key.ctrl || key.meta)
            return false;
        if (input === "j" || input === "k") {
            nav.select(nav.index + (input === "j" ? 1 : -1));
            return true;
        }
        if (input === "n") {
            setDialog({ kind: "new" });
            return true;
        }
        if ((input === "r" || input === "d") && !editable) {
            notify(`${info.label} is built in: it cannot be ${input === "r" ? "renamed" : "deleted"}`, "info");
            return true;
        }
        if (input === "r") {
            setDialog({ kind: "rename" });
            return true;
        }
        if (input === "d") {
            setDialog({ kind: "delete" });
            return true;
        }
        return false;
    }, { active: dialog === null, hints });

    // ---- the list, scrolled to keep the selected slot in view --------------------------
    const selectedLine = selected ? lines.findIndex(line => "slot" in line && line.slot.id === selected.id) : 0;
    const top = Math.max(0, Math.min(Math.max(0, lines.length - listRows),
                                     selectedLine - Math.floor(listRows / 2) < 0 ? 0 : selectedLine - Math.floor(listRows / 2)));
    const shown = lines.slice(top, top + listRows);
    const valueWidth = 14;
    const swatchWidth = 4;
    const labelWidth = Math.max(8, inner - 2 - valueWidth - swatchWidth - 2);

    const swatch = (slot: Slot) => {
        const colour = slotValue(scheme, slot.id);
        if (!styled)
            return <Text>{" ".repeat(swatchWidth)}</Text>;
        // A text colour is shown as text on what it is painted on; a background as a block of itself.
        return slot.on
            ? <InkText color={colour} backgroundColor={slotValue(scheme, slot.on)}>{fit("Abc", swatchWidth)}</InkText>
            : <InkText backgroundColor={colour}>{" ".repeat(swatchWidth)}</InkText>;
    };

    const close = () => setDialog(null);
    const position = `${at + 1} of ${themes.length}`;

    return (
        <Box flexDirection="column" width={width} height={height}>
            <Panel plain={!boxed} title="Scheme" detail={position} width={width} height={headRows + (boxed ? PANEL_EDGE : 0)}>
                <Text wrap="truncate">
                    <Text color={colors.dim}>{`${unicode ? "‹" : "<"} `}</Text>
                    <Text bold color={colors.accent}>{clean(info.label)}</Text>
                    <Text color={colors.dim}>{` ${unicode ? "›" : ">"}   `}</Text>
                    {editable ? `yours, as --theme ${name}` : "built in"}
                    {info.description ? <Text color={colors.dim}>{`  ${glyphs.dot}  ${truncate(clean(info.description), Math.max(0, inner - 40))}`}</Text> : ""}
                </Text>
                <Text color={colors.dim} wrap="truncate">
                    {!styled
                        ? "Colours are switched off here (NO_COLOR, or a terminal without them): schemes can be changed, not seen."
                        : editable
                            ? "Enter changes the selected colour; what you keep is saved at once."
                            : "Built-in schemes cannot be changed: n makes a copy of this one that can."}
                </Text>
                {unreadable.length > 0 && (
                    <Text color={colors.warning} wrap="truncate">
                        {`${glyphs.warning} Unreadable: ${unreadable.map(slot => `${slot.group.toLowerCase()} / ${slot.label.split(":")[0]!.toLowerCase()}`).join("; ")} ${unreadable.length === 1 ? "is" : "are"} the colour of what is behind`}
                    </Text>
                )}
            </Panel>
            <Panel plain={!boxed} title="Colours" detail={selected ? `${nav.index + 1}/${SLOTS.length}` : ""} width={width} height={listRows + (boxed ? PANEL_EDGE : 0)}>
                {shown.map((line, i) => {
                    if ("heading" in line)
                        return <Text key={`h${i}`} bold color={colors.dim} wrap="truncate">{fit(line.heading, inner)}</Text>;
                    const slot = line.slot;
                    const isSelected = selected?.id === slot.id;
                    return (
                        <Box key={slot.id} width={inner} height={1}>
                            <Text inverse={isSelected && dialog === null} bold={isSelected && dialog !== null} wrap="truncate">
                                {`${isSelected ? glyphs.pointer : " "} ${fit(slot.label, labelWidth)}${fit(slotValue(scheme, slot.id), valueWidth)}`}
                            </Text>
                            {swatch(slot)}
                        </Box>
                    );
                })}
            </Panel>
            {dialog?.kind === "colour" && <ColourDialog name={name} scheme={scheme} slot={dialog.slot} onClose={close} />}
            {dialog?.kind === "new" && (
                <NameDialog
                    title={`Copy ${clean(info.label)}`}
                    intro="A scheme of your own, starting with these colours."
                    initial={suggestName(name)}
                    submit="Create"
                    onClose={close}
                    onDone={created => {
                        registerScheme(created, forkScheme(scheme, created, info.label));
                        use(created);
                        notify(`Made ${created}: Enter changes a colour`, "success");
                        close();
                    }}
                />
            )}
            {dialog?.kind === "rename" && (
                <NameDialog
                    title={`Rename ${clean(info.label)}`}
                    intro="The name is what --theme and the settings file know it by."
                    initial={name}
                    submit="Rename"
                    onClose={close}
                    onDone={renamed => {
                        registerScheme(renamed, { ...forkScheme(scheme, renamed, ""), description: scheme.description });
                        setTheme(renamed);
                        removeScheme(name);
                        save();
                        notify(`Renamed to ${renamed}`, "success");
                        close();
                    }}
                />
            )}
            {dialog?.kind === "delete" && (
                <ConfirmDialog
                    title={`Delete ${clean(info.label)}`}
                    message={`Delete your colour scheme ${clean(name)}? The built-in ${schemeOf("dark").label} takes its place.`}
                    confirmLabel="Delete"
                    danger
                    armMs={CONFIRM_ARM_MS}
                    onCancel={close}
                    onConfirm={() => {
                        removeScheme(name);
                        save();
                        notify(`Deleted ${name}`, "success");
                        close();
                    }}
                />
            )}
        </Box>
    );
}
