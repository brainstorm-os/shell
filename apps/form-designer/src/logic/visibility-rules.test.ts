import type { PropertyPredicate } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { type FormField, cellsToFields, fieldsToCells } from "./form-model";
import {
	isConditionMet,
	isFieldVisible,
	requiredEmptyFields,
	visibleFields,
	visibleFillProperties,
} from "./visibility-rules";

const needsShipping: PropertyPredicate = { $eq: { needsShipping: true } };

const name: FormField = { property: "name" };
const address: FormField = { property: "address", condition: needsShipping };

describe("isConditionMet", () => {
	it("treats an absent condition as always visible", () => {
		expect(isConditionMet(undefined, {})).toBe(true);
	});

	it("evaluates the predicate against the in-progress values", () => {
		expect(isConditionMet(needsShipping, { needsShipping: true })).toBe(true);
		expect(isConditionMet(needsShipping, { needsShipping: false })).toBe(false);
		expect(isConditionMet(needsShipping, {})).toBe(false);
	});

	it("supports the full predicate language (composition + existence)", () => {
		const rule: PropertyPredicate = {
			$and: [{ $eq: { country: "US" } }, { $exists: { state: true } }],
		};
		expect(isConditionMet(rule, { country: "US", state: "CA" })).toBe(true);
		expect(isConditionMet(rule, { country: "US" })).toBe(false);
		expect(isConditionMet(rule, { country: "DE", state: "BE" })).toBe(false);
	});
});

describe("isFieldVisible / visibleFields", () => {
	it("shows unconditional fields and gates conditional ones", () => {
		expect(isFieldVisible(name, {})).toBe(true);
		expect(isFieldVisible(address, { needsShipping: true })).toBe(true);
		expect(isFieldVisible(address, {})).toBe(false);
	});

	it("filters the field list to what is currently shown, in order", () => {
		expect(visibleFields([name, address], { needsShipping: true })).toEqual([name, address]);
		expect(visibleFields([name, address], { needsShipping: false })).toEqual([name]);
	});
});

describe("requiredEmptyFields", () => {
	it("reports visible empty fields that must block Create", () => {
		const empty = requiredEmptyFields([name, address], { needsShipping: true });
		expect(empty.map((f) => f.property)).toEqual(["name", "address"]);
	});

	it("never blocks on a hidden field, even when its value is empty", () => {
		const empty = requiredEmptyFields([name, address], { name: "Ada", needsShipping: false });
		expect(empty).toEqual([]);
	});

	it("blocks on a now-visible conditional field that is still empty", () => {
		const empty = requiredEmptyFields([name, address], { name: "Ada", needsShipping: true });
		expect(empty.map((f) => f.property)).toEqual(["address"]);
	});
});

describe("visibleFillProperties", () => {
	it("keeps visible answers and drops hidden ones", () => {
		const props = visibleFillProperties({
			fields: [name, address],
			values: { name: "Ada", address: "1 Analytical Way", needsShipping: false },
			fallbackName: "Untitled",
		});
		expect(props.name).toBe("Ada");
		expect("address" in props).toBe(false); // hidden → not persisted
	});

	it("persists a conditional answer once the field is shown", () => {
		const props = visibleFillProperties({
			fields: [name, address],
			values: { name: "Ada", address: "1 Analytical Way", needsShipping: true },
			fallbackName: "Untitled",
		});
		expect(props.address).toBe("1 Analytical Way");
	});

	it("falls back to the default name when no name value is present", () => {
		const props = visibleFillProperties({
			fields: [name],
			values: {},
			fallbackName: "Untitled",
		});
		expect(props.name).toBe("Untitled");
	});
});

describe("condition round-trips through the layout cell", () => {
	it("persists `condition` on the cell and reads it back unchanged", () => {
		const field: FormField = { property: "address", label: "Address", condition: needsShipping };
		const cells = fieldsToCells([field]);
		expect(cells[0]?.condition).toEqual(needsShipping);
		expect(cellsToFields(cells)[0]).toEqual(field);
	});

	it("omits `condition` entirely for an unconditional field", () => {
		const cells = fieldsToCells([name]);
		expect("condition" in (cells[0] ?? {})).toBe(false);
		expect(cellsToFields(cells)[0]).toEqual(name);
	});
});
