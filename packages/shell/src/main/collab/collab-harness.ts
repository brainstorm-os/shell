/**
 * Two-vault collaboration harness (Collab C4, in-process layer).
 *
 * The reusable scaffold for multi-USER collaboration scenarios: two real
 * `VaultSession`s with distinct sovereign identities, wired to each other over
 * a `LoopbackRelayPort` (a local relay), sharing entities through the C2 invite
 * flow and converging their Y.Docs through the encrypted wire path. It packages
 * the moves the C3 end-to-end test proved — provision, invite, share, install,
 * sync — behind a small API so a *scenario* reads as the story (Mira shares a
 * brief with Marcus; both edit; Mira revokes) rather than the plumbing.
 *
 * This is the deterministic, in-process tier. The Electron two-shell variant
 * over a real WebSocket relay (the soak-style `tests/soak` harness, but for two
 * different users) is the live dogfood tier — Collab-C4-live — and sits on the
 * exact same C1/C2 primitives this harness exercises.
 *
 * Test-support only: imported by `*.test.ts`, never by shipped app code, so it
 * tree-shakes out of the production bundle.
 */

import { ed25519Verify } from "@brainstorm-os/native";
import * as Y from "yjs";
import { XCHACHA_NONCE_BYTES } from "../credentials/crypto";
import { type MemberWrapPayload, wrapDekVersionOf } from "../credentials/member-wraps";
import type { EntityDekStore } from "../entities/entity-dek-store";
import { installEntityDek } from "../entities/install-wrap";
import { EntitiesRepository } from "../storage/entities-repo";
import {
	type PipelineContext,
	emitWrapBootstrap,
	encryptAndEmit,
	receiveAndApply,
	receiveWrapBootstrap,
} from "../sync/envelope-pipeline";
import { LoopbackRelayPort } from "../sync/relay-port";
import { VaultSession } from "../vault/session";
import { type AccessRole, isActiveMember, revokeAccess, roleOf } from "./access-record";
import { type ShareInvite, createShareInviteSigned, shareEntityWithInvite } from "./share-invite";

/** Origin tag for remote-applied updates so a doc's own update observer does
 *  not echo a received update straight back to the sender. */
export const REMOTE_ORIGIN = Symbol("collab-harness/remote");

function freshNonce(): Uint8Array {
	const n = new Uint8Array(XCHACHA_NONCE_BYTES);
	crypto.getRandomValues(n);
	return n;
}

/**
 * One participant in a collaboration: a `VaultSession`, its `EntityDekStore`,
 * a relay-bound `PipelineContext`, and a per-entity local Y.Doc registry. Its
 * relay knows only how to reach the *other* participant (loopback pair).
 */
export class CollabVault {
	readonly docs = new Map<string, Y.Doc>();

	private constructor(
		readonly label: string,
		readonly session: VaultSession,
		readonly dekStore: EntityDekStore,
		readonly relay: LoopbackRelayPort,
		readonly ctx: PipelineContext,
		/** entity id → type, shared with the ctx's `resolveEntity` closure. */
		private readonly resolvable: Map<string, string>,
	) {}

	static async create(opts: {
		label: string;
		vaultId: string;
		vaultPath: string;
		relay: LoopbackRelayPort;
	}): Promise<CollabVault> {
		const session = await VaultSession.create({
			vaultId: opts.vaultId,
			vaultPath: opts.vaultPath,
			forceInsecure: true,
		});
		const dekStore = await session.entityDekStore();
		const resolvable = new Map<string, string>();
		const seq = new Map<string, number>();
		const ctx: PipelineContext = {
			dekStore,
			devicePub: session.identity.publicKey,
			deviceSign: (bytes) => session.signPayload(bytes),
			deviceVerify: (sig, bytes, senderPub) => {
				try {
					return ed25519Verify(senderPub, bytes, sig);
				} catch {
					return false;
				}
			},
			resolveEntity: (routedId) => {
				const type = resolvable.get(routedId);
				return type ? { id: routedId, type } : null;
			},
			relay: opts.relay,
			nextSeq: (entityId) => {
				const next = (seq.get(entityId) ?? -1) + 1;
				seq.set(entityId, next);
				return next;
			},
			nowMs: () => Date.now(),
			randomNonce: () => freshNonce(),
		};
		return new CollabVault(opts.label, session, dekStore, opts.relay, ctx, resolvable);
	}

	/** Register an entity id → type so this vault's pipeline can route it. */
	register(entityId: string, type: string): void {
		this.resolvable.set(entityId, type);
	}

	/** The user-Ed25519 identity, base64 — what access grants name. */
	get userPubB64(): string {
		return this.session.identity.publicKeyBase64;
	}

	/** Mint a self-signed `ShareInvite` from this vault's session keys — the
	 *  secret never leaves the session (`createShareInviteSigned`). */
	invite(label = this.label): ShareInvite {
		return createShareInviteSigned({
			userPub: this.session.identity.publicKey,
			x25519Pub: this.session.deviceX25519.publicKey,
			label,
			sign: (payload) => this.session.signPayload(payload),
		});
	}

	/** Owner-side: create the entity row + a fresh DEK, and a local Y.Doc. */
	async provisionEntity(entityId: string, type: string): Promise<Y.Doc> {
		const dekId = this.dekStore.nextDekId();
		const db = await this.session.dataStores.open("entities");
		new EntitiesRepository(db).create({
			id: entityId,
			type,
			properties: { name: entityId },
			createdBy: this.label,
			now: Date.now(),
			dekId,
		});
		const handle = this.dekStore.persist(entityId, dekId);
		this.dekStore.close(handle.dek);
		this.register(entityId, type);
		const doc = new Y.Doc();
		this.docs.set(entityId, doc);
		return doc;
	}

	/** Collaborator-side: an entity row with no DEK yet (the wrap installs it),
	 *  and a local Y.Doc to receive into. */
	async ensureEntityRow(entityId: string, type: string): Promise<Y.Doc> {
		const db = await this.session.dataStores.open("entities");
		const repo = new EntitiesRepository(db);
		if (!repo.get(entityId)) {
			repo.create({
				id: entityId,
				type,
				properties: { name: entityId },
				createdBy: `${this.label} (received)`,
				now: Date.now(),
				dekId: null,
			});
		}
		this.register(entityId, type);
		const doc = new Y.Doc();
		this.docs.set(entityId, doc);
		return doc;
	}

	/** Install a received member-wrap's DEK into this vault's store. */
	async installWrap(wrap: MemberWrapPayload, entityId: string): Promise<void> {
		const dek = this.session.unwrapMemberWrap(wrap, entityId);
		try {
			const db = await this.session.dataStores.open("entities");
			installEntityDek(
				entityId,
				dek,
				wrapDekVersionOf(wrap),
				this.dekStore,
				new EntitiesRepository(db),
			);
		} finally {
			dek.fill(0);
		}
	}

	isActiveMember(entityId: string, memberB64: string): boolean {
		const doc = this.docs.get(entityId);
		return doc ? isActiveMember(doc, entityId, memberB64) : false;
	}

	roleOf(entityId: string, memberB64: string): AccessRole | null {
		const doc = this.docs.get(entityId);
		return doc ? roleOf(doc, entityId, memberB64) : null;
	}

	/** Resolves once the session has fully released its file handles —
	 *  await before rm'ing the vault dir (EBUSY on Windows otherwise). */
	dispose(): Promise<void> {
		return this.session.dispose();
	}
}

/** A loopback-linked pair of vaults: owner + collaborator over one relay pair. */
export class CollabLink {
	/** Teardown closures for live-sync listeners, run on `dispose`. */
	private readonly liveDisposers: Array<() => void> = [];

	private constructor(
		readonly owner: CollabVault,
		readonly collaborator: CollabVault,
	) {}

	/** Boot two vaults wired to each other over a fresh loopback relay pair. */
	static async create(opts: {
		owner: { label: string; vaultId: string; vaultPath: string };
		collaborator: { label: string; vaultId: string; vaultPath: string };
	}): Promise<CollabLink> {
		const ports = LoopbackRelayPort.pair(2);
		const ownerRelay = ports[0];
		const collabRelay = ports[1];
		if (!ownerRelay || !collabRelay) throw new Error("collab-harness: expected two relay ports");
		const owner = await CollabVault.create({ ...opts.owner, relay: ownerRelay });
		const collaborator = await CollabVault.create({ ...opts.collaborator, relay: collabRelay });
		return new CollabLink(owner, collaborator);
	}

	/**
	 * The full owner→collaborator share: verify the invite, grant + wrap on the
	 * owner's doc, deliver the wrap over the relay (collaborator installs the
	 * DEK), then sync the encrypted doc state so the collaborator can read the
	 * content AND the grant inside it. After this the collaborator is an active
	 * member of `entityId` at `role` and holds the DEK.
	 */
	async share(opts: {
		entityId: string;
		type: string;
		invite: ShareInvite;
		role: AccessRole;
	}): Promise<void> {
		const ownerDoc = this.owner.docs.get(opts.entityId);
		if (!ownerDoc) throw new Error(`collab-harness: owner has no doc for ${opts.entityId}`);
		const collabDoc = await this.collaborator.ensureEntityRow(opts.entityId, opts.type);

		const exposed = this.owner.session.exposeIdentityForPairing();
		const handle = this.owner.dekStore.open(opts.entityId);
		if (!handle) throw new Error("collab-harness: owner DEK missing");
		const wrap = shareEntityWithInvite(ownerDoc, {
			entityId: opts.entityId,
			invite: opts.invite,
			role: opts.role,
			dek: handle.dek,
			signerSecret: exposed.secretKey,
			now: Date.now(),
			type: opts.type,
		});
		this.owner.dekStore.close(handle.dek);

		await this.deliverWrap(opts.entityId, wrap);
		await this.deliverState(opts.entityId, ownerDoc, collabDoc);
	}

	private async deliverWrap(entityId: string, wrap: MemberWrapPayload): Promise<void> {
		const installed = new Promise<void>((resolve, reject) => {
			const handler = (frame: Uint8Array): void => {
				void receiveWrapBootstrap(frame, this.collaborator.ctx, async (received, id) => {
					await this.collaborator.installWrap(received, id);
				})
					.then(() => {
						this.collaborator.relay.offFrame(handler);
						resolve();
					})
					.catch(reject);
			};
			this.collaborator.relay.onFrame(handler);
		});
		await emitWrapBootstrap(entityId, wrap, this.owner.ctx);
		await installed;
	}

	private async deliverState(entityId: string, ownerDoc: Y.Doc, collabDoc: Y.Doc): Promise<void> {
		const applied = new Promise<void>((resolve, reject) => {
			const handler = (frame: Uint8Array): void => {
				void receiveAndApply(frame, this.collaborator.ctx, (plaintext) => {
					Y.applyUpdate(collabDoc, plaintext, REMOTE_ORIGIN);
				})
					.then(() => {
						this.collaborator.relay.offFrame(handler);
						resolve();
					})
					.catch(reject);
			};
			this.collaborator.relay.onFrame(handler);
		});
		await encryptAndEmit(entityId, Y.encodeStateAsUpdate(ownerDoc), this.owner.ctx);
		await applied;
	}

	/**
	 * Wire live bidirectional sync for `entityId`: each side emits its own
	 * local updates under the DEK and applies the other's (REMOTE_ORIGIN
	 * suppresses the echo). Both docs converge as either side edits.
	 */
	wireLiveSync(entityId: string): void {
		const ownerDoc = this.owner.docs.get(entityId);
		const collabDoc = this.collaborator.docs.get(entityId);
		if (!ownerDoc || !collabDoc) throw new Error("collab-harness: both docs must exist to wire sync");
		this.wireSide(this.owner, ownerDoc, entityId);
		this.wireSide(this.collaborator, collabDoc, entityId);
	}

	private wireSide(vault: CollabVault, doc: Y.Doc, entityId: string): void {
		const onUpdate = (update: Uint8Array, origin: unknown): void => {
			if (origin === REMOTE_ORIGIN) return;
			void encryptAndEmit(entityId, update, vault.ctx);
		};
		const onFrame = (frame: Uint8Array): void => {
			void receiveAndApply(frame, vault.ctx, (plaintext) => {
				Y.applyUpdate(doc, plaintext, REMOTE_ORIGIN);
			});
		};
		doc.on("update", onUpdate);
		vault.relay.onFrame(onFrame);
		this.liveDisposers.push(() => {
			doc.off("update", onUpdate);
			vault.relay.offFrame(onFrame);
		});
	}

	/**
	 * Owner revokes `memberB64`'s access to `entityId` (signed, append-only —
	 * the entry is marked revoked, not deleted). With live sync wired the revoke
	 * propagates to the collaborator's doc like any other update. Returns true
	 * if a live grant was found and revoked.
	 */
	revoke(entityId: string, memberB64: string): boolean {
		const ownerDoc = this.owner.docs.get(entityId);
		if (!ownerDoc) throw new Error(`collab-harness: owner has no doc for ${entityId}`);
		const exposed = this.owner.session.exposeIdentityForPairing();
		return revokeAccess(ownerDoc, {
			entityId,
			member: memberB64,
			signerSecret: exposed.secretKey,
			now: Date.now(),
		});
	}

	/** Resolve once both docs for `entityId` carry identical Yjs state, or
	 *  reject after `timeoutMs`. */
	async awaitConverged(entityId: string, timeoutMs = 2000): Promise<void> {
		const ownerDoc = this.owner.docs.get(entityId);
		const collabDoc = this.collaborator.docs.get(entityId);
		if (!ownerDoc || !collabDoc) throw new Error("collab-harness: missing docs for convergence");
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const a = Buffer.from(Y.encodeStateVector(ownerDoc)).toString("hex");
			const b = Buffer.from(Y.encodeStateVector(collabDoc)).toString("hex");
			if (a === b) return;
			await new Promise((r) => setTimeout(r, 25));
		}
		throw new Error(`collab-harness: ${entityId} did not converge within ${timeoutMs}ms`);
	}

	/** Resolves once both vaults have fully released their file handles —
	 *  await before rm'ing the vault dirs (EBUSY on Windows otherwise). */
	async dispose(): Promise<void> {
		for (const off of this.liveDisposers.splice(0)) off();
		this.owner.relay.close();
		this.collaborator.relay.close();
		await Promise.all([this.owner.dispose(), this.collaborator.dispose()]);
	}
}
