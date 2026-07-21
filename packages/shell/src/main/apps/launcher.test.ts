import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeHandshake, encodeHandshake } from "@brainstorm-os/sdk";
import type { AppHandshake } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RendererIdentityRegistry } from "../ipc/renderer-identity";
import { DataStores } from "../storage/data-stores";
import { AppsRepository } from "../storage/registry-repo";
import { AppSignatureStatus } from "./app-signature";
import { DEFAULT_INSTALL_PROVENANCE } from "./install-provenance";
import { AppLauncher, type ContainerFactory } from "./launcher";
import type { BaseWindowHandle, TabViewFactory, WebContentsViewHandle } from "./window-container";

type Handlers = Map<string, Array<(...a: unknown[]) => void>>;

function makeEmitter() {
	const handlers: Handlers = new Map();
	const on = (event: string, h: (...a: unknown[]) => void) => {
		const set = handlers.get(event) ?? [];
		set.push(h);
		handlers.set(event, set);
	};
	const off = (event: string, h: (...a: unknown[]) => void) => {
		const set = handlers.get(event);
		if (!set) return;
		const i = set.indexOf(h);
		if (i >= 0) set.splice(i, 1);
	};
	const fire = (event: string, ...args: unknown[]) => {
		for (const h of [...(handlers.get(event) ?? [])]) h(...args);
	};
	return { on, off, fire };
}

type FakeBaseWindow = BaseWindowHandle & {
	fire: (event: string, ...a: unknown[]) => void;
	minimizeForTest: () => void;
};
type FakeView = WebContentsViewHandle & { loadedUrl: string };

function fakeFactories() {
	let nextWindowId = 100;
	let nextWcId = 1000;
	const containers: Array<{
		args: Parameters<ContainerFactory>[0];
		window: FakeBaseWindow;
	}> = [];
	const tabViews: Array<{ args: Parameters<TabViewFactory>[0]; view: FakeView }> = [];

	const containerFactory: ContainerFactory = (args) => {
		const id = nextWindowId++;
		const { on, off, fire } = makeEmitter();
		let destroyed = false;
		let minimized = false;
		let fullscreen = false;
		let title = args.title;
		const window: FakeBaseWindow = {
			id,
			contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
			getContentBounds: () => ({ x: 0, y: 0, width: 1100, height: 720 }),
			getBounds: () => ({ x: 0, y: 0, width: 1100, height: 720 }),
			setBounds: vi.fn(),
			setTitle: vi.fn((t: string) => {
				title = t;
			}),
			getTitle: () => title,
			setBackgroundColor: vi.fn(),
			isDestroyed: () => destroyed,
			isFocused: () => false,
			isMinimized: () => minimized,
			isMaximized: () => false,
			isFullScreen: () => fullscreen,
			setFullScreen: vi.fn((flag: boolean) => {
				if (fullscreen === flag) return;
				fullscreen = flag;
				fire(flag ? "enter-full-screen" : "leave-full-screen");
			}),
			focus: vi.fn(),
			show: vi.fn(),
			showInactive: vi.fn(),
			hide: vi.fn(),
			minimizeForTest: () => {
				minimized = true;
			},
			restore: vi.fn(() => {
				minimized = false;
			}),
			minimize: vi.fn(),
			maximize: vi.fn(),
			unmaximize: vi.fn(),
			close: vi.fn(() => {
				let prevented = false;
				fire("close", {
					preventDefault: () => {
						prevented = true;
					},
				});
				if (prevented) return;
				destroyed = true;
				fire("closed");
			}),
			destroy: vi.fn(() => {
				if (destroyed) return;
				destroyed = true;
				fire("closed");
			}),
			on: on as BaseWindowHandle["on"],
			off: off as BaseWindowHandle["off"],
			once: ((event: string, h: (...a: unknown[]) => void) => {
				const wrap = (...a: unknown[]) => {
					off(event, wrap);
					h(...a);
				};
				on(event, wrap);
			}) as BaseWindowHandle["once"],
			fire,
		};
		containers.push({ args, window });
		return window;
	};

	const tabViewFactory: TabViewFactory = (args) => {
		const id = nextWcId++;
		const { on, off, fire } = makeEmitter();
		let destroyed = false;
		let title = "";
		const view = {
			loadedUrl: "",
			webContents: {
				id,
				send: vi.fn(),
				getTitle: () => title,
				getURL: () => view.loadedUrl,
				isDestroyed: () => destroyed,
				isFocused: () => false,
				startDrag: vi.fn(),
				close: vi.fn(() => {
					destroyed = true;
				}),
				focus: vi.fn(),
				loadURL: vi.fn((url: string) => {
					view.loadedUrl = url;
					// Mirror Electron: a successful load fires `did-finish-load`.
					fire("did-finish-load");
				}),
				on: on as WebContentsViewHandle["webContents"]["on"],
				off: off as WebContentsViewHandle["webContents"]["off"],
			},
			setBounds: vi.fn(),
			setVisible: vi.fn(),
			setBackgroundColor: vi.fn(),
			// Test affordance — drive a title change as the renderer would.
			emitTitle: (t: string) => {
				title = t;
				fire("page-title-updated");
			},
		} as FakeView & { emitTitle: (t: string) => void };
		tabViews.push({ args, view });
		return view;
	};

	return { containerFactory, tabViewFactory, containers, tabViews };
}

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-launcher-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("registry");
	const appsRepo = new AppsRepository(db);
	const identities = new RendererIdentityRegistry();
	const { containerFactory, tabViewFactory, containers, tabViews } = fakeFactories();
	const revealDashboard = vi.fn();
	const launcher = new AppLauncher({
		mainDir: "/fake/main",
		appsRepo,
		identities,
		containerFactory,
		tabViewFactory,
		resolveAppName: (appId) => `${appId} app`,
		revealDashboard,
	});

	const bundleDir = join(vaultDir, "apps", "io.example.notes", "1.0.0");
	appsRepo.upsert({
		id: "io.example.notes",
		version: "1.0.0",
		sdk: "1",
		manifestPath: join(bundleDir, "manifest.json"),
		bundleDir,
		bundleSha256: "a".repeat(64),
		installedAt: 1,
		updatedAt: 1,
		signatureStatus: AppSignatureStatus.Unsigned,
		signatureKeyId: null,
		...DEFAULT_INSTALL_PROVENANCE,
	});

	return {
		vaultDir,
		stores,
		appsRepo,
		identities,
		launcher,
		containers,
		tabViews,
		bundleDir,
		revealDashboard,
	};
}

const baseLaunch = {
	appId: "io.example.notes",
	entryPath: "index.html",
	launch: { reason: "fresh" as const },
	capabilities: ["storage.kv"] as readonly string[],
	version: "1.0.0",
	sdk: "1",
};

describe("AppLauncher", () => {
	let env: Awaited<ReturnType<typeof setup>>;

	beforeEach(async () => {
		env = await setup();
	});

	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("creates a tab view with the right preload + identity-stamping args", () => {
		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		expect(env.tabViews).toHaveLength(1);
		const args = env.tabViews[0]?.args;
		expect(args?.appId).toBe("io.example.notes");
		expect(args?.preloadPath).toMatch(/preload[/\\]app-preload\.js$/);
		expect(args?.additionalArguments.some((a) => a === "--brainstorm-app-id=io.example.notes")).toBe(
			true,
		);
		const handshakeArg = args?.additionalArguments.find((a) =>
			a.startsWith("--brainstorm-handshake="),
		);
		expect(handshakeArg).toBeDefined();
		const decoded = decodeHandshake(handshakeArg?.slice("--brainstorm-handshake=".length) ?? "");
		expect(decoded.app.id).toBe("io.example.notes");
		expect(decoded.capabilities).toEqual(["storage.kv"]);
	});

	it("carries the active locale on the handshake when supplied (12.15)", () => {
		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir, locale: "es-ES" });
		const handshakeArg = env.tabViews[0]?.args.additionalArguments.find((a) =>
			a.startsWith("--brainstorm-handshake="),
		);
		const decoded = decodeHandshake(handshakeArg?.slice("--brainstorm-handshake=".length) ?? "");
		expect(decoded.locale).toBe("es-ES");
	});

	it("omits locale from the handshake when none is supplied (12.15)", () => {
		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		const handshakeArg = env.tabViews[0]?.args.additionalArguments.find((a) =>
			a.startsWith("--brainstorm-handshake="),
		);
		const decoded = decodeHandshake(handshakeArg?.slice("--brainstorm-handshake=".length) ?? "");
		expect(decoded.locale).toBeUndefined();
	});

	it("seeds the container + tab title with the app's display name", () => {
		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		expect(env.containers[0]?.args.title).toBe("io.example.notes app");
		expect(env.containers[0]?.window.getTitle()).toBe("io.example.notes app");
	});

	it("updates the OS window title when the active tab publishes its object name", () => {
		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		const tab = env.tabViews[0]?.view as FakeView & { emitTitle: (t: string) => void };
		tab.emitTitle("My note — Notes");
		expect(env.containers[0]?.window.getTitle()).toBe("My note — Notes");
	});

	it("seeds the tab route from an open-entity launch context", () => {
		const window = env.launcher.launch({
			...baseLaunch,
			bundleDir: env.bundleDir,
			launch: { reason: "open-entity", entityId: "ent_42" },
		});
		expect(window.container.activeRoute()).toBe("brainstorm://entity/ent_42");
	});

	it("cache-busts the file:// entry URL with the bundle digest", () => {
		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		const entry = env.tabViews[0]?.view.loadedUrl ?? "";
		expect(entry.startsWith(`file://${join(env.bundleDir, "index.html")}`)).toBe(true);
		expect(entry).toContain("?v=aaaaaaaa");
	});

	it("registers the WebContents id in the identity registry", () => {
		const window = env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		expect(env.identities.get(window.webContentsId)).toBe("io.example.notes");
	});

	it("reveals and focuses an existing container when launched a second time with the same windowId", () => {
		const first = env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		const second = env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		expect(second.webContentsId).toBe(first.webContentsId);
		expect(env.containers).toHaveLength(1);
		// A bare focus() is a no-op for a window sitting behind the dashboard;
		// the relaunch must raise it via show() too.
		expect(env.containers[0]?.window.show).toHaveBeenCalled();
		expect(env.containers[0]?.window.focus).toHaveBeenCalled();
	});

	it("restores a minimized container when its icon is clicked again", () => {
		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		env.containers[0]?.window.minimizeForTest();
		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		expect(env.containers[0]?.window.restore).toHaveBeenCalled();
		expect(env.containers[0]?.window.show).toHaveBeenCalled();
		expect(env.containers[0]?.window.focus).toHaveBeenCalled();
	});

	it("opens a new tab in the same container via addTabToContainer", () => {
		const first = env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		const containerId = first.container.id;
		const second = env.launcher.addTabToContainer(containerId, {
			...baseLaunch,
			bundleDir: env.bundleDir,
			launch: { reason: "open-entity", entityId: "ent_2" },
		});
		expect(env.containers).toHaveLength(1); // same OS window
		expect(env.tabViews).toHaveLength(2); // two renderers
		expect(second.webContentsId).not.toBe(first.webContentsId);
		expect(env.launcher.windowsFor("io.example.notes")).toHaveLength(2);
	});

	it("resolves the container owning a focused tab webContents (New Tab target)", () => {
		const win = env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		const hit = env.launcher.containerForTabSender(win.webContentsId);
		expect(hit?.container.id).toBe(win.container.id);
		expect(hit?.appId).toBe("io.example.notes");
		expect(env.launcher.containerForTabSender(999_999)).toBeNull();
	});

	it("opens a brand-new container via openInNewWindow", () => {
		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		env.launcher.openInNewWindow({
			...baseLaunch,
			bundleDir: env.bundleDir,
			launch: { reason: "open-entity", entityId: "ent_3" },
		});
		expect(env.containers).toHaveLength(2);
		expect(env.launcher.allContainers()).toHaveLength(2);
	});

	it("creates a separate container for a different windowId", () => {
		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir, windowId: "main" });
		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir, windowId: "inspector" });
		expect(env.containers).toHaveLength(2);
		expect(env.launcher.windowsFor("io.example.notes")).toHaveLength(2);
	});

	it("rejects launches for apps not installed — without creating a container", () => {
		expect(() =>
			env.launcher.launch({ ...baseLaunch, appId: "io.example.ghost", bundleDir: env.bundleDir }),
		).toThrow(/not installed/);
		expect(env.containers).toHaveLength(0);
	});

	it("rejects launches with a mismatched bundleDir — without creating a container", () => {
		expect(() => env.launcher.launch({ ...baseLaunch, bundleDir: "/wrong/place" })).toThrow(
			/bundleDir mismatch/,
		);
		expect(env.containers).toHaveLength(0);
	});

	it("parks (keeps warm) on user close — renderer alive + hidden + off the running set", () => {
		const window = env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		const base = env.containers[0]?.window;
		base?.close();
		expect(base?.isDestroyed()).toBe(false);
		expect(base?.hide).toHaveBeenCalled();
		expect(env.launcher.getExistingWindow("io.example.notes")?.parked).toBe(true);
		expect(env.identities.get(window.webContentsId)).toBe("io.example.notes");
		expect(env.launcher.runningAppIds()).toEqual([]);
	});

	it("re-launching a parked app shows the SAME renderer (no re-spawn)", () => {
		const first = env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		const base = env.containers[0]?.window;
		base?.close();
		expect(env.tabViews).toHaveLength(1);

		const second = env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		expect(second.webContentsId).toBe(first.webContentsId); // reused, not recreated
		expect(env.tabViews).toHaveLength(1);
		expect(second.parked).toBe(false);
		expect(base?.show).toHaveBeenCalled();
		expect(base?.focus).toHaveBeenCalled();
		expect(env.launcher.runningAppIds()).toEqual(["io.example.notes"]);
	});

	it("evicts the least-recently-parked container beyond the cap", async () => {
		const { containerFactory, tabViewFactory, containers } = fakeFactories();
		const launcher = new AppLauncher({
			mainDir: "/fake/main",
			appsRepo: env.appsRepo,
			identities: env.identities,
			containerFactory,
			tabViewFactory,
			maxParkedWindows: 2,
		});
		const w1 = launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir, windowId: "a" });
		launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir, windowId: "b" });
		launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir, windowId: "c" });
		containers[0]?.window.close(); // parked (LRU)
		containers[1]?.window.close();
		containers[2]?.window.close(); // over cap → evict w1 (least recent)
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(containers).toHaveLength(3);
		expect(containers[0]?.window.isDestroyed()).toBe(true);
		expect(env.identities.get(w1.webContentsId)).toBeUndefined();
		expect(containers[1]?.window.isDestroyed()).toBe(false);
		expect(containers[2]?.window.isDestroyed()).toBe(false);
	});

	it("closeApp tears down (never parks) every container for that app", () => {
		const w1 = env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir, windowId: "main" });
		const w2 = env.launcher.launch({
			...baseLaunch,
			bundleDir: env.bundleDir,
			windowId: "inspector",
		});
		env.launcher.closeApp("io.example.notes");
		expect(env.containers[0]?.window.isDestroyed()).toBe(true);
		expect(env.containers[1]?.window.isDestroyed()).toBe(true);
		expect(env.identities.get(w1.webContentsId)).toBeUndefined();
		expect(env.identities.get(w2.webContentsId)).toBeUndefined();
		expect(env.launcher.windowsFor("io.example.notes")).toEqual([]);
	});

	it("after prepareForQuit, close tears down (no parking) for a clean shutdown", () => {
		const window = env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		env.launcher.prepareForQuit();
		env.containers[0]?.window.close();
		expect(env.containers[0]?.window.isDestroyed()).toBe(true);
		expect(env.launcher.getExistingWindow("io.example.notes")).toBeNull();
		expect(env.identities.get(window.webContentsId)).toBeUndefined();
	});

	it("closing the last tab tears the container down", () => {
		const window = env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		window.container.closeTab(window.tabId);
		expect(env.containers[0]?.window.isDestroyed()).toBe(true);
		expect(env.identities.get(window.webContentsId)).toBeUndefined();
		expect(env.launcher.windowsFor("io.example.notes")).toEqual([]);
	});

	it("evictAllParked tears down warm-kept renderers (vault lock / close / switch)", () => {
		const window = env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		env.containers[0]?.window.close();
		expect(env.launcher.getExistingWindow("io.example.notes")?.parked).toBe(true);
		expect(env.containers[0]?.window.isDestroyed()).toBe(false);

		env.launcher.evictAllParked();
		expect(env.containers[0]?.window.isDestroyed()).toBe(true);
		expect(env.identities.get(window.webContentsId)).toBeUndefined();
		expect(env.launcher.windowsFor("io.example.notes")).toEqual([]);
	});

	it("leaves macOS fullscreen before hiding a parked window (no stranded black Space)", () => {
		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		const base = env.containers[0]?.window;
		base?.setFullScreen(true);
		base?.close();
		expect(base?.setFullScreen).toHaveBeenLastCalledWith(false);
		expect(base?.isFullScreen()).toBe(false);
		// hide happens only after the leave-full-screen transition completes
		// (the fake fires it synchronously from setFullScreen).
		expect(base?.hide).toHaveBeenCalled();
		expect(env.launcher.getExistingWindow("io.example.notes")?.parked).toBe(true);
	});

	it("reveals the dashboard after parking the last visible window", () => {
		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		env.containers[0]?.window.close();
		expect(env.revealDashboard).toHaveBeenCalledTimes(1);
	});

	it("does NOT reveal the dashboard while another app window stays visible", () => {
		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir, windowId: "a" });
		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir, windowId: "b" });
		env.containers[0]?.window.close();
		expect(env.revealDashboard).not.toHaveBeenCalled();
		env.containers[1]?.window.close();
		expect(env.revealDashboard).toHaveBeenCalledTimes(1);
	});

	it("reveals the dashboard when the last tab close tears down the only window", () => {
		const window = env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		window.container.closeTab(window.tabId);
		expect(env.containers[0]?.window.isDestroyed()).toBe(true);
		expect(env.revealDashboard).toHaveBeenCalledTimes(1);
	});

	it("does NOT reveal the dashboard for quit-path or parked-window teardown", () => {
		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir });
		env.containers[0]?.window.close(); // park — one reveal
		expect(env.revealDashboard).toHaveBeenCalledTimes(1);
		env.launcher.evictAllParked(); // parked teardown — no extra reveal
		expect(env.revealDashboard).toHaveBeenCalledTimes(1);

		env.launcher.launch({ ...baseLaunch, bundleDir: env.bundleDir, windowId: "q" });
		env.launcher.prepareForQuit();
		env.containers[1]?.window.close(); // quit path — never reveals
		expect(env.revealDashboard).toHaveBeenCalledTimes(1);
	});
});

describe("handshake encode/decode", () => {
	it("base64-round-trips a handshake including unicode", () => {
		const handshake: AppHandshake = {
			app: { id: "io.example.app", version: "1.0.0", sdkVersion: "1" },
			capabilities: ["storage.kv", "entities.read:io.example/Note/v1"],
			launch: { reason: "open-entity", entityId: "ent_β🌱" },
		};
		const decoded = decodeHandshake(encodeHandshake(handshake));
		expect(decoded).toEqual(handshake);
	});
});
