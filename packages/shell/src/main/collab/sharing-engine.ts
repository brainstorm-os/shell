/**
 * SharingEngine (Collab-C5) — the session-bound, relay-bound core of the
 * collaboration share/revoke flow, extracted from {@link CollabDevBridge} so it
 * is reused unchanged by BOTH the dev/dogfood bridge AND the production,
 * capability-gated `sharing` broker service (`main/sharing/sharing-service.ts`).
 *
 * It owns the C1 access-record + C2 share-invite primitives over the PERSISTED
 * `YDocStore` (not in-memory docs) and emits frames over the live relay — the
 * exact path proven end-to-end by the two-shell `collab-001` real-Electron
 * dogfood, so the production service inherits that coherence. It deliberately
 * carries NO inbound receiver: in production, ongoing sync of a now-shared
 * entity rides the always-on {@link LiveSyncEngine} (10.12), which subscribes
 * any entity whose signed access record lists >1 active member. The dev bridge
 * layers its own bespoke receiver on top for the dogfood harness.
 *
 * Relay-blind boundary intact: this file never reads a frame body in the clear
 * except through the same `envelope-pipeline` DEK path the rest of sync uses.
 */

import * as Y from "yjs";
import { XCHACHA_NONCE_BYTES, base64ToBytes } from "../credentials/crypto";
import { verifySignature } from "../credentials/identity";
import {
	type MemberWrapPayload,
	appendWrap,
	findWrapForRecipient,
	wrapDekForRecipient,
} from "../credentials/member-wraps";
import type { EntityDekStore } from "../entities/entity-dek-store";
import { installEntityDek } from "../entities/install-wrap";
import { queryVaultListSource } from "../entities/vault-entities-service";
import { EntitiesRepository } from "../storage/entities-repo";
import { type PipelineContext, emitWrapBootstrap, encryptAndEmit } from "../sync/envelope-pipeline";
import type { RelayPort, RelaySurface } from "../sync/relay-port";
import type { VaultSession } from "../vault/session";
import {
	AccessRole,
	type ResolvedMember,
	grantAccess,
	resolveCurrentMembers,
	revokeAccess,
} from "./access-record";
import { childrenSourceFor, containmentRuleForParent } from "./containment-registry";
import { inboxChannelFor } from "./inbox-channel";
import { type ShareInvite, createShareInviteSigned, shareEntityWithInvite } from "./share-invite";

function freshNonce(): Uint8Array {
	const n = new Uint8Array(XCHACHA_NONCE_BYTES);
	crypto.getRandomValues(n);
	return n;
}

/** The relay surface the engine needs — satisfied by `ActiveRelayOrchestrator`
 *  (production) and a loopback adapter (tests). */
export type CollabRelayLike = RelaySurface;

export type CollabIdentity = {
	/** base64 sovereign user-Ed25519 key — what access grants name + the wire sender. */
	userPubB64: string;
	/** base64 device X25519 wrapping key — the HPKE recipient an invite carries. */
	x25519PubB64: string;
};

export type CollabAccessView = {
	member: string;
	role: AccessRole;
	active: boolean;
	revokedAt: number | null;
};

function toAccessView(m: ResolvedMember): CollabAccessView {
	return { member: m.member, role: m.role, active: m.active, revokedAt: m.revokedAt };
}

/**
 * Owns the session-bound share flow. One instance per active vault session;
 * the relay is read on every emit through `getRelay` so a port swap is
 * transparent.
 */
export class SharingEngine {
	readonly #session: VaultSession;
	readonly #getRelay: () => CollabRelayLike | null;
	readonly #seq = new Map<string, number>();
	readonly #types = new Map<string, string>();
	readonly #appendQueues = new Map<string, Promise<unknown>>();
	#dekStore: EntityDekStore | null = null;
	#entitiesRepo: EntitiesRepository | null = null;

	constructor(session: VaultSession, getRelay: () => CollabRelayLike | null) {
		this.#session = session;
		this.#getRelay = getRelay;
	}

	/** This shell's sovereign identity + wrapping key — names the user across the share flow. */
	whoami(): CollabIdentity {
		return {
			userPubB64: this.#session.identity.publicKeyBase64,
			x25519PubB64: this.#session.deviceX25519.publicKeyBase64,
		};
	}

	/** Collaborator-side: mint a self-signed `ShareInvite` (the secret never
	 *  leaves the session — `createShareInviteSigned` takes a signing closure). */
	createInvite(label: string): ShareInvite {
		return createShareInviteSigned({
			userPub: this.#session.identity.publicKey,
			x25519Pub: this.#session.deviceX25519.publicKey,
			label,
			sign: (payload) => this.#session.signPayload(payload),
		});
	}

	/** Owner-side: create the entity row + a fresh DEK and bootstrap the owner's
	 *  own Owner grant into the doc's access log. Idempotent on an existing row.
	 *  `properties` lets a caller seed the row (e.g. a message's `conversation`
	 *  pointing at its channel, so the collection cascade can enumerate it);
	 *  defaults to `{ name: entityId }`. */
	async provisionEntity(
		entityId: string,
		type: string,
		properties: Record<string, unknown> = { name: entityId },
	): Promise<void> {
		const dekStore = await this.ensureDekStore();
		const repo = await this.ensureEntitiesRepo();
		this.#types.set(entityId, type);
		if (!repo.get(entityId)) {
			const dekId = dekStore.nextDekId();
			repo.transaction(() => {
				repo.create({
					id: entityId,
					type,
					properties,
					createdBy: this.#session.identity.publicKeyBase64,
					now: Date.now(),
					dekId,
				});
				const handle = dekStore.persist(entityId, dekId);
				dekStore.close(handle.dek);
			});
		}
		const exposed = this.#session.exposeIdentityForPairing();
		await this.mutateAndEmit(entityId, (doc) => {
			grantAccess(doc, {
				entityId,
				member: this.#session.identity.publicKeyBase64,
				role: AccessRole.Owner,
				signerSecret: exposed.secretKey,
				now: Date.now(),
			});
		});
	}

	/**
	 * Owner-side share: verify the invite, append a signed grant + HPKE-wrap the
	 * DEK into the doc (C2 `shareEntityWithInvite`), persist the doc delta, then
	 * emit the wrap (`emitWrapBootstrap`) and the full encrypted doc state so the
	 * collaborator installs the DEK and reads the doc (the grant rides inside
	 * it). Returns the resolved access view after the share.
	 */
	async share(opts: {
		entityId: string;
		type: string;
		invite: ShareInvite;
		role: AccessRole;
	}): Promise<CollabAccessView[]> {
		await this.#shareOne(opts.entityId, opts.type, opts.invite, opts.role);
		return this.access(opts.entityId);
	}

	/**
	 * Collection-sharing (design 71): share a container with the invitee AND
	 * cascade the same grant + per-entity DEK-wrap onto every existing child of
	 * the container. After this each child is an ordinary shared entity, so the
	 * always-on `LiveSyncEngine` syncs them with no engine change. Children
	 * created *later* are picked up by the create-hook auto-share, not here.
	 *
	 * The container type with no containment rule (a single-entity collection —
	 * Note, Whiteboard) shares exactly like {@link share}. Returns the container's
	 * access view.
	 *
	 * NOTE (design 71 §Performance, follow-up): the cascade is sequential here.
	 * The async-off-IPC, concurrency-capped, idempotently-resumable form is a
	 * planned refinement; this first cut proves convergence for the demo-scale
	 * channels M1 targets. `#shareOne` is idempotent per (entity, member), so a
	 * re-run is safe.
	 */
	async shareCollection(opts: {
		entityId: string;
		type: string;
		invite: ShareInvite;
		role: AccessRole;
	}): Promise<CollabAccessView[]> {
		await this.#shareOne(opts.entityId, opts.type, opts.invite, opts.role);
		const rule = containmentRuleForParent(opts.type);
		if (rule) {
			const result = await queryVaultListSource(childrenSourceFor(rule, opts.entityId), () =>
				this.ensureEntitiesRepo(),
			);
			if (result.ok) {
				for (const childId of result.ids) {
					await this.#shareOne(childId, rule.childType, opts.invite, opts.role);
				}
			}
		}
		return this.access(opts.entityId);
	}

	/**
	 * Deferred re-cascade (design 71 flow-2 step 5) — re-push EVERY existing child
	 * of a container to its current members. Call when a container's membership
	 * grows (a new member's grant arrives, or a member's X25519 becomes known)
	 * after children already exist: `autoShareNewChild` is idempotent per
	 * `(child, member)` — an already-wrapped member short-circuits — so a re-run
	 * only delivers the children the new member is still missing. No-op for a
	 * single-entity container (no rule). The trigger (observing a container
	 * access-record change) is wired in the sync layer; this is the mechanism.
	 */
	async recascadeCollection(containerId: string, containerType: string): Promise<void> {
		const rule = containmentRuleForParent(containerType);
		if (!rule) return;
		const result = await queryVaultListSource(childrenSourceFor(rule, containerId), () =>
			this.ensureEntitiesRepo(),
		);
		if (!result.ok) return;
		for (const childId of result.ids) {
			await this.autoShareNewChild(childId, rule.childType, containerId);
		}
	}

	/**
	 * Flow 2 (design 71) — a child was just created locally under a SHARED
	 * container; cascade the container's membership onto it so it syncs to every
	 * member. Recipients come from the container's **signed access record**
	 * (`resolveCurrentMembers`), never the local wraps array, and each member's
	 * X25519 is read from their signed grant. For each active member other than
	 * self: grant them on the child (signed by self — the trust model is that any
	 * member may add child entities that inherit the container's membership), wrap
	 * the child DEK to their X25519, and emit the wrap to their inbox. A final
	 * full-state emit converges the child. Returns the number of members the child
	 * was shared to.
	 *
	 * A member whose X25519 is not yet known locally (their container grant hasn't
	 * replicated to this device) is **skipped, not silently dropped** — the caller
	 * is responsible for a deferred re-cascade when that grant arrives (design 71
	 * flow-2 step 5). No-op (returns 0) when the container is solo (≤1 active
	 * member) or this device holds no DEK for the child.
	 */
	async autoShareNewChild(childId: string, childType: string, containerId: string): Promise<number> {
		const members = await this.#activeMembersWithKeys(containerId);
		const selfPub = this.#session.identity.publicKeyBase64;
		const recipients = members.filter((m) => m.member !== selfPub && m.x25519 !== null);
		// Solo container (only self) ⇒ nothing to fan out, exactly like LiveSync's
		// solo-quiet rule. (A container shared only with members we can't yet wrap
		// to also lands here; the deferred re-cascade picks them up later.)
		if (recipients.length === 0) return 0;
		const dekStore = await this.ensureDekStore();
		this.#types.set(childId, childType);
		const handle = dekStore.open(childId);
		if (!handle) return 0;
		const exposed = this.#session.exposeIdentityForPairing();
		const relay = this.requireRelay();
		let shared = 0;
		try {
			for (const m of recipients) {
				const x25519 = m.x25519 as string;
				const recipientPub = base64ToBytes(x25519);
				const wrap = await this.#mutateAndEmitReturning(childId, (doc) => {
					grantAccess(doc, {
						entityId: childId,
						member: selfPub,
						role: AccessRole.Owner,
						signerSecret: exposed.secretKey,
						now: Date.now(),
						x25519: this.#session.deviceX25519.publicKeyBase64,
					});
					grantAccess(doc, {
						entityId: childId,
						member: m.member,
						role: m.role,
						signerSecret: exposed.secretKey,
						now: Date.now(),
						x25519,
					});
					const existing = findWrapForRecipient(doc, recipientPub);
					if (existing) return existing;
					const w = wrapDekForRecipient(handle.dek, recipientPub, childId, childType);
					appendWrap(doc, w);
					return w;
				});
				await emitWrapBootstrap(
					childId,
					wrap,
					this.makeCtx(relay.currentPort()),
					inboxChannelFor(m.member),
				);
				shared++;
			}
			if (shared > 0) await this.#emitFullState(childId);
		} finally {
			dekStore.close(handle.dek);
		}
		return shared;
	}

	/** The active members of `containerId` with their signed X25519 wrapping key
	 *  (design 71) — the authenticated recipient set for a child cascade. Loads
	 *  the persisted container doc and reads its signed access record. */
	async #activeMembersWithKeys(
		containerId: string,
	): Promise<Array<{ member: string; role: AccessRole; x25519: string | null }>> {
		const { doc } = await this.#session.ydocStore.load(containerId);
		try {
			return resolveCurrentMembers(doc, containerId)
				.filter((m) => m.active)
				.map((m) => ({ member: m.member, role: m.role, x25519: m.x25519 }));
		} finally {
			doc.destroy();
		}
	}

	/**
	 * Share ONE entity with the invitee: bootstrap the owner's own grant, append
	 * the invitee's signed grant + HPKE-wrap the entity's DEK (C2), persist the
	 * delta, then emit the wrap to the invitee's inbox + the full encrypted state.
	 * The reusable unit behind both {@link share} (container only) and
	 * {@link shareCollection} (container + each child). Idempotent: a re-share at
	 * the same role is a no-op (`shareEntityWithInvite` returns the existing wrap).
	 */
	async #shareOne(
		entityId: string,
		type: string,
		invite: ShareInvite,
		role: AccessRole,
	): Promise<void> {
		const dekStore = await this.ensureDekStore();
		this.#types.set(entityId, type);
		const exposed = this.#session.exposeIdentityForPairing();
		const handle = dekStore.open(entityId);
		if (!handle) {
			throw new Error(`sharing-engine: owner has no DEK for ${entityId}`);
		}
		let wrap: MemberWrapPayload;
		try {
			wrap = await this.#mutateAndEmitReturning(entityId, (doc) => {
				// Bootstrap the OWNER's own grant (idempotent — `grantAccess`
				// no-ops on a live grant) BEFORE granting the invitee. A normal
				// entity (entities.create) carries no access record until its
				// first share, so without this the record would name only the
				// invitee — one active member — and LiveSyncEngine's `isShared`
				// (>1 active member) would never start syncing it. The owner's own
				// X25519 rides the grant so a peer member's later child cascade can
				// wrap to the owner too (design 71).
				grantAccess(doc, {
					entityId,
					member: this.#session.identity.publicKeyBase64,
					role: AccessRole.Owner,
					signerSecret: exposed.secretKey,
					now: Date.now(),
					x25519: this.#session.deviceX25519.publicKeyBase64,
				});
				return shareEntityWithInvite(doc, {
					entityId,
					invite,
					role,
					dek: handle.dek,
					signerSecret: exposed.secretKey,
					now: Date.now(),
					type,
				});
			});
		} finally {
			dekStore.close(handle.dek);
		}
		const relay = this.requireRelay();
		const ctx = this.makeCtx(relay.currentPort());
		// Deliver the wrap to the recipient's INBOX channel — they can't be on the
		// entity channel yet (they don't know its id). On receipt their live-sync
		// engine installs the DEK, subscribes to the entity channel, then the full
		// state below converges. The entity stays the AAD-bound real entity.
		await emitWrapBootstrap(entityId, wrap, ctx, inboxChannelFor(invite.userPubB64));
		await this.#emitFullState(entityId);
	}

	/** Owner revokes `memberB64` (signed, append-only audit) and emits the delta. */
	async revoke(entityId: string, memberB64: string): Promise<boolean> {
		const exposed = this.#session.exposeIdentityForPairing();
		let revoked = false;
		await this.mutateAndEmit(entityId, (doc) => {
			revoked = revokeAccess(doc, {
				entityId,
				member: memberB64,
				signerSecret: exposed.secretKey,
				now: Date.now(),
			});
		});
		return revoked;
	}

	/** The resolved access log (active + revoked audit) for `entityId`. */
	async access(entityId: string): Promise<CollabAccessView[]> {
		const { doc } = await this.#session.ydocStore.load(entityId);
		try {
			// One CURRENT row per member (re-grant-after-revoke wins) — not the raw
			// per-append audit list, which would surface a stale revoked row (F-287).
			return resolveCurrentMembers(doc, entityId).map(toAccessView);
		} finally {
			doc.destroy();
		}
	}

	/** Record a (entityId → type) mapping so the wire `resolveEntity` can route
	 *  frames the engine emits/receives for an entity it hasn't loaded a row for. */
	recordType(entityId: string, type: string): void {
		this.#types.set(entityId, type);
	}

	// --- shared infra (used by the dev bridge's receiver too) -----------------

	/** Load the doc, run `mutate`, persist only the resulting delta, emit it. */
	async mutateAndEmit(entityId: string, mutate: (doc: Y.Doc) => void): Promise<void> {
		await this.#mutateAndEmitReturning(entityId, (doc) => {
			mutate(doc);
			return undefined;
		});
	}

	/** Install a per-entity DEK recovered from an inbound `WrapBootstrap`. */
	async installWrap(wrap: MemberWrapPayload, entityId: string): Promise<void> {
		const dekStore = await this.ensureDekStore();
		const dek = this.#session.unwrapMemberWrap(wrap, entityId);
		try {
			const repo = await this.ensureEntitiesRepo();
			installEntityDek(entityId, dek, dekStore, repo);
		} finally {
			dek.fill(0);
		}
	}

	/** Serialize per-entity appends so an out-of-order pair can't interleave. */
	async serializedAppendUpdate(entityId: string, update: Uint8Array): Promise<void> {
		const prior = this.#appendQueues.get(entityId) ?? Promise.resolve();
		const next = prior
			.catch(() => {})
			.then(() => this.#session.ydocStore.appendUpdate(entityId, update));
		this.#appendQueues.set(entityId, next);
		try {
			await next;
		} finally {
			if (this.#appendQueues.get(entityId) === next) {
				this.#appendQueues.delete(entityId);
			}
		}
	}

	makeCtx(relay: RelayPort): PipelineContext {
		return {
			dekStore: this.#dekStoreOrThrow(),
			devicePub: this.#session.identity.publicKey,
			deviceSign: (bytes) => this.#session.signPayload(bytes),
			deviceVerify: (sig, bytes, senderPub) => verifySignature(senderPub, bytes, sig),
			resolveEntity: (routedId) => {
				const type = this.#types.get(routedId) ?? this.#entitiesRepo?.get(routedId)?.type;
				return type ? { id: routedId, type } : null;
			},
			relay,
			nextSeq: (id) => {
				const next = (this.#seq.get(id) ?? -1) + 1;
				this.#seq.set(id, next);
				return next;
			},
			nowMs: () => Date.now(),
			randomNonce: () => freshNonce(),
		};
	}

	requireRelay(): CollabRelayLike {
		const relay = this.#getRelay();
		if (!relay) throw new Error("sharing-engine: no active relay");
		return relay;
	}

	async ensureDekStore(): Promise<EntityDekStore> {
		if (!this.#dekStore) this.#dekStore = await this.#session.entityDekStore();
		return this.#dekStore;
	}

	async ensureEntitiesRepo(): Promise<EntitiesRepository> {
		if (!this.#entitiesRepo) {
			const db = await this.#session.dataStores.open("entities");
			this.#entitiesRepo = new EntitiesRepository(db);
		}
		return this.#entitiesRepo;
	}

	// --- internals ------------------------------------------------------------

	async #mutateAndEmitReturning<T>(entityId: string, mutate: (doc: Y.Doc) => T): Promise<T> {
		const { doc } = await this.#session.ydocStore.load(entityId);
		let diff: Uint8Array;
		let result: T;
		try {
			const before = Y.encodeStateVector(doc);
			result = mutate(doc);
			diff = Y.encodeStateAsUpdate(doc, before);
		} finally {
			doc.destroy();
		}
		if (diff.length > 0) {
			await this.serializedAppendUpdate(entityId, diff);
			await this.#emitUpdate(entityId, diff);
		}
		return result;
	}

	async #emitFullState(entityId: string): Promise<void> {
		const { doc } = await this.#session.ydocStore.load(entityId);
		let state: Uint8Array;
		try {
			state = Y.encodeStateAsUpdate(doc);
		} finally {
			doc.destroy();
		}
		await this.#emitUpdate(entityId, state);
	}

	async #emitUpdate(entityId: string, update: Uint8Array): Promise<void> {
		const relay = this.#getRelay();
		if (!relay) return;
		const dekStore = await this.ensureDekStore();
		const handle = dekStore.open(entityId);
		if (!handle) return;
		dekStore.close(handle.dek);
		try {
			const ctx = this.makeCtx(relay.currentPort());
			await encryptAndEmit(entityId, update, ctx);
		} catch (error) {
			console.warn(`[sharing] wire-emit failed for ${entityId}: ${(error as Error).message}`);
		}
	}

	#dekStoreOrThrow(): EntityDekStore {
		if (!this.#dekStore) throw new Error("sharing-engine: dek store not initialized");
		return this.#dekStore;
	}
}
