/**
 * Collab-C5-invite-anchor — the adversarial regression for the security-review
 * FAIL that blocked 0.12.0.
 *
 * THE ATTACK. Mallory legitimately co-members ONE entity with Alice. From that
 * entity's signed access record she reads Alice's sovereign Ed25519 key and
 * Alice's device X25519 wrapping key, both of which every member can see, and
 * from the sovereign key she derives Alice's `inbox:<pubkey>` channel. She then:
 *
 *   1. mints a DEK of her own for an entity id Alice has never seen, seals it to
 *      Alice's X25519 and drops it on Alice's inbox — accepted, because a FIRST
 *      install has no key to substitute (`authorizesWrapInstall`);
 *   2. builds that entity's doc herself, SELF-SIGNING an Owner grant for herself
 *      and an Editor grant for Alice, and emits the full state.
 *
 *  Step 2 is the hole. Every grant verifies (she signed her own), so the F-288
 *  bootstrap predicate — which asks only "does the incoming record make this
 *  sender an active Editor+?" — says yes, and Alice's vault takes a populated,
 *  arbitrarily-typed entity with Mallory holding PERSISTENT WRITE, which reaches
 *  automation execution through the entities-service properties projection.
 *
 * The first assertion in each case pins the pre-fix behaviour explicitly:
 * `authorizesAsShareBootstrap` (unchanged, still shipped as the signature half)
 * ADMITS every one of these forgeries. The gate that now sits on top of it,
 * `authorizeShareBootstrap`, refuses them, because it additionally demands an
 * anchor rooted in something Alice already holds — the single-use secret from an
 * invite SHE minted, MAC-bound to the entity, her member key and the granter.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESSAGE_TYPE_URL } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DataStores } from "../storage/data-stores";
import { ShareInvitesRepository } from "../storage/entities-repo";
import { VaultSession } from "../vault/session";
import { AccessRole, authorizesAsShareBootstrap, grantAccess, revokeAccess } from "./access-record";
import { computeInviteAnchor, deriveInviteSecret } from "./invite-anchor";
import { ShareBootstrapVerdict, authorizeShareBootstrap } from "./share-bootstrap-authz";
import type { ShareInvite } from "./share-invite";
import { SharingEngine } from "./sharing-engine";

/** The entity Alice and Mallory legitimately share. */
const SHARED = "ent_team_brief";
/** The entity Mallory tries to inject. Alice has never heard of it. */
const INJECTED = "ent_mallory_payload";
const AUTOMATION_TYPE = "brainstorm/Automation/v1";

describe("Collab-C5-invite-anchor — a co-member cannot inject a second entity", () => {
	let aliceDir = "";
	let malloryDir = "";
	let alice: VaultSession;
	let mallory: VaultSession;
	let aliceInvites: ShareInvitesRepository;
	let aliceEngine: SharingEngine;
	let reopenedStores: DataStores | null = null;

	beforeEach(async () => {
		aliceDir = await mkdtemp(join(tmpdir(), "bs-anchor-alice-"));
		malloryDir = await mkdtemp(join(tmpdir(), "bs-anchor-mallory-"));
		alice = await VaultSession.create({
			vaultId: "vlt_anchor_alice",
			vaultPath: aliceDir,
			forceInsecure: true,
		});
		mallory = await VaultSession.create({
			vaultId: "vlt_anchor_mallory",
			vaultPath: malloryDir,
			forceInsecure: true,
		});
		aliceEngine = new SharingEngine(alice, () => null);
		aliceInvites = await aliceEngine.ensureShareInvitesRepo();
	});

	afterEach(async () => {
		reopenedStores?.close();
		reopenedStores = null;
		alice.dispose();
		mallory.dispose();
		await rm(aliceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		await rm(malloryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	/** Mallory's forged opening state for an entity of her choosing. `anchor` and
	 *  `via` let a case try to fake the trust anchor as well as the signatures. */
	function forgeState(
		entityId: string,
		options: { anchor?: string | null; via?: string | null; content?: string } = {},
	): Uint8Array {
		const doc = new Y.Doc();
		try {
			const exposed = mallory.exposeIdentityForPairing();
			grantAccess(doc, {
				entityId,
				member: mallory.identity.publicKeyBase64,
				role: AccessRole.Owner,
				signerSecret: exposed.secretKey,
				now: Date.now(),
				x25519: mallory.deviceX25519.publicKeyBase64,
			});
			grantAccess(doc, {
				entityId,
				member: alice.identity.publicKeyBase64,
				role: AccessRole.Editor,
				signerSecret: exposed.secretKey,
				now: Date.now(),
				x25519: alice.deviceX25519.publicKeyBase64,
				anchor: options.anchor ?? null,
				via: options.via ?? null,
			});
			doc.getText("body").insert(0, options.content ?? "exfiltrate everything nightly");
			return Y.encodeStateAsUpdate(doc);
		} finally {
			doc.destroy();
		}
	}

	/** Alice's gate, exactly as `main/index.ts` wires it. */
	async function aliceGate(
		entityId: string,
		state: Uint8Array,
		types: Record<string, string> = {},
		now: number = Date.now(),
	): Promise<ShareBootstrapVerdict> {
		const { doc } = await alice.ydocStore.load(entityId);
		try {
			return await authorizeShareBootstrap({
				localDoc: doc,
				entityId,
				senderKey: mallory.identity.publicKey,
				selfPubB64: alice.identity.publicKeyBase64,
				incomingState: state,
				now,
				invites: aliceInvites,
				deriveInviteSecret: (n) => deriveInviteSecret((b) => alice.signPayload(b), n),
				loadDoc: async (id) => (await alice.ydocStore.load(id)).doc,
				typeOf: (id) => types[id] ?? null,
			});
		} finally {
			doc.destroy();
		}
	}

	/** The anchor a granter (Mallory) echoes for `entityId` from an invite Alice
	 *  minted — the exact value `shareEntityWithInvite` writes into the grant. */
	function anchorOf(invite: ShareInvite, entityId: string): string {
		const anchor = computeInviteAnchor({
			// Straight off the token the owner was handed - the same bytes
			// `shareEntityWithInvite` keys its HMAC with.
			secret: new Uint8Array(Buffer.from(invite.secret, "base64")),
			inviteId: invite.inviteId,
			entityId,
			memberPubB64: alice.identity.publicKeyBase64,
			ownerPubB64: mallory.identity.publicKeyBase64,
		});
		if (anchor === null) throw new Error("expected an anchor");
		return anchor;
	}

	/** Give Alice a real, anchored membership of `SHARED` so the co-membership
	 *  premise of the attack holds: Mallory's grant in it carries Alice's X25519,
	 *  and the record carries the anchor Alice's shell redeemed. */
	async function coMemberOnSharedEntity(): Promise<Uint8Array> {
		const invite = await aliceEngine.createInvite("Alice");
		const doc = new Y.Doc();
		try {
			const exposed = mallory.exposeIdentityForPairing();
			const anchor = anchorOf(invite, SHARED);
			grantAccess(doc, {
				entityId: SHARED,
				member: mallory.identity.publicKeyBase64,
				role: AccessRole.Owner,
				signerSecret: exposed.secretKey,
				now: Date.now(),
				x25519: mallory.deviceX25519.publicKeyBase64,
			});
			grantAccess(doc, {
				entityId: SHARED,
				member: alice.identity.publicKeyBase64,
				role: AccessRole.Editor,
				signerSecret: exposed.secretKey,
				now: Date.now(),
				x25519: alice.deviceX25519.publicKeyBase64,
				anchor,
			});
			const state = Y.encodeStateAsUpdate(doc);
			expect(await aliceGate(SHARED, state)).toBe(ShareBootstrapVerdict.Allow);
			await alice.ydocStore.appendUpdate(SHARED, state);
			return state;
		} finally {
			doc.destroy();
		}
	}

	it("THE ATTACK: a self-signed record injects a second entity pre-fix, and is refused now", async () => {
		await coMemberOnSharedEntity();
		const forged = forgeState(INJECTED);

		const { doc } = await alice.ydocStore.load(INJECTED);
		try {
			expect(
				authorizesAsShareBootstrap(doc, INJECTED, mallory.identity.publicKey, forged),
				"PRE-FIX: signatures alone admit the forgery - this is the hole",
			).toBe(true);
		} finally {
			doc.destroy();
		}

		expect(
			await aliceGate(INJECTED, forged, { [INJECTED]: AUTOMATION_TYPE }),
			"POST-FIX: no anchor, no bootstrap",
		).toBe(ShareBootstrapVerdict.DenyNoAnchor);
	});

	it("an anchor LIFTED from the entity they legitimately share is bound to that entity", async () => {
		await coMemberOnSharedEntity();
		// Mallory can read Alice's real anchor out of the shared entity's record -
		// every member can. It is worth nothing anywhere else.
		const { doc } = await alice.ydocStore.load(SHARED);
		let lifted: string | null = null;
		try {
			const entries = doc.getMap("brainstorm.meta").get("access") as Y.Array<Y.Map<unknown>>;
			for (let i = 0; i < entries.length; i++) {
				const value = entries.get(i).get("anchor");
				if (typeof value === "string") lifted = value;
			}
		} finally {
			doc.destroy();
		}
		expect(lifted, "the shared entity really does carry an anchor to steal").not.toBeNull();

		const forged = forgeState(INJECTED, { anchor: lifted });
		expect(await aliceGate(INJECTED, forged)).toBe(ShareBootstrapVerdict.DenyInviteMismatch);
	});

	it("a fabricated anchor for an invite Alice never minted never verifies", async () => {
		const forged = forgeState(INJECTED, { anchor: "AAAAAAAAAAAAAAAAAAAAAA:aGVsbG8=" });
		expect(await aliceGate(INJECTED, forged)).toBe(ShareBootstrapVerdict.DenyInviteMismatch);
	});

	it("a garbage anchor is refused as malformed, never crashes the receive path", async () => {
		for (const anchor of ["", ":", "no-separator", "a:".padEnd(400, "z"), "%%%:%%%"]) {
			const forged = forgeState(INJECTED, { anchor });
			const verdict = await aliceGate(INJECTED, forged);
			expect(verdict).not.toBe(ShareBootstrapVerdict.Allow);
		}
	});

	it("a PIPE-carrying anchor cannot make one signature cover two grants", async () => {
		// `|a=` and `|v=` are tagged segments of the grant's signed payload, so an
		// anchor containing the literal `|v=` would make one byte string readable as
		// both `(anchor = "Z|v=Y", via = null)` and `(anchor = "Z", via = "Y")`.
		// The minting side refuses it outright...
		const invite = await aliceEngine.createInvite("Alice");
		expect(() =>
			grantAccess(new Y.Doc(), {
				entityId: INJECTED,
				member: alice.identity.publicKeyBase64,
				role: AccessRole.Editor,
				signerSecret: mallory.exposeIdentityForPairing().secretKey,
				now: Date.now(),
				anchor: `${anchorOf(invite, INJECTED)}|v=${SHARED}`,
			}),
		).toThrow(/must not contain/);

		// ...and a value smuggled straight into the stored map reads as ABSENT, so
		// the reconstructed payload mismatches and the grant does not validate.
		const doc = new Y.Doc();
		try {
			const exposed = mallory.exposeIdentityForPairing();
			grantAccess(doc, {
				entityId: INJECTED,
				member: mallory.identity.publicKeyBase64,
				role: AccessRole.Owner,
				signerSecret: exposed.secretKey,
				now: Date.now(),
			});
			grantAccess(doc, {
				entityId: INJECTED,
				member: alice.identity.publicKeyBase64,
				role: AccessRole.Editor,
				signerSecret: exposed.secretKey,
				now: Date.now(),
				anchor: anchorOf(invite, INJECTED),
			});
			const entries = doc.getMap("brainstorm.meta").get("access") as Y.Array<Y.Map<unknown>>;
			entries.get(1).set("anchor", `${anchorOf(invite, INJECTED)}|v=${SHARED}`);
			expect(await aliceGate(INJECTED, Y.encodeStateAsUpdate(doc))).toBe(
				ShareBootstrapVerdict.DenyNoSelfGrant,
			);
		} finally {
			doc.destroy();
		}
	});

	it("claiming CONTAINER descent from an entity with no containment rule is refused", async () => {
		await coMemberOnSharedEntity();
		const forged = forgeState(INJECTED, { via: SHARED });
		expect(
			await aliceGate(INJECTED, forged, {
				[SHARED]: "brainstorm/Note/v1",
				[INJECTED]: AUTOMATION_TYPE,
			}),
			"a Note contains nothing, so nothing descends from it",
		).toBe(ShareBootstrapVerdict.DenyContainerNoRule);
	});

	it("claiming descent from a container Alice is not in is refused", async () => {
		const forged = forgeState(INJECTED, { via: "ent_container_alice_never_saw" });
		expect(await aliceGate(INJECTED, forged)).toBe(ShareBootstrapVerdict.DenyContainerNotMember);
	});

	it("a record that does not name Alice never bootstraps, however well signed", async () => {
		const doc = new Y.Doc();
		try {
			const exposed = mallory.exposeIdentityForPairing();
			grantAccess(doc, {
				entityId: INJECTED,
				member: mallory.identity.publicKeyBase64,
				role: AccessRole.Owner,
				signerSecret: exposed.secretKey,
				now: Date.now(),
			});
			const verdict = await aliceGate(INJECTED, Y.encodeStateAsUpdate(doc));
			expect(verdict).toBe(ShareBootstrapVerdict.DenyNoSelfGrant);
		} finally {
			doc.destroy();
		}
	});

	it("SPENT: even the real invite holder gets exactly one entity out of it", async () => {
		// The invite Alice minted for Mallory is redeemed legitimately on SHARED.
		// Mallory holds the token, so she can compute a perfect anchor for a second
		// entity - and it is refused because the invite is pinned, not because she
		// cannot do the arithmetic.
		const invite = await aliceEngine.createInvite("Alice");
		const first = forgeState(SHARED, { anchor: anchorOf(invite, SHARED) });
		expect(await aliceGate(SHARED, first)).toBe(ShareBootstrapVerdict.Allow);
		await alice.ydocStore.appendUpdate(SHARED, first);

		const second = forgeState(INJECTED, { anchor: anchorOf(invite, INJECTED) });
		expect(await aliceGate(INJECTED, second)).toBe(ShareBootstrapVerdict.DenyInviteSpent);
	});

	it("EXPIRED: an invite past its window cannot open its first entity", async () => {
		const invite = await aliceEngine.createInvite("Alice");
		const forged = forgeState(INJECTED, { anchor: anchorOf(invite, INJECTED) });
		expect(await aliceGate(INJECTED, forged, {}, invite.expiresAt + 1)).toBe(
			ShareBootstrapVerdict.DenyInviteExpired,
		);
	});

	it("REVOKED: a withdrawn invite is refused even with a perfect anchor", async () => {
		const invite = await aliceEngine.createInvite("Alice");
		const forged = forgeState(INJECTED, { anchor: anchorOf(invite, INJECTED) });
		expect(aliceInvites.revoke(invite.inviteId, Date.now())).toBe(true);
		expect(await aliceGate(INJECTED, forged)).toBe(ShareBootstrapVerdict.DenyInviteRevoked);
	});

	it("RESTART: a spent invite is still spent after the vault store is reopened", async () => {
		const invite = await aliceEngine.createInvite("Alice");
		const first = forgeState(SHARED, { anchor: anchorOf(invite, SHARED) });
		expect(await aliceGate(SHARED, first)).toBe(ShareBootstrapVerdict.Allow);

		// Rebuild the invite store from the vault FILE, dropping every in-memory
		// handle the way a relaunch does. If single-use lived in memory, every
		// invite the vault ever minted would come back redeemable.
		const reopened = new DataStores(aliceDir);
		reopenedStores = reopened;
		aliceInvites = new ShareInvitesRepository(await reopened.open("entities"));
		expect(aliceInvites.listOutstanding(Date.now()), "the invite is spent on disk").toEqual([]);

		const second = forgeState(INJECTED, { anchor: anchorOf(invite, INJECTED) });
		expect(await aliceGate(INJECTED, second)).toBe(ShareBootstrapVerdict.DenyInviteSpent);
	});

	it("a local record already resolved is authoritative - no re-bootstrap around it", async () => {
		await coMemberOnSharedEntity();
		const forged = forgeState(SHARED);
		expect(await aliceGate(SHARED, forged)).toBe(ShareBootstrapVerdict.DenyLocalRecord);
	});

	it("CASCADE: a child of a container Alice really belongs to IS admitted", async () => {
		// The legitimate collection path: Alice is a member of a channel, and a
		// co-member introduces a message under it. No invite is in play; the
		// container Alice already holds is the anchor.
		const invite = await aliceEngine.createInvite("Alice");
		const anchoredChannel = forgeState(SHARED, { anchor: anchorOf(invite, SHARED) });
		expect(await aliceGate(SHARED, anchoredChannel)).toBe(ShareBootstrapVerdict.Allow);
		await alice.ydocStore.appendUpdate(SHARED, anchoredChannel);

		const types = {
			[SHARED]: "io.brainstorm.chat/Channel/v1",
			[INJECTED]: MESSAGE_TYPE_URL,
		};
		const child = forgeState(INJECTED, { via: SHARED });
		expect(await aliceGate(INJECTED, child, types)).toBe(ShareBootstrapVerdict.Allow);

		// ...but only at the container's declared child type. An Automation
		// smuggled in under the same container is refused.
		const wrongType = { ...types, [INJECTED]: AUTOMATION_TYPE };
		expect(await aliceGate(INJECTED, child, wrongType)).toBe(
			ShareBootstrapVerdict.DenyContainerChildType,
		);
	});

	it("REVOKED: a member removed from the container can no longer cascade into it", async () => {
		const invite = await aliceEngine.createInvite("Alice");
		const channel = forgeState(SHARED, { anchor: anchorOf(invite, SHARED) });
		expect(await aliceGate(SHARED, channel)).toBe(ShareBootstrapVerdict.Allow);
		await alice.ydocStore.appendUpdate(SHARED, channel);

		// Alice revokes Mallory on her own copy of the container. Mallory's later
		// cascade claim resolves against THAT record, not the one she sends.
		const { doc } = await alice.ydocStore.load(SHARED);
		try {
			const exposed = alice.exposeIdentityForPairing();
			expect(
				revokeAccess(doc, {
					entityId: SHARED,
					member: mallory.identity.publicKeyBase64,
					signerSecret: exposed.secretKey,
					now: Date.now(),
				}),
			).toBe(true);
			await alice.ydocStore.appendUpdate(SHARED, Y.encodeStateAsUpdate(doc));
		} finally {
			doc.destroy();
		}

		const types = { [SHARED]: "io.brainstorm.chat/Channel/v1", [INJECTED]: MESSAGE_TYPE_URL };
		const child = forgeState(INJECTED, { via: SHARED });
		expect(await aliceGate(INJECTED, child, types)).toBe(
			ShareBootstrapVerdict.DenyContainerGranterNotMember,
		);
	});

	it("a granter who is only an EDITOR cannot redeem an anchor (F-288 tightening holds)", async () => {
		const invite = await aliceEngine.createInvite("Alice");
		const anchor = anchorOf(invite, INJECTED);
		const doc = new Y.Doc();
		try {
			const exposed = mallory.exposeIdentityForPairing();
			grantAccess(doc, {
				entityId: INJECTED,
				member: mallory.identity.publicKeyBase64,
				role: AccessRole.Editor,
				signerSecret: exposed.secretKey,
				now: Date.now(),
			});
			grantAccess(doc, {
				entityId: INJECTED,
				member: alice.identity.publicKeyBase64,
				role: AccessRole.Editor,
				signerSecret: exposed.secretKey,
				now: Date.now(),
				anchor,
			});
			expect(await aliceGate(INJECTED, Y.encodeStateAsUpdate(doc))).toBe(
				ShareBootstrapVerdict.DenyGranterNotOwner,
			);
		} finally {
			doc.destroy();
		}
	});
});
