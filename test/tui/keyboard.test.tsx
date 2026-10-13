import { describe, it, expect, afterEach } from "vitest";
import { useState } from "react";
import { Text } from "ink";
import { KeyboardProvider, KeyScope, Layer, useHints, useKeys, createKeyboard, splitInput, makeKey } from "../../src/tui/keyboard.js";
import { TextInput } from "../../src/tui/components/TextInput.js";
import { onInternalError } from "../../src/tui/log.js";
import { renderInk, cleanup, keys } from "../helpers/ink.js";

afterEach(cleanup);

function Recorder({ name, log, layer, consume = true, trap = false, active = true, hints = [] }: {
    name: string, log: string[], layer?: number, consume?: boolean, trap?: boolean, active?: boolean,
    hints?: [string, string][],
}) {
    useKeys(input => {
        log.push(`${name}:${input}`);
        return consume;
    }, { layer: layer ?? Layer.page, trap, active, hints });
    return null;
}

function HintLine() {
    const hints = useHints();
    return <Text>hints={hints.map(([k, l]) => `${k} ${l}`).join(",")}</Text>;
}

describe("keyboard dispatch", () => {
    it("gives a key to the highest layer only", async () => {
        const log: string[] = [];
        const r = renderInk(
            <KeyboardProvider>
                <Recorder name="global" log={log} layer={Layer.global} />
                <Recorder name="page" log={log} layer={Layer.page} />
                <Recorder name="input" log={log} layer={Layer.input} />
                <Text>ready</Text>
            </KeyboardProvider>);
        await r.waitFor("ready");
        await r.press("x");
        expect(log).toEqual(["input:x"]);
    });

    it("falls through when a handler declines the key", async () => {
        const log: string[] = [];
        const r = renderInk(
            <KeyboardProvider>
                <Recorder name="global" log={log} layer={Layer.global} />
                <Recorder name="page" log={log} layer={Layer.page} consume={false} />
                <Text>ready</Text>
            </KeyboardProvider>);
        await r.waitFor("ready");
        await r.press("y");
        expect(log).toEqual(["page:y", "global:y"]);
    });

    it("skips inactive handlers", async () => {
        const log: string[] = [];
        const r = renderInk(
            <KeyboardProvider>
                <Recorder name="global" log={log} layer={Layer.global} />
                <Recorder name="page" log={log} layer={Layer.page} active={false} />
                <Text>ready</Text>
            </KeyboardProvider>);
        await r.waitFor("ready");
        await r.press("z");
        expect(log).toEqual(["global:z"]);
    });

    it("lets everything inside a scope outrank everything outside it, and a trap stop the rest", async () => {
        const log: string[] = [];
        const r = renderInk(
            <KeyboardProvider>
                <Recorder name="outer-input" log={log} layer={Layer.input} consume={false} />
                <KeyScope>
                    <Recorder name="dialog-field" log={log} layer={Layer.input} consume={false} />
                    <Recorder name="dialog" log={log} layer={Layer.global} consume={false} trap />
                </KeyScope>
                <Text>ready</Text>
            </KeyboardProvider>);
        await r.waitFor("ready");
        await r.press("k");
        // The dialog's own field first, then the dialog, which traps: the
        // page's text field outside never sees the key.
        expect(log).toEqual(["dialog-field:k", "dialog:k"]);
    });

    it("always delivers system keys first, even past a trap", async () => {
        const log: string[] = [];
        const r = renderInk(
            <KeyboardProvider>
                <Recorder name="system" log={log} layer={Layer.system} consume={false} />
                <KeyScope>
                    <Recorder name="dialog" log={log} layer={Layer.global} trap />
                </KeyScope>
                <Text>ready</Text>
            </KeyboardProvider>);
        await r.waitFor("ready");
        await r.press(keys.ctrl("c"));
        expect(log).toEqual(["system:c", "dialog:c"]);
    });

    it("orders same-layer handlers by registration, children before parents", () => {
        const keyboard = createKeyboard();
        const log: string[] = [];
        const make = (id: number, name: string) => ({
            id, scope: 0, layer: Layer.page, active: true, trap: false, hints: [], help: null,
            handler: { current: () => { log.push(name); return false } },
        });
        keyboard.register(make(2, "second"));
        keyboard.register(make(1, "first"));
        keyboard.dispatch("a", {} as never);
        expect(log).toEqual(["first", "second"]);
    });

    it("collects hints from active handlers, cut off below a trap", async () => {
        function Dialog() {
            return (
                <KeyScope>
                    <Recorder name="d" log={[]} layer={Layer.global} trap hints={[["esc", "close"]]} />
                </KeyScope>
            );
        }
        function Harness() {
            const [open, setOpen] = useState(false);
            useKeys(input => {
                if (input === "o") { setOpen(true); return true }
                return false;
            }, { layer: Layer.global, hints: [["o", "open"]] });
            return (
                <>
                    <Recorder name="p" log={[]} consume={false} hints={[["enter", "details"]]} />
                    {open && <Dialog />}
                    <HintLine />
                </>
            );
        }
        const r = renderInk(<KeyboardProvider><Harness /></KeyboardProvider>);
        await r.waitFor("hints=enter details,o open");
        await r.press("o");
        await r.waitFor("hints=esc close");
    });

    it("contains a handler that throws: the error is reported and input keeps working", async () => {
        const errors: unknown[] = [];
        const unsubscribe = onInternalError(error => errors.push(error));
        const log: string[] = [];
        function Thrower() {
            useKeys(input => {
                if (input === "x")
                    throw new Error("boom");
                return false;
            });
            return null;
        }
        try {
            const r = renderInk(
                <KeyboardProvider>
                    <Thrower />
                    <Recorder name="global" log={log} layer={Layer.global} />
                    <Text>ready</Text>
                </KeyboardProvider>);
            await r.waitFor("ready");
            await r.press("x", "y");
            expect((errors[0] as Error).message).toBe("boom");
            // The throwing key is treated as consumed; the next key flows normally.
            expect(log).toEqual(["global:y"]);
        } finally {
            unsubscribe();
        }
    });

});

describe("keys that arrive together in one read", () => {
    it("are split back into the keys they were", () => {
        const events = splitInput("ab\r4\t\x01x\x7f", makeKey());
        expect(events.map(e => [e.input, e.key.return, e.key.tab, e.key.ctrl, e.key.backspace, e.run ?? false])).toEqual([
            ["ab", false, false, false, false, true],
            ["", true, false, false, false, false],
            ["4", false, false, false, false, false],
            ["", false, true, false, false, false],
            ["a", false, false, true, false, false],
            ["x", false, false, false, false, false],
            ["", false, false, false, true, false],
        ]);
        // CR LF is one Enter; a lone capital is shifted, as Ink reports it.
        expect(splitInput("x\r\n", makeKey()).filter(e => e.key.return)).toHaveLength(1);
        expect(splitInput("Q", makeKey())[0]!.key.shift).toBe(false); // single chars pass through untouched
        expect(splitInput("aQ\r", makeKey())[0]!.input).toBe("aQ");
        // Events Ink already parsed are left alone.
        expect(splitInput("", makeKey({ upArrow: true }))).toHaveLength(1);
    });

    it("submit a text field when Enter came in the same read as the text", async () => {
        const submitted: string[] = [];
        function Field() {
            const [value, setValue] = useState("");
            return (
                <>
                    <TextInput value={value} onChange={setValue} onSubmit={v => submitted.push(v)} width={20} />
                    <Text>value=[{value}]</Text>
                </>
            );
        }
        const r = renderInk(<KeyboardProvider><Field /></KeyboardProvider>);
        await r.press("s3cr3t\r");
        await r.waitFor("value=[s3cr3t]");
        await r.waitFor(() => submitted.length === 1);
        expect(submitted).toEqual(["s3cr3t"]);
    });

    it("deliver shortcuts typed faster than they were read, one at a time", async () => {
        const log: string[] = [];
        const r = renderInk(
            <KeyboardProvider>
                <Recorder name="page" log={log} consume={false} />
                <Recorder name="global" log={log} layer={Layer.global} consume={false} />
                <Text>ready</Text>
            </KeyboardProvider>);
        await r.waitFor("ready");
        await r.press("4?j");
        // Offered whole first (a field would take it), then split.
        expect(log).toEqual(["page:4?j", "global:4?j", "page:4", "global:4", "page:?", "global:?", "page:j", "global:j"]);
    });

    it("leave a run whole when something takes it", async () => {
        const log: string[] = [];
        const r = renderInk(
            <KeyboardProvider>
                <Recorder name="field" log={log} layer={Layer.input} />
                <Text>ready</Text>
            </KeyboardProvider>);
        await r.waitFor("ready");
        await r.press("hello");
        expect(log).toEqual(["field:hello"]);
    });

    it("offers only Tab and Ctrl+C from the shell while a text field has the keys", () => {
        const keyboard = createKeyboard();
        const make = (id: number, layer: number, hints: [string, string][]) => ({
            id, scope: 0, layer, active: true, trap: false, hints, help: null, handler: { current: () => false },
        });
        keyboard.register(make(1, Layer.global, [["q", "quit"]]));
        keyboard.register(make(2, Layer.page, [["enter", "open"]]));
        expect(keyboard.footerHints().global).toEqual([["q", "quit"]]);
        keyboard.register(make(3, Layer.input, [["esc", "clear"]]));
        expect(keyboard.footerHints()).toEqual({
            local: [["esc", "clear"], ["enter", "open"]],
            global: [["tab", "pages"], ["ctrl+c", "quit"]],
        });
    });

    it("gives the help screen each handler's full key list, without the shell's own", () => {
        const keyboard = createKeyboard();
        const make = (id: number, layer: number, hints: [string, string][], help: [string, string][] | null) => ({
            id, scope: 0, layer, active: true, trap: false, hints, help, handler: { current: () => false },
        });
        keyboard.register(make(1, Layer.global, [["q", "quit"]], null));
        keyboard.register(make(2, Layer.page, [["h", "sys"]], [["h", "show system accounts"], ["S", "reverse"]]));
        keyboard.register(make(3, Layer.page, [["enter", "open"]], null));
        expect(keyboard.footerHints().local).toEqual([["h", "sys"], ["enter", "open"]]);
        expect(keyboard.helpHints()).toEqual([["h", "show system accounts"], ["S", "reverse"], ["enter", "open"]]);
    });

    it("treats a paste as text for a focused field and nothing else", async () => {
        const log: string[] = [];
        const r = renderInk(
            <KeyboardProvider>
                <Recorder name="page" log={log} />
                <Text>ready</Text>
            </KeyboardProvider>);
        await r.waitFor("ready");
        // No field has the keys: "S" and a newline must not act as keys.
        await r.press(keys.paste("S\r"));
        expect(log).toEqual([]);

        const submitted: string[] = [];
        function Field() {
            const [value, setValue] = useState("");
            return <><TextInput value={value} onChange={setValue} onSubmit={v => submitted.push(v)} width={30} /><Text>value=[{value}]</Text></>;
        }
        const f = renderInk(<KeyboardProvider><Field /></KeyboardProvider>);
        await f.press(keys.paste("line one\nline two\n"));
        await f.waitFor("value=[line one line two ]");
        expect(submitted).toEqual([]);
    });
});
