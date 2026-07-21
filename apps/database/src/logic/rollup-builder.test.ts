import { ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { AggregationKind } from "./aggregations";
import type { EntityRow } from "./in-memory-entities";
import { entitiesById } from "./rollup";
import {
	buildRollupColumn,
	defaultRollupName,
	rollupAggregationOptions,
	rollupColumnId,
	rollupRelationCandidates,
	rollupTargetCandidates,
} from "./rollup-builder";

function row(id: string, type: string, properties: Record<string, unknown>): EntityRow {
	return { id, type, properties, createdAt: 0, updatedAt: 0, deletedAt: null };
}

// An Engagements ⇄ Deliverables vault: engagements link to deliverables via the
// `deliverables` relation; deliverables carry a `fee` (number) and `done` (bool).
const deliverables = [
	row("d_1", "Deliverable", { name: "Logo", fee: 1000, done: true }),
	row("d_2", "Deliverable", { name: "Site", fee: 2500, done: false }),
];
const engagements = [
	row("eng_1", "Engagement", { name: "Acme", deliverables: [{ value: "d_1" }, { value: "d_2" }] }),
	row("eng_2", "Engagement", { name: "Globex", lead: "d_1", note: "nothing-links-out" }),
];
const allRows = [...engagements, ...deliverables];
const byId = entitiesById(allRows);
const nameOf = (key: string): string => key.charAt(0).toUpperCase() + key.slice(1);

describe("rollupRelationCandidates", () => {
	it("finds properties whose values resolve to live entities, with target types", () => {
		const relations = rollupRelationCandidates(engagements, byId, nameOf);
		const keys = relations.map((r) => r.key);
		expect(keys).toContain("deliverables");
		expect(keys).toContain("lead");
		// `name` / `note` are plain strings that resolve to no entity → not relations.
		expect(keys).not.toContain("name");
		expect(keys).not.toContain("note");
		const deliverablesRel = relations.find((r) => r.key === "deliverables");
		expect(deliverablesRel?.targetTypes).toEqual(["Deliverable"]);
		expect(deliverablesRel?.name).toBe("Deliverables");
	});

	it("returns nothing when no property links to a live entity", () => {
		expect(rollupRelationCandidates([row("x", "T", { a: "plain", b: 7 })], byId, nameOf)).toEqual([]);
	});
});

describe("rollupTargetCandidates", () => {
	it("offers the linked entities' properties with inferred value types", () => {
		const targets = rollupTargetCandidates("deliverables", engagements, byId, nameOf);
		const byKey = new Map(targets.map((t) => [t.key, t.valueType]));
		expect(byKey.get("fee")).toBe(ValueType.Number);
		expect(byKey.get("done")).toBe(ValueType.Boolean);
		expect(byKey.get("name")).toBe(ValueType.Text);
		// System / plumbing fields are not target candidates.
		expect(byKey.has("id")).toBe(false);
		expect(byKey.has("type")).toBe(false);
	});

	it("returns nothing for a relation that resolves to no entities", () => {
		expect(rollupTargetCandidates("missing", engagements, byId, nameOf)).toEqual([]);
	});
});

describe("rollupAggregationOptions", () => {
	it("scopes to the target type and drops the no-op None", () => {
		const numberKinds = rollupAggregationOptions(ValueType.Number).map((o) => o.kind);
		expect(numberKinds).toContain(AggregationKind.Sum);
		expect(numberKinds).toContain(AggregationKind.Average);
		expect(numberKinds).not.toContain(AggregationKind.None);
		// Text only gets the universal count family — no Sum.
		expect(rollupAggregationOptions(ValueType.Text).map((o) => o.kind)).not.toContain(
			AggregationKind.Sum,
		);
	});

	it("labels each option", () => {
		const sum = rollupAggregationOptions(ValueType.Number).find(
			(o) => o.kind === AggregationKind.Sum,
		);
		expect(sum?.label).toBe("Sum");
	});
});

describe("buildRollupColumn", () => {
	it("builds a visible column with a spec-derived id and string aggregation", () => {
		const column = buildRollupColumn({
			relationKey: "deliverables",
			targetPropertyKey: "fee",
			targetName: "Fee",
			aggregation: AggregationKind.Sum,
		});
		expect(column.visible).toBe(true);
		expect(column.propertyId).toBe(rollupColumnId("deliverables", "fee", AggregationKind.Sum));
		expect(column.rollup).toEqual({
			relationKey: "deliverables",
			targetPropertyKey: "fee",
			aggregation: "sum",
			name: "Sum of Fee",
		});
	});

	it("honors an explicit name override", () => {
		const column = buildRollupColumn({
			relationKey: "deliverables",
			targetPropertyKey: "fee",
			targetName: "Fee",
			aggregation: AggregationKind.Sum,
			name: "Total fee",
		});
		expect(column.rollup?.name).toBe("Total fee");
	});

	it("gives distinct ids per (relation, target, aggregation)", () => {
		expect(rollupColumnId("r", "t", AggregationKind.Sum)).not.toBe(
			rollupColumnId("r", "t", AggregationKind.Average),
		);
	});
});

describe("defaultRollupName", () => {
	it('reads "<Aggregation> of <Target>"', () => {
		expect(defaultRollupName("Fee", AggregationKind.Sum)).toBe("Sum of Fee");
		expect(defaultRollupName("Due date", AggregationKind.Latest)).toBe("Latest of Due date");
	});
});
