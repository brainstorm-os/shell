/**
 * LaunchOrchestrator — resolves an app id into a fully-realized
 * `AppLauncher.launch(options)` call.
 *
 * The dashboard, launcher palette (Stage 7.4), and intent dispatcher
 * (Stage 7.5) all need the same lookup chain to open an app window:
 *   1. Pull the installed-app record from `AppsRepository`.
 *   2. Read `manifest.json` from the bundle dir to get current capabilities + sdk.
 *   3. Read the live capability grants from the ledger.
 *   4. Hand off to `AppLauncher.launch(...)`.
 *
 * Centralizing the lookup keeps callers from poking at the bundle dir or the
 * ledger directly — and means the integrity-check step (Stage 12) lives in
 * one place.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import type { FormatContext, LaunchContext } from "@brainstorm-os/sdk-types";
import type { ThemeName } from "@brainstorm-os/tokens";
import type { AppsRepository } from "../storage/registry-repo/apps-repo";
import type { AppLauncher, AppWindow, LaunchOptions } from "./launcher";

export type LaunchOrchestratorOptions = {
	appsRepo: AppsRepository;
	ledger: CapabilityLedger;
	launcher: AppLauncher;
	/** Resolve the active shell theme name. The orchestrator awaits this on
	 *  each launch so the app window opens with the correct theme without
	 *  needing a follow-up IPC round-trip. Returns `null` when no session is
	 *  active (tests + early-boot callers); the preload then falls back to
	 *  `DEFAULT_THEME`. */
	getActiveTheme?: () => Promise<ThemeName | null>;
	/** Resolve the active UI locale (BCP-47 tag), awaited on each launch so the
	 *  app window opens in the right language with no follow-up IPC round-trip
	 *  (12.15). Returns `null` when no session is active (tests + early-boot
	 *  callers); the SDK then falls back to `DEFAULT_LOCALE`. */
	getActiveLocale?: () => Promise<string | null>;
	/** Resolve the active regional-format context, awaited on each launch so the
	 *  app window's first frame formats dates / numbers per Settings → Regional
	 *  (12.15 15f). `null` when no session is active (host defaults). */
	getActiveFormat?: () => Promise<FormatContext | null>;
};

export type OrchestratedLaunch = {
	appId: string;
	launch?: LaunchContext;
	windowId?: string;
};

function makeLaunchError(
	kind: "NotInstalled" | "BundleMissing" | "Invalid",
	message: string,
	details?: Record<string, unknown>,
): Error {
	const err = new Error(message) as Error & { kind?: string; details?: Record<string, unknown> };
	err.name = kind;
	err.kind = kind;
	if (details) err.details = details;
	return err;
}

export class LaunchOrchestrator {
	/** Resolved `entry` per bundle, keyed by `bundleSha256`. The manifest only
	 *  contributes `entry` to a launch (capabilities are reconciled at
	 *  install/update time), and `entry` is immutable for a given bundle hash —
	 *  so reading + parsing manifest.json on every window open / app switch is
	 *  pure I/O latency on the critical path. The sha key invalidates whenever
	 *  the bundle content changes (install, update, dev rebuild-reinstall). */
	private readonly entryCache = new Map<string, string>();

	constructor(private readonly options: LaunchOrchestratorOptions) {}

	async launch(request: OrchestratedLaunch): Promise<AppWindow> {
		return this.options.launcher.launch(await this.buildOptions(request));
	}

	/** Open the launch context as a new tab in an existing container (the tab
	 *  strip's "+" / new-tab mode). */
	async addTab(containerId: string, request: OrchestratedLaunch): Promise<AppWindow> {
		return this.options.launcher.addTabToContainer(containerId, await this.buildOptions(request));
	}

	/** Open the launch context in a brand-new container (new-window mode). */
	async openInNewWindow(request: OrchestratedLaunch): Promise<AppWindow> {
		return this.options.launcher.openInNewWindow(await this.buildOptions(request));
	}

	private async buildOptions(request: OrchestratedLaunch): Promise<LaunchOptions> {
		const record = this.options.appsRepo.getActive(request.appId);
		if (!record) {
			throw makeLaunchError("NotInstalled", `app ${request.appId} is not installed`);
		}
		const entryPath = await this.resolveEntryPath(request.appId, record);
		const capabilities = this.options.ledger
			.listActive(request.appId)
			.map((grant) =>
				grant.scope === null ? grant.capability : `${grant.capability}:${grant.scope}`,
			);

		const theme = this.options.getActiveTheme
			? await this.options.getActiveTheme().catch((error) => {
					console.warn("[LaunchOrchestrator] getActiveTheme failed:", error);
					return null;
				})
			: null;
		const locale = this.options.getActiveLocale
			? await this.options.getActiveLocale().catch((error) => {
					console.warn("[LaunchOrchestrator] getActiveLocale failed:", error);
					return null;
				})
			: null;
		const format = this.options.getActiveFormat
			? await this.options.getActiveFormat().catch((error) => {
					console.warn("[LaunchOrchestrator] getActiveFormat failed:", error);
					return null;
				})
			: null;
		const options: LaunchOptions = {
			appId: request.appId,
			bundleDir: record.bundleDir,
			entryPath,
			launch: request.launch ?? { reason: "fresh" as const },
			capabilities,
			version: record.version,
			sdk: record.sdk,
		};
		if (theme) options.theme = theme;
		if (locale) options.locale = locale;
		if (format) options.format = format;
		if (request.windowId !== undefined) options.windowId = request.windowId;
		return options;
	}

	private async resolveEntryPath(
		appId: string,
		record: { bundleDir: string; bundleSha256: string },
	): Promise<string> {
		const cached = this.entryCache.get(record.bundleSha256);
		if (cached !== undefined) return cached;

		const manifestPath = join(record.bundleDir, "manifest.json");
		let manifestRaw: string;
		try {
			manifestRaw = await readFile(manifestPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw makeLaunchError(
					"BundleMissing",
					`app ${appId} is registered but its bundle is gone from disk — uninstall it to clean up`,
					{ appId },
				);
			}
			throw error;
		}
		// `capabilities` are reconciled at install/update time, not here; `entry`
		// is the only launch-relevant field — the manifest-declared renderer HTML
		// relative to bundleDir. Default "index.html" for back-compat; rejected if
		// it tries to escape the bundle via `..` or an absolute path.
		const manifest = JSON.parse(manifestRaw) as { entry?: string };
		const entryPath = manifest.entry ?? "index.html";
		if (entryPath.includes("..") || entryPath.startsWith("/")) {
			throw makeLaunchError(
				"Invalid",
				`app ${appId} manifest.entry must be a relative path inside the bundle, got ${entryPath}`,
				{ appId },
			);
		}
		this.entryCache.set(record.bundleSha256, entryPath);
		return entryPath;
	}
}
