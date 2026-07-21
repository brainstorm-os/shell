/**
 * Pure-logic tests for the Settings → Data tab forms (VP-4).
 *
 * The form helpers in `data-section-forms.ts` are the test surface for
 * the Properties + Dictionaries tabs — they encapsulate the validation
 * + draft-construction logic so the React layer stays a dumb consumer.
 * Same anti-corruption pattern as the Notes-app property + dictionary
 * stores: validation lives close to the form so errors surface inline,
 * with the shell-side store re-validating at the broker boundary.
 */

import type { Dictionary, PropertyDef } from "@brainstorm-os/sdk-types";
import { PropertyKindPreset, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	SUPPORTED_PRESETS,
	appendDictionaryItem,
	draftDictionary,
	draftPropertyDef,
	moveDictionaryItem,
	removeDictionaryItem,
	renameDictionary,
	renameDictionaryItem,
	requiresDictionary,
} from "./data-section-forms";

function emptyDict(): Dictionary {
	return { id: "dict_test", name: "Status", items: [] };
}

describe("draftPropertyDef", () => {
	it("rejects an empty name", () => {
		const result = draftPropertyDef({ name: "   ", preset: PropertyKindPreset.Text });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors[0]).toContain("name");
	});

	it("builds a Text PropertyDef with a fresh key", () => {
		const result = draftPropertyDef({ name: "Priority", preset: PropertyKindPreset.Text });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.valueType).toBe(ValueType.Text);
			expect(result.value.name).toBe("Priority");
			expect(result.value.key.startsWith("prop_")).toBe(true);
			expect(result.value.icon).toBeNull();
		}
	});

	it("trims the name before storing", () => {
		const result = draftPropertyDef({ name: "  Status  ", preset: PropertyKindPreset.Text });
		if (!result.ok) throw new Error("expected ok");
		expect(result.value.name).toBe("Status");
	});

	it("rejects Select without a dictionaryId", () => {
		const result = draftPropertyDef({ name: "Status", preset: PropertyKindPreset.Select });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors[0]).toContain("dictionaryId");
	});

	it("builds a Select PropertyDef when a dictionaryId is supplied", () => {
		const result = draftPropertyDef({
			name: "Status",
			preset: PropertyKindPreset.Select,
			dictionaryId: "dict_xyz",
		});
		if (!result.ok) throw new Error("expected ok");
		expect(result.value.valueType).toBe(ValueType.Text);
		expect(result.value.vocabulary?.dictionaryId).toBe("dict_xyz");
		// Select is single-value (Cardinality.max === 1).
		expect(result.value.count?.max).toBe(1);
	});

	it("rejects MultiSelect without a dictionaryId", () => {
		const result = draftPropertyDef({
			name: "Tags",
			preset: PropertyKindPreset.MultiSelect,
		});
		expect(result.ok).toBe(false);
	});

	it("builds MultiSelect with multi-valued cardinality", () => {
		const result = draftPropertyDef({
			name: "Tags",
			preset: PropertyKindPreset.MultiSelect,
			dictionaryId: "dict_xyz",
		});
		if (!result.ok) throw new Error("expected ok");
		expect(result.value.valueType).toBe(ValueType.Text);
		expect(result.value.vocabulary?.dictionaryId).toBe("dict_xyz");
		expect((result.value.count?.max ?? 1) > 1).toBe(true);
	});

	it("builds every non-Select preset without vocabulary", () => {
		const nonSelect = SUPPORTED_PRESETS.filter(
			(p) => p !== PropertyKindPreset.Select && p !== PropertyKindPreset.MultiSelect,
		);
		for (const preset of nonSelect) {
			const result = draftPropertyDef({ name: `Test ${preset}`, preset });
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value.vocabulary).toBeUndefined();
		}
	});

	it("returns unique keys per call", () => {
		const a = draftPropertyDef({ name: "A", preset: PropertyKindPreset.Text });
		const b = draftPropertyDef({ name: "B", preset: PropertyKindPreset.Text });
		if (!a.ok || !b.ok) throw new Error("expected both ok");
		expect(a.value.key).not.toBe(b.value.key);
	});
});

describe("requiresDictionary", () => {
	it("flags Select + MultiSelect only", () => {
		expect(requiresDictionary(PropertyKindPreset.Select)).toBe(true);
		expect(requiresDictionary(PropertyKindPreset.MultiSelect)).toBe(true);
		expect(requiresDictionary(PropertyKindPreset.Text)).toBe(false);
		expect(requiresDictionary(PropertyKindPreset.Number)).toBe(false);
		expect(requiresDictionary(PropertyKindPreset.Date)).toBe(false);
		expect(requiresDictionary(PropertyKindPreset.Boolean)).toBe(false);
	});
});

describe("SUPPORTED_PRESETS", () => {
	it("is frozen so callers can't mutate the shared list", () => {
		expect(Object.isFrozen(SUPPORTED_PRESETS)).toBe(true);
	});

	it("includes every preset the form exposes today", () => {
		// Link is intentionally NOT here — its entity-type picker UI lands
		// with Stage 9 entities. Once it does, both sides of the assertion
		// add `PropertyKindPreset.Link` and this test flips green again.
		expect([...SUPPORTED_PRESETS]).toEqual([
			PropertyKindPreset.Text,
			PropertyKindPreset.Number,
			PropertyKindPreset.Date,
			PropertyKindPreset.Boolean,
			PropertyKindPreset.Select,
			PropertyKindPreset.MultiSelect,
			PropertyKindPreset.Url,
			PropertyKindPreset.Email,
			PropertyKindPreset.Phone,
			PropertyKindPreset.File,
		]);
	});
});

describe("draftDictionary", () => {
	it("rejects an empty name", () => {
		const result = draftDictionary({ id: "dict_a", name: "   " });
		expect(result.ok).toBe(false);
	});

	it("builds an empty Dictionary with the supplied id", () => {
		const result = draftDictionary({ id: "dict_a", name: "Status" });
		if (!result.ok) throw new Error("expected ok");
		expect(result.value.id).toBe("dict_a");
		expect(result.value.name).toBe("Status");
		expect(result.value.items).toEqual([]);
	});

	it("trims the name", () => {
		const result = draftDictionary({ id: "dict_a", name: "  Status  " });
		if (!result.ok) throw new Error("expected ok");
		expect(result.value.name).toBe("Status");
	});
});

describe("renameDictionary", () => {
	it("rejects an empty new name", () => {
		const result = renameDictionary(emptyDict(), "   ");
		expect(result.ok).toBe(false);
	});

	it("returns the input unchanged when the new name is identical post-trim", () => {
		const dict = emptyDict();
		const result = renameDictionary(dict, "  Status  ");
		if (!result.ok) throw new Error("expected ok");
		expect(result.value).toBe(dict);
	});

	it("creates a new object with the trimmed name when changed", () => {
		const dict = emptyDict();
		const result = renameDictionary(dict, "  Priority  ");
		if (!result.ok) throw new Error("expected ok");
		expect(result.value).not.toBe(dict);
		expect(result.value.name).toBe("Priority");
	});
});

describe("appendDictionaryItem", () => {
	it("rejects an empty label", () => {
		const result = appendDictionaryItem(emptyDict(), { label: "   " });
		expect(result.ok).toBe(false);
	});

	it("adds an item at sortIndex 0 when the dictionary is empty", () => {
		const dict = emptyDict();
		const result = appendDictionaryItem(dict, { id: "di_first", label: "Open" });
		if (!result.ok) throw new Error("expected ok");
		expect(result.value.items).toHaveLength(1);
		expect(result.value.items[0]?.id).toBe("di_first");
		expect(result.value.items[0]?.sortIndex).toBe(0);
	});

	it("appends after the largest existing sortIndex", () => {
		const base: Dictionary = {
			id: "d",
			name: "n",
			items: [
				{ id: "a", label: "A", icon: null, sortIndex: 0 },
				{ id: "b", label: "B", icon: null, sortIndex: 7 }, // gap on purpose
			],
		};
		const result = appendDictionaryItem(base, { id: "c", label: "C" });
		if (!result.ok) throw new Error("expected ok");
		const c = result.value.items[2];
		expect(c?.sortIndex).toBe(8);
	});

	it("does not mutate the input", () => {
		const dict = emptyDict();
		const before = dict.items;
		appendDictionaryItem(dict, { id: "x", label: "X" });
		expect(dict.items).toBe(before);
	});

	it("mints a fresh id when none supplied", () => {
		const a = appendDictionaryItem(emptyDict(), { label: "X" });
		const b = appendDictionaryItem(emptyDict(), { label: "X" });
		if (!a.ok || !b.ok) throw new Error("expected both ok");
		expect(a.value.items[0]?.id).not.toBe(b.value.items[0]?.id);
		expect(a.value.items[0]?.id.startsWith("di_")).toBe(true);
	});
});

describe("moveDictionaryItem", () => {
	const dict: Dictionary = {
		id: "d",
		name: "n",
		items: [
			{ id: "a", label: "A", icon: null, sortIndex: 0 },
			{ id: "b", label: "B", icon: null, sortIndex: 1 },
			{ id: "c", label: "C", icon: null, sortIndex: 2 },
		],
	};

	it("moves an item up", () => {
		const next = moveDictionaryItem(dict, 1, -1);
		expect(next.items.map((it) => it.id)).toEqual(["b", "a", "c"]);
		expect(next.items.map((it) => it.sortIndex)).toEqual([0, 1, 2]);
	});

	it("moves an item down", () => {
		const next = moveDictionaryItem(dict, 1, 1);
		expect(next.items.map((it) => it.id)).toEqual(["a", "c", "b"]);
		expect(next.items.map((it) => it.sortIndex)).toEqual([0, 1, 2]);
	});

	it("is a no-op when moving the first item up", () => {
		const next = moveDictionaryItem(dict, 0, -1);
		expect(next).toBe(dict);
	});

	it("is a no-op when moving the last item down", () => {
		const next = moveDictionaryItem(dict, 2, 1);
		expect(next).toBe(dict);
	});

	it("is a no-op when index is out of bounds", () => {
		const next = moveDictionaryItem(dict, 99, -1);
		expect(next).toBe(dict);
	});

	it("doesn't mutate the input", () => {
		const beforeIds = dict.items.map((it) => it.id);
		moveDictionaryItem(dict, 1, -1);
		expect(dict.items.map((it) => it.id)).toEqual(beforeIds);
	});
});

describe("removeDictionaryItem", () => {
	const dict: Dictionary = {
		id: "d",
		name: "n",
		items: [
			{ id: "a", label: "A", icon: null, sortIndex: 0 },
			{ id: "b", label: "B", icon: null, sortIndex: 5 },
			{ id: "c", label: "C", icon: null, sortIndex: 9 },
		],
	};

	it("drops the matching item and renumbers sortIndex", () => {
		const next = removeDictionaryItem(dict, "b");
		expect(next.items.map((it) => it.id)).toEqual(["a", "c"]);
		expect(next.items.map((it) => it.sortIndex)).toEqual([0, 1]);
	});

	it("is a no-op when the id is not present", () => {
		const next = removeDictionaryItem(dict, "missing");
		expect(next).toBe(dict);
	});

	it("doesn't mutate the input", () => {
		const beforeIds = dict.items.map((it) => it.id);
		removeDictionaryItem(dict, "b");
		expect(dict.items.map((it) => it.id)).toEqual(beforeIds);
	});
});

describe("renameDictionaryItem", () => {
	const dict: Dictionary = {
		id: "d",
		name: "n",
		items: [
			{ id: "a", label: "A", icon: null, sortIndex: 0 },
			{ id: "b", label: "B", icon: null, sortIndex: 1 },
		],
	};

	it("rejects an empty new label", () => {
		const result = renameDictionaryItem(dict, "a", "  ");
		expect(result.ok).toBe(false);
	});

	it("returns the input unchanged for unknown ids", () => {
		const result = renameDictionaryItem(dict, "missing", "X");
		if (!result.ok) throw new Error("expected ok");
		expect(result.value).toBe(dict);
	});

	it("updates only the matching item's label", () => {
		const result = renameDictionaryItem(dict, "a", "  Alpha  ");
		if (!result.ok) throw new Error("expected ok");
		expect(result.value).not.toBe(dict);
		expect(result.value.items[0]?.label).toBe("Alpha");
		expect(result.value.items[1]?.label).toBe("B");
	});
});

describe("draftPropertyDef shape stability", () => {
	// Defensive: callers narrow on `valueType` + modifier presence;
	// this guards against accidental shape drift in the helper.
	it("does not emit a `vocabulary` field for presets without one", () => {
		const result = draftPropertyDef({ name: "Yes", preset: PropertyKindPreset.Boolean });
		if (!result.ok) throw new Error("expected ok");
		const def: PropertyDef = result.value;
		expect(def.vocabulary).toBeUndefined();
	});
});
