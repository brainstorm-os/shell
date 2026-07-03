import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM, StubEmbedder, type TextEmbedder } from "./embedder";
import type { IndexableEntity } from "./search-indexer";
import { VectorIndexer } from "./vector-indexer";
import { InMemoryVectorStore } from "./vector-store";

function ent(entityId: string, type: string, title: string, body = ""): IndexableEntity {
	return { entityId, type, ownerAppId: "io.brainstorm.notes", title, body };
}

function make(): VectorIndexer {
	return new VectorIndexer(new InMemoryVectorStore(EMBEDDING_DIM), new StubEmbedder());
}

describe("VectorIndexer", () => {
	it("fails closed on an embedder/store dimension mismatch", () => {
		expect(() => new VectorIndexer(new InMemoryVectorStore(16), new StubEmbedder(384))).toThrow(
			/dim/,
		);
	});

	it("indexes an entity and finds it by its own text", async () => {
		const ix = make();
		await ix.indexEntity(ent("a", "note", "vector search", "embeddings nearest neighbour"));
		expect(ix.count()).toBe(1);
		const hits = await ix.query("vector search embeddings");
		expect(hits[0]?.entityId).toBe("a");
	});

	it("ranks the most textually-similar entity first", async () => {
		const ix = make();
		await ix.indexEntity(
			ent("db", "note", "vector database index", "cosine nearest neighbour search"),
		);
		await ix.indexEntity(ent("cal", "note", "calendar event reminder", "schedule meeting tomorrow"));
		const hits = await ix.query("vector database cosine search");
		expect(hits[0]?.entityId).toBe("db");
	});

	it("re-indexing the same id replaces, never duplicates", async () => {
		const ix = make();
		await ix.indexEntity(ent("a", "note", "first version"));
		await ix.indexEntity(ent("a", "note", "second version entirely different"));
		expect(ix.count()).toBe(1);
	});

	it("drops an entity that became blank (no longer indexable)", async () => {
		const ix = make();
		await ix.indexEntity(ent("a", "note", "has content"));
		expect(ix.count()).toBe(1);
		await ix.indexEntity(ent("a", "note", "", ""));
		expect(ix.count()).toBe(0);
	});

	it("removeEntity deletes the embedding", async () => {
		const ix = make();
		await ix.indexEntity(ent("a", "note", "content"));
		ix.removeEntity("a");
		expect(ix.count()).toBe(0);
	});

	it("rebuild repopulates from sources atomically, skipping non-indexable", async () => {
		const ix = make();
		await ix.indexEntity(ent("stale", "note", "old"));
		await ix.rebuild([
			ent("x", "note", "alpha"),
			ent("blank", "note", "", ""),
			ent("y", "task", "beta"),
		]);
		expect(ix.count()).toBe(2);
		const hits = await ix.query("alpha beta");
		expect(hits.map((h) => h.entityId).sort()).toEqual(["x", "y"]);
	});

	it("filters query results by type", async () => {
		const ix = make();
		await ix.indexEntity(ent("n", "note", "shared word alpha"));
		await ix.indexEntity(ent("t", "task", "shared word alpha"));
		const hits = await ix.query("shared word alpha", 10, ["task"]);
		expect(hits.map((h) => h.entityId)).toEqual(["t"]);
	});

	it("returns no hits for an empty / token-less query", async () => {
		const ix = make();
		await ix.indexEntity(ent("a", "note", "content"));
		expect(await ix.query("")).toEqual([]);
		expect(await ix.query("   !!!   ")).toEqual([]);
	});

	it("throws after dispose", async () => {
		const ix = make();
		ix.dispose();
		await expect(ix.indexEntity(ent("a", "note", "x"))).rejects.toThrow(/disposed/);
	});
});

class CountingEmbedder implements TextEmbedder {
	readonly name = "counting";
	readonly dim = EMBEDDING_DIM;
	calls = 0;
	readonly #inner = new StubEmbedder();
	embed(text: string): Float32Array {
		this.calls += 1;
		return this.#inner.embed(text);
	}
}

describe("VectorIndexer.reconcile (incremental, 11.3)", () => {
	it("first reconcile embeds every entity", async () => {
		const emb = new CountingEmbedder();
		const ix = new VectorIndexer(new InMemoryVectorStore(EMBEDDING_DIM), emb);
		await ix.reconcile([ent("a", "note", "alpha", "x"), ent("b", "note", "bravo", "y")]);
		expect(ix.count()).toBe(2);
		expect(emb.calls).toBe(2);
	});

	it("re-reconcile with UNCHANGED content embeds nothing (the per-write win)", async () => {
		const emb = new CountingEmbedder();
		const ix = new VectorIndexer(new InMemoryVectorStore(EMBEDDING_DIM), emb);
		const entities = [ent("a", "note", "alpha", "x"), ent("b", "note", "bravo", "y")];
		await ix.reconcile(entities);
		emb.calls = 0;
		await ix.reconcile(entities);
		expect(emb.calls).toBe(0);
		expect(ix.count()).toBe(2);
	});

	it("embeds ONLY the entity whose indexable content changed", async () => {
		const emb = new CountingEmbedder();
		const ix = new VectorIndexer(new InMemoryVectorStore(EMBEDDING_DIM), emb);
		await ix.reconcile([ent("a", "note", "alpha", "x"), ent("b", "note", "bravo", "y")]);
		emb.calls = 0;
		await ix.reconcile([ent("a", "note", "alpha", "x"), ent("b", "note", "bravo", "CHANGED")]);
		expect(emb.calls).toBe(1);
	});

	it("reaps a deleted entity", async () => {
		const ix = make();
		await ix.reconcile([ent("a", "note", "alpha", "x"), ent("b", "note", "bravo", "y")]);
		await ix.reconcile([ent("a", "note", "alpha", "x")]);
		expect(ix.count()).toBe(1);
	});

	it("reaps an entity that went blank (non-indexable)", async () => {
		const ix = make();
		await ix.reconcile([ent("a", "note", "alpha", "x")]);
		expect(ix.count()).toBe(1);
		await ix.reconcile([ent("a", "note", "", "")]);
		expect(ix.count()).toBe(0);
	});

	it("first reconcile reaps a pre-existing store row not in the current set", async () => {
		const store = new InMemoryVectorStore(EMBEDDING_DIM);
		store.upsert({
			entityId: "stale",
			type: "note",
			ownerAppId: "x",
			updatedAt: 1,
			embedding: new StubEmbedder().embed("stale from last session"),
		});
		const ix = new VectorIndexer(store, new StubEmbedder());
		await ix.reconcile([ent("a", "note", "alpha", "x")]);
		expect(store.snapshotIds().has("stale")).toBe(false);
		expect(store.snapshotIds().has("a")).toBe(true);
	});
});
