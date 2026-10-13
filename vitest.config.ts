import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const vendor = fileURLToPath(new URL("./vendor", import.meta.url));

export default defineConfig({
    resolve: {
        // Mirrors upstream cockpit's esbuild `nodePaths: ['pkg/lib']`, which is what
        // resolves the bare `cockpit/_internal/location` specifier at cockpit.js:16.
        alias: [
            { find: /^cockpit$/, replacement: `${vendor}/cockpit.js` },
            { find: /^cockpit\/(.*)$/, replacement: `${vendor}/cockpit/$1` },
            // Ink's reconciler instance, as in build.js.
            { find: /^ink-reconciler$/, replacement: fileURLToPath(new URL("./node_modules/ink/build/reconciler.js", import.meta.url)) },
            { find: /^ink-instances$/, replacement: fileURLToPath(new URL("./node_modules/ink/build/instances.js", import.meta.url)) },
        ],
    },
    test: {
        environment: "node",
        // Tests must not pick up the developer's own saved settings (src/config.ts).
        env: { COCKPIT_TUI_CONFIG: "" },
        include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    },
});
