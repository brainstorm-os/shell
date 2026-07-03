/**
 * VaultSession — the in-memory state for an opened vault.
 *
 * Owns:
 *   - The keystore backend (per-vault choice, recorded in vault.json).
 *   - The vault master key (32 bytes; held until vault close, then zeroed).
 *   - The identity public key + fingerprint (signing is mediated via
 *     `signPayload` — the private key never leaves the main process).
 *   - The credential store (Tier 2; encrypted JSON file under the master key).
 *
 * Lifecycle per §Specific secrets:
 *
 *   Vault create:
 *     1. Pick a keystore backend (keyring → passphrase fallback → insecure dev).
 *     2. Generate Ed25519 identity + 32-byte vault master key.
 *     3. Store both in the keystore under `brainstorm.<vault-id>.{identity,master}`.
 *     4. Record public key, fingerprint, and active backend in vault.json.
 *
 *   Vault open:
 *     1. Read vault.json — determine which backend recorded the secrets.
 *     2. Load identity + master from keystore.
 *     3. Verify the loaded identity public key matches the one recorded in
 *        vault.json (catches tampering or wrong-keystore scenarios).
 *
 *   Vault close:
 *     1. Zero the master key buffer.
 *     2. Drop the identity secret reference.
 *     3. Dispose the keystore backend (passphrase wrap key is zeroed).
 */

import { join } from "node:path";
import type { UnlockResult } from "../../shared/app-lock-wire-types";
import { AiUsageRepository } from "../ai/ai-usage-repo";
import { AssetDekStore } from "../assets/asset-dek-store";
import { AssetStore } from "../assets/asset-store";
import {
	VaultMediaDomain,
	deriveMediaKey,
	openMedia as openMediaBlob,
	sealMedia as sealMediaBlob,
} from "../assets/vault-media-crypto";
import { migrateMediaDir } from "../assets/vault-media-migrate";
import { AccountRepository } from "../billing/account-repo";
import { BillingService } from "../billing/billing-service";
import { CreditLedgerRepository } from "../billing/credit-ledger-repo";
import { EntitlementRepository } from "../billing/entitlement-repo";
import { applyShellGrants } from "../capabilities/default-grants";
import { CapabilityLedger } from "../capabilities/ledger";
import {
	clearAppLockPin,
	hasAppLockPin,
	setAppLockPin,
	verifyAppLockPin,
} from "../credentials/app-lock-pin";
import { generateSymmetricKey } from "../credentials/crypto";
import {
	type DeviceEd25519Keypair,
	publicKeyFromSecret as deriveDeviceEd25519Public,
	publicKeyToBase64 as deviceEd25519PublicToBase64,
	generateDeviceEd25519,
	signWithDeviceKey,
} from "../credentials/device-ed25519";
import {
	type DeviceX25519Keypair,
	publicKeyFromSecret as deriveX25519Public,
	generateDeviceX25519,
	publicKeyToBase64 as x25519PublicToBase64,
} from "../credentials/device-x25519";
import {
	type IdentityKeypair,
	signPayload as ed25519Sign,
	fingerprintPublicKey,
	generateIdentity,
	publicKeyFromBase64,
	publicKeyFromSecret,
	publicKeyToBase64,
} from "../credentials/identity";
import {
	type KeystoreBackend,
	type KeystoreBackendName,
	type PickKeystoreOptions,
	pickKeystore,
} from "../credentials/keystore";
import {
	type MemberWrapPayload,
	unwrapDekAndTypeForRecipient,
	unwrapDekForRecipient,
} from "../credentials/member-wraps";
import { type CredentialKey, type CredentialMetadata, CredentialStore } from "../credentials/store";
import { DashboardStore } from "../dashboard/dashboard-store";
import { EntityDekStore } from "../entities/entity-dek-store";
import { FileHandleRegistry } from "../files/file-handle-registry";
import type { VaultNetworkSettings } from "../network/privacy-config";
import { PropertiesStore } from "../properties/properties-store";
import { DataStores } from "../storage/data-stores";
import {
	AssetDeksRepository,
	AssetsRepository,
	EntitiesRepository,
	EntityDeksRepository,
} from "../storage/entities-repo";
import { YDocStore } from "../storage/ydoc-store";
import { appLockCooldownMs, isAppLockCapped } from "./app-lock-policy";
import { readAppLockSettings, writeAppLockSettings } from "./app-lock-settings";
import {
	readVaultNetworkSettings,
	writeVaultNetworkSettings,
} from "./vault-network-settings-store";

/**
 * Canonical entity type of the vault's root container — the single
 * `brainstorm/Folder/v1` every folder/file hangs off (per
 * ). Kept here, not app-side, so
 * the bootstrap and any future shell consumer share one literal.
 */
export const ROOT_FOLDER_TYPE = "brainstorm/Folder/v1";

/**
 * Well-known, deterministic id of the vault root Folder. A fixed id (not
 * a random one persisted in vault metadata) makes the bootstrap idempotent
 * with a single `repo.get(id)` probe and lets any reader resolve the root
 * without an extra lookup table — the same stable-id strategy the kv→
 * entities bridge uses for migrated rows. Entity ids are local opaque
 * strings (§Decision), so a constant is a valid id.
 */
export const ROOT_FOLDER_ENTITY_ID = "brainstorm/root-folder/v1";

/** `created_by` stamp for shell-provisioned entities (not any app). */
const SHELL_ACTOR = "brainstorm.shell";

export type RootFolderBootstrapResult = {
	/** The resolved root Folder id (always `ROOT_FOLDER_ENTITY_ID`). */
	rootId: string;
	/** True only on the open that first created the row. */
	created: boolean;
};

export type VaultIdentity = {
	publicKey: Uint8Array;
	publicKeyBase64: string;
	fingerprint: string;
};

/** The device's X25519 keypair (Stage 10.2). The secret never leaves the
 *  main process — apps that need to decrypt a member wrap call
 *  `unwrapMemberWrap` and receive the plaintext DEK, not the secret. */
export type DeviceX25519Identity = {
	publicKey: Uint8Array;
	publicKeyBase64: string;
};

/** The device's Ed25519 signing keypair (Stage 10.5a). Per-device, separate
 *  from the sovereign user-Ed25519 key (`identity`) and from the HPKE
 *  recipient X25519 key. Used by the pairing handshake to sign device-
 *  attributed bytes; the secret never leaves the main process. */
export type DeviceEd25519Identity = {
	publicKey: Uint8Array;
	publicKeyBase64: string;
};

export type VaultSessionMeta = {
	vaultId: string;
	vaultPath: string;
	backend: KeystoreBackendName;
	backendDescription: string;
	backendIsInsecure: boolean;
	identity: { publicKeyBase64: string; fingerprint: string };
	deviceX25519: { publicKeyBase64: string };
	deviceEd25519: { publicKeyBase64: string };
};

export type OpenSessionOptions = {
	expectedPublicKeyBase64?: string;
} & Omit<PickKeystoreOptions, "vaultPath">;

export type CreateSessionOptions = {
	vaultId: string;
	vaultPath: string;
} & Omit<PickKeystoreOptions, "vaultPath">;

export class VaultSession {
	readonly vaultId: string;
	readonly vaultPath: string;
	readonly backend: KeystoreBackend;
	readonly identity: VaultIdentity;
	readonly deviceX25519: DeviceX25519Identity;
	readonly deviceEd25519: DeviceEd25519Identity;
	readonly credentials: CredentialStore;
	readonly dataStores: DataStores;
	readonly ydocStore: YDocStore;
	/**
	 * Per-vault `FileHandle` registry (9.10). Lives in-memory only — handles
	 * are session-stable but never persisted (a vault close re-grants on
	 * next pick). Apps that hold one across a restart re-request via
	 * `files.requestOpen` — the user's grant is the load-bearing audit
	 * surface, not a serialised token.
	 */
	readonly fileHandles = new FileHandleRegistry();

	private masterKey: Uint8Array;
	private identitySecret: Uint8Array;
	private deviceX25519Secret: Uint8Array;
	private deviceEd25519Secret: Uint8Array;
	private cachedLedger: CapabilityLedger | null = null;
	private cachedBilling: BillingService | null = null;
	private cachedBillingRepos: {
		accounts: AccountRepository;
		entitlements: EntitlementRepository;
	} | null = null;
	private cachedAiUsage: AiUsageRepository | null = null;
	private cachedCreditLedger: CreditLedgerRepository | null = null;
	private cachedDashboard: DashboardStore | null = null;
	private dashboardOpening: Promise<DashboardStore> | null = null;
	private cachedProperties: PropertiesStore | null = null;
	private propertiesOpening: Promise<PropertiesStore> | null = null;
	private cachedDekStore: EntityDekStore | null = null;
	private dekStoreOpening: Promise<EntityDekStore> | null = null;
	private cachedAssetStore: AssetStore | null = null;
	private assetStoreOpening: Promise<AssetStore> | null = null;
	private cachedAssetDekStore: AssetDekStore | null = null;
	private assetDekStoreOpening: Promise<AssetDekStore> | null = null;
	/** Deterministic media at-rest key (OQ-240), derived lazily from the master
	 *  key and zeroed on dispose. Encrypts the content-addressed cover/icon/
	 *  wallpaper blobs that were the last plaintext-on-disk binary stores. */
	private cachedMediaKey: Uint8Array | null = null;
	private cachedNetworkSettings: VaultNetworkSettings | null = null;
	private networkSettingsOpening: Promise<VaultNetworkSettings> | null = null;
	private readonly networkSettingsListeners = new Set<
		(next: VaultNetworkSettings, previous: VaultNetworkSettings | null) => void
	>();
	private disposed = false;
	// Soft-lock flag (Stage 13.8). Only set on the passphrase backend, where the
	// master key stays resident (no cheap PIN-gated re-read) — the lock is the
	// overlay + PIN gate. Keyring/insecure backends hard-lock instead (the
	// session is disposed + re-opened), so they never carry this flag.
	private locked = false;

	private constructor(args: {
		vaultId: string;
		vaultPath: string;
		backend: KeystoreBackend;
		identity: VaultIdentity;
		identitySecret: Uint8Array;
		deviceX25519: DeviceX25519Identity;
		deviceX25519Secret: Uint8Array;
		deviceEd25519: DeviceEd25519Identity;
		deviceEd25519Secret: Uint8Array;
		masterKey: Uint8Array;
	}) {
		this.vaultId = args.vaultId;
		this.vaultPath = args.vaultPath;
		this.backend = args.backend;
		this.identity = args.identity;
		this.identitySecret = args.identitySecret;
		this.deviceX25519 = args.deviceX25519;
		this.deviceX25519Secret = args.deviceX25519Secret;
		this.deviceEd25519 = args.deviceEd25519;
		this.deviceEd25519Secret = args.deviceEd25519Secret;
		this.masterKey = args.masterKey;
		this.credentials = new CredentialStore(args.vaultPath, this.masterKey);
		// DataStores derives a per-DB at-rest key from the master key (HKDF)
		// and keeps only a defensive copy zeroed on close; it never aliases
		// the session's buffer (which is zeroed on dispose).
		this.dataStores = new DataStores(args.vaultPath, { masterKey: this.masterKey });
		this.ydocStore = new YDocStore(args.vaultPath);
	}

	/**
	 * Lazily open `ledger.db` and return the CapabilityLedger backed by it.
	 * Cached after first call. The broker's checkCapability closure calls
	 * this on every IPC dispatch — first call opens the DB + applies shell
	 * grants, subsequent calls are O(1).
	 */
	async capabilityLedger(): Promise<CapabilityLedger> {
		this.assertOpen();
		if (this.cachedLedger) return this.cachedLedger;
		const db = await this.dataStores.open("ledger");
		const ledger = new CapabilityLedger(db);
		applyShellGrants(ledger);
		this.cachedLedger = ledger;
		return ledger;
	}

	/**
	 * Lazily open `account.db` and return the `BillingService` backed by it
	 * (14.1). Reads the per-device account link + cached entitlement; v1 reports
	 * the hardcoded Free entitlement when nothing is cached.
	 */
	async billingService(): Promise<BillingService> {
		this.assertOpen();
		if (this.cachedBilling) return this.cachedBilling;
		const { accounts, entitlements } = await this.billingRepos();
		const service = new BillingService(accounts, entitlements);
		this.cachedBilling = service;
		return service;
	}

	/** Lazily open `account.db` and return the per-app AI usage accounting repo
	 *  (14.8). Cached — the broker's budget gate reads it on every AI call. */
	async aiUsageRepo(): Promise<AiUsageRepository> {
		this.assertOpen();
		if (this.cachedAiUsage) return this.cachedAiUsage;
		const db = await this.dataStores.open("account");
		const repo = new AiUsageRepository(db);
		this.cachedAiUsage = repo;
		return repo;
	}

	/** Lazily open `account.db` and return the bundled-AI-credit ledger (14.8). */
	async aiCreditLedger(): Promise<CreditLedgerRepository> {
		this.assertOpen();
		if (this.cachedCreditLedger) return this.cachedCreditLedger;
		const db = await this.dataStores.open("account");
		const repo = new CreditLedgerRepository(db);
		this.cachedCreditLedger = repo;
		return repo;
	}

	/**
	 * The raw `account.db` repos behind `billingService()` — the 14.6
	 * `BillingAccountService` (Settings → Billing) writes the account link /
	 * clears the entitlement cache through these. Same lazy open, shared cache.
	 */
	async billingRepos(): Promise<{
		accounts: AccountRepository;
		entitlements: EntitlementRepository;
	}> {
		this.assertOpen();
		if (this.cachedBillingRepos) return this.cachedBillingRepos;
		const db = await this.dataStores.open("account");
		this.cachedBillingRepos = {
			accounts: new AccountRepository(db),
			entitlements: new EntitlementRepository(db),
		};
		return this.cachedBillingRepos;
	}

	/**
	 * Lazily open the dashboard Yjs doc (one per vault). Concurrent callers
	 * share the in-flight open promise to avoid two readers racing on the
	 * same on-disk file.
	 */
	async dashboardStore(): Promise<DashboardStore> {
		this.assertOpen();
		if (this.cachedDashboard) return this.cachedDashboard;
		if (this.dashboardOpening) return this.dashboardOpening;
		this.dashboardOpening = DashboardStore.open(this.ydocStore).then((store) => {
			this.cachedDashboard = store;
			this.dashboardOpening = null;
			return store;
		});
		return this.dashboardOpening;
	}

	/** The already-open dashboard store, or null if it hasn't been opened yet.
	 *  Synchronous — used by the notification host, which must read prefs +
	 *  append history inside a synchronous `post()` (the broker handler can't
	 *  await). The store is opened on first dashboard render, so it's resolved
	 *  well before apps start posting in practice. */
	dashboardStoreIfOpen(): DashboardStore | null {
		return this.cachedDashboard ?? null;
	}

	/**
	 * Lazily open the vault-level properties Yjs doc (one per vault).
	 * Concurrent callers share the in-flight open promise to avoid two
	 * readers racing on the same on-disk file — same pattern as
	 * `dashboardStore()`.
	 */
	async propertiesStore(): Promise<PropertiesStore> {
		this.assertOpen();
		if (this.cachedProperties) return this.cachedProperties;
		if (this.propertiesOpening) return this.propertiesOpening;
		// Reset the in-flight slot on BOTH outcomes. Without the `.catch`
		// reset, a single transient open failure leaves `propertiesOpening`
		// a permanently-rejected promise that every later caller awaits —
		// `properties.list()` then rejects forever and the catalog reads
		// empty for the rest of the session with no recovery. (Mirrors the
		// dashboardStore() lazy-open contract.)
		this.propertiesOpening = PropertiesStore.open(this.ydocStore).then(
			(store) => {
				this.cachedProperties = store;
				this.propertiesOpening = null;
				return store;
			},
			(error) => {
				this.propertiesOpening = null;
				throw error;
			},
		);
		return this.propertiesOpening;
	}

	/**
	 * Per-vault `EntityDekStore` (Stage 10.1) — mints + persists the
	 * sealed DEK that backs every entity created through the entities
	 * service. Lazily constructed; reuses the cached `entities.db` handle.
	 * The master key is passed by reference (aliasing the session's
	 * `this.masterKey` buffer) so the in-place zero on dispose propagates
	 * to the store without a separate teardown. **Future-self note**:
	 * never replace this with `new Uint8Array(this.masterKey)` — a
	 * defensive copy decouples from the in-place zero and re-introduces a
	 * key-plaintext-retention hazard.
	 *
	 * Mirrors the `propertiesStore` / `dashboardStore` in-flight-promise
	 * idiom: concurrent first-callers race onto a shared open Promise so
	 * two repos + two statement caches are never built and orphaned.
	 */
	async entityDekStore(): Promise<EntityDekStore> {
		this.assertOpen();
		if (this.cachedDekStore) return this.cachedDekStore;
		if (this.dekStoreOpening) return this.dekStoreOpening;
		this.dekStoreOpening = this.dataStores.open("entities").then(
			(db) => {
				const deks = new EntityDeksRepository(db);
				const store = new EntityDekStore(deks, this.masterKey);
				this.cachedDekStore = store;
				this.dekStoreOpening = null;
				return store;
			},
			(error) => {
				this.dekStoreOpening = null;
				throw error;
			},
		);
		return this.dekStoreOpening;
	}

	/**
	 * Per-vault `AssetStore` — encrypted binary-asset persistence (favicon /
	 * cover / future uploads). Lazily constructed on the cached `entities.db`
	 * handle; the per-asset DEKs ride the same master key (by reference, like
	 * `entityDekStore` — never a defensive copy, so the dispose-time zero
	 * propagates). Blobs live at `<vaultPath>/data/assets/`. Same in-flight
	 * Promise idiom so concurrent first-callers share one open.
	 */
	async assetStore(): Promise<AssetStore> {
		this.assertOpen();
		if (this.cachedAssetStore) return this.cachedAssetStore;
		if (this.assetStoreOpening) return this.assetStoreOpening;
		// Two awaits (entities.db + the shared AssetDekStore), so the in-flight
		// promise is built in an async IIFE with a `finally` reset — a rejection
		// from EITHER await must clear `assetStoreOpening` or a poisoned rejected
		// promise would be returned to every later caller (no self-heal). The
		// `.then(onF, onRej)` shape used by the single-await accessors can't catch
		// a rejection thrown inside an async onF, so it is not reused here.
		this.assetStoreOpening = (async () => {
			try {
				const db = await this.dataStores.open("entities");
				const dekStore = await this.assetDekStore();
				const store = new AssetStore(
					new AssetsRepository(db),
					dekStore,
					join(this.vaultPath, "data", "assets"),
					(fn) => db.transaction(fn)(),
				);
				this.cachedAssetStore = store;
				return store;
			} finally {
				this.assetStoreOpening = null;
			}
		})();
		return this.assetStoreOpening;
	}

	/**
	 * Per-vault `AssetDekStore` — the master-key wrap layer for per-asset DEKs.
	 * Shared by `assetStore()` (the at-rest seal/open) and the Asset-B1 re-home
	 * pass (which reads the master-key DEK to re-seal it under the entity DEK).
	 * The master key rides by reference (zeroed on dispose), same as
	 * `entityDekStore`. One instance per session via the in-flight-Promise idiom.
	 */
	async assetDekStore(): Promise<AssetDekStore> {
		this.assertOpen();
		if (this.cachedAssetDekStore) return this.cachedAssetDekStore;
		if (this.assetDekStoreOpening) return this.assetDekStoreOpening;
		this.assetDekStoreOpening = this.dataStores.open("entities").then(
			(db) => {
				const store = new AssetDekStore(new AssetDeksRepository(db), this.masterKey);
				this.cachedAssetDekStore = store;
				this.assetDekStoreOpening = null;
				return store;
			},
			(error) => {
				this.assetDekStoreOpening = null;
				throw error;
			},
		);
		return this.assetDekStoreOpening;
	}

	/** The deterministic media at-rest key, derived once from the master key
	 *  (OQ-240). The master key buffer is the live one (zeroed on dispose), so
	 *  the derived key is computed fresh and cached here, then zeroed on dispose. */
	private mediaAtRestKey(): Uint8Array {
		this.assertOpen();
		if (!this.cachedMediaKey) this.cachedMediaKey = deriveMediaKey(this.masterKey);
		return this.cachedMediaKey;
	}

	/** Seal a media blob (cover/icon/wallpaper) for at-rest storage. `relName`
	 *  is the on-disk filename; it binds the ciphertext via AAD. */
	sealMedia(domain: VaultMediaDomain, relName: string, bytes: Uint8Array): Uint8Array {
		return sealMediaBlob(this.mediaAtRestKey(), domain, relName, bytes);
	}

	/** Open a sealed media blob. Satisfies the serve path's `MediaUnsealer`. */
	openMedia(domain: VaultMediaDomain, relName: string, blob: Uint8Array): Uint8Array {
		return openMediaBlob(this.mediaAtRestKey(), domain, relName, blob);
	}

	/** One-time idempotent re-seal of any legacy plaintext media files
	 *  (OQ-240). Best-effort; logs a summary. Safe to call on every open. */
	async migrateMediaAtRest(): Promise<void> {
		const key = this.mediaAtRestKey();
		let total = 0;
		for (const domain of Object.values(VaultMediaDomain)) {
			total += await migrateMediaDir(this.vaultPath, domain, key);
		}
		if (total > 0) {
			console.log(`[brainstorm] media at-rest: sealed ${total} legacy plaintext file(s)`);
		}
	}

	/**
	 * Lazily load the per-vault `VaultNetworkSettings` (Net-1e) — the
	 * combined link-preview privacy policy + optional proxy override
	 * persisted at `<vaultPath>/shell/network-settings.json`. First read
	 * applies the default-on-first-read contract (default flips to Off
	 * on privacy-strict paths per OQ-163). Subsequent reads are O(1).
	 *
	 * Concurrent first-callers share the in-flight Promise so two
	 * parallel `vault:network-settings:get` IPC calls don't race two
	 * file reads (mirrors the `propertiesStore` / `dashboardStore`
	 * lazy-open idiom).
	 */
	async vaultNetworkSettings(): Promise<VaultNetworkSettings> {
		this.assertOpen();
		if (this.cachedNetworkSettings) return this.cachedNetworkSettings;
		if (this.networkSettingsOpening) return this.networkSettingsOpening;
		this.networkSettingsOpening = readVaultNetworkSettings(this.vaultPath).then(
			(settings) => {
				this.cachedNetworkSettings = settings;
				this.networkSettingsOpening = null;
				return settings;
			},
			(error) => {
				this.networkSettingsOpening = null;
				throw error;
			},
		);
		return this.networkSettingsOpening;
	}

	/** Synchronous read of the cached settings. Returns null if the
	 *  async load hasn't happened yet — callers that need the value
	 *  pre-flighted (e.g. the network handler's `getPrivacyConfig`
	 *  reader) should call `vaultNetworkSettings()` once at vault-open
	 *  time, then this sync read on every IPC. */
	get cachedVaultNetworkSettings(): VaultNetworkSettings | null {
		return this.cachedNetworkSettings;
	}

	/** Validate + persist the new settings, refresh the in-memory cache,
	 *  and notify subscribers (the `vault:network-settings:set` IPC
	 *  handler + the preview-cache invalidator wire here). */
	async setVaultNetworkSettings(next: VaultNetworkSettings): Promise<void> {
		this.assertOpen();
		const previous = this.cachedNetworkSettings;
		await writeVaultNetworkSettings(this.vaultPath, next);
		this.cachedNetworkSettings = next;
		for (const listener of this.networkSettingsListeners) {
			try {
				listener(next, previous);
			} catch (error) {
				console.warn("[brainstorm] vault-network-settings listener threw:", error);
			}
		}
	}

	/** Subscribe to per-vault settings changes — fires after `set`
	 *  resolves so listeners see the post-change state. Returns an
	 *  unsubscribe. */
	onVaultNetworkSettingsChanged(
		listener: (next: VaultNetworkSettings, previous: VaultNetworkSettings | null) => void,
	): () => void {
		this.networkSettingsListeners.add(listener);
		return () => {
			this.networkSettingsListeners.delete(listener);
		};
	}

	/**
	 * Ensure the vault's canonical root `brainstorm/Folder/v1` exists in
	 * `entities.db`, creating it on first open and resolving to it on every
	 * subsequent open. This is what makes the Files app non-empty: the
	 * renderer binds its synthetic root to this real Folder so a brand-new
	 * vault shows an addressable (empty) container instead of nothing.
	 *
	 * Idempotent: a single `repo.get(ROOT_FOLDER_ENTITY_ID)` probe — present
	 * means a prior open (or a user edit) already owns the row and it is
	 * left untouched (no-clobber, same contract as the kv→entities bridge).
	 * Fail-safe: any storage error is swallowed and surfaced as
	 * `created: false` — the root bootstrap must never reject the vault-open
	 * path. Lazily opens `entities.db` via the shared cached handle, so the
	 * cost after the first call is one indexed primary-key lookup.
	 */
	async ensureRootFolder(now: number = Date.now()): Promise<RootFolderBootstrapResult> {
		this.assertOpen();
		try {
			const db = await this.dataStores.open("entities");
			const repo = new EntitiesRepository(db);
			if (repo.get(ROOT_FOLDER_ENTITY_ID)) {
				return { rootId: ROOT_FOLDER_ENTITY_ID, created: false };
			}
			// Shell-internal singleton: no DEK row yet. Stage 10.1's at-rest
			// wrap is for entities created through the entities IPC service;
			// the root folder is shell-stamped and never sync-encrypted on
			// its own (its contents are individually-encrypted entities).
			repo.create({
				id: ROOT_FOLDER_ENTITY_ID,
				type: ROOT_FOLDER_TYPE,
				properties: { name: "Vault", members: [] },
				createdBy: SHELL_ACTOR,
				now,
				dekId: null,
			});
			return { rootId: ROOT_FOLDER_ENTITY_ID, created: true };
		} catch (error) {
			console.warn(`[brainstorm] root-folder bootstrap failed: ${(error as Error).message}`);
			return { rootId: ROOT_FOLDER_ENTITY_ID, created: false };
		}
	}

	/** Create a fresh session — generates a new identity, device X25519
	 *  + device Ed25519 keypairs, and a master key. All four are persisted
	 *  under the picked keystore backend so a later `open()` finds them. */
	static async create(options: CreateSessionOptions): Promise<VaultSession> {
		const { vaultId, vaultPath, ...keystoreOptions } = options;
		const backend = await pickKeystore({ vaultPath, ...keystoreOptions });
		const identityPair = generateIdentity();
		const devicePair = generateDeviceX25519();
		const deviceEdPair = generateDeviceEd25519();
		const masterKey = generateSymmetricKey();

		await backend.setSecret(vaultId, "identity", identityPair.secretKey);
		await backend.setSecret(vaultId, "master", masterKey);
		await backend.setSecret(vaultId, "device-x25519", devicePair.secretKey);
		await backend.setSecret(vaultId, "device-ed25519", deviceEdPair.secretKey);

		const identity: VaultIdentity = {
			publicKey: identityPair.publicKey,
			publicKeyBase64: publicKeyToBase64(identityPair.publicKey),
			fingerprint: fingerprintPublicKey(identityPair.publicKey),
		};
		const deviceX25519: DeviceX25519Identity = {
			publicKey: devicePair.publicKey,
			publicKeyBase64: x25519PublicToBase64(devicePair.publicKey),
		};
		const deviceEd25519: DeviceEd25519Identity = {
			publicKey: deviceEdPair.publicKey,
			publicKeyBase64: deviceEd25519PublicToBase64(deviceEdPair.publicKey),
		};
		return new VaultSession({
			vaultId,
			vaultPath,
			backend,
			identity,
			identitySecret: identityPair.secretKey,
			deviceX25519,
			deviceX25519Secret: devicePair.secretKey,
			deviceEd25519,
			deviceEd25519Secret: deviceEdPair.secretKey,
			masterKey,
		});
	}

	/** Open an existing vault — loads identity, master, and device X25519
	 *  from the keystore. Vaults created before 10.2 don't carry a
	 *  `device-x25519` entry; on first open after upgrade we lazy-mint +
	 *  persist one (no migration prompt, idempotent). */
	static async open(
		vaultId: string,
		vaultPath: string,
		options: OpenSessionOptions = {},
	): Promise<VaultSession> {
		const { expectedPublicKeyBase64, ...keystoreOptions } = options;
		const backend = await pickKeystore({ vaultPath, ...keystoreOptions });

		// All four secrets live under separate keys in the same backend
		// — fetch in parallel. On the macOS keychain backend the round-
		// trip is the dominant cost on the boot critical path.
		const [identitySecret, masterKey, deviceX25519Secret, deviceEd25519Secret] = await Promise.all([
			backend.getSecret(vaultId, "identity"),
			backend.getSecret(vaultId, "master"),
			backend.getSecret(vaultId, "device-x25519"),
			backend.getSecret(vaultId, "device-ed25519"),
		]);
		if (!identitySecret) {
			throw new Error(
				`Vault ${vaultId}: identity key missing from keystore (${backend.name}). Cannot open.`,
			);
		}
		if (!masterKey) {
			throw new Error(
				`Vault ${vaultId}: master key missing from keystore (${backend.name}). Cannot open.`,
			);
		}

		const identityPair: IdentityKeypair = {
			secretKey: identitySecret,
			publicKey: derivePublicKey(identitySecret),
		};
		const publicKeyBase64 = publicKeyToBase64(identityPair.publicKey);

		if (expectedPublicKeyBase64 && expectedPublicKeyBase64 !== publicKeyBase64) {
			throw new Error(
				`Vault ${vaultId}: identity public key in keystore does not match vault.json (possible tampering or wrong keystore).`,
			);
		}

		// Lazy-mint the device X25519 keypair for vaults created before
		// 10.2. Idempotent: the persist call is gated on the `getSecret`
		// returning null. A vault opened on a 10.2 client, closed, then
		// re-opened reads the persisted key on the second open.
		let devicePair: DeviceX25519Keypair;
		if (deviceX25519Secret) {
			devicePair = {
				secretKey: deviceX25519Secret,
				publicKey: deriveX25519Public(deviceX25519Secret),
			};
		} else {
			devicePair = generateDeviceX25519();
			await backend.setSecret(vaultId, "device-x25519", devicePair.secretKey);
		}

		// Same lazy-mint contract for the 10.5a per-device Ed25519 signing
		// keypair on vaults created pre-10.5a.
		let deviceEdPair: DeviceEd25519Keypair;
		if (deviceEd25519Secret) {
			deviceEdPair = {
				secretKey: deviceEd25519Secret,
				publicKey: deriveDeviceEd25519Public(deviceEd25519Secret),
			};
		} else {
			deviceEdPair = generateDeviceEd25519();
			await backend.setSecret(vaultId, "device-ed25519", deviceEdPair.secretKey);
		}

		const identity: VaultIdentity = {
			publicKey: identityPair.publicKey,
			publicKeyBase64,
			fingerprint: fingerprintPublicKey(identityPair.publicKey),
		};
		const deviceX25519: DeviceX25519Identity = {
			publicKey: devicePair.publicKey,
			publicKeyBase64: x25519PublicToBase64(devicePair.publicKey),
		};
		const deviceEd25519: DeviceEd25519Identity = {
			publicKey: deviceEdPair.publicKey,
			publicKeyBase64: deviceEd25519PublicToBase64(deviceEdPair.publicKey),
		};
		return new VaultSession({
			vaultId,
			vaultPath,
			backend,
			identity,
			identitySecret: identityPair.secretKey,
			deviceX25519,
			deviceX25519Secret: devicePair.secretKey,
			deviceEd25519,
			deviceEd25519Secret: deviceEdPair.secretKey,
			masterKey,
		});
	}

	signPayload(payload: Uint8Array): Uint8Array {
		this.assertOpen();
		return ed25519Sign(this.identitySecret, payload);
	}

	/** Sign `payload` with the per-device Ed25519 secret (Stage 10.5a).
	 *  Distinct from `signPayload` (sovereign user key) — used by the
	 *  pairing handshake to bind a message to the originating device. */
	signWithDeviceKey(payload: Uint8Array): Uint8Array {
		this.assertOpen();
		return signWithDeviceKey(this.deviceEd25519Secret, payload);
	}

	/** Expose the sovereign + per-device keypairs to the `PairingService`
	 *  (Stage 10.5b — pairing IPC handlers). The secret-key references are
	 *  live aliases into the session buffers; the pairing service must NOT
	 *  zero them (the session owns the lifetime). Callers stay inside the
	 *  main process — these never cross IPC. */
	exposeIdentityForPairing(): {
		publicKey: Uint8Array;
		secretKey: Uint8Array;
		deviceEd25519Public: Uint8Array;
		deviceEd25519Secret: Uint8Array;
		deviceX25519Public: Uint8Array;
	} {
		this.assertOpen();
		return {
			publicKey: this.identity.publicKey,
			secretKey: this.identitySecret,
			deviceEd25519Public: this.deviceEd25519.publicKey,
			deviceEd25519Secret: this.deviceEd25519Secret,
			deviceX25519Public: this.deviceX25519.publicKey,
		};
	}

	/**
	 * Open a member wrap addressed to this device — returns the plaintext
	 * 32-byte DEK. The X25519 secret never leaves the main process; callers
	 * receive the DEK and MUST zero it when finished. AAD is recomputed
	 * from `entityId` here (the same domain-separated prefix the wrap was
	 * minted under), so a caller passing the wrong entity id fails closed
	 * on AEAD verification.
	 *
	 * Throws on AAD mismatch, recipient mismatch (wrap not addressed to
	 * this device), tampered ciphertext, or a malformed payload. The wire
	 * path (10.3) verifies the entity id against the row before calling
	 * to close the same DEK-swap vector that `EntityDekStore.open` closes.
	 */
	unwrapMemberWrap(wrap: MemberWrapPayload, entityId: string): Uint8Array {
		this.assertOpen();
		return unwrapDekForRecipient(wrap, this.deviceX25519Secret, entityId);
	}

	/**
	 * Stage 10.14 — unwrap a member wrap, recovering both the DEK and the
	 * entity `type` sealed alongside it (a cold device needs the type to
	 * materialize the `entities.db` row; `type` is null for a pre-10.14 wrap).
	 * The caller MUST zero the returned `dek`.
	 */
	unwrapMemberWrapWithType(
		wrap: MemberWrapPayload,
		entityId: string,
	): { dek: Uint8Array; type: string | null } {
		this.assertOpen();
		return unwrapDekAndTypeForRecipient(wrap, this.deviceX25519Secret, entityId);
	}

	async setCredential(target: CredentialKey, value: Uint8Array): Promise<void> {
		this.assertOpen();
		await this.credentials.set(target, value);
	}

	async getCredential(target: CredentialKey): Promise<Uint8Array | null> {
		this.assertOpen();
		return await this.credentials.get(target);
	}

	async deleteCredential(target: CredentialKey): Promise<boolean> {
		this.assertOpen();
		return await this.credentials.delete(target);
	}

	async listCredentials(app: string): Promise<CredentialMetadata[]> {
		this.assertOpen();
		return await this.credentials.list(app);
	}

	get meta(): VaultSessionMeta {
		return {
			vaultId: this.vaultId,
			vaultPath: this.vaultPath,
			backend: this.backend.name,
			backendDescription: this.backend.description,
			backendIsInsecure: this.backend.isInsecure,
			identity: {
				publicKeyBase64: this.identity.publicKeyBase64,
				fingerprint: this.identity.fingerprint,
			},
			deviceX25519: {
				publicKeyBase64: this.deviceX25519.publicKeyBase64,
			},
			deviceEd25519: {
				publicKeyBase64: this.deviceEd25519.publicKeyBase64,
			},
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		zero(this.masterKey);
		zero(this.identitySecret);
		zero(this.deviceX25519Secret);
		zero(this.deviceEd25519Secret);
		this.masterKey = new Uint8Array(0);
		this.identitySecret = new Uint8Array(0);
		this.deviceX25519Secret = new Uint8Array(0);
		this.deviceEd25519Secret = new Uint8Array(0);
		this.cachedLedger = null;
		this.cachedBilling = null;
		this.cachedBillingRepos = null;
		this.cachedAiUsage = null;
		this.cachedCreditLedger = null;
		// The DEK store aliases `this.masterKey`'s backing buffer; the
		// in-place `zero(this.masterKey)` above already wiped the bytes the
		// store would otherwise read. Dropping the cache + the in-flight
		// open releases the repo and its prepared statements.
		this.cachedDekStore = null;
		this.dekStoreOpening = null;
		this.cachedAssetStore = null;
		this.assetStoreOpening = null;
		this.cachedAssetDekStore = null;
		this.assetDekStoreOpening = null;
		if (this.cachedMediaKey) {
			zero(this.cachedMediaKey);
			this.cachedMediaKey = null;
		}
		this.cachedNetworkSettings = null;
		this.networkSettingsOpening = null;
		this.networkSettingsListeners.clear();
		if (this.cachedDashboard) {
			const store = this.cachedDashboard;
			this.cachedDashboard = null;
			// fire-and-forget — flushes outstanding writes before resolving
			void store.close();
		}
		if (this.cachedProperties) {
			const store = this.cachedProperties;
			this.cachedProperties = null;
			void store.close();
		}
		this.dataStores.close();
		// PassphraseBackend.dispose exists; other backends are no-ops.
		const maybeDispose = (this.backend as { dispose?: () => void }).dispose;
		if (typeof maybeDispose === "function") maybeDispose.call(this.backend);
	}

	private assertOpen(): void {
		if (this.disposed) {
			throw new Error("VaultSession is disposed");
		}
	}

	/** Soft-lock state (Stage 13.8). True only for a passphrase-backend session
	 *  that's been locked (key resident behind the overlay + PIN gate). */
	isLocked(): boolean {
		return this.locked;
	}

	/** Internal — toggled by the module-level `lockActiveVault`/`unlockActiveVault`
	 *  orchestrators for the soft-lock path. Not for direct caller use. */
	markLocked(): void {
		this.locked = true;
	}
	markUnlocked(): void {
		this.locked = false;
	}
}

function zero(buffer: Uint8Array): void {
	for (let i = 0; i < buffer.length; i++) buffer[i] = 0;
}

function derivePublicKey(secretKey: Uint8Array): Uint8Array {
	return publicKeyFromSecret(secretKey);
}

// --- module-level active session ---------------------------------------

let active: VaultSession | null = null;
const activeSessionListeners = new Set<(session: VaultSession | null) => void>();

export function setActiveVaultSession(session: VaultSession | null): void {
	console.log(
		`[brainstorm] setActiveVaultSession: ${session ? `set to ${session.vaultId}` : "cleared"}`,
	);
	if (active && active !== session) {
		active.dispose();
	}
	active = session;
	// Stage 10.5c — notify the live-transport orchestrator of the session
	// flip. The orchestrator reads `vault.json.syncRelay` and rebuilds the
	// RelayPort (loopback when absent, WebSocket when present). Lazy import
	// to avoid a top-of-file cycle (sync/active-relay → vault/session is a
	// module-load no-go since session.ts is loaded by everything).
	void (async () => {
		try {
			const { getActiveRelay } = await import("../sync/active-relay");
			const relay = getActiveRelay();
			if (relay) {
				await relay.onSessionChanged(
					session ? { vaultId: session.vaultId, vaultPath: session.vaultPath } : null,
				);
			}
		} catch (error) {
			console.warn(
				`[brainstorm] setActiveVaultSession: active-relay notify failed: ${(error as Error).message}`,
			);
		}
	})();
	for (const listener of activeSessionListeners) {
		try {
			listener(session);
		} catch (error) {
			console.warn("[brainstorm] active-session listener threw:", error);
		}
	}
}

export function getActiveVaultSession(): VaultSession | null {
	return active;
}

/** Subscribe to active-session changes. Fires after the new session is set
 *  (or `null` on close), so the listener sees the post-change state. */
export function onActiveVaultSessionChanged(
	listener: (session: VaultSession | null) => void,
): () => void {
	activeSessionListeners.add(listener);
	return () => {
		activeSessionListeners.delete(listener);
	};
}

export function closeActiveVaultSession(): void {
	if (!active) return;
	active.dispose();
	active = null;
	// Notify subscribers of the teardown exactly as a switch does (the active
	// session went to null). Without this, close + the hard-lock path (which
	// routes through here) bypass `onActiveVaultSessionChanged` entirely — e.g.
	// the Browser-10 cookie jar would never clear the live web session or drop
	// its `cookies.on("changed")` listener on lock, leaking cookie plaintext in
	// memory while "locked" and writing to a now-closed DB.
	for (const listener of activeSessionListeners) {
		try {
			listener(null);
		} catch (error) {
			console.warn("[brainstorm] active-session listener threw on close:", error);
		}
	}
}

// ─── App-lock (Stage 13.8) ────────────────────────────────────────────────
//
// Two backend-aware modes (OQ-184): the OS-keyring (and insecure-dev) backend
// HARD-locks — the session is disposed (zeroing every key buffer via the
// existing, tested `dispose()`), then `unlock(pin)` re-reads the master key from
// the keystore by re-running the equally-tested `VaultSession.open()`. The
// passphrase backend SOFT-locks — the master key stays resident (no cheap
// PIN-gated re-read without re-prompting the passphrase), so lock is just the
// overlay + PIN gate. The PIN is a *gate* verified against the keystore-held
// light-Argon2id hash (see `credentials/app-lock-pin.ts`), never a KDF.

export enum AppLockMode {
	Hard = "hard",
	Soft = "soft",
}

/** Hard-lock everywhere except the passphrase backend, which has no cheap
 *  PIN-gated key re-read and so soft-locks (key stays resident). */
export function appLockModeForBackend(name: KeystoreBackendName): AppLockMode {
	return name === "passphrase" ? AppLockMode.Soft : AppLockMode.Hard;
}

// Wire types live in the renderer-safe shared module; re-exported here so the
// existing main-side importers keep resolving them from `session.ts`.
export type { UnlockReason, UnlockResult } from "../../shared/app-lock-wire-types";

type LockedVaultState = {
	vaultId: string;
	vaultPath: string;
	mode: AppLockMode;
	/** How the vault was opened — replayed verbatim by a hard-lock re-open. */
	openOptions: OpenSessionOptions;
	failedAttempts: number;
	/** Epoch ms of the last *failed* attempt — the main-side cooldown gate reads
	 *  this so the escalating delay is enforced here, not only in the renderer
	 *  (a hostile/stale renderer could otherwise spam `vault:unlock`). */
	lastFailedAt: number;
};

let lockedVault: LockedVaultState | null = null;

/** Whether the active vault is currently app-locked (either mode). */
export function isVaultLocked(): boolean {
	return lockedVault !== null;
}

/**
 * Engage the app-lock on the active vault. Returns the mode that was applied,
 * or `null` if there was no active session (nothing to lock) — idempotent if
 * already locked (returns the existing mode). The caller broadcasts
 * `app:lock-changed` (Stage 13.8c). `openOptions` is captured so a hard-lock
 * unlock can replay the original open (e.g. carry a passphrase forward — though
 * the passphrase backend soft-locks and never re-opens here).
 */
export function lockActiveVault(openOptions: OpenSessionOptions = {}): AppLockMode | null {
	if (lockedVault) return lockedVault.mode;
	const session = active;
	if (!session) return null;
	const mode = appLockModeForBackend(session.backend.name);
	lockedVault = {
		vaultId: session.vaultId,
		vaultPath: session.vaultPath,
		mode,
		openOptions,
		failedAttempts: 0,
		lastFailedAt: 0,
	};
	if (mode === AppLockMode.Hard) {
		// Zeros every key buffer + tears down stores; `active` becomes null so
		// the broker fails closed on every IPC dispatch while locked.
		closeActiveVaultSession();
	} else {
		session.markLocked();
	}
	return mode;
}

/**
 * Attempt to unlock with `pin`. On the keyring/insecure (hard) path this
 * re-opens the vault session; on the passphrase (soft) path it just clears the
 * lock flag. Wrong PIN increments the failure counter and reports the next
 * cooldown; past the cap (`isAppLockCapped`) the PIN is refused outright and the
 * caller must fall back to full-passphrase re-auth (a later surface concern).
 */
export async function unlockActiveVault(pin: string): Promise<UnlockResult> {
	const state = lockedVault;
	if (!state) return { ok: false, reason: "not-locked", failedAttempts: 0, cooldownMs: 0 };
	if (isAppLockCapped(state.failedAttempts)) {
		return { ok: false, reason: "capped", failedAttempts: state.failedAttempts, cooldownMs: 0 };
	}

	// Enforce the escalating cooldown HERE, not only in the renderer: reject an
	// attempt that arrives before the delay earned by prior failures has elapsed,
	// without running the verifier or counting the attempt. Otherwise a hostile or
	// stale renderer (or DevTools) could spam `vault:unlock` and burn the whole
	// attempt budget in milliseconds, making the ladder cosmetic.
	const requiredCooldown = appLockCooldownMs(state.failedAttempts);
	const sinceLastFailure = Date.now() - state.lastFailedAt;
	if (state.failedAttempts > 0 && sinceLastFailure < requiredCooldown) {
		return {
			ok: false,
			reason: "wrong-pin",
			failedAttempts: state.failedAttempts,
			cooldownMs: requiredCooldown - sinceLastFailure,
		};
	}

	// Soft-lock reuses the still-live session's backend; hard-lock re-picks the
	// keystore (the session is disposed) to read the PIN verifier.
	const backend =
		state.mode === AppLockMode.Soft && active
			? active.backend
			: await pickKeystore({ vaultPath: state.vaultPath, ...state.openOptions });

	const ok = await verifyAppLockPin(backend, state.vaultId, pin);
	if (!ok) {
		state.failedAttempts += 1;
		state.lastFailedAt = Date.now();
		return {
			ok: false,
			reason: isAppLockCapped(state.failedAttempts) ? "capped" : "wrong-pin",
			failedAttempts: state.failedAttempts,
			cooldownMs: appLockCooldownMs(state.failedAttempts),
		};
	}

	if (state.mode === AppLockMode.Soft) {
		active?.markUnlocked();
	} else {
		const session = await VaultSession.open(state.vaultId, state.vaultPath, state.openOptions);
		setActiveVaultSession(session);
	}
	lockedVault = null;
	return { ok: true };
}

/**
 * Set (or replace) the app-lock PIN on the active vault. Returns false if there
 * is no active session. Only callable while unlocked (the dashboard Settings
 * surface) — the PIN is a convenience gate; the keystore secret it's stored
 * under is the real protection (see `credentials/app-lock-pin.ts`).
 */
export async function setActiveVaultPin(pin: string): Promise<boolean> {
	const session = active;
	if (!session) return false;
	await setAppLockPin(session.backend, session.vaultId, pin);
	return true;
}

/** Remove the app-lock PIN from the active vault. Returns whether one existed. */
export async function clearActiveVaultPin(): Promise<boolean> {
	const session = active;
	if (!session) return false;
	return clearAppLockPin(session.backend, session.vaultId);
}

/** Whether the active vault has an app-lock PIN set. */
export async function activeVaultHasPin(): Promise<boolean> {
	const session = active;
	if (!session) return false;
	return hasAppLockPin(session.backend, session.vaultId);
}

/**
 * Engage the app-lock on a cold launch when the active vault has a PIN. The lock
 * state lives only in memory (`lockedVault`), so a fresh process always starts
 * unlocked — without this a relaunch silently skips the PIN entirely, while
 * idle/sleep auto-lock only ever gates an already-running session. Whenever a PIN
 * is set the cold boot must re-prompt for it, exactly like the auto-lock watcher.
 * On the keyring (hard-lock) backend this disposes the freshly-opened session
 * (keys zeroed); `vault:unlock` re-opens it. Returns the lock mode applied, or
 * `null` when no PIN is set (the vault stays unlocked).
 */
export async function lockOnBootIfPinSet(
	openOptions: OpenSessionOptions = {},
): Promise<AppLockMode | null> {
	if (!(await activeVaultHasPin())) return null;
	return lockActiveVault(openOptions);
}

/** The active vault's auto-lock idle timeout (minutes; `0` = off). Returns `0`
 *  when there's no active session so the watcher never fires. */
export async function getActiveVaultAutoLockMinutes(): Promise<number> {
	const session = active;
	if (!session) return 0;
	return (await readAppLockSettings(session.vaultPath)).autoLockMinutes;
}

/** Persist the active vault's auto-lock idle timeout. Returns false when there's
 *  no active session. */
export async function setActiveVaultAutoLockMinutes(minutes: number): Promise<boolean> {
	const session = active;
	if (!session) return false;
	await writeAppLockSettings(session.vaultPath, { autoLockMinutes: minutes });
	return true;
}

/** Test-only — reset the module-level lock state between cases. */
export function resetAppLockStateForTests(): void {
	lockedVault = null;
}

/**
 * Use this in tests / programmatic flows that need access to the
 * `publicKeyFromBase64` helper without importing the identity module
 * separately — keeps consumer surface tight.
 */
export const identityHelpers = {
	publicKeyToBase64,
	publicKeyFromBase64,
	fingerprintPublicKey,
};
