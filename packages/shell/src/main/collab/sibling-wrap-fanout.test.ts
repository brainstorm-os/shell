/**
 * Stage 10.3c — the ONGOING producer, over a real relay.
 *
 * `wrap-fanout.test.ts` pins the rules in isolation. This pins the thing that
 * was actually missing: that a real `SharingEngine`, given a real rostered
 * sibling device, actually puts a wrap on the wire. 10.3b's failure was never
 * a wrong rule — it was a producer nobody wrote, so the receive half sat there
 * complete and two of one user's own devices never synced a single entity.
 * A test that only exercised the pure module would have passed against that.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bytesToBase64 } from "../credentials/crypto";
import { EntitiesRepository } from "../storage/entities-repo";
import { LoopbackRelayPort, type RelayPort } from "../sync/relay-port";
import { VaultSession } from "../vault/session";
import { VaultPropertiesStore } from "../vault/vault-properties-store";
import { type CollabRelayLike, SharingEngine } from "./sharing-engine";

function relayAdapter(port: LoopbackRelayPort): CollabRelayLike {
	return {
		currentPort: (): RelayPort => port,
		onFrame: (cb) => port.onFrame(cb),
		offFrame: (cb) => port.offFrame(cb),
	};
}

describe("SharingEngine.fanOutEntityWrapToSiblings", () => {
	let dirOwner = "";
	let dirSibling = "";
	let owner: VaultSession;
	let sibling: VaultSession;
	let ports: LoopbackRelayPort[];
	let engine: SharingEngine;

	beforeEach(async () => {
		dirOwner = await mkdtemp(join(tmpdir(), "bs-fanout-owner-"));
		dirSibling = await mkdtemp(join(tmpdir(), "bs-fanout-sib-"));
		owner = await VaultSession.create({
			vaultId: "vlt_owner",
			vaultPath: dirOwner,
			forceInsecure: true,
		});
		// Stands in for the SAME user's second device: we only need a real
		// X25519 keypair to be a legitimate HPKE recipient.
		sibling = await VaultSession.create({
			vaultId: "vlt_sibling",
			vaultPath: dirSibling,
			forceInsecure: true,
		});
		ports = LoopbackRelayPort.pair(2);
		const p0 = ports[0];
		if (!p0) throw new Error("expected a loopback port");
		engine = new SharingEngine(owner, () => relayAdapter(p0));
	});

	afterEach(async () => {
		for (const p of ports) p.close();
		owner.dispose();
		sibling.dispose();
		await rm(dirOwner, { recursive: true, force: true });
		await rm(dirSibling, { recursive: true, force: true });
	});

	async function rosterSibling(x25519PubB64: string): Promise<void> {
		const props = await VaultPropertiesStore.open(owner.ydocStore);
		props.devices().add({
			deviceEd25519Pub: "sibling-ed25519-pub",
			deviceX25519Pub: x25519PubB64,
			deviceLabel: "Second device",
			addedAt: Date.now(),
			addedBy: owner.identity.publicKeyBase64,
			sig: "test-signature",
		});
		// The store persists through an observer, and the engine re-opens the
		// doc from disk rather than sharing this instance — let the write land.
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	/** A real entity row plus its DEK — the DEK table is FK-bound to the row,
	 *  so the entity has to exist first. */
	async function seedEntityDek(entityId: string): Promise<void> {
		const db = await owner.dataStores.open("entities");
		new EntitiesRepository(db).create({
			id: entityId,
			type: "brainstorm/Note/v1",
			properties: {},
			createdBy: "brainstorm",
			now: Date.now(),
			dekId: null,
		});
		const dekStore = await owner.entityDekStore();
		const handle = dekStore.persist(entityId, dekStore.nextDekId());
		dekStore.close(handle.dek);
	}

	it("puts a wrap on the wire for a rostered sibling device", async () => {
		await rosterSibling(bytesToBase64(sibling.deviceX25519.publicKey));
		await seedEntityDek("ent_1");

		const dekStore = await owner.entityDekStore();
		const handle = dekStore.open("ent_1");
		if (!handle) throw new Error("expected a DEK");
		const result = await engine.fanOutEntityWrapToSiblings(
			"ent_1",
			handle.dek,
			handle.version,
			"brainstorm/Note/v1",
		);
		dekStore.close(handle.dek);

		expect(result).not.toBeNull();
		expect(result?.sent).toBe(1);
		expect(result?.failed).toEqual([]);
	});

	it("is a no-op for a single-device identity — never wraps to itself", async () => {
		await seedEntityDek("ent_2");
		const dekStore = await owner.entityDekStore();
		const handle = dekStore.open("ent_2");
		if (!handle) throw new Error("expected a DEK");
		const result = await engine.fanOutEntityWrapToSiblings("ent_2", handle.dek, handle.version);
		dekStore.close(handle.dek);

		expect(result?.sent).toBe(0);
	});

	it("refuses a placeholder ordinal rather than shipping version 0", async () => {
		await rosterSibling(bytesToBase64(sibling.deviceX25519.publicKey));
		await seedEntityDek("ent_3");
		const dekStore = await owner.entityDekStore();
		const handle = dekStore.open("ent_3");
		if (!handle) throw new Error("expected a DEK");
		// The retro-wrap pass hands `installEntityWrap` exactly this shape.
		const result = await engine.fanOutEntityWrapToSiblings("ent_3", handle.dek, 0);
		dekStore.close(handle.dek);

		expect(result?.refused).toBe("placeholder-dek");
		expect(result?.sent).toBe(0);
	});

	it("resolves the roster once and reuses it — a caller-supplied roster is honoured", async () => {
		await rosterSibling(bytesToBase64(sibling.deviceX25519.publicKey));
		const roster = await engine.resolveSiblingRoster();
		expect(roster.length).toBeGreaterThan(0);

		// The backfill's contract: N entities, ONE roster resolution. Passing the
		// pre-resolved list must produce the same wire result as reading it per
		// entity — that equivalence is what makes hoisting it safe.
		for (const id of ["ent_4", "ent_5", "ent_6"]) {
			await seedEntityDek(id);
			const dekStore = await owner.entityDekStore();
			const handle = dekStore.open(id);
			if (!handle) throw new Error("expected a DEK");
			const result = await engine.fanOutEntityWrapToSiblings(
				id,
				handle.dek,
				handle.version,
				"brainstorm/Note/v1",
				roster,
			);
			dekStore.close(handle.dek);
			expect(result?.sent).toBe(1);
			expect(result?.failed).toEqual([]);
		}
	});

	it("an empty caller-supplied roster wraps for nobody — the list is authoritative", async () => {
		// Guards the hoist against the failure mode that would matter: a stale or
		// empty pre-resolved roster must not silently fall back to a fresh read,
		// or the caching would be untestable and its cost unbounded.
		await rosterSibling(bytesToBase64(sibling.deviceX25519.publicKey));
		await seedEntityDek("ent_7");
		const dekStore = await owner.entityDekStore();
		const handle = dekStore.open("ent_7");
		if (!handle) throw new Error("expected a DEK");
		const result = await engine.fanOutEntityWrapToSiblings(
			"ent_7",
			handle.dek,
			handle.version,
			"brainstorm/Note/v1",
			[],
		);
		dekStore.close(handle.dek);

		expect(result?.sent).toBe(0);
	});
});
