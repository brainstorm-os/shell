/**
 * Launches the production-built shell under Playwright's Electron driver.
 *
 * Each call points Electron at a caller-provided `userDataDir` so two
 * launches in the same spec can be cold (fresh dir) or warm (reused dir =
 * same vault state, same registry, on-disk caches warm).
 *
 * Forces `BRAINSTORM_DEV_INSECURE_CREDENTIALS=1` so no real OS-keyring entry
 * is needed — the shell creates an `insecure-dev` master key file inside the
 * vault. Matches the in-process integration tests' keystore mode.
 *
 * `BRAINSTORM_AUTO_SEED=0` keeps the dev seeder out of cold-start
 * measurements — the harness explicitly controls vault state.
 */

import { appendFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron } from "@playwright/test";

/* Playwright runs this file as an ES module — `__dirname` doesn't exist
 * there; the previous CJS form (`resolve(__dirname, ...)`) threw a
 * `ReferenceError: __dirname is not defined in ES module scope` on
 * import, preventing any perf spec from even reaching its test fn. */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SHELL_DIR = join(REPO_ROOT, "packages", "shell");
const ELECTRON_BIN = join(SHELL_DIR, "node_modules", ".bin", "electron");
const MAIN_ENTRY = join(SHELL_DIR, "out", "main", "index.js");

export type LaunchOptions = {
	userDataDir: string;
	timeoutMs?: number;
	extraEnv?: Record<string, string>;
	/** Optional file path. When set, the Electron child's stdout + stderr
	 *  are appended to this file. Used by the soak harness to capture
	 *  pairing/sync debug instrumentation that the shell's main process
	 *  writes when `BRAINSTORM_SOAK_DEBUG=1`. */
	stdioCapturePath?: string;
};

export type LaunchResult = {
	app: ElectronApplication;
};

export function shellBuildExists(): boolean {
	return existsSync(MAIN_ENTRY);
}

/**
 * Harness runs are HIDDEN by default: `BRAINSTORM_HIDDEN_WINDOWS=1` stops the
 * shell mapping any window onto a display (see
 * `packages/shell/src/main/window/reveal-window.ts`), so an e2e / perf / soak
 * / visual run never paints over whatever the developer is doing. The renderer
 * keeps painting, so CDP screenshots and screencasts are unaffected.
 *
 * Opt out with `BRAINSTORM_TEST_VISIBLE=1` when a human genuinely wants to
 * watch a run.
 */
export function hiddenWindowEnv(): Record<string, string> {
	if (process.env.BRAINSTORM_TEST_VISIBLE === "1") return {};
	return { BRAINSTORM_HIDDEN_WINDOWS: "1" };
}

export async function launchShell(options: LaunchOptions): Promise<LaunchResult> {
	if (!shellBuildExists()) {
		throw new Error(
			`Shell build not found at ${MAIN_ENTRY}. Run "bun run perf:build" before "bun run perf".`,
		);
	}
	const app = await _electron.launch({
		executablePath: ELECTRON_BIN,
		args: [MAIN_ENTRY, `--user-data-dir=${options.userDataDir}`],
		cwd: SHELL_DIR,
		timeout: options.timeoutMs ?? 60_000,
		env: {
			...process.env,
			BRAINSTORM_DEV_INSECURE_CREDENTIALS: "1",
			BRAINSTORM_AUTO_SEED: "0",
			// Reveal every window with `showInactive` so repeated Playwright
			// launches don't rip OS focus away from the developer — Playwright
			// drives the renderer over CDP, which never needs OS-level focus.
			BRAINSTORM_NO_FOCUS: "1",
			...hiddenWindowEnv(),
			NODE_ENV: "production",
			...(options.extraEnv ?? {}),
		},
	});
	if (options.stdioCapturePath) {
		const cap = options.stdioCapturePath;
		const proc = app.process();
		const tag = `[shell:${options.userDataDir.split("/").pop() ?? "?"}]`;
		proc.stdout?.on("data", (chunk) => {
			try {
				appendFileSync(cap, `${tag}/OUT ${String(chunk)}`);
			} catch {
				// best-effort
			}
		});
		proc.stderr?.on("data", (chunk) => {
			try {
				appendFileSync(cap, `${tag}/ERR ${String(chunk)}`);
			} catch {
				// best-effort
			}
		});
	}
	return { app };
}
