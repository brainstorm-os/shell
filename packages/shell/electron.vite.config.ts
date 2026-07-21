import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Dev keeps bundles unminified for readable main/renderer stacks in the error
// log; production minifies (sourcemaps stay on, so stacks still resolve to
// original frames). `size-limit` measures the production artifact, so the
// budgets in are scored against minified output.
export default defineConfig(({ command }) => {
	const minify = command === "build";
	return {
		main: {
			plugins: [
				externalizeDepsPlugin({
					// Workspace packages must be BUNDLED, not externalized, because
					// the built `out/main/` directory has no node_modules of its own
					// at runtime (Electron resolves only the shell's package.json
					// deps, which point at workspace:* — that resolver doesn't run
					// inside the production main process).
					exclude: [
						"@brainstorm-os/block-protocol",
						"@brainstorm-os/sdk",
						"@brainstorm-os/sdk-types",
						"@brainstorm-os/tokens",
						"@brainstorm-os/editor",
					],
				}),
			],
			build: {
				outDir: "out/main",
				minify,
				sourcemap: true,
				rollupOptions: {
					input: {
						index: resolve(__dirname, "src/main/index.ts"),
						"workers/storage": resolve(__dirname, "src/workers/storage/index.ts"),
						"workers/ydoc": resolve(__dirname, "src/workers/ydoc/index.ts"),
						"workers/extraction": resolve(__dirname, "src/workers/extraction/index.ts"),
						"workers/mailbox": resolve(__dirname, "src/workers/mailbox/index.ts"),
					},
					output: {
						entryFileNames: "[name].js",
					},
				},
			},
		},
		preload: {
			// No dependency externalization for the preload. The sandboxed
			// preload runtime cannot resolve `require()`; every dependency the
			// preload (or anything it imports — `@brainstorm-os/sdk`, `ulid`, etc.)
			// must be inlined into the bundle. Electron + node built-ins are
			// already considered external by Vite's preload preset. Since
			// electron-vite 5, omitting `externalizeDepsPlugin` is NOT enough —
			// the plugin is auto-applied unless `externalizeDeps: false` (a bare
			// `require("@brainstorm-os/sdk-types")` in out/preload kills
			// `window.brainstorm` in every sandboxed window).
			build: {
				externalizeDeps: false,
				outDir: "out/preload",
				minify,
				sourcemap: true,
				rollupOptions: {
					input: {
						index: resolve(__dirname, "src/preload/index.ts"),
						"app-preload": resolve(__dirname, "src/preload/app-preload.ts"),
						"chrome-preload": resolve(__dirname, "src/preload/chrome-preload.ts"),
					},
					output: {
						format: "cjs",
						entryFileNames: "[name].js",
					},
				},
			},
			resolve: {
				// The sandboxed preload runs in a Chromium (browser) context, NOT
				// Node — `require("node:crypto")` is unavailable there, and a
				// preload that requires it fails to load entirely, taking down
				// `window.brainstorm` AND the `.app-header` chrome-inset injection
				// for EVERY app (blank "runtime missing" apps, headers jammed under
				// the traffic lights). Force the `browser` export condition so
				// dual-package deps in the preload graph (yjs → lib0's `webcrypto`)
				// resolve to the Web-Crypto implementation (`globalThis.crypto`,
				// available in the preload) instead of the `node:` builtin.
				conditions: ["browser", "module", "import", "default"],
			},
		},
		renderer: {
			root: "src/renderer",
			plugins: [react()],
			server: {
				port: 5173,
				strictPort: true,
			},
			build: {
				outDir: "out/renderer",
				minify,
				sourcemap: true,
				rollupOptions: {
					input: {
						index: resolve(__dirname, "src/renderer/index.html"),
						"chrome/tab-strip": resolve(__dirname, "src/renderer/chrome/tab-strip.html"),
					},
					output: {
						manualChunks(id) {
							if (id.includes("@amplitude") || id.includes("rrweb")) return "analytics";
						},
					},
				},
			},
			resolve: {
				alias: {
					"@renderer": resolve(__dirname, "src/renderer"),
					"@brainstorm-os/tokens": resolve(__dirname, "../tokens/src/index.ts"),
				},
			},
		},
	};
});
