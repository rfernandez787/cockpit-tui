/*
 * A live session against the mock bridge, for tests that render the app.
 */
import { fileURLToPath } from "node:url";
import { StreamTransport } from "../../src/transport/stream.js";
import { initInfo, type Session } from "../../src/session.js";

const MOCK = fileURLToPath(new URL("../mock-bridge/bridge.mjs", import.meta.url));

export interface MockSession extends Session {
    close(): void;
}

export async function mockSession(scenario: object = {}): Promise<MockSession> {
    const transport = new StreamTransport(["node", MOCK], {
        env: { COCKPIT_MOCK_SCENARIO: JSON.stringify(scenario) },
        onStderr: () => {},
    });
    transport.install();
    await transport.connect();
    await initInfo();
    return { mode: "local", target: "localhost", transport, close: () => transport.close() };
}
