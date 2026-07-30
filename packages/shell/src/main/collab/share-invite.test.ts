import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { XCHACHA_NONCE_BYTES, bytesToBase64, generateSymmetricKey } from "../credentials/crypto";
import { generateDeviceX25519 } from "../credentials/device-x25519";
import { generateIdentity, signPayload, verifySignature } from "../credentials/identity";
import { unwrapDekForRecipient } from "../credentials/member-wraps";
import type { EntityDekStore } from "../entities/entity-dek-store";
import {
	type PipelineContext,
	emitWrapBootstrap,
	receiveWrapBootstrap,
} from "../sync/envelope-pipeline";
import { LoopbackRelayPort } from "../sync/relay-port";
import { randomBytes } from "../test-support/crypto-test-helpers";
import { AccessRole, activeMembers, isActiveMember, roleOf } from "./access-record";
import { INVITE_SECRET_BYTES } from "./invite-anchor";
import {
	SHARE_INVITE_VERSION,
	createShareInvite,
	createShareInviteSigned,
	isShareInvite,
	shareEntityWithInvite,
	verifyShareInvite,
} from "./share-invite";

const ENTITY_ID = "ent_share_c2";
const OTHER_ENTITY = "ent_other";

/** A collaborator: a user Ed25519 identity + an X25519 wrapping keypair. */
function makeCollaborator(label: string) {
	const user = generateIdentity();
	const wrapping = generateDeviceX25519();
	const invite = createShareInvite({
		userSecret: user.secretKey,
		x25519Pub: wrapping.publicKey,
		label,
	});
	return { user, wrapping, invite };
}

describe("share-invite — the ShareInvite primitive", () => {
	it("round-trips: a self-signed invite verifies", () => {
		const { invite } = makeCollaborator("Marcus — laptop");
		expect(isShareInvite(invite)).toBe(true);
		expect(invite.v).toBe(SHARE_INVITE_VERSION);
		expect(verifyShareInvite(invite)).toBe(true);
	});

	it("createShareInviteSigned (closure form) matches the raw-secret form", () => {
		const user = generateIdentity();
		const wrapping = generateDeviceX25519();
		// Pin the anchor secret + clock: a production mint draws fresh randomness
		// and stamps a fresh expiry, so only a pinned pair can be byte-compared.
		const anchorSecret = randomBytes(INVITE_SECRET_BYTES);
		const now = 1_700_000_000_000;
		const fromSecret = createShareInvite({
			userSecret: user.secretKey,
			x25519Pub: wrapping.publicKey,
			label: "Marcus",
			secret: anchorSecret,
			now,
		});
		// A session signs without exposing its secret — same Ed25519 key + payload
		// is deterministic (RFC 8032), so the two invites are byte-identical.
		const fromClosure = createShareInviteSigned({
			userPub: user.publicKey,
			x25519Pub: wrapping.publicKey,
			label: "Marcus",
			secret: anchorSecret,
			now,
			sign: (payload) => signPayload(user.secretKey, payload),
		});
		expect(fromClosure).toEqual(fromSecret);
		expect(verifyShareInvite(fromClosure)).toBe(true);
	});

	it("rejects a swapped wrapping key (the binding's whole point)", () => {
		const { invite } = makeCollaborator("Mira");
		const attackerKey = generateDeviceX25519();
		const tampered = { ...invite, x25519PubB64: bytesToBase64(attackerKey.publicKey) };
		expect(verifyShareInvite(tampered)).toBe(false);
	});

	it("rejects a swapped user identity", () => {
		const { invite } = makeCollaborator("Mira");
		const other = generateIdentity();
		const tampered = { ...invite, userPubB64: bytesToBase64(other.publicKey) };
		expect(verifyShareInvite(tampered)).toBe(false);
	});

	it("rejects a tampered label and a tampered signature", () => {
		const { invite } = makeCollaborator("Mira");
		expect(verifyShareInvite({ ...invite, label: "Owner" })).toBe(false);
		expect(verifyShareInvite({ ...invite, sig: bytesToBase64(randomBytes(64)) })).toBe(false);
	});

	it("rejects malformed / wrong-version / undecodable invites without throwing", () => {
		const { invite } = makeCollaborator("Mira");
		expect(verifyShareInvite(null)).toBe(false);
		expect(verifyShareInvite({})).toBe(false);
		expect(verifyShareInvite({ ...invite, v: 1 })).toBe(false);
		expect(verifyShareInvite({ ...invite, sig: "not base64 %%%" })).toBe(false);
	});
});

describe("share-invite — shareEntityWithInvite (owner orchestration)", () => {
	it("authorizes the invitee and delivers a DEK they can unwrap", () => {
		const owner = generateIdentity();
		const { user, wrapping, invite } = makeCollaborator("Marcus");
		const doc = new Y.Doc();
		const dek = generateSymmetricKey();

		const wrap = shareEntityWithInvite(doc, {
			entityId: ENTITY_ID,
			invite,
			role: AccessRole.Editor,
			dek,
			signerSecret: owner.secretKey,
			now: 1000,
		});

		// Authorization: a signature-valid, active grant for the invitee's USER key.
		expect(isActiveMember(doc, ENTITY_ID, invite.userPubB64)).toBe(true);
		expect(roleOf(doc, ENTITY_ID, invite.userPubB64)).toBe(AccessRole.Editor);
		const members = activeMembers(doc, ENTITY_ID);
		expect(members).toHaveLength(1);
		expect(members[0]?.addedBy).toBe(bytesToBase64(owner.publicKey));

		// Key delivery: the invitee opens the wrap with their X25519 secret and
		// recovers the exact DEK.
		const recovered = unwrapDekForRecipient(wrap, wrapping.secretKey, ENTITY_ID);
		expect(Buffer.from(recovered).equals(Buffer.from(dek))).toBe(true);
		// The user key is the identity; only the matching X25519 secret opens it.
		expect(user.publicKey).toHaveLength(32);
	});

	it("refuses to share to an unverifiable invite", () => {
		const owner = generateIdentity();
		const { invite } = makeCollaborator("Marcus");
		const forged = { ...invite, x25519PubB64: bytesToBase64(generateDeviceX25519().publicKey) };
		const doc = new Y.Doc();
		expect(() =>
			shareEntityWithInvite(doc, {
				entityId: ENTITY_ID,
				invite: forged,
				role: AccessRole.Editor,
				dek: generateSymmetricKey(),
				signerSecret: owner.secretKey,
				now: 1000,
			}),
		).toThrow(/verification/);
		// Nothing was authorized.
		expect(activeMembers(doc, ENTITY_ID)).toHaveLength(0);
	});

	it("rejects an empty entityId before mutating the doc (no dangling grant)", () => {
		const owner = generateIdentity();
		const { invite } = makeCollaborator("Marcus");
		const doc = new Y.Doc();
		expect(() =>
			shareEntityWithInvite(doc, {
				entityId: "",
				invite,
				role: AccessRole.Editor,
				dek: generateSymmetricKey(),
				signerSecret: owner.secretKey,
				now: 1000,
			}),
		).toThrow(/entityId/);
		const access = doc.getMap("brainstorm.meta").get("access") as Y.Array<unknown> | undefined;
		expect(access === undefined || access.length === 0).toBe(true);
	});

	it("throws on a re-share at a different role (no silent role no-op)", () => {
		const owner = generateIdentity();
		const { invite } = makeCollaborator("Marcus");
		const doc = new Y.Doc();
		const opts = {
			entityId: ENTITY_ID,
			invite,
			role: AccessRole.Viewer,
			dek: generateSymmetricKey(),
			signerSecret: owner.secretKey,
			now: 1000,
		} as const;
		shareEntityWithInvite(doc, opts);
		expect(() => shareEntityWithInvite(doc, { ...opts, role: AccessRole.Editor, now: 2000 })).toThrow(
			/already a member/,
		);
		// The role is unchanged — the original grant stands.
		expect(roleOf(doc, ENTITY_ID, invite.userPubB64)).toBe(AccessRole.Viewer);
	});

	it("is idempotent — re-sharing returns the same wrap, no duplicates", () => {
		const owner = generateIdentity();
		const { invite } = makeCollaborator("Marcus");
		const doc = new Y.Doc();
		const dek = generateSymmetricKey();
		const opts = {
			entityId: ENTITY_ID,
			invite,
			role: AccessRole.Editor,
			dek,
			signerSecret: owner.secretKey,
			now: 1000,
		} as const;

		const first = shareEntityWithInvite(doc, opts);
		const second = shareEntityWithInvite(doc, { ...opts, now: 2000 });

		expect(second).toEqual(first);
		expect(activeMembers(doc, ENTITY_ID)).toHaveLength(1);
		// One wrap on the doc, not two.
		const wraps = doc.getMap("brainstorm.meta").get("wraps") as Y.Array<unknown>;
		expect(wraps.length).toBe(1);
	});

	it("the delivered wrap is entity-bound — it won't open under another entity id", () => {
		const owner = generateIdentity();
		const { wrapping, invite } = makeCollaborator("Marcus");
		const doc = new Y.Doc();
		const dek = generateSymmetricKey();
		const wrap = shareEntityWithInvite(doc, {
			entityId: ENTITY_ID,
			invite,
			role: AccessRole.Viewer,
			dek,
			signerSecret: owner.secretKey,
			now: 1000,
		});
		expect(() => unwrapDekForRecipient(wrap, wrapping.secretKey, OTHER_ENTITY)).toThrow();
	});
});

/** Minimal pipeline context for the wrap-bootstrap path, which never touches
 *  the DEK store (the wrap is already HPKE-sealed). Signs/verifies the routing
 *  header with the sender's Ed25519 key. */
function makeWrapCtx(args: {
	senderSecret: Uint8Array;
	senderPub: Uint8Array;
	relay: LoopbackRelayPort;
}): PipelineContext {
	const seq = new Map<string, number>();
	return {
		dekStore: {
			open() {
				throw new Error("wrap-bootstrap path must not open the DEK store");
			},
		} as unknown as EntityDekStore,
		devicePub: args.senderPub,
		deviceSign: (bytes) => signPayload(args.senderSecret, bytes),
		deviceVerify: (sig, bytes, senderPub) => verifySignature(senderPub, bytes, sig),
		resolveEntity: (routedId) => (routedId === ENTITY_ID ? { id: ENTITY_ID, type: "note" } : null),
		relay: args.relay,
		nextSeq: (entityId) => {
			const next = (seq.get(entityId) ?? 0) + 1;
			seq.set(entityId, next);
			return next;
		},
		nowMs: () => 1234,
		randomNonce: () => randomBytes(XCHACHA_NONCE_BYTES),
	};
}

describe("share-invite — wrap reaches the collaborator over the relay (C2 flow)", () => {
	it("owner shares → emit wrap-bootstrap → collaborator unwraps the DEK, blind relay sees ciphertext", async () => {
		const owner = generateIdentity();
		const { wrapping, invite } = makeCollaborator("Marcus");

		// Owner authorizes + wraps on their doc copy.
		const ownerDoc = new Y.Doc();
		const dek = generateSymmetricKey();
		const wrap = shareEntityWithInvite(ownerDoc, {
			entityId: ENTITY_ID,
			invite,
			role: AccessRole.Editor,
			dek,
			signerSecret: owner.secretKey,
			now: 1000,
		});

		// The collaborator's synced copy of the (otherwise-encrypted) doc carries
		// the grant — that's how they confirm a real authorization backs the wrap.
		const collabDoc = new Y.Doc();
		Y.applyUpdate(collabDoc, Y.encodeStateAsUpdate(ownerDoc));
		expect(isActiveMember(collabDoc, ENTITY_ID, invite.userPubB64)).toBe(true);

		const relays = LoopbackRelayPort.pair(2);
		const ownerRelay = relays[0];
		const collabRelay = relays[1];
		if (!ownerRelay || !collabRelay) throw new Error("LoopbackRelayPort.pair(2) returned < 2 ports");
		const ownerCtx = makeWrapCtx({
			senderSecret: owner.secretKey,
			senderPub: owner.publicKey,
			relay: ownerRelay,
		});
		const collabCtx = makeWrapCtx({
			senderSecret: owner.secretKey,
			senderPub: owner.publicKey,
			relay: collabRelay,
		});

		const seenFrames: Uint8Array[] = [];
		let recovered: Uint8Array | null = null;
		collabRelay.onFrame((frame) => {
			seenFrames.push(frame);
			void receiveWrapBootstrap(frame, collabCtx, (received, entityId) => {
				expect(entityId).toBe(ENTITY_ID);
				recovered = unwrapDekForRecipient(received, wrapping.secretKey, entityId);
			});
		});

		await emitWrapBootstrap(ENTITY_ID, wrap, ownerCtx);

		expect(recovered).not.toBeNull();
		expect(Buffer.from(recovered as unknown as Uint8Array).equals(Buffer.from(dek))).toBe(true);

		// Blind relay: the 32-byte plaintext DEK never appears in any frame body.
		const dekHex = Buffer.from(dek).toString("hex");
		for (const frame of seenFrames) {
			expect(Buffer.from(frame).toString("hex").includes(dekHex)).toBe(false);
		}
	});
});
