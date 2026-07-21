/**
 * Pure-logic helpers backing the shared `<InlinePropertyForm>` React
 * component. Lives in `@brainstorm-os/sdk` so Notes, Database, Graph, and
 * any future app can drive the same form against the same vault-level
 * `PropertiesService` without copying logic or styles.
 *
 * Maps a (primary, textFormat, multi) tuple to a canonical
 * `PropertyKindPreset`, mints fresh property keys + dictionary ids,
 * and produces a draft `PropertyDef` (plus an optional empty
 * `Dictionary` when the preset is Select / Multi-select).
 *
 * The full vocabulary editor lives in the shell's Settings → Data tab.
 * Apps surface a lighter inline flow — name + kind tile + (text format
 * | multi toggle) — and any richer config is "open Settings → Data"
 * to keep the in-editor surface small.
 */

import {
	type Dictionary,
	type DictionaryItem,
	type PropertyDef,
	PropertyFormat,
	PropertyKindPreset,
} from "@brainstorm-os/sdk-types";
import { compileFormula } from "./formula";
import { newDictionaryId, newDictionaryItemId, newPropertyKey } from "./properties-keys";
import { defForPreset } from "./properties-preset";
import { validatePropertyDef } from "./properties-validate";

/** Primary kinds the inline picker surfaces — 6 tiles. Link is
 *  deferred alongside the shell's `SUPPORTED_PRESETS` until the
 *  entity-type picker UI lands with Stage 9 entities. */
export enum InlinePrimaryKind {
	Text = "text",
	Number = "number",
	Boolean = "boolean",
	Date = "date",
	Select = "select",
	Relation = "relation",
	File = "file",
	Formula = "formula",
}

/** Order the tiles render in. */
export const INLINE_PRIMARY_KIND_ORDER: readonly InlinePrimaryKind[] = Object.freeze([
	InlinePrimaryKind.Text,
	InlinePrimaryKind.Number,
	InlinePrimaryKind.Boolean,
	InlinePrimaryKind.Date,
	InlinePrimaryKind.Select,
	InlinePrimaryKind.Relation,
	InlinePrimaryKind.File,
	InlinePrimaryKind.Formula,
]);

/** Sub-format shown when Text is the primary kind. Collapses
 *  URL / Email / Phone into the Text tile per the composable model. */
export enum InlineTextFormat {
	Plain = "plain",
	Url = "url",
	Email = "email",
	Phone = "phone",
}

export const INLINE_TEXT_FORMAT_ORDER: readonly InlineTextFormat[] = Object.freeze([
	InlineTextFormat.Plain,
	InlineTextFormat.Url,
	InlineTextFormat.Email,
	InlineTextFormat.Phone,
]);

/** Sub-format shown when Number is the primary kind. Currency + Percent are
 *  `format` modifiers on a `number` property (per-property, not per-value —
 *  the value stays a bare number; the def's `format`/`currency` drive display
 *  + validation). The per-value `valueMeta` model is v2 (OQ-LD-15). */
export enum InlineNumberFormat {
	Plain = "plain",
	Currency = "currency",
	Percent = "percent",
	Duration = "duration",
}

export const INLINE_NUMBER_FORMAT_ORDER: readonly InlineNumberFormat[] = Object.freeze([
	InlineNumberFormat.Plain,
	InlineNumberFormat.Currency,
	InlineNumberFormat.Percent,
	InlineNumberFormat.Duration,
]);

/** Default ISO-4217 code when a currency property is created (mirrors the
 *  formatter's own fallback). */
export const DEFAULT_CURRENCY_CODE = "USD";

/** Curated ISO-4217 codes the inline picker offers. The full set is large and
 *  rarely needed inline; the Settings → Data constructor can set any code. */
export const INLINE_CURRENCY_CODES: readonly string[] = Object.freeze([
	"USD",
	"EUR",
	"GBP",
	"JPY",
	"CHF",
	"CAD",
	"AUD",
	"CNY",
	"INR",
	"SEK",
	"NOK",
	"BRL",
]);

/** Map a (primary, textFormat, multi) tuple to a concrete preset that
 *  `defForPreset` understands. */
export function resolveInlinePreset(
	primary: InlinePrimaryKind,
	textFormat: InlineTextFormat,
	multi: boolean,
): PropertyKindPreset {
	if (primary === InlinePrimaryKind.Text) {
		switch (textFormat) {
			case InlineTextFormat.Url:
				return PropertyKindPreset.Url;
			case InlineTextFormat.Email:
				return PropertyKindPreset.Email;
			case InlineTextFormat.Phone:
				return PropertyKindPreset.Phone;
			default:
				return PropertyKindPreset.Text;
		}
	}
	if (primary === InlinePrimaryKind.Select && multi) {
		return PropertyKindPreset.MultiSelect;
	}
	switch (primary) {
		case InlinePrimaryKind.Number:
			return PropertyKindPreset.Number;
		case InlinePrimaryKind.Boolean:
			return PropertyKindPreset.Boolean;
		case InlinePrimaryKind.Date:
			return PropertyKindPreset.Date;
		case InlinePrimaryKind.Select:
			return PropertyKindPreset.Select;
		case InlinePrimaryKind.Relation:
			// Both single + multi relations are the `Link` EntityRef preset;
			// cardinality is set from the `multi` toggle in draftInlineProperty
			// (the preset itself defaults to multi).
			return PropertyKindPreset.Link;
		case InlinePrimaryKind.File:
			return PropertyKindPreset.File;
		case InlinePrimaryKind.Formula:
			return PropertyKindPreset.Formula;
		default:
			return PropertyKindPreset.Text;
	}
}

/** Whether the form should surface the "Allow multiple values"
 *  toggle for the current primary kind. Select (one vs many tags) and
 *  Relation (link one vs many objects) both branch on it. */
export function supportsMultiToggle(primary: InlinePrimaryKind): boolean {
	return primary === InlinePrimaryKind.Select || primary === InlinePrimaryKind.Relation;
}

/** Whether the form should surface the Text-format sub-segmented
 *  control for the current primary kind. */
export function supportsTextFormat(primary: InlinePrimaryKind): boolean {
	return primary === InlinePrimaryKind.Text;
}

/** Whether the form should surface the Number-format sub-segmented control
 *  (Plain / Currency / Percent) for the current primary kind. */
export function supportsNumberFormat(primary: InlinePrimaryKind): boolean {
	return primary === InlinePrimaryKind.Number;
}

/** A target entity-type the inline Relation picker can scope a link to —
 *  e.g. `{ type: "brainstorm/Task/v1", label: "Tasks" }`. Hosts supply the
 *  list (apps know their own types); the SDK form is type-agnostic. */
export type RelationTargetType = {
	type: string;
	label: string;
};

/** Split a free-text option blob into trimmed, de-duplicated labels. The
 *  inline Select field accepts one option per line *or* comma-separated, so a
 *  founder can paste "Lead, Qualified, Proposal, Won, Lost" or list them on
 *  separate lines and get the same dictionary. De-dupe is case-insensitive
 *  (first spelling wins) so "Won" and "won" don't both seed an item. */
export function parseSelectOptions(text: string): string[] {
	return dedupeSelectOptions(text.split(/[\n,]/));
}

/** Trim each label, drop blanks, collapse case-insensitive duplicates (first
 *  spelling wins). Shared by the text parser and the array path so a caller
 *  passing `options: [...]` directly gets the same hygiene as the form. */
export function dedupeSelectOptions(labels: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of labels) {
		const label = raw.trim();
		if (label.length === 0) continue;
		const key = label.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(label);
	}
	return out;
}

function buildDictionaryItems(labels: readonly string[]): DictionaryItem[] {
	return labels.map((label, sortIndex) => ({
		id: newDictionaryItemId(),
		label,
		icon: null,
		sortIndex,
	}));
}

export type InlinePropertyFormInput = {
	name: string;
	primary: InlinePrimaryKind;
	textFormat: InlineTextFormat;
	multi: boolean;
	/** Number sub-format. Defaults to Plain; only consulted when
	 *  `primary === Number`. */
	numberFormat?: InlineNumberFormat;
	/** ISO-4217 code for a Currency number property. Defaults to USD; only
	 *  consulted when `numberFormat === Currency`. */
	currency?: string;
	/** Seed values for a Select / MultiSelect dictionary, created inline so a
	 *  lifecycle ("Lead → Won") is one-shot. Empty/whitespace entries are
	 *  dropped and duplicates collapsed; only consulted when `primary ===
	 *  Select`. An empty list mints an empty dictionary (the prior behaviour —
	 *  options are then added in Settings → Data). */
	options?: readonly string[];
	/** Target entity types for a Relation. When non-empty the def carries
	 *  `allowedTypes`, so the link picker scopes its candidates (link to Tasks
	 *  / People, not just notes). Empty / absent = link to anything; only
	 *  consulted when `primary === Relation`. */
	allowedTypes?: readonly string[];
	/** Arithmetic expression for a Formula property (`{qty} * {rate}`). Required
	 *  + must compile; only consulted when `primary === Formula`. */
	formulaExpression?: string;
};

export type InlinePropertyDraft = {
	def: PropertyDef;
	/** When the picked preset is `Select` / `MultiSelect`, an empty
	 *  dictionary is minted alongside the def — its id matches the
	 *  def's `vocabulary.dictionaryId`. Callers must commit the
	 *  dictionary first, then the def. */
	dictionary: Dictionary | null;
};

export type InlinePropertyDraftResult =
	| { ok: true; value: InlinePropertyDraft }
	| { ok: false; errors: readonly string[] };

/** Build a fresh PropertyDef (and Dictionary when needed) from the
 *  inline-form fields. */
export function draftInlineProperty(input: InlinePropertyFormInput): InlinePropertyDraftResult {
	const name = input.name.trim();
	if (name.length === 0) {
		return { ok: false, errors: ["name must be non-empty"] };
	}
	const preset = resolveInlinePreset(input.primary, input.textFormat, input.multi);

	let dictionary: Dictionary | null = null;
	let vocabulary: { dictionaryId: string } | undefined;
	if (preset === PropertyKindPreset.Select || preset === PropertyKindPreset.MultiSelect) {
		const dictionaryId = newDictionaryId();
		const items = buildDictionaryItems(dedupeSelectOptions(input.options ?? []));
		dictionary = { id: dictionaryId, name, items };
		vocabulary = { dictionaryId };
	}

	// A typed Relation pins `allowedTypes`; an untyped one (empty list) links to
	// anything and leaves the field off so the picker keeps its default scope.
	const allowedTypes =
		input.primary === InlinePrimaryKind.Relation
			? (input.allowedTypes ?? []).filter((t) => t.trim().length > 0)
			: [];

	let def: PropertyDef;
	try {
		def = defForPreset(preset, {
			key: newPropertyKey(),
			name,
			...(vocabulary ? { vocabulary } : {}),
			...(allowedTypes.length > 0 ? { allowedTypes } : {}),
		});
	} catch (err) {
		return {
			ok: false,
			errors: [err instanceof Error ? err.message : String(err)],
		};
	}

	// Number sub-format: Currency / Percent are `format` modifiers layered onto
	// the plain Number def. Currency also carries an ISO-4217 code (per-property,
	// shared by every value in the column). Plain leaves the def untouched.
	if (input.primary === InlinePrimaryKind.Number) {
		const numberFormat = input.numberFormat ?? InlineNumberFormat.Plain;
		if (numberFormat === InlineNumberFormat.Currency) {
			def = {
				...def,
				format: PropertyFormat.Currency,
				currency: (input.currency ?? DEFAULT_CURRENCY_CODE).trim().toUpperCase(),
			};
		} else if (numberFormat === InlineNumberFormat.Percent) {
			def = { ...def, format: PropertyFormat.Percent };
		} else if (numberFormat === InlineNumberFormat.Duration) {
			def = { ...def, format: PropertyFormat.Duration };
		}
	}

	// Relation cardinality: the `Link` preset defaults to multi (max 50); a
	// single-target relation (the `multi` toggle off) clamps to {0,1} so the
	// link cell renders one chip and the picker closes on pick.
	if (input.primary === InlinePrimaryKind.Relation && !input.multi) {
		def = { ...def, count: { min: 0, max: 1 } };
	}

	// Formula: the expression must be present + compile. The Formula preset
	// already set `format=formula`; attach the validated expression.
	if (input.primary === InlinePrimaryKind.Formula) {
		const expression = (input.formulaExpression ?? "").trim();
		const compiled = compileFormula(expression);
		if (!compiled.ok) return { ok: false, errors: [compiled.error] };
		def = { ...def, formula: expression };
	}

	const check = validatePropertyDef(def);
	if (!check.ok) return { ok: false, errors: check.errors };
	return { ok: true, value: { def, dictionary } };
}
