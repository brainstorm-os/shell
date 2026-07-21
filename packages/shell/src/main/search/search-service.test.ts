import { open } from "@brainstorm-os/sqlite";
import { describe, expect, it } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import { applyMigrations } from "../storage/migrations";
import { SEARCH_MIGRATIONS } from "../storage/search-schema";
import { SearchIndexer } from "./search-indexer";
import { makeSearchServiceHandler } from "./search-service";

function envelope(method: string, ...args: unknown[]): Envelope {
	return {
		v: 1,
		msg: "m1",
		app: "io.example.app",
		service: "search",
		method,
		args,
		caps: ["search.read"],
	};
}

async function withIndexer(): Promise<{ indexer: SearchIndexer; teardown: () => void }> {
	const db = await open(":memory:");
	await applyMigrations(db, SEARCH_MIGRATIONS);
	const indexer = new SearchIndexer(db);
	return {
		indexer,
		teardown: () => {
			indexer.dispose();
			db.close();
		},
	};
}

describe("makeSearchServiceHandler", () => {
	it("throws Unavailable when no indexer is active", async () => {
		const handler = makeSearchServiceHandler({ getIndexer: () => null });
		await expect(
			async () => await handler(envelope("query", { text: "anything" })),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("throws Invalid for unknown methods", async () => {
		const { indexer, teardown } = await withIndexer();
		try {
			const handler = makeSearchServiceHandler({ getIndexer: () => indexer });
			await expect(
				async () => await handler(envelope("explode", { text: "x" })),
			).rejects.toMatchObject({
				name: "Invalid",
				message: /unknown search method: explode/,
			});
		} finally {
			teardown();
		}
	});

	it("rejects malformed query args", async () => {
		const { indexer, teardown } = await withIndexer();
		try {
			const handler = makeSearchServiceHandler({ getIndexer: () => indexer });
			await expect(async () => await handler(envelope("query"))).rejects.toMatchObject({
				name: "Invalid",
			});
			await expect(async () => await handler(envelope("query", null))).rejects.toMatchObject({
				name: "Invalid",
			});
			await expect(async () => await handler(envelope("query", { text: 42 }))).rejects.toMatchObject({
				name: "Invalid",
			});
			await expect(
				async () => await handler(envelope("query", { text: "ok", limit: "lots" })),
			).rejects.toMatchObject({ name: "Invalid" });
			await expect(
				async () => await handler(envelope("query", { text: "ok", types: [42] })),
			).rejects.toMatchObject({ name: "Invalid" });
		} finally {
			teardown();
		}
	});

	it("routes query → indexer.query and returns hits", async () => {
		const { indexer, teardown } = await withIndexer();
		try {
			indexer.indexEntity({
				entityId: "e1",
				type: "io.brainstorm.notes/Note/v1",
				ownerAppId: "io.brainstorm.notes",
				title: "global search",
				body: "the search service is live",
			});
			const handler = makeSearchServiceHandler({ getIndexer: () => indexer });
			const result = (await handler(envelope("query", { text: "global" }))) as Array<{
				entityId: string;
			}>;
			expect(result).toHaveLength(1);
			expect(result[0]?.entityId).toBe("e1");
		} finally {
			teardown();
		}
	});

	it("passes types + limit through to the indexer", async () => {
		const { indexer, teardown } = await withIndexer();
		try {
			indexer.indexEntity({
				entityId: "n1",
				type: "io.brainstorm.notes/Note/v1",
				ownerAppId: "io.brainstorm.notes",
				title: "alpha",
				body: "",
			});
			indexer.indexEntity({
				entityId: "t1",
				type: "brainstorm/Task/v1",
				ownerAppId: "io.brainstorm.tasks",
				title: "alpha",
				body: "",
			});
			const handler = makeSearchServiceHandler({ getIndexer: () => indexer });
			const onlyNotes = (await handler(
				envelope("query", { text: "alpha", types: ["io.brainstorm.notes/Note/v1"] }),
			)) as Array<{ entityId: string }>;
			expect(onlyNotes.map((h) => h.entityId)).toEqual(["n1"]);
		} finally {
			teardown();
		}
	});
});

describe("search.hybrid (11.4)", () => {
	/** A minimal stand-in for VectorIndexer — the service only calls query(). */
	function fakeVector(hits: Array<{ entityId: string; type?: string }>) {
		return {
			query: async () =>
				hits.map((h) => ({
					entityId: h.entityId,
					type: h.type ?? "io.brainstorm.notes/Note/v1",
					ownerAppId: "io.brainstorm.notes",
					updatedAt: 0,
					distance: 0.1,
				})),
		} as unknown as import("./vector-indexer").VectorIndexer;
	}

	it("degrades to lexical-only when no vector indexer is wired", async () => {
		const { indexer, teardown } = await withIndexer();
		try {
			indexer.indexEntity({
				entityId: "e1",
				type: "io.brainstorm.notes/Note/v1",
				ownerAppId: "io.brainstorm.notes",
				title: "phoenix",
				body: "",
			});
			const handler = makeSearchServiceHandler({ getIndexer: () => indexer });
			const hits = (await handler(envelope("hybrid", { text: "phoenix" }))) as Array<{
				entityId: string;
			}>;
			expect(hits.map((h) => h.entityId)).toEqual(["e1"]);
		} finally {
			teardown();
		}
	});

	it("fuses lexical + vector rankings, boosting an id both lists agree on", async () => {
		const { indexer, teardown } = await withIndexer();
		try {
			// Lexical order: a, b (both match "phoenix").
			indexer.indexEntity({
				entityId: "a",
				type: "io.brainstorm.notes/Note/v1",
				ownerAppId: "io.brainstorm.notes",
				title: "phoenix project",
				body: "phoenix phoenix",
			});
			indexer.indexEntity({
				entityId: "b",
				type: "io.brainstorm.notes/Note/v1",
				ownerAppId: "io.brainstorm.notes",
				title: "phoenix",
				body: "",
			});
			// Vector ranks b first, then a brand-new id "c".
			const handler = makeSearchServiceHandler({
				getIndexer: () => indexer,
				getVectorIndexer: () => fakeVector([{ entityId: "b" }, { entityId: "c" }]),
			});
			const hits = (await handler(envelope("hybrid", { text: "phoenix" }))) as Array<{
				entityId: string;
			}>;
			// b appears in both lists → highest fused score; c (vector-only) is included.
			expect(hits[0]?.entityId).toBe("b");
			expect(hits.map((h) => h.entityId).sort()).toEqual(["a", "b", "c"]);
		} finally {
			teardown();
		}
	});

	it("synthesises a minimal hit for a vector-only id (no lexical snippet)", async () => {
		const { indexer, teardown } = await withIndexer();
		try {
			const handler = makeSearchServiceHandler({
				getIndexer: () => indexer,
				getVectorIndexer: () => fakeVector([{ entityId: "vonly", type: "brainstorm/Task/v1" }]),
			});
			const hits = (await handler(envelope("hybrid", { text: "anything" }))) as Array<{
				entityId: string;
				type: string;
				snippet: string;
			}>;
			expect(hits).toHaveLength(1);
			expect(hits[0]).toMatchObject({ entityId: "vonly", type: "brainstorm/Task/v1", snippet: "" });
		} finally {
			teardown();
		}
	});
});
