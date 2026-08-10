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
import { type ElectronApplication, type Page, _electron } from "@playwright/test";

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

/* An app window is an Electron `BaseWindow` hosting several `WebContentsView`s,
 * and Playwright surfaces every one of them as a `Page`. The container mounts
 * its tab-strip chrome view (`AppLauncher.openContainer`) BEFORE it adds the
 * app tab, so the strip's `window` event fires first and a bare
 * `app.waitForEvent("window")` hands back the strip — which collapses to
 * height 0 while the container holds a single tab (`WindowContainer.layout`).
 * That is the "0 width" screenshot error and every `visible` locator timing
 * out (F-485). Select the page by URL instead, exactly as the dogfood harness
 * does. */
const TAB_STRIP_URL_FRAGMENT = "/chrome/tab-strip";
const DASHBOARD_URL_FRAGMENT = "/renderer/index.html";
/** Installed bundles live at `<vault>/apps/<appId>/<version>/…`
 *  (`AppInstaller.installDirFor`), so every app-renderer entry URL carries this
 *  segment — while the drag-ghost overlay (`data:`), Browser's web views
 *  (`http(s):`) and both shell surfaces above do not. */
const APP_BUNDLE_URL_FRAGMENT = "/apps/";

/** True when `page` is an app renderer — not the dashboard, the tab strip, or
 *  any other surface the shell parks in the same window list. Pass `appId` to
 *  require a specific app. */
export function isAppPage(page: Page, appId?: string): boolean {
	const url = page.url();
	if (!url.startsWith("file://")) return false;
	if (url.includes(TAB_STRIP_URL_FRAGMENT) || url.includes(DASHBOARD_URL_FRAGMENT)) return false;
	if (!url.includes(APP_BUNDLE_URL_FRAGMENT)) return false;
	return appId === undefined || url.includes(`/${appId}/`);
}

export type WaitForAppPageOptions = {
	appId?: string;
	timeoutMs?: number;
	/** Pages to ignore — pass the pre-click window list when a spec opens a
	 *  second app and must not match the first one again. */
	exclude?: readonly Page[];
};

/** Poll the live page set for an app-renderer page, waking on each new window.
 *  The replacement for `app.waitForEvent("window")` after a launch click. */
export async function waitForAppPage(
	app: ElectronApplication,
	options: WaitForAppPageOptions = {},
): Promise<Page> {
	const { appId, timeoutMs = 30_000 } = options;
	const skip = new Set<Page>(options.exclude ?? []);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const hit = app.windows().find((page) => !skip.has(page) && isAppPage(page, appId));
		if (hit) return hit;
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await app.waitForEvent("window", { timeout: Math.min(500, remaining) }).catch(() => undefined);
	}
	const seen = app.windows().map((page) => page.url());
	throw new Error(
		`waitForAppPage: no app renderer${appId ? ` for ${appId}` : ""} after ${timeoutMs}ms (pages: ${seen.join(", ") || "none"})`,
	);
}

export type OpenAppOptions = WaitForAppPageOptions & {
	/** Dashboard icon label to click. Omit to click the first icon. */
	label?: string;
};

/** Dismiss the What's-New popover if it is up, click an app's dashboard icon,
 *  and return the app renderer page once it has parsed its document. */
export async function openAppFromDashboard(
	app: ElectronApplication,
	dashboard: Page,
	options: OpenAppOptions = {},
): Promise<Page> {
	const { label, ...waitOptions } = options;
	const whatsNew = dashboard.locator(".popover");
	if (await whatsNew.isVisible().catch(() => false)) {
		await dashboard.keyboard.press("Escape");
		await whatsNew.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
	}
	const icons =
		label === undefined
			? dashboard.locator(".dashboard-icons__icon")
			: dashboard.locator(".dashboard-icons__icon", { hasText: label });
	const icon = icons.first();
	await icon.waitFor({ state: "visible", timeout: 10_000 });
	await icon.click();
	const page = await waitForAppPage(app, waitOptions);
	await page.waitForLoadState("domcontentloaded");
	return page;
}
