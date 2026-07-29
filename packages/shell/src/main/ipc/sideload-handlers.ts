/**
 * `apps:install-from-*` IPC handlers — install an app from a local folder or a
 * `.brainstorm` archive picked via the OS file dialog (AppForge-1, doc 49), or
 * from `CodeFile/v1` entities written inside the vault (AppForge-2).
 *
 * This is the first renderer-reachable producer of the sideload install path
 * (`InstallOrigin.LocalFile`). Trust posture:
 *   - The install is a **privileged shell action behind a user gesture**: only
 *     the dashboard renderer may invoke it (sender-checked against the
 *     dashboard WebContents — app renderers are rejected fail-closed, on top
 *     of the preload boundary that never exposes these channels to apps), and
 *     the bundle only ever comes from an OS dialog the user drove or from
 *     vault entities the user picked in the shell's own chrome.
 *   - The chosen bytes are **hostile input**: the manifest is validated by the
 *     installer's fail-closed validator (re-run here first so failures map to
 *     typed codes), archives are size-bounded before unpack, decompression is
 *     expansion-bounded, and the tar unpacker + `unpackBrainstormBundleToDir`
 *     both reject traversal out of the staging dir.
 *   - The vault-install path takes **entity ids only** from the renderer —
 *     never paths or content. Type, `path`, and source text are all resolved
 *     server-side from the entity row (resolve-the-type-server-side rule), and
 *     the `path` property is the first time a vault string becomes a
 *     filesystem path, so it goes through `sanitizeVaultRelPath` fail-closed
 *     (no absolute / drive / `..` / `.` / backslash / control chars / dups)
 *     with count + per-file + total byte bounds before anything touches disk.
 *   - Unsigned bundles install with `AppSignatureStatus.Unsigned` recorded —
 *     advisory in v1 (same policy as every install path; `shouldBlockInstall`
 *     stays the single enforcement chokepoint) and surfaced in the result +
 *     marketplace listing so the UI can say so honestly.
 *
 * Results are always typed (`SideloadInstallResult`) — a handler never throws
 * raw errors into the renderer's `invoke` rejection path.
 */

import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import { type BrowserWindow, type IpcMainInvokeEvent, dialog, ipcMain } from "electron";
import type { AppSignatureStatus } from "../apps/app-signature";
import { InstallOrigin, type InstallProvenance } from "../apps/install-provenance";
import { AppInstaller } from "../apps/installer";
import { validateManifest } from "../apps/manifest";
import { unpackBrainstormBundleToDir } from "../catalog/brainstorm-package";
import { placeDashboardIcon } from "../dev/seed-demo-apps";
import { getActiveShortcutRegistry } from "../shortcuts/active-registry";
import { EntitiesRepository } from "../storage/entities-repo";
import { isSafeEntityId } from "../storage/entity-id";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import { getActiveVaultSession } from "../vault/session";

export const APPS_INSTALL_FROM_FOLDER_CHANNEL = "apps:install-from-folder" as const;
export const APPS_INSTALL_FROM_FILE_CHANNEL = "apps:install-from-file" as const;
export const APPS_LIST_VAULT_APP_SOURCES_CHANNEL = "apps:list-vault-app-sources" as const;
export const APPS_INSTALL_FROM_VAULT_CHANNEL = "apps:install-from-vault" as const;

/** Canonical `CodeFile/v1` entity-type id — the Code editor's contract
 *  (`apps/code-editor/src/runtime.ts`). Source text lives in the property bag
 *  (`properties.content`, `properties.body` legacy fallback) per the v1
 *  CodeFile contract; `properties.path` is the vault-relative file path. */
const CODE_FILE_ENTITY_TYPE = "brainstorm/CodeFile/v1";
const MANIFEST_FILENAME = "manifest.json";

/** A hostile manifest.json could be gigabytes; bound the read before parsing.
 *  Real manifests are a few KiB — 512 KiB is ~100× headroom. */
const MAX_MANIFEST_BYTES = 512 * 1024;
/** Cap on the `.brainstorm` file itself (compressed). First-party bundles are
 *  single-digit MiB; 64 MiB is generous for any real app. */
const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** Cap on the decompressed content — bounds a gzip bomb independently of the
 *  on-disk file size. */
const DEFAULT_MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
/** Bounds for the vault (CodeFile) install path. A hand-written app is tens of
 *  files / tens of KiB; these are generous ceilings, not targets. */
const MAX_VAULT_FILE_COUNT = 256;
/** Bound on the candidate scan so a vault with thousands of code files can't
 *  pull them all into the main process to build the picker. */
const MAX_VAULT_SCAN_ROWS = 4096;
const MAX_VAULT_PATH_CHARS = 512;
const MAX_VAULT_PATH_SEGMENTS = 16;
const DEFAULT_MAX_VAULT_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_VAULT_TOTAL_BYTES = 32 * 1024 * 1024;
/** Vault paths surface in failure reasons — keep them readable, not a DoS. */
const REASON_PATH_CHARS = 120;

export enum SideloadInstallStatus {
	Installed = "installed",
	Cancelled = "cancelled",
	Failed = "failed",
}

export enum SideloadFailureCode {
	/** Caller is not the privileged dashboard renderer. */
	NotAllowed = "not-allowed",
	NoVaultSession = "no-vault-session",
	/** manifest.json missing / unparseable / rejected by the validator. */
	BadManifest = "bad-manifest",
	/** An active install with the same app id already exists. */
	AlreadyInstalled = "already-installed",
	/** `.brainstorm` bytes rejected (bad magic/codec, traversal entry, bomb). */
	BadArchive = "bad-archive",
	/** `.brainstorm` file exceeds the size bound. */
	ArchiveTooLarge = "archive-too-large",
	/** `AppInstaller.install` reported a failure past the pre-checks. */
	InstallFailed = "install-failed",
	/** Vault-install request was malformed (not an id list / too many / dup ids). */
	BadRequest = "bad-request",
	/** A selected id is missing from the vault or is not a `CodeFile/v1`. */
	NotCodeFiles = "not-code-files",
	/** A CodeFile `path` failed the fail-closed relative-path rules. */
	BadPath = "bad-path",
	/** The selection has no (or no unambiguous) root `manifest.json`. */
	NoManifest = "no-manifest",
	/** A file (or the whole selection) exceeds the source-size bounds. */
	SourceTooLarge = "source-too-large",
}

export type SideloadInstalledApp = {
	id: string;
	name: string;
	version: string;
	/** Advisory manifest-signature outcome — `unsigned` for typical local
	 *  bundles; the UI surfaces this rather than hiding it. */
	signatureStatus: AppSignatureStatus;
};

export type SideloadInstallResult =
	| {
			status: SideloadInstallStatus.Installed;
			app: SideloadInstalledApp;
			grantedCapabilities: string[];
	  }
	| { status: SideloadInstallStatus.Cancelled }
	| { status: SideloadInstallStatus.Failed; code: SideloadFailureCode; reason: string };

export type SideloadHandlersOptions = {
	getDashboard: () => BrowserWindow | null;
	/** Electron `dialog.showOpenDialog` seam — injected by tests. */
	showOpenDialog?: (
		parent: BrowserWindow | null,
		options: Electron.OpenDialogOptions,
	) => Promise<Electron.OpenDialogReturnValue>;
	/** Size bounds, overridable by tests so limits are exercised without
	 *  multi-MiB fixtures. */
	maxArchiveBytes?: number;
	maxUnpackedBytes?: number;
	maxVaultFileBytes?: number;
	maxVaultTotalBytes?: number;
};

/** One installable app root found in the vault's CodeFile tree — a
 *  `manifest.json` CodeFile plus every CodeFile under its directory. */
export type VaultAppSource = {
	/** Directory prefix inside the CodeFile tree (`""` = top level). */
	rootDir: string;
	manifestEntityId: string;
	/** The exact id list to pass to `apps:install-from-vault`. */
	fileIds: string[];
	fileCount: number;
	totalBytes: number;
	/** Parsed + validator-approved manifest summary, or null with `problem`. */
	manifest: {
		id: string;
		name: string;
		version: string;
		capabilities: string[];
	} | null;
	problem: string | null;
};

export type VaultAppSourcesResult =
	| { ok: true; sources: VaultAppSource[] }
	| { ok: false; code: SideloadFailureCode; reason: string };

function failed(code: SideloadFailureCode, reason: string): SideloadInstallResult {
	return { status: SideloadInstallStatus.Failed, code, reason };
}

const CANCELLED: SideloadInstallResult = { status: SideloadInstallStatus.Cancelled };

export function registerSideloadHandlers(options: SideloadHandlersOptions): void {
	const showOpenDialog =
		options.showOpenDialog ??
		((parent, dialogOptions) =>
			parent ? dialog.showOpenDialog(parent, dialogOptions) : dialog.showOpenDialog(dialogOptions));
	const maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
	const maxUnpackedBytes = options.maxUnpackedBytes ?? DEFAULT_MAX_UNPACKED_BYTES;
	const maxVaultFileBytes = options.maxVaultFileBytes ?? DEFAULT_MAX_VAULT_FILE_BYTES;
	const maxVaultTotalBytes = options.maxVaultTotalBytes ?? DEFAULT_MAX_VAULT_TOTAL_BYTES;

	/** Install surface = privileged: only the dashboard renderer may call it.
	 *  App renderers never get these channels via preload, but the sender check
	 *  keeps a compromised app renderer out even if it could reach ipcRenderer. */
	const rejectNonDashboard = (event: IpcMainInvokeEvent): SideloadInstallResult | null => {
		const dashboard = options.getDashboard();
		if (!dashboard || dashboard.isDestroyed() || event.sender !== dashboard.webContents) {
			return failed(SideloadFailureCode.NotAllowed, "install is only available to the dashboard");
		}
		return null;
	};

	ipcMain.handle(APPS_INSTALL_FROM_FOLDER_CHANNEL, async (event): Promise<SideloadInstallResult> => {
		const rejection = rejectNonDashboard(event);
		if (rejection) return rejection;
		const session = getActiveVaultSession();
		if (!session) return failed(SideloadFailureCode.NoVaultSession, "no active vault session");

		const picked = await showOpenDialog(options.getDashboard(), {
			title: "Install app from folder",
			properties: ["openDirectory"],
		});
		const bundleDir = picked.canceled ? undefined : picked.filePaths[0];
		if (bundleDir === undefined) return CANCELLED;

		return installBundleDir(bundleDir, session);
	});

	ipcMain.handle(APPS_INSTALL_FROM_FILE_CHANNEL, async (event): Promise<SideloadInstallResult> => {
		const rejection = rejectNonDashboard(event);
		if (rejection) return rejection;
		const session = getActiveVaultSession();
		if (!session) return failed(SideloadFailureCode.NoVaultSession, "no active vault session");

		const picked = await showOpenDialog(options.getDashboard(), {
			title: "Install app from file",
			properties: ["openFile"],
			filters: [{ name: "Brainstorm app package", extensions: ["brainstorm"] }],
		});
		const filePath = picked.canceled ? undefined : picked.filePaths[0];
		if (filePath === undefined) return CANCELLED;

		let bytes: Uint8Array;
		try {
			const info = await stat(filePath);
			if (info.size > maxArchiveBytes) {
				return failed(
					SideloadFailureCode.ArchiveTooLarge,
					`archive is ${info.size} bytes — the limit is ${maxArchiveBytes}`,
				);
			}
			bytes = await readFile(filePath);
		} catch (error) {
			return failed(SideloadFailureCode.BadArchive, (error as Error).message);
		}

		// Unpack into a fresh staging dir (never the vault) — the installer then
		// copies out of it, and the staging dir is removed no matter what.
		const stagingDir = await mkdtemp(join(tmpdir(), "brainstorm-sideload-"));
		try {
			try {
				await unpackBrainstormBundleToDir(bytes, stagingDir, {
					maxOutputBytes: maxUnpackedBytes,
				});
			} catch (error) {
				return failed(SideloadFailureCode.BadArchive, (error as Error).message);
			}
			return await installBundleDir(stagingDir, session);
		} finally {
			await rm(stagingDir, { recursive: true, force: true });
		}
	});

	ipcMain.handle(
		APPS_LIST_VAULT_APP_SOURCES_CHANNEL,
		async (event): Promise<VaultAppSourcesResult> => {
			const rejection = rejectNonDashboard(event);
			if (rejection) return sourcesFailure(rejection);
			const session = getActiveVaultSession();
			if (!session) {
				return {
					ok: false,
					code: SideloadFailureCode.NoVaultSession,
					reason: "no active vault session",
				};
			}
			const repo = new EntitiesRepository(await session.dataStores.open("entities"));
			return { ok: true, sources: listVaultAppSources(repo) };
		},
	);

	ipcMain.handle(
		APPS_INSTALL_FROM_VAULT_CHANNEL,
		async (event, fileIds: unknown): Promise<SideloadInstallResult> => {
			const rejection = rejectNonDashboard(event);
			if (rejection) return rejection;
			const session = getActiveVaultSession();
			if (!session) return failed(SideloadFailureCode.NoVaultSession, "no active vault session");

			const idsCheck = validateVaultFileIds(fileIds);
			if (!idsCheck.ok) return failed(SideloadFailureCode.BadRequest, idsCheck.reason);

			const repo = new EntitiesRepository(await session.dataStores.open("entities"));
			const files: VaultSourceFile[] = [];
			let totalBytes = 0;
			for (const id of idsCheck.ids) {
				// Server-side resolution — the id is the ONLY renderer input. Type,
				// path, and content all come from the vault row, never the caller.
				const row = repo.get(id);
				if (!row || row.type !== CODE_FILE_ENTITY_TYPE) {
					return failed(SideloadFailureCode.NotCodeFiles, `${id} is not a code file in this vault`);
				}
				const pathCheck = sanitizeVaultRelPath(row.properties.path);
				if (!pathCheck.ok) {
					return failed(SideloadFailureCode.BadPath, `${id}: ${pathCheck.reason}`);
				}
				const content = codeFileContent(row.properties);
				const bytes = Buffer.byteLength(content, "utf8");
				if (bytes > maxVaultFileBytes) {
					return failed(
						SideloadFailureCode.SourceTooLarge,
						`${clipPath(pathCheck.path)} is ${bytes} bytes — the per-file limit is ${maxVaultFileBytes}`,
					);
				}
				totalBytes += bytes;
				if (totalBytes > maxVaultTotalBytes) {
					return failed(
						SideloadFailureCode.SourceTooLarge,
						`the selection exceeds the total limit of ${maxVaultTotalBytes} bytes`,
					);
				}
				files.push({ id, path: pathCheck.path, content });
			}

			const layout = resolveBundleLayout(files);
			if (!layout.ok) return layout.result;

			// Materialise into a fresh staging dir (never the vault); the installer
			// copies out of it and the dir is removed no matter what.
			const stagingDir = await mkdtemp(join(tmpdir(), "brainstorm-vault-app-"));
			try {
				const stagingRoot = resolve(stagingDir);
				for (const entry of layout.entries) {
					const abs = resolve(stagingRoot, entry.relPath);
					// Belt + braces on top of the sanitizer: nothing leaves staging.
					if (abs !== stagingRoot && !abs.startsWith(stagingRoot + sep)) {
						return failed(
							SideloadFailureCode.BadPath,
							`${clipPath(entry.relPath)} escapes the staging directory`,
						);
					}
					await mkdir(dirname(abs), { recursive: true });
					await writeFile(abs, entry.content, "utf8");
				}
				return await installBundleDir(stagingDir, session);
			} finally {
				await rm(stagingDir, { recursive: true, force: true });
			}
		},
	);
}

type VaultSourceFile = { id: string; path: string; content: string };

function sourcesFailure(rejection: SideloadInstallResult): VaultAppSourcesResult {
	return rejection.status === SideloadInstallStatus.Failed
		? { ok: false, code: rejection.code, reason: rejection.reason }
		: { ok: false, code: SideloadFailureCode.NotAllowed, reason: "not allowed" };
}

function clipPath(path: string): string {
	return path.length > REASON_PATH_CHARS ? `${path.slice(0, REASON_PATH_CHARS)}…` : path;
}

/** Source text per the v1 CodeFile contract — property bag, `body` legacy
 *  fallback, absent degrades to an empty file (mirrors the Code editor's
 *  projection). */
function codeFileContent(props: Record<string, unknown>): string {
	if (typeof props.content === "string") return props.content;
	if (typeof props.body === "string") return props.body;
	return "";
}

type VaultFileIdsCheck = { ok: true; ids: string[] } | { ok: false; reason: string };

function validateVaultFileIds(value: unknown): VaultFileIdsCheck {
	if (!Array.isArray(value)) return { ok: false, reason: "expected a list of entity ids" };
	if (value.length === 0) return { ok: false, reason: "select at least one code file" };
	if (value.length > MAX_VAULT_FILE_COUNT) {
		return { ok: false, reason: `at most ${MAX_VAULT_FILE_COUNT} files can be installed` };
	}
	const seen = new Set<string>();
	for (const id of value) {
		if (!isSafeEntityId(id)) return { ok: false, reason: "invalid entity id in the selection" };
		if (seen.has(id)) return { ok: false, reason: "duplicate entity id in the selection" };
		seen.add(id);
	}
	return { ok: true, ids: value as string[] };
}

type VaultPathCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Fail-closed gate for the one spot where a vault string becomes a filesystem
 * path. Accepts only a plain `/`-separated relative path: no absolute or
 * drive-letter form, no `.`/`..`/empty segments, no backslashes (a separator
 * on Windows — ambiguity is rejected, not normalised), no control characters,
 * bounded length and depth.
 */
export function sanitizeVaultRelPath(value: unknown): VaultPathCheck {
	if (typeof value !== "string" || value.length === 0) {
		return { ok: false, reason: "the file has no path" };
	}
	if (value.length > MAX_VAULT_PATH_CHARS) {
		return { ok: false, reason: `path exceeds ${MAX_VAULT_PATH_CHARS} characters` };
	}
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) {
			return { ok: false, reason: "path contains a control character" };
		}
	}
	if (value.includes("\\")) return { ok: false, reason: "path contains a backslash" };
	if (value.startsWith("/")) return { ok: false, reason: "path is absolute" };
	if (/^[A-Za-z]:/.test(value)) return { ok: false, reason: "path is a drive-letter path" };
	const segments = value.split("/");
	if (segments.length > MAX_VAULT_PATH_SEGMENTS) {
		return { ok: false, reason: `path exceeds ${MAX_VAULT_PATH_SEGMENTS} segments` };
	}
	for (const segment of segments) {
		if (segment === "") return { ok: false, reason: "path has an empty segment" };
		if (segment === "." || segment === "..") {
			return { ok: false, reason: "path has a relative segment" };
		}
	}
	return { ok: true, path: value };
}

function isManifestPath(path: string): boolean {
	return path === MANIFEST_FILENAME || path.endsWith(`/${MANIFEST_FILENAME}`);
}

type BundleLayout =
	| { ok: true; entries: { relPath: string; content: string }[] }
	| { ok: false; result: SideloadInstallResult };

/**
 * Pick the app root (the unique shallowest `manifest.json` in the selection),
 * require every file to live under it, strip the root prefix, and reject
 * duplicate / file-vs-directory-conflicting relative paths case-insensitively
 * (macOS and Windows filesystems would silently clobber otherwise).
 */
function resolveBundleLayout(files: VaultSourceFile[]): BundleLayout {
	const manifests = files.filter((file) => isManifestPath(file.path));
	if (manifests.length === 0) {
		return {
			ok: false,
			result: failed(SideloadFailureCode.NoManifest, "the selection has no manifest.json"),
		};
	}
	const depth = (path: string): number => path.split("/").length;
	const minDepth = Math.min(...manifests.map((m) => depth(m.path)));
	const shallowest = manifests.filter((m) => depth(m.path) === minDepth);
	const rootManifest = shallowest[0];
	if (shallowest.length !== 1 || rootManifest === undefined) {
		return {
			ok: false,
			result: failed(
				SideloadFailureCode.NoManifest,
				"the selection has more than one root manifest.json — select exactly one app",
			),
		};
	}
	const rootPrefix = rootManifest.path.slice(0, rootManifest.path.length - MANIFEST_FILENAME.length);

	const entries: { relPath: string; content: string }[] = [];
	const seen = new Map<string, string>();
	for (const file of files) {
		if (!file.path.startsWith(rootPrefix)) {
			return {
				ok: false,
				result: failed(
					SideloadFailureCode.BadPath,
					`${clipPath(file.path)} is outside the app root ${rootPrefix || "(vault top level)"}`,
				),
			};
		}
		const relPath = file.path.slice(rootPrefix.length);
		const lower = relPath.toLowerCase();
		if (seen.has(lower)) {
			return {
				ok: false,
				result: failed(SideloadFailureCode.BadPath, `duplicate path ${clipPath(relPath)}`),
			};
		}
		seen.set(lower, relPath);
		entries.push({ relPath, content: file.content });
	}
	const lowers = [...seen.keys()].sort();
	for (let i = 1; i < lowers.length; i++) {
		const prev = lowers[i - 1];
		const next = lowers[i];
		if (prev !== undefined && next !== undefined && next.startsWith(`${prev}/`)) {
			return {
				ok: false,
				result: failed(
					SideloadFailureCode.BadPath,
					`${clipPath(prev)} is both a file and a directory in the selection`,
				),
			};
		}
	}
	return { ok: true, entries };
}

/** Group the vault's CodeFiles into installable app candidates — one per
 *  `manifest.json`, carrying everything under its directory. Rows whose path
 *  fails the sanitizer are left out (install would refuse them anyway). */
function listVaultAppSources(repo: EntitiesRepository): VaultAppSource[] {
	const files: VaultSourceFile[] = [];
	for (const row of repo.query({ type: CODE_FILE_ENTITY_TYPE, limit: MAX_VAULT_SCAN_ROWS })) {
		const check = sanitizeVaultRelPath(row.properties.path);
		if (!check.ok) continue;
		files.push({ id: row.id, path: check.path, content: codeFileContent(row.properties) });
	}
	const sources: VaultAppSource[] = [];
	for (const manifestFile of files.filter((file) => isManifestPath(file.path))) {
		const rootPrefix = manifestFile.path.slice(
			0,
			manifestFile.path.length - MANIFEST_FILENAME.length,
		);
		const group = files.filter((file) => file.path.startsWith(rootPrefix));
		let manifest: VaultAppSource["manifest"] = null;
		let problem: string | null = null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(manifestFile.content);
		} catch (error) {
			problem = `manifest.json is not valid JSON: ${(error as Error).message}`;
		}
		if (problem === null) {
			const validated = validateManifest(parsed);
			if (validated.ok) {
				manifest = {
					id: validated.manifest.id,
					name: validated.manifest.name,
					version: validated.manifest.version,
					capabilities: [...validated.manifest.capabilities],
				};
			} else {
				problem = validated.path ? `${validated.reason} (${validated.path})` : validated.reason;
			}
		}
		// A candidate the install path would refuse on count alone is surfaced as
		// a problem (disabled row) rather than offered and then failing.
		if (problem === null && group.length > MAX_VAULT_FILE_COUNT) {
			manifest = null;
			problem = `the folder holds ${group.length} files — at most ${MAX_VAULT_FILE_COUNT} can be installed`;
		}
		sources.push({
			rootDir: rootPrefix.replace(/\/$/, ""),
			manifestEntityId: manifestFile.id,
			fileIds: group.map((file) => file.id),
			fileCount: group.length,
			totalBytes: group.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0),
			manifest,
			problem,
		});
	}
	sources.sort((a, b) => a.rootDir.localeCompare(b.rootDir));
	return sources;
}

type ActiveSession = NonNullable<ReturnType<typeof getActiveVaultSession>>;

/** Shared install half: validate the (untrusted) manifest → typed pre-check
 *  failures → `AppInstaller.install` with `InstallOrigin.LocalFile` provenance
 *  → pin the dashboard icon (mirrors the catalog install path). */
async function installBundleDir(
	bundleDir: string,
	session: ActiveSession,
): Promise<SideloadInstallResult> {
	const manifestCheck = await readManifestForPrecheck(bundleDir);
	if (!manifestCheck.ok) return failed(SideloadFailureCode.BadManifest, manifestCheck.reason);
	const manifest = manifestCheck.manifest;

	const registry = await session.dataStores.open("registry");
	const appsRepo = new AppsRepository(registry);
	const existing = appsRepo.getActive(manifest.id);
	if (existing) {
		return failed(
			SideloadFailureCode.AlreadyInstalled,
			`${manifest.id} is already installed at version ${existing.version}`,
		);
	}

	const ledger = await session.capabilityLedger();
	const installer = new AppInstaller(
		session.vaultPath,
		registry,
		ledger,
		getActiveShortcutRegistry() ?? undefined,
	);
	const provenance: InstallProvenance = {
		origin: InstallOrigin.LocalFile,
		catalogId: null,
		channel: UpdateChannel.Stable,
		publisherKey: null,
		catalogVersion: null,
	};

	let result: Awaited<ReturnType<AppInstaller["install"]>>;
	try {
		result = await installer.install({ bundleDir, provenance });
	} catch (error) {
		return failed(SideloadFailureCode.InstallFailed, (error as Error).message);
	}
	if (!result.ok) return failed(SideloadFailureCode.InstallFailed, result.reason);

	// Explicit user install = they want the app reachable — pin its icon (and
	// clear a past dismissal), same as the catalog install path.
	const dashboard = await session.dashboardStore();
	dashboard.clearAppIconDismissed(result.app.id);
	placeDashboardIcon(dashboard, result.app.id, result.app.manifest.name);

	return {
		status: SideloadInstallStatus.Installed,
		app: {
			id: result.app.id,
			name: result.app.manifest.name,
			version: result.app.version,
			signatureStatus: result.app.signature.status,
		},
		grantedCapabilities: result.capabilities.granted,
	};
}

type ManifestPrecheck =
	| { ok: true; manifest: { id: string; name: string } }
	| { ok: false; reason: string };

/** Pre-read the untrusted manifest so failures map to typed codes (the
 *  installer re-validates — this never *grants* anything, it only classifies).
 *  Size-bounded before parse. */
async function readManifestForPrecheck(bundleDir: string): Promise<ManifestPrecheck> {
	const manifestPath = join(bundleDir, "manifest.json");
	let raw: string;
	try {
		const info = await stat(manifestPath);
		if (info.size > MAX_MANIFEST_BYTES) {
			return { ok: false, reason: `manifest.json is ${info.size} bytes — too large` };
		}
		raw = await readFile(manifestPath, "utf8");
	} catch {
		return { ok: false, reason: "manifest.json missing or unreadable in the selected bundle" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { ok: false, reason: `manifest.json is not valid JSON: ${(error as Error).message}` };
	}
	const validated = validateManifest(parsed);
	if (!validated.ok) {
		return {
			ok: false,
			reason: validated.path ? `${validated.reason} (${validated.path})` : validated.reason,
		};
	}
	return { ok: true, manifest: { id: validated.manifest.id, name: validated.manifest.name } };
}
