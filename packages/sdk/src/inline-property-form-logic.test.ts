/**
 * Pure-logic tests for the inline property-form helpers. Drives
 * `draftInlineProperty` across the (primary, textFormat, multi) matrix
 * and asserts each path produces the right PropertyDef + Dictionary
 * shape. Same coverage as the data-section-forms suite at the shell
 * level — pin both surfaces to the same composable contract.
 */

import {
	CARDINALITY_HARD_MAX,
	FILE_ENTITY_TYPE,
	PropertyFormat,
	PropertyKindPreset,
	ValueType,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	INLINE_PRIMARY_KIND_ORDER,
	INLINE_TEXT_FORMAT_ORDER,
	InlineNumberFormat,
	InlinePrimaryKind,
	InlineTextFormat,
	dedupeSelectOptions,
	draftInlineProperty,
	parseSelectOptions,
	resolveInlinePreset,
	supportsMultiToggle,
	supportsNumberFormat,
	supportsTextFormat,
} from "./inline-property-form-logic";

describe("inline-property-form-logic — helpers", () => {
	it("kind order is exactly the eight supported primary kinds", () => {
		expect(INLINE_PRIMARY_KIND_ORDER).toEqual([
			InlinePrimaryKind.Text,
			InlinePrimaryKind.Number,
			InlinePrimaryKind.Boolean,
			InlinePrimaryKind.Date,
			InlinePrimaryKind.Select,
			InlinePrimaryKind.Relation,
			InlinePrimaryKind.File,
			InlinePrimaryKind.Formula,
		]);
		expect(Object.isFrozen(INLINE_PRIMARY_KIND_ORDER)).toBe(true);
	});

	it("text format order covers plain + URL + Email + Phone", () => {
		expect(INLINE_TEXT_FORMAT_ORDER).toEqual([
			InlineTextFormat.Plain,
			InlineTextFormat.Url,
			InlineTextFormat.Email,
			InlineTextFormat.Phone,
		]);
		expect(Object.isFrozen(INLINE_TEXT_FORMAT_ORDER)).toBe(true);
	});

	it("supportsMultiToggle is true for Select + Relation", () => {
		for (const kind of INLINE_PRIMARY_KIND_ORDER) {
			expect(supportsMultiToggle(kind)).toBe(
				kind === InlinePrimaryKind.Select || kind === InlinePrimaryKind.Relation,
			);
		}
	});

	it("supportsTextFormat is true only for Text", () => {
		for (const kind of INLINE_PRIMARY_KIND_ORDER) {
			expect(supportsTextFormat(kind)).toBe(kind === InlinePrimaryKind.Text);
		}
	});

	it("supportsNumberFormat is true only for Number", () => {
		for (const kind of INLINE_PRIMARY_KIND_ORDER) {
			expect(supportsNumberFormat(kind)).toBe(kind === InlinePrimaryKind.Number);
		}
	});

	it("resolveInlinePreset maps each (primary, textFormat) to the right preset", () => {
		expect(resolveInlinePreset(InlinePrimaryKind.Text, InlineTextFormat.Plain, false)).toBe(
			PropertyKindPreset.Text,
		);
		expect(resolveInlinePreset(InlinePrimaryKind.Text, InlineTextFormat.Url, false)).toBe(
			PropertyKindPreset.Url,
		);
		expect(resolveInlinePreset(InlinePrimaryKind.Text, InlineTextFormat.Email, false)).toBe(
			PropertyKindPreset.Email,
		);
		expect(resolveInlinePreset(InlinePrimaryKind.Text, InlineTextFormat.Phone, false)).toBe(
			PropertyKindPreset.Phone,
		);
		expect(resolveInlinePreset(InlinePrimaryKind.Number, InlineTextFormat.Plain, false)).toBe(
			PropertyKindPreset.Number,
		);
		expect(resolveInlinePreset(InlinePrimaryKind.Boolean, InlineTextFormat.Plain, false)).toBe(
			PropertyKindPreset.Boolean,
		);
		expect(resolveInlinePreset(InlinePrimaryKind.Date, InlineTextFormat.Plain, false)).toBe(
			PropertyKindPreset.Date,
		);
		expect(resolveInlinePreset(InlinePrimaryKind.Select, InlineTextFormat.Plain, false)).toBe(
			PropertyKindPreset.Select,
		);
		expect(resolveInlinePreset(InlinePrimaryKind.Select, InlineTextFormat.Plain, true)).toBe(
			PropertyKindPreset.MultiSelect,
		);
		expect(resolveInlinePreset(InlinePrimaryKind.File, InlineTextFormat.Plain, false)).toBe(
			PropertyKindPreset.File,
		);
		expect(resolveInlinePreset(InlinePrimaryKind.Relation, InlineTextFormat.Plain, false)).toBe(
			PropertyKindPreset.Link,
		);
		expect(resolveInlinePreset(InlinePrimaryKind.Relation, InlineTextFormat.Plain, true)).toBe(
			PropertyKindPreset.Link,
		);
	});

	it("text-format only affects the Text primary kind", () => {
		expect(resolveInlinePreset(InlinePrimaryKind.Number, InlineTextFormat.Url, false)).toBe(
			PropertyKindPreset.Number,
		);
		expect(resolveInlinePreset(InlinePrimaryKind.Date, InlineTextFormat.Email, false)).toBe(
			PropertyKindPreset.Date,
		);
	});

	it("multi toggle only matters for Select", () => {
		expect(resolveInlinePreset(InlinePrimaryKind.Number, InlineTextFormat.Plain, true)).toBe(
			PropertyKindPreset.Number,
		);
		expect(resolveInlinePreset(InlinePrimaryKind.File, InlineTextFormat.Plain, true)).toBe(
			PropertyKindPreset.File,
		);
	});
});

describe("inline-property-form-logic — parseSelectOptions", () => {
	it("splits on newlines and commas, trims, drops blanks", () => {
		expect(parseSelectOptions("Lead\nQualified, Proposal\n\n  Won  ")).toEqual([
			"Lead",
			"Qualified",
			"Proposal",
			"Won",
		]);
	});

	it("collapses case-insensitive duplicates, first spelling wins", () => {
		expect(parseSelectOptions("Won, won, WON")).toEqual(["Won"]);
	});

	it("returns [] for empty / whitespace-only input", () => {
		expect(parseSelectOptions("")).toEqual([]);
		expect(parseSelectOptions("  \n , ")).toEqual([]);
	});

	it("dedupeSelectOptions applies the same hygiene to an array", () => {
		expect(dedupeSelectOptions([" A ", "a", "", "B"])).toEqual(["A", "B"]);
	});
});

describe("inline-property-form-logic — draftInlineProperty", () => {
	it("rejects empty name (whitespace-only counts as empty)", () => {
		const result = draftInlineProperty({
			name: "   ",
			primary: InlinePrimaryKind.Text,
			textFormat: InlineTextFormat.Plain,
			multi: false,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors).toContain("name must be non-empty");
	});

	it("builds a Text def with no vocabulary + no dictionary", () => {
		const result = draftInlineProperty({
			name: " Description ",
			primary: InlinePrimaryKind.Text,
			textFormat: InlineTextFormat.Plain,
			multi: false,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { def, dictionary } = result.value;
		expect(def.name).toBe("Description");
		expect(def.valueType).toBe(ValueType.Text);
		expect(def.format).toBeUndefined();
		expect(def.vocabulary).toBeUndefined();
		expect(dictionary).toBeNull();
	});

	it("builds a URL def by routing through Text + format=Url", () => {
		const result = draftInlineProperty({
			name: "Website",
			primary: InlinePrimaryKind.Text,
			textFormat: InlineTextFormat.Url,
			multi: false,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.def.format).toBe(PropertyFormat.Url);
	});

	it("builds an Email def", () => {
		const result = draftInlineProperty({
			name: "Contact",
			primary: InlinePrimaryKind.Text,
			textFormat: InlineTextFormat.Email,
			multi: false,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.def.format).toBe(PropertyFormat.Email);
	});

	it("builds a Phone def", () => {
		const result = draftInlineProperty({
			name: "Phone",
			primary: InlinePrimaryKind.Text,
			textFormat: InlineTextFormat.Phone,
			multi: false,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.def.format).toBe(PropertyFormat.Phone);
	});

	it("builds a Number def", () => {
		const result = draftInlineProperty({
			name: "Score",
			primary: InlinePrimaryKind.Number,
			textFormat: InlineTextFormat.Plain,
			multi: false,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.def.valueType).toBe(ValueType.Number);
		// Plain number carries no format modifier.
		expect(result.value.def.format).toBeUndefined();
		expect(result.value.def.currency).toBeUndefined();
	});

	it("builds a Currency def (number + format=currency + uppercased code)", () => {
		const result = draftInlineProperty({
			name: "Deal size",
			primary: InlinePrimaryKind.Number,
			textFormat: InlineTextFormat.Plain,
			multi: false,
			numberFormat: InlineNumberFormat.Currency,
			currency: "eur",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { def } = result.value;
		expect(def.valueType).toBe(ValueType.Number);
		expect(def.format).toBe(PropertyFormat.Currency);
		expect(def.currency).toBe("EUR");
	});

	it("defaults a Currency def to USD when no code is given", () => {
		const result = draftInlineProperty({
			name: "Price",
			primary: InlinePrimaryKind.Number,
			textFormat: InlineTextFormat.Plain,
			multi: false,
			numberFormat: InlineNumberFormat.Currency,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.def.currency).toBe("USD");
	});

	it("builds a Percent def (number + format=percent, no currency)", () => {
		const result = draftInlineProperty({
			name: "Margin",
			primary: InlinePrimaryKind.Number,
			textFormat: InlineTextFormat.Plain,
			multi: false,
			numberFormat: InlineNumberFormat.Percent,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.def.format).toBe(PropertyFormat.Percent);
		expect(result.value.def.currency).toBeUndefined();
	});

	it("builds a Duration def (number + format=duration, no currency)", () => {
		const result = draftInlineProperty({
			name: "Hours",
			primary: InlinePrimaryKind.Number,
			textFormat: InlineTextFormat.Plain,
			multi: false,
			numberFormat: InlineNumberFormat.Duration,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.def.valueType).toBe(ValueType.Number);
		expect(result.value.def.format).toBe(PropertyFormat.Duration);
		expect(result.value.def.currency).toBeUndefined();
	});

	it("builds a single Relation def (entityRef, Link preset, count {0,1})", () => {
		const result = draftInlineProperty({
			name: "Research notes",
			primary: InlinePrimaryKind.Relation,
			textFormat: InlineTextFormat.Plain,
			multi: false,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { def } = result.value;
		expect(def.valueType).toBe(ValueType.EntityRef);
		expect(def.count).toEqual({ min: 0, max: 1 });
		expect(result.value.dictionary).toBeNull();
	});

	it("builds a multi Relation def (entityRef, multi cardinality)", () => {
		const result = draftInlineProperty({
			name: "Deliverables",
			primary: InlinePrimaryKind.Relation,
			textFormat: InlineTextFormat.Plain,
			multi: true,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { def } = result.value;
		expect(def.valueType).toBe(ValueType.EntityRef);
		// The Link preset's default cardinality is multi (max > 1).
		expect((def.count?.max ?? 1) > 1).toBe(true);
	});

	it("ignores numberFormat for non-number kinds", () => {
		const result = draftInlineProperty({
			name: "Title",
			primary: InlinePrimaryKind.Text,
			textFormat: InlineTextFormat.Plain,
			multi: false,
			numberFormat: InlineNumberFormat.Currency,
			currency: "EUR",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.def.currency).toBeUndefined();
		expect(result.value.def.format).toBeUndefined();
	});

	it("builds a Boolean def", () => {
		const result = draftInlineProperty({
			name: "Done",
			primary: InlinePrimaryKind.Boolean,
			textFormat: InlineTextFormat.Plain,
			multi: false,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.def.valueType).toBe(ValueType.Boolean);
	});

	it("builds a Date def", () => {
		const result = draftInlineProperty({
			name: "Due",
			primary: InlinePrimaryKind.Date,
			textFormat: InlineTextFormat.Plain,
			multi: false,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.def.valueType).toBe(ValueType.Date);
	});

	it("builds a Select def with a fresh empty dictionary whose id matches the vocabulary ref", () => {
		const result = draftInlineProperty({
			name: "Status",
			primary: InlinePrimaryKind.Select,
			textFormat: InlineTextFormat.Plain,
			multi: false,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { def, dictionary } = result.value;
		expect(def.valueType).toBe(ValueType.Text);
		expect(def.vocabulary).toBeDefined();
		expect(dictionary).not.toBeNull();
		if (!dictionary) return;
		expect(dictionary.items).toEqual([]);
		expect(dictionary.name).toBe("Status");
		expect(def.vocabulary?.dictionaryId).toBe(dictionary.id);
		expect(def.count?.max ?? 1).toBe(1);
	});

	it("builds a MultiSelect def when multi=true under Select", () => {
		const result = draftInlineProperty({
			name: "Tags",
			primary: InlinePrimaryKind.Select,
			textFormat: InlineTextFormat.Plain,
			multi: true,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { def, dictionary } = result.value;
		expect(def.count?.max).toBe(CARDINALITY_HARD_MAX);
		expect(dictionary).not.toBeNull();
	});

	it("builds a File def pinned to brainstorm/File/v1", () => {
		const result = draftInlineProperty({
			name: "Attachments",
			primary: InlinePrimaryKind.File,
			textFormat: InlineTextFormat.Plain,
			multi: false,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.def.valueType).toBe(ValueType.EntityRef);
		expect(result.value.def.allowedTypes).toEqual([FILE_ENTITY_TYPE]);
		expect(result.value.dictionary).toBeNull();
	});

	it("seeds a Select dictionary from inline options (trimmed, ordered, de-duped)", () => {
		const result = draftInlineProperty({
			name: "Stage",
			primary: InlinePrimaryKind.Select,
			textFormat: InlineTextFormat.Plain,
			multi: false,
			options: ["Lead", " Qualified ", "Proposal", "Won", "won", ""],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { dictionary } = result.value;
		expect(dictionary).not.toBeNull();
		if (!dictionary) return;
		expect(dictionary.items.map((i) => i.label)).toEqual(["Lead", "Qualified", "Proposal", "Won"]);
		expect(dictionary.items.map((i) => i.sortIndex)).toEqual([0, 1, 2, 3]);
		// Each item carries a fresh id + null icon (matching the spec shape).
		expect(new Set(dictionary.items.map((i) => i.id)).size).toBe(4);
		expect(dictionary.items.every((i) => i.icon === null)).toBe(true);
	});

	it("seeds a MultiSelect dictionary from inline options too", () => {
		const result = draftInlineProperty({
			name: "Channels",
			primary: InlinePrimaryKind.Select,
			textFormat: InlineTextFormat.Plain,
			multi: true,
			options: ["Email", "Social"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.dictionary?.items.map((i) => i.label)).toEqual(["Email", "Social"]);
	});

	it("keeps the empty dictionary when Select gets no options", () => {
		const result = draftInlineProperty({
			name: "Status",
			primary: InlinePrimaryKind.Select,
			textFormat: InlineTextFormat.Plain,
			multi: false,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.dictionary?.items).toEqual([]);
	});

	it("ignores options for non-select kinds", () => {
		const result = draftInlineProperty({
			name: "Notes",
			primary: InlinePrimaryKind.Text,
			textFormat: InlineTextFormat.Plain,
			multi: false,
			options: ["a", "b"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.dictionary).toBeNull();
	});

	it("pins allowedTypes on a typed Relation", () => {
		const result = draftInlineProperty({
			name: "Client",
			primary: InlinePrimaryKind.Relation,
			textFormat: InlineTextFormat.Plain,
			multi: false,
			allowedTypes: ["brainstorm/Task/v1", " ", "io.brainstorm.contacts/Person/v1"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Blank entries are dropped; the rest pass through.
		expect(result.value.def.allowedTypes).toEqual([
			"brainstorm/Task/v1",
			"io.brainstorm.contacts/Person/v1",
		]);
	});

	it("leaves allowedTypes off an untyped (link-to-anything) Relation", () => {
		const result = draftInlineProperty({
			name: "Related",
			primary: InlinePrimaryKind.Relation,
			textFormat: InlineTextFormat.Plain,
			multi: true,
			allowedTypes: [],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.def.allowedTypes).toBeUndefined();
	});

	it("ignores allowedTypes for non-relation kinds", () => {
		const result = draftInlineProperty({
			name: "Title",
			primary: InlinePrimaryKind.Text,
			textFormat: InlineTextFormat.Plain,
			multi: false,
			allowedTypes: ["brainstorm/Task/v1"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.def.allowedTypes).toBeUndefined();
	});

	it("mints a fresh key + dictionary id on each call", () => {
		const a = draftInlineProperty({
			name: "Status",
			primary: InlinePrimaryKind.Select,
			textFormat: InlineTextFormat.Plain,
			multi: false,
		});
		const b = draftInlineProperty({
			name: "Status",
			primary: InlinePrimaryKind.Select,
			textFormat: InlineTextFormat.Plain,
			multi: false,
		});
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(a.value.def.key).not.toBe(b.value.def.key);
		expect(a.value.dictionary?.id).not.toBe(b.value.dictionary?.id);
	});

	it("drafts a Formula property carrying its compiled expression", () => {
		const result = draftInlineProperty({
			name: "Amount",
			primary: InlinePrimaryKind.Formula,
			textFormat: InlineTextFormat.Plain,
			multi: false,
			formulaExpression: "{qty} * {rate}",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.def.valueType).toBe(ValueType.Number);
		expect(result.value.def.format).toBe(PropertyFormat.Formula);
		expect(result.value.def.formula).toBe("{qty} * {rate}");
	});

	it("rejects a Formula property with an empty or invalid expression", () => {
		const empty = draftInlineProperty({
			name: "Bad",
			primary: InlinePrimaryKind.Formula,
			textFormat: InlineTextFormat.Plain,
			multi: false,
			formulaExpression: "   ",
		});
		expect(empty.ok).toBe(false);
		const broken = draftInlineProperty({
			name: "Bad",
			primary: InlinePrimaryKind.Formula,
			textFormat: InlineTextFormat.Plain,
			multi: false,
			formulaExpression: "{a} * * {b}",
		});
		expect(broken.ok).toBe(false);
	});
});
