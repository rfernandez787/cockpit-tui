/*
 * http-stream2 on scripted routes, as cockpit-bridge 356 relays HTTP over a
 * unix socket (channels/http_channel.py), confirmed against frames captured
 * from it talking to podman's REST service:
 *
 *  - the open carries the whole request line: "unix" (or "port"), "method",
 *    "path" (query string included) and "headers". The body follows as data
 *    frames, ended by the client's "done"; nothing is sent to the server
 *    before that "done".
 *  - the answer is: ready, {"command": "response", "status", "reason",
 *    "headers"}, the body as data frames, done, close. An HTTP error status
 *    is not a channel problem: the close is clean, and the error body (which
 *    for podman is JSON with "cause" and "message") arrives as data.
 *  - a response that never ends (podman's events, stats with stream=true)
 *    is data frames for as long as the channel is open; the client closes.
 *  - a socket nobody listens on closes the channel "not-found" before ready.
 *
 * The scenario, per unix socket path (or port number), by "METHOD path":
 *
 *   "http": {
 *     "/run/user/1000/podman/podman.sock": {
 *       "GET /v3.4.0/libpod/info": { "body": { "version": { "Version": "5.8.2" } } },
 *       "GET /v3.4.0/libpod/containers/json?all=true": { "body": [ ... ] },
 *       "POST /v3.4.0/libpod/containers/abc/stop": {
 *         "status": 204,
 *         "effects": [ { "http": { "<socket>": { "GET ...": { "body": [...] } } } },
 *                      { "httpData": ["<socket>", "GET /v3.4.0/libpod/events", "{...}\n"] } ] },
 *       "GET /v3.4.0/libpod/events": { "keepOpen": true, "chunks": [ { "data": "{...}\n", "delayMs": 50 } ] },
 *       "DELETE /v3.4.0/libpod/images/x?force=false": { "status": 409, "body": { "cause": "...", "message": "..." } }
 *     }
 *   }
 *
 *   A route gives "status" (200), "reason", "headers", and a "body" (a string
 *   sent as is, or any other JSON value sent as JSON with a trailing newline
 *   and Content-Type application/json), or "chunks" ([{"data", "delayMs"}]);
 *   "delayMs" before the response; "keepOpen" for a stream that only the
 *   client ends; "problem" to fail the channel instead; "effects" applied
 *   once the response is out. A request with no route for its exact path is
 *   tried without its query string, and is otherwise a 404 the way podman
 *   words one. Request bodies are in the log (COCKPIT_MOCK_LOG).
 *
 * Effects (also usable from D-Bus methods and spawn results):
 *
 *   { "http": { "<socket>": { "METHOD path": route | null } } }   routes change (null removes one)
 *   { "httpData": ["<socket>", "METHOD path", "text"] }             written to every open keepOpen stream of that route
 */
import {
    scenario, control, sendControl, finish, schedule, writeFrame, applyEffects, effectKinds, isPlainObject, guarded,
} from "./core.mjs";

const REASONS = {
    200: "OK", 201: "Created", 204: "No Content", 304: "Not Modified", 400: "Bad Request", 404: "Not Found",
    409: "Conflict", 500: "Internal Server Error",
};

/** Routes by endpoint, changed at run time by "http" effects. */
const routes = new Map();
for (const [endpoint, table] of Object.entries(scenario.http ?? {}))
    routes.set(endpoint, new Map(Object.entries(table ?? {})));

/** Open keepOpen streams, by "endpoint\nroute". */
const streams = new Map();

function endpointOf(options) {
    return typeof options.unix === "string" ? options.unix : options.port !== undefined ? String(options.port) : "";
}

function lookup(endpoint, method, path) {
    const table = routes.get(endpoint);
    if (!table)
        return undefined;
    const exact = `${method} ${path}`;
    if (table.has(exact))
        return { key: exact, route: table.get(exact) };
    const bare = `${method} ${path.split("?")[0]}`;
    if (table.has(bare))
        return { key: bare, route: table.get(bare) };
    return null;
}

function respond(state, key, route) {
    const json = route.body !== undefined && typeof route.body !== "string";
    const status = route.status ?? 200;
    control.ready(state.id);
    sendControl({
        command: "response", channel: state.id, status, reason: route.reason ?? REASONS[status] ?? "",
        headers: { ...(json ? { "Content-Type": "application/json" } : {}), Server: "Libpod/5.8.2 (linux)", ...(route.headers ?? {}) },
    });
    if (route.body !== undefined)
        writeFrame(state.id, Buffer.from(json ? `${JSON.stringify(route.body)}\n` : route.body, "utf8"));

    const end = () => {
        if (route.keepOpen) {
            const id = `${state.endpoint}\n${key}`;
            if (!streams.has(id))
                streams.set(id, new Set());
            streams.get(id).add(state);
            state.stream = id;
        } else {
            control.done(state.id);
            finish(state, {});
        }
        applyEffects(route.effects, {});
    };
    const chunks = [...(route.chunks ?? [])];
    const next = () => {
        const chunk = chunks.shift();
        if (!chunk)
            return end();
        schedule(state, chunk.delayMs ?? 0, () => {
            writeFrame(state.id, Buffer.from(chunk.data ?? "", "utf8"));
            next();
        });
    };
    next();
}

export const httpStream2 = {
    open(state) {
        const options = state.options;
        state.endpoint = endpointOf(options);
        state.requested = false;
    },
    // The request body: in the log; nothing here acts on it.
    data() {},
    done(state) {
        if (state.requested)
            return;
        state.requested = true;
        const options = state.options;
        const method = typeof options.method === "string" ? options.method : "GET";
        const path = typeof options.path === "string" ? options.path : "/";
        const found = lookup(state.endpoint, method, path);
        if (found === undefined) {
            // Nothing listens there: the connection is refused before any response.
            finish(state, { problem: "not-found", message: `[Errno 2] No such file or directory: ${state.endpoint}` });
            return;
        }
        if (found === null) {
            respond(state, "", {
                status: 404,
                body: { cause: "not found", message: `no route for ${method} ${path} in the scenario`, response: 404 },
            });
            return;
        }
        const { key, route } = found;
        if (route.problem) {
            finish(state, { problem: route.problem, ...(route.message ? { message: route.message } : {}) });
            return;
        }
        schedule(state, route.delayMs ?? 0, () => respond(state, key, route));
    },
    clientClose(state) {
        if (state.stream)
            streams.get(state.stream)?.delete(state);
        finish(state, {});
    },
};

effectKinds.http = effect => {
    for (const [endpoint, table] of Object.entries(effect.http ?? {})) {
        if (!routes.has(endpoint))
            routes.set(endpoint, new Map());
        if (!isPlainObject(table))
            continue;
        for (const [key, route] of Object.entries(table)) {
            if (route === null)
                routes.get(endpoint).delete(key);
            else
                routes.get(endpoint).set(key, route);
        }
    }
};

effectKinds.httpData = effect => {
    const [endpoint, key, text] = effect.httpData ?? [];
    for (const state of [...(streams.get(`${endpoint}\n${key}`) ?? [])])
        guarded(state, () => writeFrame(state.id, Buffer.from(String(text ?? ""), "utf8")));
};
