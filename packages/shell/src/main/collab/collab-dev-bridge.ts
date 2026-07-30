/**
 * Collab-C4-live — the dev-only bridge that drives the C1/C2 share flow over
 * the LIVE relay against the PERSISTED `YDocStore`, so two real shells (two
 * different *users*) can dogfood collaboration through the shipped app.
 *
 * The owner-side share/revoke/createInvite core now lives in the reusable
 * {@link SharingEngine} (shared with the production `sharing` broker service);
 * this bridge is the thin dev/dogfood wrapper that layers a bespoke inbound
 * RECEIVER on top — in production that receiver is the always-on
 * `LiveSyncEngine` (10.12), so the bridge's receiver is test-support only. The
 * class is the testable core; the `dev:collab:*` IPC handlers
 * (`ipc/collab-dev-handlers.ts`) are thin wrappers that bind one instance to
 * the active vault session + relay, registered behind the same dev env-gate as
 * the soak handlers — never shipped in a packaged build.
 *
 * **Why a combined, serialized receiver.** The owner emits the member-wrap
 * (`WrapBootstrap`) and then the encrypted doc-state (`Update`) over the same
 * relay. The collaborator MUST install the DEK from the wrap before it can
 * decrypt the state, so the receiver processes frames strictly in arrival
 * order through one promise chain.
 */

import { GrantedVia } from "@brainstorm-os/capabilities/ledger";
import * as Y from "yjs";
import { parseAssetChunkManifest } from "../assets/asset-chunks";
import { AssetKind } from "../assets/asset-types";
import { AssetsRepository } from "../storage/entities-repo";
import { decodeFrame } from "../sync/envelope-codec";
import { receiveAndApply, receiveWrapBootstrap } from "../sync/envelope-pipeline";
import { getLiveSyncEngine } from "../sync/live-sync-wiring";
import { getPresenceRouter } from "../sync/presence-wiring";
import { WireKind } from "../sync/routing-header";
import type { VaultSession } from "../vault/session";
import { type AccessRole, isAccessRole } from "./access-record";
import type { ShareInvite } from "./share-invite";
import {
	type CollabAccessView,
	type CollabIdentity,
	type CollabRelayLike,
	SharingEngine,
} from "./sharing-engine";

export type { CollabAccessView, CollabIdentity, CollabRelayLike } from "./sharing-engine";

/** Yjs text type the dogfood co-edit writes into. The real editor uses its own
 *  Lexical-bound types; this is a plain scratch surface for the harness so a
 *  collab session can prove convergence without booting the full editor. */
export const COLLAB_TEXT_KEY = "collab-text";

/** App id the asset-bind verb writes entities as. The bridge grants it
 *  `entities.read/write:*` in the vault ledger at bind time so the REAL
 *  type-scoped entities service (the production implicit-bind reconcile path)
 *  authorizes the write — no cap-check bypass. */
export const COLLAB_DEV_APP_ID = "io.brainstorm.dev.collab";

/** Where the bytes a `materializeAssetOnAccess` call returned came from — the
 *  observable a dogfood spec asserts lazy fetch with (first access = relay,
 *  later accesses = the restored local blob). */
export enum CollabAssetSource {
	LocalBlob = "local-blob",
	RelayFetch = "relay-fetch",
}

export type CollabAssetBindResult = { assetId: string; url: string };

export type CollabAssetStatus = {
	/** A local `assets` metadata row exists. */
	hasRow: boolean;
	/** The encrypted blob is on this device (a local `readAsset` round-trips). */
	hasLocalBytes: boolean;
	/** The entity Y.Doc carries a valid chunk manifest for the asset — the
	 *  upload-done marker `uploadBoundAsset` installs after every chunk lands.
	 *  Read through the ydoc worker's cache (current on the binding device). */
	manifestPresent: boolean;
};

export type CollabAssetBytes = { bytes: Uint8Array; mime: string };

export type CollabAssetAccessResult = CollabAssetBytes & { source: CollabAssetSource };

/** The Asset-B4 production paths the bridge's asset verbs drive — injected by
 *  `collab-dev-handlers` from the main-process wiring so this class stays
 *  unit-testable with fakes. */
export type CollabAssetDeps = {
	/** The REAL `entities` broker service (staleness-broadcast wrapper included):
	 *  route a property patch through `entities.update` so the implicit-bind
	 *  reconciler derives `asset_refs` and `onAssetBound` pushes the chunks. */
	updateEntityProperties: (
		appId: string,
		entityId: string,
		patch: Record<string, unknown>,
	) => Promise<unknown>;
	/** Raw (untrusted) chunk manifest off the entity Y.Doc (ydoc worker ferry). */
	readManifest: (entityId: string, assetId: string) => Promise<unknown>;
	/** The production asset-DEK re-home pass (normally a boot-time drain) — run
	 *  after a bind so the wrap a peer's materialize needs lands mid-session. */
	rehomeAssetDeks: () => Promise<void>;
	/** Evict the ydoc worker's cached doc so its next read loads from disk. The
	 *  dogfood receiver appends synced updates via the main-process doc store,
	 *  which the worker's in-memory cache can never observe. */
	evictWorkerDoc: (entityId: string) => Promise<void>;
	/** The production Asset-B4c cold-device metadata reconstruction pass
	 *  (`assets` + `asset_deks` + `asset_refs` rows from synced manifests). */
	reconstructAssets: (entityIds: readonly string[]) => Promise<void>;
	/** The production serve-on-miss materialisation — fetch + verify + reassemble
	 *  the chunks from the durable node, restoring the local blob. */
	materializeOnAccess: (assetId: string) => Promise<CollabAssetBytes | null>;
};

export class CollabDevBridge {
	readonly #session: VaultSession;
	readonly #getRelay: () => CollabRelayLike | null;
	readonly #engine: SharingEngine;
	readonly #assetDeps: CollabAssetDeps | null;
	#receiver: ((frame: Uint8Array) => void) | null = null;
	/** Every entity channel this shell currently subscribes to. The receiver is a
	 *  single shared listener that dispatches each frame by its own header
	 *  entityId, so one teammate can hold live subscriptions to many shared docs
	 *  at once (mirrors the production LiveSyncEngine; fixes the single-entity
	 *  receiver, F-289). */
	readonly #receiverEntityIds = new Set<string>();
	#receiveChain: Promise<unknown> = Promise.resolve();

	constructor(
		session: VaultSession,
		getRelay: () => CollabRelayLike | null,
		assetDeps: CollabAssetDeps | null = null,
	) {
		this.#session = session;
		this.#getRelay = getRelay;
		this.#engine = new SharingEngine(session, getRelay);
		this.#assetDeps = assetDeps;
	}

	/** This shell's sovereign identity + wrapping key. */
	whoami(): CollabIdentity {
		return this.#engine.whoami();
	}

	/** Collaborator-side: mint a self-signed `ShareInvite` (and persist its
	 *  single-use anchor secret in this vault — Collab-C5-invite-anchor). */
	async createInvite(label: string): Promise<ShareInvite> {
		return await this.#engine.createInvite(label);
	}

	/** Owner-side: create the entity row + DEK + the owner's Owner grant.
	 *  `properties` seeds the row (e.g. a message's `conversation`). */
	async provisionEntity(
		entityId: string,
		type: string,
		properties?: Record<string, unknown>,
	): Promise<void> {
		await this.#engine.provisionEntity(entityId, type, properties ?? { name: entityId });
	}

	/**
	 * Subscribe to `entityId`'s relay channel and install the combined,
	 * serialized receiver (WrapBootstrap → install DEK, Update → apply). Usable
	 * by BOTH sides. Idempotent + ADDITIVE — a second call subscribes another
	 * channel without dropping the first, so a teammate can hold many shared docs
	 * live at once. Ensures a local entity row exists (no DEK yet on the
	 * collaborator side — the wrap installs it). This bespoke receiver is the
	 * dev/dogfood analog of the production `LiveSyncEngine`.
	 */
	async installShareReceiver(entityId: string, type: string): Promise<void> {
		await this.#engine.ensureDekStore();
		const repo = await this.#engine.ensureEntitiesRepo();
		this.#engine.recordType(entityId, type);
		if (!repo.get(entityId)) {
			repo.create({
				id: entityId,
				type,
				properties: { name: entityId },
				createdBy: `${this.#session.identity.publicKeyBase64} (received)`,
				now: Date.now(),
				dekId: null,
			});
		}
		const relay = this.#engine.requireRelay();
		relay.subscribe?.(entityId);
		this.#receiverEntityIds.add(entityId);
		// One shared listener for ALL subscribed channels; it dispatches each frame
		// by the entityId in the frame's own header (#handleFrame). Installing a
		// second entity must not drop the first.
		if (!this.#receiver) {
			const listener = (frame: Uint8Array): void => {
				this.#receiveChain = this.#receiveChain.catch(() => {}).then(() => this.#handleFrame(frame));
			};
			relay.onFrame(listener);
			this.#receiver = listener;
		}
		void getLiveSyncEngine()?.trackOpen(entityId, type);
	}

	/** Owner-side share — delegates to the engine. */
	async share(opts: {
		entityId: string;
		type: string;
		invite: ShareInvite;
		role: AccessRole;
	}): Promise<CollabAccessView[]> {
		const members = await this.#engine.share(opts);
		void getLiveSyncEngine()?.refreshMembership(opts.entityId, opts.type);
		return members;
	}

	/** Owner-side collection share — share the container + cascade onto its
	 *  existing children (design 71). Delegates to the engine. */
	async shareCollection(opts: {
		entityId: string;
		type: string;
		invite: ShareInvite;
		role: AccessRole;
	}): Promise<CollabAccessView[]> {
		return this.#engine.shareCollection(opts);
	}

	/** Append text into the doc's scratch text type and emit the delta. */
	async editText(entityId: string, text: string): Promise<void> {
		await this.#engine.mutateAndEmit(entityId, (doc) => {
			const t = doc.getText(COLLAB_TEXT_KEY);
			t.insert(t.length, text);
		});
	}

	/** Owner revokes `memberB64` (signed, append-only audit) and emits the delta. */
	async revoke(entityId: string, memberB64: string): Promise<boolean> {
		return this.#engine.revoke(entityId, memberB64);
	}

	/** The resolved access log (active + revoked audit) for `entityId`. */
	async access(entityId: string): Promise<CollabAccessView[]> {
		return this.#engine.access(entityId);
	}

	/** The persisted doc's state vector — equal across peers ⇒ converged. */
	async stateVector(entityId: string): Promise<Uint8Array> {
		const { doc } = await this.#session.ydocStore.load(entityId);
		try {
			return Y.encodeStateVector(doc);
		} finally {
			doc.destroy();
		}
	}

	/** The current scratch text — a cheap content-level convergence check. */
	async readText(entityId: string): Promise<string> {
		const { doc } = await this.#session.ydocStore.load(entityId);
		try {
			return doc.getText(COLLAB_TEXT_KEY).toString();
		} finally {
			doc.destroy();
		}
	}

	/** PRES-4 dogfood — publish this shell's presence for a shared entity. */
	publishPresence(entityId: string, appId: string, state: Record<string, unknown> | null): void {
		getPresenceRouter()?.publish(appId, entityId, state);
	}

	/** PRES-4 dogfood — remote peer snapshots after the relay round-trip. */
	presenceRemotePeers(entityId: string): { clientId: number; state: Record<string, unknown> }[] {
		return [...(getPresenceRouter()?.remotePeerSnapshots(entityId) ?? [])];
	}

	/**
	 * Asset-B4 dogfood — create an encrypted asset from `bytes` through the REAL
	 * `AssetStore` (per-asset random DEK, sealed blob), then reference it from
	 * `entityId`'s properties as a `brainstorm://asset/<id>` URL through the REAL
	 * entities service, so the implicit-bind reconciler derives the `asset_refs`
	 * row and the post-commit `onAssetBound` hook pushes the chunks to the node.
	 * Finishes with the production asset-DEK re-home pass (a boot-time drain in
	 * normal operation) so the entity-doc wrap a peer's materialize needs exists
	 * before this session shares the entity.
	 */
	async bindAsset(
		entityId: string,
		bytes: Uint8Array,
		mime: string,
		propertyKey: string,
	): Promise<CollabAssetBindResult> {
		const deps = this.#requireAssetDeps();
		const store = await this.#session.assetStore();
		const { assetId } = await store.writeAsset({ bytes, mime, kind: AssetKind.Upload });
		const url = `brainstorm://asset/${assetId}`;
		await this.#grantDevEntityCaps();
		await deps.updateEntityProperties(COLLAB_DEV_APP_ID, entityId, { [propertyKey]: url });
		await deps.rehomeAssetDeks();
		return { assetId, url };
	}

	/** Local + wire observability for one (entity, asset) pair — what a spec
	 *  polls to await the upload (manifest present) and to prove lazy fetch
	 *  (no row / no local bytes before the first access on a peer). */
	async assetStatus(entityId: string, assetId: string): Promise<CollabAssetStatus> {
		const deps = this.#requireAssetDeps();
		const store = await this.#session.assetStore();
		const db = await this.#session.dataStores.open("entities");
		const hasRow = new AssetsRepository(db).getById(assetId) !== null;
		const hasLocalBytes = hasRow && (await store.readAsset(assetId)) !== null;
		const manifestPresent =
			parseAssetChunkManifest(await deps.readManifest(entityId, assetId)) !== null;
		return { hasRow, hasLocalBytes, manifestPresent };
	}

	/**
	 * Asset-B4 dogfood — materialise an asset ON ACCESS, exactly as production
	 * lazy fetch does: reconstruct the local metadata from the synced manifest +
	 * re-homed DEK wrap if this device never had it (Asset-B4c), serve the local
	 * blob when present, else fetch + verify + reassemble the chunks from the
	 * durable node (serve-on-miss), which restores the blob for later reads. The
	 * returned `source` is the lazy-fetch observable.
	 */
	async materializeAssetOnAccess(
		entityId: string,
		assetId: string,
	): Promise<CollabAssetAccessResult | null> {
		const deps = this.#requireAssetDeps();
		await deps.evictWorkerDoc(entityId);
		await deps.reconstructAssets([entityId]);
		const store = await this.#session.assetStore();
		const local = await store.readAsset(assetId);
		if (local) {
			return { bytes: local.bytes, mime: local.mime, source: CollabAssetSource.LocalBlob };
		}
		const fetched = await deps.materializeOnAccess(assetId);
		return fetched
			? { bytes: fetched.bytes, mime: fetched.mime, source: CollabAssetSource.RelayFetch }
			: null;
	}

	/** The asset's bytes from the LOCAL store only — never the wire. Null when
	 *  the row or blob is absent (the "bytes not here before access" probe). */
	async readAssetLocal(assetId: string): Promise<CollabAssetBytes | null> {
		const store = await this.#session.assetStore();
		const got = await store.readAsset(assetId);
		return got ? { bytes: got.bytes, mime: got.mime } : null;
	}

	dispose(): void {
		const relay = this.#getRelay();
		if (relay) this.#detachReceiver(relay);
	}

	// --- internals ----------------------------------------------------------

	#requireAssetDeps(): CollabAssetDeps {
		if (!this.#assetDeps) {
			throw new Error("collab-dev-bridge: asset deps not wired");
		}
		return this.#assetDeps;
	}

	/** Idempotent runtime grants so the type-scoped entities service authorizes
	 *  the dev app's writes through its normal ledger check. */
	async #grantDevEntityCaps(): Promise<void> {
		const ledger = await this.#session.capabilityLedger();
		for (const capability of ["entities.read", "entities.write"]) {
			ledger.grant({
				appId: COLLAB_DEV_APP_ID,
				capability,
				scope: "*",
				grantedVia: GrantedVia.Runtime,
			});
		}
	}

	async #handleFrame(frame: Uint8Array): Promise<void> {
		try {
			const decoded = decodeFrame(frame);
			const entityId = decoded.header.entityId;
			if (!this.#receiverEntityIds.has(entityId)) return;
			const relay = this.#getRelay();
			if (!relay) return;
			const ctx = this.#engine.makeCtx(relay.currentPort());
			if (decoded.header.kind === WireKind.WrapBootstrap) {
				await receiveWrapBootstrap(frame, ctx, async (received, id) => {
					await this.#engine.installWrap(received, id);
				});
			} else if (decoded.header.kind === WireKind.Update) {
				await receiveAndApply(frame, ctx, async (plaintext) => {
					await this.#engine.serializedAppendUpdate(entityId, plaintext);
				});
			}
		} catch (error) {
			console.warn(`[dev:collab] receive failed: ${(error as Error).message}`);
		}
	}

	#detachReceiver(relay: CollabRelayLike): void {
		if (this.#receiver) {
			relay.offFrame(this.#receiver);
			this.#receiver = null;
		}
		for (const id of this.#receiverEntityIds) relay.unsubscribe?.(id);
		this.#receiverEntityIds.clear();
	}
}

/** Parse + validate an `AccessRole` from the wire (IPC string arg). */
export function parseAccessRole(value: unknown): AccessRole {
	if (isAccessRole(value)) return value;
	throw new Error(`collab-dev-bridge: invalid role "${String(value)}"`);
}
