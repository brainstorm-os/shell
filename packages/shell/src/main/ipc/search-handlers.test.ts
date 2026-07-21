import { describe, expect, it } from "vitest";
import { EmbedderPhase, markReady, needsConsentStatus } from "../search/embedder-status";
import type { SearchHit, SearchIndexer } from "../search/search-indexer";
import { runHybridQuery } from "../search/search-service";
import type { VectorIndexer } from "../search/vector-indexer";
import { type SearchHandlerDeps, buildReport, validateQuery } from "./search-handlers";

describe("validateQuery", () => {
	it("accepts a minimal { text } query", () => {
		expect(validateQuery({ text: "hello" })).toEqual({ text: "hello" });
	});

	it("rejects null", () => {
		expect(validateQuery(null)).toBeNull();
	});

	it("rejects primitives", () => {
		expect(validateQuery(42)).toBeNull();
		expect(validateQuery("hello")).toBeNull();
		expect(validateQuery(true)).toBeNull();
	});

	it("rejects arrays", () => {
		expect(validateQuery(["hello"])).toBeNull();
	});

	it("rejects { text } that isn't a string", () => {
		expect(validateQuery({ text: 5 })).toBeNull();
		expect(validateQuery({})).toBeNull();
	});

	it("accepts types when given an array of non-empty strings", () => {
		expect(validateQuery({ text: "x", types: ["a", "b"] })).toEqual({
			text: "x",
			types: ["a", "b"],
		});
	});

	it("rejects types containing empty strings", () => {
		expect(validateQuery({ text: "x", types: ["a", ""] })).toBeNull();
	});

	it("rejects types containing non-strings", () => {
		expect(validateQuery({ text: "x", types: ["a", 1] })).toBeNull();
	});

	it("rejects non-array types", () => {
		expect(validateQuery({ text: "x", types: "a" })).toBeNull();
	});

	it("accepts a finite limit", () => {
		expect(validateQuery({ text: "x", limit: 10 })).toEqual({ text: "x", limit: 10 });
	});

	it("rejects non-finite or non-numeric limit", () => {
		expect(validateQuery({ text: "x", limit: Number.POSITIVE_INFINITY })).toBeNull();
		expect(validateQuery({ text: "x", limit: Number.NaN })).toBeNull();
		expect(validateQuery({ text: "x", limit: "10" })).toBeNull();
	});

	it("preserves the empty-text case (caller short-circuits on empty)", () => {
		expect(validateQuery({ text: "" })).toEqual({ text: "" });
	});
});

describe("buildReport — semantic model status (11.3)", () => {
	const baseDeps: SearchHandlerDeps = {
		getIndexer: () => null,
		reindex: async () => undefined,
		getAvailableCount: async () => null,
	};

	it("reports the wired semantic status", async () => {
		const report = await buildReport({ ...baseDeps, getSemanticStatus: () => markReady() });
		expect(report.semantic.phase).toBe(EmbedderPhase.Ready);
		expect(report.semantic.percent).toBe(100);
	});

	it("defaults to Absent (lexical-only) when no embedder is wired", async () => {
		const report = await buildReport(baseDeps);
		expect(report.semantic.phase).toBe(EmbedderPhase.Absent);
	});

	it("still reports semantic status when the coverage scan throws", async () => {
		const report = await buildReport({
			...baseDeps,
			getAvailableCount: async () => {
				throw new Error("scan failed");
			},
			getSemanticStatus: () => markReady(),
		});
		expect(report.available).toBeNull();
		expect(report.semantic.phase).toBe(EmbedderPhase.Ready);
	});

	it("surfaces the pre-opt-in NeedsConsent gate to the panel (11.3 consent)", async () => {
		const report = await buildReport({
			...baseDeps,
			getSemanticStatus: () => needsConsentStatus(),
		});
		expect(report.semantic.phase).toBe(EmbedderPhase.NeedsConsent);
	});
});

describe("launcher default search is hybrid (11.4)", () => {
	const lexHit: SearchHit = {
		entityId: "e1",
		type: "io.brainstorm.notes/Note/v1",
		ownerAppId: "io.brainstorm.notes",
		title: "phoenix",
		snippet: "phoenix",
		score: 1,
		updatedAt: 0,
	};
	const fakeIndexer = { query: () => [lexHit] } as unknown as SearchIndexer;

	it("degrades to the lexical result when no vector indexer is wired (today's behaviour)", async () => {
		const hits = await runHybridQuery(fakeIndexer, null, { text: "phoenix" });
		expect(hits.map((h) => h.entityId)).toEqual(["e1"]);
	});

	it("fuses a vector-only id once a vector indexer is wired (11.3 sharpening)", async () => {
		const fakeVector = {
			query: async () => [
				{ entityId: "v2", type: "brainstorm/Task/v1", ownerAppId: "x", updatedAt: 0, distance: 0.1 },
			],
		} as unknown as VectorIndexer;
		const hits = await runHybridQuery(fakeIndexer, fakeVector, { text: "phoenix" });
		expect(hits.map((h) => h.entityId).sort()).toEqual(["e1", "v2"]);
	});
});
