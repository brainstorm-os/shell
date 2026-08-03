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

import { ENTITY_PROPS_MAP_NAME } from "@brainstorm-os/sdk-types";
import * as Y from "yjs";
import { XCHACHA_NONCE_BYTES, base64ToBytes } from "../credentials/crypto";
import { verifySignature } from "../credentials/identity";
import {
	type MemberWrapPayload,
	appendWrap,
	findWrapForRecipient,
	wrapDekForRecipient,
	wrapDekVersionOf,
} from "../credentials/member-wraps";
import type { EntityDekStore } from "../entities/entity-dek-store";
import { writeEntityProps } from "../entities/entity-doc-codec";
import { installEntityDek } from "../entities/install-wrap";
import { queryVaultListSource } from "../entities/vault-entities-service";
import {
	EntitiesRepository,
	PendingRotationsRepository,
	ShareInvitesRepository,
} from "../storage/entities-repo";
import { type PipelineContext, emitWrapBootstrap, encryptAndEmit } from "../sync/envelope-pipeline";
import type { RelayPort, RelaySurface } from "../sync/relay-port";
import { type WrapFanoutResult, fanOutEntityWrap } from "../sync/wrap-fanout";
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
import { cacheRemoteProfile, readSelfProfileSnapshot } from "./profile-store";
import {
	type ShareInvite,
	createShareInviteSigned,
	inviteProfile,
	shareEntityWithInvite,
} from "./share-invite";
import { type SurvivorWrap, rewrapDekForSurvivors } from "./survivor-rewrap";

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
	#pendingRepo: PendingRotationsRepository | null = null;
	#invitesRepo: ShareInvitesRepository | null = null;
	#draining = false;

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

	/**
	 * Collaborator-side: mint a self-signed `ShareInvite`. The sovereign signing
	 * key never leaves the session (`createShareInviteSigned` takes a signing
	 * closure).
	 *
	 * Collab-C5-invite-anchor: the invite also carries a fresh single-use anchor
	 * secret, and its record is PERSISTED here before the token is returned. That
	 * row is the only thing that will later admit a first-share bootstrap into
	 * this vault, so an invite that could not be recorded must not be handed out
	 * (the store throw propagates — a token minted without its row would silently
	 * fail to redeem, which is the deadlock shape this rung exists to avoid).
	 *
	 * Collab-C6-b: the invite also carries this identity's signed display-profile
	 * snapshot, and an empty `label` falls back to that profile's display name.
	 * Every shipping call site passes `""`, which is why an auto-saved teammate
	 * used to land in the share dialog as a blank chip.
	 */
	async createInvite(label: string): Promise<ShareInvite> {
		const profile = await readSelfProfileSnapshot(this.#session);
		const invite = createShareInviteSigned({
			userPub: this.#session.identity.publicKey,
			x25519Pub: this.#session.deviceX25519.publicKey,
			label: label || (profile?.displayName ?? ""),
			sign: (payload) => this.#session.signPayload(payload),
			profile,
		});
		const repo = await this.ensureShareInvitesRepo();
		repo.mint({
			inviteId: invite.inviteId,
			secretB64: invite.secret,
			memberPubB64: invite.userPubB64,
			createdAt: Date.now(),
			expiresAt: invite.expiresAt,
		});
		return invite;
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
			// 10.3c — mirror the production create path. `createEntityWithDek` runs
			// `installEntityWrap`, and the sibling fan-out hangs off exactly that
			// hook, so a bridge that mints a DEK and stops leaves this device the
			// only holder — and no dogfood session can ever reach the producer.
			// That is precisely how `collab/012` kept failing on `no DEK for
			// entity` with a working LAN link: the transport was never the problem,
			// the harness simply never asked for a wrap.
			await this.#fanOutProvisionedDek(entityId, type);
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

	/** Fan a freshly-provisioned entity's DEK out to this identity's other
	 *  devices. Never throws and never blocks the create: an offline sibling
	 *  must not fail a local write, and the pairing backfill is the catch-up. */
	async #fanOutProvisionedDek(entityId: string, type: string): Promise<void> {
		try {
			const dekStore = await this.ensureDekStore();
			const handle = dekStore.open(entityId);
			if (!handle) return;
			try {
				await this.fanOutEntityWrapToSiblings(entityId, handle.dek, handle.version, type);
			} finally {
				dekStore.close(handle.dek);
			}
		} catch (error) {
			console.warn(`[sharing] provision fan-out failed for ${entityId}: ${(error as Error).message}`);
		}
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
					// Collab-C5-invite-anchor: a child's grant is anchored on the
					// CONTAINER the receiver already belongs to, not on the invite. The
					// invite stays pinned to the container alone, so one code can open a
					// collection of any size without becoming a multi-entity credential.
					await this.#shareOne(childId, rule.childType, opts.invite, opts.role, opts.entityId);
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
						// Collab-C5-invite-anchor: the receiver has no invite in play for
						// a child created after the share, so the grant names the container
						// they are already a member of. Their gate checks that locally —
						// container membership + our right to cascade + the containment
						// rule's child type — instead of trusting this signature alone.
						via: containerId,
					});
					const existing = findWrapForRecipient(doc, recipientPub);
					if (existing) return existing;
					const w = wrapDekForRecipient(handle.dek, recipientPub, childId, childType, handle.version);
					appendWrap(doc, w);
					return w;
				});
				const inbox = inboxChannelFor(m.member);
				await emitWrapBootstrap(childId, wrap, this.makeCtx(relay.currentPort()), inbox);
				// F-471 — same subscribe race as `#shareOne`: this member has never
				// seen `childId`, so the entity-channel state below can land before
				// their subscribe does. Send it down the inbox they are already on.
				await this.#emitFullState(childId, inbox);
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
		via?: string,
	): Promise<void> {
		const dekStore = await this.ensureDekStore();
		this.#types.set(entityId, type);
		const exposed = this.#session.exposeIdentityForPairing();
		// Collab-C6-b — remember the invitee's verified name locally, so THIS
		// vault's roster resolves them on every entity from now on, not only the
		// ones whose doc happens to carry the snapshot. Fail-closed inside
		// `cacheRemoteProfile`: an unverifiable snapshot writes nothing.
		await cacheRemoteProfile(this.#session, invite.userPubB64, inviteProfile(invite));
		const selfProfile = await readSelfProfileSnapshot(this.#session);
		const handle = dekStore.open(entityId);
		if (!handle) {
			throw new Error(`sharing-engine: owner has no DEK for ${entityId}`);
		}
		// Collab-C5 — the owner enumerates a container's children from the SQLite
		// index, but the receiver's container-descent gate reads the child's parent
		// property back out of the DOC it is sent. An entity whose properties were
		// never written through the Y.Doc (a legacy or seeded row) has an empty
		// property map, so the two disagree: the owner grants and emits, and the
		// receiver refuses with `deny-container-not-a-child` and drops the child on
		// the floor with only a console warning. Seed the doc from the row first,
		// the same lazy hydration the ydoc worker performs on write. A doc that
		// already carries properties is left alone — the doc stays the source of
		// truth, this only backfills one that was never populated.
		const propsRow = (await this.ensureEntitiesRepo()).get(entityId);
		const seedProps = propsRow?.properties ?? null;
		let wrap: MemberWrapPayload;
		try {
			wrap = await this.#mutateAndEmitReturning(entityId, (doc) => {
				if (seedProps && doc.getMap(ENTITY_PROPS_MAP_NAME).size === 0) {
					writeEntityProps(doc, seedProps);
				}
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
					dekVersion: handle.version,
					selfProfile,
					selfPubkey: this.#session.identity.publicKeyBase64,
					...(via === undefined ? {} : { via }),
				});
			});
		} finally {
			dekStore.close(handle.dek);
		}
		const relay = this.requireRelay();
		const ctx = this.makeCtx(relay.currentPort());
		// Deliver the wrap to the recipient's INBOX channel — they can't be on the
		// entity channel yet (they don't know its id). On receipt their live-sync
		// engine installs the DEK and subscribes to the entity channel. The entity
		// stays the AAD-bound real entity.
		const inbox = inboxChannelFor(invite.userPubB64);
		await emitWrapBootstrap(entityId, wrap, ctx, inbox);
		// F-471 — the full state ALSO goes to that same inbox, not only to the
		// entity channel. The recipient's subscribe to the entity channel is an
		// async control message issued only once the wrap has resolved, so a
		// forward-only relay drops anything sent to the entity channel in the
		// window between the two — deterministically losing the very state the
		// share was supposed to deliver. The inbox is a channel they subscribed to
		// at engine start, so it has no window; frames are ordered on one socket,
		// so the wrap is always installed before this arrives.
		await this.#emitFullState(entityId, inbox);
		// Existing members are on the entity channel and got the grant delta from
		// the mutate above; this repairs any whose local state lagged. Yjs state is
		// idempotent, so the recipient receiving both copies is a no-op.
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
		if (revoked) await this.#rotateAfterRevoke(entityId);
		return revoked;
	}

	/**
	 * ROT-3a — rotate the entity DEK after a successful revoke so the removed
	 * member's key no longer decrypts NEW content (content forward secrecy,
	 * design 73). Mints DEK′, re-wraps it for the SURVIVORS only (ROT-1 excludes
	 * the now-inactive member by construction), publishes those wraps to the
	 * survivors' inboxes, then re-seals the snapshot under DEK′. The 10.11 token
	 * re-home (which would ALSO give metadata forward secrecy) is dormant in
	 * production (design 73 §dormancy), so `rotate` is a local no-op: emission
	 * already flips to DEK′ because the store's most-recent-by-`created_at` row
	 * IS DEK′. The revoked member stays subscribed to the entity channel and
	 * still sees the (now-undecryptable) traffic — that residual metadata gap is
	 * ROT-3b, gated on 10.11b.
	 *
	 * Delivering the survivor wraps needs an active relay; an offline revoke
	 * records the signed removal but defers rotation (logged) to a future
	 * reconnect hook — out of ROT-3a scope.
	 */
	async #rotateAfterRevoke(entityId: string): Promise<void> {
		// The DURABLE half always runs, online or off: mint DEK′ (so emission has
		// flipped even for offline post-revoke edits), re-wrap the survivors, and
		// append those wraps into the doc (so a later cold/new-device join can
		// unwrap). Only the WIRE half — delivering the inbox `WrapBootstrap` so a
		// LIVE survivor installs DEK′ — needs a relay; when it can't complete
		// (offline, or an emit throw) the entity is marked pending and the drain
		// (relay-connect + boot) finishes it. This is ROT-3a-ii / F-ROT-4: revoke
		// no longer silently loses the rotation.
		const members = await this.#currentMembersOf(entityId);
		const type = this.#types.get(entityId) ?? (await this.ensureEntitiesRepo()).get(entityId)?.type;
		const dekStore = await this.ensureDekStore();
		const handle = dekStore.persist(entityId, dekStore.nextDekId());
		const version = handle.version;
		let wraps: SurvivorWrap[];
		let skipped: string[];
		try {
			({ wraps, skipped } = rewrapDekForSurvivors(handle.dek, version, members, entityId, type));
		} finally {
			dekStore.close(handle.dek);
		}
		if (skipped.length > 0) {
			console.warn(`[sharing] ${entityId}: ${skipped.length} survivor(s) had no device key`);
		}
		if (wraps.length > 0) {
			await this.#mutateAndEmitReturning(entityId, (doc) => {
				for (const { wrap } of wraps) appendWrap(doc, wrap);
			});
		}
		const pending = await this.ensurePendingRotationsRepo();
		const delivered = await this.#deliverRotationWire(entityId, wraps);
		if (delivered) {
			pending.remove(entityId);
		} else {
			pending.mark(entityId, version, Date.now());
		}
		console.info(
			`[sharing] rotated ${entityId} on revoke: v${version}, ${wraps.length} wrap(s), delivered=${delivered}`,
		);
	}

	/**
	 * Stage 10.3c — fan this entity's DEK out to the user's OTHER devices.
	 *
	 * The producer 10.3b never built. Without it nothing ever wrapped an entity
	 * DEK for a paired device, so two of one user's own devices never synced a
	 * single entity.
	 *
	 * Rides the IDENTITY inbox, not a per-device channel: every device of one
	 * identity already subscribes it, and the frame `sender` is the sovereign
	 * user key, so a device-scoped channel would hand the blind relay a new
	 * identifier telling it how many devices this identity has. Siblings the
	 * wrap is not addressed to drop it on an exact `recipientPubB64` compare —
	 * see the guard in `installWrap`.
	 *
	 * Returns null when there is nothing to do (no relay, no siblings), so the
	 * caller can tell "not delivered" from "nothing to deliver".
	 */
	async fanOutEntityWrapToSiblings(
		entityId: string,
		dek: Uint8Array,
		version: number,
		type?: string,
	): Promise<WrapFanoutResult | null> {
		const relay = this.#getRelay();
		if (!relay) return null; // offline — the pairing backfill is the catch-up path
		// `makeCtx` reads the DEK store, and this can be the first thing to run
		// on a session (an entity created before anything else touched sharing),
		// so initialise rather than assume.
		await this.ensureDekStore();
		const { VaultPropertiesStore } = await import("../vault/vault-properties-store");
		const props = await VaultPropertiesStore.open(this.#session.ydocStore);
		const devices = props.devices().listActive();
		const ctx = this.makeCtx(relay.currentPort());
		return fanOutEntityWrap({
			entityId,
			dek,
			version,
			...(type === undefined ? {} : { type }),
			devices,
			selfDeviceEd25519Pub: this.#session.deviceEd25519.publicKeyBase64,
			identityRoute: inboxChannelFor(this.#session.identity.publicKeyBase64),
			wrapFor: (d, recipientPubB64, id, t, v) =>
				wrapDekForRecipient(d, base64ToBytes(recipientPubB64), id, t, v),
			emit: (id, wrap, route) => emitWrapBootstrap(id, wrap, ctx, route),
		});
	}

	/** Deliver the inbox `WrapBootstrap` for each survivor wrap + re-seal the
	 *  snapshot under DEK′ over the wire. Returns true when delivery completed
	 *  (or there was nothing to deliver), false when it must be deferred (no
	 *  relay, or an emit threw) — the caller then marks the entity pending. */
	async #deliverRotationWire(entityId: string, wraps: readonly SurvivorWrap[]): Promise<boolean> {
		const relay = this.#getRelay();
		if (!relay) return wraps.length === 0; // nothing to send ⇒ nothing pending
		try {
			const ctx = this.makeCtx(relay.currentPort());
			for (const { member, wrap } of wraps) {
				await emitWrapBootstrap(entityId, wrap, ctx, inboxChannelFor(member));
			}
			await this.#emitFullState(entityId);
			return true;
		} catch (error) {
			console.warn(
				`[sharing] deferred rotation delivery for ${entityId}: ${(error as Error).message}`,
			);
			return false;
		}
	}

	/** Re-derive the survivor wraps for the entity's CURRENT DEK (the drain
	 *  path — it has no in-memory wraps). Empty when the entity has no DEK. */
	async #rederiveSurvivorWraps(entityId: string): Promise<SurvivorWrap[]> {
		const dekStore = await this.ensureDekStore();
		const handle = dekStore.open(entityId);
		if (!handle) return [];
		try {
			const members = await this.#currentMembersOf(entityId);
			const type = this.#types.get(entityId) ?? (await this.ensureEntitiesRepo()).get(entityId)?.type;
			return rewrapDekForSurvivors(handle.dek, handle.version, members, entityId, type).wraps;
		} finally {
			dekStore.close(handle.dek);
		}
	}

	/**
	 * ROT-3a-ii drain — finish the wire delivery for every entity whose rotation
	 * was deferred (offline revoke / emit failure). Idempotent and safe to call
	 * repeatedly; wired to relay-connect + session boot. Re-derives each entity's
	 * survivor wraps from its CURRENT DEK (so a rotation superseded while offline
	 * still delivers the latest key), re-emits the inbox bootstraps + full state,
	 * and clears the pending mark on success. A row whose entity lost its DEK is
	 * dropped (the FK cascade already removes deleted entities).
	 */
	async drainPendingRotations(): Promise<{ drained: number; remaining: number }> {
		if (this.#draining) return { drained: 0, remaining: -1 };
		this.#draining = true;
		try {
			const pending = await this.ensurePendingRotationsRepo();
			const rows = pending.listAll();
			if (rows.length === 0) return { drained: 0, remaining: 0 };
			if (!this.#getRelay()) return { drained: 0, remaining: rows.length };
			let drained = 0;
			for (const { entityId } of rows) {
				const wraps = await this.#rederiveSurvivorWraps(entityId);
				const delivered = await this.#deliverRotationWire(entityId, wraps);
				if (delivered) {
					pending.remove(entityId);
					drained++;
				}
			}
			return { drained, remaining: pending.listAll().length };
		} finally {
			this.#draining = false;
		}
	}

	/** The entity's active-and-inactive member set after a mutation — the input
	 *  to the survivor re-wrap (revoked members are `active:false`, excluded). */
	async #currentMembersOf(entityId: string): Promise<readonly ResolvedMember[]> {
		const { doc } = await this.#session.ydocStore.load(entityId);
		try {
			return resolveCurrentMembers(doc, entityId);
		} finally {
			doc.destroy();
		}
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
			installEntityDek(entityId, dek, wrapDekVersionOf(wrap), dekStore, repo);
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

	async ensurePendingRotationsRepo(): Promise<PendingRotationsRepository> {
		if (!this.#pendingRepo) {
			const db = await this.#session.dataStores.open("entities");
			this.#pendingRepo = new PendingRotationsRepository(db);
		}
		return this.#pendingRepo;
	}

	async ensureShareInvitesRepo(): Promise<ShareInvitesRepository> {
		if (!this.#invitesRepo) {
			const db = await this.#session.dataStores.open("entities");
			this.#invitesRepo = new ShareInvitesRepository(db);
		}
		return this.#invitesRepo;
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

	async #emitFullState(entityId: string, route?: string): Promise<void> {
		const { doc } = await this.#session.ydocStore.load(entityId);
		let state: Uint8Array;
		try {
			state = Y.encodeStateAsUpdate(doc);
		} finally {
			doc.destroy();
		}
		await this.#emitUpdate(entityId, state, route);
	}

	async #emitUpdate(entityId: string, update: Uint8Array, route?: string): Promise<void> {
		const relay = this.#getRelay();
		if (!relay) return;
		const dekStore = await this.ensureDekStore();
		const handle = dekStore.open(entityId);
		if (!handle) return;
		dekStore.close(handle.dek);
		try {
			const ctx = this.makeCtx(relay.currentPort());
			await encryptAndEmit(entityId, update, ctx, route);
		} catch (error) {
			console.warn(`[sharing] wire-emit failed for ${entityId}: ${(error as Error).message}`);
		}
	}

	#dekStoreOrThrow(): EntityDekStore {
		if (!this.#dekStore) throw new Error("sharing-engine: dek store not initialized");
		return this.#dekStore;
	}
}
