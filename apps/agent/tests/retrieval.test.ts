/**
 * Agent-4 — broker-assembled hybrid retrieval + cited-answer link mapping.
 * Pure helpers: building the bounded retrieval context block from hits,
 * fail-soft fetch over the capability-gated search service, and mapping a
 * turn's citation ids to clickable link descriptors labelled by title.
 */

import type { SearchHit, SearchQuery } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import {
	RETRIEVAL_SNIPPET_MAX,
	RETRIEVAL_TOP_K,
	buildRetrievalContextBlock,
	citationsToLinks,
	hitsToContextItems,
	retrieveContext,
	titleMapFromItems,
	withRetrievalContext,
} from "../src/logic/retrieval";

function hit(over: Partial<SearchHit> = {}): SearchHit {
	return {
		entityId: "ent_1",
		type: "io.brainstorm.notes/Note/v1",
		ownerAppId: "io.brainstorm.notes",
		title: "Renewals plan",
		snippet: "the <mark>renewals</mark> are due in Q3",
		score: -1.2,
		updatedAt: 100,
		...over,
	};
}

describe("hitsToContextItems", () => {
	it("reduces hits to id/type/title and a clean, clamped snippet", () => {
		const items = hitsToContextItems([hit()]);
		expect(items).toEqual([
			{
				entityId: "ent_1",
				type: "io.brainstorm.notes/Note/v1",
				title: "Renewals plan",
				snippet: "the renewals are due in Q3",
			},
		]);
	});

	it("bounds to top-K", () => {
		const hits = Array.from({ length: 20 }, (_, i) => hit({ entityId: `ent_${i}` }));
		expect(hitsToContextItems(hits)).toHaveLength(RETRIEVAL_TOP_K);
		expect(hitsToContextItems(hits, 3)).toHaveLength(3);
	});

	it("clamps an overlong snippet with an ellipsis", () => {
		const long = "x".repeat(RETRIEVAL_SNIPPET_MAX + 100);
		const [item] = hitsToContextItems([hit({ snippet: long })]);
		expect(item?.snippet.length).toBeLessThanOrEqual(RETRIEVAL_SNIPPET_MAX);
		expect(item?.snippet.endsWith("…")).toBe(true);
	});
});

describe("buildRetrievalContextBlock", () => {
	it("emits one line per hit carrying the id so the model can cite it", () => {
		const block = buildRetrievalContextBlock(
			hitsToContextItems([hit(), hit({ entityId: "ent_2", title: "Budget" })]),
		);
		expect(block).toContain("[ent_1] Renewals plan — the renewals are due in Q3");
		expect(block).toContain("[ent_2] Budget");
	});

	it("returns empty string for no items (degrades to ungrounded chat)", () => {
		expect(buildRetrievalContextBlock([])).toBe("");
	});

	it("falls back to the id as the label when the title is blank", () => {
		const block = buildRetrievalContextBlock(hitsToContextItems([hit({ title: "  " })]));
		expect(block).toContain("[ent_1] ent_1");
	});
});

describe("withRetrievalContext", () => {
	it("appends a non-empty block separated by a blank line", () => {
		expect(withRetrievalContext("base", "BLOCK")).toBe("base\n\nBLOCK");
	});
	it("leaves the instruction untouched for an empty block", () => {
		expect(withRetrievalContext("base", "")).toBe("base");
	});
});

describe("retrieveContext (fail-soft, broker-assembled)", () => {
	it("calls search.hybrid with the bounded query and reduces the hits", async () => {
		const calls: SearchQuery[] = [];
		const search = {
			query: async () => [],
			hybrid: async (q: SearchQuery) => {
				calls.push(q);
				return [hit(), hit({ entityId: "ent_2" })];
			},
		};
		const items = await retrieveContext(search, "  renewals  ");
		expect(calls).toEqual([{ text: "renewals", limit: RETRIEVAL_TOP_K }]);
		expect(items.map((i) => i.entityId)).toEqual(["ent_1", "ent_2"]);
	});

	it("returns [] with no search service (no entities.read path)", async () => {
		expect(await retrieveContext(null, "x")).toEqual([]);
		expect(await retrieveContext(undefined, "x")).toEqual([]);
	});

	it("returns [] for an empty query without calling the service", async () => {
		const hybrid = vi.fn();
		await retrieveContext({ query: async () => [], hybrid }, "   ");
		expect(hybrid).not.toHaveBeenCalled();
	});

	it("swallows a thrown search and degrades to ungrounded chat", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const search = {
			query: async () => [],
			hybrid: async () => {
				throw new Error("Unavailable");
			},
		};
		expect(await retrieveContext(search, "renewals")).toEqual([]);
		warn.mockRestore();
	});
});

describe("citationsToLinks", () => {
	const titles = new Map([
		["ent_1", "Renewals plan"],
		["ent_2", "Budget"],
	]);

	it("labels each citation by its title from the retrieval map", () => {
		expect(citationsToLinks(["ent_1", "ent_2"], titles)).toEqual([
			{ entityId: "ent_1", label: "Renewals plan" },
			{ entityId: "ent_2", label: "Budget" },
		]);
	});

	it("falls back to the id when the title is unknown", () => {
		expect(citationsToLinks(["ent_99"], titles)).toEqual([{ entityId: "ent_99", label: "ent_99" }]);
	});

	it("dedupes, drops blanks, preserves order", () => {
		expect(citationsToLinks(["ent_1", " ", "ent_1", "ent_2"], titles)).toEqual([
			{ entityId: "ent_1", label: "Renewals plan" },
			{ entityId: "ent_2", label: "Budget" },
		]);
	});

	it("returns [] for no citations", () => {
		expect(citationsToLinks(undefined, titles)).toEqual([]);
		expect(citationsToLinks([], titles)).toEqual([]);
	});
});

describe("titleMapFromItems", () => {
	it("maps id→title, dropping blank titles", () => {
		const map = titleMapFromItems(
			hitsToContextItems([hit(), hit({ entityId: "ent_2", title: "  " })]),
		);
		expect(map.get("ent_1")).toBe("Renewals plan");
		expect(map.has("ent_2")).toBe(false);
	});
});
