import { PropertyView, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { EditableField, fieldDef, readFieldValue, toStoredValue } from "./inspector-cells";

describe("fieldDef", () => {
	it("synthesises a single-line Plain Text def for the name field", () => {
		const def = fieldDef(EditableField.Name, "Name");
		expect(def.key).toBe("name");
		expect(def.name).toBe("Name");
		expect(def.icon).toBeNull();
		expect(def.valueType).toBe(ValueType.Text);
		expect(def.display?.view).toBe(PropertyView.Plain);
	});

	it("synthesises a wrapping Multiline Text def for the description field", () => {
		const def = fieldDef(EditableField.Description, "Description");
		expect(def.key).toBe("description");
		expect(def.valueType).toBe(ValueType.Text);
		expect(def.display?.view).toBe(PropertyView.Multiline);
	});

	it("uses the enum value (= the properties key) as the def key", () => {
		expect(fieldDef(EditableField.Name, "x").key).toBe(EditableField.Name);
		expect(fieldDef(EditableField.Description, "x").key).toBe(EditableField.Description);
	});
});

describe("readFieldValue", () => {
	it("reads a stored string as the scalar value", () => {
		expect(readFieldValue({ name: "Quarterly report" }, EditableField.Name)).toBe("Quarterly report");
		expect(readFieldValue({ description: "A folder of reports" }, EditableField.Description)).toBe(
			"A folder of reports",
		);
	});

	it("returns null (canonical empty) for a missing property", () => {
		expect(readFieldValue({}, EditableField.Name)).toBeNull();
		expect(readFieldValue({ other: 1 }, EditableField.Description)).toBeNull();
	});

	it("returns null for a non-string stored value rather than coercing", () => {
		expect(readFieldValue({ name: 42 }, EditableField.Name)).toBeNull();
		expect(readFieldValue({ description: { nested: true } }, EditableField.Description)).toBeNull();
		expect(readFieldValue({ name: null }, EditableField.Name)).toBeNull();
	});
});

describe("toStoredValue", () => {
	it("passes a committed string through unchanged", () => {
		expect(toStoredValue("Renamed")).toBe("Renamed");
		expect(toStoredValue("")).toBe("");
	});

	it("collapses null / non-string (cleared cell) to an empty string", () => {
		expect(toStoredValue(null)).toBe("");
		expect(toStoredValue(undefined)).toBe("");
		expect(toStoredValue(123)).toBe("");
	});
});
