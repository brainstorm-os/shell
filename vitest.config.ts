import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Pool-size cap: vitest's default spawns one worker per core (10 on a
// M2 Pro), and each fork imports the heavy module graph (pixi.js +
// Lexical + Yjs + react-dom). On a 16 GB workstation that's too tight
// once a handful of test files are mid-flight, so the default caps
// workers at 4. `BRAINSTORM_VITEST_MAX_WORKERS` lets a fatter CI host
// raise it. Vitest 4 flattened `poolOptions.forks.maxForks` → top-level
// `maxWorkers`.
const MAX_WORKERS_DEFAULT = 4;
const maxWorkersFromEnv = Number.parseInt(process.env.BRAINSTORM_VITEST_MAX_WORKERS ?? "", 10);
const MAX_WORKERS =
	Number.isFinite(maxWorkersFromEnv) && maxWorkersFromEnv > 0
		? maxWorkersFromEnv
		: MAX_WORKERS_DEFAULT;

export default defineConfig({
	// The dev MCP server (`tools/mcp-server`) lives at the harness root post-
	// restructure and is reached via a local `app/tools/mcp-server` symlink. Its
	// jsdom-env tests resolve to that real (out-of-app-root) path, so allow the
	// parent dir to be served by vite's dev-server file pipeline.
	server: { fs: { allow: [".", ".."] } },
	test: {
		include: [
			"packages/*/src/**/*.test.{ts,tsx}",
			// Native NAPI-RS smoke + argon2id contract tests (NAPI-1+). The .node
			// binary is built by the root `pretest` script; without it these
			// fail to import `../index.js` — a real signal, not a skip.
			"packages/native/test/**/*.test.ts",
			// Per-app tests for first-party apps under `apps/`. The implementation
			// plan in docs/apps/42-file-manager-implementation.md (and future
			// per-app plans) places tests under `apps/<name>/tests/`.
			"apps/*/tests/**/*.test.{ts,tsx}",
			"apps/*/src/**/*.test.{ts,tsx}",
			// Dev tooling tests (Stage 0.10+: `tools/mcp-server`).
			"tools/*/tests/**/*.test.{ts,tsx}",
			"tools/*/src/**/*.test.{ts,tsx}",
			// Top-level `tools/check-*.mjs` lint gates (12.15: check-app-i18n).
			"tools/*.test.mjs",
			// Soak harness unit tests (Stage 10.9a). The Playwright spec
			// under `tests/soak/specs/` is excluded by its `.spec.ts`
			// suffix; only `.test.ts` library tests run under vitest.
			"tests/soak/lib/**/*.test.ts",
			// Perf-harness library tests (12.7). Same convention as soak:
			// only `.test.ts` runs under vitest; the Playwright specs in
			// `tests/perf/specs/` are excluded by their `.spec.ts` suffix.
			"tests/perf/lib/**/*.test.ts",
		],
		environment: "node",
		pool: "forks",
		maxWorkers: MAX_WORKERS,
		// The default 5s budget is too tight for the heaviest categories once
		// the whole monorepo runs under the 4-worker cap: the repo-walking
		// structural guards (tools/mcp-server/tests/*-check), per-app boot-smoke
		// dynamic `import()`s (heavy transitive graph), and the Argon2id-backed
		// app-lock/vault tests all brush 5–17s under parallel contention and
		// flake nondeterministically. They pass deterministically with headroom.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov", "html"],
			include: ["packages/*/src/**/*.{ts,tsx}", "tools/*/src/**/*.{ts,tsx}"],
			exclude: [
				"**/*.test.{ts,tsx}",
				"**/*.d.ts",
				"packages/shell/src/main/test-support/**",
				"packages/shell/src/renderer/main.tsx",
				"packages/shell/src/renderer/index.html",
				"packages/*/dist/**",
				"packages/*/out/**",
				"tools/*/dist/**",
				"tools/mcp-server/src/index.ts",
			],
			thresholds: {
				lines: 70,
				statements: 70,
				functions: 70,
				branches: 70,
			},
		},
	},
	resolve: {
		alias: {
			// `react-dom` is a workspace runtime dep of `packages/shell`
			// (symlinked into its node_modules) but only a *devDependency*
			// of `packages/sdk` — bun materialises `react`'s peer symlink
			// there but not `react-dom`'s, so the sdk property-ui
			// `*.test.tsx` files (the only `react-dom/client` importers
			// outside the shell) fail to resolve it under vitest. Pin both
			// specifiers to the shell's resolvable copy so resolution is
			// deterministic regardless of which package context imports it.
			// Test-only (vitest config); production property-ui runs in the
			// shell where react-dom is properly linked. Longer prefix first
			// per the ordering rule below.
			"react-dom/client": resolve(__dirname, "packages/shell/node_modules/react-dom/client.js"),
			"react-dom": resolve(__dirname, "packages/shell/node_modules/react-dom"),
			"@brainstorm/tokens": resolve(__dirname, "packages/tokens/src/index.ts"),
			// Subpath exports — must precede the bare `@brainstorm/sdk` entry
			// so the longer prefix wins (alias matching is order-sensitive),
			// else `@brainstorm/sdk/resizable` rewrites to `…/index.ts/resizable`.
			"@brainstorm/sdk/property-ui/pure": resolve(__dirname, "packages/sdk/src/property-ui-pure.ts"),
			// `.css` must precede the bare `…/dictionary-editor` (JS) alias — the
			// prefix matcher would otherwise rewrite it to `…/dictionary-editor.tsx.css`.
			"@brainstorm/sdk/property-ui/dictionary-editor.css": resolve(
				__dirname,
				"packages/sdk/src/property-ui/dictionary-editor.css",
			),
			"@brainstorm/sdk/property-ui/dictionary-editor": resolve(
				__dirname,
				"packages/sdk/src/property-ui/dictionary-editor.tsx",
			),
			"@brainstorm/sdk/property-ui": resolve(__dirname, "packages/sdk/src/property-ui.ts"),
			"@brainstorm/sdk/resizable": resolve(__dirname, "packages/sdk/src/resizable.ts"),
			"@brainstorm/sdk/searchbar": resolve(__dirname, "packages/sdk/src/searchbar/index.ts"),
			"@brainstorm/sdk/perf": resolve(__dirname, "packages/sdk/src/perf.ts"),
			"@brainstorm/sdk/date-buckets": resolve(__dirname, "packages/sdk/src/date-buckets.ts"),
			"@brainstorm/sdk/date-formatters": resolve(__dirname, "packages/sdk/src/date-formatters.ts"),
			"@brainstorm/sdk/find-replace": resolve(__dirname, "packages/sdk/src/find-replace/index.ts"),
			"@brainstorm/sdk/frustum-cull": resolve(__dirname, "packages/sdk/src/frustum-cull.ts"),
			"@brainstorm/sdk/in-memory-entities": resolve(
				__dirname,
				"packages/sdk/src/in-memory-entities.ts",
			),
			"@brainstorm/sdk/system-entities": resolve(__dirname, "packages/sdk/src/system-entities.ts"),
			"@brainstorm/sdk/predicate-eval": resolve(__dirname, "packages/sdk/src/predicate-eval/index.ts"),
			"@brainstorm/sdk/note-references": resolve(__dirname, "packages/sdk/src/note-references.ts"),
			"@brainstorm/sdk/language-detect": resolve(__dirname, "packages/sdk/src/language-detect.ts"),
			"@brainstorm/sdk/code-highlight": resolve(__dirname, "packages/sdk/src/code-highlight/index.ts"),
			"@brainstorm/sdk/selection": resolve(__dirname, "packages/sdk/src/selection.ts"),
			"@brainstorm/sdk/codec-helpers": resolve(__dirname, "packages/sdk/src/codec-helpers.ts"),
			"@brainstorm/sdk/sanitize-text": resolve(__dirname, "packages/sdk/src/sanitize-text.ts"),
			"@brainstorm/sdk/spellcheck-menu": resolve(__dirname, "packages/sdk/src/spellcheck-menu.ts"),
			"@brainstorm/sdk/spellcheck": resolve(__dirname, "packages/sdk/src/spellcheck.ts"),
			"@brainstorm/sdk/peer-presence": resolve(__dirname, "packages/sdk/src/peer-presence.ts"),
			"@brainstorm/sdk/storage-repository": resolve(
				__dirname,
				"packages/sdk/src/storage-repository.ts",
			),
			"@brainstorm/sdk/last-viewed": resolve(__dirname, "packages/sdk/src/last-viewed.ts"),
			"@brainstorm/sdk/lock-button": resolve(__dirname, "packages/sdk/src/lock-button/index.ts"),
			"@brainstorm/sdk/entity-icon": resolve(__dirname, "packages/sdk/src/entity-icon.ts"),
			"@brainstorm/sdk/tab-identity": resolve(__dirname, "packages/sdk/src/tab-identity.ts"),
			"@brainstorm/sdk/entity-cover": resolve(__dirname, "packages/sdk/src/entity-cover.ts"),
			"@brainstorm/sdk/entity-drag": resolve(__dirname, "packages/sdk/src/entity-drag.ts"),
			"@brainstorm/sdk/object-dnd": resolve(__dirname, "packages/sdk/src/object-dnd/index.ts"),
			"@brainstorm/sdk/icon-picker": resolve(__dirname, "packages/sdk/src/icon-picker/index.ts"),
			"@brainstorm/sdk/cover-picker": resolve(__dirname, "packages/sdk/src/cover-picker/index.ts"),
			"@brainstorm/sdk/color-picker": resolve(__dirname, "packages/sdk/src/color-picker/index.ts"),
			"@brainstorm/sdk/picker-host": resolve(__dirname, "packages/sdk/src/picker-host.tsx"),
			"@brainstorm/sdk/recurrence-labels": resolve(
				__dirname,
				"packages/sdk/src/i18n/recurrence-labels.ts",
			),
			"@brainstorm/sdk/recurrence-edit": resolve(__dirname, "packages/sdk/src/recurrence-edit.ts"),
			"@brainstorm/sdk/reminder-schedule": resolve(__dirname, "packages/sdk/src/reminder-schedule.ts"),
			"@brainstorm/sdk/recurrence-editor": resolve(
				__dirname,
				"packages/sdk/src/recurrence-editor/index.ts",
			),
			"@brainstorm/sdk/i18n": resolve(__dirname, "packages/sdk/src/i18n/common-labels.ts"),
			"@brainstorm/sdk/i18n-react": resolve(__dirname, "packages/sdk/src/i18n/react.tsx"),
			"@brainstorm/sdk/object-menu": resolve(__dirname, "packages/sdk/src/object-menu/index.ts"),
			"@brainstorm/sdk/contributed-actions": resolve(
				__dirname,
				"packages/sdk/src/contributed-actions/index.ts",
			),
			"@brainstorm/sdk/menus": resolve(__dirname, "packages/sdk/src/menus/index.ts"),
			// `.css` must precede the bare `…/tooltip` (JS) alias — the prefix
			// matcher would otherwise rewrite it to `…/tooltip/index.ts.css`.
			"@brainstorm/sdk/tooltip.css": resolve(__dirname, "packages/sdk/src/tooltip/tooltip.css"),
			"@brainstorm/sdk/tooltip": resolve(__dirname, "packages/sdk/src/tooltip/index.ts"),
			"@brainstorm/sdk/widget": resolve(__dirname, "packages/sdk/src/widget/index.tsx"),
			"@brainstorm/sdk/select-menu": resolve(__dirname, "packages/sdk/src/select-menu/index.ts"),
			// `.css` alias before the base so the matcher doesn't rewrite it to
			// `…/composer-context/index.ts.css`.
			"@brainstorm/sdk/composer-context.css": resolve(
				__dirname,
				"packages/sdk/src/composer-context/composer-context.css",
			),
			"@brainstorm/sdk/composer-context": resolve(
				__dirname,
				"packages/sdk/src/composer-context/index.ts",
			),
			"@brainstorm/sdk/icon": resolve(__dirname, "packages/sdk/src/icon/index.ts"),
			"@brainstorm/sdk/typography": resolve(__dirname, "packages/sdk/src/typography/index.ts"),
			"@brainstorm/sdk/popover": resolve(__dirname, "packages/sdk/src/popover/index.ts"),
			"@brainstorm/sdk/shortcut": resolve(__dirname, "packages/sdk/src/shortcut/index.ts"),
			"@brainstorm/sdk/nav-history": resolve(__dirname, "packages/sdk/src/nav-history/index.ts"),
			"@brainstorm/sdk/a11y": resolve(__dirname, "packages/sdk/src/a11y/index.ts"),
			"@brainstorm/sdk/date-pager": resolve(__dirname, "packages/sdk/src/date-pager/index.ts"),
			"@brainstorm/sdk/date-grid": resolve(__dirname, "packages/sdk/src/date-grid/index.ts"),
			"@brainstorm/sdk/calendar": resolve(__dirname, "packages/sdk/src/calendar/index.ts"),
			"@brainstorm/sdk/panel-toggle": resolve(__dirname, "packages/sdk/src/panel-toggle/index.ts"),
			"@brainstorm/sdk/pdf-engine": resolve(__dirname, "packages/sdk/src/pdf-engine/index.ts"),
			"@brainstorm/sdk/checkbox": resolve(__dirname, "packages/sdk/src/checkbox/index.ts"),
			"@brainstorm/sdk/count-badge": resolve(__dirname, "packages/sdk/src/count-badge/index.ts"),
			"@brainstorm/sdk/properties-panel": resolve(
				__dirname,
				"packages/sdk/src/properties-panel/index.tsx",
			),
			"@brainstorm/sdk/layout-resolver": resolve(__dirname, "packages/sdk/src/layout-resolver.ts"),
			"@brainstorm/sdk/block-frame/inner": resolve(
				__dirname,
				"packages/sdk/src/block-frame/inner-transport.ts",
			),
			"@brainstorm/sdk/block-frame": resolve(__dirname, "packages/sdk/src/block-frame/index.ts"),
			"@brainstorm/sdk/block-registry": resolve(__dirname, "packages/sdk/src/block-registry/index.ts"),
			"@brainstorm/sdk/block-mount": resolve(__dirname, "packages/sdk/src/block-mount/index.ts"),
			"@brainstorm/sdk/block-runtime": resolve(__dirname, "packages/sdk/src/block-runtime/index.ts"),
			"@brainstorm/sdk/export-file": resolve(__dirname, "packages/sdk/src/export-file/index.ts"),
			"@brainstorm/sdk/export-popover": resolve(__dirname, "packages/sdk/src/export-popover/index.ts"),
			"@brainstorm/sdk/formula": resolve(__dirname, "packages/sdk/src/formula/index.ts"),
			"@brainstorm/sdk/entity-export": resolve(__dirname, "packages/sdk/src/entity-export/index.ts"),
			"@brainstorm/sdk/virtual-list": resolve(__dirname, "packages/sdk/src/virtual-list/index.ts"),
			// CSS subpaths — apps `import "@brainstorm/sdk/app-theme.css"` for
			// shared chrome; vitest's resolver doesn't consult the package
			// `exports` map by default, so boot-smoke tests fail without these.
			"@brainstorm/sdk/app-theme.css": resolve(__dirname, "packages/sdk/src/app-theme.css"),
			"@brainstorm/sdk/searchbar/searchbar.css": resolve(
				__dirname,
				"packages/sdk/src/searchbar/searchbar.css",
			),
			"@brainstorm/sdk/checkbox/checkbox.css": resolve(
				__dirname,
				"packages/sdk/src/checkbox/checkbox.css",
			),
			"@brainstorm/sdk/count-badge.css": resolve(
				__dirname,
				"packages/sdk/src/count-badge/count-badge.css",
			),
			"@brainstorm/sdk/properties-panel/properties-panel.css": resolve(
				__dirname,
				"packages/sdk/src/properties-panel/properties-panel.css",
			),
			"@brainstorm/sdk/property-ui/cells.css": resolve(
				__dirname,
				"packages/sdk/src/property-ui/cells.css",
			),
			"@brainstorm/sdk/virtual-list.css": resolve(
				__dirname,
				"packages/sdk/src/virtual-list/virtual-list.css",
			),
			"@brainstorm/sdk/coming-soon/coming-soon.css": resolve(
				__dirname,
				"packages/sdk/src/coming-soon/coming-soon.css",
			),
			"@brainstorm/sdk/coming-soon": resolve(__dirname, "packages/sdk/src/coming-soon/index.ts"),
			"@brainstorm/sdk/empty-state.css": resolve(
				__dirname,
				"packages/sdk/src/empty-state/empty-state.css",
			),
			"@brainstorm/sdk/empty-state": resolve(__dirname, "packages/sdk/src/empty-state/index.ts"),
			"@brainstorm/sdk": resolve(__dirname, "packages/sdk/src/index.ts"),
			"@brainstorm/sdk-types": resolve(__dirname, "packages/sdk-types/src/index.ts"),
			"@brainstorm/react-yjs": resolve(__dirname, "packages/react-yjs/src/index.ts"),
			// CSS subpaths must precede the bare `@brainstorm/editor` alias — else
			// it swallows the `/editor.css` suffix into `index.ts/editor.css`
			// (boot-smoke evaluates an app entry that imports the stylesheet).
			"@brainstorm/editor/editor.css": resolve(__dirname, "packages/editor/src/editor.css"),
			"@brainstorm/editor/editor-theme.css": resolve(
				__dirname,
				"packages/editor/src/editor-theme.css",
			),
			"@brainstorm/editor": resolve(__dirname, "packages/editor/src/index.ts"),
			"@brainstorm/cli": resolve(__dirname, "packages/cli/src/index.ts"),
			"@renderer": resolve(__dirname, "packages/shell/src/renderer"),
		},
	},
});
