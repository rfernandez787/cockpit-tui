import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { StreamTransport } from "../src/transport/stream.js";
import { Superuser, type SuperuserPrompt } from "../src/superuser.js";

const MOCK = fileURLToPath(new URL("./mock-bridge/bridge.mjs", import.meta.url));

let active: StreamTransport | null = null;

async function connect(scenario: unknown = {}): Promise<void> {
    const transport = new StreamTransport(["node", MOCK], {
        env: { COCKPIT_MOCK_SCENARIO: JSON.stringify(scenario) },
        onStderr: () => {},
    });
    transport.install();
    active = transport;
    await transport.connect();
}

afterEach(() => {
    active?.close();
    active = null;
});

describe("privilege escalation over cockpit.Superuser", () => {
    it("reports the available methods before escalating", async () => {
        await connect({ superuserFlow: { bridges: ["sudo", "pkexec"] } });
        const superuser = await Superuser.open();

        expect(superuser.current).toBe("none");
        expect(superuser.allowed).toBe(false);
        expect(superuser.bridges).toEqual(["sudo", "pkexec"]);
        expect(superuser.methods.sudo).toBe("Password");
    });

    it("escalates when the password is correct", async () => {
        await connect({
            superuserFlow: { prompts: [{ prompt: "Password for alice: " }], password: "s3cr3t" },
        });
        const superuser = await Superuser.open();

        const seen: SuperuserPrompt[] = [];
        await superuser.start(async prompt => {
            seen.push(prompt);
            return "s3cr3t";
        });

        expect(superuser.current).toBe("sudo");
        expect(superuser.allowed).toBe(true);
        expect(seen).toHaveLength(1);
        expect(seen[0]!.prompt).toBe("Password for alice: ");
        // echo:false means the answer is a secret and must be masked.
        expect(seen[0]!.echo).toBe(false);
    });

    it("escalates with no prompt at all when sudo is passwordless", async () => {
        await connect({ superuserFlow: { prompts: [], bridges: ["sudo"] } });
        const superuser = await Superuser.open();

        let asked = false;
        await superuser.start(async () => { asked = true; return "" });

        expect(asked).toBe(false);
        expect(superuser.allowed).toBe(true);
    });

    it("retries and surfaces sudo's error text on a wrong password", async () => {
        await connect({
            superuserFlow: {
                prompts: [{ prompt: "Password for alice: " }, { prompt: "Password for alice: " }],
                password: "s3cr3t",
            },
        });
        const superuser = await Superuser.open();

        const errors: string[] = [];
        let attempt = 0;
        await superuser.start(async prompt => {
            errors.push(prompt.error);
            attempt += 1;
            return attempt === 1 ? "wrong" : "s3cr3t";
        });

        expect(attempt).toBe(2);
        expect(errors[0]).toBe("");                       // first ask: no error yet
        expect(errors[1]).toBe("Sorry, try again.");      // sudo's retry text
        expect(superuser.allowed).toBe(true);
    });

    it("rejects when every attempt fails", async () => {
        await connect({
            superuserFlow: { prompts: [{ prompt: "Password: " }], password: "s3cr3t" },
        });
        const superuser = await Superuser.open();

        await expect(superuser.start(async () => "definitely-wrong"))
            .rejects.toThrow(/Sorry, try again/);
        expect(superuser.allowed).toBe(false);
    });

    it("cancels cleanly when the responder declines", async () => {
        await connect({
            superuserFlow: { prompts: [{ prompt: "Password: " }], password: "s3cr3t" },
        });
        const superuser = await Superuser.open();

        await expect(superuser.start(async () => null)).rejects.toThrow(/cancelled/);
        expect(superuser.current).toBe("none");
    });

    it("drops privileges on stop", async () => {
        await connect({
            superuserFlow: { prompts: [{ prompt: "Password: " }], password: "s3cr3t" },
        });
        const superuser = await Superuser.open();
        await superuser.start(async () => "s3cr3t");
        expect(superuser.allowed).toBe(true);

        await superuser.stop();
        expect(superuser.current).toBe("none");
        expect(superuser.allowed).toBe(false);
    });

    it("notifies listeners when privilege state changes", async () => {
        await connect({
            superuserFlow: { prompts: [{ prompt: "Password: " }], password: "s3cr3t" },
        });
        const superuser = await Superuser.open();

        let changes = 0;
        superuser.onChanged(() => { changes += 1 });
        await superuser.start(async () => "s3cr3t");

        expect(changes).toBeGreaterThan(0);
    });
});

describe("what dropping privileges does to channels", () => {
    it("closes privileged channels with 'terminated' before Stop returns, and leaves the rest", async () => {
        const { default: cockpit } = await import("../src/cockpit.js");
        await connect({ superuserFlow: { prompts: [], bridges: ["sudo"] } });
        const superuser = await Superuser.open();
        await superuser.start(async () => "");
        const privileged = cockpit.channel({ payload: "echo", superuser: "try" });
        const plain = cockpit.channel({ payload: "echo" });
        await Promise.all([privileged.wait(), plain.wait()]);
        const closes: unknown[] = [];
        privileged.addEventListener("close", ((_e: unknown, options: unknown) => closes.push(options)) as never);
        await superuser.stop();
        expect(closes).toEqual([expect.objectContaining({ problem: "terminated" })]);
        expect(plain.valid).toBe(true);
    });
});
