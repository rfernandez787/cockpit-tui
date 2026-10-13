/*
 * The page harness itself: providers, params, navigation and status capture.
 */
import { it, expect, afterEach } from "vitest";
import { Text } from "ink";
import { useEffect } from "react";
import { usePrivilege } from "../../src/tui/privilege.js";
import { useStatus } from "../../src/tui/status.js";
import { useNavigation, usePageParams } from "../../src/tui/navigation.js";
import type { PageProps } from "../../src/tui/page.js";
import { renderPage } from "../helpers/page.js";
import { cleanup } from "../helpers/ink.js";

afterEach(cleanup);

function Probe({ width, height }: PageProps) {
    const privilege = usePrivilege();
    const params = usePageParams<{ unit: string }>("probe");
    const { notify } = useStatus();
    const navigation = useNavigation();
    useEffect(() => {
        notify("hello from the page", "success");
        navigation.go("logs", { unit: "sshd.service" });
    }, []);
    return <Text>size={width}x{height} allowed={String(privilege.allowed)} unit={params?.unit ?? "none"}</Text>;
}

it("renders a page with providers, params, status and navigation", async () => {
    const r = renderPage(Probe, { columns: 80, rows: 20, allowed: true, params: { pageId: "probe", value: { unit: "a.service" } } });
    const frame = await r.waitFor("status: success: hello from the page");
    expect(frame).toContain("size=80x19 allowed=true unit=a.service");
    expect(r.navigations).toEqual([["logs", { unit: "sshd.service" }]]);
});
