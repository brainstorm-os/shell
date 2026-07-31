/**
 * Stage 10.12 — `LiveSyncEngine`: always-on online live sync.
 *
 * The 10.0–10.9 spine proved the crypto + blind-relay wire path, but on the
 * *normal* app path nothing auto-emits (only the dev/collab/pairing bridges
 * called `encryptAndEmit`) and inbound frames were never applied to a live
 * doc. This engine closes that — it is the production-shaped analog of
 * `CollabDevBridge`, but driven by the normal entities-service edit path
 * instead of `dev:collab:*` IPC:
 *
 *   1. **subscribe** — `trackOpen(entityId, type)` is called when an app
 *      `loadDoc`s an entity. If the entity is **shared** (its signed access
 *      record lists >1 active member) the engine subscribes that entity's
 *      relay channel and remembers the type. Solo entities are ignored — the
 *      relay stays quiet (no channel, no traffic) per the 10.12 scope.
 *   2. **emit** — `noteLocalUpdate(entityId, update)` is called after a local
 *      `applyDoc` / `setEntityState` commit persists. If the entity is shared
 *      the engine `encryptAndEmit`s the update through the active relay.
 *   3. **apply** — inbound relay frames are decoded; `Update` frames for a
 *      tracked entity are decrypted (`receiveAndApply`, DEK opened in-process
 *      and zeroed) and the plaintext is handed to `applyRemoteUpdate`, which
 *      the wiring routes into the ydoc worker's live cached doc (apply +
 *      persist) and on to any open renderer windows (`deliverDocUpdate`).
 *
 * **No echo loop by construction.** Remote updates are applied via
 * `applyRemoteUpdate` — a path that does NOT pass through the capability-gated
 * `entities.applyDoc` verb, so it never triggers `noteLocalUpdate`. Only
 * app-originated IPC edits reach the emit hook.
 *
 * **Relay-blind boundary intact.** This file lives outside `**\/sync/**\/*relay*.ts`
 * (the CI fence's glob), so it MAY touch crypto — and it must, to seal/open
 * envelopes. The relay *transport* it talks to (`RelaySurface`) stays blind.
 *
 * Online-only: an entity edited while the relay is unreachable does not
 * backfill — that is `SYNC-2`'s durable-store job. The engine simply emits
 * against the current port; a missed frame is a missed frame at 10.12.
 */

import { inboxChannelFor } from "../collab/inbox-channel";
import { XCHACHA_NONCE_BYTES, bytesToBase64 } from "../credentials/crypto";
import type { MemberWrapPayload } from "../credentials/member-wraps";
import type { EntityDekStore } from "../entities/entity-dek-store";
import { decodeFrame } from "./envelope-codec";
import {
	type PipelineContext,
	emitAwareness,
	emitSnapshot,
	encryptAndEmit,
	receiveAndApply,
	receiveAwareness,
	receiveWrapBootstrap,
} from "./envelope-pipeline";
import type { RelayPort, RelaySurface } from "./relay-port";
import { WireKind } from "./routing-header";

/**
 * Everything the engine needs that lives in the vault session / wiring layer.
 * Injected so the engine is a pure, deterministically-testable core (two
 * engines over a `LoopbackRelayPort` reproduce a live co-edit with no shell).
 */
export type LiveSyncEngineContext = {
	/** The swap-stable relay surface (`ActiveRelayOrchestrator`), or null when
	 *  no transport is up yet. Read on every send so a port swap is transparent. */
	getRelay: () => RelaySurface | null;
	/** Per-entity DEK store — opened on demand per envelope, zeroed by the
	 *  pipeline. The engine never caches a DEK. */
	dekStore: EntityDekStore;
	/** This device's sovereign Ed25519 public key — the wire `sender`. */
	devicePub: Uint8Array;
	/** Ed25519 sign closure (the secret never leaves the session). */
	deviceSign: (bytes: Uint8Array) => Uint8Array;
	/** Ed25519 verify against the sender pubkey carried in the frame header. */
	deviceVerify: (sig: Uint8Array, bytes: Uint8Array, senderPub: Uint8Array) => boolean;
	/** Resolve an entity id → its type, or null if unknown locally. */
	resolveEntityType: (entityId: string) => string | null;
	/** Is this entity shared (signed access record lists >1 active member)?
	 *  Consulted once per `trackOpen` and cached; solo ⇒ the engine ignores it. */
	isShared: (entityId: string) => Promise<boolean>;
	/** Stage 10.13 — does the device's selective-sync policy admit this entity?
	 *  Consulted alongside `isShared`: an entity syncs only if it is BOTH shared
	 *  AND policy-admitted. Optional; absent ⇒ admit everything (the desktop
	 *  default), so the 10.12 behaviour is unchanged when no policy is wired. */
	policyAdmits?: (entityId: string) => boolean | Promise<boolean>;
	/** Apply a decrypted remote Yjs update to the live doc + persist + notify
	 *  open renderers. Implemented by the wiring over the ydoc worker +
	 *  `deliverDocUpdate`; deliberately NOT the `entities.applyDoc` verb (that
	 *  would re-enter the emit hook). */
	applyRemoteUpdate: (entityId: string, type: string, update: Uint8Array) => Promise<void>;
	/** Presence (Stage 10.6 wiring) — deliver a decrypted remote AWARENESS update
	 *  (cursors / selection / "who's here") for a tracked entity to the open app
	 *  renderers, which apply it to their `y-protocols` `Awareness`. Implemented by
	 *  the wiring over the presence IPC channel; absent ⇒ inbound awareness is
	 *  dropped (presence off). Distinct from `applyRemoteUpdate`: awareness is
	 *  ephemeral, never persisted to the doc/ydoc store. */
	applyRemoteAwareness?: (
		entityId: string,
		type: string,
		update: Uint8Array,
	) => void | Promise<void>;
	/** Stage 10.14 — the full Yjs state (`Y.encodeStateAsUpdate`) for an entity,
	 *  fetched from the ydoc worker. Used to emit a `Snapshot` frame when the
	 *  local doc compacts, so the durable node can compact its tail too. Optional;
	 *  absent ⇒ the engine never emits snapshots (the node keeps only the tail). */
	getEntitySnapshot?: (entityId: string) => Promise<Uint8Array | null>;
	/** Stage 10.14 — install a per-entity DEK recovered from an inbound
	 *  `WrapBootstrap` frame (the durable node serves these first in backfill).
	 *  Implemented by the wiring over the session: HPKE-unwrap with the device
	 *  X25519 secret (never leaves the session), re-seal under the master key,
	 *  persist into the DEK store, and — on a cold/restoring device — materialize
	 *  the `entities.db` row from the recovered `type` so the snapshot that
	 *  follows has a parent row to update. Returns the recovered entity `type`
	 *  (null for a pre-10.14 wrap that sealed only the DEK), which the engine
	 *  uses to promote a restore-tracked entity from its pending sentinel to the
	 *  real type. Optional; absent ⇒ the engine ignores inbound wraps (live-only
	 *  mode, no restore). The X25519 secret never crosses here — only the
	 *  resulting install side-effect. */
	installWrap?: (
		wrap: MemberWrapPayload,
		entityId: string,
		senderPubB64: string,
	) => Promise<string | null>;
	/** Stage 10.5c revoke predicate — drops frames from a revoked device before
	 *  any crypto. Optional; absent ⇒ enforcement off (back-compat). */
	isDeviceRevoked?: (senderPub: Uint8Array) => boolean;
	/** Collab-C5 (F-288) writer-role predicate — drops an inbound update whose
	 *  authenticated sender isn't an Editor+ member of the entity. Receives the
	 *  decrypted update so a first-share receiver can authorize off the signed
	 *  record the frame carries. Optional; absent ⇒ enforcement off (back-compat). */
	authorizeWriter?: (
		senderPubB64: string,
		resolvedEntityId: string,
		plaintext: Uint8Array,
	) => boolean | Promise<boolean>;
	nowMs?: () => number;
	randomNonce?: () => Uint8Array;
	/** Stage 10.7 traffic-tick hooks for the sync-status surface. */
	onSent?: (frameBytes: number) => void;
	onReceived?: (frameBytes: number) => void;
};

function defaultNonce(): Uint8Array {
	const n = new Uint8Array(XCHACHA_NONCE_BYTES);
	crypto.getRandomValues(n);
	return n;
}

/** Stage 10.14 — placeholder type for a restore-tracked entity before its
 *  `WrapBootstrap` arrives (the cold device doesn't yet know the real type).
 *  Non-empty so the `#tracked` membership check passes; the leading space
 *  can't collide with a real reverse-DNS type, so a state frame that somehow
 *  preceded the wrap is dropped rather than applied under it. */
const RESTORE_PENDING_TYPE = " restore-pending";

export class LiveSyncEngine {
	readonly #ctx: LiveSyncEngineContext;
	/** Entities this device has open AND that are shared — the only ids the
	 *  engine emits for and accepts inbound frames for. id → type. A
	 *  restore-tracked entity sits at {@link RESTORE_PENDING_TYPE} until its
	 *  wrap arrives and promotes it to the real type. */
	readonly #tracked = new Map<string, string>();
	/** Stage 10.14 — restore-tracked entities whose `WrapBootstrap` has landed
	 *  (DEK installed + row materialized). id → recovered type. The restore
	 *  engine reads this to report which catalog entries actually came back. */
	readonly #restored = new Map<string, string>();
	/** Per-entity monotonic seq for the wire header (replay-window debugging). */
	readonly #seq = new Map<string, number>();
	/** Serialize inbound apply so an out-of-order pair can't interleave a
	 *  half-applied doc — mirrors the dev bridge's single receive chain. */
	#receiveChain: Promise<unknown> = Promise.resolve();
	#frameListener: ((frame: Uint8Array) => void) | null = null;
	#disposed = false;
	/** Collab-C5 — this identity's inbox channel; we subscribe to it so an owner
	 *  can deliver a cross-user share's `WrapBootstrap` for an entity we don't
	 *  yet know. Derived once from the sovereign pubkey. */
	readonly #inbox: string;

	constructor(ctx: LiveSyncEngineContext) {
		this.#ctx = ctx;
		this.#inbox = inboxChannelFor(bytesToBase64(ctx.devicePub));
	}

	/** Attach the relay frame listener + subscribe to our inbox channel.
	 *  Idempotent. Listeners survive port swaps because `RelaySurface.onFrame`
	 *  re-binds on rebuild. */
	start(): void {
		if (this.#disposed || this.#frameListener) return;
		const relay = this.#ctx.getRelay();
		if (!relay) return;
		const listener = (frame: Uint8Array): void => {
			this.#receiveChain = this.#receiveChain.catch(() => {}).then(() => this.#handleFrame(frame));
		};
		relay.onFrame(listener);
		this.#frameListener = listener;
		// Receive cross-user share wraps addressed to us (Collab-C5).
		relay.subscribe?.(this.#inbox);
	}

	/**
	 * Called when an app opens an entity's doc. If the entity is shared the
	 * engine starts tracking it (emit + accept inbound) and subscribes its
	 * relay channel. Idempotent. A solo entity is a no-op — it never touches
	 * the relay. Ensures the frame listener is attached.
	 */
	async trackOpen(entityId: string, type: string): Promise<void> {
		if (this.#disposed) return;
		if (this.#tracked.has(entityId)) return;
		if (!(await this.#shouldSync(entityId))) return;
		if (this.#disposed || this.#tracked.has(entityId)) return;
		this.#tracked.set(entityId, type);
		this.start();
		this.#ctx.getRelay()?.subscribe?.(entityId);
	}

	/**
	 * Stage 10.14 — track an entity for cold-restore WITHOUT the `isShared`
	 * gate. A restoring device has no local doc to read the access record from,
	 * so it can't pass `isShared` — but the durable node's catalog already
	 * asserts the account owns this entity, so subscribing is safe. The entity
	 * is tracked at {@link RESTORE_PENDING_TYPE} so inbound frames are accepted;
	 * the `WrapBootstrap` (served first in backfill) installs the DEK, the
	 * wiring materializes the row from the recovered type, and `#handleWrap`
	 * promotes the tracked type — after which the `snapshot ++ tail` apply.
	 * Idempotent; ensures the frame listener is attached and subscribes.
	 */
	trackForRestore(entityId: string): void {
		if (this.#disposed || this.#tracked.has(entityId)) return;
		this.#tracked.set(entityId, RESTORE_PENDING_TYPE);
		this.start();
		this.#ctx.getRelay()?.subscribe?.(entityId);
	}

	/**
	 * 10.10 — batch form of {@link trackForRestore}: track the WHOLE catalog in
	 * one pass and subscribe through the relay's `subscribeBatch` when the
	 * transport has one. The WebSocket port coalesces the ids into chunked
	 * `bundle:true` subscribe controls, so the durable node answers the entire
	 * bootstrap backfill as bundled frames (few messages) instead of one
	 * message per wrap/snapshot/tail frame. Semantically identical to looping
	 * `trackForRestore`; already-tracked ids are skipped.
	 */
	trackForRestoreBatch(entityIds: readonly string[]): void {
		if (this.#disposed) return;
		const fresh = entityIds.filter((id) => !this.#tracked.has(id));
		if (fresh.length === 0) return;
		for (const id of fresh) this.#tracked.set(id, RESTORE_PENDING_TYPE);
		this.start();
		const relay = this.#ctx.getRelay();
		if (!relay) return;
		if (relay.subscribeBatch) {
			relay.subscribeBatch(fresh);
			return;
		}
		for (const id of fresh) relay.subscribe?.(id);
	}

	/** Stage 10.14 — the recovered type of a restore-tracked entity whose wrap
	 *  has landed, or null if it hasn't (or the entity wasn't restore-tracked). */
	restoredType(entityId: string): string | null {
		return this.#restored.get(entityId) ?? null;
	}

	/**
	 * Re-evaluate an entity's shared+policy state — call after a share grant or
	 * revoke mutates the access record so a freshly-shared open entity starts
	 * syncing (and a fully-revoked one stops). Cheap when the state is unchanged.
	 */
	async refreshMembership(entityId: string, type: string): Promise<void> {
		if (this.#disposed) return;
		const sync = await this.#shouldSync(entityId);
		if (sync && !this.#tracked.has(entityId)) {
			this.#tracked.set(entityId, type);
			this.start();
			this.#ctx.getRelay()?.subscribe?.(entityId);
		} else if (!sync && this.#tracked.has(entityId)) {
			this.#tracked.delete(entityId);
			this.#ctx.getRelay()?.unsubscribe?.(entityId);
		}
	}

	/**
	 * Stage 10.13 — the selective-sync policy changed. Re-evaluate every tracked
	 * entity and **unsubscribe** any the new policy no longer admits (its local
	 * copy is untouched — eviction/re-fetch is `SYNC-2`'s job). A newly-admitted
	 * entity that isn't currently open is picked up on its next `trackOpen`.
	 */
	async refreshPolicy(): Promise<void> {
		if (this.#disposed) return;
		for (const entityId of [...this.#tracked.keys()]) {
			if (!(await this.#shouldSync(entityId))) {
				this.#tracked.delete(entityId);
				this.#ctx.getRelay()?.unsubscribe?.(entityId);
			}
		}
	}

	/** An entity syncs only if it is BOTH shared AND admitted by the device's
	 *  selective-sync policy (absent predicate ⇒ admit). */
	async #shouldSync(entityId: string): Promise<boolean> {
		if (!(await this.#ctx.isShared(entityId))) return false;
		if (!this.#ctx.policyAdmits) return true;
		return await this.#ctx.policyAdmits(entityId);
	}

	/** Stop tracking an entity (its last window closed). The channel is
	 *  unsubscribed; a later `trackOpen` re-subscribes. */
	untrack(entityId: string): void {
		this.#restored.delete(entityId);
		if (!this.#tracked.delete(entityId)) return;
		this.#ctx.getRelay()?.unsubscribe?.(entityId);
	}

	isTracked(entityId: string): boolean {
		return this.#tracked.has(entityId);
	}

	/** Resolves when the current in-flight inbound-apply chain settles. Lets a
	 *  caller (or a test) await convergence after a peer emits. */
	whenIdle(): Promise<unknown> {
		return this.#receiveChain.catch(() => {});
	}

	/**
	 * Emit a locally-produced Yjs update for a shared, tracked entity. No-op
	 * for an untracked (solo / not-open) entity, so the per-keystroke path
	 * stays free for the overwhelming solo-edit majority. A relay/emit failure
	 * is swallowed (online-only: a missed frame is not a failed edit).
	 */
	async noteLocalUpdate(entityId: string, update: Uint8Array): Promise<void> {
		if (this.#disposed) return;
		if (!this.#tracked.has(entityId)) return;
		const relay = this.#ctx.getRelay();
		if (!relay) return;
		try {
			await encryptAndEmit(entityId, update, this.#makeCtx(relay.currentPort()));
		} catch (error) {
			console.warn(`[live-sync] emit failed for ${entityId}: ${(error as Error).message}`);
		}
	}

	/**
	 * Presence — emit a locally-produced AWARENESS update (cursor / selection /
	 * "I'm here") for a tracked, shared entity, sealed under the same per-entity
	 * DEK as doc updates (the relay sees ciphertext). No-op for an untracked /
	 * solo entity so presence never touches the relay for a private doc. Ephemeral
	 * and best-effort: a missed awareness frame just means a momentarily-stale
	 * cursor, never a failed edit, so a relay error is swallowed.
	 */
	async emitLocalAwareness(entityId: string, update: Uint8Array): Promise<void> {
		if (this.#disposed) return;
		if (!this.#tracked.has(entityId)) return;
		const relay = this.#ctx.getRelay();
		if (!relay) return;
		try {
			await emitAwareness(entityId, update, this.#makeCtx(relay.currentPort()));
		} catch (error) {
			console.warn(`[live-sync] awareness emit failed for ${entityId}: ${(error as Error).message}`);
		}
	}

	/**
	 * Stage 10.14 — the local doc for a tracked entity just compacted (its tail
	 * crossed the 256 KiB threshold). Emit a full-state `Snapshot` frame so the
	 * durable node swaps in a fresh snapshot and resets ITS tail — bounding the
	 * node's storage to the client's compaction cadence. No-op for an untracked
	 * entity or when no snapshot source is wired; a failure is swallowed
	 * (online-only — a missed snapshot just means the node keeps the longer tail).
	 */
	async noteCompaction(entityId: string): Promise<void> {
		if (this.#disposed) return;
		if (!this.#tracked.has(entityId)) return;
		if (!this.#ctx.getEntitySnapshot) return;
		const relay = this.#ctx.getRelay();
		if (!relay) return;
		try {
			const state = await this.#ctx.getEntitySnapshot(entityId);
			if (!state || this.#disposed || !this.#tracked.has(entityId)) return;
			await emitSnapshot(entityId, state, this.#makeCtx(relay.currentPort()));
		} catch (error) {
			console.warn(`[live-sync] snapshot emit failed for ${entityId}: ${(error as Error).message}`);
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const relay = this.#ctx.getRelay();
		if (relay && this.#frameListener) {
			relay.offFrame(this.#frameListener);
			for (const id of this.#tracked.keys()) relay.unsubscribe?.(id);
			relay.unsubscribe?.(this.#inbox);
		}
		this.#frameListener = null;
		this.#tracked.clear();
		this.#restored.clear();
		this.#seq.clear();
	}

	// --- internals ----------------------------------------------------------

	async #handleFrame(frame: Uint8Array): Promise<void> {
		if (this.#disposed) return;
		let entityId: string;
		try {
			const decoded = decodeFrame(frame);
			entityId = decoded.header.entityId;
			// Update + Snapshot are DEK-sealed doc state (a Snapshot is the full
			// state, e.g. an offline-backfill frame) and apply identically +
			// idempotently. WrapBootstrap carries a per-entity DEK wrap — the
			// durable node serves these FIRST in restore backfill (10.14), so the
			// device installs the DEK before applying the state; handled below.
			// Awareness is ephemeral presence (cursors / selection / who's-here),
			// routed to the open renderer but never persisted; foreign kinds ignored.
			if (decoded.header.kind === WireKind.WrapBootstrap) {
				await this.#handleWrap(frame, entityId);
				return;
			}
			if (decoded.header.kind === WireKind.Awareness) {
				await this.#handleAwareness(frame, entityId);
				return;
			}
			if (decoded.header.kind !== WireKind.Update && decoded.header.kind !== WireKind.Snapshot) {
				return;
			}
		} catch {
			return;
		}
		const type = this.#tracked.get(entityId);
		if (!type) return;
		// 10.14 — a restore-tracked entity at the pending sentinel has no row +
		// no DEK yet (its wrap hasn't landed). The node serves wraps first, so
		// this only fires on a misordered stream; drop rather than apply state
		// under a placeholder type (the row would be missing anyway).
		if (type === RESTORE_PENDING_TYPE) return;
		const relay = this.#ctx.getRelay();
		if (!relay) return;
		try {
			await receiveAndApply(frame, this.#makeCtx(relay.currentPort()), async (plaintext) => {
				await this.#ctx.applyRemoteUpdate(entityId, type, plaintext);
			});
		} catch (error) {
			console.warn(`[live-sync] receive failed for ${entityId}: ${(error as Error).message}`);
		}
	}

	/**
	 * Stage 10.14 — install a per-entity DEK from an inbound `WrapBootstrap`
	 * (the durable node serves these first in restore backfill). NOT gated on
	 * `#tracked`: a cold/restoring device has no doc to read the access record
	 * from, so it can't pass `isShared` — but a wrap is HPKE-sealed *for this
	 * device*, so installing the DEK it carries is always safe + idempotent.
	 * The verify/parse/unseal happens in `receiveWrapBootstrap` + the wiring's
	 * `installWrap`; the device X25519 secret never crosses into the engine.
	 */
	async #handleWrap(frame: Uint8Array, entityId: string): Promise<void> {
		if (!this.#ctx.installWrap) return;
		const relay = this.#ctx.getRelay();
		if (!relay) return;
		// Collab-C5 cross-user share — a wrap for an entity we DON'T track means
		// we were just granted access (it reached us via our inbox `route`). But
		// `receiveWrapBootstrap` refuses an unknown entity, so speculatively
		// pre-register it at the pending sentinel + subscribe to its channel so
		// the wrap resolves; `installWrap` recovers the real type and the
		// promotion below upgrades the track. A wrap that doesn't actually
		// install for us (not ours / malformed) is rolled back. A
		// restore-tracked entity (`trackForRestore`) is already tracked, so it
		// takes the 10.14 path (preRegistered = false) and IS reported to the
		// restore engine; a live share is not.
		const preRegistered = !this.#tracked.has(entityId);
		if (preRegistered) {
			this.#tracked.set(entityId, RESTORE_PENDING_TYPE);
			relay.subscribe?.(entityId);
		}
		let installedType: string | null = null;
		try {
			await receiveWrapBootstrap(
				frame,
				this.#makeCtx(relay.currentPort()),
				async (wrap, id, senderPubB64) => {
					installedType = (await this.#ctx.installWrap?.(wrap, id, senderPubB64)) ?? null;
				},
			);
		} catch (error) {
			console.warn(`[live-sync] wrap install failed for ${entityId}: ${(error as Error).message}`);
		}
		if (installedType && this.#tracked.get(entityId) === RESTORE_PENDING_TYPE) {
			// Promote the pending track to the recovered type so the snapshot/tail
			// (or the owner's initial state) that follow apply under the right type.
			this.#tracked.set(entityId, installedType);
			// Only a genuine restore (pre-existing trackForRestore) is reported to
			// the restore engine — a live cross-user share is not.
			if (!preRegistered) this.#restored.set(entityId, installedType);
		} else if (preRegistered && this.#tracked.get(entityId) === RESTORE_PENDING_TYPE) {
			// Speculative pre-register that never installed — undo it.
			this.#tracked.delete(entityId);
			relay.unsubscribe?.(entityId);
		}
	}

	/** Decrypt an inbound `Awareness` frame for a tracked entity and hand the
	 *  plaintext to `applyRemoteAwareness` (→ the open renderer). Ephemeral: never
	 *  persisted. No-op if presence isn't wired or the entity is untracked/pending. */
	async #handleAwareness(frame: Uint8Array, entityId: string): Promise<void> {
		if (!this.#ctx.applyRemoteAwareness) return;
		const type = this.#tracked.get(entityId);
		if (!type || type === RESTORE_PENDING_TYPE) return;
		const relay = this.#ctx.getRelay();
		if (!relay) return;
		try {
			await receiveAwareness(frame, this.#makeCtx(relay.currentPort()), async (plaintext) => {
				await this.#ctx.applyRemoteAwareness?.(entityId, type, plaintext);
			});
		} catch (error) {
			console.warn(
				`[live-sync] awareness receive failed for ${entityId}: ${(error as Error).message}`,
			);
		}
	}

	#makeCtx(relay: RelayPort): PipelineContext {
		const ctx: PipelineContext = {
			dekStore: this.#ctx.dekStore,
			devicePub: this.#ctx.devicePub,
			deviceSign: this.#ctx.deviceSign,
			deviceVerify: this.#ctx.deviceVerify,
			resolveEntity: (routedId) => {
				const type = this.#tracked.get(routedId) ?? this.#ctx.resolveEntityType(routedId);
				return type ? { id: routedId, type } : null;
			},
			relay,
			nextSeq: (entityId) => {
				const next = (this.#seq.get(entityId) ?? -1) + 1;
				this.#seq.set(entityId, next);
				return next;
			},
			nowMs: this.#ctx.nowMs ?? (() => Date.now()),
			randomNonce: this.#ctx.randomNonce ?? defaultNonce,
		};
		if (this.#ctx.isDeviceRevoked) ctx.isDeviceRevoked = this.#ctx.isDeviceRevoked;
		if (this.#ctx.authorizeWriter) ctx.authorizeWriter = this.#ctx.authorizeWriter;
		if (this.#ctx.onSent) ctx.onSent = this.#ctx.onSent;
		if (this.#ctx.onReceived) ctx.onReceived = this.#ctx.onReceived;
		return ctx;
	}
}
