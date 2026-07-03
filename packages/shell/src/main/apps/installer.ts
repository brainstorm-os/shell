/**
 * App installer per §Install / §Update / §Uninstall.
 *
 * Inputs:
 *   - A directory containing `manifest.json` + the app's bundle assets.
 *
 * Install effects:
 *   1. Validate the manifest.
 *   2. Copy the bundle to `<vault>/apps/<id>/<version>/`.
 *   3. Record bundle SHA-256 for integrity (Stage 12 verifies on launch).
 *   4. Write rows via the `registry.db` repositories: apps, openers, blocks,
 *      entity_types, widgets.
 *   5. Apply **default-minimum** capability grants + manifest-requested grants
 *      to the capability ledger.
 *
 * Update flow (same id, higher version):
 *   - Diff capabilities (`diffCapabilities`); caller decides whether to
 *     re-consent for new grants. Removed grants are revoked silently.
 *   - Copy the new bundle alongside the old, switch the `current` row.
 *   - Old version stays on disk until vacuumed (Stage 13).
 *
 * Uninstall flow:
 *   - Mark `apps.uninstalled_at` on the row (soft).
 *   - Mark introduced `entity_types.orphaned = 1` (OQ-3 resolution).
 *   - Revoke all live grants for the app.
 *   - Drop registrations from `openers`, `blocks`, `widgets` (pure lookup
 *     tables — re-install repopulates them).
 *
 * Per the Stage 5 repository-pattern decision: SQL stays in the per-table
 * repos under `storage/registry-repo/`; this file only orchestrates them.
 *
 * Stage 5 lands the programmatic flow. The capability-prompt modal that
 * wraps this for an interactive install is Stage 5b.
 */

import { cp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { applyDefaultAppGrants } from "../capabilities/default-grants";
import { type CapabilityLedger, GrantedVia } from "../capabilities/ledger";
import { type ShortcutRegistry, shellChordSet } from "../shortcuts/shortcut-registry";
import { OpenerTargetKind, RegistryRepositories } from "../storage/registry-repo";
import type { SqliteDatabase } from "../storage/sqlite";
import { hashBundleDirectory } from "./app-bundle-hash";
import {
	AppSignatureStatus,
	type SignatureVerification,
	type TrustedAppKeys,
	shouldBlockInstall,
	verifyManifestSignature,
} from "./app-signature";
import { broadcastAppsChanged } from "./apps-changed";
import { shouldCopyBundleEntry } from "./bundle-filter";
import { DEFAULT_INSTALL_PROVENANCE, type InstallProvenance } from "./install-provenance";
import {
	type AppManifest,
	type ValidationResult,
	diffCapabilities,
	validateManifest,
	validateShortcutShellCollisions,
} from "./manifest";

/**
 * Manifest-signature policy for the installer (13.2). v1 default is
 * **advisory** — `trustedKeys` empty + `enforce` false — so signatures are
 * recorded on the registry row but never block install. Wiring a populated
 * `trustedKeys` map verifies signed manifests; flipping `enforce` to true (v2)
 * turns a bad/untrusted signature into an install reject via `shouldBlockInstall`.
 */
export type AppSignaturePolicy = {
	trustedKeys: TrustedAppKeys;
	enforce: boolean;
};

const ADVISORY_NO_KEYS: AppSignaturePolicy = { trustedKeys: new Map(), enforce: false };

/** Cap on a stored block bundle (chars). A first-party block IIFE is tens of
 *  KiB; this bounds a hostile/oversized artifact from bloating registry.db
 *  (the bundle is the app's own copied dist, but the installer is the trust
 *  boundary, so it caps regardless). 2 MiB is ~100× a real bundle. */
const MAX_BLOCK_SOURCE_BYTES = 2 * 1024 * 1024;

export type InstallSource = {
	/** Absolute path to the directory containing `manifest.json`. */
	bundleDir: string;
	/** Where this install came from + how it updates (doc 59 / schema v9).
	 *  Omitted → `DEFAULT_INSTALL_PROVENANCE` on a fresh install; on update,
	 *  omitted preserves the existing row's provenance. */
	provenance?: InstallProvenance;
};

export type InstalledApp = {
	id: string;
	version: string;
	manifest: AppManifest;
	bundleDir: string;
	bundleSha256: string;
	installedAt: number;
	/** Advisory manifest-signature outcome recorded on the registry row (13.2). */
	signature: SignatureVerification;
};

export type InstallResult =
	| { ok: true; app: InstalledApp; capabilities: { granted: string[]; alreadyGranted: string[] } }
	| { ok: false; reason: string; path?: string };

export type UpdateResult =
	| {
			ok: true;
			app: InstalledApp;
			capabilities: { added: string[]; removed: string[]; unchanged: string[] };
	  }
	| { ok: false; reason: string; path?: string };

export type UninstallResult =
	| { ok: true; revokedCapabilities: number; orphanedTypes: number }
	| { ok: false; reason: string };

export type RefreshResult =
	| { ok: true; id: string; version: string }
	| { ok: false; reason: string; path?: string };

export class AppInstaller {
	private readonly repos: RegistryRepositories;

	constructor(
		private readonly vaultPath: string,
		registryDb: SqliteDatabase,
		private readonly ledger: CapabilityLedger,
		/** Optional. When supplied, install/update validates manifest-vs-shell
		 *  chord collisions and mirrors `manifest.shortcuts: [...]` into the
		 *  registry under `app/<app-id>/<id>` (per §Manifest is the
		 *  source of truth, iteration 6.10b). Callers that don't have a
		 *  registry on hand (tests, seed scripts pre-shell-boot) may omit it;
		 *  registry mirroring then happens at shell startup via the
		 *  installed-apps boot pass. */
		private readonly shortcutRegistry?: ShortcutRegistry,
		/** Manifest-signature policy. Omitted → advisory with no trusted keys
		 *  (v1 default): every signed manifest reads `untrusted`, unsigned reads
		 *  `unsigned`, and install is never blocked. */
		signaturePolicy?: AppSignaturePolicy,
	) {
		this.repos = new RegistryRepositories(registryDb);
		this.registryDb = registryDb;
		this.signaturePolicy = signaturePolicy ?? ADVISORY_NO_KEYS;
	}

	private readonly registryDb: SqliteDatabase;
	private readonly signaturePolicy: AppSignaturePolicy;

	async install(source: InstallSource): Promise<InstallResult> {
		const manifestResult = await readAndValidateManifest(source.bundleDir);
		if (!manifestResult.ok) {
			return { ok: false, reason: manifestResult.reason, path: manifestResult.path };
		}
		const manifest = manifestResult.manifest;

		const active = this.repos.apps.getActive(manifest.id);
		if (active) {
			return {
				ok: false,
				reason: `app ${manifest.id} is already installed at version ${active.version} — use update()`,
			};
		}

		const shortcutCollision = this.checkShortcutCollisions(manifest);
		if (shortcutCollision) return shortcutCollision;

		const signature = this.verifySignature(manifest);
		const signatureBlock = this.enforceSignature(signature);
		if (signatureBlock) return signatureBlock;

		const installDir = this.installDirFor(manifest.id, manifest.version);
		// Registry says not installed; any pre-existing files in installDir are
		// orphan leftovers from a prior failed copy (e.g. ERR_FS_CP_EINVAL on a
		// dev-time node_modules symlink). Clear them so the bundle hash reflects
		// only the current source and not stale fragments.
		await rm(installDir, { recursive: true, force: true });
		await cp(source.bundleDir, installDir, {
			recursive: true,
			filter: (src) => shouldCopyBundleEntry(source.bundleDir, src),
		});
		const bundleSha256 = await hashBundleDirectory(installDir);
		const installedAt = Date.now();
		const blockSources = await this.readBlockSources(manifest, installDir);
		const provenance = source.provenance ?? DEFAULT_INSTALL_PROVENANCE;

		this.registryDb.transaction(() => {
			this.repos.apps.upsert({
				id: manifest.id,
				version: manifest.version,
				sdk: manifest.sdk,
				manifestPath: join(installDir, "manifest.json"),
				bundleDir: installDir,
				bundleSha256,
				installedAt,
				updatedAt: installedAt,
				signatureStatus: signature.status,
				signatureKeyId: signature.keyId ?? null,
				origin: provenance.origin,
				catalogId: provenance.catalogId,
				channel: provenance.channel,
				publisherKey: provenance.publisherKey,
				catalogVersion: provenance.catalogVersion,
			});
			this.writeRegistrations(manifest, installedAt, blockSources);
		})();

		const defaultsGranted = applyDefaultAppGrants(this.ledger, manifest.id);
		const requested: string[] = [];
		const alreadyGranted: string[] = [];
		for (const cap of manifest.capabilities) {
			if (this.ledger.has(manifest.id, cap)) {
				alreadyGranted.push(cap);
				continue;
			}
			const { capability, scope } = splitCapability(cap);
			this.ledger.grant({
				appId: manifest.id,
				capability,
				scope,
				grantedVia: GrantedVia.Install,
			});
			requested.push(cap);
		}

		this.mirrorShortcuts(manifest);
		broadcastAppsChanged();

		return {
			ok: true,
			app: {
				id: manifest.id,
				version: manifest.version,
				manifest,
				bundleDir: installDir,
				bundleSha256,
				installedAt,
				signature,
			},
			capabilities: {
				granted: [...defaultsGranted.map(formatGrant), ...requested],
				alreadyGranted,
			},
		};
	}

	async update(source: InstallSource): Promise<UpdateResult> {
		const manifestResult = await readAndValidateManifest(source.bundleDir);
		if (!manifestResult.ok) {
			return { ok: false, reason: manifestResult.reason, path: manifestResult.path };
		}
		const manifest = manifestResult.manifest;
		const previous = this.repos.apps.getActive(manifest.id);
		if (!previous) {
			return { ok: false, reason: `app ${manifest.id} is not installed — use install()` };
		}
		if (manifest.version === previous.version) {
			return { ok: false, reason: `version ${manifest.version} is already installed` };
		}

		const shortcutCollision = this.checkShortcutCollisions(manifest);
		if (shortcutCollision) return shortcutCollision;

		const previousManifest = await readManifestJson(previous.bundleDir);
		const previousCaps = previousManifest?.capabilities ?? [];
		const diff = diffCapabilities(previousCaps, manifest.capabilities);

		const signature = this.verifySignature(manifest);
		const signatureBlock = this.enforceSignature(signature);
		if (signatureBlock) return signatureBlock;

		const installDir = this.installDirFor(manifest.id, manifest.version);
		await rm(installDir, { recursive: true, force: true });
		await cp(source.bundleDir, installDir, {
			recursive: true,
			filter: (src) => shouldCopyBundleEntry(source.bundleDir, src),
		});
		const bundleSha256 = await hashBundleDirectory(installDir);
		const now = Date.now();
		const blockSources = await this.readBlockSources(manifest, installDir);
		// An update preserves the install's provenance unless the caller (the
		// catalog update engine) overrides it — a version bump shouldn't wipe
		// where the app is tracked.
		const provenance: InstallProvenance = source.provenance ?? {
			origin: previous.origin,
			catalogId: previous.catalogId,
			channel: previous.channel,
			publisherKey: previous.publisherKey,
			catalogVersion: previous.catalogVersion,
		};

		this.registryDb.transaction(() => {
			this.repos.apps.updateBundle({
				id: manifest.id,
				version: manifest.version,
				sdk: manifest.sdk,
				manifestPath: join(installDir, "manifest.json"),
				bundleDir: installDir,
				bundleSha256,
				installedAt: previous.installedAt,
				updatedAt: now,
				signatureStatus: signature.status,
				signatureKeyId: signature.keyId ?? null,
				origin: provenance.origin,
				catalogId: provenance.catalogId,
				channel: provenance.channel,
				publisherKey: provenance.publisherKey,
				catalogVersion: provenance.catalogVersion,
			});
			this.clearLookupRegistrations(manifest.id);
			this.writeRegistrations(manifest, now, blockSources);
		})();

		for (const removed of diff.removed) {
			const { capability, scope } = splitCapability(removed);
			this.ledger.revoke(manifest.id, capability, scope);
		}
		for (const added of diff.added) {
			const { capability, scope } = splitCapability(added);
			this.ledger.grant({
				appId: manifest.id,
				capability,
				scope,
				grantedVia: GrantedVia.Install,
			});
		}

		this.mirrorShortcuts(manifest);
		broadcastAppsChanged();

		return {
			ok: true,
			app: {
				id: manifest.id,
				version: manifest.version,
				manifest,
				bundleDir: installDir,
				bundleSha256,
				installedAt: previous.installedAt,
				signature,
			},
			capabilities: diff,
		};
	}

	/** Run the manifest-signature check under the configured policy (13.2).
	 *  Total — verification never throws (a bad signature reads `Invalid`). */
	private verifySignature(manifest: AppManifest): SignatureVerification {
		const result = verifyManifestSignature(manifest, this.signaturePolicy.trustedKeys);
		if (
			result.status !== AppSignatureStatus.Verified &&
			result.status !== AppSignatureStatus.Unsigned
		) {
			const note = result.detail ? ` — ${result.detail}` : "";
			console.warn(`[AppInstaller] manifest signature ${result.status} for ${manifest.id}${note}`);
		}
		return result;
	}

	/** The single enforcement chokepoint. v1 advisory → always null (never
	 *  blocks). Returns an install/update failure only when the policy enforces
	 *  signatures AND the status is bad/untrusted. */
	private enforceSignature(
		signature: SignatureVerification,
	): { ok: false; reason: string; path: string } | null {
		if (!shouldBlockInstall(signature.status, { enforce: this.signaturePolicy.enforce })) {
			return null;
		}
		return {
			ok: false,
			reason: `manifest signature ${signature.status}${signature.detail ? ` — ${signature.detail}` : ""}`,
			path: "$.signature",
		};
	}

	/**
	 * 7.6 — re-apply an installed app's manifest registrations
	 * (openers / blocks / widgets / intents / entity-types) from the
	 * **already-installed** bundle, without an uninstall+reinstall cycle.
	 *
	 * The dev hot-reload primitive: edit `apps/<app>/manifest.json`'s
	 * `registrations`, refresh, and the running shell's IntentsBus —
	 * which reads the registry repo live on every dispatch (no cache) —
	 * picks the change up immediately. Deliberately narrow vs. `update()`:
	 * no bundle copy, no version bump, no install-dir churn, and **no
	 * capability re-grant/revoke** (manifest `capabilities` are a
	 * user-consent surface, not a dev-iteration knob). Same registry
	 * transaction shape as `update()`'s registration half.
	 */
	async refreshRegistrations(appId: string): Promise<RefreshResult> {
		const existing = this.repos.apps.getActive(appId);
		if (!existing) {
			return { ok: false, reason: `app ${appId} is not installed` };
		}
		const manifestResult = await readAndValidateManifest(existing.bundleDir);
		if (!manifestResult.ok) {
			return { ok: false, reason: manifestResult.reason, path: manifestResult.path };
		}
		const manifest = manifestResult.manifest;
		if (manifest.id !== appId) {
			return {
				ok: false,
				reason: `manifest id ${manifest.id} does not match installed app ${appId}`,
			};
		}
		const shortcutCollision = this.checkShortcutCollisions(manifest);
		if (shortcutCollision) return shortcutCollision;
		const now = Date.now();
		const blockSources = await this.readBlockSources(manifest, existing.bundleDir);
		this.registryDb.transaction(() => {
			this.clearLookupRegistrations(appId);
			this.writeRegistrations(manifest, now, blockSources);
		})();
		this.mirrorShortcuts(manifest);
		broadcastAppsChanged();
		return { ok: true, id: manifest.id, version: manifest.version };
	}

	async uninstall(appId: string): Promise<UninstallResult> {
		const existing = this.repos.apps.getActive(appId);
		if (!existing) {
			return { ok: false, reason: `app ${appId} is not installed` };
		}

		const orphanedTypes = this.repos.entityTypes.orphanForApp(appId);
		this.registryDb.transaction(() => {
			this.clearLookupRegistrations(appId);
			this.repos.apps.markUninstalled(appId);
		})();
		const revokedCapabilities = this.ledger.revokeAllFor(appId);
		this.shortcutRegistry?.unregisterApp(appId);

		// Bundle directory stays on disk for forensic recovery; vacuum is a
		// separate operation (Stage 13).
		broadcastAppsChanged();
		return { ok: true, revokedCapabilities, orphanedTypes };
	}

	/** Bundle directory cleanup. Separate from uninstall so a recovery-from-
	 *  bad-update can keep the old bundle around. */
	async vacuumBundles(appId: string): Promise<void> {
		const dir = join(this.vaultPath, "apps", appId);
		try {
			await rm(dir, { recursive: true });
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
	}

	private installDirFor(appId: string, version: string): string {
		return join(this.vaultPath, "apps", appId, version);
	}

	/** Manifest-vs-shell chord collision check (per §App opt-in
	 *  shadowing). No-op when no shortcut registry was wired in (tests /
	 *  seed-time install — the boot-time mirror pass enforces the rule
	 *  the next time the registry is alive). */
	private checkShortcutCollisions(
		manifest: AppManifest,
	): { ok: false; reason: string; path: string } | null {
		if (!this.shortcutRegistry) return null;
		if (!manifest.shortcuts || manifest.shortcuts.length === 0) return null;
		const shellChords = shellChordSet(this.shortcutRegistry);
		return validateShortcutShellCollisions(manifest, shellChords);
	}

	/** Mirror the manifest's `shortcuts: [...]` into the shortcut registry
	 *  under `app/<app-id>/<id>` (per §Manifest is the source of
	 *  truth). No-op when no registry was wired in. */
	private mirrorShortcuts(manifest: AppManifest): void {
		if (!this.shortcutRegistry) return;
		this.shortcutRegistry.registerApp(manifest.id, manifest.shortcuts ?? []);
	}

	/** Read each declared block's built bundle from the installed app dir.
	 *  Convention: `dist/blocks/<block-name>.js` where `<block-name>` is the
	 *  block id's last `/`-segment (matches the app's `vite.blocks.config`
	 *  output). A missing file is normal — that block ships no live bundle and
	 *  renders as the fallback card. A bundle larger than the cap is dropped
	 *  (defense against a hostile/oversized artifact bloating registry.db). */
	private async readBlockSources(
		manifest: AppManifest,
		installDir: string,
	): Promise<Map<string, string>> {
		const sources = new Map<string, string>();
		for (const b of manifest.registrations?.blocks ?? []) {
			const fileName = `${b.id.slice(b.id.lastIndexOf("/") + 1)}.js`;
			try {
				const text = await readFile(join(installDir, "dist", "blocks", fileName), "utf8");
				if (text.length <= MAX_BLOCK_SOURCE_BYTES) sources.set(b.id, text);
			} catch {
				/* no bundle for this block — fallback card. */
			}
		}
		return sources;
	}

	/** Insert the manifest's openers / blocks / entity-types / widgets. */
	private writeRegistrations(
		manifest: AppManifest,
		now: number,
		blockSources: Map<string, string> = new Map(),
	): void {
		const regs = manifest.registrations ?? {};

		const openers = (regs.openers ?? []).map((opener) => {
			const [targetKind, target] =
				"entityType" in opener && opener.entityType !== undefined
					? ([OpenerTargetKind.EntityType, opener.entityType] as const)
					: "mime" in opener && opener.mime !== undefined
						? ([OpenerTargetKind.Mime, opener.mime] as const)
						: "scheme" in opener && opener.scheme !== undefined
							? ([OpenerTargetKind.Scheme, opener.scheme] as const)
							: "extension" in opener && opener.extension !== undefined
								? ([OpenerTargetKind.Extension, opener.extension] as const)
								: ([OpenerTargetKind.Mime, ""] as const);
			return { appId: manifest.id, targetKind, target, kind: opener.kind };
		});
		this.repos.openers.insertMany(openers.filter((o) => o.target.length > 0));

		this.repos.blocks.insertMany(
			(regs.blocks ?? []).map((b) => ({
				id: b.id,
				appId: manifest.id,
				name: b.name,
				registeredAt: now,
				source: blockSources.get(b.id) ?? null,
				...(b.entityTypes ? { entityTypes: b.entityTypes } : {}),
			})),
		);

		for (const et of regs.entityTypes ?? []) {
			this.repos.entityTypes.upsert({
				id: et.id,
				introducedBy: manifest.id,
				schemaUrl: et.schemaUrl,
				schemaInline: et.schema ?? null,
				registeredAt: now,
			});
		}

		this.repos.widgets.insertMany(
			(regs.widgets ?? []).map((w) => ({
				id: w.id,
				appId: manifest.id,
				name: w.name,
				size: w.size,
				registeredAt: now,
			})),
		);

		this.repos.intents.insertMany(
			(regs.intents ?? []).map((it) => ({
				appId: manifest.id,
				verb: it.verb,
				entityType: it.entityType ?? null,
				mime: it.mime ?? null,
				format: it.format ?? null,
				kind: it.kind ?? null,
				blockId: it.blockId ?? null,
				label: it.label ?? null,
				priority: it.priority ?? "secondary",
				registeredAt: now,
				icon: it.icon ?? null,
				actionGroup: it.group ?? null,
			})),
		);
	}

	/**
	 * Drop pure-lookup registrations (openers/blocks/widgets) for an app.
	 * `entity_types` are NOT touched here — they survive uninstall as orphaned
	 * (OQ-3 resolution) and are refreshed by the upsert in `writeRegistrations`
	 * on re-install.
	 */
	private clearLookupRegistrations(appId: string): void {
		this.repos.openers.deleteForApp(appId);
		this.repos.blocks.deleteForApp(appId);
		this.repos.widgets.deleteForApp(appId);
		this.repos.intents.deleteForApp(appId);
	}
}

async function readAndValidateManifest(bundleDir: string): Promise<ValidationResult> {
	const manifestPath = join(bundleDir, "manifest.json");
	let raw: string;
	try {
		raw = await readFile(manifestPath, "utf8");
	} catch (error) {
		if (isNotFound(error)) {
			return { ok: false, reason: "manifest.json missing in bundle", path: "$" };
		}
		return { ok: false, reason: `failed to read manifest: ${(error as Error).message}`, path: "$" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			ok: false,
			reason: `manifest.json is not valid JSON: ${(error as Error).message}`,
			path: "$",
		};
	}
	return validateManifest(parsed);
}

async function readManifestJson(bundleDir: string): Promise<AppManifest | null> {
	try {
		const raw = await readFile(join(bundleDir, "manifest.json"), "utf8");
		const parsed = JSON.parse(raw);
		const result = validateManifest(parsed);
		return result.ok ? result.manifest : null;
	} catch {
		return null;
	}
}

function splitCapability(cap: string): { capability: string; scope: string | null } {
	const i = cap.indexOf(":");
	if (i < 0) return { capability: cap, scope: null };
	return { capability: cap.slice(0, i), scope: cap.slice(i + 1) };
}

function formatGrant(g: { capability: string; scope: string | null }): string {
	return g.scope === null ? g.capability : `${g.capability}:${g.scope}`;
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code: unknown }).code === "ENOENT"
	);
}

/** `stat`-based test helper for callers that need to confirm install state. */
export async function bundleExists(bundleDir: string): Promise<boolean> {
	try {
		const info = await stat(bundleDir);
		return info.isDirectory();
	} catch {
		return false;
	}
}
