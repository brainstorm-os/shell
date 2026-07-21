import { type SqliteDatabase, open } from "@brainstorm-os/sqlite";
import { describe, expect, it } from "vitest";
import { buildMatchExpression } from "../search/search-indexer";
import { applyMigrations } from "../storage/migrations";
import { SEARCH_MIGRATIONS } from "../storage/search-schema";
import { HELP_CORPUS_FORMAT, type HelpArticle, type HelpCorpus } from "./help-corpus";
import { HelpIndexer, articleByTopicId } from "./help-indexer";

async function openIndexer(): Promise<{ db: SqliteDatabase; indexer: HelpIndexer }> {
	const db = await open(":memory:");
	await applyMigrations(db, SEARCH_MIGRATIONS);
	const indexer = new HelpIndexer(db);
	return { db, indexer };
}

function article(overrides: Partial<HelpArticle> = {}): HelpArticle {
	const base: HelpArticle = {
		topicId: "guide/getting-started/getting-started/welcome",
		sectionId: "getting-started",
		title: "Welcome to Brainstorm",
		slug: "getting-started/welcome",
		markdown: "# Welcome to Brainstorm\n\nLocal-first personal knowledge management.",
		plaintext: "Welcome to Brainstorm Local-first personal knowledge management.",
		headings: [],
		relPath: "getting-started/welcome.md",
	};
	return { ...base, ...overrides };
}

function corpus(...articles: HelpArticle[]): HelpCorpus {
	return { format: HELP_CORPUS_FORMAT, sections: [], articles };
}

describe("HelpIndexer — round-trip", () => {
	it("rebuild → query returns the row with snippet + score", async () => {
		const { indexer } = await openIndexer();
		try {
			indexer.rebuild(
				corpus(
					article({
						topicId: "guide/getting-started/getting-started/welcome",
						title: "Welcome to Brainstorm",
						plaintext: "Local-first personal knowledge management",
					}),
					article({
						topicId: "guide/concepts/vaults",
						sectionId: "concepts",
						title: "Vaults",
						plaintext: "Dashboard launcher windows",
						slug: "concepts/vaults",
						relPath: "concepts/vaults.md",
					}),
				),
			);
			const hits = indexer.query("local-first");
			expect(hits).toHaveLength(1);
			expect(hits[0]?.topicId).toBe("guide/getting-started/getting-started/welcome");
			expect(hits[0]?.title).toBe("Welcome to Brainstorm");
			expect(hits[0]?.snippet).toContain("<mark>");
			expect(hits[0]?.score).toBeLessThan(0);
		} finally {
			indexer.dispose();
		}
	});

	it("rebuild is atomic — re-running replaces contents", async () => {
		const { indexer } = await openIndexer();
		try {
			indexer.rebuild(corpus(article({ topicId: "a", title: "Welcome", plaintext: "one" })));
			expect(indexer.count()).toBe(1);
			indexer.rebuild(
				corpus(
					article({ topicId: "b", title: "B", plaintext: "two" }),
					article({ topicId: "c", title: "C", plaintext: "three" }),
				),
			);
			expect(indexer.count()).toBe(2);
			expect(indexer.query("one")).toEqual([]);
			expect(indexer.query("two")).toHaveLength(1);
		} finally {
			indexer.dispose();
		}
	});

	it("empty / whitespace queries return []", async () => {
		const { indexer } = await openIndexer();
		try {
			indexer.rebuild(corpus(article()));
			expect(indexer.query("")).toEqual([]);
			expect(indexer.query("   ")).toEqual([]);
			expect(indexer.query(",.;")).toEqual([]);
		} finally {
			indexer.dispose();
		}
	});

	it("disposed indexer rejects further calls", async () => {
		const { indexer } = await openIndexer();
		indexer.dispose();
		expect(() => indexer.query("x")).toThrow(/disposed/);
		expect(() => indexer.rebuild(corpus())).toThrow(/disposed/);
		expect(() => indexer.count()).toThrow(/disposed/);
	});
});

describe("HelpIndexer — escape reuse fence (drift-test against SearchIndexer)", () => {
	it("uses the same buildMatchExpression as SearchIndexer (no duplicate escape paths)", async () => {
		const { indexer } = await openIndexer();
		try {
			indexer.rebuild(
				corpus(
					article({
						topicId: "g/x",
						title: "Quoted",
						plaintext: "the quick brown fox jumps over the lazy dog",
					}),
				),
			);
			expect(buildMatchExpression("quick fox")).toBe('"quick" AND "fox"*');
			const hits = indexer.query("quick fox");
			expect(hits).toHaveLength(1);
			expect(hits[0]?.topicId).toBe("g/x");
		} finally {
			indexer.dispose();
		}
	});

	it("FTS5 operator characters typed by users are inert (no injection)", async () => {
		const { indexer } = await openIndexer();
		try {
			indexer.rebuild(corpus(article({ topicId: "g/x", plaintext: "alpha beta gamma OR delta" })));
			// "alpha OR beta" tokenises to alpha + OR + beta — all three must match
			// as ordinary words (the OR is NOT the FTS5 disjunction operator).
			expect(indexer.query("alpha OR beta")).toHaveLength(1);
			// Parens + star are stripped by the unicode61 tokeniser; the matcher
			// sees "alpha" + "beta" with no syntax leaking in.
			expect(indexer.query("(alpha) *beta")).toHaveLength(1);
		} finally {
			indexer.dispose();
		}
	});

	it("respects an explicit query limit (clamped to HARD_LIMIT)", async () => {
		const { indexer } = await openIndexer();
		try {
			const many = Array.from({ length: 5 }, (_, i) =>
				article({
					topicId: `g/${i}`,
					title: `Title ${i}`,
					plaintext: `keyword body number ${i}`,
				}),
			);
			indexer.rebuild(corpus(...many));
			expect(indexer.query("keyword")).toHaveLength(5);
			expect(indexer.query("keyword", 2)).toHaveLength(2);
			expect(indexer.query("keyword", 99999)).toHaveLength(5);
			expect(indexer.query("keyword", 0)).toHaveLength(5);
		} finally {
			indexer.dispose();
		}
	});
});

describe("articleByTopicId", () => {
	it("returns the article for a known topicId, null otherwise", () => {
		const c = corpus(article({ topicId: "g/a" }), article({ topicId: "g/b", title: "Other" }));
		expect(articleByTopicId(c, "g/a")?.topicId).toBe("g/a");
		expect(articleByTopicId(c, "g/b")?.title).toBe("Other");
		expect(articleByTopicId(c, "g/missing")).toBeNull();
	});
});
