import { describe, it, expect } from "vitest";
import { parseCli, splitUserHost, usage, UsageError } from "../src/args.js";
import { parseOsRelease } from "../src/session.js";

describe("command line", () => {
    it("defaults to the TUI on the local bridge", () => {
        expect(parseCli([])).toEqual({ command: "tui", help: false, version: false, insecure: false, admin: false });
    });

    it("recognises the probe subcommand and its flags", () => {
        const args = parseCli(["probe", "--host", "admin@server", "--admin"]);
        expect(args).toMatchObject({ command: "probe", host: "admin@server", admin: true });
    });

    it("accepts the ws flags together", () => {
        expect(parseCli(["--ws", "https://box:9090", "--user", "admin", "--insecure"]))
            .toMatchObject({ ws: "https://box:9090", user: "admin", insecure: true });
    });

    it("takes --page for the TUI", () => {
        expect(parseCli(["--page", "services"]).page).toBe("services");
    });

    it("takes --theme for the TUI, and says in the usage which there are", () => {
        expect(parseCli(["--theme", "light"]).theme).toBe("light");
        expect(parseCli([]).theme).toBeUndefined();
        expect(() => parseCli(["probe", "--theme", "light"])).toThrow(/--theme applies only to the TUI/);
        expect(() => parseCli(["--theme", ""])).toThrow(/--theme needs a value/);
        expect(usage(["overview"], ["dark", "newt"])).toMatch(/--theme NAME\s+TUI: the colour scheme for this run \(dark, newt\)/);
    });

    it.each([
        [["--hots", "x"], /Unknown option '--hots'/],
        [["frobnicate"], /unknown command 'frobnicate'/],
        [["probe", "extra"], /unexpected argument 'extra'/],
        [["--host", "a", "--ws", "b"], /mutually exclusive/],
        [["--bridge", "/x", "--host", "a"], /local bridge/],
        [["--insecure"], /only to --ws/],
        [["--user", "bob"], /only to --ws or --host/],
        [["--host", "a@b", "--user", "c"], /not both/],
        [["probe", "--page", "logs"], /only to the TUI/],
        [["--host", ""], /needs a value/],
    ])("rejects %j", (argv, message) => {
        expect(() => parseCli(argv)).toThrow(UsageError);
        expect(() => parseCli(argv)).toThrow(message);
    });

    it("splits user@host the way ssh does, at the last @", () => {
        expect(splitUserHost("box")).toEqual({ host: "box" });
        expect(splitUserHost("admin@box")).toEqual({ user: "admin", host: "box" });
        expect(splitUserHost("a@corp@box")).toEqual({ user: "a@corp", host: "box" });
    });
});

describe("os-release parsing", () => {
    it("handles quoting and escapes the way os-release(5) specifies", () => {
        const parsed = parseOsRelease([
            "# comment",
            'NAME="Red Hat Enterprise Linux"',
            "ID=rhel",
            "VERSION_ID='9.8'",
            'PRETTY_NAME="Say \\"hi\\" \\$HOME"',
            "",
            "BROKEN LINE",
        ].join("\n"));
        expect(parsed).toEqual({
            NAME: "Red Hat Enterprise Linux",
            ID: "rhel",
            VERSION_ID: "9.8",
            PRETTY_NAME: 'Say "hi" $HOME',
        });
    });
});
