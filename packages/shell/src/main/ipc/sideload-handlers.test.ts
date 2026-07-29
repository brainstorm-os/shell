/**
 * sideload-handlers — the local (folder / `.brainstorm`) install surface
 * (AppForge-1). The bundle is hostile input and the channel is privileged, so
 * the tests exercise both halves: the happy paths land a real install
 * (registry row with `local-file` provenance, pinned dashboard icon, unsigned
 * signature surfaced) and the hostile paths are refused with typed codes —
 * bad/oversized/traversing manifests, id collisions, garbage or traversing or
 * bomb archives, oversized files, and a non-dashboard sender.
 *
 * Electron is mocked; everything below the IPC layer (DataStores,
 * CapabilityLedger, DashboardStore, AppInstaller, the `.brainstorm` codec) is
 * real — mirrors `apps-handlers.test.ts`.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
import { AppSignatureStatus } from "../apps/app-signature";
import { InstallOrigin } from "../apps/install-provenance";
import type { AppManifest } from "../apps/manifest";
import { packBrainstormBundle } from "../catalog/brainstorm-package";
import { DashboardStore } from "../dashboard/dashboard-store";
import { DataStores } from "../storage/data-stores";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import { YDocStore } from "../storage/ydoc-store";
import {
	APPS_INSTALL_FROM_FILE_CHANNEL,
	APPS_INSTALL_FROM_FOLDER_CHANNEL,
	SideloadFailureCode,
	type SideloadHandlersOptions,
	type SideloadInstallResult,
	SideloadInstallStatus,
	registerSideloadHandlers,
} from "./sideload-handlers";

const APP_ID = "io.example.sideloaded";

const baseManifest: AppManifest = {
	id: APP_ID,
	name: "Sideloaded",
	version: "1.0.0",
	sdk: "1",
	entry: "index.html",
	capabilities: ["entities.read:io.example/Note/v1"],
};

let vaultDir: string;
let sourceDir: string;
let stores: DataStores;
let yStore: YDocStore;
let dashboardStore: DashboardStore;
let dashboardWindow: BrowserWindow;
let dialogResult: { canceled: boolean; filePaths: string[] };

const invokeAsDashboard = (channel: string): Promise<SideloadInstallResult> =>
	handlers.get(channel)?.({ sender: dashboardWindow.webContents }) as Promise<SideloadInstallResult>;

async function writeBundle(dir: string, manifest: unknown, files: Record<string, string> = {}) {
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "manifest.json"),
		typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2),
		"utf8",
	);
	for (const [path, contents] of Object.entries(files)) {
		const abs = join(dir, path);
		await mkdir(join(abs, ".."), { recursive: true });
		await writeFile(abs, contents, "utf8");
	}
}

function register(overrides: Partial<SideloadHandlersOptions> = {}): void {
	registerSideloadHandlers({
		getDashboard: () => dashboardWindow,
		showOpenDialog: async () => dialogResult,
		...overrides,
	});
}

beforeEach(async () => {
	handlers.clear();
	vaultDir = await mkdtemp(join(tmpdir(), "bs-sideload-vault-"));
	sourceDir = await mkdtemp(join(tmpdir(), "bs-sideload-src-"));
	stores = new DataStores(vaultDir);
	yStore = new YDocStore(vaultDir);
	dashboardStore = await DashboardStore.open(yStore);
	dashboardWindow = {
		isDestroyed: () => false,
		webContents: { id: 7 },
	} as unknown as BrowserWindow;
	dialogResult = { canceled: true, filePaths: [] };
	activeSession = {
		vaultPath: vaultDir,
		dataStores: stores,
		capabilityLedger: async () => new CapabilityLedger(await stores.open("ledger")),
		dashboardStore: async () => dashboardStore,
	};
});

afterEach(async () => {
	await dashboardStore.flush().catch(() => undefined);
	await dashboardStore.close().catch(() => undefined);
	stores.close();
	await rm(vaultDir, { recursive: true, force: true });
	await rm(sourceDir, { recursive: true, force: true });
});

describe("apps:install-from-folder", () => {
	it("installs a two-file bundle: registry row with local-file provenance, pinned icon, unsigned surfaced", async () => {
		await writeBundle(sourceDir, baseManifest, { "index.html": "<!doctype html>" });
		dialogResult = { canceled: false, filePaths: [sourceDir] };
		register();

		const result = await invokeAsDashboard(APPS_INSTALL_FROM_FOLDER_CHANNEL);
		expect(result.status).toBe(SideloadInstallStatus.Installed);
		if (result.status !== SideloadInstallStatus.Installed) return;
		expect(result.app).toMatchObject({
			id: APP_ID,
			name: "Sideloaded",
			version: "1.0.0",
			signatureStatus: AppSignatureStatus.Unsigned,
		});
		expect(result.grantedCapabilities).toContain("entities.read:io.example/Note/v1");

		const repo = new AppsRepository(await stores.open("registry"));
		const row = repo.getActive(APP_ID);
		expect(row?.origin).toBe(InstallOrigin.LocalFile);
		expect(row?.catalogId).toBeNull();
		expect(row?.signatureStatus).toBe(AppSignatureStatus.Unsigned);

		const icons = Object.values(dashboardStore.snapshot().icons);
		expect(icons.some((icon) => icon.kind === "app" && icon.target === APP_ID)).toBe(true);
	});

	it("returns Cancelled when the dialog is dismissed", async () => {
		dialogResult = { canceled: true, filePaths: [] };
		register();
		const result = await invokeAsDashboard(APPS_INSTALL_FROM_FOLDER_CHANNEL);
		expect(result).toEqual({ status: SideloadInstallStatus.Cancelled });
	});

	it("refuses a manifest whose entry path traverses out of the bundle", async () => {
		await writeBundle(sourceDir, { ...baseManifest, entry: "../../outside/index.html" });
		dialogResult = { canceled: false, filePaths: [sourceDir] };
		register();
		const result = await invokeAsDashboard(APPS_INSTALL_FROM_FOLDER_CHANNEL);
		expect(result).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.BadManifest,
		});
	});

	it("refuses a malformed app id and unparseable JSON", async () => {
		await writeBundle(sourceDir, { ...baseManifest, id: "../evil" });
		dialogResult = { canceled: false, filePaths: [sourceDir] };
		register();
		const badId = await invokeAsDashboard(APPS_INSTALL_FROM_FOLDER_CHANNEL);
		expect(badId).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.BadManifest,
		});

		await writeBundle(sourceDir, "{not json");
		const badJson = await invokeAsDashboard(APPS_INSTALL_FROM_FOLDER_CHANNEL);
		expect(badJson).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.BadManifest,
		});
	});

	it("refuses an oversized manifest before parsing it", async () => {
		const huge = JSON.stringify({ ...baseManifest, padding: "x".repeat(600 * 1024) });
		await writeBundle(sourceDir, huge);
		dialogResult = { canceled: false, filePaths: [sourceDir] };
		register();
		const result = await invokeAsDashboard(APPS_INSTALL_FROM_FOLDER_CHANNEL);
		expect(result).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.BadManifest,
		});
	});

	it("refuses an id collision with an already-installed app", async () => {
		await writeBundle(sourceDir, baseManifest, { "index.html": "<!doctype html>" });
		dialogResult = { canceled: false, filePaths: [sourceDir] };
		register();
		const first = await invokeAsDashboard(APPS_INSTALL_FROM_FOLDER_CHANNEL);
		expect(first.status).toBe(SideloadInstallStatus.Installed);

		const second = await invokeAsDashboard(APPS_INSTALL_FROM_FOLDER_CHANNEL);
		expect(second).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.AlreadyInstalled,
		});
	});

	it("fails closed for a non-dashboard sender and with no vault session", async () => {
		register();
		const foreign = handlers.get(APPS_INSTALL_FROM_FOLDER_CHANNEL)?.({
			sender: { id: 999 },
		}) as Promise<SideloadInstallResult>;
		expect(await foreign).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.NotAllowed,
		});

		activeSession = null;
		expect(await invokeAsDashboard(APPS_INSTALL_FROM_FOLDER_CHANNEL)).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.NoVaultSession,
		});
	});
});

describe("apps:install-from-file", () => {
	async function writeArchive(files: Record<string, string>): Promise<string> {
		const map = new Map<string, Uint8Array>(
			Object.entries(files).map(([path, text]) => [path, new TextEncoder().encode(text)]),
		);
		const bytes = packBrainstormBundle(map);
		const filePath = join(sourceDir, "app.brainstorm");
		await writeFile(filePath, bytes);
		return filePath;
	}

	it("round-trips a packed bundle: pack → pick → unpack → install, staging dir cleaned up", async () => {
		const filePath = await writeArchive({
			"manifest.json": JSON.stringify(baseManifest),
			"index.html": "<!doctype html>",
		});
		dialogResult = { canceled: false, filePaths: [filePath] };
		register();

		const before = (await readdir(tmpdir())).filter((d) => d.startsWith("brainstorm-sideload-"));
		const result = await invokeAsDashboard(APPS_INSTALL_FROM_FILE_CHANNEL);
		expect(result.status).toBe(SideloadInstallStatus.Installed);
		if (result.status !== SideloadInstallStatus.Installed) return;
		expect(result.app.signatureStatus).toBe(AppSignatureStatus.Unsigned);

		const repo = new AppsRepository(await stores.open("registry"));
		expect(repo.getActive(APP_ID)?.origin).toBe(InstallOrigin.LocalFile);

		// The staging dir is removed in the `finally` — no new leftovers.
		const after = (await readdir(tmpdir())).filter((d) => d.startsWith("brainstorm-sideload-"));
		expect(after.length).toBeLessThanOrEqual(before.length);
	});

	it("refuses garbage bytes as BadArchive", async () => {
		const filePath = join(sourceDir, "junk.brainstorm");
		await writeFile(filePath, Buffer.from("definitely not a bundle"));
		dialogResult = { canceled: false, filePaths: [filePath] };
		register();
		expect(await invokeAsDashboard(APPS_INSTALL_FROM_FILE_CHANNEL)).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.BadArchive,
		});
	});

	it("refuses an archive with a path-traversal entry (zip-slip)", async () => {
		const filePath = await writeArchive({
			"manifest.json": JSON.stringify(baseManifest),
			"../evil.txt": "escape",
		});
		dialogResult = { canceled: false, filePaths: [filePath] };
		register();
		const result = await invokeAsDashboard(APPS_INSTALL_FROM_FILE_CHANNEL);
		expect(result).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.BadArchive,
		});
		// And nothing escaped next to the staging dirs.
		const leaked = (await readdir(tmpdir())).some((d) => d === "evil.txt");
		expect(leaked).toBe(false);
	});

	it("refuses an over-limit file before reading it", async () => {
		const filePath = await writeArchive({
			"manifest.json": JSON.stringify(baseManifest),
			"index.html": "<!doctype html>",
		});
		dialogResult = { canceled: false, filePaths: [filePath] };
		register({ maxArchiveBytes: 16 });
		expect(await invokeAsDashboard(APPS_INSTALL_FROM_FILE_CHANNEL)).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.ArchiveTooLarge,
		});
	});

	it("refuses a decompression bomb via the unpack expansion bound", async () => {
		const filePath = await writeArchive({
			"manifest.json": JSON.stringify(baseManifest),
			// 256 KiB of zeros gzips to ~300 bytes — tiny file, big expansion.
			"index.html": "\0".repeat(256 * 1024),
		});
		dialogResult = { canceled: false, filePaths: [filePath] };
		register({ maxUnpackedBytes: 4 * 1024 });
		expect(await invokeAsDashboard(APPS_INSTALL_FROM_FILE_CHANNEL)).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.BadArchive,
		});
	});

	it("returns Cancelled when the file dialog is dismissed", async () => {
		dialogResult = { canceled: true, filePaths: [] };
		register();
		expect(await invokeAsDashboard(APPS_INSTALL_FROM_FILE_CHANNEL)).toEqual({
			status: SideloadInstallStatus.Cancelled,
		});
	});
});
