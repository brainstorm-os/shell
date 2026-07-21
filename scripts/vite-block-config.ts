import { resolve } from "node:path";
import type { UserConfig } from "vite";

/**
 * Shared Vite config factory for a first-party app's BP block bundle build
 * (`vite.blocks.config.ts`). Each declared block compiles to a SINGLE
 * self-contained IIFE that runs inside the sandboxed opaque-origin block frame
 * — the host inlines it into the frame's srcdoc (`@brainstorm-os/sdk/block-frame`
 * buildBlockSrcdoc). The frame CSP is `default-src 'none'` (no network), so
 * EVERYTHING is inlined: no externals, no code-split chunks, no asset URLs.
 *
 * Convention: one file per block id at `dist/blocks/<block-name>.js`, where
 * `<block-name>` is the block id's last `/`-segment. The installer reads it by
 * that path and stores it as the block's source.
 */
export function blockBuildConfig(opts: {
	/** The app directory (pass `__dirname` from the app's config). */
	appDir: string;
	/** Block id's last segment, e.g. `embedded-list` — names the entry dir and
	 *  output file (`src/blocks/<blockName>/entry.ts` → `<blockName>.js`). */
	blockName: string;
	/** IIFE global name (irrelevant at runtime — the bundle is an opaque-origin
	 *  frame with no name collisions — but rollup requires one). */
	globalName: string;
}): UserConfig {
	return {
		build: {
			outDir: resolve(opts.appDir, "dist/blocks"),
			// Do NOT wipe dist/ — the app build (vite.config.ts) emits there too
			// and runs first in the chained `build` script.
			emptyOutDir: false,
			// External maps can't be fetched (connect-src 'none'); ship none.
			sourcemap: false,
			minify: true,
			target: "chrome130",
			rollupOptions: {
				input: resolve(opts.appDir, `src/blocks/${opts.blockName}/entry.ts`),
				// No externals — the block runs in a jail with no module loader and
				// no network; rollup inlines the SDK block-runtime + everything else.
				external: [],
				output: {
					format: "iife",
					name: opts.globalName,
					entryFileNames: `${opts.blockName}.js`,
					inlineDynamicImports: true,
				},
			},
		},
	};
}
