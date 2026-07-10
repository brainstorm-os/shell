/**
 * ROT-3a-ii — `pending_rotations` repo tests. Cover mark/remove/listAll/has,
 * the upsert-on-remark, ordering, and the `ON DELETE CASCADE` from the parent
 * entity (a deleted entity drops its pending mark automatically).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataStores } from "../data-stores";
import { EntitiesRepository } from "./entities-repo";
import { PendingRotationsRepository } from "./pending-rotations-repo";

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-pending-rot-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("entities");
	const entities = new EntitiesRepository(db);
	const pending = new PendingRotationsRepository(db);
	return { vaultDir, stores, db, entities, pending };
}

describe("PendingRotationsRepository", () => {
	let env: Awaited<ReturnType<typeof setup>>;

	const seed = (id: string) =>
		env.entities.create({
			id,
			type: "io.x/Note/v1",
			properties: {},
			createdBy: "io.x",
			now: 1,
			dekId: null,
		});

	beforeEach(async () => {
		env = await setup();
		seed("ent_a");
		seed("ent_b");
	});

	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("mark + has + remove round-trips", () => {
		expect(env.pending.has("ent_a")).toBe(false);
		env.pending.mark("ent_a", 2, 1000);
		expect(env.pending.has("ent_a")).toBe(true);
		expect(env.pending.remove("ent_a")).toBe(1);
		expect(env.pending.has("ent_a")).toBe(false);
		expect(env.pending.remove("ent_a")).toBe(0);
	});

	it("mark upserts (a re-mark overwrites the ordinal, not a second row)", () => {
		env.pending.mark("ent_a", 2, 1000);
		env.pending.mark("ent_a", 5, 2000);
		const rows = env.pending.listAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.dekVersion).toBe(5);
		expect(rows[0]?.createdAt).toBe(2000);
	});

	it("listAll returns oldest-first (drain order)", () => {
		env.pending.mark("ent_b", 1, 3000);
		env.pending.mark("ent_a", 1, 1000);
		expect(env.pending.listAll().map((r) => r.entityId)).toEqual(["ent_a", "ent_b"]);
	});

	it("a hard-deleted entity drops its pending mark (explicit cleanup, pragma-independent)", () => {
		env.pending.mark("ent_a", 2, 1000);
		env.entities.softDelete("ent_a", 5000);
		expect(env.entities.hardDelete("ent_a")).toBe(true);
		expect(env.pending.has("ent_a")).toBe(false);
	});
});
