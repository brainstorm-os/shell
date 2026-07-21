import { DateGranularity, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { effectiveColumnDef, inferPropertyDef } from "./effective-def";
import type { EntityRow } from "./in-memory-entities";

const row = (properties: Record<string, unknown>): EntityRow => ({
	id: "e1",
	type: "T",
	properties,
	createdAt: 0,
	updatedAt: 0,
	deletedAt: null,
});

describe("inferPropertyDef", () => {
	it("types scalars from a sample value", () => {
		expect(inferPropertyDef("done", true)?.valueType).toBe(ValueType.Boolean);
		expect(inferPropertyDef("count", 7)?.valueType).toBe(ValueType.Number);
		expect(inferPropertyDef("note", "hi")?.valueType).toBe(ValueType.Text);
		const date = inferPropertyDef("due", 1_700_000_000_000);
		expect(date?.valueType).toBe(ValueType.Date);
		expect(date?.granularity).toBe(DateGranularity.Date);
	});

	it("does not infer arrays, rich text, or empty", () => {
		expect(inferPropertyDef("tags", ["a"])).toBeNull();
		expect(inferPropertyDef("body", { root: {} })).toBeNull();
		expect(inferPropertyDef("x", "")).toBeNull();
		expect(inferPropertyDef("x", null)).toBeNull();
	});
});

describe("effectiveColumnDef", () => {
	it("leaves system/meta fields un-editable", () => {
		const rows = [row({ createdAt: 1_700_000_000_000 })];
		expect(effectiveColumnDef("createdAt", rows)).toBeNull();
		expect(effectiveColumnDef("updated_at", rows)).toBeNull();
		expect(effectiveColumnDef("id", rows)).toBeNull();
	});

	it("infers from the first typeable value across rows", () => {
		const rows = [row({}), row({ priority: 3 })];
		expect(effectiveColumnDef("priority", rows)?.valueType).toBe(ValueType.Number);
	});

	it("returns null when no row carries a typeable value", () => {
		expect(effectiveColumnDef("blank", [row({}), row({ blank: null })])).toBeNull();
	});
});
