/**
 * ROT-3a — rotate-on-revoke wired into `SharingEngine.revoke` (design 73).
 *
 * The pure sequencing (ROT-2) and the survivor re-wrap (ROT-1) are unit-tested
 * on their own. This drives the REAL wiring over a persisted `YDocStore` + real
 * `EntityDekStore`: an owner shares an entity with two guests, then revokes one,
 * and we assert the *content* forward-secrecy guarantee cryptographically —
 *
 *   1. the entity DEK actually rotated on the store (a new most-recent row);
 *   2. a SURVIVOR (the remaining guest) can unwrap the NEW DEK from a wrap the
 *      rotation appended to the doc — so they keep reading;
 *   3. the REVOKED guest has NO wrap of the new DEK anywhere in the doc — the
 *      best key their device can recover is the old, now-superseded DEK.
 *
 * The first test pins the OWNER-SIDE invariant (the DEK′ wrap exists + decrypts
 * for a survivor, never for the revoked member). The second drives the REAL
 * survivor RECEIVE path end-to-end — install the initial wrap on guest B's own
 * vault, rotate, install the DEK′ wrap — and proves the survivor UPGRADES to
 * DEK′ (not locked out, F-ROT-1) while a replayed pre-rotation wrap is rejected
 * (no rollback, F-ROT-3). Both close the ROT-4 findings via `ROT-3a-i`
 * (versioned/monotonic DEK install). See docs/_review/2026-07-09-rot-3a-security-review.md.
 *
 * The 10.11 token re-home (metadata forward secrecy) is dormant in production
 * (design 73 §dormancy); the residual metadata gap is ROT-3b.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemberWrapPayload, listWraps, wrapDekVersionOf } from "../credentials/member-wraps";
import { installEntityDek } from "../entities/install-wrap";
import { EntitiesRepository } from "../storage/entities-repo";
import { LoopbackRelayPort, type RelayPort } from "../sync/relay-port";
import { VaultSession } from "../vault/session";
import { AccessRole, resolveCurrentMembers } from "./access-record";
import { type CollabRelayLike, SharingEngine } from "./sharing-engine";

const ENTITY = "ent_secret_doc";
const ENTITY_TYPE = "io.brainstorm.notes/Note/v1";

function relayAdapter(port: LoopbackRelayPort): CollabRelayLike {
	return {
		currentPort: (): RelayPort => port,
		onFrame: (cb) => port.onFrame(cb),
		offFrame: (cb) => port.offFrame(cb),
	};
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

describe("SharingEngine.revoke — ROT-3a rotates the DEK for forward secrecy", () => {
	let dirOwner = "";
	let dirA = "";
	let dirB = "";
	let owner: VaultSession;
	let guestA: VaultSession;
	let guestB: VaultSession;
	let ports: LoopbackRelayPort[];
	let engine: SharingEngine;

	beforeEach(async () => {
		dirOwner = await mkdtemp(join(tmpdir(), "bs-rot-owner-"));
		dirA = await mkdtemp(join(tmpdir(), "bs-rot-a-"));
		dirB = await mkdtemp(join(tmpdir(), "bs-rot-b-"));
		owner = await VaultSession.create({
			vaultId: "vlt_owner",
			vaultPath: dirOwner,
			forceInsecure: true,
		});
		guestA = await VaultSession.create({ vaultId: "vlt_a", vaultPath: dirA, forceInsecure: true });
		guestB = await VaultSession.create({ vaultId: "vlt_b", vaultPath: dirB, forceInsecure: true });
		ports = LoopbackRelayPort.pair(2);
		const p0 = ports[0];
		if (!p0) throw new Error("expected a loopback port");
		engine = new SharingEngine(owner, () => relayAdapter(p0));
	});

	afterEach(async () => {
		for (const p of ports) p.close();
		owner.dispose();
		guestA.dispose();
		guestB.dispose();
		await rm(dirOwner, { recursive: true, force: true });
		await rm(dirA, { recursive: true, force: true });
		await rm(dirB, { recursive: true, force: true });
	});

	/** The current DEK bytes the store resolves for the entity (a copy). */
	async function currentDek(entityId: string): Promise<Uint8Array> {
		const store = await engine.ensureDekStore();
		const handle = store.open(entityId);
		if (!handle) throw new Error("no DEK for entity");
		const copy = new Uint8Array(handle.dek);
		store.close(handle.dek);
		return copy;
	}

	/** Does the doc carry a wrap that `session` can unwrap to exactly `dek`? */
	async function docHasWrapYielding(
		entityId: string,
		session: VaultSession,
		dek: Uint8Array,
	): Promise<boolean> {
		const { doc } = await owner.ydocStore.load(entityId);
		try {
			const target = session.deviceX25519.publicKeyBase64;
			for (const wrap of listWraps(doc)) {
				if (wrap.recipientPubB64 !== target) continue;
				let unwrapped: Uint8Array;
				try {
					unwrapped = session.unwrapMemberWrap(wrap, entityId);
				} catch {
					continue;
				}
				try {
					if (bytesEqual(unwrapped, dek)) return true;
				} finally {
					unwrapped.fill(0);
				}
			}
			return false;
		} finally {
			doc.destroy();
		}
	}

	/** A guest-side invite (created through the guest's own engine, as the real
	 *  invite flow does — the secret never leaves that session). */
	function inviteFrom(guest: VaultSession, label: string) {
		return new SharingEngine(guest, () => null).createInvite(label);
	}

	it("mints a new DEK, re-wraps it for the survivor, and never for the revoked member", async () => {
		await engine.provisionEntity(ENTITY, ENTITY_TYPE, { name: "secret" });
		await engine.share({
			entityId: ENTITY,
			type: ENTITY_TYPE,
			invite: inviteFrom(guestA, "A"),
			role: AccessRole.Editor,
		});
		await engine.share({
			entityId: ENTITY,
			type: ENTITY_TYPE,
			invite: inviteFrom(guestB, "B"),
			role: AccessRole.Editor,
		});

		const dekBefore = await currentDek(ENTITY);
		// Before revoke both guests can obtain the SAME (shared) DEK.
		expect(await docHasWrapYielding(ENTITY, guestA, dekBefore)).toBe(true);
		expect(await docHasWrapYielding(ENTITY, guestB, dekBefore)).toBe(true);

		const revoked = await engine.revoke(ENTITY, guestA.identity.publicKeyBase64);
		expect(revoked).toBe(true);

		// 1. The DEK rotated on the store.
		const dekAfter = await currentDek(ENTITY);
		expect(bytesEqual(dekAfter, dekBefore)).toBe(false);

		// 2. The surviving guest (B) can unwrap the NEW DEK from the doc.
		expect(await docHasWrapYielding(ENTITY, guestB, dekAfter)).toBe(true);

		// 3. The revoked guest (A) has NO wrap of the new DEK — content FS.
		expect(await docHasWrapYielding(ENTITY, guestA, dekAfter)).toBe(false);
		// A's device can at most still recover the OLD, superseded DEK.
		expect(await docHasWrapYielding(ENTITY, guestA, dekBefore)).toBe(true);

		// The revoked member is no longer an active member of the entity.
		const { doc } = await owner.ydocStore.load(ENTITY);
		try {
			const active = resolveCurrentMembers(doc, ENTITY)
				.filter((m) => m.active)
				.map((m) => m.member);
			expect(active).not.toContain(guestA.identity.publicKeyBase64);
			expect(active).toContain(guestB.identity.publicKeyBase64);
		} finally {
			doc.destroy();
		}

		dekBefore.fill(0);
		dekAfter.fill(0);
	});

	it("END-TO-END: a live survivor's real install path UPGRADES to DEK′ and rejects a replay", async () => {
		await engine.provisionEntity(ENTITY, ENTITY_TYPE, { name: "secret" });
		await engine.share({
			entityId: ENTITY,
			type: ENTITY_TYPE,
			invite: inviteFrom(guestA, "A"),
			role: AccessRole.Editor,
		});
		await engine.share({
			entityId: ENTITY,
			type: ENTITY_TYPE,
			invite: inviteFrom(guestB, "B"),
			role: AccessRole.Editor,
		});

		// Guest B's OWN vault: materialize the entity row + its DEK store/repo, as
		// the production receive path does, so we can run B's real install path.
		const bStore = await guestB.entityDekStore();
		const bRepo = new EntitiesRepository(await guestB.dataStores.open("entities"));
		bRepo.create({
			id: ENTITY,
			type: ENTITY_TYPE,
			properties: { name: "secret" },
			createdBy: guestB.identity.publicKeyBase64,
			now: Date.now(),
			dekId: bStore.nextDekId(),
		});

		const bWrapAt = async (version: number): Promise<MemberWrapPayload> => {
			const { doc } = await owner.ydocStore.load(ENTITY);
			try {
				const mine = guestB.deviceX25519.publicKeyBase64;
				const w = listWraps(doc).find(
					(x) => x.recipientPubB64 === mine && wrapDekVersionOf(x) === version,
				);
				if (!w) throw new Error(`no B wrap at version ${version}`);
				return w;
			} finally {
				doc.destroy();
			}
		};
		const bInstall = (wrap: MemberWrapPayload): boolean => {
			const dek = guestB.unwrapMemberWrap(wrap, ENTITY);
			try {
				return installEntityDek(ENTITY, dek, wrapDekVersionOf(wrap), bStore, bRepo);
			} finally {
				dek.fill(0);
			}
		};
		const bCurrentDek = (): Uint8Array => {
			const h = bStore.open(ENTITY);
			if (!h) throw new Error("B has no DEK");
			const copy = new Uint8Array(h.dek);
			bStore.close(h.dek);
			return copy;
		};

		// B installs the initial (v1) wrap → holds the shared DEK.
		const initialWrap = await bWrapAt(1);
		expect(bInstall(initialWrap)).toBe(true);
		const dekV1 = await currentDek(ENTITY);
		expect(bytesEqual(bCurrentDek(), dekV1)).toBe(true);

		// Owner revokes A → rotation mints DEK′ + re-wraps for B.
		expect(await engine.revoke(ENTITY, guestA.identity.publicKeyBase64)).toBe(true);
		const dekV2 = await currentDek(ENTITY);
		expect(bytesEqual(dekV2, dekV1)).toBe(false);

		// B installs the rotation (v2) wrap → UPGRADES to DEK′ (F-ROT-1 closed).
		expect(bInstall(await bWrapAt(2))).toBe(true);
		expect(bytesEqual(bCurrentDek(), dekV2)).toBe(true);

		// A replayed pre-rotation (v1) wrap does NOT roll B back (F-ROT-3 closed).
		expect(bInstall(initialWrap)).toBe(false);
		expect(bytesEqual(bCurrentDek(), dekV2)).toBe(true);

		dekV1.fill(0);
		dekV2.fill(0);
	});

	it("is a no-op rotation when there is no active relay (deferred), but still records the revoke", async () => {
		const offlineEngine = new SharingEngine(owner, () => null);
		await offlineEngine.provisionEntity("ent_offline", ENTITY_TYPE, { name: "offline" });
		await offlineEngine
			.share({
				entityId: "ent_offline",
				type: ENTITY_TYPE,
				invite: inviteFrom(guestA, "A"),
				role: AccessRole.Editor,
			})
			.catch(() => {
				/* share needs a relay; provision alone is enough to seed the DEK row */
			});
		const before = await currentDek("ent_offline");
		const revoked = await offlineEngine.revoke("ent_offline", guestA.identity.publicKeyBase64);
		expect(revoked).toBe(true);
		// No relay → rotation deferred → DEK unchanged.
		const after = await currentDek("ent_offline");
		expect(bytesEqual(after, before)).toBe(true);
		before.fill(0);
		after.fill(0);
	});
});
