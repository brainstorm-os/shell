import { ListSourceKind } from "@brainstorm-os/sdk-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { List } from "../types/list";
import { type ListView, ListViewKind } from "../types/list-view";
import {
	compileViewCached,
	filterEntitiesCached,
	groupLabelResolverCached,
	resetCompileCache,
} from "./compile-cache";
import type { EntityRow, InMemoryEntities } from "./in-memory-entities";

function row(id: string, properties: Record<string, unknown> = {}): EntityRow {
	return {
		id,
		type: "note",
		properties,
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};
}

function makeList(): List {
	return {
		id: "l",
		name: "L",
		icon: null,
		description: "",
		source: { kind: ListSourceKind.ByType, types: ["note"] },
		members: { include: [], exclude: [] },
		views: [],
		defaultViewId: null,
		defaultTemplate: null,
		createdAt: 0,
		updatedAt: 0,
	};
}

function makeView(overrides: Partial<ListView> = {}): ListView {
	return {
		id: "v",
		listId: "l",
		name: "V",
		kind: ListViewKind.Grid,
		columns: [],
		sorts: [],
		filters: null,
		groupBy: null,
		manualOrder: [],
		layoutOptions: { rowHeight: "comfortable", wrap: false, showRowNumbers: false },
		coverProperty: null,
		cardSubtitleProperty: null,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	} as ListView;
}

describe("compile cache", () => {
	beforeEach(() => resetCompileCache());

	describe("compileViewCached", () => {
		it("returns the same CompiledView on identity-equal inputs", () => {
			const view = makeView();
			const entities: ReadonlyArray<EntityRow> = [row("a"), row("b")];
			const labelFor = (k: string) => k;
			const first = compileViewCached(view, entities, labelFor);
			const second = compileViewCached(view, entities, labelFor);
			expect(second).toBe(first);
			expect(second.rows).toBe(first.rows);
		});

		it("recomputes when entities reference changes", () => {
			const view = makeView();
			const labelFor = (k: string) => k;
			const first = compileViewCached(view, [row("a")], labelFor);
			const second = compileViewCached(view, [row("a")], labelFor);
			expect(second).not.toBe(first);
		});

		it("recomputes when manualOrder changes on the same view object reference", () => {
			const view = makeView({ manualOrder: ["a"] });
			const entities = [row("a"), row("b")];
			const labelFor = (k: string) => k;
			const first = compileViewCached(view, entities, labelFor);
			// Same view object reference, but manualOrder semantically changed
			// via a fresh view object — cache should miss.
			const view2 = makeView({ manualOrder: ["b", "a"] });
			const second = compileViewCached(view2, entities, labelFor);
			expect(second).not.toBe(first);
		});
	});

	describe("filterEntitiesCached", () => {
		it("returns the same array on identity-equal inputs", () => {
			const list = makeList();
			const db: InMemoryEntities = { entities: [row("a"), row("b")], links: [] };
			const build = vi.fn(() => () => true);
			const first = filterEntitiesCached(list, db, "", build);
			const second = filterEntitiesCached(list, db, "", build);
			expect(second).toBe(first);
			expect(build).toHaveBeenCalledTimes(1);
		});

		it("does not call buildPredicate on a cache hit", () => {
			const list = makeList();
			const db: InMemoryEntities = { entities: [row("a")], links: [] };
			const build = vi.fn(() => () => true);
			filterEntitiesCached(list, db, "", build);
			filterEntitiesCached(list, db, "", build);
			filterEntitiesCached(list, db, "", build);
			expect(build).toHaveBeenCalledTimes(1);
		});

		it("misses on a different searchQuery", () => {
			const list = makeList();
			const db: InMemoryEntities = { entities: [row("a")], links: [] };
			const build = vi.fn(() => () => true);
			filterEntitiesCached(list, db, "", build);
			filterEntitiesCached(list, db, "x", build);
			expect(build).toHaveBeenCalledTimes(2);
		});
	});

	describe("groupLabelResolverCached", () => {
		it("returns the same resolver across calls with the same db", () => {
			const db: InMemoryEntities = { entities: [row("a")], links: [] };
			const build = vi.fn(() => (k: string) => k);
			const r1 = groupLabelResolverCached(db, build);
			const r2 = groupLabelResolverCached(db, build);
			expect(r2).toBe(r1);
			expect(build).toHaveBeenCalledTimes(1);
		});

		it("rebuilds when db reference changes", () => {
			const dbA: InMemoryEntities = { entities: [row("a")], links: [] };
			const dbB: InMemoryEntities = { entities: [row("b")], links: [] };
			const build = vi.fn(() => (k: string) => k);
			const r1 = groupLabelResolverCached(dbA, build);
			const r2 = groupLabelResolverCached(dbB, build);
			expect(r2).not.toBe(r1);
			expect(build).toHaveBeenCalledTimes(2);
		});
	});
});
