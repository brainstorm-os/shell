import type { PropertiesSnapshot, PropertyDef } from "@brainstorm-os/sdk-types";
import { PropertyFormat, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import {
	buildPropertyDefResolver,
	buildVocabularyResolver,
	installPropertyDefResolver,
	installVocabularyResolver,
	resolvePropertyDef,
	resolveVocabularyColor,
} from "./property-resolver";

function def(over: Partial<PropertyDef> & { key: string; valueType: ValueType }): PropertyDef {
	return { name: over.key, icon: null, ...over };
}

const snapshot: PropertiesSnapshot = {
	properties: {
		statusKey: def({
			key: "statusKey",
			valueType: ValueType.Text,
			vocabulary: { dictionaryId: "dict-task-status" },
		}),
		name: def({ key: "name", valueType: ValueType.Text }),
		cost: def({ key: "cost", valueType: ValueType.Number, format: PropertyFormat.Currency }),
	},
	dictionaries: {
		"dict-task-status": {
			id: "dict-task-status",
			name: "Status",
			items: [
				{ id: "i1", label: "done", icon: null, sortIndex: 0, colour: "#16a34a" },
				{ id: "i2", label: "reverted", icon: null, sortIndex: 1, colour: "#dc2626" },
				{
					id: "i3",
					label: "archived",
					icon: null,
					sortIndex: 2,
					colour: "#000000",
					archivedAt: 123,
				},
			],
		},
	},
};

describe("buildVocabularyResolver (real Dictionary via the shared pure core)", () => {
	it("delegates entirely to the fallback when there is no snapshot", () => {
		const fallback = vi.fn(() => "#fallback");
		const r = buildVocabularyResolver(null, fallback);
		expect(r("statusKey", "done")).toBe("#fallback");
		expect(fallback).toHaveBeenCalledWith("statusKey", "done");
	});

	it("resolves a Select value to its dictionary item colour", () => {
		const r = buildVocabularyResolver(snapshot, () => null);
		// Select values store the option id ("i1"), not the label — the resolver
		// indexes by id so a user-created (opaque-id) option resolves too.
		expect(r("statusKey", "i1")).toBe("#16a34a");
		expect(r("statusKey", "i2")).toBe("#dc2626");
		// The label is no longer a lookup key.
		expect(r("statusKey", "done")).toBe(null);
	});

	it("falls back for unknown values, archived items, and non-vocabulary props", () => {
		const fallback = vi.fn(() => "#fb");
		const r = buildVocabularyResolver(snapshot, fallback);
		expect(r("statusKey", "nope")).toBe("#fb"); // id not in vocab
		expect(r("statusKey", "i3")).toBe("#fb"); // archived item skipped (activeItems)
		expect(r("name", "anything")).toBe("#fb"); // no vocabulary modifier
		expect(r("unknownProp", "x")).toBe("#fb"); // property absent
	});

	it("resolves a dotted path against its head property", () => {
		const r = buildVocabularyResolver(snapshot, () => null);
		expect(r("statusKey.value", "i1")).toBe("#16a34a");
	});
});

describe("buildPropertyDefResolver", () => {
	it("returns undefined when there is no snapshot (standalone-dev)", () => {
		const r = buildPropertyDefResolver(null);
		expect(r("statusKey")).toBeUndefined();
	});

	it("resolves a propertyId — including a dotted path — to its PropertyDef", () => {
		const r = buildPropertyDefResolver(snapshot);
		expect(r("cost")?.valueType).toBe(ValueType.Number);
		expect(r("cost")?.format).toBe(PropertyFormat.Currency);
		expect(r("statusKey.value")?.key).toBe("statusKey");
		expect(r("absent")).toBeUndefined();
	});
});

describe("installed resolvers route through the active implementation", () => {
	it("routes vocabulary colour through the installed resolver", () => {
		installVocabularyResolver(buildVocabularyResolver(snapshot, () => null));
		expect(resolveVocabularyColor("statusKey", "i1")).toBe("#16a34a");
		installVocabularyResolver(() => "#zzz");
		expect(resolveVocabularyColor("anything", "x")).toBe("#zzz");
	});

	it("routes PropertyDef through the installed resolver; null-snapshot install yields no def", () => {
		installPropertyDefResolver(buildPropertyDefResolver(snapshot));
		expect(resolvePropertyDef("cost")?.valueType).toBe(ValueType.Number);
		installPropertyDefResolver(buildPropertyDefResolver(null));
		expect(resolvePropertyDef("cost")).toBeUndefined();
	});
});
