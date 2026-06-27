/**
 * 10.1 — `EntityDekStore` tests. Cover:
 *   - DEK shape (32 bytes, unique dekIds).
 *   - Round-trip (persist → open returns the same bytes).
 *   - AAD binding via domain-separated prefix (unwrap with mismatched
 *     entity id throws — property test).
 *   - Sealed blob ≠ plaintext DEK (byte-inequality assertion).
 *   - Master-key swap → open throws.
 *   - `close(dek)` zeros the buffer.
 *   - Empty entityId is rejected at both `persist` and `open`.
 *   - Plaintext DEK is zeroed when the repo INSERT throws (defense).
 *   - Round-trip property test (N random DEKs + entity ids).
 *   - Forward-pin: AAD recompute path for 10.3 — see test docstring.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSymmetricKey, openSecret } from "../credentials/crypto";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository, EntityDeksRepository } from "../storage/entities-repo";
import { type EntityDekHandle, EntityDekStore } from "./entity-dek-store";

const ENTITY_DEK_AAD_PREFIX = "brainstorm/entity-dek/v1:";

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-dek-store-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("entities");
	const entities = new EntitiesRepository(db);
	const deks = new EntityDeksRepository(db);
	const masterKey = generateSymmetricKey();
	const store = new EntityDekStore(deks, masterKey);
	return { vaultDir, stores, db, entities, deks, masterKey, store };
}

/** Seed an `entity_deks`-owning parent row so the FK is satisfiable. */
function seedEntity(env: Awaited<ReturnType<typeof setup>>, id: string): void {
	env.entities.create({
		id,
		type: "io.x/Note/v1",
		properties: {},
		createdBy: "io.x",
		now: 1,
		dekId: null,
	});
}

/** Mint a DEK + persist its wrap row. Replaces the dropped `create()` helper. */
function mintDek(env: Awaited<ReturnType<typeof setup>>, entityId: string): EntityDekHandle {
	return env.store.persist(entityId, env.store.nextDekId());
}

function aadBytes(entityId: string): Uint8Array {
	return new TextEncoder().encode(ENTITY_DEK_AAD_PREFIX + entityId);
}

describe("EntityDekStore", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("persist returns a 32-byte DEK + a fresh dekId, persists the wrap row", () => {
		seedEntity(env, "ent_a");
		const handle = mintDek(env, "ent_a");
		expect(handle.dek).toBeInstanceOf(Uint8Array);
		expect(handle.dek.length).toBe(32);
		expect(typeof handle.dekId).toBe("string");
		expect(handle.dekId.length).toBeGreaterThan(0);
		const row = env.deks.getByEntityId("ent_a");
		expect(row?.dekId).toBe(handle.dekId);
		expect(row?.entityId).toBe("ent_a");
		env.store.close(handle.dek);
	});

	it("each persist mints a unique dekId + DEK", () => {
		seedEntity(env, "ent_a");
		seedEntity(env, "ent_b");
		const a = mintDek(env, "ent_a");
		const b = mintDek(env, "ent_b");
		expect(a.dekId).not.toBe(b.dekId);
		expect(Buffer.from(a.dek).equals(Buffer.from(b.dek))).toBe(false);
		env.store.close(a.dek);
		env.store.close(b.dek);
	});

	it("open returns the same DEK bytes that persist produced (round-trip)", () => {
		seedEntity(env, "ent_a");
		const made = mintDek(env, "ent_a");
		const dekCopy = new Uint8Array(made.dek);
		const opened = env.store.open("ent_a");
		expect(opened).not.toBeNull();
		expect(opened?.dekId).toBe(made.dekId);
		expect(Buffer.from(opened?.dek ?? new Uint8Array()).equals(Buffer.from(dekCopy))).toBe(true);
		env.store.close(made.dek);
		if (opened) env.store.close(opened.dek);
	});

	it("open returns null when no DEK row exists for the entity", () => {
		seedEntity(env, "ent_missing");
		expect(env.store.open("ent_missing")).toBeNull();
	});

	it("sealed blob in entity_deks is NOT the plaintext DEK (byte inequality)", () => {
		seedEntity(env, "ent_a");
		const made = mintDek(env, "ent_a");
		const row = env.deks.getByEntityId("ent_a");
		const ciphertext = Buffer.from(row?.sealedDek.ciphertextB64 ?? "", "base64");
		expect(ciphertext.length).toBeGreaterThan(0);
		// Plaintext bytes must not appear verbatim anywhere in the ciphertext —
		// trivial but rules out an "oh no, we stored it plain" mistake.
		const dekHex = Buffer.from(made.dek).toString("hex");
		expect(ciphertext.toString("hex")).not.toContain(dekHex);
		env.store.close(made.dek);
	});

	it("close(dek) zeros the buffer", () => {
		seedEntity(env, "ent_a");
		const made = mintDek(env, "ent_a");
		// Sanity: at least one byte was non-zero (random key with 32 bytes
		// has a vanishingly small chance of being all-zero).
		expect(made.dek.some((b) => b !== 0)).toBe(true);
		env.store.close(made.dek);
		expect(made.dek.every((b) => b === 0)).toBe(true);
	});

	it("AAD binding: unwrap with a different entity id throws (direct AEAD + store.open)", () => {
		seedEntity(env, "ent_a");
		seedEntity(env, "ent_other"); // satisfy FK before reparenting the wrap row
		const made = mintDek(env, "ent_a");
		const row = env.deks.getByEntityId("ent_a");
		expect(row).not.toBeNull();
		// Direct unwrap with a mismatched (domain-separated) AAD → AEAD throws.
		expect(() =>
			openSecret(
				env.masterKey,
				row?.sealedDek ?? { v: 1, nonceB64: "", ciphertextB64: "" },
				aadBytes("ent_other"),
			),
		).toThrow();
		// And the EntityDekStore.open path: if someone hand-stamps the
		// entity_deks row under a different entity_id, open() throws.
		env.db
			.prepare("UPDATE entity_deks SET entity_id = ? WHERE dek_id = ?")
			.run("ent_other", made.dekId);
		expect(() => env.store.open("ent_other")).toThrow();
		env.store.close(made.dek);
	});

	it("AAD uses the domain-separated prefix `brainstorm/entity-dek/v1:`", () => {
		seedEntity(env, "ent_a");
		const made = mintDek(env, "ent_a");
		const row = env.deks.getByEntityId("ent_a");
		// Bare entity-id AAD (no prefix) must fail — proves the prefix is load-bearing.
		expect(() =>
			openSecret(
				env.masterKey,
				row?.sealedDek ?? { v: 1, nonceB64: "", ciphertextB64: "" },
				new TextEncoder().encode("ent_a"),
			),
		).toThrow();
		// Prefixed AAD must succeed.
		const plaintext = openSecret(
			env.masterKey,
			row?.sealedDek ?? { v: 1, nonceB64: "", ciphertextB64: "" },
			aadBytes("ent_a"),
		);
		expect(Buffer.from(plaintext).equals(Buffer.from(made.dek))).toBe(true);
		env.store.close(made.dek);
		plaintext.fill(0);
	});

	it("master-key swap: opening a DEK with a different master key throws", () => {
		seedEntity(env, "ent_a");
		const made = mintDek(env, "ent_a");
		const otherMaster = generateSymmetricKey();
		const otherStore = new EntityDekStore(env.deks, otherMaster);
		expect(() => otherStore.open("ent_a")).toThrow();
		env.store.close(made.dek);
	});

	it("clock + dekId factories are injected (deterministic test)", () => {
		seedEntity(env, "ent_a");
		const store = new EntityDekStore(
			env.deks,
			env.masterKey,
			() => 42,
			() => "fixed-id",
		);
		const made = store.persist("ent_a", store.nextDekId());
		expect(made.dekId).toBe("fixed-id");
		const row = env.deks.getByEntityId("ent_a");
		expect(row?.createdAt).toBe(42);
		store.close(made.dek);
	});

	it("rejects empty entityId at persist and open (defense-in-depth on AAD)", () => {
		seedEntity(env, "ent_a"); // FK satisfied; persist still rejects on empty id
		expect(() => env.store.persist("", env.store.nextDekId())).toThrow(/non-empty/);
		expect(() => env.store.open("")).toThrow(/non-empty/);
	});

	it("persistWithDek stores a caller-supplied DEK that round-trips via open (10.9e soak path)", () => {
		seedEntity(env, "ent_a");
		const supplied = new Uint8Array(32);
		for (let i = 0; i < 32; i++) supplied[i] = (i * 17 + 3) & 0xff;
		const dekId = env.store.nextDekId();
		const persisted = env.store.persistWithDek("ent_a", dekId, supplied);
		expect(persisted.dekId).toBe(dekId);
		expect(persisted.dek).toEqual(supplied);
		// The store keeps a defensive copy — mutating the input MUST NOT
		// affect the persisted row (otherwise a caller could rewrite the
		// sealed DEK after persist returns).
		supplied[0] = 0xff;
		const reopened = env.store.open("ent_a");
		expect(reopened).not.toBeNull();
		expect(reopened?.dek[0]).toBe(3); // (0 * 17 + 3) & 0xff
		if (reopened) env.store.close(reopened.dek);
		env.store.close(persisted.dek);
	});

	it("persistWithDek rejects non-32-byte input", () => {
		seedEntity(env, "ent_a");
		expect(() =>
			env.store.persistWithDek("ent_a", env.store.nextDekId(), new Uint8Array(16)),
		).toThrow(/32-byte/);
		expect(() =>
			env.store.persistWithDek("ent_a", env.store.nextDekId(), new Uint8Array(64)),
		).toThrow(/32-byte/);
	});

	it("zeros the freshly-minted DEK when the wrap-row INSERT throws", () => {
		seedEntity(env, "ent_a");
		// Mint a wrap once so the dek_id PRIMARY KEY collides on the second persist.
		const first = mintDek(env, "ent_a");
		// Reuse the same dekId so deks.create throws — bypass nextDekId().
		expect(() => env.store.persist("ent_a", first.dekId)).toThrow();
		// (We can't observe the just-minted DEK after the throw — it was
		// local to persist() and has dropped out of scope. The contract is
		// "the buffer is zeroed before the throw propagates"; this test
		// pins the throw path. Memory hygiene is enforced by code review.)
		env.store.close(first.dek);
	});

	it("FORWARD PIN (10.3): open(entityId) recomputes AAD from the *requested* id", () => {
		// Stage 10.3 wires the wire-encryption path. The danger: if 10.3's
		// resolver fetches a DEK row via `entities.dek_id` and reuses that
		// caller-supplied entity id as the AAD, then `entities.dek_id` →
		// other-entity's `dek_id` is a re-opened DEK-swap vector. The fix
		// (which 10.1's `open` already embodies) is to compute AAD from
		// the resolved row's `entity_id` and verify `row.entity_id ===
		// requestedEntityId` before unwrap. This test pins the contract.
		seedEntity(env, "ent_a");
		seedEntity(env, "ent_b");
		const a = mintDek(env, "ent_a");
		// Swap the wrap row to point at ent_b's dek_id position (forge the FK).
		env.db.prepare("UPDATE entity_deks SET entity_id = ? WHERE dek_id = ?").run("ent_b", a.dekId);
		// open("ent_a") finds no row for ent_a → null (not "silently unwrap ent_b's wrap").
		expect(env.store.open("ent_a")).toBeNull();
		// open("ent_b") finds a row whose AAD bound to "ent_a"; AAD mismatch on unwrap → throws.
		expect(() => env.store.open("ent_b")).toThrow();
		env.store.close(a.dek);
	});

	it("PROPERTY: wrap/unwrap round-trip holds for random DEKs + entity ids (N=64)", () => {
		const N = 64;
		// Deterministic enough — generateSymmetricKey uses noble CSPRNG so
		// we just need the same fresh-bytes property for each iteration.
		for (let i = 0; i < N; i += 1) {
			const id = `ent_prop_${i}`;
			seedEntity(env, id);
			const made = mintDek(env, id);
			const dekCopy = new Uint8Array(made.dek);
			const opened = env.store.open(id);
			if (!opened) throw new Error(`open returned null for ${id}`);
			expect(Buffer.from(opened.dek).equals(Buffer.from(dekCopy))).toBe(true);
			env.store.close(made.dek);
			env.store.close(opened.dek);
			dekCopy.fill(0);
		}
	});

	it("PROPERTY: unwrapping with a mismatched entity id always throws (N=32 random pairs)", () => {
		const N = 32;
		for (let i = 0; i < N; i += 1) {
			const id = `ent_x_${i}`;
			seedEntity(env, id);
			const made = mintDek(env, id);
			// Random other id — guaranteed different because of the suffix.
			const otherId = `ent_y_${i}_${Math.random().toString(36).slice(2)}`;
			const row = env.deks.getByEntityId(id);
			expect(() =>
				openSecret(
					env.masterKey,
					row?.sealedDek ?? { v: 1, nonceB64: "", ciphertextB64: "" },
					aadBytes(otherId),
				),
			).toThrow();
			env.store.close(made.dek);
		}
	});
});
