/*
 * The pages, in upstream Cockpit's menu order, then cockpit-tui's own.
 */
import OverviewPage from "../pages/overview/index.js";
import LogsPage from "../pages/logs/index.js";
import StoragePage from "../pages/storage/index.js";
import NetworkingPage from "../pages/networking/index.js";
import PodmanPage from "../pages/podman/index.js";
import AccountsPage from "../pages/accounts/index.js";
import ServicesPage from "../pages/services/index.js";
import TerminalPage from "../pages/terminal/index.js";
import ColoursPage from "../pages/colours/index.js";
import type { PageDefinition } from "./page.js";

export const PAGES: readonly PageDefinition[] = [
    { id: "overview", title: "Overview", component: OverviewPage },
    { id: "logs", title: "Logs", component: LogsPage },
    { id: "storage", title: "Storage", component: StoragePage },
    { id: "networking", title: "Networking", component: NetworkingPage },
    { id: "podman", title: "Containers", component: PodmanPage },
    { id: "accounts", title: "Accounts", component: AccountsPage },
    { id: "services", title: "Services", component: ServicesPage },
    { id: "terminal", title: "Terminal", component: TerminalPage },
    // Not Cockpit's: cockpit-tui's own colours, kept on the viewer's machine.
    { id: "colours", title: "Colours", component: ColoursPage },
];

export function pageIndex(id: string | undefined): number {
    if (!id)
        return 0;
    const index = PAGES.findIndex(page => page.id === id.toLowerCase());
    return index;
}
