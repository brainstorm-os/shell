/**
 * sideload-handlers — the local (folder / `.brainstorm`) install surface
 * (AppForge-1) plus the vault (`CodeFile/v1`) install surface (AppForge-2).
 * The bundle is hostile input and the channels are privileged, so the tests
 * exercise both halves: the happy paths land a real install (registry row with
 * `local-file` provenance, pinned dashboard icon, unsigned signature surfaced)
 * and the hostile paths are refused with typed codes — bad/oversized/traversing
 * manifests, id collisions, garbage or traversing or bomb archives, oversized
 * files, and a non-dashboard sender.
 *
 * The AppForge-2 block additionally covers the new trust edge: vault strings
 * (`CodeFile.path`) becoming filesystem paths. Ids are the ONLY renderer
 * input, so a spoofed type, a traversing/absolute/duplicate path, a missing
 * manifest and an oversized selection each fail closed with their own code.
 *
 * Electron is mocked; everything below the IPC layer (DataStores,
 * EntitiesRepository, CapabilityLedger, DashboardStore, AppInstaller, the
 * `.brainstorm` codec) is real — mirrors `apps-handlers.test.ts`.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import { EntitiesRepository } from "../storage/entities-repo";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import { YDocStore } from "../storage/ydoc-store";
import {
	APPS_INSTALL_FROM_FILE_CHANNEL,
	APPS_INSTALL_FROM_FOLDER_CHANNEL,
	APPS_INSTALL_FROM_VAULT_CHANNEL,
	APPS_LIST_VAULT_APP_SOURCES_CHANNEL,
	SideloadFailureCode,
	type SideloadHandlersOptions,
	type SideloadInstallResult,
	SideloadInstallStatus,
	type VaultAppSourcesResult,
	registerSideloadHandlers,
	sanitizeVaultRelPath,
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

const invokeAsDashboard = (channel: string, ...args: unknown[]): Promise<SideloadInstallResult> =>
	handlers.get(channel)?.(
		{ sender: dashboardWindow.webContents },
		...args,
	) as Promise<SideloadInstallResult>;

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

describe("apps:install-from-vault (AppForge-2)", () => {
	const CODE_FILE_TYPE = "brainstorm/CodeFile/v1";
	let entities: EntitiesRepository;
	let nextId = 0;

	const seedCodeFile = (path: string, content: string, type = CODE_FILE_TYPE): string => {
		const id = `codefile${++nextId}`;
		entities.create({
			id,
			type,
			properties: { path, content },
			createdBy: "io.brainstorm.code-editor",
			now: 1_000 + nextId,
			dekId: null,
		});
		return id;
	};

	const listSources = (): Promise<VaultAppSourcesResult> =>
		handlers.get(APPS_LIST_VAULT_APP_SOURCES_CHANNEL)?.({
			sender: dashboardWindow.webContents,
		}) as Promise<VaultAppSourcesResult>;

	beforeEach(async () => {
		entities = new EntitiesRepository(await stores.open("entities"));
		nextId = 0;
	});

	it("installs a two-file app written in the vault, leaving the source entities untouched", async () => {
		const manifestJson = JSON.stringify(baseManifest, null, 2);
		const html = "<!doctype html><title>from the vault</title>";
		const manifestId = seedCodeFile("my-app/manifest.json", manifestJson);
		const entryId = seedCodeFile("my-app/index.html", html);
		register();

		const before = (await readdir(tmpdir())).filter((d) => d.startsWith("brainstorm-vault-app-"));
		const result = await invokeAsDashboard(APPS_INSTALL_FROM_VAULT_CHANNEL, [manifestId, entryId]);
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

		// The root prefix is stripped: manifest.json + index.html sit at the
		// installed bundle root, byte-identical to the vault sources.
		const installedDir = row?.bundleDir ?? "";
		expect(await readFile(join(installedDir, "index.html"), "utf8")).toBe(html);
		expect(JSON.parse(await readFile(join(installedDir, "manifest.json"), "utf8")).id).toBe(APP_ID);

		// The Code editor can re-open its sources unchanged — the install reads,
		// it never rewrites the entities.
		expect(entities.get(entryId)?.properties).toMatchObject({
			path: "my-app/index.html",
			content: html,
		});
		expect(entities.get(manifestId)?.properties.content).toBe(manifestJson);

		const icons = Object.values(dashboardStore.snapshot().icons);
		expect(icons.some((icon) => icon.kind === "app" && icon.target === APP_ID)).toBe(true);

		// Staging dir removed in the `finally`.
		const after = (await readdir(tmpdir())).filter((d) => d.startsWith("brainstorm-vault-app-"));
		expect(after.length).toBeLessThanOrEqual(before.length);
	});

	it("refuses an id whose entity is a different type (type spoof)", async () => {
		const manifestId = seedCodeFile("app/manifest.json", JSON.stringify(baseManifest));
		const noteId = seedCodeFile("app/note.md", "# not code", "brainstorm/Note/v1");
		register();
		expect(
			await invokeAsDashboard(APPS_INSTALL_FROM_VAULT_CHANNEL, [manifestId, noteId]),
		).toMatchObject({ status: SideloadInstallStatus.Failed, code: SideloadFailureCode.NotCodeFiles });
		// …and an id that isn't in the vault at all.
		expect(
			await invokeAsDashboard(APPS_INSTALL_FROM_VAULT_CHANNEL, [manifestId, "ghostentity"]),
		).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.NotCodeFiles,
		});
	});

	it("refuses traversing, absolute, backslash and empty vault paths", async () => {
		register();
		for (const path of [
			"../../etc/passwd",
			"/etc/passwd",
			"app/../../escape.js",
			"C:\\windows\\system32\\evil.js",
			"app//double.js",
			"app/./same.js",
			"",
		]) {
			const manifestId = seedCodeFile("app/manifest.json", JSON.stringify(baseManifest));
			const hostileId = seedCodeFile(path, "boom");
			expect(
				await invokeAsDashboard(APPS_INSTALL_FROM_VAULT_CHANNEL, [manifestId, hostileId]),
			).toMatchObject({ status: SideloadInstallStatus.Failed, code: SideloadFailureCode.BadPath });
			entities.hardDelete(manifestId);
			entities.hardDelete(hostileId);
		}
		// Nothing escaped into the temp root.
		expect((await readdir(tmpdir())).includes("escape.js")).toBe(false);
	});

	it("refuses duplicate paths (case-insensitively) and duplicate ids", async () => {
		const manifestId = seedCodeFile("app/manifest.json", JSON.stringify(baseManifest));
		const aId = seedCodeFile("app/index.html", "first");
		const bId = seedCodeFile("app/Index.HTML", "second");
		register();
		expect(
			await invokeAsDashboard(APPS_INSTALL_FROM_VAULT_CHANNEL, [manifestId, aId, bId]),
		).toMatchObject({ status: SideloadInstallStatus.Failed, code: SideloadFailureCode.BadPath });
		expect(
			await invokeAsDashboard(APPS_INSTALL_FROM_VAULT_CHANNEL, [manifestId, aId, aId]),
		).toMatchObject({ status: SideloadInstallStatus.Failed, code: SideloadFailureCode.BadRequest });
	});

	it("refuses a file outside the app root and a selection with two root manifests", async () => {
		const manifestId = seedCodeFile("app/manifest.json", JSON.stringify(baseManifest));
		const strayId = seedCodeFile("elsewhere/lib.js", "export const x = 1;");
		register();
		expect(
			await invokeAsDashboard(APPS_INSTALL_FROM_VAULT_CHANNEL, [manifestId, strayId]),
		).toMatchObject({ status: SideloadInstallStatus.Failed, code: SideloadFailureCode.BadPath });

		const otherManifestId = seedCodeFile("other/manifest.json", JSON.stringify(baseManifest));
		expect(
			await invokeAsDashboard(APPS_INSTALL_FROM_VAULT_CHANNEL, [manifestId, otherManifestId]),
		).toMatchObject({ status: SideloadInstallStatus.Failed, code: SideloadFailureCode.NoManifest });
	});

	it("refuses a selection with no manifest.json and an invalid manifest", async () => {
		const onlyEntry = seedCodeFile("app/index.html", "<!doctype html>");
		register();
		expect(await invokeAsDashboard(APPS_INSTALL_FROM_VAULT_CHANNEL, [onlyEntry])).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.NoManifest,
		});

		const badManifestId = seedCodeFile("app2/manifest.json", "{not json");
		expect(await invokeAsDashboard(APPS_INSTALL_FROM_VAULT_CHANNEL, [badManifestId])).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.BadManifest,
		});
	});

	it("refuses an oversized file and an oversized selection", async () => {
		const manifestId = seedCodeFile("app/manifest.json", JSON.stringify(baseManifest));
		const bigId = seedCodeFile("app/big.js", "x".repeat(4096));
		register({ maxVaultFileBytes: 1024 });
		expect(
			await invokeAsDashboard(APPS_INSTALL_FROM_VAULT_CHANNEL, [manifestId, bigId]),
		).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.SourceTooLarge,
		});

		handlers.clear();
		register({ maxVaultTotalBytes: 1024 });
		expect(
			await invokeAsDashboard(APPS_INSTALL_FROM_VAULT_CHANNEL, [manifestId, bigId]),
		).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.SourceTooLarge,
		});
	});

	it("refuses a malformed request and fails closed for a non-dashboard sender / no vault", async () => {
		register();
		for (const payload of [undefined, "not-an-array", [], [42], ["../evil"], ["a".repeat(200)]]) {
			expect(await invokeAsDashboard(APPS_INSTALL_FROM_VAULT_CHANNEL, payload)).toMatchObject({
				status: SideloadInstallStatus.Failed,
				code: SideloadFailureCode.BadRequest,
			});
		}

		const foreign = handlers.get(APPS_INSTALL_FROM_VAULT_CHANNEL)?.({ sender: { id: 999 } }, [
			"codefile1",
		]) as Promise<SideloadInstallResult>;
		expect(await foreign).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.NotAllowed,
		});

		activeSession = null;
		expect(await invokeAsDashboard(APPS_INSTALL_FROM_VAULT_CHANNEL, ["codefile1"])).toMatchObject({
			status: SideloadInstallStatus.Failed,
			code: SideloadFailureCode.NoVaultSession,
		});
	});

	it("lists vault app candidates with parsed manifests, and refuses a foreign sender", async () => {
		seedCodeFile("my-app/manifest.json", JSON.stringify(baseManifest));
		seedCodeFile("my-app/index.html", "<!doctype html>");
		seedCodeFile("broken/manifest.json", "{not json");
		seedCodeFile("loose/notes.txt", "no manifest here");
		seedCodeFile("../hostile/manifest.json", JSON.stringify(baseManifest));
		register();

		const listed = await listSources();
		expect(listed.ok).toBe(true);
		if (!listed.ok) return;
		// The traversing candidate is dropped by the sanitizer, the two valid
		// roots survive.
		expect(listed.sources.map((s) => s.rootDir).sort()).toEqual(["broken", "my-app"]);
		const app = listed.sources.find((s) => s.rootDir === "my-app");
		expect(app?.manifest).toMatchObject({ id: APP_ID, name: "Sideloaded", version: "1.0.0" });
		expect(app?.manifest?.capabilities).toEqual(["entities.read:io.example/Note/v1"]);
		expect(app?.fileCount).toBe(2);
		expect(app?.problem).toBeNull();
		const broken = listed.sources.find((s) => s.rootDir === "broken");
		expect(broken?.manifest).toBeNull();
		expect(broken?.problem).toContain("not valid JSON");

		// The listed ids install as-is.
		const installed = await invokeAsDashboard(APPS_INSTALL_FROM_VAULT_CHANNEL, app?.fileIds ?? []);
		expect(installed.status).toBe(SideloadInstallStatus.Installed);

		const foreign = (await handlers.get(APPS_LIST_VAULT_APP_SOURCES_CHANNEL)?.({
			sender: { id: 999 },
		})) as VaultAppSourcesResult;
		expect(foreign).toMatchObject({ ok: false, code: SideloadFailureCode.NotAllowed });
	});
});

describe("sanitizeVaultRelPath", () => {
	it("accepts plain relative paths and rejects every escape shape", () => {
		expect(sanitizeVaultRelPath("index.html")).toEqual({ ok: true, path: "index.html" });
		expect(sanitizeVaultRelPath("src/ui/app.tsx")).toEqual({ ok: true, path: "src/ui/app.tsx" });
		for (const bad of [
			undefined,
			null,
			42,
			"",
			"/abs.js",
			"C:/win.js",
			"c:\\win.js",
			"../up.js",
			"a/../../up.js",
			"a/./b.js",
			"a//b.js",
			"a\\b.js",
			"nul\u0000.js",
			"line\nbreak.js",
			"x".repeat(600),
			`${"deep/".repeat(20)}file.js`,
		]) {
			expect(sanitizeVaultRelPath(bad)).toMatchObject({ ok: false });
		}
	});
});
