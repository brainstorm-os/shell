/**
 * apps-handlers — the `apps:uninstall` ↔ dashboard contract. Uninstalling an
 * app must remove its pinned dashboard icons AND push the fresh snapshot to
 * the dashboard renderer — without the push the tile lingers as a zombie
 * until a manual reload (the github-issues uninstall bug). Electron is
 * mocked; the handlers run against real DataStores / CapabilityLedger /
 * DashboardStore instances.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: IpcHandler) => {
			handlers.set(channel, fn);
		},
	},
	app: {},
	dialog: {},
	nativeImage: {},
	nativeTheme: {},
}));

let activeSession: unknown;
vi.mock("../vault/session", () => ({
	getActiveVaultSession: () => activeSession,
}));

import { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import type { BrowserWindow } from "electron";
import { AppInstaller } from "../apps/installer";
import type { AppManifest } from "../apps/manifest";
import { DashboardStore } from "../dashboard/dashboard-store";
import { DataStores } from "../storage/data-stores";
import { YDocStore } from "../storage/ydoc-store";
import { type UninstallSummary, registerAppsHandlers } from "./apps-handlers";
import {
	DASHBOARD_SNAPSHOT_CHANNEL,
	type EnrichedDashboardSnapshot,
	registerDashboardHandlers,
} from "./dashboard-handlers";

const APP_ID = "io.example.notes";

const manifest: AppManifest = {
	id: APP_ID,
	name: "Notes",
	version: "1.0.0",
	sdk: "1",
	entry: "dist/index.html",
	capabilities: [],
};

const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);

let vaultDir: string;
let sourceDir: string;
let stores: DataStores;
let yStore: YDocStore;
let dashboardStore: DashboardStore;
/** Every dashboard store opened during a test — drained + closed in afterEach
 *  before the vault dir is removed, so a pending debounced ydoc persist can't
 *  fire after teardown (unhandled ENOENT on dashboard-rebuilt.ydoc). */
const openDashStores: DashboardStore[] = [];
let sends: Array<{ channel: string; payload: EnrichedDashboardSnapshot }>;
let dashboardWindow: BrowserWindow;

function makeSession(dashboard: DashboardStore): unknown {
	return {
		vaultPath: vaultDir,
		dataStores: stores,
		capabilityLedger: async () => new CapabilityLedger(await stores.open("ledger")),
		dashboardStore: async () => dashboard,
	};
}

const flushPushes = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
	handlers.clear();
	vaultDir = await mkdtemp(join(tmpdir(), "bs-apps-ipc-"));
	sourceDir = await mkdtemp(join(tmpdir(), "bs-apps-src-"));
	await mkdir(join(sourceDir, "dist"), { recursive: true });
	await writeFile(join(sourceDir, "manifest.json"), JSON.stringify(manifest), "utf8");
	await writeFile(join(sourceDir, "dist", "index.html"), "<!doctype html>", "utf8");

	stores = new DataStores(vaultDir);
	yStore = new YDocStore(vaultDir);
	dashboardStore = await DashboardStore.open(yStore);
	openDashStores.push(dashboardStore);
	activeSession = makeSession(dashboardStore);

	const registry = await stores.open("registry");
	const ledger = new CapabilityLedger(await stores.open("ledger"));
	const installer = new AppInstaller(vaultDir, registry, ledger);
	const installed = await installer.install({ bundleDir: sourceDir });
	if (!installed.ok) throw new Error(`install failed: ${installed.reason}`);

	sends = [];
	dashboardWindow = {
		isDestroyed: () => false,
		setBackgroundColor: () => {},
		webContents: {
			isDestroyed: () => false,
			send: (channel: string, payload: EnrichedDashboardSnapshot) => {
				sends.push({ channel, payload });
			},
		},
	} as unknown as BrowserWindow;

	registerDashboardHandlers(() => dashboardWindow);
	registerAppsHandlers({
		getOrchestrator: async () => null,
		getLauncherSync: () => null,
		onSessionRebuilt: () => () => {},
		getDashboard: () => dashboardWindow,
		closeAppWindows: () => {},
	});
});

afterEach(async () => {
	for (const ds of openDashStores) {
		await ds.flush().catch(() => undefined);
		await ds.close().catch(() => undefined);
	}
	openDashStores.length = 0;
	stores.close();
	await rm(vaultDir, { recursive: true, force: true });
	await rm(sourceDir, { recursive: true, force: true });
});

const hasAppIcon = (snap: EnrichedDashboardSnapshot) =>
	Object.values(snap.icons).some((icon) => icon.kind === "app" && icon.target === APP_ID);

describe("apps:uninstall × dashboard snapshot push", () => {
	it("removes the app's pinned icons and pushes the fresh snapshot to the renderer", async () => {
		dashboardStore.upsertIcon("icon-notes", {
			x: 0,
			y: 0,
			kind: "app",
			target: APP_ID,
			label: "Notes",
		});
		// Renderer mount: fetch once, which also wires the push subscription.
		await invoke("dashboard:snapshot");
		await flushPushes();
		sends.length = 0;

		const summary = (await invoke("apps:uninstall", APP_ID)) as UninstallSummary;
		expect(summary.ok).toBe(true);

		// Doc truth: the icon is gone from the store.
		expect(Object.keys(dashboardStore.snapshot().icons)).toEqual([]);

		// Live push: the renderer received a snapshot without the icon — no
		// manual reload needed.
		await vi.waitFor(() => {
			const last = sends.at(-1);
			expect(last?.channel).toBe(DASHBOARD_SNAPSHOT_CHANNEL);
			expect(hasAppIcon(last?.payload as EnrichedDashboardSnapshot)).toBe(false);
		});
	});

	it("pushes the active store's snapshot even when the subscription points at a previous session's store (zombie-icon repro)", async () => {
		// Renderer subscribed against the boot session's store…
		await invoke("dashboard:snapshot");
		await flushPushes();

		// …then the session is rebuilt with a NEW dashboard store the renderer
		// never re-fetched against. The app icon (and a marker icon proving
		// which store a push reflects) live only in the new store.
		const rebuiltStore = await DashboardStore.open(yStore, { docId: "dashboard-rebuilt" });
		openDashStores.push(rebuiltStore);
		rebuiltStore.upsertIcon("icon-notes", {
			x: 0,
			y: 0,
			kind: "app",
			target: APP_ID,
			label: "Notes",
		});
		rebuiltStore.upsertIcon("icon-keep", {
			x: 1,
			y: 0,
			kind: "app",
			target: "io.example.keep",
			label: "Keep",
		});
		activeSession = makeSession(rebuiltStore);
		await flushPushes();
		sends.length = 0;

		const summary = (await invoke("apps:uninstall", APP_ID)) as UninstallSummary;
		expect(summary.ok).toBe(true);

		await vi.waitFor(() => {
			const last = sends.at(-1);
			expect(last?.channel).toBe(DASHBOARD_SNAPSHOT_CHANNEL);
			const payload = last?.payload as EnrichedDashboardSnapshot;
			// The push reflects the ACTIVE store (marker present, uninstalled
			// app's icon gone) — not the stale one the subscription started on.
			expect(Object.keys(payload.icons)).toEqual(["icon-keep"]);
		});
	});
});
