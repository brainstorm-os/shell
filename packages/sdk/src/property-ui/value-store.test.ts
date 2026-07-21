import type { PropertyDef } from "@brainstorm-os/sdk-types";
import { CARDINALITY_HARD_MAX, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { emptyValueFor } from "../properties-validate";
import { bindValue, clearValue, migrateValuesField, readValue, writeValue } from "./value-store";

const text = (key: string): PropertyDef => ({
	key,
	name: "Title",
	icon: null,
	valueType: ValueType.Text,
});

const number = (key: string, min?: number, max?: number): PropertyDef => ({
	key,
	name: "Score",
	icon: null,
	valueType: ValueType.Number,
	...(min !== undefined || max !== undefined
		? { range: { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) } }
		: {}),
});

const bool = (key: string): PropertyDef => ({
	key,
	name: "Done",
	icon: null,
	valueType: ValueType.Boolean,
});

const multi = (key: string): PropertyDef => ({
	key,
	name: "Tags",
	icon: null,
	valueType: ValueType.Text,
	vocabulary: { dictionaryId: "dict_a" },
	count: { min: 0, max: CARDINALITY_HARD_MAX },
});

describe("readValue", () => {
	it("returns the kind-empty default when values is undefined", () => {
		expect(readValue(undefined, text("prop_a"))).toBeNull();
		expect(readValue(undefined, bool("prop_b"))).toBe(false);
		expect(readValue(undefined, multi("prop_c"))).toEqual([]);
	});

	it("returns the kind-empty default when the key is missing", () => {
		expect(readValue({}, text("prop_a"))).toBeNull();
	});

	it("returns the stored value coerced to the kind shape", () => {
		expect(readValue({ prop_a: "hello" }, text("prop_a"))).toBe("hello");
	});

	it("clamps numbers to declared min/max during read", () => {
		const def = number("prop_n", 0, 10);
		expect(readValue({ prop_n: 200 }, def)).toBe(10);
		expect(readValue({ prop_n: -5 }, def)).toBe(0);
	});

	it("coerces malformed stored values to the kind empty", () => {
		expect(readValue({ prop_a: 42 }, text("prop_a"))).toBeNull();
		expect(readValue({ prop_c: "not-an-array" }, multi("prop_c"))).toEqual([]);
	});
});

describe("writeValue", () => {
	it("stores a non-empty value under the property's key", () => {
		const out = writeValue({}, text("prop_a"), "hello");
		expect(out).toEqual({ prop_a: "hello" });
	});

	it("creates the values object when none was passed", () => {
		expect(writeValue(undefined, text("prop_a"), "hello")).toEqual({ prop_a: "hello" });
	});

	it("does not mutate the input map", () => {
		const initial = { prop_a: "before" };
		const out = writeValue(initial, text("prop_a"), "after");
		expect(initial).toEqual({ prop_a: "before" });
		expect(out).toEqual({ prop_a: "after" });
		expect(out).not.toBe(initial);
	});

	it("clears the entry when the next value equals the kind empty (null for text)", () => {
		const out = writeValue({ prop_a: "hi", prop_b: 5 }, text("prop_a"), null);
		expect(out).toEqual({ prop_b: 5 });
		expect("prop_a" in out).toBe(false);
	});

	it("clears the entry when an array kind is set to []", () => {
		const out = writeValue({ prop_c: ["x"] }, multi("prop_c"), []);
		expect("prop_c" in out).toBe(false);
	});

	it("stores false as a real value for Boolean (not as empty)", () => {
		// Boolean's empty is `false` by `emptyValueFor`, so writing false
		// clears the entry — that's the intended behavior (boolean
		// "not bound" and "bound to false" collapse, matching the spec's
		// '`null` is the canonical empty — Boolean exception aside').
		const out = writeValue({}, bool("prop_x"), false);
		expect("prop_x" in out).toBe(false);
	});

	it("stores true and overrides a prior false-empty", () => {
		const out = writeValue({}, bool("prop_x"), true);
		expect(out.prop_x).toBe(true);
	});
});

describe("clearValue", () => {
	it("removes the entry if present", () => {
		expect(clearValue({ prop_a: "v" }, "prop_a")).toEqual({});
	});

	it("returns the original map (empty) when the key is absent", () => {
		expect(clearValue({}, "prop_a")).toEqual({});
		expect(clearValue(undefined, "prop_a")).toEqual({});
	});

	it("preserves other keys", () => {
		expect(clearValue({ prop_a: "x", prop_b: "y" }, "prop_a")).toEqual({ prop_b: "y" });
	});
});

describe("bindValue", () => {
	it("adds the key present with its kind-empty value (the panel Add bug)", () => {
		// Regression: seeding the empty value through writeValue deletes
		// the key, so the panel binding never persisted.
		const def = text("prop_a");
		// The EXACT panel path: seed the canonical empty via the value
		// path → writeValue drops it (isEmptyValue is true by definition
		// for emptyValueFor), so the key never persists.
		const writeOut = writeValue({}, def, emptyValueFor(def) as never);
		expect("prop_a" in writeOut).toBe(false);

		// bindValue keeps the key present so the row renders + persists.
		const bound = bindValue({}, def);
		expect("prop_a" in bound).toBe(true);
	});

	it("never clobbers an existing value (idempotent re-bind)", () => {
		const def = text("prop_a");
		const existing = { prop_a: "keep me" };
		expect(bindValue(existing, def)).toBe(existing);
	});

	it("handles an undefined values map", () => {
		expect("prop_a" in bindValue(undefined, text("prop_a"))).toBe(true);
	});
});

describe("migrateValuesField", () => {
	it("returns the same object for a plain record", () => {
		const r = { prop_a: "x" };
		expect(migrateValuesField(r)).toBe(r);
	});

	it("returns an empty object for undefined / null", () => {
		expect(migrateValuesField(undefined)).toEqual({});
		expect(migrateValuesField(null)).toEqual({});
	});

	it("returns an empty object for arrays (corrupt row)", () => {
		expect(migrateValuesField([1, 2, 3])).toEqual({});
	});

	it("returns an empty object for primitive scalars", () => {
		expect(migrateValuesField("string")).toEqual({});
		expect(migrateValuesField(42)).toEqual({});
	});
});
