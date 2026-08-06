import { defineConfig } from "@playwright/test";
import { scaled } from "./tests/e2e/lib/ci-timeouts";

// 13.3 — Playwright end-to-end smoke. Functional (not perf): exercises the
// beta-exit happy paths against the production-built shell under Electron —
// create-vault, install app, edit a Note, an FTS hit, the multi-device
// pairing entry, and a theme switch.
//
// NOT wired into `bun run test` (Vitest under Bun). Runs via `bun run e2e`,
// chained to `e2e:build` so a stale `packages/shell/out/` can't pass a smoke
// that the current source would fail. Reuses the proven perf launch harness
// (`tests/perf/lib/launch-shell.ts`) so there is one Electron-launch path.
//
// Display requirements (same as the perf harness): macOS / Windows run
// unmodified; Linux CI must wrap in `xvfb-run --auto-servernum -- bun run e2e`
// (or export a real `DISPLAY`). `launchShell` keeps a real GPU/display — the
// renderer must actually paint for the smoke to mean anything.
export default defineConfig({
	testDir: "./tests/e2e/specs",
	testMatch: /.*\.spec\.ts$/,
	// Each spec launches its own Electron process against its own
	// `--user-data-dir`; serialise so the windows don't contend.
	workers: 1,
	fullyParallel: false,
	// One flaky retry — a smoke is a yes/no on the flow, and a real Electron
	// boot occasionally loses a window event to OS scheduling jitter.
	retries: 1,
	// 180s locally; 3x on CI, where the same spec ran past this budget on a
	// shared runner even after its internal poll was given room.
	timeout: scaled(180_000),
	reporter: [["list"], ["json", { outputFile: "tests/e2e/results/playwright-report.json" }]],
});
