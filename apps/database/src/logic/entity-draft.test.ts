/**
 * Tests for `draftForList` — the entity-draft computer used by "+ New" on a
 * view. Spec table from §Criteria
 * inheritance:
 *
 *   - type comes from view.defaultTypeUrl OR a single-type byType source.
 *   - Property values come from the AND-chain of source ∪ view.filters.
 *   - Pinnable predicates: $eq, $in (of one), $contains (single → list),
 *     $allIn, $gte (pins to lower bound), $lte (pins to upper if no $gte).
 *   - OR-branch values are silently dropped.
 *   - $gt / $lt / $like / $notLike / $exists / $empty / $not* do not pin.
 */

import { describe, expect, it } from "vitest";
import { CompositeOp, type ListSource, ListSourceKind } from "../types/list-source";
import {
	FilterGroupOp,
	type FilterNode,
	FilterNodeKind,
	type PropertyPredicate,
} from "../types/predicate";
import {
	type DraftInputs,
	collectAndOnlyPredicates,
	collectAndOnlyPredicatesFromFilterNode,
	draftForList,
} from "./entity-draft";

const noSource: DraftInputs = {
	source: null,
	viewFilters: null,
	defaultTypeUrl: null,
};

describe("draftForList — type resolution", () => {
	it("prefers the view's defaultTypeUrl over the source", () => {
		const inputs: DraftInputs = {
			source: { kind: ListSourceKind.ByType, types: ["io.example/Movie/v1"] },
			viewFilters: null,
			defaultTypeUrl: "io.example/Book/v1",
		};
		expect(draftForList(inputs).type).toBe("io.example/Book/v1");
	});

	it("falls back to a single-type byType source's type", () => {
		const inputs: DraftInputs = {
			source: { kind: ListSourceKind.ByType, types: ["io.example/Movie/v1"] },
			viewFilters: null,
			defaultTypeUrl: null,
		};
		expect(draftForList(inputs).type).toBe("io.example/Movie/v1");
	});

	it("omits type when source has multiple types and no defaultTypeUrl", () => {
		const inputs: DraftInputs = {
			source: {
				kind: ListSourceKind.ByType,
				types: ["io.example/Movie/v1", "io.example/Book/v1"],
			},
			viewFilters: null,
			defaultTypeUrl: null,
		};
		expect(draftForList(inputs).type).toBeUndefined();
	});

	it("omits type when there's no source and no defaultTypeUrl", () => {
		expect(draftForList(noSource).type).toBeUndefined();
	});
});

describe("draftForList — pinnable predicates from source", () => {
	it("pins $eq values from a byFilter source", () => {
		const inputs: DraftInputs = {
			source: {
				kind: ListSourceKind.ByFilter,
				where: { $eq: { status: "Unwatched", genre: "Comedy" } },
			},
			viewFilters: null,
			defaultTypeUrl: "io.example/Movie/v1",
		};
		const draft = draftForList(inputs);
		expect(draft.properties).toEqual({ status: "Unwatched", genre: "Comedy" });
	});

	it("does not pin byLink anchors (caller dispatches link creation)", () => {
		const inputs: DraftInputs = {
			source: {
				kind: ListSourceKind.ByLink,
				linkType: "io.example/links/belongs-to/v1",
				direction: "in",
				anchorEntityId: "ent_project_01",
			} as ListSource,
			viewFilters: null,
			defaultTypeUrl: "io.example/Task/v1",
		};
		expect(draftForList(inputs).properties).toEqual({});
	});
});

describe("draftForList — pinnable predicates from view filters", () => {
	it("pins through an AND group", () => {
		const view: FilterNode = {
			kind: FilterNodeKind.Group,
			op: FilterGroupOp.And,
			children: [
				{
					kind: FilterNodeKind.Predicate,
					predicate: { $eq: { status: "Todo" } },
				},
				{
					kind: FilterNodeKind.Predicate,
					predicate: { $eq: { assignee: "ent_user_self" } },
				},
			],
		};
		const draft = draftForList({
			source: null,
			viewFilters: view,
			defaultTypeUrl: "io.example/Task/v1",
		});
		expect(draft.properties).toEqual({
			status: "Todo",
			assignee: "ent_user_self",
		});
	});

	it("drops everything inside an OR group", () => {
		const view: FilterNode = {
			kind: FilterNodeKind.Group,
			op: FilterGroupOp.Or,
			children: [
				{ kind: FilterNodeKind.Predicate, predicate: { $eq: { status: "Todo" } } },
				{ kind: FilterNodeKind.Predicate, predicate: { $eq: { status: "Doing" } } },
			],
		};
		const draft = draftForList({
			source: null,
			viewFilters: view,
			defaultTypeUrl: "io.example/Task/v1",
		});
		expect(draft.properties).toEqual({});
	});

	it("drops the OR sub-tree but keeps siblings inside the parent AND", () => {
		const view: FilterNode = {
			kind: FilterNodeKind.Group,
			op: FilterGroupOp.And,
			children: [
				{ kind: FilterNodeKind.Predicate, predicate: { $eq: { type: "Task" } } },
				{
					kind: FilterNodeKind.Group,
					op: FilterGroupOp.Or,
					children: [
						{ kind: FilterNodeKind.Predicate, predicate: { $eq: { status: "Todo" } } },
						{ kind: FilterNodeKind.Predicate, predicate: { $eq: { status: "Doing" } } },
					],
				},
			],
		};
		const draft = draftForList({
			source: null,
			viewFilters: view,
			defaultTypeUrl: null,
		});
		expect(draft.properties).toEqual({ type: "Task" });
	});
});

describe("draftForList — predicate operators", () => {
	function inputs(predicate: PropertyPredicate): DraftInputs {
		return {
			source: null,
			viewFilters: {
				kind: FilterNodeKind.Predicate,
				predicate,
			},
			defaultTypeUrl: null,
		};
	}

	it("$in pins the value when there's exactly one", () => {
		expect(draftForList(inputs({ $in: { status: ["Todo"] } })).properties).toEqual({
			status: "Todo",
		});
	});

	it("$in with multiple values does not pin", () => {
		expect(draftForList(inputs({ $in: { status: ["Todo", "Doing"] } })).properties).toEqual({});
	});

	it("$contains pins as a one-element list", () => {
		expect(draftForList(inputs({ $contains: { tags: "work" } })).properties).toEqual({
			tags: ["work"],
		});
	});

	it("$contains accumulates across two predicates and deduplicates repeated values", () => {
		// Two AND-combined $contains on the same path: the second appends only
		// if the value isn't already present.
		const draft = draftForList({
			source: null,
			viewFilters: {
				kind: FilterNodeKind.Group,
				op: FilterGroupOp.And,
				children: [
					{ kind: FilterNodeKind.Predicate, predicate: { $contains: { tags: "work" } } },
					{ kind: FilterNodeKind.Predicate, predicate: { $contains: { tags: "Q2" } } },
					{ kind: FilterNodeKind.Predicate, predicate: { $contains: { tags: "work" } } },
				],
			},
			defaultTypeUrl: null,
		});
		expect(draft.properties).toEqual({ tags: ["work", "Q2"] });
	});

	it("$allIn pins the entire array", () => {
		expect(draftForList(inputs({ $allIn: { tags: ["work", "Q2"] } })).properties).toEqual({
			tags: ["work", "Q2"],
		});
	});

	it("$gte pins the lower bound", () => {
		expect(draftForList(inputs({ $gte: { dueDate: "2026-01-01" } })).properties).toEqual({
			dueDate: "2026-01-01",
		});
	});

	it("$gte + $lte: the lower bound wins (in source-then-filter order)", () => {
		const merged = draftForList({
			source: {
				kind: ListSourceKind.ByFilter,
				where: {
					$and: [{ $gte: { dueDate: "2026-01-01" } }, { $lte: { dueDate: "2026-12-31" } }],
				},
			},
			viewFilters: null,
			defaultTypeUrl: null,
		});
		expect(merged.properties).toEqual({ dueDate: "2026-01-01" });
	});

	it("$lte alone pins to the upper bound (best we can do)", () => {
		expect(draftForList(inputs({ $lte: { dueDate: "2026-12-31" } })).properties).toEqual({
			dueDate: "2026-12-31",
		});
	});

	it("non-pinnable operators do not contribute", () => {
		const nonPinnable: PropertyPredicate[] = [
			{ $neq: { status: "Done" } },
			{ $notIn: { status: ["Archived"] } },
			{ $notContains: { tags: "blocked" } },
			{ $gt: { age: 18 } },
			{ $lt: { age: 65 } },
			{ $like: { title: "foo" } },
			{ $notLike: { title: "bar" } },
			{ $exists: { startedAt: true } },
			{ $empty: { finishedAt: true } },
			{ $not: { $eq: { status: "Cancelled" } } },
		];
		for (const p of nonPinnable) {
			expect(draftForList(inputs(p)).properties).toEqual({});
		}
	});
});

describe("draftForList — source + view filter composition", () => {
	it("merges source and view filter pinned values; view runs second", () => {
		const inputs: DraftInputs = {
			source: {
				kind: ListSourceKind.ByFilter,
				where: { $eq: { type: "Task", priority: "Low" } },
			},
			viewFilters: {
				kind: FilterNodeKind.Predicate,
				predicate: { $eq: { priority: "High" } },
			},
			defaultTypeUrl: "io.example/Task/v1",
		};
		const draft = draftForList(inputs);
		// View filter ran second and overrode the source's `priority`.
		expect(draft.properties).toEqual({ type: "Task", priority: "High" });
	});
});

describe("collectAndOnlyPredicates — sources", () => {
	it("returns nothing for a null source", () => {
		expect(collectAndOnlyPredicates(null)).toEqual([]);
	});

	it("returns nothing for byType / byLink / byVocabulary", () => {
		expect(
			collectAndOnlyPredicates({
				kind: ListSourceKind.ByType,
				types: ["a/B/v1"],
			}),
		).toEqual([]);
		expect(
			collectAndOnlyPredicates({
				kind: ListSourceKind.ByLink,
				linkType: "a/b/v1",
				direction: "in",
				anchorEntityId: "x",
			} as ListSource),
		).toEqual([]);
		expect(
			collectAndOnlyPredicates({
				kind: ListSourceKind.ByVocabulary,
				vocabularyId: "v1",
				values: ["a"],
			}),
		).toEqual([]);
	});

	it("returns the where of a byFilter source", () => {
		const where: PropertyPredicate = { $eq: { x: 1 } };
		expect(
			collectAndOnlyPredicates({
				kind: ListSourceKind.ByFilter,
				where,
			}),
		).toEqual([where]);
	});

	it("recurses into composite AND but stops at composite OR", () => {
		const where1: PropertyPredicate = { $eq: { a: 1 } };
		const where2: PropertyPredicate = { $eq: { b: 2 } };
		expect(
			collectAndOnlyPredicates({
				kind: ListSourceKind.Composite,
				op: CompositeOp.And,
				sources: [
					{ kind: ListSourceKind.ByFilter, where: where1 },
					{ kind: ListSourceKind.ByFilter, where: where2 },
				],
			}),
		).toEqual([where1, where2]);

		expect(
			collectAndOnlyPredicates({
				kind: ListSourceKind.Composite,
				op: CompositeOp.Or,
				sources: [
					{ kind: ListSourceKind.ByFilter, where: where1 },
					{ kind: ListSourceKind.ByFilter, where: where2 },
				],
			}),
		).toEqual([]);
	});
});

describe("collectAndOnlyPredicatesFromFilterNode", () => {
	it("returns [] for null", () => {
		expect(collectAndOnlyPredicatesFromFilterNode(null)).toEqual([]);
	});

	it("returns the predicate for a leaf node", () => {
		const p: PropertyPredicate = { $eq: { x: 1 } };
		expect(
			collectAndOnlyPredicatesFromFilterNode({
				kind: FilterNodeKind.Predicate,
				predicate: p,
			}),
		).toEqual([p]);
	});

	it("recurses into AND groups", () => {
		const a: PropertyPredicate = { $eq: { x: 1 } };
		const b: PropertyPredicate = { $eq: { y: 2 } };
		expect(
			collectAndOnlyPredicatesFromFilterNode({
				kind: FilterNodeKind.Group,
				op: FilterGroupOp.And,
				children: [
					{ kind: FilterNodeKind.Predicate, predicate: a },
					{ kind: FilterNodeKind.Predicate, predicate: b },
				],
			}),
		).toEqual([a, b]);
	});

	it("stops at OR groups", () => {
		const a: PropertyPredicate = { $eq: { x: 1 } };
		const b: PropertyPredicate = { $eq: { y: 2 } };
		expect(
			collectAndOnlyPredicatesFromFilterNode({
				kind: FilterNodeKind.Group,
				op: FilterGroupOp.Or,
				children: [
					{ kind: FilterNodeKind.Predicate, predicate: a },
					{ kind: FilterNodeKind.Predicate, predicate: b },
				],
			}),
		).toEqual([]);
	});
});

describe("draftForList — this object ($host) pins (9.12.24)", () => {
	const viewFilters: FilterNode = {
		kind: FilterNodeKind.Group,
		op: FilterGroupOp.And,
		children: [
			{ kind: FilterNodeKind.Predicate, predicate: { $contains: { authors: { $host: true } } } },
			{ kind: FilterNodeKind.Predicate, predicate: { $eq: { owner: { $host: true } } } },
		],
	};

	it("pre-fills the host into the relation a contextual view filters on", () => {
		const draft = draftForList({ ...noSource, viewFilters, hostEntityId: "page_1" });
		expect(draft.properties).toEqual({ authors: ["page_1"], owner: "page_1" });
	});

	it("pins nothing for a $host ref without a host", () => {
		expect(draftForList({ ...noSource, viewFilters }).properties).toEqual({});
	});
});
