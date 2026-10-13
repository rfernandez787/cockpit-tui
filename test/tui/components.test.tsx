import { describe, it, expect, afterEach } from "vitest";
import { useState } from "react";
import { Box, Text } from "ink";
import { KeyboardProvider } from "../../src/tui/keyboard.js";
import { Table, useListNav, layoutColumns, type Column } from "../../src/tui/components/Table.js";
import { TextInput } from "../../src/tui/components/TextInput.js";
import { AreaProvider, ConfirmDialog } from "../../src/tui/components/Dialog.js";
import { meterBar } from "../../src/tui/components/Meter.js";
import { glyphs } from "../../src/tui/theme.js";
import { width as textWidth } from "../../src/tui/text.js";
import { renderInk, cleanup, keys } from "../helpers/ink.js";

afterEach(cleanup);

interface Row { name: string, state: string }

const columns: Column<Row>[] = [
    { id: "name", title: "Name", value: r => r.name },
    { id: "state", title: "State", width: 8, value: r => r.state },
];

function TableHarness({ rows, height = 5 }: { rows: Row[], height?: number }) {
    const nav = useListNav(rows.map(r => r.name), height - 1);
    return (
        <Box flexDirection="column">
            <Table rows={rows} columns={columns} nav={nav} width={30} height={height} empty="nothing here" />
            <Text>selected={nav.key ?? "none"}</Text>
        </Box>
    );
}

const many = Array.from({ length: 20 }, (_, i) => ({ name: `unit-${String(i).padStart(2, "0")}`, state: i % 3 ? "active" : "failed" }));

describe("Table", () => {
    it("renders a header and the first rows, marking the selection", async () => {
        const r = renderInk(<KeyboardProvider><TableHarness rows={many} /></KeyboardProvider>);
        const frame = await r.waitFor("selected=unit-00");
        const lines = frame.split("\n");
        expect(lines[0]).toContain("Name");
        // At 30 columns the position indicator has no free space and is
        // left out rather than written over a column title.
        expect(lines[0]).toContain("State");
        expect(lines[0]).not.toContain("1/20");
        expect(lines[1]).toContain(`${glyphs.pointer} unit-00`);
        expect(lines[1]).toContain("failed");
        expect(lines).toHaveLength(6);
        for (const line of lines.slice(0, 5))
            expect(textWidth(line)).toBeLessThanOrEqual(30);
    });

    it("applies every arrow key in a burst", async () => {
        const r = renderInk(<KeyboardProvider><TableHarness rows={many} /></KeyboardProvider>);
        await r.waitFor("selected=unit-00");
        await r.press(keys.down + keys.down + keys.down);
        await r.waitFor("selected=unit-03");
    });

    it("shows the position in the header when there is room for it", async () => {
        function Wide() {
            const nav = useListNav(many.map(r => r.name), 4);
            return <Table rows={many} columns={[columns[0]!]} nav={nav} width={30} height={5} />;
        }
        const r = renderInk(<KeyboardProvider><Wide /></KeyboardProvider>);
        const frame = await r.waitFor("1/20");
        expect(frame.split("\n")[0]).toMatch(/^ {2}Name +1\/20$/);
        await r.press(keys.end);
        await r.waitFor("20/20");
    });

    it("moves and scrolls with the arrow and page keys", async () => {
        const r = renderInk(<KeyboardProvider><TableHarness rows={many} /></KeyboardProvider>);
        await r.waitFor("selected=unit-00");
        await r.press(keys.down, keys.down);
        await r.waitFor("selected=unit-02");
        await r.press(keys.down, keys.down, keys.down);
        const frame = await r.waitFor("selected=unit-05");
        // Four visible rows: the view scrolled to keep the selection in sight.
        expect(frame).toContain(`${glyphs.pointer} unit-05`);
        expect(frame).not.toContain("unit-01");
        await r.press(keys.end);
        await r.waitFor("selected=unit-19");
        await r.press(keys.home);
        await r.waitFor("selected=unit-00");
        await r.press(keys.pageDown);
        await r.waitFor("selected=unit-03");
        await r.press(keys.up);
        await r.waitFor("selected=unit-02");
    });

    it("keeps the selection on the same row when rows are inserted above it", async () => {
        const r = renderInk(<KeyboardProvider><TableHarness rows={many} /></KeyboardProvider>);
        await r.waitFor("selected=unit-00");
        await r.press(keys.down, keys.down);
        await r.waitFor("selected=unit-02");
        r.rerender(<KeyboardProvider><TableHarness rows={[{ name: "aaa", state: "new" }, ...many]} /></KeyboardProvider>);
        await r.waitFor(frame => frame.includes("selected=unit-02") && frame.includes(`${glyphs.pointer} unit-02`));
    });

    it("falls back to the nearest row when the selected one disappears", async () => {
        const r = renderInk(<KeyboardProvider><TableHarness rows={many} /></KeyboardProvider>);
        await r.waitFor("selected=unit-00");
        await r.press(keys.end);
        await r.waitFor("selected=unit-19");
        r.rerender(<KeyboardProvider><TableHarness rows={many.slice(0, 10)} /></KeyboardProvider>);
        await r.waitFor("selected=unit-09");
    });

    it("draws nothing at all when given no height", async () => {
        function Zero() {
            const nav = useListNav(many.map(r => r.name), 1);
            return (
                <Box flexDirection="column">
                    <Text>above</Text>
                    <Table rows={many} columns={columns} nav={nav} width={30} height={0} />
                    <Text>below</Text>
                </Box>
            );
        }
        const r = renderInk(<KeyboardProvider><Zero /></KeyboardProvider>);
        const frame = await r.waitFor("below");
        expect(frame).not.toContain("Name");
    });

    it("wraps a long empty message, keeping the rows' indent", async () => {
        function Empty() {
            const nav = useListNav([], 4);
            return <Table rows={[]} columns={columns} nav={nav} width={24} height={5}
                          empty="No units match the filter that is currently applied" />;
        }
        const r = renderInk(<KeyboardProvider><Empty /></KeyboardProvider>);
        const frame = await r.waitFor("No units");
        for (const line of frame.split("\n").slice(1).filter(l => l.trim()))
            expect(line.startsWith("  ")).toBe(true);
    });

    it("shows the empty text when there are no rows", async () => {
        const r = renderInk(<KeyboardProvider><TableHarness rows={[]} /></KeyboardProvider>);
        const frame = await r.waitFor("nothing here");
        expect(frame).toContain("selected=none");
    });

    it("lays out columns: fixed widths kept, flexible ones share the rest exactly", () => {
        const cols: Column<Row>[] = [
            { id: "a", title: "A", value: () => "", grow: 2 },
            { id: "b", title: "B", value: () => "", width: 10 },
            { id: "c", title: "C", value: () => "", grow: 1 },
        ];
        const widths = layoutColumns(cols, 50);
        expect(widths[1]).toBe(10);
        expect(widths.reduce((a, b) => a + b, 0) + 2).toBe(50);
        expect(widths[0]!).toBeGreaterThan(widths[2]!);
    });

    it("drops expendable columns first when space runs out", () => {
        const cols: Column<Row>[] = [
            { id: "name", title: "Name", value: () => "", minWidth: 10 },
            { id: "desc", title: "Description", value: () => "", minWidth: 20, dropPriority: 1 },
            { id: "state", title: "State", value: () => "", width: 8 },
        ];
        const widths = layoutColumns(cols, 25);
        expect(widths[1]).toBe(0);
        expect(widths[2]).toBe(8);
        expect(widths[0]).toBe(25 - 8 - 1);
    });
});

function InputHarness({ mask, onSubmit }: { mask?: string, onSubmit?: (v: string) => void }) {
    const [value, setValue] = useState("");
    return (
        <Box flexDirection="column">
            <TextInput value={value} onChange={setValue} onSubmit={onSubmit} width={20}
                       {...(mask !== undefined ? { mask } : {})} />
            <Text>value=[{value}]</Text>
        </Box>
    );
}

describe("TextInput", () => {
    it("edits like readline", async () => {
        const r = renderInk(<KeyboardProvider><InputHarness /></KeyboardProvider>);
        await r.press("hello");
        await r.waitFor("value=[hello]");
        await r.press(keys.left, keys.left, "X");
        await r.waitFor("value=[helXlo]");
        await r.press(keys.backspace);
        await r.waitFor("value=[hello]");
        await r.press(keys.home, keys.delete);
        await r.waitFor("value=[ello]");
        await r.press(keys.end, " world");
        await r.waitFor("value=[ello world]");
        await r.press(keys.ctrl("w"));
        await r.waitFor("value=[ello ]");
        await r.press(keys.ctrl("u"));
        await r.waitFor("value=[]");
    });

    it("submits on Enter", async () => {
        const submitted: string[] = [];
        const r = renderInk(<KeyboardProvider><InputHarness onSubmit={v => submitted.push(v)} /></KeyboardProvider>);
        await r.press("abc", keys.enter);
        await r.waitFor("value=[abc]");
        expect(submitted).toEqual(["abc"]);
    });

    it("masks a secret, and an empty mask shows nothing at all", async () => {
        const r = renderInk(<KeyboardProvider><InputHarness mask="*" /></KeyboardProvider>);
        await r.press("s3cr3t");
        const frame = await r.waitFor("value=[s3cr3t]");
        expect(frame.split("\n")[0]).toContain("******");
        expect(frame.split("\n")[0]).not.toContain("s3cr3t");

        const hidden = renderInk(<KeyboardProvider><InputHarness mask="" /></KeyboardProvider>);
        await hidden.press("s3cr3t");
        const hiddenFrame = await hidden.waitFor("value=[s3cr3t]");
        expect(hiddenFrame.split("\n")[0]!.trim()).toBe("");
    });

    it("keeps every keystroke when several arrive in one read", async () => {
        const r = renderInk(<KeyboardProvider><InputHarness /></KeyboardProvider>);
        // One chunk, three events: "a", a cursor key, "b". Each handler must
        // see the state the previous one left, not the last render's.
        await r.press("a" + keys.left + "b");
        await r.waitFor("value=[ba]");
    });

    it("enforces maxLength on growth only, keeping what fits of a paste", async () => {
        function Limited({ initial }: { initial: string }) {
            const [value, setValue] = useState(initial);
            return (
                <Box flexDirection="column">
                    <TextInput value={value} onChange={setValue} width={20} maxLength={5} />
                    <Text>value=[{value}]</Text>
                </Box>
            );
        }
        const r = renderInk(<KeyboardProvider><Limited initial="" /></KeyboardProvider>);
        await r.press("abcdefgh");
        await r.waitFor("value=[abcde]");
        await r.press("x");
        await r.waitFor("value=[abcde]");
        // A value that is already too long (set by the caller) can be shortened.
        const long = renderInk(<KeyboardProvider><Limited initial="abcdefg" /></KeyboardProvider>);
        await long.press(keys.backspace);
        await long.waitFor("value=[abcdef]");
    });

    it("never inserts control characters", async () => {
        const r = renderInk(<KeyboardProvider><InputHarness /></KeyboardProvider>);
        await r.press("x\ty\x07z");
        const frame = await r.waitFor(f => f.includes("value=[x"));
        expect(frame).not.toMatch(/[\x00-\x08\x0b-\x1f]/);
    });
});

describe("ConfirmDialog", () => {
    function Harness({ log }: { log: string[] }) {
        return (
            <AreaProvider area={{ width: 60, height: 14 }}>
                <Box width={60} height={14} flexDirection="column">
                    <Text>{"background ".repeat(20)}</Text>
                    <ConfirmDialog title="Stop sshd.service?" message="Remote logins will stop working."
                                   confirmLabel="Stop" danger
                                   onConfirm={() => log.push("confirm")} onCancel={() => log.push("cancel")} />
                </Box>
            </AreaProvider>
        );
    }

    it("renders over its area and answers Enter and Esc", async () => {
        const log: string[] = [];
        const r = renderInk(<KeyboardProvider><Harness log={log} /></KeyboardProvider>, { columns: 60, rows: 14 });
        const frame = await r.waitFor("Stop sshd.service?");
        expect(frame).toContain("Remote logins will stop working.");
        expect(frame).toContain("< Stop >");
        await r.press(keys.enter);
        expect(log).toEqual(["confirm"]);
        await r.press(keys.escape);
        expect(log).toEqual(["confirm", "cancel"]);
    });
});

describe("meterBar", () => {
    it("never shows full for <100% or empty for >0%", () => {
        expect(meterBar(0, 12)).toEqual({ filled: 0, empty: 10 });
        expect(meterBar(1, 12)).toEqual({ filled: 10, empty: 0 });
        expect(meterBar(0.001, 12).filled).toBe(1);
        expect(meterBar(0.999, 12).filled).toBe(9);
        expect(meterBar(0.5, 12)).toEqual({ filled: 5, empty: 5 });
        expect(meterBar(null, 12)).toEqual({ filled: 0, empty: 10 });
        expect(meterBar(7, 12)).toEqual({ filled: 10, empty: 0 });
    });
});

describe("FormDialog", () => {
    async function load() {
        return await import("../../src/tui/components/Form.js");
    }

    it("moves between fields, edits each kind, and submits from anywhere", async () => {
        const { FormDialog } = await load();
        const submitted: Record<string, unknown>[] = [];
        function Harness() {
            const [v, setV] = useState({ name: "", secret: "", admin: false, shell: "/bin/bash" });
            return (
                <AreaProvider area={{ width: 70, height: 20 }}>
                    <Box width={70} height={20}>
                        <FormDialog
                            title="Create account"
                            submitLabel="Create"
                            fields={[
                                { kind: "text", id: "name", label: "User name", value: v.name },
                                { kind: "password", id: "secret", label: "Password", value: v.secret },
                                { kind: "checkbox", id: "admin", label: "Administrator", value: v.admin },
                                { kind: "select", id: "shell", label: "Shell", value: v.shell,
                                  options: [{ value: "/bin/bash", label: "bash" }, { value: "/bin/zsh", label: "zsh" }] },
                            ]}
                            onChange={(id, value) => setV(prev => ({ ...prev, [id]: value }))}
                            onSubmit={() => submitted.push(v)}
                            onCancel={() => {}}
                        />
                    </Box>
                </AreaProvider>
            );
        }
        const r = renderInk(<KeyboardProvider><Harness /></KeyboardProvider>, { columns: 70, rows: 20 });
        await r.waitFor("Create account");
        await r.press("alice", keys.tab, "hunter2", keys.down, " ", keys.down, keys.right);
        await r.waitFor("[x]");
        await r.waitFor("zsh");
        expect(r.lastFrame()).not.toContain("hunter2");
        await r.press(keys.up, keys.up, keys.up, keys.enter);
        expect(submitted).toEqual([{ name: "alice", secret: "hunter2", admin: true, shell: "/bin/zsh" }]);
    });

    it("shows field errors and the busy state, and ignores keys while busy", async () => {
        const { FormDialog } = await load();
        const log: string[] = [];
        const r = renderInk(
            <KeyboardProvider>
                <AreaProvider area={{ width: 70, height: 20 }}>
                    <Box width={70} height={20}>
                        <FormDialog title="Set host name" busy busyText="Saving"
                                    fields={[{ kind: "text", id: "h", label: "Name", value: "x", error: "Too short" }]}
                                    onChange={() => log.push("change")} onSubmit={() => log.push("submit")}
                                    onCancel={() => log.push("cancel")} />
                    </Box>
                </AreaProvider>
            </KeyboardProvider>, { columns: 70, rows: 20 });
        await r.waitFor("Too short");
        await r.waitFor("Saving");
        await r.press("abc", keys.enter, keys.escape);
        expect(log).toEqual([]);
    });
});
