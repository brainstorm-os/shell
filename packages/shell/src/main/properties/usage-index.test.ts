/**
 * Tests for the property + dictionary usage index (B5.10 shell half).
 *
 *  - Pure counters round-trip every meaningful entity-shape (empty,
 *    null, false, 0, "", [], multi-value array).
 *  - Dictionary counter respects vocabulary binding + skips archived
 *    items + collapses multi-tags to one entity-per-dictionary.
 *  - Lazy `UsageIndex` caches, invalidates, dedupes concurrent reads,
 *    and degrades to the empty snapshot on reader failure.
 */

import { ValueType } from "@brainstorm-os/sdk-types";
import type { Dictionary, PropertyDef } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { VaultEntity } from "../entities/vault-entities-service";
import {
	EMPTY_USAGE_COUNTS,
	UsageIndex,
	computeDictionaryTotalsFromItems,
	computeDictionaryUsage,
	computePropertyUsage,
	computeUsageCounts,
} from "./usage-index";

const now = 1_700_000_000_000;

function entity(id: string, properties: Record<string, unknown>): VaultEntity {
	return {
		id,
		type: "io.brainstorm.notes/Note/v1",
		properties,
		createdAt: now,
		updatedAt: now,
		deletedAt: null,
		ownerAppId: "io.brainstorm.notes",
	};
}

function prop(key: string, valueType: ValueType, dictionaryId?: string): PropertyDef {
	const def: PropertyDef = {
		key,
		name: key,
		icon: null,
		valueType,
	};
	if (dictionaryId) def.vocabulary = { dictionaryId };
	return def;
}

function dict(id: string, items: Array<{ id: string; archived?: boolean }>): Dictionary {
	return {
		id,
		name: id,
		items: items.map((it, i) => ({
			id: it.id,
			label: it.id,
			icon: null,
			sortIndex: i,
			...(it.archived ? { archivedAt: now } : {}),
		})),
	};
}

describe("computePropertyUsage", () => {
	it("counts only non-empty values", () => {
		const counts = computePropertyUsage([
			entity("e1", { title: "x", status: "todo", tags: [] }),
			entity("e2", { title: "", status: "done", tags: ["a"] }),
			entity("e3", { title: null, status: undefined, tags: ["a", "b"] }),
		]);
		expect(counts).toEqual({ title: 1, status: 2, tags: 2 });
	});

	it("treats falsy primitives (false, 0) as real values", () => {
		const counts = computePropertyUsage([
			entity("e1", { archived: false, count: 0 }),
			entity("e2", { archived: true, count: 5 }),
		]);
		expect(counts).toEqual({ archived: 2, count: 2 });
	});

	it("handles entities with no properties", () => {
		expect(computePropertyUsage([])).toEqual({});
		expect(computePropertyUsage([entity("e1", {})])).toEqual({});
	});

	it("ignores entries whose properties payload is not an object", () => {
		const bad = { ...entity("e1", {}) } as VaultEntity;
		(bad as unknown as { properties: unknown }).properties = null;
		expect(computePropertyUsage([bad])).toEqual({});
	});

	it("treats nested-empty objects as no-value", () => {
		const counts = computePropertyUsage([
			entity("e1", { meta: {} }),
			entity("e2", { meta: { x: 1 } }),
		]);
		expect(counts).toEqual({ meta: 1 });
	});
});

describe("computeDictionaryUsage (per-item counts)", () => {
	const statusProp = prop("status", ValueType.Text, "d-status");
	const tagsProp = prop("tags", ValueType.Text, "d-tags");
	const titleProp = prop("title", ValueType.Text);

	const dStatus = dict("d-status", [
		{ id: "todo" },
		{ id: "done" },
		{ id: "abandoned", archived: true },
	]);
	const dTags = dict("d-tags", [{ id: "red" }, { id: "blue" }]);

	const catalog = {
		status: statusProp,
		tags: tagsProp,
		title: titleProp,
	} satisfies Record<string, PropertyDef>;

	const dicts = { "d-status": dStatus, "d-tags": dTags };

	it("credits each cited item per entity, collapsing duplicates inside one array", () => {
		const counts = computeDictionaryUsage(
			[
				entity("e1", { status: "todo", tags: ["red", "blue"] }),
				entity("e2", { status: "done", tags: ["red", "red"] }),
				entity("e3", { status: "", tags: [] }),
			],
			catalog,
			dicts,
		);
		expect(counts).toEqual({ todo: 1, done: 1, red: 2, blue: 1 });
	});

	it("ignores values pointing at archived items", () => {
		const counts = computeDictionaryUsage(
			[entity("e1", { status: "abandoned" }), entity("e2", { status: "todo" })],
			catalog,
			dicts,
		);
		expect(counts).toEqual({ todo: 1 });
	});

	it("ignores values pointing at unknown ids (stale references after item delete)", () => {
		const counts = computeDictionaryUsage(
			[entity("e1", { status: "ghost" }), entity("e2", { tags: ["green"] })],
			catalog,
			dicts,
		);
		expect(counts).toEqual({});
	});

	it("returns {} when no property is vocabulary-bound", () => {
		const counts = computeDictionaryUsage(
			[entity("e1", { title: "x" })],
			{ title: titleProp },
			dicts,
		);
		expect(counts).toEqual({});
	});

	it("returns {} when no dictionaries are present", () => {
		expect(computeDictionaryUsage([entity("e1", { status: "todo" })], catalog, {})).toEqual({});
	});
});

describe("computeDictionaryTotalsFromItems (per-dictionary aggregate)", () => {
	const tagsProp = prop("tags", ValueType.Text, "d-tags");
	const dTags = dict("d-tags", [{ id: "red" }, { id: "blue" }, { id: "stale", archived: true }]);

	it("collapses multi-tags from the same dictionary to one entity", () => {
		const totals = computeDictionaryTotalsFromItems(
			[
				entity("e1", { tags: ["red", "blue"] }),
				entity("e2", { tags: ["red"] }),
				entity("e3", { tags: ["stale"] }),
				entity("e4", { tags: [] }),
			],
			{ tags: tagsProp },
			{ "d-tags": dTags },
		);
		expect(totals).toEqual({ "d-tags": 2 });
	});

	it("returns {} when no dictionaries are present", () => {
		expect(
			computeDictionaryTotalsFromItems([entity("e1", { tags: ["red"] })], { tags: tagsProp }, {}),
		).toEqual({});
	});
});

describe("computeUsageCounts (composite)", () => {
	it("emits both indices in one pass with the same numbers as the pure halves", () => {
		const entities = [
			entity("e1", { title: "x", status: "todo" }),
			entity("e2", { title: "y", status: "done" }),
		];
		const props = {
			title: prop("title", ValueType.Text),
			status: prop("status", ValueType.Text, "d"),
		};
		const dicts = { d: dict("d", [{ id: "todo" }, { id: "done" }]) };
		const out = computeUsageCounts(entities, props, dicts);
		expect(out.propertyUsage).toEqual({ title: 2, status: 2 });
		expect(out.dictionaryUsage).toEqual({ todo: 1, done: 1 });
	});
});

describe("UsageIndex (lazy + invalidating)", () => {
	it("caches the snapshot until invalidated", async () => {
		let readCount = 0;
		const index = new UsageIndex({
			readEntities: async () => {
				readCount += 1;
				return [entity("e1", { title: "x" })];
			},
			readCatalog: () => ({ properties: {}, dictionaries: {} }),
		});

		const a = await index.snapshot();
		const b = await index.snapshot();
		expect(readCount).toBe(1);
		expect(b).toBe(a);
		expect(a.propertyUsage).toEqual({ title: 1 });

		index.invalidate();
		await index.snapshot();
		expect(readCount).toBe(2);
	});

	it("dedupes concurrent in-flight recomputes", async () => {
		let readCount = 0;
		let resolve!: (entities: VaultEntity[]) => void;
		const pending = new Promise<VaultEntity[]>((res) => {
			resolve = res;
		});
		const index = new UsageIndex({
			readEntities: () => {
				readCount += 1;
				return pending;
			},
			readCatalog: () => ({ properties: {}, dictionaries: {} }),
		});
		const a = index.snapshot();
		const b = index.snapshot();
		resolve([entity("e1", { title: "x" })]);
		const [aR, bR] = await Promise.all([a, b]);
		expect(readCount).toBe(1);
		expect(aR).toBe(bR);
		expect(aR.propertyUsage).toEqual({ title: 1 });
	});

	it("falls back to the empty snapshot when the entities reader throws", async () => {
		const index = new UsageIndex({
			readEntities: async () => {
				throw new Error("storage down");
			},
			readCatalog: () => ({ properties: {}, dictionaries: {} }),
		});
		const snap = await index.snapshot();
		expect(snap).toBe(EMPTY_USAGE_COUNTS);
	});

	it("falls back to the empty snapshot when the catalog reader throws", async () => {
		const index = new UsageIndex({
			readEntities: async () => [],
			readCatalog: () => {
				throw new Error("properties down");
			},
		});
		const snap = await index.snapshot();
		expect(snap).toBe(EMPTY_USAGE_COUNTS);
	});

	it("recovers after a transient failure when invalidate() is called", async () => {
		let fail = true;
		const index = new UsageIndex({
			readEntities: async () => {
				if (fail) throw new Error("blip");
				return [entity("e1", { title: "x" })];
			},
			readCatalog: () => ({ properties: {}, dictionaries: {} }),
		});
		expect(await index.snapshot()).toBe(EMPTY_USAGE_COUNTS);
		fail = false;
		index.invalidate();
		const recovered = await index.snapshot();
		expect(recovered.propertyUsage).toEqual({ title: 1 });
	});
});
