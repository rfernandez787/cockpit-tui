#!/usr/bin/env node
/*
 * Bundler.
 *
 * Two settings are non-obvious. The first is `nodePaths: ['vendor']`. The vendored library
 * imports its own modules with bare specifiers (`cockpit/_internal/location`
 * at cockpit.js:16), which no Node resolver will find on its own. Upstream's
 * build.js does exactly this with `nodePaths: ['pkg/lib']`; mirroring it is
 * what lets vendor/ stay byte-identical to upstream.
 *
 * The second is the stub below for Ink's React DevTools bridge. Ink loads
 * it only when DEV=true *and* the optional react-devtools-core package is
 * installed, but esbuild resolves every import at bundle time, and an
 * unresolvable one fails the build. Marking react-devtools-core external
 * instead would hoist a static import of it to the top of the bundle and
 * crash at startup wherever it is absent, so the whole module is stubbed.
 *
 *   node build.js                 bundle to dist/cli.js
 *   node build.js --outfile F     bundle to F instead
 *   node build.js --watch         rebuild on change
 *   node build.js --run [args]    bundle, then run it with the remaining args
 */
import * as esbuild from "esbuild";
import { chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
const outfileIndex = argv.indexOf("--outfile");
const outfile = outfileIndex >= 0 && argv[outfileIndex + 1]
    ? resolve(argv[outfileIndex + 1])
    : `${root}dist/cli.js`;

/** Replace ink/build/devtools.js with an empty module; see the header. */
const stubInkDevtools = {
    name: "stub-ink-devtools",
    setup(build) {
        build.onResolve({ filter: /^\.\/devtools\.js$/ }, args =>
            /[\\/]ink[\\/]build[\\/]/.test(args.importer)
                ? { path: "ink-devtools", namespace: "stub-ink-devtools" }
                : undefined);
        build.onLoad({ filter: /.*/, namespace: "stub-ink-devtools" }, () =>
            ({ contents: "export {};", loader: "js" }));
    },
};

const options = {
    entryPoints: [`${root}src/cli.ts`],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    nodePaths: [`${root}vendor`],
    plugins: [stubInkDevtools],
    // Ink's own React reconciler instance, which Ink does not export; the
    // keyboard dispatches keys through it (see src/tui/keyboard.tsx). An
    // absolute path, so it is the very module Ink's own imports load.
    alias: {
        "ink-reconciler": `${root}node_modules/ink/build/reconciler.js`,
        "ink-instances": `${root}node_modules/ink/build/instances.js`,
    },
    // React and its reconciler choose their development builds at runtime
    // unless NODE_ENV says otherwise. The development reconciler records a
    // performance.measure() per component render, which Node keeps forever:
    // an idle Overview grew by about 2 MB a minute. Build for production.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    banner: {
        js: [
            "#!/usr/bin/env node",
            // Some dependencies are still CommonJS. Bundling them into an ESM
            // output leaves bare `require` calls with nothing to resolve them.
            "import { createRequire as __createRequire } from 'node:module';",
            "const require = __createRequire(import.meta.url);",
        ].join("\n"),
    },
    logLevel: "info",
};

if (argv.includes("--watch")) {
    const context = await esbuild.context(options);
    await context.watch();
} else {
    await esbuild.build(options);
    await chmod(outfile, 0o755);

    const runIndex = argv.indexOf("--run");
    if (runIndex >= 0) {
        const args = argv.slice(runIndex + 1).filter(arg => arg !== "--");
        const child = spawn(process.execPath, [outfile, ...args], { stdio: "inherit" });
        child.on("exit", (code, signal) => {
            process.exit(signal ? 1 : code ?? 0);
        });
    }
}
