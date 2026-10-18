import { type PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	inversePairs,
	multiplicityOf,
	planInverseBackfill,
	planInverseWrites,
	withRef,
	withoutRef,
} from "./inverse-relations";

function ref(key: string, extra: Partial<PropertyDef> = {}): PropertyDef {
	return { key, name: key, icon: null, valueType: ValueType.EntityRef, ...extra };
}

const MANY = { count: { min: 0, max: 50 } };
const defs: PropertyDef[] = [
	ref("authors", { ...MANY, inverseOf: "books" }),
	ref("books", MANY),
	ref("owner", { inverseOf: "owns" }),
	ref("owns", MANY),
	ref("related", { ...MANY, inverseOf: "related" }),
];
const pairs = inversePairs(defs);
const multi = multiplicityOf(defs);

function reader(db: Record<string, Record<string, unknown>>) {
	return (id: string) => db[id] ?? null;
}

describe("inversePairs", () => {
	it("maps both directions, including a self-pair", () => {
		expect(pairs.get("authors")).toBe("books");
		expect(pairs.get("books")).toBe("authors");
		expect(pairs.get("related")).toBe("related");
	});

	it("ignores a pair whose partner is missing or not a relation, and ambiguous pairs", () => {
		const p = inversePairs([
			ref("a", { inverseOf: "ghost" }),
			{ key: "t", name: "t", icon: null, valueType: ValueType.Text },
			ref("b", { inverseOf: "t" }),
			ref("x", { inverseOf: "y" }),
			ref("z", { inverseOf: "y" }),
			ref("y"),
		]);
		expect(p.size).toBe(0);
	});
});

describe("withRef / withoutRef", () => {
	it("keeps the stored shape", () => {
		expect(withRef(null, "e1", true)).toEqual([{ value: "e1" }]);
		expect(withRef(["e0"], "e1", true)).toEqual(["e0", "e1"]);
		expect(withRef([{ value: "e1" }], "e1", true)).toEqual([{ value: "e1" }]);
		expect(withRef("e0", "e1", false)).toBe("e1");
		expect(withoutRef([{ value: "e1" }, { value: "e2" }], "e1")).toEqual([{ value: "e2" }]);
		expect(withoutRef("e1", "e1")).toBeNull();
		expect(withoutRef("e2", "e1")).toBe("e2");
	});
});

describe("planInverseWrites", () => {
	it("adds and removes on the far end", () => {
		const db = {
			p1: { books: [{ value: "b1" }] },
			p2: { books: [] },
			p3: {},
		};
		const writes = planInverseWrites({
			entityId: "b1",
			before: { authors: [{ value: "p1" }, { value: "p2" }] },
			after: { authors: [{ value: "p2" }, { value: "p3" }] },
			pairs,
			multi,
			read: reader(db),
		});
		expect(writes).toEqual([
			{ entityId: "p1", patch: { books: [] } },
			{ entityId: "p3", patch: { books: [{ value: "b1" }] } },
		]);
	});

	it("a single-valued far end displaces its previous target", () => {
		const db = {
			task: { owner: "old" },
			old: { owns: [{ value: "task" }, { value: "t2" }] },
			me: { owns: [] },
		};
		const writes = planInverseWrites({
			entityId: "me",
			before: { owns: [] },
			after: { owns: [{ value: "task" }] },
			pairs,
			multi,
			read: reader(db),
		});
		expect(writes).toEqual([
			{ entityId: "old", patch: { owns: [{ value: "t2" }] } },
			{ entityId: "task", patch: { owner: "me" } },
		]);
	});

	it("a delete (after = {}) cleans every far end", () => {
		const db = { p1: { books: [{ value: "b1" }, { value: "b2" }] }, r: { related: ["b1"] } };
		const writes = planInverseWrites({
			entityId: "b1",
			before: { authors: [{ value: "p1" }], related: ["r"] },
			after: {},
			pairs,
			multi,
			read: reader(db),
		});
		expect(writes).toEqual([
			{ entityId: "p1", patch: { books: [{ value: "b2" }] } },
			{ entityId: "r", patch: { related: [] } },
		]);
	});

	it("skips missing far ends, self references and untouched keys", () => {
		const writes = planInverseWrites({
			entityId: "b1",
			before: {},
			after: { authors: [{ value: "gone" }, { value: "b1" }], title: "x" },
			pairs,
			multi,
			read: reader({}),
		});
		expect(writes).toEqual([]);
	});
});

describe("planInverseBackfill", () => {
	it("makes every one-sided reference two-sided, both directions", () => {
		const rows = [
			{ id: "b1", properties: { authors: [{ value: "p1" }] } },
			{ id: "b2", properties: {} },
			{ id: "p1", properties: { books: [{ value: "b2" }] } },
		];
		const writes = planInverseBackfill({ key: "authors", inverse: "books", rows, multi });
		expect(writes).toEqual([
			{ entityId: "p1", patch: { books: [{ value: "b2" }, { value: "b1" }] } },
			{ entityId: "b2", patch: { authors: [{ value: "p1" }] } },
		]);
	});

	it("never overwrites an occupied single-valued side", () => {
		const rows = [
			{ id: "me", properties: { owns: [{ value: "task" }] } },
			{ id: "task", properties: { owner: "someone" } },
			{ id: "someone", properties: {} },
		];
		expect(planInverseBackfill({ key: "owner", inverse: "owns", rows, multi })).toEqual([
			{ entityId: "someone", patch: { owns: [{ value: "task" }] } },
		]);
	});
});
