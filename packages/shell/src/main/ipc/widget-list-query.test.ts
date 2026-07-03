/**
 * Widget-bridge list-query filtering (F-384) — the pure halves of the
 * `widget-bridge:list-entities` handler: wire-value validation and snapshot
 * narrowing. The IPC + capability gate itself is exercised in the
 * real-Electron dogfood sessions.
 */

import { describe, expect, it } from "vitest";
import type { VaultEntitiesSnapshot } from "../entities/vault-entities-service";
import {
	filterWidgetSnapshot,
	parseWidgetListQuery,
	resolveWidgetListAccess,
} from "./widget-list-query";

function entity(id: string, type: string, updatedAt: number, deletedAt: number | null = null) {
	return { id, type, properties: {}, createdAt: 0, updatedAt, deletedAt, ownerAppId: "app" };
}

const SNAPSHOT: VaultEntitiesSnapshot = {
	entities: [
		entity("n1", "Note/v1", 30),
		entity("n2", "Note/v1", 10),
		entity("n3", "Note/v1", 20, 99), // deleted
		entity("t1", "Task/v1", 40),
	],
	links: [
		{ srcEntityId: "n1", destEntityId: "t1" },
		{ srcEntityId: "t1", destEntityId: "n2" },
	] as never,
};

describe("parseWidgetListQuery", () => {
	it("accepts {types, limit} and clamps the limit", () => {
		expect(parseWidgetListQuery({ types: ["a"], limit: 9999 })).toEqual({
			types: ["a"],
			limit: 500,
		});
	});
	it("rejects junk shapes", () => {
		expect(parseWidgetListQuery(undefined)).toBeNull();
		expect(parseWidgetListQuery("x")).toBeNull();
		expect(parseWidgetListQuery({})).toBeNull();
		expect(parseWidgetListQuery({ types: [1] })).toBeNull();
		expect(parseWidgetListQuery({ limit: 0 })).toBeNull();
		expect(parseWidgetListQuery({ limit: Number.NaN })).toBeNull();
	});
	it("floors a fractional limit", () => {
		expect(parseWidgetListQuery({ limit: 3.7 })).toEqual({ limit: 3 });
	});
});

describe("filterWidgetSnapshot", () => {
	it("filters by type and drops links to excluded destinations", () => {
		const out = filterWidgetSnapshot(SNAPSHOT, { types: ["Note/v1"] });
		expect(out.entities.map((e) => e.id)).toEqual(["n1", "n2", "n3"]);
		expect(out.links).toEqual([{ srcEntityId: "t1", destEntityId: "n2" }]);
	});

	it("limit implies live-only + newest-first", () => {
		const out = filterWidgetSnapshot(SNAPSHOT, { types: ["Note/v1"], limit: 1 });
		expect(out.entities.map((e) => e.id)).toEqual(["n1"]); // n3 deleted, n1 newest
	});

	it("returns the snapshot untouched for an empty query", () => {
		expect(filterWidgetSnapshot(SNAPSHOT, {})).toBe(SNAPSHOT);
	});
});

describe("resolveWidgetListAccess", () => {
	const capsOf = (granted: string[]) => (cap: string) => granted.includes(cap);

	it("wildcard read passes with or without a query", () => {
		const has = capsOf(["entities.read:*"]);
		expect(resolveWidgetListAccess(has, null)).toEqual({ allowed: true, enforced: null });
		const q = { types: ["Book/v1"] };
		expect(resolveWidgetListAccess(has, q)).toEqual({ allowed: true, enforced: q });
	});

	it("a scoped app is admitted only through a typed query it is granted", () => {
		const has = capsOf(["entities.read:Book/v1"]);
		// no query → denied (would leak the whole vault)
		expect(resolveWidgetListAccess(has, null).allowed).toBe(false);
		// covered typed query → allowed, filter enforced
		const q = { types: ["Book/v1"], limit: 8 };
		expect(resolveWidgetListAccess(has, q)).toEqual({ allowed: true, enforced: q });
		// a type outside its grants → denied
		expect(resolveWidgetListAccess(has, { types: ["Book/v1", "Note/v1"] }).allowed).toBe(false);
		// a limit-only query names no types → denied
		expect(resolveWidgetListAccess(has, { limit: 5 }).allowed).toBe(false);
	});
});
