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
import { XCHACHA_NONCE_BYTES } from "../credentials/crypto";
import { verifySignature } from "../credentials/identity";
import type { MemberWrapPayload } from "../credentials/member-wraps";
import type { EntityDekStore } from "../entities/entity-dek-store";
import { installEntityDek } from "../entities/install-wrap";
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
	 *  own Owner grant into the doc's access log. Idempotent on an existing row. */
	async provisionEntity(entityId: string, type: string): Promise<void> {
		const dekStore = await this.ensureDekStore();
		const repo = await this.ensureEntitiesRepo();
		this.#types.set(entityId, type);
		if (!repo.get(entityId)) {
			const dekId = dekStore.nextDekId();
			repo.transaction(() => {
				repo.create({
					id: entityId,
					type,
					properties: { name: entityId },
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
		const dekStore = await this.ensureDekStore();
		this.#types.set(opts.entityId, opts.type);
		const exposed = this.#session.exposeIdentityForPairing();
		const handle = dekStore.open(opts.entityId);
		if (!handle) {
			throw new Error(`sharing-engine: owner has no DEK for ${opts.entityId}`);
		}
		let wrap: MemberWrapPayload;
		try {
			wrap = await this.#mutateAndEmitReturning(opts.entityId, (doc) => {
				// Bootstrap the OWNER's own grant (idempotent — `grantAccess`
				// no-ops on a live grant) BEFORE granting the invitee. A normal
				// entity (entities.create) carries no access record until its
				// first share, so without this the record would name only the
				// invitee — one active member — and LiveSyncEngine's `isShared`
				// (>1 active member) would never start syncing it. The dev bridge
				// gets this for free via its separate `provisionEntity` step.
				grantAccess(doc, {
					entityId: opts.entityId,
					member: this.#session.identity.publicKeyBase64,
					role: AccessRole.Owner,
					signerSecret: exposed.secretKey,
					now: Date.now(),
				});
				return shareEntityWithInvite(doc, {
					entityId: opts.entityId,
					invite: opts.invite,
					role: opts.role,
					dek: handle.dek,
					signerSecret: exposed.secretKey,
					now: Date.now(),
					type: opts.type,
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
		await emitWrapBootstrap(opts.entityId, wrap, ctx, inboxChannelFor(opts.invite.userPubB64));
		await this.#emitFullState(opts.entityId);
		return this.access(opts.entityId);
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
