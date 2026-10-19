/**
 * Tests for `buildColumnAdderOptions` + `appendColumnForProperty`.
 * The pure half of 9.3.5.U.b — the renderer's option list driver.
 */

import { type PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { ColumnSpec } from "../types/list-view";
import {
	ColumnAdderOptionKind,
	PropertyReuseKind,
	appendColumnForProperty,
	buildColumnAdderOptions,
	findReusablePropertyDef,
	resolvePropertyReuse,
} from "./column-adder";

function def(key: string, name: string, valueType: ValueType = ValueType.Text): PropertyDef {
	return {
		key,
		name,
		icon: null,
		valueType,
	};
}

function col(propertyId: string): ColumnSpec {
	return { propertyId, visible: true };
}

describe("buildColumnAdderOptions", () => {
	it("always ends with a CreateNew option even on an empty input", () => {
		const out = buildColumnAdderOptions({
			existingColumns: [],
			vaultProperties: [],
			dataDerivedProps: [],
		});
		expect(out.length).toBe(1);
		expect(out[0]?.kind).toBe(ColumnAdderOptionKind.CreateNew);
	});

	it("surfaces vault properties as Existing with valueType subtitles", () => {
		const out = buildColumnAdderOptions({
			existingColumns: [],
			vaultProperties: [def("author", "Author", ValueType.Text)],
			dataDerivedProps: [],
		});
		expect(out[0]).toEqual({
			kind: ColumnAdderOptionKind.Existing,
			propertyId: "author",
			label: "Author",
			subtitle: "Text",
		});
	});

	it("collapses duplicate catalog defs with the same name + type to one entry (F-034)", () => {
		const out = buildColumnAdderOptions({
			existingColumns: [],
			// Four "Deal size · Number" defs (distinct generated keys) + one of a
			// different type that must NOT be collapsed away.
			vaultProperties: [
				def("prop_a", "Deal size", ValueType.Number),
				def("prop_b", "Deal size", ValueType.Number),
				def("prop_c", "Deal size", ValueType.Number),
				def("prop_d", "Deal size", ValueType.Number),
				def("prop_e", "Deal size", ValueType.Text),
			],
			dataDerivedProps: [],
		});
		const existing = out.filter((o) => o.kind === ColumnAdderOptionKind.Existing);
		// One "Deal size · Number" (first def wins the slot) + one "Deal size · Text".
		expect(existing.length).toBe(2);
		expect(existing[0]).toMatchObject({
			propertyId: "prop_a",
			label: "Deal size",
			subtitle: "Number",
		});
		expect(
			existing.some((o) => o.kind === ColumnAdderOptionKind.Existing && o.propertyId === "prop_e"),
		).toBe(true);
	});

	it("surfaces data-derived ids as DataDerived with a humanized label", () => {
		const out = buildColumnAdderOptions({
			existingColumns: [],
			vaultProperties: [],
			dataDerivedProps: ["due_date", "ownerName", "tags"],
		});
		const labels = out
			.filter((o) => o.kind === ColumnAdderOptionKind.DataDerived)
			.map((o) => (o as { label: string }).label);
		expect(labels).toEqual(expect.arrayContaining(["Due date", "Owner Name", "Tags"]));
	});

	it("filters out properties already represented as columns", () => {
		const out = buildColumnAdderOptions({
			existingColumns: [col("author"), col("tags")],
			vaultProperties: [def("author", "Author"), def("status", "Status")],
			dataDerivedProps: ["tags", "due_date"],
		});
		const propIds = out
			.filter((o) => o.kind !== ColumnAdderOptionKind.CreateNew)
			.map((o) => (o as { propertyId: string }).propertyId);
		expect(propIds).not.toContain("author");
		expect(propIds).not.toContain("tags");
		expect(propIds).toEqual(expect.arrayContaining(["status", "due_date"]));
	});

	it("dedupes vault-defined properties out of the data-derived list (Existing wins)", () => {
		const out = buildColumnAdderOptions({
			existingColumns: [],
			vaultProperties: [def("author", "Author")],
			dataDerivedProps: ["author"],
		});
		const propIds = out
			.filter((o) => o.kind !== ColumnAdderOptionKind.CreateNew)
			.map((o) => (o as { propertyId: string }).propertyId);
		// `author` shows up exactly once — as Existing.
		expect(propIds.filter((id) => id === "author").length).toBe(1);
		expect(out[0]?.kind).toBe(ColumnAdderOptionKind.Existing);
	});

	it("groups Existing before DataDerived before CreateNew (KIND_RANK)", () => {
		const out = buildColumnAdderOptions({
			existingColumns: [],
			vaultProperties: [def("zeta", "Zeta")],
			dataDerivedProps: ["alpha"],
		});
		expect(out.map((o) => o.kind)).toEqual([
			ColumnAdderOptionKind.Existing,
			ColumnAdderOptionKind.DataDerived,
			ColumnAdderOptionKind.CreateNew,
		]);
	});

	it("sorts within a kind alphabetically by label (case-insensitive)", () => {
		const out = buildColumnAdderOptions({
			existingColumns: [],
			vaultProperties: [
				def("z", "Zeta"),
				def("a", "Alpha"),
				def("m", "mango"), // lowercase
			],
			dataDerivedProps: [],
		});
		const labels = out
			.filter((o) => o.kind === ColumnAdderOptionKind.Existing)
			.map((o) => (o as { label: string }).label);
		expect(labels).toEqual(["Alpha", "mango", "Zeta"]);
	});

	it("filters by query (case-insensitive substring on label and propertyId)", () => {
		const out = buildColumnAdderOptions({
			existingColumns: [],
			vaultProperties: [def("status", "Status"), def("author", "Author")],
			dataDerivedProps: ["due_date"],
			query: "Auth",
		});
		const ids = out
			.filter((o) => o.kind !== ColumnAdderOptionKind.CreateNew)
			.map((o) => (o as { propertyId: string }).propertyId);
		expect(ids).toEqual(["author"]);
	});

	it("seeds the CreateNew option with the trimmed query so the form pre-fills the name", () => {
		const empty = buildColumnAdderOptions({
			existingColumns: [],
			vaultProperties: [],
			dataDerivedProps: [],
			query: "  ",
		}).at(-1);
		expect(empty?.kind).toBe(ColumnAdderOptionKind.CreateNew);
		expect((empty as { seedName: string }).seedName).toBe("");

		const seeded = buildColumnAdderOptions({
			existingColumns: [],
			vaultProperties: [],
			dataDerivedProps: [],
			query: "  Sprint Goal  ",
		}).at(-1);
		expect((seeded as { seedName: string }).seedName).toBe("Sprint Goal");
		expect((seeded as { label: string }).label).toContain('"Sprint Goal"');
	});

	it("matching is case-insensitive against propertyId for DataDerived", () => {
		// User types "DUE" — matches `due_date` even though casing differs.
		const out = buildColumnAdderOptions({
			existingColumns: [],
			vaultProperties: [],
			dataDerivedProps: ["due_date", "tags"],
			query: "DUE",
		});
		const ids = out
			.filter((o) => o.kind === ColumnAdderOptionKind.DataDerived)
			.map((o) => (o as { propertyId: string }).propertyId);
		expect(ids).toEqual(["due_date"]);
	});

	it("falls back to the property key when the def has no name", () => {
		const out = buildColumnAdderOptions({
			existingColumns: [],
			vaultProperties: [{ key: "raw_id", name: "", icon: null, valueType: ValueType.Text }],
			dataDerivedProps: [],
		});
		expect((out[0] as { label: string }).label).toBe("raw_id");
	});
});

describe("appendColumnForProperty", () => {
	it("appends a new visible column at the end", () => {
		const before: ColumnSpec[] = [col("title"), col("status")];
		const after = appendColumnForProperty(before, "tags");
		expect(after).toHaveLength(3);
		expect(after.at(-1)).toEqual({ propertyId: "tags", visible: true });
	});

	it("is idempotent — a propertyId already present returns the same shape (no double column)", () => {
		const before: ColumnSpec[] = [col("title")];
		const after = appendColumnForProperty(before, "title");
		expect(after).toEqual(before);
		// Returns a copy, not the same reference (so callers can mutate without
		// affecting the input).
		expect(after).not.toBe(before);
	});

	it("returns a fresh array (input remains immutable)", () => {
		const before: ColumnSpec[] = [col("title")];
		const after = appendColumnForProperty(before, "new");
		expect(before).toHaveLength(1);
		expect(after).toHaveLength(2);
	});
});

describe("findReusablePropertyDef (F-034)", () => {
	const catalog: PropertyDef[] = [
		def("prop_a", "Deal size", ValueType.Number),
		def("prop_b", "Status", ValueType.Text),
	];

	it("matches an existing def by case-insensitive name + value type", () => {
		expect(findReusablePropertyDef(catalog, "  deal SIZE ", ValueType.Number)?.key).toBe("prop_a");
	});

	it("does not match when the value type differs (same name, different kind)", () => {
		expect(findReusablePropertyDef(catalog, "Deal size", ValueType.Text)).toBeNull();
	});

	it("returns null for a genuinely new name (so a fresh def is minted)", () => {
		expect(findReusablePropertyDef(catalog, "Last contact", ValueType.Date)).toBeNull();
	});

	it("returns null for a blank name", () => {
		expect(findReusablePropertyDef(catalog, "   ", ValueType.Number)).toBeNull();
	});
});

describe("resolvePropertyReuse (F-508)", () => {
	const relation = (key: string, name: string, extra: Partial<PropertyDef> = {}): PropertyDef => ({
		...def(key, name, ValueType.EntityRef),
		...extra,
	});
	const project = relation("prop_project", "Project");
	const catalog: PropertyDef[] = [project, def("prop_a", "Deal size", ValueType.Number)];

	it("creates when no catalog def shares the name + type", () => {
		const draft = relation("prop_new", "Owner");
		expect(resolvePropertyReuse(catalog, { def: draft })).toEqual({
			kind: PropertyReuseKind.Create,
		});
	});

	it("reuses when the draft expresses no relation settings (same name + type is the same property)", () => {
		const draft = relation("prop_new", "project");
		expect(resolvePropertyReuse(catalog, { def: draft })).toEqual({
			kind: PropertyReuseKind.Reuse,
			def: project,
		});
	});

	it("reuses when the draft's target + pairing match the existing def", () => {
		const existing = relation("prop_project", "Project", {
			allowedTypes: ["Project/v1"],
			inverseOf: "prop_tasks",
		});
		const draft = relation("prop_new", "Project", {
			allowedTypes: ["Project/v1"],
			inverseOf: "prop_tasks",
		});
		expect(resolvePropertyReuse([existing], { def: draft }).kind).toBe(PropertyReuseKind.Reuse);
	});

	it("adopts a new target onto the existing def instead of dropping it", () => {
		const draft = relation("prop_new", "Project", { allowedTypes: ["Project/v1"] });
		const decision = resolvePropertyReuse(catalog, { def: draft });
		expect(decision).toEqual({
			kind: PropertyReuseKind.Adopt,
			def: { ...project, allowedTypes: ["Project/v1"] },
		});
	});

	it("adopts a brand-new paired property, re-pointing the partner at the existing key", () => {
		const draft = relation("prop_new", "Project", { inverseOf: "prop_partner" });
		const partner = relation("prop_partner", "Tasks", { inverseOf: "prop_new" });
		const decision = resolvePropertyReuse(catalog, { def: draft, partner });
		expect(decision).toEqual({
			kind: PropertyReuseKind.Adopt,
			def: { ...project, inverseOf: "prop_partner" },
			partner: { ...partner, inverseOf: "prop_project" },
		});
	});

	it("maps a self-pairing onto the existing def's own key", () => {
		const draft = relation("prop_new", "Project", { inverseOf: "prop_new" });
		const decision = resolvePropertyReuse(catalog, { def: draft });
		expect(decision).toEqual({
			kind: PropertyReuseKind.Adopt,
			def: { ...project, inverseOf: "prop_project" },
		});
	});

	it("adopts a pairing with an existing relation", () => {
		const draft = relation("prop_new", "Project", { inverseOf: "prop_tasks" });
		const decision = resolvePropertyReuse(catalog, { def: draft });
		expect(decision).toEqual({
			kind: PropertyReuseKind.Adopt,
			def: { ...project, inverseOf: "prop_tasks" },
		});
	});

	it("keeps the draft distinct when the existing def is already paired elsewhere", () => {
		const paired = relation("prop_project", "Project", { inverseOf: "prop_milestones" });
		const draft = relation("prop_new", "Project", { inverseOf: "prop_tasks" });
		expect(resolvePropertyReuse([paired], { def: draft })).toEqual({
			kind: PropertyReuseKind.Distinct,
			conflictsWith: paired,
			pairedWith: "prop_milestones",
		});
	});

	it("still adopts a new target when the existing pairing is left alone", () => {
		const paired = relation("prop_project", "Project", { inverseOf: "prop_milestones" });
		const draft = relation("prop_new", "Project", { allowedTypes: ["Project/v1"] });
		expect(resolvePropertyReuse([paired], { def: draft })).toEqual({
			kind: PropertyReuseKind.Adopt,
			def: { ...paired, allowedTypes: ["Project/v1"] },
		});
	});

	it("treats a same-set target in a different order as no change", () => {
		const existing = relation("prop_project", "Project", { allowedTypes: ["A/v1", "B/v1"] });
		const draft = relation("prop_new", "Project", { allowedTypes: ["B/v1", "A/v1"] });
		expect(resolvePropertyReuse([existing], { def: draft }).kind).toBe(PropertyReuseKind.Reuse);
	});
});
