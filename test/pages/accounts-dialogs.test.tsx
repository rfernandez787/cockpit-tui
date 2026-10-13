/*
 * The Accounts page's dialogs on their own, driven through the keyboard API
 * directly: keys dispatched back to back, before React has rendered what the
 * previous one changed -- what a real terminal does with a burst of keys
 * (tmux send-keys, a fast typist, key repeat), which the stream-driven page
 * harness does not reproduce.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Box } from "ink";
import type { ReactElement } from "react";
import { AreaProvider } from "../../src/tui/components/Dialog.js";
import { createKeyboard, KeyboardProvider, makeKey, type KeyboardApi } from "../../src/tui/keyboard.js";
import { CreateGroupDialog, GroupsDialog } from "../../src/pages/accounts/dialogs.js";
import { DEFAULT_LOGIN_DEFS, type Account, type GroupEntry } from "../../src/pages/accounts/model.js";
import { cleanup, renderInk } from "../helpers/ink.js";

afterEach(() => cleanup());

const ALICE: Account = {
    name: "alice", password: "x", uid: 1001, gid: 1001, gecos: "Alice", home: "/home/alice", shell: "/bin/bash",
    fullName: "Alice", primaryGroup: "alice", groups: [], adminGroups: [], system: false,
};

const GROUPS: GroupEntry[] = ["alice", "bob", "cexample", "docker", "libvirt", "wheel"]
    .map((name, i) => ({ name, gid: 1000 + i, members: [] }));

function inArea(api: KeyboardApi, node: ReactElement) {
    return renderInk(
        <AreaProvider area={{ width: 80, height: 22 }}>
            <KeyboardProvider keyboard={api}>
                <Box width={80} height={22} flexDirection="column">{node}</Box>
            </KeyboardProvider>
        </AreaProvider>,
        { columns: 80, rows: 22 });
}

function renderGroups(api: KeyboardApi, closed: string[]) {
    return inArea(api, <GroupsDialog account={ALICE} groups={GROUPS} loggedIn={false}
                                     onCancel={() => closed.push("cancel")} onDone={summary => closed.push(summary)} />);
}

const down = () => makeKey({ downArrow: true });

describe("groups editor with keys in a burst", () => {
    it("marks the row the cursor ended on", async () => {
        const api = createKeyboard();
        const r = renderGroups(api, []);
        await r.waitFor("Groups of alice");
        // No render between them: each key must see what the one before it did.
        api.dispatch("", down());
        api.dispatch("", down());
        api.dispatch(" ", makeKey());
        const frame = await r.waitFor(/will add/);
        const marked = frame.split("\n").find(line => line.includes("will add")) ?? "";
        expect(marked).toMatch(/›.*\[x\] cexample/);
        expect(frame).not.toMatch(/\[x\] bob/);
    });

    it("cancels on the second Esc of a burst, after the first cleared the filter", async () => {
        const api = createKeyboard();
        const closed: string[] = [];
        const r = renderGroups(api, closed);
        await r.waitFor("Groups of alice");
        api.dispatch("d", makeKey());
        api.dispatch("o", makeKey());
        await r.waitFor("Filter: do");
        api.dispatch("", makeKey({ escape: true }));
        api.dispatch("", makeKey({ escape: true }));
        await r.waitFor(() => closed.length > 0);
        expect(closed).toEqual(["cancel"]);
    });

    it("only asks on a second Enter that came in the same burst as the first", async () => {
        const api = createKeyboard();
        const closed: string[] = [];
        const r = renderGroups(api, closed);
        await r.waitFor("Groups of alice");
        // As typed ahead: the space marks a group (bob), and neither Enter has seen a question.
        api.dispatch("", down());
        api.dispatch(" ", makeKey());
        api.dispatch("", makeKey({ return: true }));
        api.dispatch("", makeKey({ return: true }));
        const frame = await r.waitFor("Press Enter again to apply");
        expect(frame).not.toMatch(/Adding to|Removing from/);
        expect(closed).toEqual([]);
    });
});

describe("create group with keys in a burst", () => {
    it("does not create on two Enters that arrive before the question is shown", async () => {
        const api = createKeyboard();
        const created: string[] = [];
        const r = inArea(api, <CreateGroupDialog groups={GROUPS} loginDefs={DEFAULT_LOGIN_DEFS}
                                                 onCreated={name => created.push(name)} onCancel={() => created.push("cancel")} />);
        await r.waitFor("Create new group");
        for (const letter of "devs") {
            api.dispatch(letter, makeKey());
            await r.waitFor(f => /Name\s+\S/.test(f) && f.includes(`Name     ${"devs".slice(0, "devs".indexOf(letter) + 1)}`));
        }
        api.dispatch("", makeKey({ return: true }));
        api.dispatch("", makeKey({ return: true }));
        const frame = await r.waitFor("Press Enter again to create devs");
        expect(frame).not.toContain("Creating the group");
        expect(created).toEqual([]);
    });
});
