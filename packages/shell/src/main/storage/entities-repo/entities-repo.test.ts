import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataStores } from "../data-stores";
import { EntitiesRepository } from "./entities-repo";

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-entities-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("entities");
	return { vaultDir, stores, repo: new EntitiesRepository(db), db };
}

describe("EntitiesRepository", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	const seed = (over: Partial<Parameters<EntitiesRepository["create"]>[0]> = {}) =>
		env.repo.create({
			id: "ent_1",
			type: "io.x/Note/v1",
			properties: { title: "Hello", count: 3, tags: ["a", "b"] },
			createdBy: "io.x",
			now: 1000,
			dekId: null,
			...over,
		});

	it("create + get round-trips and excludes soft-deleted", () => {
		seed();
		expect(env.repo.get("ent_1")).toMatchObject({
			id: "ent_1",
			type: "io.x/Note/v1",
			properties: { title: "Hello", count: 3 },
			createdBy: "io.x",
		});
		env.repo.softDelete("ent_1", 2000);
		expect(env.repo.get("ent_1")).toBeNull();
	});

	it("create stamps dekId on the row (Stage 10.1; not surfaced via EntityRow)", () => {
		seed({ id: "with_dek", dekId: "dek_abc" });
		seed({ id: "no_dek", dekId: null });
		const row = env.db
			.prepare("SELECT id, dek_id FROM entities WHERE id IN ('with_dek', 'no_dek') ORDER BY id")
			.all() as Array<{ id: string; dek_id: string | null }>;
		expect(row).toEqual([
			{ id: "no_dek", dek_id: null },
			{ id: "with_dek", dek_id: "dek_abc" },
		]);
	});

	it("update shallow-merges properties and bumps updated_at + change version", () => {
		seed();
		const updated = env.repo.update("ent_1", { title: "Bye", extra: 1 }, 1500);
		expect(updated).toMatchObject({
			properties: { title: "Bye", count: 3, extra: 1 },
			updatedAt: 1500,
		});
		expect(env.repo.update("missing", { x: 1 }, 1600)).toBeNull();
		const changes = env.db
			.prepare("SELECT change_kind, change_version FROM change_log WHERE entity_id = ? ORDER BY seq")
			.all("ent_1") as Array<{ change_kind: string; change_version: number }>;
		expect(changes.map((c) => c.change_kind)).toEqual(["create", "update"]);
		expect(changes[1]?.change_version).toBe(2);
	});

	it("linksFromMany batches outgoing-link reads, filters soft-deleted, ignores empty input", () => {
		seed({ id: "a", properties: {} });
		seed({ id: "b", properties: {} });
		seed({ id: "c", properties: {} });
		env.repo.putLink({
			id: "ab",
			sourceEntityId: "a",
			destEntityId: "b",
			linkType: "rel",
			createdAt: 1,
		});
		env.repo.putLink({
			id: "ac",
			sourceEntityId: "a",
			destEntityId: "c",
			linkType: "rel",
			createdAt: 2,
		});
		env.repo.putLink({
			id: "bc",
			sourceEntityId: "b",
			destEntityId: "c",
			linkType: "rel",
			createdAt: 3,
		});
		env.repo.deleteLink("ac", 5);
		expect(env.repo.linksFromMany([])).toEqual([]);
		const all = env.repo.linksFromMany(["a", "b", "missing"]);
		expect(all.map((l) => l.id).sort()).toEqual(["ab", "bc"]);
		expect(env.repo.linksFromMany(["a"]).map((l) => l.id)).toEqual(
			env.repo.linksFrom("a").map((l) => l.id),
		);
	});

	it("listIdsWithPropertyIn batches value lookups, filters soft-deleted, ignores empty input", () => {
		seed({ id: "a", properties: { ext: "k1" } });
		seed({ id: "b", properties: { ext: "k2" } });
		seed({ id: "c", properties: { ext: "k3" } });
		seed({ id: "d", properties: { other: "k1" } });
		env.repo.softDelete("c", 2000);
		expect(env.repo.listIdsWithPropertyIn("ext", [])).toEqual([]);
		// Over-chunk-size input (chunk = 500) exercises the padded second chunk.
		const values = ["k1", ...Array.from({ length: 502 }, (_, i) => `miss-${i}`), "k2", "k3"];
		const pairs = env.repo
			.listIdsWithPropertyIn("ext", values)
			.sort((x, y) => x.id.localeCompare(y.id));
		expect(pairs).toEqual([
			{ id: "a", value: "k1" },
			{ id: "b", value: "k2" },
		]);
		// Agrees with the single-value form.
		expect(env.repo.listIdsWithProperty("ext", "k1")).toEqual(["a"]);
	});

	it("softDelete cascades to incident links and is idempotent", () => {
		seed();
		seed({ id: "ent_2", properties: {} });
		env.repo.putLink({
			id: "lnk_1",
			sourceEntityId: "ent_1",
			destEntityId: "ent_2",
			linkType: "rel",
			createdAt: 1000,
		});
		expect(env.repo.linksFrom("ent_1")).toHaveLength(1);
		expect(env.repo.softDelete("ent_1", 2000)).toBe(true);
		expect(env.repo.linksFrom("ent_1")).toHaveLength(0);
		expect(env.repo.softDelete("ent_1", 2100)).toBe(false);
	});

	it("query filters by type, spaceId, text, orderBy, limit", () => {
		seed({ id: "a", properties: { title: "alpha" }, now: 10 });
		seed({ id: "b", properties: { title: "beta" }, now: 30 });
		seed({ id: "c", type: "io.x/Task/v1", properties: { title: "gamma" }, now: 20 });

		expect(
			env.repo
				.query({ type: "io.x/Note/v1" })
				.map((e) => e.id)
				.sort(),
		).toEqual(["a", "b"]);
		expect(env.repo.query({ type: ["io.x/Note/v1", "io.x/Task/v1"] })).toHaveLength(3);
		expect(env.repo.query({ text: "GAMMA" }).map((e) => e.id)).toEqual(["c"]);
		expect(
			env.repo.query({ orderBy: [{ property: "updatedAt", direction: "asc" }] }).map((e) => e.id),
		).toEqual(["a", "c", "b"]);
		expect(env.repo.query({ limit: 1 })).toHaveLength(1);
		expect(env.repo.query({ type: [] })).toEqual([]);
	});

	it("query compiles property predicates", () => {
		seed({ id: "a", properties: { n: 5, s: "hello", flag: true } });
		seed({ id: "b", properties: { n: 50, s: "world" } });
		const ids = (q: Parameters<EntitiesRepository["query"]>[0]) =>
			env.repo
				.query(q)
				.map((e) => e.id)
				.sort();

		expect(ids({ where: { $eq: { n: 5 } } })).toEqual(["a"]);
		expect(ids({ where: { $contains: { s: "ELL" } } })).toEqual(["a"]);
		expect(ids({ where: { $gt: { n: 10 } } })).toEqual(["b"]);
		expect(ids({ where: { $lt: { n: 10 } } })).toEqual(["a"]);
		expect(ids({ where: { $exists: { flag: true } } })).toEqual(["a"]);
		expect(ids({ where: { $or: [{ $eq: { n: 5 } }, { $eq: { n: 50 } }] } })).toEqual(["a", "b"]);
		expect(ids({ where: { $and: [{ $gt: { n: 1 } }, { $lt: { n: 10 } }] } })).toEqual(["a"]);
	});

	it("query compiles comparison refs ($now / $prop) (9.12.21)", () => {
		const now = Date.now();
		const DAY = 86_400_000;
		seed({ id: "overdue", properties: { due: { at: now - DAY }, assignee: "u1", owner: "u1" } });
		seed({ id: "future", properties: { due: { at: now + DAY }, assignee: "u2", owner: "u9" } });
		const ids = (q: Parameters<EntitiesRepository["query"]>[0]) =>
			env.repo
				.query(q)
				.map((e) => e.id)
				.sort();

		// due < now() — only the past-dated row.
		expect(ids({ where: { $lt: { due: { $now: true } } } })).toEqual(["overdue"]);
		// assignee = owner — only the row where the two properties match.
		expect(ids({ where: { $eq: { assignee: { $prop: "owner" } } } })).toEqual(["overdue"]);
	});

	it("query filters by a link predicate (EXISTS over live links)", () => {
		seed({ id: "src", properties: {} });
		seed({ id: "dst", properties: {} });
		env.repo.putLink({
			id: "l1",
			sourceEntityId: "src",
			destEntityId: "dst",
			linkType: "mentions",
			createdAt: 1,
		});
		expect(env.repo.query({ link: { type: "mentions" } }).map((e) => e.id)).toEqual(["src"]);
		expect(env.repo.query({ link: { dest: "dst" } }).map((e) => e.id)).toEqual(["src"]);
		expect(env.repo.query({ link: { type: "nope" } })).toEqual([]);
	});

	it("rejects an unsafe property key in a predicate / orderBy", () => {
		seed();
		expect(() => env.repo.query({ where: { $eq: { "a'; DROP": 1 } } })).toThrow(
			/invalid property key/,
		);
		expect(() => env.repo.query({ orderBy: [{ property: "a b", direction: "asc" }] })).toThrow(
			/invalid property key/,
		);
	});

	it("tolerates a corrupt properties blob", () => {
		seed();
		env.db.prepare("UPDATE entities SET properties = ? WHERE id = ?").run("{not json", "ent_1");
		expect(env.repo.get("ent_1")?.properties).toEqual({});
	});

	it("listDeleted returns soft-deleted rows most-recent-first with deletedAt", () => {
		seed({ id: "a" });
		seed({ id: "b" });
		expect(env.repo.listDeleted()).toEqual([]);
		env.repo.softDelete("a", 2000);
		env.repo.softDelete("b", 3000);
		const deleted = env.repo.listDeleted();
		expect(deleted.map((e) => e.id)).toEqual(["b", "a"]);
		expect(deleted[0]).toMatchObject({ id: "b", deletedAt: 3000 });
		expect(env.repo.get("a")).toBeNull();
	});

	it("restore brings an entity back and is idempotent + change-logged", () => {
		seed({ id: "a" });
		expect(env.repo.restore("a", 1500)).toBe(false); // live → no-op
		env.repo.softDelete("a", 2000);
		expect(env.repo.restore("a", 2500)).toBe(true);
		expect(env.repo.get("a")).toMatchObject({ id: "a" });
		expect(env.repo.listDeleted()).toEqual([]);
		expect(env.repo.restore("a", 2600)).toBe(false); // already live
		expect(env.repo.restore("missing", 2700)).toBe(false);
		const kinds = env.db
			.prepare("SELECT change_kind FROM change_log WHERE entity_id = ? ORDER BY seq")
			.all("a") as Array<{ change_kind: string }>;
		expect(kinds.map((k) => k.change_kind)).toEqual(["create", "delete", "update"]);
	});

	it("restore only re-links incident links whose other endpoint is also live", () => {
		seed({ id: "a", properties: {} });
		seed({ id: "b", properties: {} });
		seed({ id: "c", properties: {} });
		env.repo.putLink({
			id: "ab",
			sourceEntityId: "a",
			destEntityId: "b",
			linkType: "rel",
			createdAt: 1,
		});
		env.repo.putLink({
			id: "ac",
			sourceEntityId: "a",
			destEntityId: "c",
			linkType: "rel",
			createdAt: 1,
		});
		env.repo.softDelete("a", 2000); // soft-deletes a, ab, ac
		env.repo.softDelete("c", 2100); // c stays deleted across a's restore
		expect(env.repo.restore("a", 3000)).toBe(true);
		// a↔b restored (both live); a↔c stays deleted (c still in the bin).
		expect(env.repo.linksFrom("a").map((l) => l.id)).toEqual(["ab"]);
	});

	it("hardDelete purges only soft-deleted entities, with links + change log", () => {
		seed({ id: "a", properties: {} });
		seed({ id: "b", properties: {} });
		env.repo.putLink({
			id: "ab",
			sourceEntityId: "a",
			destEntityId: "b",
			linkType: "rel",
			createdAt: 1,
		});
		expect(env.repo.hardDelete("a")).toBe(false); // live → refused
		expect(env.repo.get("a")).toMatchObject({ id: "a" });
		env.repo.softDelete("a", 2000);
		expect(env.repo.hardDelete("a")).toBe(true);
		expect(env.repo.listDeleted()).toEqual([]);
		expect(env.repo.get("a")).toBeNull();
		expect(
			env.db.prepare("SELECT COUNT(*) AS c FROM links WHERE id = 'ab'").get() as { c: number },
		).toEqual({ c: 0 });
		expect(
			env.db.prepare("SELECT COUNT(*) AS c FROM change_log WHERE entity_id = 'a'").get() as {
				c: number;
			},
		).toEqual({ c: 0 });
		expect(env.repo.hardDelete("a")).toBe(false); // idempotent
	});

	it("listAssetOwners maps each live assetId to its owning entity, skipping soft-deleted", () => {
		seed({ id: "file_1", type: "brainstorm/File/v1", properties: { assetId: "asset_1" } });
		seed({ id: "file_2", type: "brainstorm/File/v1", properties: { assetId: "asset_2" } });
		seed({ id: "note", properties: { title: "no asset" } });
		env.repo.softDelete("file_2", 3000);

		expect(env.repo.listAssetOwners()).toEqual([
			{ assetId: "asset_1", id: "file_1", type: "brainstorm/File/v1" },
		]);
	});
});
