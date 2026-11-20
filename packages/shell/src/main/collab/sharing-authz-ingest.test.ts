/**
 * The sharing authorization policy on the REAL ingest + DEK path (0.16.0).
 *
 * `access-record-authz.test.ts` proves the policy on bare docs. This drives it
 * through the parts production runs: three real `VaultSession`s, each with its
 * own `SharingEngine`, `EntityDekStore`, persisted `YDocStore` and `entities.db`,
 * exchanging sealed frames over a loopback relay, with every inbound frame
 * judged by `createSyncAuthz` — the same three closures `main/index.ts` hands
 * the live-sync engine.
 *
 * Alice owns a channel and shares it with Eve as an Editor. Eve then does, with
 * ordinary sync updates sealed under the DEK she legitimately holds, everything
 * the pre-0.16 characterisation showed an Editor could do — and Alice's shell
 * applies every one of those updates whole (it has to: they are CRDT deltas
 * from an authorized writer). The assertions are on what that changes for
 * Alice: nothing.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESSAGE_TYPE_URL } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { base64ToBytes, generateSymmetricKey } from "../credentials/crypto";
import { verifySignature } from "../credentials/identity";
import { listWraps, wrapDekForRecipient, wrapDekVersionOf } from "../credentials/member-wraps";
import type { EntityDekStore } from "../entities/entity-dek-store";
import { installEntityDek } from "../entities/install-wrap";
import type { EntitiesRepository } from "../storage/entities-repo";
import { decodeFrame } from "../sync/envelope-codec";
import {
	type PipelineContext,
	emitWrapBootstrap,
	receiveAndApply,
	receiveWrapBootstrap,
} from "../sync/envelope-pipeline";
import { LoopbackRelayPort, type RelayPort } from "../sync/relay-port";
import { WireKind } from "../sync/routing-header";
import { VaultSession } from "../vault/session";
import { AccessRole, getAccessArray, grantAccess, revokeAccess } from "./access-record";
import { inboxChannelFor } from "./inbox-channel";
import { type CollabRelayLike, SharingDeniedError, SharingEngine } from "./sharing-engine";
import { type SyncAuthz, createSyncAuthz } from "./sync-authz";

const CHANNEL = "ent_authz_channel";
const CHANNEL_TYPE = "io.brainstorm.chat/Channel/v1";
const BODY = "body";

function relayAdapter(port: LoopbackRelayPort): CollabRelayLike {
	return {
		currentPort: (): RelayPort => port,
		onFrame: (cb) => port.onFrame(cb),
		offFrame: (cb) => port.offFrame(cb),
	};
}

/** One participant's shell, built from the real parts and gated exactly as
 *  production gates it. Frames queue on arrival and apply on `drain()`, so a
 *  test controls the order things happen in. */
class Shell {
	readonly refused: string[] = [];
	readonly #inbox: Uint8Array[] = [];
	#seq = 0;

	private constructor(
		readonly session: VaultSession,
		readonly engine: SharingEngine,
		readonly repo: EntitiesRepository,
		readonly dekStore: EntityDekStore,
		readonly authz: SyncAuthz,
		readonly port: LoopbackRelayPort,
		readonly dir: string,
	) {
		port.onFrame((frame) => {
			this.#inbox.push(frame);
		});
	}

	static async open(label: string, port: LoopbackRelayPort): Promise<Shell> {
		const dir = await mkdtemp(join(tmpdir(), `bs-authz-${label}-`));
		const session = await VaultSession.create({
			vaultId: `vlt_authz_${label}`,
			vaultPath: dir,
			forceInsecure: true,
		});
		const engine = new SharingEngine(session, () => relayAdapter(port));
		const repo = await engine.ensureEntitiesRepo();
		const dekStore = await engine.ensureDekStore();
		const authz = createSyncAuthz({
			session,
			dekStore,
			accessTrust: await session.accessTrust(),
			shareInvites: await engine.ensureShareInvitesRepo(),
			typeOf: (id) => repo.get(id)?.type ?? null,
		});
		return new Shell(session, engine, repo, dekStore, authz, port, dir);
	}

	get pub(): string {
		return this.session.identity.publicKeyBase64;
	}

	ctx(): PipelineContext {
		return {
			dekStore: this.dekStore,
			devicePub: this.session.identity.publicKey,
			deviceSign: (bytes) => this.session.signPayload(bytes),
			deviceVerify: (sig, bytes, senderPub) => verifySignature(senderPub, bytes, sig),
			resolveEntity: (routedId) => {
				const type = this.repo.get(routedId)?.type;
				return type ? { id: routedId, type } : { id: routedId, type: CHANNEL_TYPE };
			},
			relay: this.port,
			nextSeq: () => this.#seq++,
			nowMs: () => Date.now(),
			randomNonce: () => crypto.getRandomValues(new Uint8Array(24)),
			authorizeWriter: this.authz.authorizeWriter,
		};
	}

	/** Apply everything received so far, the way `LiveSyncEngine` does: a wrap
	 *  installs (if its sender may install it), a state frame applies (if its
	 *  sender may write). A refusal is recorded, never thrown. */
	async drain(): Promise<void> {
		for (const frame of this.#inbox.splice(0)) {
			const decoded = decodeFrame(frame);
			try {
				if (decoded.header.kind === WireKind.WrapBootstrap) {
					await receiveWrapBootstrap(frame, this.ctx(), async (wrap, id, sender) => {
						if (!(await this.authz.authorizeWrapInstall(id, sender))) {
							this.refused.push(`wrap:${id}`);
							return;
						}
						if (wrap.recipientPubB64 !== this.session.deviceX25519.publicKeyBase64) return;
						const { dek, type } = this.session.unwrapMemberWrapWithType(wrap, id);
						try {
							if (!this.repo.get(id)) {
								this.repo.create({
									id,
									type: type ?? CHANNEL_TYPE,
									properties: {},
									createdBy: "received",
									now: Date.now(),
									dekId: null,
								});
							}
							installEntityDek(id, dek, wrapDekVersionOf(wrap), this.dekStore, this.repo);
						} finally {
							dek.fill(0);
						}
					});
				} else {
					const entityId = decoded.header.entityId;
					await receiveAndApply(frame, this.ctx(), async (plaintext) => {
						await this.engine.serializedAppendUpdate(entityId, plaintext);
					});
				}
			} catch (error) {
				this.refused.push((error as Error).message);
			}
		}
	}

	unauthorized(): string[] {
		return this.refused.filter((m) => m.includes("not an authorized writer"));
	}

	async read<T>(entityId: string, fn: (doc: Y.Doc) => T): Promise<T> {
		const { doc } = await this.session.ydocStore.load(entityId);
		try {
			return fn(doc);
		} finally {
			doc.destroy();
		}
	}

	async active(entityId: string): Promise<string[]> {
		return (await this.engine.access(entityId))
			.filter((m) => m.active)
			.map((m) => m.member)
			.sort();
	}

	text(entityId: string): Promise<string> {
		return this.read(entityId, (doc) => doc.getText(BODY).toString());
	}

	dekVersion(entityId: string): number {
		const handle = this.dekStore.open(entityId);
		if (!handle) throw new Error("no DEK");
		this.dekStore.close(handle.dek);
		return handle.version;
	}

	async close(): Promise<void> {
		this.port.close();
		await this.session.dispose();
		await rm(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

describe("an Editor's sync updates cannot change who holds an entity — real ingest + DEK path", () => {
	let alice: Shell;
	let eve: Shell;
	let sam: Shell;

	beforeEach(async () => {
		const ports = LoopbackRelayPort.pair(3);
		const [p0, p1, p2] = ports;
		if (!p0 || !p1 || !p2) throw new Error("expected three loopback ports");
		alice = await Shell.open("alice", p0);
		eve = await Shell.open("eve", p1);
		sam = await Shell.open("sam", p2);

		// Alice owns the channel and shares it with Eve as an Editor.
		await alice.engine.provisionEntity(CHANNEL, CHANNEL_TYPE, { name: "general" });
		const invite = await eve.engine.createInvite("Eve");
		await alice.engine.shareCollection({
			entityId: CHANNEL,
			type: CHANNEL_TYPE,
			invite,
			role: AccessRole.Editor,
		});
		await eve.drain();
		await sam.drain();
	});

	afterEach(async () => {
		await Promise.all([alice.close(), eve.close(), sam.close()]);
	});

	/** Eve hands Sam the channel's DEK out of band — she holds it, nothing can
	 *  stop her — so that Sam can seal frames the relay and the AEAD accept. */
	function leakDekToSam(): void {
		const handle = eve.dekStore.open(CHANNEL);
		if (!handle) throw new Error("eve has no DEK");
		try {
			sam.repo.create({
				id: CHANNEL,
				type: CHANNEL_TYPE,
				properties: {},
				createdBy: "leaked",
				now: Date.now(),
				dekId: null,
			});
			installEntityDek(CHANNEL, handle.dek, handle.version, sam.dekStore, sam.repo);
		} finally {
			eve.dekStore.close(handle.dek);
		}
	}

	it("the baseline: the legitimate share lands, the receiver pins the owner as root, and edits flow both ways", async () => {
		expect(eve.unauthorized()).toEqual([]);
		expect(await eve.active(CHANNEL)).toEqual([alice.pub, eve.pub].sort());
		expect((await eve.session.accessTrust()).rootOf(CHANNEL)).toBe(alice.pub);
		expect((await alice.session.accessTrust()).rootOf(CHANNEL)).toBe(alice.pub);
		expect(await alice.authz.isShared(CHANNEL)).toBe(true);
		expect(await eve.authz.isShared(CHANNEL)).toBe(true);

		await eve.engine.mutateAndEmit(CHANNEL, (doc) => doc.getText(BODY).insert(0, "from eve. "));
		await alice.drain();
		expect(alice.unauthorized()).toEqual([]);
		expect(await alice.text(CHANNEL)).toBe("from eve. ");
	});

	it("Eve adds Sam as an Editor: Alice applies the update and Sam is still nobody", async () => {
		const eveSecret = eve.session.exposeIdentityForPairing().secretKey;
		await eve.engine.mutateAndEmit(CHANNEL, (doc) => {
			grantAccess(doc, {
				entityId: CHANNEL,
				member: sam.pub,
				role: AccessRole.Editor,
				signerSecret: eveSecret,
				now: Date.now(),
				x25519: sam.session.deviceX25519.publicKeyBase64,
			});
			doc.getText(BODY).insert(0, "eve was here. ");
		});
		await alice.drain();
		// The update WAS applied — the content half of it is right there…
		expect(await alice.text(CHANNEL)).toBe("eve was here. ");
		expect(
			await alice.read(CHANNEL, (doc) =>
				getAccessArray(doc)
					.toArray()
					.some((entry) => entry.get("member") === sam.pub),
			),
		).toBe(true);
		// …and Sam is not a member on any surface that reads the record.
		expect(await alice.active(CHANNEL)).toEqual([alice.pub, eve.pub].sort());
		expect((await alice.engine.access(CHANNEL)).some((m) => m.member === sam.pub)).toBe(false);

		// Sam, holding the leaked DEK, writes. The frame decrypts and verifies; the
		// writer gate is what refuses it.
		leakDekToSam();
		await sam.engine.mutateAndEmit(CHANNEL, (doc) => doc.getText(BODY).insert(0, "SAM "));
		await alice.drain();
		expect(alice.unauthorized()).toHaveLength(1);
		expect(await alice.text(CHANNEL)).toBe("eve was here. ");

		// The cascade wraps a new message's DEK to the channel's members: not Sam.
		await alice.engine.provisionEntity("msg_after", MESSAGE_TYPE_URL, { conversation: CHANNEL });
		expect(await alice.engine.autoShareNewChild("msg_after", MESSAGE_TYPE_URL, CHANNEL)).toBe(1);
		const samKey = sam.session.deviceX25519.publicKeyBase64;
		expect(
			await alice.read("msg_after", (doc) =>
				listWraps(doc).some((wrap) => wrap.recipientPubB64 === samKey),
			),
		).toBe(false);
		expect(await alice.active("msg_after")).toEqual([alice.pub, eve.pub].sort());
	});

	it("Eve revokes Alice and makes herself Owner: Alice is still the owner, and Eve's DEK rotation is refused", async () => {
		const eveSecret = eve.session.exposeIdentityForPairing().secretKey;
		await eve.engine.mutateAndEmit(CHANNEL, (doc) => {
			revokeAccess(doc, {
				entityId: CHANNEL,
				member: alice.pub,
				signerSecret: eveSecret,
				now: Date.now(),
			});
			revokeAccess(doc, {
				entityId: CHANNEL,
				member: eve.pub,
				signerSecret: eveSecret,
				now: Date.now(),
			});
			grantAccess(doc, {
				entityId: CHANNEL,
				member: eve.pub,
				role: AccessRole.Owner,
				signerSecret: eveSecret,
				now: Date.now() + 1,
				x25519: eve.session.deviceX25519.publicKeyBase64,
				trust: { root: null },
			});
		});
		await alice.drain();
		const view = await alice.engine.access(CHANNEL);
		expect(view.find((m) => m.member === alice.pub)).toMatchObject({
			role: AccessRole.Owner,
			active: true,
		});
		// She did leave (that much is hers to do); she did not come back as Owner.
		expect(view.find((m) => m.member === eve.pub)?.active).toBe(false);
		expect(await alice.active(CHANNEL)).toEqual([alice.pub]);

		// The rotation her "ownership" was for: a DEK of her choosing, sealed to
		// Alice's wrapping key at a bumped ordinal, dropped on Alice's inbox.
		const before = alice.dekVersion(CHANNEL);
		const hostile = generateSymmetricKey();
		const wrap = wrapDekForRecipient(
			hostile,
			base64ToBytes(alice.session.deviceX25519.publicKeyBase64),
			CHANNEL,
			CHANNEL_TYPE,
			before + 1,
		);
		await emitWrapBootstrap(CHANNEL, wrap, eve.ctx(), inboxChannelFor(alice.pub));
		await alice.drain();
		expect(alice.refused).toContain(`wrap:${CHANNEL}`);
		expect(alice.dekVersion(CHANNEL)).toBe(before);
	});

	it("Eve deletes the whole access record: nothing changes for Alice, and Alice's next change writes it back", async () => {
		await eve.engine.mutateAndEmit(CHANNEL, (doc) => {
			const access = getAccessArray(doc);
			access.delete(0, access.length);
		});
		await alice.drain();
		expect(await alice.read(CHANNEL, (doc) => getAccessArray(doc).length)).toBe(0);
		expect(await alice.active(CHANNEL)).toEqual([alice.pub, eve.pub].sort());
		expect(await alice.authz.isShared(CHANNEL)).toBe(true);
		expect(await alice.engine.shareTrace(CHANNEL)).toBe(true);

		// Alice can still remove her, and the rotation's survivor set is Alice alone.
		expect(await alice.engine.revoke(CHANNEL, eve.pub)).toBe(true);
		expect(await alice.active(CHANNEL)).toEqual([alice.pub]);
		expect(await alice.read(CHANNEL, (doc) => getAccessArray(doc).length)).toBeGreaterThan(0);
		const eveKey = eve.session.deviceX25519.publicKeyBase64;
		const version = alice.dekVersion(CHANNEL);
		expect(
			await alice.read(CHANNEL, (doc) =>
				listWraps(doc).some(
					(wrap) => wrap.recipientPubB64 === eveKey && wrapDekVersionOf(wrap) === version,
				),
			),
		).toBe(false);
	});

	it("after Alice removes Eve, Eve's un-revoke (blank the revoke, re-append the grant) is refused at the writer gate", async () => {
		// The revoke alone, with the DEK rotation still pending (an offline revoke
		// defers it): the window in which Eve's frames still DECRYPT, so the
		// record is the only thing standing between her and the doc.
		const aliceSecret = alice.session.exposeIdentityForPairing().secretKey;
		const aliceTrust = await alice.session.accessTrust();
		await alice.engine.mutateAndEmit(CHANNEL, (doc) => {
			revokeAccess(doc, {
				entityId: CHANNEL,
				member: eve.pub,
				signerSecret: aliceSecret,
				now: Date.now(),
				trust: aliceTrust.trustFor(doc, CHANNEL),
			});
		});
		await eve.drain();
		// Eve acts on the copy she still has, under the DEK she still has.
		await eve.engine.mutateAndEmit(CHANNEL, (doc) => {
			for (const entry of getAccessArray(doc).toArray()) {
				if (entry.get("member") !== eve.pub) continue;
				entry.set("revokedAt", null);
				entry.set("revokedBy", null);
				entry.set("revokeSig", null);
			}
			doc.getText(BODY).insert(0, "still here ");
		});
		await alice.drain();
		expect(alice.unauthorized()).toHaveLength(1);
		expect(await alice.text(CHANNEL)).toBe("");
		expect(await alice.active(CHANNEL)).toEqual([alice.pub]);
	});

	it("a member who is not an owner cannot share or remove anyone through the engine", async () => {
		const invite = await sam.engine.createInvite("Sam");
		await expect(
			eve.engine.share({ entityId: CHANNEL, type: CHANNEL_TYPE, invite, role: AccessRole.Viewer }),
		).rejects.toBeInstanceOf(SharingDeniedError);
		await expect(eve.engine.revoke(CHANNEL, alice.pub)).rejects.toBeInstanceOf(SharingDeniedError);
		// Nothing was written or emitted for either attempt.
		await alice.drain();
		expect(await alice.active(CHANNEL)).toEqual([alice.pub, eve.pub].sort());
	});

	it("a member may leave, and the owner sees it", async () => {
		expect(await eve.engine.revoke(CHANNEL, eve.pub)).toBe(true);
		await alice.drain();
		expect(await alice.active(CHANNEL)).toEqual([alice.pub]);
		expect(await alice.authz.isShared(CHANNEL)).toBe(false);
	});

	it("the owner's grant, role change and revoke still work end to end", async () => {
		const invite = await sam.engine.createInvite("Sam");
		await alice.engine.share({
			entityId: CHANNEL,
			type: CHANNEL_TYPE,
			invite,
			role: AccessRole.Viewer,
		});
		await sam.drain();
		await eve.drain();
		expect(await sam.active(CHANNEL)).toEqual([alice.pub, eve.pub, sam.pub].sort());
		expect(await eve.active(CHANNEL)).toEqual([alice.pub, eve.pub, sam.pub].sort());

		// A Viewer's write is refused (F-288), as before.
		await sam.engine.mutateAndEmit(CHANNEL, (doc) => doc.getText(BODY).insert(0, "viewer "));
		await alice.drain();
		expect(alice.unauthorized()).toHaveLength(1);

		expect(await alice.engine.revoke(CHANNEL, sam.pub)).toBe(true);
		await eve.drain();
		expect(await eve.active(CHANNEL)).toEqual([alice.pub, eve.pub].sort());
		// Eve, a survivor, installed the rotated DEK from the Owner.
		expect(eve.refused.filter((m) => m.startsWith("wrap:"))).toEqual([]);
		expect(eve.dekVersion(CHANNEL)).toBe(alice.dekVersion(CHANNEL));
	});
});
