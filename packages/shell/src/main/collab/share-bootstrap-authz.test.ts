/**
 * Collab-C5 (F-288) - the writer-authorization gate on the RECEIVER's real
 * production path, not on a stub predicate.
 *
 * The shipped `envelope-pipeline.test.ts` coverage passes `authorizeWriter: ()
 * => true|false`, so it proves only that the pipeline honours the answer. This
 * file wires the PRODUCTION closure (`main/index.ts`: base64url sender →
 * `ydocStore.load` → `isAuthorizedWriter`) onto a second real `VaultSession`
 * and drives a genuine cross-user share through it, which is where the gate is
 * load-bearing - and where it deadlocked.
 *
 * The deadlock (surfaced by dogfood collab spec `009`, reproduced here): a
 * member being shared with for the FIRST time has no local doc, so their access
 * record is empty, so `isAuthorizedWriter` denies the owner - and the frame it
 * denies is the very frame that carries the access record. The record can
 * therefore never arrive: every subsequent frame is denied on the same empty
 * doc. Every dogfood spec that passed did so through the ungated
 * `CollabDevBridge` receiver, so nothing caught it.
 *
 * The fix keeps the gate fail-closed and grants NO key-free surface: reaching
 * the predicate already required the entity DEK plus a valid signature over the
 * frame, and the bootstrap branch admits a sender only when the local doc holds
 * NO access record at all AND the incoming state makes that sender a
 * signature-verified active Editor+ (see `authorizesAsShareBootstrap`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { verifySignature } from "../credentials/identity";
import { wrapDekVersionOf } from "../credentials/member-wraps";
import { installEntityDek } from "../entities/install-wrap";
import { base64UrlToBytes } from "../pairing/pairing-channel";
import type { EntitiesRepository, ShareInvitesRepository } from "../storage/entities-repo";
import { decodeFrame } from "../sync/envelope-codec";
import {
	type PipelineContext,
	receiveAndApply,
	receiveWrapBootstrap,
} from "../sync/envelope-pipeline";
import { LoopbackRelayPort, type RelayPort } from "../sync/relay-port";
import { WireKind } from "../sync/routing-header";
import { VaultSession } from "../vault/session";
import {
	AccessRole,
	authorizesAsShareBootstrap,
	isAuthorizedWriter,
	resolveMembers,
} from "./access-record";
import { COLLAB_TEXT_KEY, CollabDevBridge } from "./collab-dev-bridge";
import { deriveInviteSecret } from "./invite-anchor";
import { ShareBootstrapVerdict, authorizeShareBootstrap } from "./share-bootstrap-authz";
import { type CollabRelayLike, SharingEngine } from "./sharing-engine";

const ENTITY = "ent_shared_brief";
const ENTITY_TYPE = "brainstorm/Note/v1";
const BODY = "Operating hub - Q3 brief.";

function relayAdapter(port: LoopbackRelayPort): CollabRelayLike {
	return {
		currentPort: (): RelayPort => port,
		onFrame: (cb) => port.onFrame(cb),
		offFrame: (cb) => port.offFrame(cb),
	};
}

/**
 * A receiving shell built from the REAL parts: the session's own DEK store,
 * entities repo and `YDocStore`, plus the production-shaped `authorizeWriter`
 * closure copied from `main/index.ts`. Frames are fed in exactly as
 * `LiveSyncEngine.#handleFrame` feeds them (wrap first, then state).
 */
class ReceivingShell {
	readonly denied: string[] = [];
	#seq = 0;

	private constructor(
		readonly session: VaultSession,
		readonly engine: SharingEngine,
		readonly repo: EntitiesRepository,
		readonly dekStore: Awaited<ReturnType<VaultSession["entityDekStore"]>>,
		readonly invites: ShareInvitesRepository,
		readonly port: LoopbackRelayPort,
	) {}

	static async open(session: VaultSession, port: LoopbackRelayPort): Promise<ReceivingShell> {
		const engine = new SharingEngine(session, () => relayAdapter(port));
		const repo = await engine.ensureEntitiesRepo();
		const dekStore = await engine.ensureDekStore();
		const invites = await engine.ensureShareInvitesRepo();
		return new ReceivingShell(session, engine, repo, dekStore, invites, port);
	}

	/** The production `main/index.ts` closure, verbatim in shape — including the
	 *  Collab-C5-invite-anchor gate, so the LEGITIMATE first share is proven to
	 *  survive it and not just the signature half. */
	readonly refusals: ShareBootstrapVerdict[] = [];

	#authorizeWriter = async (
		senderPubB64: string,
		entityId: string,
		plaintext: Uint8Array,
	): Promise<boolean> => {
		let senderKey: Uint8Array;
		try {
			senderKey = base64UrlToBytes(senderPubB64);
		} catch {
			return false;
		}
		const { doc } = await this.session.ydocStore.load(entityId);
		try {
			if (isAuthorizedWriter(doc, entityId, senderKey)) return true;
			const verdict = await authorizeShareBootstrap({
				localDoc: doc,
				entityId,
				senderKey,
				selfPubB64: this.session.identity.publicKeyBase64,
				incomingState: plaintext,
				now: Date.now(),
				invites: this.invites,
				deriveInviteSecret: (nonce) =>
					deriveInviteSecret((bytes) => this.session.signPayload(bytes), nonce),
				loadDoc: async (id) => (await this.session.ydocStore.load(id)).doc,
				typeOf: (id) => this.repo.get(id)?.type ?? null,
			});
			if (verdict !== ShareBootstrapVerdict.Allow) this.refusals.push(verdict);
			return verdict === ShareBootstrapVerdict.Allow;
		} catch {
			return false;
		} finally {
			doc.destroy();
		}
	};

	#ctx(): PipelineContext {
		return {
			dekStore: this.dekStore,
			devicePub: this.session.identity.publicKey,
			deviceSign: (bytes) => this.session.signPayload(bytes),
			deviceVerify: (sig, bytes, senderPub) => verifySignature(senderPub, bytes, sig),
			resolveEntity: (routedId) => ({
				id: routedId,
				type: this.repo.get(routedId)?.type ?? ENTITY_TYPE,
			}),
			relay: this.port,
			nextSeq: () => this.#seq++,
			nowMs: () => Date.now(),
			randomNonce: () => crypto.getRandomValues(new Uint8Array(24)),
			authorizeWriter: this.#authorizeWriter,
		};
	}

	/** Ingest one wire frame the way the live engine does. A denial is
	 *  recorded, never thrown, mirroring `#handleFrame`'s warn-and-continue. */
	async ingest(frame: Uint8Array): Promise<void> {
		const decoded = decodeFrame(frame);
		const entityId = decoded.header.entityId;
		if (decoded.header.kind === WireKind.WrapBootstrap) {
			await receiveWrapBootstrap(frame, this.#ctx(), async (wrap, id) => {
				if (!this.repo.get(id)) {
					this.repo.create({
						id,
						type: ENTITY_TYPE,
						properties: {},
						createdBy: `${this.session.identity.publicKeyBase64} (received)`,
						now: Date.now(),
						dekId: null,
					});
				}
				const dek = this.session.unwrapMemberWrap(wrap, id);
				try {
					installEntityDek(id, dek, wrapDekVersionOf(wrap), this.dekStore, this.repo);
				} finally {
					dek.fill(0);
				}
			});
			return;
		}
		try {
			await receiveAndApply(frame, this.#ctx(), async (plaintext) => {
				await this.engine.serializedAppendUpdate(entityId, plaintext);
			});
		} catch (error) {
			this.denied.push((error as Error).message);
		}
	}

	async text(): Promise<string> {
		const { doc } = await this.session.ydocStore.load(ENTITY);
		try {
			return doc.getText(COLLAB_TEXT_KEY).toString();
		} finally {
			doc.destroy();
		}
	}

	/** Denials that are the GATE talking, not ordinary pre-share frames the
	 *  receiver has no DEK for yet (production drops those as untracked). */
	unauthorized(): string[] {
		return this.denied.filter((m) => m.includes("not an authorized writer"));
	}

	async activeMembers(): Promise<string[]> {
		const { doc } = await this.session.ydocStore.load(ENTITY);
		try {
			return resolveMembers(doc, ENTITY)
				.filter((m) => m.active)
				.map((m) => m.member);
		} finally {
			doc.destroy();
		}
	}
}

describe("F-288 writer authorization on the receiver's production path", () => {
	let dirOwner = "";
	let dirGuest = "";
	let owner: VaultSession;
	let guest: VaultSession;
	let ports: LoopbackRelayPort[];
	let bridge: CollabDevBridge;
	let received: ReceivingShell;
	let frames: Uint8Array[];

	beforeEach(async () => {
		dirOwner = await mkdtemp(join(tmpdir(), "bs-f288-owner-"));
		dirGuest = await mkdtemp(join(tmpdir(), "bs-f288-guest-"));
		owner = await VaultSession.create({
			vaultId: "vlt_f288_owner",
			vaultPath: dirOwner,
			forceInsecure: true,
		});
		guest = await VaultSession.create({
			vaultId: "vlt_f288_guest",
			vaultPath: dirGuest,
			forceInsecure: true,
		});
		ports = LoopbackRelayPort.pair(2);
		const p0 = ports[0];
		const p1 = ports[1];
		if (!p0 || !p1) throw new Error("expected two loopback ports");
		bridge = new CollabDevBridge(owner, () => relayAdapter(p0));
		received = await ReceivingShell.open(guest, p1);
		frames = [];
		p1.onFrame((frame) => {
			frames.push(frame);
		});
	});

	afterEach(async () => {
		bridge?.dispose();
		for (const p of ports) p.close();
		owner.dispose();
		guest.dispose();
		await rm(dirOwner, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		await rm(dirGuest, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	/** Drive every frame the owner emitted through the receiver, in order. */
	async function drain(): Promise<void> {
		const pending = frames.splice(0, frames.length);
		for (const frame of pending) await received.ingest(frame);
	}

	async function shareWith(role: AccessRole): Promise<void> {
		await bridge.provisionEntity(ENTITY, ENTITY_TYPE);
		await bridge.editText(ENTITY, BODY);
		const invite = await new SharingEngine(guest, () => null).createInvite("Guest");
		await bridge.share({ entityId: ENTITY, type: ENTITY_TYPE, invite, role });
	}

	it("BOOTSTRAP: a first-time member applies the owner's opening state (the F-288 deadlock)", async () => {
		await shareWith(AccessRole.Editor);
		await drain();

		expect(received.unauthorized(), "the opening state must not be dropped").toEqual([]);
		expect(received.refusals, "the invite anchor must ADMIT the legitimate share").toEqual([]);
		expect(await received.text()).toContain("Q3 brief");
		expect(await received.activeMembers()).toContain(guest.identity.publicKeyBase64);
		// Single-use is pinned to a pair, not burnt on first sight: the invite must
		// still name this entity + this owner so a re-sent opening frame applies.
		const invites = await received.engine.ensureShareInvitesRepo();
		expect(invites.listOutstanding(Date.now()), "the invite is spent").toEqual([]);
	});

	it("a doc that already carries a record is authoritative - no re-bootstrap around it", async () => {
		await shareWith(AccessRole.Editor);
		await drain();

		const strangerDir = await mkdtemp(join(tmpdir(), "bs-f288-stranger-"));
		const stranger = await VaultSession.create({
			vaultId: "vlt_f288_stranger",
			vaultPath: strangerDir,
			forceInsecure: true,
		});
		const { doc } = await guest.ydocStore.load(ENTITY);
		try {
			expect(resolveMembers(doc, ENTITY).length).toBeGreaterThan(0);
			expect(isAuthorizedWriter(doc, ENTITY, stranger.identity.publicKey)).toBe(false);
			expect(
				authorizesAsShareBootstrap(
					doc,
					ENTITY,
					stranger.identity.publicKey,
					Y.encodeStateAsUpdate(doc),
				),
				"a populated local record must refuse the bootstrap branch outright",
			).toBe(false);
		} finally {
			doc.destroy();
			stranger.dispose();
			await rm(strangerDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it("an incoming state that does not name the sender never authorizes a bootstrap", () => {
		const local = new Y.Doc();
		const incoming = new Y.Doc();
		try {
			expect(
				authorizesAsShareBootstrap(
					local,
					ENTITY,
					owner.identity.publicKey,
					Y.encodeStateAsUpdate(incoming),
				),
			).toBe(false);
		} finally {
			local.destroy();
			incoming.destroy();
		}
	});

	it("a DELTA first frame does not authorize a bootstrap (only a full state can)", async () => {
		// The legit flow works because `SharingEngine.#emitFullState` sends
		// `Y.encodeStateAsUpdate(doc)`, so the probe resolves the whole record. If
		// some future path ever emits a DELTA as the opening frame, the access
		// entries stay in the probe's pending structs and the bootstrap must deny
		// rather than half-resolve. Pinning that here so the dependency is a test,
		// not a comment.
		await shareWith(AccessRole.Editor);
		const { doc } = await owner.ydocStore.load(ENTITY);
		try {
			const ahead = new Y.Doc();
			// A state vector from a doc that has never seen anything yields a full
			// state; ask instead for the diff against the doc ITSELF, which is empty.
			const delta = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc));
			const local = new Y.Doc();
			try {
				expect(authorizesAsShareBootstrap(local, ENTITY, owner.identity.publicKey, delta)).toBe(false);
			} finally {
				local.destroy();
				ahead.destroy();
			}
		} finally {
			doc.destroy();
		}
	});

	it("an oversized incoming state is refused before it reaches the decoder", () => {
		const local = new Y.Doc();
		try {
			expect(
				authorizesAsShareBootstrap(
					local,
					ENTITY,
					owner.identity.publicKey,
					new Uint8Array(4 * 1024 * 1024 + 1),
				),
			).toBe(false);
		} finally {
			local.destroy();
		}
	});

	it("VIEWER: the gate still drops a Viewer's write after bootstrap (F-288 holds)", async () => {
		await shareWith(AccessRole.Viewer);
		await drain();
		expect(await received.text(), "a Viewer still READS the shared doc").toContain("Q3 brief");

		// The guest is a Viewer holding the DEK and able to sign. Only the signed
		// access record stops them - on the owner's side and on their own copy.
		for (const session of [owner, guest]) {
			const { doc } = await session.ydocStore.load(ENTITY);
			try {
				expect(isAuthorizedWriter(doc, ENTITY, guest.identity.publicKey)).toBe(false);
				expect(
					authorizesAsShareBootstrap(doc, ENTITY, guest.identity.publicKey, Y.encodeStateAsUpdate(doc)),
					"the bootstrap branch must not rescue a Viewer",
				).toBe(false);
			} finally {
				doc.destroy();
			}
		}
	});
});
