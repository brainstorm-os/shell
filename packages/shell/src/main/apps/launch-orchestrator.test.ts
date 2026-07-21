import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { ThemeName } from "@brainstorm-os/tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardStore } from "../dashboard/dashboard-store";
import type { AppsRepository } from "../storage/registry-repo/apps-repo";
import { YDocStore } from "../storage/ydoc-store";
import { LaunchOrchestrator } from "./launch-orchestrator";
import type { AppLauncher, AppWindow } from "./launcher";

function makeLauncher(): {
	launcher: AppLauncher;
	launches: Array<Parameters<AppLauncher["launch"]>[0]>;
} {
	const launches: Array<Parameters<AppLauncher["launch"]>[0]> = [];
	const launcher = {
		launch: vi.fn((options: Parameters<AppLauncher["launch"]>[0]): AppWindow => {
			launches.push(options);
			return {
				appId: options.appId,
				windowId: options.windowId ?? "main",
				tabId: "tab-1",
				webContentsId: 1,
				parked: false,
				webContents: {} as AppWindow["webContents"],
				container: {} as AppWindow["container"],
			};
		}),
		closeApp: vi.fn(),
	} as unknown as AppLauncher;
	return { launcher, launches };
}

describe("LaunchOrchestrator", () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "brainstorm-launch-"));
	});

	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	async function setupApp(opts: {
		id: string;
		version?: string;
		sdk?: string;
		manifestCaps?: string[];
	}) {
		const bundleDir = join(tmp, opts.id);
		await mkdir(bundleDir, { recursive: true });
		await writeFile(
			join(bundleDir, "manifest.json"),
			JSON.stringify({
				id: opts.id,
				version: opts.version ?? "1.0.0",
				sdk: opts.sdk ?? "1",
				capabilities: opts.manifestCaps ?? [],
			}),
		);
		return bundleDir;
	}

	it("looks up the active record + ledger grants + manifest, then calls launcher.launch", async () => {
		const bundleDir = await setupApp({ id: "io.x.app", version: "1.2.3", sdk: "1" });
		const appsRepo = {
			getActive: vi.fn(() => ({
				id: "io.x.app",
				version: "1.2.3",
				sdk: "1",
				manifestPath: join(bundleDir, "manifest.json"),
				bundleDir,
				bundleSha256: "abc",
				installedAt: 1,
				updatedAt: 1,
			})),
		} as unknown as AppsRepository;
		const ledger = {
			listActive: vi.fn(() => [
				{
					id: "g1",
					appId: "io.x.app",
					capability: "ui.notify",
					scope: null,
					grantedAt: 1,
					grantedVia: "install",
				},
				{
					id: "g2",
					appId: "io.x.app",
					capability: "storage.read",
					scope: "*",
					grantedAt: 1,
					grantedVia: "install",
				},
			]),
		} as unknown as CapabilityLedger;
		const { launcher, launches } = makeLauncher();

		const orchestrator = new LaunchOrchestrator({ appsRepo, ledger, launcher });
		await orchestrator.launch({ appId: "io.x.app" });

		expect(launches).toHaveLength(1);
		const opts = launches[0];
		expect(opts).toMatchObject({
			appId: "io.x.app",
			bundleDir,
			version: "1.2.3",
			sdk: "1",
		});
		expect(opts?.capabilities).toEqual(["ui.notify", "storage.read"]);
		expect(opts?.launch).toEqual({ reason: "fresh" });
	});

	it("throws if the app is not installed", async () => {
		const appsRepo = { getActive: vi.fn(() => null) } as unknown as AppsRepository;
		const ledger = { listActive: vi.fn(() => []) } as unknown as CapabilityLedger;
		const { launcher } = makeLauncher();
		const orchestrator = new LaunchOrchestrator({ appsRepo, ledger, launcher });

		await expect(orchestrator.launch({ appId: "missing" })).rejects.toThrow(/not installed/);
	});

	it("caches the resolved manifest entry per bundle sha — a second same-sha launch skips the read", async () => {
		const bundleDir = await setupApp({ id: "io.x.app" });
		const appsRepo = {
			getActive: vi.fn(() => ({
				id: "io.x.app",
				version: "1.0.0",
				sdk: "1",
				manifestPath: join(bundleDir, "manifest.json"),
				bundleDir,
				bundleSha256: "sha-stable",
				installedAt: 1,
				updatedAt: 1,
			})),
		} as unknown as AppsRepository;
		const ledger = { listActive: vi.fn(() => []) } as unknown as CapabilityLedger;
		const { launcher, launches } = makeLauncher();
		const orchestrator = new LaunchOrchestrator({ appsRepo, ledger, launcher });

		await orchestrator.launch({ appId: "io.x.app" });
		// Remove the manifest from disk; a cached entry means the next launch
		// must not touch the filesystem (and so must not throw BundleMissing).
		await rm(join(bundleDir, "manifest.json"));
		await expect(
			orchestrator.launch({ appId: "io.x.app", windowId: "second" }),
		).resolves.toMatchObject({ appId: "io.x.app", windowId: "second" });
		expect(launches).toHaveLength(2);
		expect(launches[1]?.entryPath).toBe("index.html");
	});

	it("re-invokes getActiveTheme on every launch (no theme caching between launches)", async () => {
		const bundleDir = await setupApp({ id: "io.x.app" });
		const appsRepo = {
			getActive: vi.fn(() => ({
				id: "io.x.app",
				version: "1.0.0",
				sdk: "1",
				manifestPath: join(bundleDir, "manifest.json"),
				bundleDir,
				bundleSha256: "abc",
				installedAt: 1,
				updatedAt: 1,
			})),
		} as unknown as AppsRepository;
		const ledger = { listActive: vi.fn(() => []) } as unknown as CapabilityLedger;
		const { launcher, launches } = makeLauncher();

		let currentTheme: ThemeName = ThemeName.DefaultDark;
		const getActiveTheme = vi.fn(async () => currentTheme);

		const orchestrator = new LaunchOrchestrator({
			appsRepo,
			ledger,
			launcher,
			getActiveTheme,
		});

		await orchestrator.launch({ appId: "io.x.app" });
		expect(launches[0]?.theme).toBe(ThemeName.DefaultDark);

		// Simulate a theme switch happening between launches. The orchestrator
		// must re-read the active theme — the failure mode would be a
		// freshly-launched app paint in the previous theme.
		currentTheme = ThemeName.Midnight;
		await orchestrator.launch({ appId: "io.x.app", windowId: "second" });
		expect(launches[1]?.theme).toBe(ThemeName.Midnight);
		expect(getActiveTheme).toHaveBeenCalledTimes(2);
	});

	it("reads the latest dashboard theme on every launch (regression for the launch-after-theme-switch bug)", async () => {
		const bundleDir = await setupApp({ id: "io.x.app" });
		const appsRepo = {
			getActive: vi.fn(() => ({
				id: "io.x.app",
				version: "1.0.0",
				sdk: "1",
				manifestPath: join(bundleDir, "manifest.json"),
				bundleDir,
				bundleSha256: "abc",
				installedAt: 1,
				updatedAt: 1,
			})),
		} as unknown as AppsRepository;
		const ledger = { listActive: vi.fn(() => []) } as unknown as CapabilityLedger;
		const { launcher, launches } = makeLauncher();

		const yStore = new YDocStore(tmp);
		const dashboard = await DashboardStore.open(yStore);

		// Mirror the closure shape from `runtime/launch-setup.ts` exactly so
		// this test exercises the same lookup chain as production. The only
		// difference is dashboard is fixed (no `getActiveVaultSession()` lookup).
		const orchestrator = new LaunchOrchestrator({
			appsRepo,
			ledger,
			launcher,
			getActiveTheme: async () => dashboard.snapshot().theme,
		});

		await orchestrator.launch({ appId: "io.x.app" });
		expect(launches[0]?.theme).toBe(ThemeName.DefaultDark);

		// User switches theme (synchronous YDoc transact); next launch must
		// read midnight, not the cached default-dark.
		dashboard.setTheme(ThemeName.Midnight);
		await orchestrator.launch({ appId: "io.x.app", windowId: "second" });
		expect(launches[1]?.theme).toBe(ThemeName.Midnight);

		await dashboard.close();
	});

	it("reads the latest dashboard locale on every launch (12.15)", async () => {
		const bundleDir = await setupApp({ id: "io.x.app" });
		const appsRepo = {
			getActive: vi.fn(() => ({
				id: "io.x.app",
				version: "1.0.0",
				sdk: "1",
				manifestPath: join(bundleDir, "manifest.json"),
				bundleDir,
				bundleSha256: "abc",
				installedAt: 1,
				updatedAt: 1,
			})),
		} as unknown as AppsRepository;
		const ledger = { listActive: vi.fn(() => []) } as unknown as CapabilityLedger;
		const { launcher, launches } = makeLauncher();

		const yStore = new YDocStore(tmp);
		const dashboard = await DashboardStore.open(yStore);

		const orchestrator = new LaunchOrchestrator({
			appsRepo,
			ledger,
			launcher,
			getActiveLocale: async () => dashboard.snapshot().locale.language,
		});

		await orchestrator.launch({ appId: "io.x.app" });
		expect(launches[0]?.locale).toBe("en");

		dashboard.setLanguage("es-ES");
		await orchestrator.launch({ appId: "io.x.app", windowId: "second" });
		expect(launches[1]?.locale).toBe("es-ES");

		await dashboard.close();
	});

	it("omits locale when no getActiveLocale is wired (tests / early boot)", async () => {
		const bundleDir = await setupApp({ id: "io.x.app" });
		const appsRepo = {
			getActive: vi.fn(() => ({
				id: "io.x.app",
				version: "1.0.0",
				sdk: "1",
				manifestPath: join(bundleDir, "manifest.json"),
				bundleDir,
				bundleSha256: "abc",
				installedAt: 1,
				updatedAt: 1,
			})),
		} as unknown as AppsRepository;
		const ledger = { listActive: vi.fn(() => []) } as unknown as CapabilityLedger;
		const { launcher, launches } = makeLauncher();
		const orchestrator = new LaunchOrchestrator({ appsRepo, ledger, launcher });
		await orchestrator.launch({ appId: "io.x.app" });
		expect(launches[0]?.locale).toBeUndefined();
	});

	it("forwards a custom LaunchContext (open-entity)", async () => {
		const bundleDir = await setupApp({ id: "io.x.editor" });
		const appsRepo = {
			getActive: vi.fn(() => ({
				id: "io.x.editor",
				version: "1.0.0",
				sdk: "1",
				manifestPath: join(bundleDir, "manifest.json"),
				bundleDir,
				bundleSha256: "abc",
				installedAt: 1,
				updatedAt: 1,
			})),
		} as unknown as AppsRepository;
		const ledger = { listActive: vi.fn(() => []) } as unknown as CapabilityLedger;
		const { launcher, launches } = makeLauncher();
		const orchestrator = new LaunchOrchestrator({ appsRepo, ledger, launcher });

		await orchestrator.launch({
			appId: "io.x.editor",
			launch: { reason: "open-entity", entityId: "ent_42" },
			windowId: "editor-2",
		});

		expect(launches[0]?.launch).toEqual({ reason: "open-entity", entityId: "ent_42" });
		expect(launches[0]?.windowId).toBe("editor-2");
	});
});
