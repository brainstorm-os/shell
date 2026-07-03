/**
 * entities — the real entities service (Stage 9.3.1). Broker service
 * `"entities"`; the canonical store over `entities.db` via
 * `EntitiesRepository`. Replaces, type-for-type, the `entities.*` SDK
 * placeholder.
 *
 * Capability model (per +
 * ): `entities` is **type-scoped**. The entity
 * type isn't known until a row is fetched, so the per-call broker gate is
 * a no-op (`caps: []`) and this handler is the sole authority — it checks
 * the per-vault capability ledger for `entities.read:<type>` /
 * `entities.write:<type>` (a `*`-scoped grant matches any type). Reads
 * **silently filter** rows whose type the app can't read (surfacing
 * existence is itself information — it does not error). Writes throw
 * `Denied`. A ledger that's unavailable fails closed (`Unavailable`).
 *
 * The Stage 9.3.2 YDoc-resolver (rich-text `getYFragment`) and 9.3.3
 * `@blockprotocol/*` conformance + Hook handlers are deliberately not
 * here — see the implementation plan's 9.3 ladder.
 */

import { Buffer } from "node:buffer";
import {
	type Entity,
	type EntityDocLink,
	EntityEventVerb,
	type EntityQuery,
} from "@brainstorm/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";
import type { AssetKind } from "../assets/asset-types";
import { LedgerUnavailableError } from "../capabilities/ledger";
import type { CapabilityLedger } from "../capabilities/ledger";
import type { EntitiesRepository, EntityRow } from "../storage/entities-repo";
import { isSafeEntityId } from "../storage/entity-id";
import { assetRefRoleForKind, extractAssetIds } from "./derive-asset-refs";
import type { EntityChange } from "./entity-change-emitter";
import type { EntityDekHandle, EntityDekStore } from "./entity-dek-store";
import type { EntityDocProjection } from "./entity-doc-codec";

export type EntitiesServiceOptions = {
	/** The entities repo for the active vault, or null when no vault is
	 *  open (→ `Unavailable`, fail closed). */
	getRepo: () => Promise<EntitiesRepository | null>;
	/** The active vault's capability ledger, or null when none. */
	getLedger: () => Promise<CapabilityLedger | null>;
	/** The active vault's per-entity DEK store (Stage 10.1). Returns null
	 *  when no vault is open (→ `Unavailable`, fail closed). Every
	 *  `entities.create` mints + persists a DEK through this; the plaintext
	 *  DEK is closed (zeroed) immediately after the row is stamped — 10.1
	 *  does not yet use it on the wire (10.3 wires encrypted Yjs updates). */
	getDekStore: () => Promise<EntityDekStore | null>;
	/** Stage 10.3a — install a `MemberWrapPayload` addressed to this device
	 *  on the freshly-created entity's Y.Doc. Called AFTER `dekStore.persist`
	 *  with the still-live DEK, so the wrap can be minted before the DEK is
	 *  zeroed in the `finally`. Idempotent on retries. Returning a rejected
	 *  promise rolls back the entity row (the surrounding repo transaction
	 *  has not yet been committed). */
	installEntityWrap?: (entityId: string, dek: Uint8Array, type?: string) => Promise<void>;
	/** Fresh entity id. Injected for deterministic tests. */
	newId: () => string;
	/** Clock. Injected for deterministic tests. */
	now?: () => number;
	/** Active vault path (for the ydoc worker), or null when none. */
	getVaultPath?: () => string | null;
	/** Invoke the `ydoc` worker (load/applyUpdate/close) for the entity's
	 *  rich-text Y.Doc. 9.3.2b — the renderer-replica transport flows
	 *  through this service so the per-type capability check (read to
	 *  load, write to apply) is reused; no new privileged channel. */
	ydoc?: (
		method: "load" | "applyUpdate" | "close" | "setEntityState",
		args: {
			vaultPath: string;
			entityId: string;
			updateB64?: string;
			props?: Record<string, unknown>;
			links?: EntityDocLink[];
			seedProps?: Record<string, unknown>;
		},
	) => Promise<unknown>;
	/** 9.3.2c — deliver a canonical-applied Y.Doc update to the apps that
	 *  have this entity's doc open (the originator excluded), so a second
	 *  window editing the same entity converges live without reload.
	 *  `targetApps` are app ids that previously `loadDoc`'d the entity, so
	 *  they already passed the per-type `entities.read` gate and already
	 *  hold the plaintext replica — no new authorization surface.
	 *
	 *  9.3.2d — returns the subset of `targetApps` that had no live
	 *  window (renderer died without `closeDoc`); the service prunes
	 *  those stale subscriptions. */
	deliverDocUpdate?: (
		entityId: string,
		updateB64: string,
		targetApps: readonly string[],
	) => readonly string[];
	/** 12.8 (doc 28 "Corrupted Yjs file") — invoked when a cold `loadDoc`
	 *  recovered a doc whose final tail entry was truncated/corrupt and was
	 *  skipped. The shell warns the user that recent edits may be lost. Fires
	 *  once per cold load (the worker LRU returns `truncatedTail: false` on a
	 *  cache hit), so a single warning per entity per session. */
	onTruncatedTail?: (entityId: string) => void;
	/** 11b.6 — post-commit change notification feeding the automations
	 *  `EntityEvent` triggers. SECURITY: invoked ONLY after the per-type
	 *  capability gate passed and the write committed; the payload carries
	 *  identifiers, never property values; a throw from the hook is
	 *  contained here and can never fail the data path. `applyDoc` (the
	 *  per-keystroke rich-text path) deliberately does NOT emit — only the
	 *  property-level create/update/delete verbs do. */
	onEntityChange?: (change: EntityChange) => void;
	/** Asset-B4 — resolve a LOCALLY-stored asset's `kind` (favicon/cover/upload)
	 *  for the implicit asset-ref bind writer, or null when the asset isn't
	 *  stored in this vault. Two jobs: it gates whether a `brainstorm://asset/`
	 *  URL in an entity's properties gets a bound `asset_refs` row (a dangling /
	 *  remote id resolves to null and is skipped), and it derives the ref role.
	 *  Presence of this hook is the Asset-B4 feature flag — when it's absent (a
	 *  legacy/test construction without asset support) the bind writer is inert
	 *  and `asset_refs` is left exactly as before. No new capability: the
	 *  entity-write gate that already passed authorizes the reconcile
	 *  (OQ-238 folds in). */
	getAssetKind?: (assetId: string) => Promise<AssetKind | null>;
	/** 10.12 — an app opened (`loadDoc`) an entity's doc. The always-on
	 *  live-sync engine consults the entity's access record and, if shared
	 *  (>1 active member), subscribes its relay channel so inbound edits land.
	 *  Fires only after the per-type read gate + a successful worker load. */
	onDocOpened?: (entityId: string, type: string) => void;
	/** 10.12 — a local Y.Doc write committed (rich-text `applyDoc` or a
	 *  property `create`/`update`). The live-sync engine emits it through the
	 *  active relay IFF the entity is shared + tracked; a solo entity is a
	 *  no-op so the per-keystroke path stays free. Carries the exact persisted
	 *  update bytes. SECURITY: fired ONLY after the per-type write gate passed
	 *  and the write committed; a throw is contained and never fails the edit. */
	onLocalDocUpdate?: (entityId: string, type: string, update: Uint8Array) => void;
	/** 10.14 — the entity's backing Y.Doc just compacted (its on-disk tail
	 *  crossed the threshold). The live-sync engine emits a full-state `Snapshot`
	 *  frame so the durable node compacts its tail too. Contained: a throw never
	 *  fails the edit. Fires only for a shared+tracked entity downstream. */
	onDocCompacted?: (entityId: string, type: string) => void;
	/** 10.12 — hands the system-only remote-apply closure out to the live-sync
	 *  wiring, ONCE at construction. Kept off the broker so an app can never
	 *  call an ungated `applyUpdate`; the engine invokes it for inbound frames
	 *  on entities it already read-gated + tracks. */
	bindApplyRemoteDoc?: (apply: ApplyRemoteDocFn) => void;
};

/** Apply a decrypted remote Y.Doc delta to the live doc + persist + materialise
 *  + deliver to open windows. `updateB64` is the base64 plaintext Yjs update. */
export type ApplyRemoteDocFn = (entityId: string, updateB64: string) => Promise<void>;

/** Capability verb. Wire form stays the string the ledger scopes by
 *  (`entities.read:*` / `entities.write:*`) — the enum centralises it
 *  per CLAUDE.md (no raw string-literal discriminators). */
enum EntityAccess {
	Read = "read",
	Write = "write",
}

function named(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

function arg(envelope: { args: unknown[] }): Record<string, unknown> {
	const a = envelope.args[0];
	return a && typeof a === "object" ? (a as Record<string, unknown>) : {};
}

export function makeEntitiesServiceHandler(options: EntitiesServiceOptions): ServiceHandler {
	const clock = options.now ?? (() => Date.now());

	// 11b.6 — post-commit fan-out. Isolated so a listener throw can never
	// surface as a failed write to the calling app (the write committed).
	const emitChange = (verb: EntityEventVerb, entityId: string, type: string): void => {
		if (!options.onEntityChange) return;
		try {
			options.onEntityChange({ verb, entityId, type });
		} catch (error) {
			console.error("[entities] onEntityChange hook failed:", error);
		}
	};

	// Asset-B4 — reconcile the `asset_refs` bindings for an entity to the
	// `brainstorm://asset/<id>` URLs its properties now carry. Called AFTER a
	// property create/update commit (NOT the per-keystroke `applyDoc` path, same
	// as `onEntityChange`). Contained exactly like the change hooks: the write
	// already committed, so a throw here (a bad row, a dropped DB handle) must
	// never surface as a failed write — it's logged and swallowed. Inert unless
	// `getAssetKind` is wired (the feature flag).
	const reconcileAssetRefs = async (
		repo: EntitiesRepository,
		entityId: string,
		properties: Record<string, unknown>,
	): Promise<void> => {
		if (!options.getAssetKind) return;
		try {
			// desired = referenced ids that resolve to a locally-stored asset
			// (a dangling / remote / not-yet-fetched id is skipped, never bound).
			// This is REQUIRED, not just conservative: `asset_refs.asset_id` has a
			// FK to `assets(asset_id)`, so a ref for an asset with no local row
			// can't be inserted. A true cold device (never had the blob's row)
			// therefore can't bind until the asset's metadata is reconstructed —
			// the forward cold-first-fetch rung (needs a stub `assets` row from the
			// synced manifest). Serve-on-miss here targets the metadata-present,
			// blob-absent case (restore / selective-sync eviction), where the row
			// + ref + DEK are local and only the encrypted blob file is missing.
			const desired = new Map<string, ReturnType<typeof assetRefRoleForKind>>();
			for (const assetId of extractAssetIds(properties)) {
				const kind = await options.getAssetKind(assetId);
				if (kind) desired.set(assetId, assetRefRoleForKind(kind));
			}
			const existingIds = new Set(repo.assetRefs.listByEntity(entityId).map((r) => r.assetId));
			const now = clock();
			for (const [assetId, role] of desired) {
				if (!existingIds.has(assetId)) repo.assetRefs.create({ entityId, assetId, role, now });
			}
			// deleteRef (not deleteByEntity) so an unchanged ref keeps its
			// `created_at` / `rehomed_at`.
			for (const assetId of existingIds) {
				if (!desired.has(assetId)) repo.assetRefs.deleteRef(entityId, assetId);
			}
		} catch (error) {
			console.error("[entities] reconcileAssetRefs failed:", error);
		}
	};

	// 9.3.2c — which apps hold an open canonical handle for an entity,
	// keyed by `${vaultPath}::${entityId}` (matches the worker's docKey,
	// so a vault switch can't cross-deliver). Refcounted because an app
	// may `loadDoc` the same entity from multiple intra-app windows that
	// share one renderer (OQ-4 (b)); the renderer's resolver is one Y.Doc
	// either way, so we only need per-app presence — closeDoc releases.
	const docSubscribers = new Map<string, Map<string, number>>();
	const subKey = (vaultPath: string, entityId: string): string => `${vaultPath}::${entityId}`;

	// 9.3.2d — `docSubscribers` is service-lifetime, but its keys embed
	// the vault path. A vault switch/close orphans every entry (the new
	// vault's renderers re-`loadDoc` under fresh keys; the old ones can
	// never match again). Drop the whole map the first time we observe
	// the active vault path change so stale `app→count` rows can't
	// accumulate across vaults. `undefined` (initial) → first real path
	// triggers a no-op clear of the empty map.
	let lastVaultPath: string | null | undefined;

	// 9.3.2c / 10.12 — apply a canonical Y.Doc delta to an entity: route it
	// into the worker's live cached doc (apply + persist), materialise the
	// derived `entities.db` row from the returned projection, and fan the
	// delta to every OTHER app window holding the entity open (so their
	// replica converges without reload). `excludeApp` is the originator on
	// the local `applyDoc` path; `null` on the remote-apply path (every open
	// window is a peer of a remote edit). Shared by `applyDoc` and the
	// off-broker `applyRemoteDoc` so the materialise+deliver logic lives once.
	const applyCanonicalDelta = async (
		vaultPath: string,
		id: string,
		updateB64: string,
		excludeApp: string | null,
	): Promise<unknown> => {
		if (!options.ydoc) throw named("Unavailable", "entities: ydoc transport not wired");
		const applied = await options.ydoc("applyUpdate", { vaultPath, entityId: id, updateB64 });
		const projection = (applied as { projection?: EntityDocProjection } | null)?.projection;
		if (projection?.properties || projection?.links) {
			const repo = await options.getRepo();
			if (repo) {
				if (projection.properties) repo.update(id, projection.properties, clock());
				if (projection.links) {
					for (const link of projection.links) {
						repo.putLink({
							id: link.id,
							sourceEntityId: id,
							destEntityId: link.destEntityId,
							linkType: link.linkType,
							createdAt: link.createdAt,
						});
					}
				}
			}
		}
		if (options.deliverDocUpdate) {
			const sk = subKey(vaultPath, id);
			const subs = docSubscribers.get(sk);
			if (subs) {
				const targets = [...subs.keys()].filter((a) => excludeApp === null || a !== excludeApp);
				if (targets.length > 0) {
					// 9.3.2d — prune any target whose renderer is gone (closed
					// without `closeDoc`) so its refcount can't leak forever.
					const deadApps = options.deliverDocUpdate(id, updateB64, targets);
					for (const dead of deadApps) subs.delete(dead);
					if (subs.size === 0) docSubscribers.delete(sk);
				}
			}
		}
		return applied;
	};

	// 10.12 — fire the live-sync emit hook for a committed local Y.Doc write.
	// Contained: a listener throw can never surface as a failed edit (the
	// write already committed). Skipped for an empty/idempotent diff.
	const emitLocalDoc = (id: string, type: string, updateB64: string | null | undefined): void => {
		if (!options.onLocalDocUpdate || !updateB64) return;
		try {
			options.onLocalDocUpdate(id, type, new Uint8Array(Buffer.from(updateB64, "base64")));
		} catch (error) {
			console.error("[entities] onLocalDocUpdate hook failed:", error);
		}
	};

	// 10.12 — the system-only remote-apply path. NOT registered on the broker
	// (an app must never be able to apply an ungated Y.Doc update): handed to
	// the live-sync wiring via `bindApplyRemoteDoc`. The engine only calls it
	// for entities it tracks, which already passed the per-type read gate at
	// `loadDoc` and are shared.
	if (options.bindApplyRemoteDoc) {
		options.bindApplyRemoteDoc(async (id: string, updateB64: string): Promise<void> => {
			const vaultPath = options.getVaultPath?.() ?? null;
			if (!vaultPath) return;
			await applyCanonicalDelta(vaultPath, id, updateB64, null);
		});
	}

	return async (envelope) => {
		const app = envelope.app;
		if (options.getVaultPath) {
			const vp = options.getVaultPath();
			if (vp !== lastVaultPath) {
				docSubscribers.clear();
				lastVaultPath = vp;
			}
		}
		const repo = await options.getRepo();
		const ledger = await options.getLedger();
		const dekStore = await options.getDekStore();
		if (!repo || !ledger || !dekStore) {
			throw named("Unavailable", "entities service: no active vault session");
		}

		const can = (verb: EntityAccess, type: string): boolean => {
			try {
				return ledger.has(app, `entities.${verb}:${type}`);
			} catch (error) {
				if (error instanceof LedgerUnavailableError) {
					throw named("Unavailable", "entities service: capability ledger unavailable");
				}
				throw error;
			}
		};

		const compose = (row: EntityRow): Entity => ({
			id: row.id,
			type: row.type,
			properties: row.properties,
			links: repo.linksFrom(row.id).map((l) => ({
				linkType: l.linkType,
				destinationEntityId: l.destEntityId,
			})),
			createdBy: row.createdBy,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		});

		switch (envelope.method) {
			case "get": {
				const id = String(arg(envelope).id ?? "");
				const row = repo.get(id);
				if (!row || !can(EntityAccess.Read, row.type)) return null;
				return compose(row);
			}

			case "query": {
				const query = (arg(envelope).query ?? {}) as EntityQuery;
				const rows = repo.query(query);
				return rows.filter((r) => can(EntityAccess.Read, r.type)).map(compose);
			}

			case "create": {
				const a = arg(envelope);
				const type = String(a.type ?? "");
				if (type === "") throw named("Invalid", "entities.create: missing type");
				if (!can(EntityAccess.Write, type)) {
					throw named("Denied", `entities.create: no entities.write for ${type}`);
				}
				const properties =
					a.properties && typeof a.properties === "object"
						? (a.properties as Record<string, unknown>)
						: {};
				// Optional caller-supplied id (9.3.5.3): entity ids are local
				// opaque strings (05-data-and-blocks-protocol §Decision), so an
				// app migrating off its kv silo may preserve its stable ids
				// (load-bearing for cross-app links). A collision with a live
				// entity is `Invalid` — the caller should `update` instead
				// (the per-app repos do get-then-create-or-update).
				const explicitId = typeof a.id === "string" && a.id !== "" ? a.id : null;
				// A caller-supplied id reaches a filesystem path (YDocStore.pathFor)
				// + a SQL row key; reject anything outside the safe charset BEFORE
				// it can drive a `mkdir`/`writeFile` so it can't escape the vault
				// docs dir (path traversal — the 10.9b pentest finding). The minted
				// id (`options.newId`) is already in-charset by construction.
				if (explicitId && !isSafeEntityId(explicitId)) {
					throw named("Invalid", `entities.create: invalid id ${JSON.stringify(explicitId)}`);
				}
				if (explicitId && repo.get(explicitId)) {
					throw named("Invalid", `entities.create: ${explicitId} already exists`);
				}
				const entityId = explicitId ?? options.newId();
				// Stage 10.1 — forward-allocate the dekId so the entity row
				// can stamp `dek_id` in its very first INSERT (no UPDATE),
				// then write the entity row and the DEK wrap row inside one
				// SQLite transaction. The FK on `entity_deks.entity_id`
				// requires the parent to exist first, so the order inside
				// the txn matters; either write throwing rolls back both,
				// so a failed wrap never leaves an entity row with a
				// dangling `dek_id`. The plaintext DEK is zeroed in the
				// `finally` whether the txn commits or aborts.
				const dekId = dekStore.nextDekId();
				let dekHandle: EntityDekHandle | null = null;
				try {
					const row = repo.transaction(() => {
						const created = repo.create({
							id: entityId,
							type,
							properties,
							createdBy: app,
							now: clock(),
							dekId,
						});
						dekHandle = dekStore.persist(entityId, dekId);
						return created;
					});
					// Stage 10.3a — install the per-device member wrap on the
					// entity's Y.Doc *after* the row + DEK are committed, but
					// while the DEK is still live (zeroed in the finally
					// below). The wrap is what the wire-path open side reads
					// to recover the DEK on a paired device; without it a
					// fresh row would be un-decryptable by any device, even
					// the one that created it. A throw here rolls the entity
					// row + DEK row back via `hardDelete` so a half-created
					// row can't strand. No installer wired = legacy test
					// context; production binds it at boot.
					if (options.installEntityWrap && dekHandle) {
						try {
							await options.installEntityWrap(entityId, (dekHandle as EntityDekHandle).dek, type);
						} catch (error) {
							// Rollback the freshly-committed row + DEK by
							// soft-then-hard delete (hardDelete is guarded by
							// `deleted_at IS NOT NULL`). FK cascade also drops
							// the `entity_deks` row.
							try {
								repo.softDelete(entityId, clock());
								repo.hardDelete(entityId);
							} catch {
								// Best-effort: a rollback failure is logged
								// but does not mask the original wrap-install
								// error which is what the caller needs to see.
							}
							throw error;
						}
					}
					// Y.Doc-first (Phase 2): seed the entity's Y.Doc with its
					// properties so the doc — not the row — is the source of
					// truth from birth (the row already holds the same set as
					// its projection). Best-effort: a transient ydoc failure
					// leaves a valid row the doc catches up to on first edit, so
					// it must not fail the create. No ydoc wired = legacy/test
					// context; the row alone is the store there.
					const createVaultPath = options.getVaultPath?.() ?? null;
					if (options.ydoc && createVaultPath && Object.keys(properties).length > 0) {
						try {
							const seeded = (await options.ydoc("setEntityState", {
								vaultPath: createVaultPath,
								entityId,
								props: properties,
							})) as { updateB64?: string | null } | null;
							// 10.12 — emit the initial property write if shared.
							emitLocalDoc(entityId, type, seeded?.updateB64);
						} catch (error) {
							console.warn(
								`[entities] create: failed to seed Y.Doc for ${entityId}: ${(error as Error).message}`,
							);
						}
					}
					emitChange(EntityEventVerb.Create, entityId, type);
					// Asset-B4 — bind `asset_refs` to the `brainstorm://asset/`
					// URLs the new row's properties carry (post-commit, contained).
					await reconcileAssetRefs(repo, entityId, row.properties);
					return compose(row);
				} finally {
					if (dekHandle) dekStore.close((dekHandle as EntityDekHandle).dek);
				}
			}

			case "update": {
				const a = arg(envelope);
				const id = String(a.id ?? "");
				const existing = repo.get(id);
				if (!existing) throw named("Invalid", `entities.update: ${id} not found`);
				if (!can(EntityAccess.Write, existing.type)) {
					throw named("Denied", `entities.update: no entities.write for ${existing.type}`);
				}
				const patch =
					a.patch && typeof a.patch === "object" ? (a.patch as Record<string, unknown>) : {};
				// Y.Doc-first (Phase 2): when the doc transport is wired, route
				// the property write through the canonical doc and materialise
				// its projection into the row — the doc is the source of truth,
				// the row a derived index. The row write merges (preserving any
				// property not yet migrated into the doc). Falls back to a direct
				// row write only in legacy/test contexts with no ydoc wired.
				let propsForRow: Record<string, unknown> = patch;
				const updateVaultPath = options.getVaultPath?.() ?? null;
				if (options.ydoc && updateVaultPath && Object.keys(patch).length > 0) {
					const res = (await options.ydoc("setEntityState", {
						vaultPath: updateVaultPath,
						entityId: id,
						props: patch,
						// Lazy hydration (Phase 5): hand the worker the row's full
						// current property set. It seeds the Y.Doc from this ONLY
						// when the doc's property map is still empty — i.e. the
						// entity was seeded / legacy-backfilled straight into
						// entities.db and this is its first Y.Doc write. That makes
						// the doc a complete source of truth before the patch, so a
						// later sync carries the whole object, not just `patch`.
						seedProps: existing.properties,
					})) as { projection?: EntityDocProjection; updateB64?: string | null } | null;
					if (res?.projection?.properties) propsForRow = res.projection.properties;
					// 10.12 — emit the property write through live-sync if shared.
					emitLocalDoc(id, existing.type, res?.updateB64);
				}
				const updated = repo.update(id, propsForRow, clock());
				if (!updated) throw named("Invalid", `entities.update: ${id} not found`);
				emitChange(EntityEventVerb.Update, id, existing.type);
				// Asset-B4 — reconcile against the row's FULL post-write property
				// set (a patch merges into existing, so pruning off just the patch
				// would drop refs for assets the patch never touched).
				await reconcileAssetRefs(repo, id, updated.properties);
				return compose(updated);
			}

			case "delete": {
				const id = String(arg(envelope).id ?? "");
				const existing = repo.get(id);
				if (!existing) return null; // idempotent
				if (!can(EntityAccess.Write, existing.type)) {
					throw named("Denied", `entities.delete: no entities.write for ${existing.type}`);
				}
				repo.softDelete(id, clock());
				emitChange(EntityEventVerb.Delete, id, existing.type);
				// Asset-B4 — this is a SOFT delete (the row persists), so the
				// `asset_refs.entity_id` ON DELETE CASCADE never fires; drop the
				// owner's refs explicitly or they'd strand and keep the asset
				// artificially reachable for GC. Contained (post-commit); gated on
				// the Asset-B4 feature being wired.
				if (options.getAssetKind) {
					try {
						repo.assetRefs.deleteByEntity(id);
					} catch (error) {
						console.error("[entities] asset-ref delete-prune failed:", error);
					}
				}
				return null;
			}

			// ── 9.3.2b: rich-text Y.Doc replica transport ──────────────
			// loadDoc/applyDoc/closeDoc proxy the `ydoc` worker for the
			// entity's backing Y.Doc, gated by the SAME per-type ledger
			// check as the property CRUD (read to load, write to apply).
			case "loadDoc": {
				if (!options.ydoc || !options.getVaultPath) {
					throw named("Unavailable", "entities.loadDoc: ydoc transport not wired");
				}
				const vaultPath = options.getVaultPath();
				if (!vaultPath) throw named("Unavailable", "entities.loadDoc: no active vault");
				const id = String(arg(envelope).id ?? "");
				const row = repo.get(id);
				if (!row) throw named("Invalid", `entities.loadDoc: ${id} not found`);
				if (!can(EntityAccess.Read, row.type)) {
					throw named("Denied", `entities.loadDoc: no entities.read for ${row.type}`);
				}
				const loaded = await options.ydoc("load", { vaultPath, entityId: id });
				// 12.8 — a recovered-but-truncated tail means the last write
				// didn't fully land before a crash; warn the user (once per
				// cold load — the worker cache returns false on a hit).
				if ((loaded as { truncatedTail?: boolean } | null)?.truncatedTail) {
					options.onTruncatedTail?.(id);
				}
				// Subscribe only after the read gate + a successful worker
				// load — a failed load delivers nothing.
				const lk = subKey(vaultPath, id);
				let byApp = docSubscribers.get(lk);
				if (!byApp) {
					byApp = new Map();
					docSubscribers.set(lk, byApp);
				}
				byApp.set(app, (byApp.get(app) ?? 0) + 1);
				// 10.12 — let the live-sync engine subscribe this entity's relay
				// channel if it's shared, so inbound edits from other devices/
				// members land on the open doc. Contained: a throw here never
				// fails the load.
				try {
					options.onDocOpened?.(id, row.type);
				} catch (error) {
					console.error("[entities] onDocOpened hook failed:", error);
				}
				return loaded;
			}

			case "applyDoc": {
				if (!options.ydoc || !options.getVaultPath) {
					throw named("Unavailable", "entities.applyDoc: ydoc transport not wired");
				}
				const vaultPath = options.getVaultPath();
				if (!vaultPath) throw named("Unavailable", "entities.applyDoc: no active vault");
				const a = arg(envelope);
				const id = String(a.id ?? "");
				const updateB64 = String(a.updateB64 ?? "");
				const row = repo.get(id);
				if (!row) throw named("Invalid", `entities.applyDoc: ${id} not found`);
				if (!can(EntityAccess.Write, row.type)) {
					throw named("Denied", `entities.applyDoc: no entities.write for ${row.type}`);
				}
				// Apply to the worker's live doc + persist, materialise the row,
				// and fan to every OTHER app holding it open (originator excluded:
				// its own renderer already has the edit; same-app windows share
				// the renderer's Y.Doc, OQ-4 (b)). 9.3.2c materialise+deliver
				// lives in the shared `applyCanonicalDelta` (reused by the remote
				// path) so the two can't drift.
				const applied = await applyCanonicalDelta(vaultPath, id, updateB64, app);
				// 10.12 — emit this local body edit through the always-on live-
				// sync engine (no-op unless the entity is shared + tracked).
				emitLocalDoc(id, row.type, updateB64);
				// 10.14 — if the worker compacted the doc's tail, let the engine
				// emit a full-state Snapshot so the durable node compacts too.
				if ((applied as { compacted?: boolean } | null)?.compacted && options.onDocCompacted) {
					try {
						options.onDocCompacted(id, row.type);
					} catch (error) {
						console.error("[entities] onDocCompacted hook failed:", error);
					}
				}
				// `projection` is a shell-internal materialisation hint — don't
				// leak it back over IPC to the app; return only the apply result.
				if (applied && typeof applied === "object" && "projection" in applied) {
					const { projection: _projection, ...rest } = applied as Record<string, unknown>;
					return rest;
				}
				return applied;
			}

			case "closeDoc": {
				// Idempotent cleanup — frees the worker's in-memory replica.
				// No capability gate (releasing memory leaks nothing); a
				// missing/deleted entity is a no-op.
				if (!options.ydoc || !options.getVaultPath) return null;
				const vaultPath = options.getVaultPath();
				if (!vaultPath) return null;
				const id = String(arg(envelope).id ?? "");
				// Release this app's subscription (refcounted) so a later
				// applyDoc no longer fans updates to a window that closed it.
				const ck = subKey(vaultPath, id);
				const byApp = docSubscribers.get(ck);
				if (byApp) {
					const next = (byApp.get(app) ?? 0) - 1;
					if (next > 0) byApp.set(app, next);
					else byApp.delete(app);
					if (byApp.size === 0) docSubscribers.delete(ck);
				}
				await options.ydoc("close", { vaultPath, entityId: id });
				return null;
			}

			default:
				throw named("Invalid", `unknown entities method: ${envelope.method}`);
		}
	};
}
