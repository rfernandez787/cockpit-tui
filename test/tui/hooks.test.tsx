/*
 * The data hooks and helpers, against the mock bridge: the behaviours pages
 * rely on and that are easy to get subtly wrong.
 */
import { describe, it, expect, afterEach } from "vitest";
import { useEffect, useState } from "react";
import { Text } from "ink";
import cockpit from "../../src/cockpit.js";
import { run, runFull, useAsync } from "../../src/tui/hooks.js";
import { errorText } from "../../src/tui/status.js";
import { PersistentStateProvider, usePersistentState, usePersistentStore } from "../../src/tui/session-context.js";
import { renderInk, cleanup } from "../helpers/ink.js";
import { mockSession, type MockSession } from "../helpers/session.js";

let session: MockSession | null = null;

afterEach(() => {
    cleanup();
    session?.close();
    session = null;
});

describe("processes", () => {
    it("aborting a running process rejects the caller and raises nothing uncaught", async () => {
        session = await mockSession({ spawnPatterns: [{ match: "^sleep", keepOpen: true }] });
        const uncaught: unknown[] = [];
        const onUncaught = (error: unknown) => uncaught.push(error);
        process.on("uncaughtException", onUncaught);
        try {
            const controller = new AbortController();
            const pending = runFull(["sleep", "100"], {}, controller.signal);
            await new Promise(resolve => setTimeout(resolve, 50));
            controller.abort();
            await expect(pending).rejects.toMatchObject({ problem: "cancelled" });
            await new Promise(resolve => setTimeout(resolve, 50));
            expect(uncaught).toEqual([]);
        } finally {
            process.off("uncaughtException", onUncaught);
        }
    });

    it("keeps a failed command's output as its message when stderr is merged", async () => {
        session = await mockSession({
            spawn: { "useradd bob": { "exit-status": 9, stdout: "useradd: user 'bob' already exists\n" } },
        });
        const error = await run(["useradd", "bob"], { err: "out" }).catch((e: unknown) => e);
        expect(errorText(error)).toBe("useradd: user 'bob' already exists");
    });
});

describe("errorText", () => {
    it("is never empty", () => {
        expect(errorText({ exit_status: 3, message: "" })).toBe("exited with status 3");
        expect(errorText({ exit_status: -15, message: "" })).toBe("killed by signal 15");
        expect(errorText({ problem: "access-denied" })).toBe("access-denied");
        expect(errorText("")).toBe("unknown error");
        expect(errorText({})).toBe("unknown error");
        expect(errorText(new Error("boom"))).toBe("boom");
    });
});

describe("useAsync", () => {
    it("drops the previous value when the question changes, but keeps it across reload()", async () => {
        const resolvers = new Map<string, (value: string) => void>();
        let reload: () => void = () => {};
        function Probe({ id }: { id: string }) {
            const state = useAsync(() => new Promise<string>(resolve => resolvers.set(id, resolve)), [id]);
            reload = state.reload;
            return <Text>value={state.value ?? "none"} loading={String(state.loading)}</Text>;
        }
        const r = renderInk(<Probe id="a" />);
        await r.waitFor(() => resolvers.has("a"));
        resolvers.get("a")!("A");
        await r.waitFor("value=A loading=false");
        r.rerender(<Probe id="b" />);
        // B's answer is not in yet: A's must not be shown as if it were B's.
        await r.waitFor("value=none loading=true");
        resolvers.get("b")!("B");
        await r.waitFor("value=B loading=false");
        resolvers.delete("b");
        reload();
        await r.waitFor("value=B loading=true");
    });
});

describe("usePersistentState", () => {
    it("keeps a value written while the component is unmounting", async () => {
        function Writer() {
            const [, set] = usePersistentState("test:last", "initial");
            // Written from the cleanup that runs as the page goes away. Twice:
            // React computes the first update eagerly; the second is queued on
            // a component that is going away, and is never processed.
            useEffect(() => () => {
                set("first");
                set("written on the way out");
            }, [set]);
            return <Text>writer</Text>;
        }
        let store: Map<string, unknown> | null = null;
        function Reader() {
            store = usePersistentStore();
            return <Text>reader</Text>;
        }
        function Harness() {
            const [show, setShow] = useState(true);
            useEffect(() => {
                const timer = setTimeout(() => setShow(false), 20);
                return () => clearTimeout(timer);
            }, []);
            return show ? <Writer /> : <Reader />;
        }
        const r = renderInk(<PersistentStateProvider><Harness /></PersistentStateProvider>);
        await r.waitFor("reader");
        await r.waitFor(() => store?.get("test:last") === "written on the way out");
    });

    it("composes functional updates made in a row", async () => {
        let bump: () => void = () => {};
        function Counter() {
            const [n, set] = usePersistentState("test:n", 0);
            bump = () => { set(x => x + 1); set(x => x + 1) };
            return <Text>n={n}</Text>;
        }
        const r = renderInk(<PersistentStateProvider><Counter /></PersistentStateProvider>);
        await r.waitFor("n=0");
        bump();
        await r.waitFor("n=2");
    });
});

describe("after the connection is gone", () => {
    it("a new channel fails at once instead of reaching for a WebSocket", async () => {
        session = await mockSession();
        session.transport.close({ problem: "terminated" });
        const constructed: unknown[] = [];
        const real = globalThis.WebSocket;
        // @ts-expect-error -- recording any attempt to build a browser socket
        globalThis.WebSocket = class { constructor(...args: unknown[]) { constructed.push(args) } };
        try {
            const error = await cockpit.spawn(["true"]).catch((e: unknown) => e) as { problem?: string };
            expect(error.problem).toBe("terminated");
            expect(constructed).toEqual([]);
            expect(session.transport.closedProblem).toBe("terminated");
        } finally {
            globalThis.WebSocket = real;
        }
    });
});
