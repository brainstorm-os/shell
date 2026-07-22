import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type AtRestMode,
	AtRestReconcileOutcome,
	describeAtRestMode,
	isAtRestMode,
	probeAtRestMode,
	reconcileAtRestMode,
} from "@brainstorm-os/sqlite/at-rest-mode";
import { ulid } from "ulid";
import type { KeystoreBackendName, PickKeystoreOptions } from "../credentials/keystore";
import { type DataStoreKind, archiveCorruptDb } from "../storage/data-stores";
import { assertVaultFormatNotPreFreeze, assertVaultFormatSupported } from "../util/schema-version";
import { WELCOME_SEED_VERSION } from "../welcome/welcome-content";
import { writeWelcomeSeedVersion } from "../welcome/welcome-seed-store";
import { appendAuditEvent } from "./audit-log";
import {
	REGISTRY_VERSION,
	type Registry,
	VAULT_FORMAT_VERSION,
	type VaultEntry,
	readRegistry,
	salvageRegistryPaths,
	writeRegistry,
} from "./registry";
import { productionScanForVaults } from "./registry-recovery";
import {
	VaultSession,
	closeActiveVaultSession,
	getActiveVaultSession,
	setActiveVaultSession,
} from "./session";
import { migrateVaultToCurrent } from "./vault-migrations";

const DEFAULT_COLORS = [
	"#7c3aed",
	"#0ea5e9",
	"#10b981",
	"#f59e0b",
	"#ef4444",
	"#ec4899",
	"#6366f1",
	"#14b8a6",
];

/**
 * The on-disk vault.json schema. Lives at <vaultPath>/vault.json and is the
 * authoritative source of vault metadata; the registry entry mirrors a subset
 * for fast enumeration without opening every vault.
 *
 * Stage 2 adds identity + credentials backend fields so the shell can
 * recognize whose keystore an opened vault came from. Earlier-format vaults
 * (without these fields) are still openable — the open path treats missing
 * identity metadata as "needs identity bootstrap".
 */
type VaultJson = {
	id: string;
	name: string;
	color: string;
	icon?: string;
	format: string;
	createdAt: number;
	identityPublicKey?: string; // base64 of the Ed25519 public key
	identityFingerprint?: string; // ed25519:<16-hex>
	credentialsBackend?: KeystoreBackendName;
	/**
	 * Stage 3b — the at-rest mode this vault was created / last opened with.
	 * Stamped on create from the live driver probe; reconciled on every open
	 * (fail-closed on a recorded-encrypted vault opening into a plaintext
	 * environment). Absent on pre-3b vaults — first open stamps it.
	 */
	atRestMode?: AtRestMode;
	/**
	 * Stage 10.4 — sync transport target. Absent ⇒ local-only (the
	 * default — no relay activity, the LoopbackRelayPort is the only
	 * implementation that ever runs). When present, the wire path opens a
	 * `WebSocketRelayPort` against `url`; `addedAt` records when the user
	 * paired this vault to the relay (10.5 pairing UX will write this).
	 * 10.4 only ships the persisted shape — wiring into the active session
	 * happens at 10.5 when there's a UX surface that knows when to do it.
	 */
	syncRelay?: SyncRelayConfig;
};

/**
 * On-disk shape of `vault.json`'s `syncRelay` field. Stage 10.4 only
 * ships the persisted contract; the live `WebSocketRelayPort` wires up
 * in 10.5 (pairing UX). The `url` is the `ws://` / `wss://` target the
 * relay serves on; `addedAt` is a unix-ms timestamp recorded when the
 * user paired this vault (or when the field was first stamped on a
 * relay-imported vault).
 */
export type SyncRelayConfig = {
	url: string;
	addedAt: number;
};

export type CreateVaultOptions = {
	name: string;
	path: string;
	color?: string;
	/** Forwarded to the keystore picker — passphrase / forceInsecure / etc. */
	keystore?: Omit<PickKeystoreOptions, "vaultPath">;
	/** Welcome-1b opt-out: when `false`, the first-launch starter content is
	 *  declined. We pre-stamp the welcome seed at the bundled version so the
	 *  vault-init seeder (`seedWelcomeOnFreshVault`) reads "already seeded" and
	 *  no-ops — no new boot-time gating, just the existing idempotency guard.
	 *  Defaults to seeding (omitted / `true`). */
	seedStarterContent?: boolean;
};

export type OpenVaultOptions = {
	/** Forwarded to the keystore picker on session open. */
	keystore?: Omit<PickKeystoreOptions, "vaultPath">;
};

export async function listVaults(): Promise<VaultEntry[]> {
	const registry = await readRegistry();
	return registry.vaults;
}

export async function getDefaultVault(): Promise<VaultEntry | null> {
	const registry = await readRegistry();
	if (!registry.defaultVaultId) return null;
	return registry.vaults.find((v) => v.id === registry.defaultVaultId) ?? null;
}

export async function createVault(options: CreateVaultOptions): Promise<VaultEntry> {
	const { name, path, color, keystore: keystoreOptions } = options;
	if (!name.trim()) throw new Error("Vault name is required");
	if (!path) throw new Error("Vault path is required");

	await ensureDirectoryUsable(path);

	const id = `vlt_${ulid()}`;
	const chosenColor = color ?? pickColor(id);
	const now = Date.now();

	await mkdir(join(path, "shell"), { recursive: true });
	await mkdir(join(path, "apps"), { recursive: true });
	await mkdir(join(path, "data", "docs"), { recursive: true });
	await mkdir(join(path, "data", "attachments"), { recursive: true });
	await mkdir(join(path, "data", "app-private"), { recursive: true });
	await mkdir(join(path, "logs"), { recursive: true });

	// Provision identity + master key. The session owns both; we only persist
	// the public-key metadata in vault.json (private key + master key live in
	// the keystore picked by the user's platform).
	const session = await VaultSession.create({
		vaultId: id,
		vaultPath: path,
		...(keystoreOptions ?? {}),
	});

	const atRest = await probeAtRestMode();
	console.info(describeAtRestMode(atRest));

	const vaultJson: VaultJson = {
		id,
		name: name.trim(),
		color: chosenColor,
		format: VAULT_FORMAT_VERSION,
		createdAt: now,
		identityPublicKey: session.identity.publicKeyBase64,
		identityFingerprint: session.identity.fingerprint,
		credentialsBackend: session.backend.name,
		atRestMode: atRest.mode,
	};

	await writeFile(join(path, "vault.json"), `${JSON.stringify(vaultJson, null, 2)}\n`, "utf8");
	await writeFile(
		join(path, "shell", "settings.json"),
		`${JSON.stringify({ version: 1 }, null, 2)}\n`,
		"utf8",
	);

	// Must precede setActiveVaultSession below — that triggers the boot seeder,
	// which this stamp makes no-op (see seedStarterContent on CreateVaultOptions).
	if (options.seedStarterContent === false) {
		await writeWelcomeSeedVersion(path, WELCOME_SEED_VERSION);
	}

	const entry: VaultEntry = {
		id,
		name: vaultJson.name,
		color: vaultJson.color,
		path,
		lastOpenedAt: now,
		format: VAULT_FORMAT_VERSION,
	};

	await persistEntry(entry, { setDefault: true });
	setActiveVaultSession(session);
	await appendAuditEvent(path, {
		kind: "vault.create",
		vaultId: entry.id,
		name: entry.name,
		format: entry.format,
		credentialsBackend: session.backend.name,
		identityFingerprint: session.identity.fingerprint,
	});
	return entry;
}

export async function openVault(path: string, options: OpenVaultOptions = {}): Promise<VaultEntry> {
	const vaultJsonPath = join(path, "vault.json");
	const raw = await readFile(vaultJsonPath, "utf8").catch(() => null);
	if (!raw) {
		throw new Error("Not a vault: vault.json missing");
	}
	const parsed = JSON.parse(raw) as unknown;
	if (!isVaultJson(parsed)) {
		throw new Error("Not a vault: vault.json is malformed");
	}

	assertVaultFormatSupported(parsed.format, VAULT_FORMAT_VERSION);
	assertVaultFormatNotPreFreeze(parsed.format, VAULT_FORMAT_VERSION);

	// Stage 10.8 — run forward-only vault-format migrations before the
	// at-rest reconcile so any persisted-side-effect bumps happen with
	// no live session in flight. Empty at 10.8 (the freeze itself is the
	// starting state); the runner is a no-op fast-path on a current vault.
	await migrateVaultToCurrent(path, parsed as unknown as Record<string, unknown>);

	// Stage 3b — probe + reconcile BEFORE opening any DB. Reconcile throws
	// fail-closed on a recorded-encrypted vault opening into a plaintext
	// environment (the silent-data-loss scenario); upgrades + first-stamps
	// continue and rewrite vault.json with the live mode at the end of open.
	const atRest = await probeAtRestMode();
	console.info(describeAtRestMode(atRest));
	const reconcile = reconcileAtRestMode(parsed.atRestMode, atRest, parsed.id);
	if (reconcile.outcome === AtRestReconcileOutcome.UpgradeReady) {
		console.info(
			`[brainstorm] storage: vault ${parsed.id} recorded as plaintext, driver is encrypted — upgrading on next DB open`,
		);
	}

	const session = await VaultSession.open(parsed.id, path, {
		...(options.keystore ?? {}),
		...(parsed.identityPublicKey ? { expectedPublicKeyBase64: parsed.identityPublicKey } : {}),
	});

	if (parsed.atRestMode !== reconcile.effectiveMode) {
		const refreshed: VaultJson = { ...parsed, atRestMode: reconcile.effectiveMode };
		await writeFile(vaultJsonPath, `${JSON.stringify(refreshed, null, 2)}\n`, "utf8");
	}

	const entry: VaultEntry = {
		id: parsed.id,
		name: parsed.name,
		color: parsed.color,
		path,
		lastOpenedAt: Date.now(),
		format: parsed.format,
	};

	await persistEntry(entry, { setDefault: true });
	setActiveVaultSession(session);
	await appendAuditEvent(path, {
		kind: "vault.open",
		vaultId: entry.id,
		format: entry.format,
		credentialsBackend: session.backend.name,
		identityFingerprint: session.identity.fingerprint,
	});
	return entry;
}

export async function activateVault(
	id: string,
	options: OpenVaultOptions = {},
): Promise<VaultEntry> {
	const registry = await readRegistry();
	const entry = registry.vaults.find((v) => v.id === id);
	if (!entry) throw new Error(`Vault ${id} not in registry`);

	if (!(await pathHasVaultJson(entry.path))) {
		await forgetVault(id);
		throw new Error(`Vault folder no longer exists at ${entry.path} — removed from the list.`);
	}

	entry.lastOpenedAt = Date.now();
	registry.defaultVaultId = id;

	// Stage 3b — same reconcile as `openVault`. Read + structurally
	// validate vault.json (matches openVault's `isVaultJson` gate, so a
	// wrong-case / typo'd `atRestMode` value fails LOUDLY as malformed
	// instead of silently degrading to FirstStamp and bypassing the
	// recorded-encrypted-but-driver-now-plaintext DowngradeRefused guard).
	// Then reconcile so a recorded-encrypted-but-driver-now-plaintext open
	// fails closed before any DB opens, regardless of which entry point
	// the shell uses.
	const vaultJsonPath = join(entry.path, "vault.json");
	const rawVaultJson = await readFile(vaultJsonPath, "utf8").catch(() => null);
	if (!rawVaultJson) {
		throw new Error(
			`Vault ${entry.id} vault.json could not be read at ${entry.path} (was present at pathHasVaultJson check moments ago; concurrent removal or permission flip).`,
		);
	}
	const parsedVaultJson = JSON.parse(rawVaultJson) as unknown;
	if (!isVaultJson(parsedVaultJson)) {
		throw new Error(`Vault ${entry.id} vault.json is malformed`);
	}
	assertVaultFormatSupported(parsedVaultJson.format, VAULT_FORMAT_VERSION);
	assertVaultFormatNotPreFreeze(parsedVaultJson.format, VAULT_FORMAT_VERSION);

	// Stage 10.8 — same migration sweep as `openVault`. Empty at 10.8;
	// the runner is a no-op fast-path on a current vault.
	await migrateVaultToCurrent(entry.path, parsedVaultJson as unknown as Record<string, unknown>);

	const recordedAtRestMode = parsedVaultJson.atRestMode;
	const atRest = await probeAtRestMode();
	console.info(describeAtRestMode(atRest));
	const reconcile = reconcileAtRestMode(recordedAtRestMode, atRest, entry.id);
	if (reconcile.outcome === AtRestReconcileOutcome.UpgradeReady) {
		console.info(
			`[brainstorm] storage: vault ${entry.id} recorded as plaintext, driver is encrypted — upgrading on next DB open`,
		);
	}

	// Registry write touches `<userData>/registry.json`; VaultSession.open
	// reads the vault's own folder + queries the keystore. Disjoint, so
	// running them in parallel shaves the registry-write off the boot
	// critical path. Audit event then fires fire-and-forget — it must
	// record but the caller doesn't need to block on the append.
	const [session] = await Promise.all([
		VaultSession.open(entry.id, entry.path, options.keystore ?? {}),
		writeRegistry(registry),
	]);

	// Run the stamp rewrite BEFORE setActiveVaultSession so a write
	// failure (disk full, EACCES) unwinds cleanly: the session object is
	// dropped, no IPC traffic ever sees a live-session-with-failed-open
	// inconsistency. Mirrors openVault's ordering (write before install).
	if (recordedAtRestMode !== reconcile.effectiveMode) {
		await rewriteVaultJsonAtRestMode(vaultJsonPath, rawVaultJson, reconcile.effectiveMode);
	}
	setActiveVaultSession(session);

	void appendAuditEvent(entry.path, {
		kind: "vault.activate",
		vaultId: entry.id,
		credentialsBackend: session.backend.name,
	}).catch((error) => {
		console.warn(`[brainstorm] vault.activate audit append failed: ${(error as Error).message}`);
	});
	return entry;
}

/**
 * Recover a vault that failed to open because a domain DB is corrupt — the
 * mutating half of doc 28's "Corrupted SQLite file" recovery (iteration 12.8),
 * invoked ONLY after the user confirms (policy: prompt before mutating). The
 * caller passes the corrupt `kind` carried by the failed `activateVault`'s
 * `VaultCorruptionError`. We archive that DB aside (never delete — see
 * `archiveCorruptDb`) and re-activate: migrations recreate the file empty, and
 * for `entities` the session-open backfill repopulates it from the KV/Yjs
 * sources. `ledger`/`registry` start fresh (grants / vault metadata reset — the
 * "re-initialize" branch the user chose over restore-from-backup). If a SECOND
 * DB is also corrupt, the re-activate throws `VaultCorruptionError` again so the
 * caller can prompt for the next one.
 */
export async function recoverCorruptVault(
	id: string,
	kind: DataStoreKind,
	now: number = Date.now(),
): Promise<VaultEntry> {
	const registry = await readRegistry();
	const entry = registry.vaults.find((v) => v.id === id);
	if (!entry) throw new Error(`Vault ${id} not in registry`);
	await archiveCorruptDb(entry.path, kind, now);
	return activateVault(id);
}

/**
 * Recover the list of vaults the registry has forgotten — doc 28's "Vault
 * registry corrupted" scenario (iteration 12.8). Scans the standard vault
 * root + any paths salvaged from the corrupt registry for directories that
 * carry a valid `vault.json`, then drops any whose id is already registered
 * (so the picker only offers genuinely-missing vaults to "Add back"). Pure
 * read; the user re-registers a candidate via `openVault` (the existing
 * register-and-open path). Best-effort: never throws.
 */
export async function scanForRecoveredVaults(): Promise<VaultEntry[]> {
	const registry = await readRegistry();
	const registered = new Set(registry.vaults.map((v) => v.id));
	const knownPaths = await salvageRegistryPaths();
	const found = await productionScanForVaults(knownPaths);
	return found.filter((v) => !registered.has(v.id));
}

/**
 * Drop a vault entry from the local registry. Does NOT touch on-disk vault
 * data — purely a "remove from this device's list of vaults" operation. If
 * the forgotten vault is the active session, the session is closed.
 */
export async function forgetVault(id: string): Promise<void> {
	const registry = await readRegistry();
	const beforeLength = registry.vaults.length;
	registry.vaults = registry.vaults.filter((v) => v.id !== id);
	if (registry.defaultVaultId === id) {
		registry.defaultVaultId = registry.vaults[0]?.id ?? null;
	}
	if (registry.vaults.length === beforeLength) return;
	await writeRegistry(registry);
	const active = getActiveVaultSession();
	if (active && active.vaultId === id) {
		closeActiveVaultSession();
	}
}

async function persistEntry(
	entry: VaultEntry,
	options: { setDefault: boolean },
): Promise<Registry> {
	const registry = await readRegistry();
	const existing = registry.vaults.findIndex((v) => v.id === entry.id);
	if (existing >= 0) {
		registry.vaults[existing] = entry;
	} else {
		registry.vaults.push(entry);
	}
	if (options.setDefault) {
		registry.defaultVaultId = entry.id;
	} else if (!registry.defaultVaultId) {
		registry.defaultVaultId = entry.id;
	}
	registry.version = REGISTRY_VERSION;
	await writeRegistry(registry);
	return registry;
}

/**
 * OS-generated metadata files that routinely appear in "empty" folders and
 * must not count as real content when deciding whether a target folder is
 * usable for a new vault. Windows drops `desktop.ini` into Downloads /
 * OneDrive-synced folders (and `Thumbs.db` for image thumbnails); macOS drops
 * `.DS_Store`. Treating these as content wrongly rejected a freshly-made
 * folder with "Directory is not empty" — the exact Windows-Downloads report.
 */
const IGNORABLE_DIR_ENTRIES = new Set(["desktop.ini", "thumbs.db", ".ds_store"]);

async function ensureDirectoryUsable(path: string): Promise<void> {
	try {
		const info = await stat(path);
		if (!info.isDirectory()) {
			throw new Error(`Not a directory: ${path}`);
		}
		const entries = await readdir(path);
		const meaningful = entries.filter((entry) => !IGNORABLE_DIR_ENTRIES.has(entry.toLowerCase()));
		if (meaningful.length > 0 && !meaningful.includes("vault.json")) {
			throw new Error(`Directory is not empty: ${path}`);
		}
	} catch (error) {
		if (isNotFound(error)) {
			await mkdir(path, { recursive: true });
			return;
		}
		throw error;
	}
}

/**
 * Rewrite vault.json's `atRestMode` field while preserving every other key
 * verbatim. Used by `activateVault` on a mode upgrade — we don't want to
 * clobber unknown forward-compat fields a future shell version may have
 * stamped.
 */
async function rewriteVaultJsonAtRestMode(
	path: string,
	rawJson: string,
	mode: AtRestMode,
): Promise<void> {
	const parsed = JSON.parse(rawJson) as Record<string, unknown>;
	parsed.atRestMode = mode;
	await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

function isVaultJson(value: unknown): value is VaultJson {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<VaultJson>;
	return (
		typeof v.id === "string" &&
		typeof v.name === "string" &&
		typeof v.color === "string" &&
		typeof v.format === "string" &&
		typeof v.createdAt === "number" &&
		(v.atRestMode === undefined || isAtRestMode(v.atRestMode)) &&
		(v.syncRelay === undefined || isSyncRelayConfig(v.syncRelay))
	);
}

/**
 * Stage 10.5c — atomic mutator for `vault.json.syncRelay`. Writes a
 * tempfile and renames so a power-loss in mid-write can never leave a
 * truncated JSON file. Passing `null` (or omitting the field) clears
 * the relay configuration (returns the vault to local-only mode).
 *
 * **Idempotent**: setting the same `{url, addedAt}` is a no-op (no
 * port flap downstream). The `addedAt` comparison is exact — a caller
 * that rewrites with a fresh timestamp counts as a "change" and
 * triggers `activeRelay.reconfigure()`. Tests use this contract to
 * pin the no-flap path.
 *
 * **Preserves unknown fields** (`atRestMode`, `identityPublicKey`,
 * any future forward-compat additions). The mutator reads the live
 * file, mutates only the `syncRelay` key, and writes back.
 *
 * Returns the effective new `SyncRelayConfig` (or `null` if cleared).
 */
export async function setSyncRelayConfig(
	vaultPath: string,
	config: SyncRelayConfig | null,
): Promise<{ changed: boolean; effective: SyncRelayConfig | null }> {
	const file = join(vaultPath, "vault.json");
	const raw = await readFile(file, "utf8");
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const before = parsed.syncRelay;
	const current = isSyncRelayConfig(before) ? before : null;
	if (config !== null && !isSyncRelayConfig(config)) {
		throw new Error("setSyncRelayConfig: invalid SyncRelayConfig (empty url or non-finite addedAt)");
	}
	if (configsEqual(current, config)) {
		return { changed: false, effective: current };
	}
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (key === "syncRelay") continue;
		next[key] = value;
	}
	if (config !== null) {
		next.syncRelay = { url: config.url, addedAt: config.addedAt };
	}
	const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
	await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	const { rename } = await import("node:fs/promises");
	await rename(tmp, file);
	// Notify the live transport orchestrator so a relay flip happens
	// inside this turn. Lazy-import to keep the relay-blind audit happy:
	// vault.ts already imports session.ts (which imports identity/crypto),
	// so going through the orchestrator's module-level singleton is safe
	// here (no new audit-fence violation; the orchestrator itself is the
	// fence-gated file, not vault.ts).
	try {
		const { getActiveRelay } = await import("../sync/active-relay");
		const relay = getActiveRelay();
		if (relay) await relay.reconfigure();
	} catch (error) {
		console.warn(
			`[brainstorm] setSyncRelayConfig: post-write reconfigure failed: ${(error as Error).message}`,
		);
	}
	return { changed: true, effective: config };
}

function configsEqual(a: SyncRelayConfig | null, b: SyncRelayConfig | null): boolean {
	if (a === null && b === null) return true;
	if (a === null || b === null) return false;
	return a.url === b.url && a.addedAt === b.addedAt;
}

/**
 * Strict-shape validator for the optional `syncRelay` field. Rejects
 * empty URL strings + non-finite `addedAt`. A malformed `syncRelay`
 * fails the parent `isVaultJson` check so `openVault` throws "Not a
 * vault: vault.json is malformed" — fail-loud, mirrors the
 * `atRestMode` precedent.
 */
export function isSyncRelayConfig(value: unknown): value is SyncRelayConfig {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<SyncRelayConfig>;
	return (
		typeof v.url === "string" &&
		v.url.length > 0 &&
		typeof v.addedAt === "number" &&
		Number.isFinite(v.addedAt)
	);
}

const FALLBACK_COLOR = "#7c3aed";

function pickColor(seed: string): string {
	let hash = 0;
	for (let i = 0; i < seed.length; i++) {
		hash = (hash << 5) - hash + seed.charCodeAt(i);
		hash |= 0;
	}
	const index = Math.abs(hash) % DEFAULT_COLORS.length;
	return DEFAULT_COLORS[index] ?? FALLBACK_COLOR;
}

async function pathHasVaultJson(path: string): Promise<boolean> {
	try {
		const info = await stat(join(path, "vault.json"));
		return info.isFile();
	} catch {
		return false;
	}
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code: unknown }).code === "ENOENT"
	);
}
