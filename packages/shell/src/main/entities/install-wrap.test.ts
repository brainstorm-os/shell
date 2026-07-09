/**
 * ROT-3a-i — `installEntityDek` is version-monotonic: it accepts a
 * STRICTLY-NEWER DEK rotation ordinal and no-ops on an equal-or-older one.
 *
 * This is the receive-side half of rotate-on-revoke's forward secrecy. The
 * pre-ROT-3a-i guard ("a DEK already exists ⇒ no-op") silently dropped a
 * rotated DEK (a live survivor stayed on the old key — F-ROT-1) and, paired
 * with receive-time row ordering, allowed a replayed old wrap to win (F-ROT-3).
 * Both are pinned here directly on the store.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EntitiesRepository } from "../storage/entities-repo";
import { VaultSession } from "../vault/session";
import type { EntityDekStore } from "./entity-dek-store";
import { installEntityDek } from "./install-wrap";

const ENT = "ent_rotdek";
const TYPE = "io.brainstorm.notes/Note/v1";

function dek(fill: number): Uint8Array {
	return new Uint8Array(32).fill(fill);
}

describe("installEntityDek — version-monotonic install (ROT-3a-i)", () => {
	let dir = "";
	let session: VaultSession;
	let store: EntityDekStore;
	let repo: EntitiesRepository;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bs-installdek-"));
		session = await VaultSession.create({ vaultId: "v", vaultPath: dir, forceInsecure: true });
		store = await session.entityDekStore();
		repo = new EntitiesRepository(await session.dataStores.open("entities"));
		repo.create({
			id: ENT,
			type: TYPE,
			properties: { name: "e" },
			createdBy: session.identity.publicKeyBase64,
			now: Date.now(),
			dekId: store.nextDekId(),
		});
	});

	afterEach(async () => {
		session.dispose();
		await rm(dir, { recursive: true, force: true });
	});

	function currentDek(): Uint8Array {
		const h = store.open(ENT);
		if (!h) throw new Error("no dek");
		const copy = new Uint8Array(h.dek);
		store.close(h.dek);
		return copy;
	}

	function currentVersion(): number {
		const h = store.open(ENT);
		if (!h) throw new Error("no dek");
		store.close(h.dek);
		return h.version;
	}

	it("installs the first DEK, then UPGRADES to a strictly-newer ordinal (the rotation case)", () => {
		expect(installEntityDek(ENT, dek(1), 1, store, repo)).toBe(true);
		expect(currentDek()[0]).toBe(1);
		expect(currentVersion()).toBe(1);

		// Rotation delivers DEK′ at ordinal 2 — must replace the current DEK.
		expect(installEntityDek(ENT, dek(2), 2, store, repo)).toBe(true);
		expect(currentDek()[0]).toBe(2);
		expect(currentVersion()).toBe(2);
	});

	it("no-ops on a re-delivered SAME ordinal (idempotent)", () => {
		installEntityDek(ENT, dek(1), 1, store, repo);
		expect(installEntityDek(ENT, dek(1), 1, store, repo)).toBe(false);
		expect(currentDek()[0]).toBe(1);
	});

	it("REJECTS an older ordinal — a replayed pre-rotation wrap can't roll the DEK back (F-ROT-3)", () => {
		installEntityDek(ENT, dek(1), 1, store, repo);
		installEntityDek(ENT, dek(2), 2, store, repo);
		// The attacker replays the ordinal-1 wrap (old DEK) AFTER the rotation.
		expect(installEntityDek(ENT, dek(1), 1, store, repo)).toBe(false);
		// Still on DEK′ — no rollback.
		expect(currentDek()[0]).toBe(2);
		expect(currentVersion()).toBe(2);
	});

	it("survives multiple rotations, always tracking the highest ordinal", () => {
		installEntityDek(ENT, dek(1), 1, store, repo);
		installEntityDek(ENT, dek(3), 3, store, repo);
		installEntityDek(ENT, dek(2), 2, store, repo); // out-of-order/replayed → rejected
		expect(currentDek()[0]).toBe(3);
		expect(currentVersion()).toBe(3);
	});
});
