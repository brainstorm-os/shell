/**
 * `apps:install-from-*` IPC handlers — install an app from a local folder or a
 * `.brainstorm` archive picked via the OS file dialog (AppForge-1, doc 49).
 *
 * This is the first renderer-reachable producer of the sideload install path
 * (`InstallOrigin.LocalFile`). Trust posture:
 *   - The install is a **privileged shell action behind a user gesture**: only
 *     the dashboard renderer may invoke it (sender-checked against the
 *     dashboard WebContents — app renderers are rejected fail-closed, on top
 *     of the preload boundary that never exposes these channels to apps), and
 *     the bundle only ever comes from an OS dialog the user drove.
 *   - The chosen bytes are **hostile input**: the manifest is validated by the
 *     installer's fail-closed validator (re-run here first so failures map to
 *     typed codes), archives are size-bounded before unpack, decompression is
 *     expansion-bounded, and the tar unpacker + `unpackBrainstormBundleToDir`
 *     both reject traversal out of the staging dir.
 *   - Unsigned bundles install with `AppSignatureStatus.Unsigned` recorded —
 *     advisory in v1 (same policy as every install path; `shouldBlockInstall`
 *     stays the single enforcement chokepoint) and surfaced in the result +
 *     marketplace listing so the UI can say so honestly.
 *
 * Results are always typed (`SideloadInstallResult`) — a handler never throws
 * raw errors into the renderer's `invoke` rejection path.
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import { type BrowserWindow, type IpcMainInvokeEvent, dialog, ipcMain } from "electron";
import type { AppSignatureStatus } from "../apps/app-signature";
import { InstallOrigin, type InstallProvenance } from "../apps/install-provenance";
import { AppInstaller } from "../apps/installer";
import { validateManifest } from "../apps/manifest";
import { unpackBrainstormBundleToDir } from "../catalog/brainstorm-package";
import { placeDashboardIcon } from "../dev/seed-demo-apps";
import { getActiveShortcutRegistry } from "../shortcuts/active-registry";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import { getActiveVaultSession } from "../vault/session";

export const APPS_INSTALL_FROM_FOLDER_CHANNEL = "apps:install-from-folder" as const;
export const APPS_INSTALL_FROM_FILE_CHANNEL = "apps:install-from-file" as const;

/** A hostile manifest.json could be gigabytes; bound the read before parsing.
 *  Real manifests are a few KiB — 512 KiB is ~100× headroom. */
const MAX_MANIFEST_BYTES = 512 * 1024;
/** Cap on the `.brainstorm` file itself (compressed). First-party bundles are
 *  single-digit MiB; 64 MiB is generous for any real app. */
const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** Cap on the decompressed content — bounds a gzip bomb independently of the
 *  on-disk file size. */
const DEFAULT_MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

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
};

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
