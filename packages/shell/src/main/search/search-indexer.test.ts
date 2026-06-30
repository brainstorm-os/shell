import { describe, expect, it } from "vitest";
import { applyMigrations } from "../storage/migrations";
import { SEARCH_MIGRATIONS } from "../storage/search-schema";
import { type SqliteDatabase, open } from "../storage/sqlite";
import {
	type IndexableEntity,
	MatchMode,
	SearchIndexer,
	buildMatchExpression,
	isIndexable,
	pickIndexable,
} from "./search-indexer";

async function openIndexer(): Promise<{ db: SqliteDatabase; indexer: SearchIndexer }> {
	const db = await open(":memory:");
	await applyMigrations(db, SEARCH_MIGRATIONS);
	const indexer = new SearchIndexer(db);
	return { db, indexer };
}

const NOTE = "io.brainstorm.notes/Note/v1";
const NOTES = "io.brainstorm.notes";

function entity(id: string, title: string, body: string): IndexableEntity {
	return { entityId: id, type: NOTE, ownerAppId: NOTES, title, body };
}

describe("buildMatchExpression", () => {
	it("returns null for empty / whitespace / non-string input", () => {
		expect(buildMatchExpression("")).toBeNull();
		expect(buildMatchExpression("   ")).toBeNull();
		expect(buildMatchExpression(",.;!?")).toBeNull();
		// @ts-expect-error — defensive runtime check
		expect(buildMatchExpression(undefined)).toBeNull();
		// @ts-expect-error — defensive runtime check
		expect(buildMatchExpression(42)).toBeNull();
	});

	it("quotes each token and prefix-matches the last", () => {
		expect(buildMatchExpression("hello")).toBe('"hello"*');
		expect(buildMatchExpression("hello world")).toBe('"hello" AND "world"*');
	});

	it("doubles internal quotes so FTS5 sees them literally", () => {
		// User typed: a "b" c → tokenises to three words; the rogue " inside any
		// single token would also be doubled if it ever appeared.
		expect(buildMatchExpression('a "b" c')).toBe('"a" AND "b" AND "c"*');
	});

	it("renders FTS5 operators as ordinary tokens (no syntax injection)", () => {
		// AND / OR / NEAR / parens / stars typed by the user all stay quoted —
		// they do NOT become FTS5 operators.
		expect(buildMatchExpression("AND OR NEAR")).toBe('"AND" AND "OR" AND "NEAR"*');
		expect(buildMatchExpression("(quick) *brown")).toBe('"quick" AND "brown"*');
	});

	it("ORs tokens in Any mode and drops stopwords when content words remain", () => {
		expect(
			buildMatchExpression("the quick brown fox", { mode: MatchMode.Any, dropStopwords: true }),
		).toBe('"quick" OR "brown" OR "fox"*');
		// All-stopword query keeps its tokens rather than degrading to no match.
		expect(buildMatchExpression("who are they", { mode: MatchMode.Any, dropStopwords: true })).toBe(
			'"who" OR "are" OR "they"*',
		);
		// Any mode without dropping stopwords ORs every token.
		expect(buildMatchExpression("cat dog", { mode: MatchMode.Any })).toBe('"cat" OR "dog"*');
	});

	it("splits on punctuation the way unicode61 does (apostrophes, hyphens become boundaries)", () => {
		// Mirrors FTS5 default `unicode61` tokenisation — anything outside
		// Unicode L+N is a separator, including ' and -. If we kept them as
		// token chars, "don't" would store as "don" + "t" but query as
		// "don't" and silently miss.
		expect(buildMatchExpression("don't stop")).toBe('"don" AND "t" AND "stop"*');
		expect(buildMatchExpression("co-author")).toBe('"co" AND "author"*');
	});
});

describe("SearchIndexer — round-trip", () => {
	it("index → query returns the row with snippet + score", async () => {
		const { db, indexer } = await openIndexer();
		try {
			indexer.indexEntity(entity("e1", "Quick brown fox", "the fox jumps over the lazy dog"));
			const hits = indexer.query({ text: "fox" });
			expect(hits).toHaveLength(1);
			expect(hits[0]?.entityId).toBe("e1");
			expect(hits[0]?.type).toBe(NOTE);
			expect(hits[0]?.ownerAppId).toBe(NOTES);
			expect(hits[0]?.title).toBe("Quick brown fox");
			expect(hits[0]?.snippet).toMatch(/<mark>fox<\/mark>/);
			expect(typeof hits[0]?.score).toBe("number");
		} finally {
			db.close();
		}
	});

	it("indexEntity is an upsert — second call replaces the body", async () => {
		const { db, indexer } = await openIndexer();
		try {
			indexer.indexEntity(entity("e1", "v1 title", "alpha"));
			indexer.indexEntity(entity("e1", "v2 title", "beta"));
			expect(indexer.count()).toBe(1);
			expect(indexer.query({ text: "alpha" })).toHaveLength(0);
			expect(indexer.query({ text: "beta" })).toHaveLength(1);
			expect(indexer.query({ text: "beta" })[0]?.title).toBe("v2 title");
		} finally {
			db.close();
		}
	});

	it("removeEntity drops both the FTS5 row and the sidecar row", async () => {
		const { db, indexer } = await openIndexer();
		try {
			indexer.indexEntity(entity("e1", "alpha", "first note"));
			indexer.indexEntity(entity("e2", "beta", "second note"));
			expect(indexer.count()).toBe(2);
			indexer.removeEntity("e1");
			expect(indexer.count()).toBe(1);
			expect(indexer.query({ text: "alpha" })).toHaveLength(0);
			expect(indexer.query({ text: "beta" })).toHaveLength(1);
			const sidecar = db
				.prepare("SELECT entity_id FROM entity_fts_meta WHERE entity_id = ?")
				.all("e1");
			expect(sidecar).toEqual([]);
		} finally {
			db.close();
		}
	});
});

describe("SearchIndexer — query semantics", () => {
	it("ranks more relevant matches first (BM25 score asc)", async () => {
		const { db, indexer } = await openIndexer();
		try {
			indexer.indexEntity(entity("title-only", "shark", ""));
			indexer.indexEntity(entity("body-only", "ocean life", "the shark swims"));
			indexer.indexEntity(entity("noise", "calendar", "weekly planning notes"));
			const hits = indexer.query({ text: "shark" });
			expect(hits.map((h) => h.entityId)).toEqual(["title-only", "body-only"]);
			const first = hits[0];
			const second = hits[1];
			if (!first || !second) throw new Error("expected two hits");
			expect(first.score).toBeLessThanOrEqual(second.score);
		} finally {
			db.close();
		}
	});

	it("supports prefix-match via the trailing * on the last token", async () => {
		const { db, indexer } = await openIndexer();
		try {
			indexer.indexEntity(entity("e1", "Calendar planning", "scheduling weekly events"));
			indexer.indexEntity(entity("e2", "Project status", "deliverables on track"));
			expect(indexer.query({ text: "cale" }).map((h) => h.entityId)).toEqual(["e1"]);
			expect(indexer.query({ text: "deliv" }).map((h) => h.entityId)).toEqual(["e2"]);
		} finally {
			db.close();
		}
	});

	it("filters by type", async () => {
		const { db, indexer } = await openIndexer();
		try {
			indexer.indexEntity({
				entityId: "n1",
				type: NOTE,
				ownerAppId: NOTES,
				title: "find me",
				body: "",
			});
			indexer.indexEntity({
				entityId: "t1",
				type: "brainstorm/Task/v1",
				ownerAppId: "io.brainstorm.tasks",
				title: "find me too",
				body: "",
			});
			const onlyNotes = indexer.query({ text: "find", types: [NOTE] });
			expect(onlyNotes.map((h) => h.entityId)).toEqual(["n1"]);
			const both = indexer.query({ text: "find" });
			expect(both.map((h) => h.entityId).sort()).toEqual(["n1", "t1"]);
		} finally {
			db.close();
		}
	});

	it("excludes the given types (so the Agent never grounds on its own transcript)", async () => {
		const { db, indexer } = await openIndexer();
		try {
			const MESSAGE = "brainstorm/Message/v1";
			indexer.indexEntity(entity("note", "Northbound launch plan", "ship the launch"));
			indexer.indexEntity({
				entityId: "msg",
				type: MESSAGE,
				ownerAppId: "io.brainstorm.agent",
				title: "",
				body: "what is in my Northbound launch plan?",
			});
			// Without the filter the Message (an exact echo of the query) outranks
			// the note; excluding it surfaces the real content instead.
			const unfiltered = indexer.query({ text: "what is in my Northbound launch plan?" });
			expect(unfiltered.map((h) => h.entityId)).toContain("msg");
			const filtered = indexer.query({
				text: "what is in my Northbound launch plan?",
				excludeTypes: [MESSAGE],
			});
			expect(filtered.map((h) => h.entityId)).not.toContain("msg");
			expect(filtered.map((h) => h.entityId)).toContain("note");
		} finally {
			db.close();
		}
	});

	it("caps results at the given limit (and at 200 hard ceiling)", async () => {
		const { db, indexer } = await openIndexer();
		try {
			for (let i = 0; i < 12; i++) {
				indexer.indexEntity(entity(`e${i}`, "alpha", `alpha row ${i}`));
			}
			expect(indexer.query({ text: "alpha", limit: 3 })).toHaveLength(3);
			expect(indexer.query({ text: "alpha", limit: 500 })).toHaveLength(12);
			expect(indexer.query({ text: "alpha", limit: 0 })).toHaveLength(12); // 0 falls back to default
			expect(indexer.query({ text: "alpha", limit: Number.NaN })).toHaveLength(12);
		} finally {
			db.close();
		}
	});

	it("returns no hits for empty / whitespace query (no FTS5 call)", async () => {
		const { db, indexer } = await openIndexer();
		try {
			indexer.indexEntity(entity("e1", "anything", "anywhere"));
			expect(indexer.query({ text: "" })).toEqual([]);
			expect(indexer.query({ text: "   " })).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("treats raw FTS5 operators in user input as literal tokens (no injection)", async () => {
		const { db, indexer } = await openIndexer();
		try {
			indexer.indexEntity(entity("e1", "cat", "a furry pet"));
			indexer.indexEntity(entity("e2", "dog", "a loyal pet"));
			// "cat OR dog" must not act as an FTS5 OR operator at the precise stage:
			// the AND of literal "cat"/"or"/"dog" matches no single doc. The
			// natural-language fallback then ORs the content words (the "or"
			// stopword dropped) and surfaces both — relevant hits, not a parse of
			// the user's operators.
			const hits = indexer.query({ text: "cat OR dog" });
			expect(hits.map((h) => h.entityId).sort()).toEqual(["e1", "e2"]);
			// Special chars should not crash.
			expect(() => indexer.query({ text: '" " ! @ # $ % ^ & * ( )' })).not.toThrow();
		} finally {
			db.close();
		}
	});

	it("falls back to an OR over content words when the precise AND match is empty", async () => {
		const { db, indexer } = await openIndexer();
		try {
			indexer.indexEntity(entity("plan", "Northbound Q3 plan", "launch roadmap and milestones"));
			indexer.indexEntity(entity("misc", "grocery list", "milk eggs bread"));
			// A full natural-language turn (what the Agent feeds into search): the
			// precise AND of every token — stopwords included — matches nothing, but
			// the fallback surfaces the relevant note and bm25 ranks it first.
			const hits = indexer.query({ text: "what is in my Northbound launch plan?" });
			expect(hits.map((h) => h.entityId)).toContain("plan");
			expect(hits[0]?.entityId).toBe("plan");
			expect(hits.map((h) => h.entityId)).not.toContain("misc");
		} finally {
			db.close();
		}
	});

	it("keeps precise AND results when they exist (NL fallback does not fire)", async () => {
		const { db, indexer } = await openIndexer();
		try {
			indexer.indexEntity(entity("both", "project plan", "the quarterly project plan"));
			indexer.indexEntity(entity("one", "project ideas", "loose ideas"));
			// "project plan" matches `both` under AND → the OR fallback never runs,
			// so the broader `one` (only "project") is NOT pulled in.
			const hits = indexer.query({ text: "project plan" });
			expect(hits.map((h) => h.entityId)).toEqual(["both"]);
		} finally {
			db.close();
		}
	});
});

describe("SearchIndexer — rebuild", () => {
	it("rebuild() wipes the index and re-populates atomically", async () => {
		const { db, indexer } = await openIndexer();
		try {
			indexer.indexEntity(entity("stale", "stale row", ""));
			indexer.rebuild([
				entity("e1", "alpha", "first"),
				entity("e2", "beta", "second"),
				entity("e3", "gamma", "third"),
			]);
			expect(indexer.count()).toBe(3);
			expect(indexer.query({ text: "stale" })).toHaveLength(0);
			expect(indexer.query({ text: "alpha" })).toHaveLength(1);
		} finally {
			db.close();
		}
	});

	it("rebuild() drops rows with empty title AND empty body (would otherwise match every search)", async () => {
		const { db, indexer } = await openIndexer();
		try {
			indexer.rebuild([entity("blank", "", ""), entity("ok", "real title", "")]);
			expect(indexer.count()).toBe(1);
			expect(indexer.query({ text: "real" }).map((h) => h.entityId)).toEqual(["ok"]);
		} finally {
			db.close();
		}
	});

	it("rebuild() is idempotent — running twice with the same input yields the same count", async () => {
		const { db, indexer } = await openIndexer();
		try {
			const input = [entity("e1", "alpha", ""), entity("e2", "beta", "")];
			indexer.rebuild(input);
			indexer.rebuild(input);
			expect(indexer.count()).toBe(2);
		} finally {
			db.close();
		}
	});
});

describe("SearchIndexer — stats", () => {
	it("reports zeroes for an empty index", async () => {
		const { db, indexer } = await openIndexer();
		try {
			const s = indexer.stats();
			expect(s.total).toBe(0);
			expect(s.byType).toEqual([]);
			expect(s.lastIndexedAt).toBe(0);
			expect(s.bytes).toBeGreaterThanOrEqual(0);
		} finally {
			db.close();
		}
	});

	it("reports a non-zero on-disk size once the index has content", async () => {
		const { db, indexer } = await openIndexer();
		try {
			indexer.indexEntity(entity("n1", "note one", "some body text"));
			// `bytes` = page_count * page_size; both are > 0 for a populated
			// DB. Regression (user-reported "size shows 0 B"): the sqlite
			// `pragma()` adapter returns an array of rows, so the value
			// reader must unwrap `[ { page_count: N } ]`.
			expect(indexer.stats().bytes).toBeGreaterThan(0);
		} finally {
			db.close();
		}
	});

	it("counts rows, groups by type busiest-first, and reports the newest timestamp", async () => {
		const { db, indexer } = await openIndexer();
		try {
			const OTHER = "io.brainstorm.tasks/Task/v1";
			indexer.indexEntity(entity("n1", "note one", "body"), 1000);
			indexer.indexEntity(entity("n2", "note two", "body"), 2000);
			indexer.indexEntity(
				{ entityId: "t1", type: OTHER, ownerAppId: "io.brainstorm.tasks", title: "task", body: "" },
				5000,
			);
			const s = indexer.stats();
			expect(s.total).toBe(3);
			// Notes (2) before Task (1) — busiest type first.
			expect(s.byType).toEqual([
				{ type: NOTE, count: 2 },
				{ type: OTHER, count: 1 },
			]);
			expect(s.lastIndexedAt).toBe(5000);
		} finally {
			db.close();
		}
	});

	it("breaks type-count ties by type name ascending", async () => {
		const { db, indexer } = await openIndexer();
		try {
			const A = "z.app/Alpha/v1";
			const Z = "z.app/Zeta/v1";
			indexer.indexEntity({ entityId: "z1", type: Z, ownerAppId: "z", title: "z", body: "" });
			indexer.indexEntity({ entityId: "a1", type: A, ownerAppId: "z", title: "a", body: "" });
			const s = indexer.stats();
			expect(s.byType.map((r) => r.type)).toEqual([A, Z]);
		} finally {
			db.close();
		}
	});

	it("rejects stats() after dispose()", async () => {
		const { db, indexer } = await openIndexer();
		try {
			indexer.dispose();
			expect(() => indexer.stats()).toThrow(/disposed/);
		} finally {
			db.close();
		}
	});
});

describe("isIndexable / pickIndexable", () => {
	it("requires id, type, and at least one of title/body with text", () => {
		expect(isIndexable(entity("e1", "title", ""))).toBe(true);
		expect(isIndexable(entity("e1", "", "body"))).toBe(true);
		expect(isIndexable(entity("e1", "  ", "   "))).toBe(false);
		expect(isIndexable({ entityId: "", type: NOTE, ownerAppId: NOTES, title: "x", body: "" })).toBe(
			false,
		);
		expect(isIndexable({ entityId: "e1", type: "", ownerAppId: NOTES, title: "x", body: "" })).toBe(
			false,
		);
	});

	it("pickIndexable keeps input order and drops only the unindexable", () => {
		const input = [entity("a", "alpha", ""), entity("blank", "", ""), entity("b", "", "beta body")];
		expect(pickIndexable(input).map((e) => e.entityId)).toEqual(["a", "b"]);
	});

	it("pickIndexable agrees with what rebuild() actually writes", async () => {
		const { db, indexer } = await openIndexer();
		try {
			const input = [entity("a", "alpha", ""), entity("blank", "", ""), entity("b", "beta", "")];
			indexer.rebuild(input);
			expect(indexer.count()).toBe(pickIndexable(input).length);
		} finally {
			db.close();
		}
	});
});

describe("SearchIndexer — lifecycle", () => {
	it("rejects calls after dispose()", async () => {
		const { db, indexer } = await openIndexer();
		try {
			indexer.dispose();
			expect(() => indexer.indexEntity(entity("e1", "x", "y"))).toThrow(/disposed/);
			expect(() => indexer.query({ text: "x" })).toThrow(/disposed/);
		} finally {
			db.close();
		}
	});
});
