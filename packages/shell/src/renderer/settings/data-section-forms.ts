/**
 * Pure-logic helpers for the Settings → Data tab forms.
 *
 * Separated from `data-section.tsx` so the validation + draft logic can
 * be unit-tested without rendering React. All functions are pure (one
 * `newDictionaryItemId()` per call where ids are minted) and return
 * fresh data — never mutate inputs.
 *
 * The shell-side `PropertiesStore.setProperty` / `setDictionary` will
 * re-validate via `@brainstorm-os/sdk` regardless of what this layer
 * approves; these helpers exist so the form can surface inline errors
 * close to the user without round-tripping IPC.
 */

import {
	defForPreset,
	newDictionaryItemId,
	newPropertyKey,
	validatePropertyDef,
} from "@brainstorm-os/sdk";
import {
	type Dictionary,
	type DictionaryItem,
	type PropertyDef,
	PropertyKindPreset,
} from "@brainstorm-os/sdk-types";

export type PropertyDraftInput = {
	name: string;
	preset: PropertyKindPreset;
	dictionaryId?: string | null;
};

export type DraftResult<T> = { ok: true; value: T } | { ok: false; errors: readonly string[] };

/**
 * Build a fresh `PropertyDef` from the new-property form fields, or
 * return the validation errors. Select / Multi-select require a
 * `dictionaryId`; everything else ignores it.
 */
export function draftPropertyDef(input: PropertyDraftInput): DraftResult<PropertyDef> {
	const name = input.name.trim();
	if (name.length === 0) {
		return { ok: false, errors: ["name must be non-empty"] };
	}

	const key = newPropertyKey();
	const needsVocabulary = requiresDictionary(input.preset);
	if (needsVocabulary && !input.dictionaryId) {
		return {
			ok: false,
			errors: [`dictionaryId is required for ${input.preset}`],
		};
	}

	let def: PropertyDef;
	try {
		def = defForPreset(input.preset, {
			key,
			name,
			...(needsVocabulary && input.dictionaryId
				? { vocabulary: { dictionaryId: input.dictionaryId } }
				: {}),
		});
	} catch (err) {
		return {
			ok: false,
			errors: [err instanceof Error ? err.message : String(err)],
		};
	}

	const check = validatePropertyDef(def);
	if (!check.ok) return { ok: false, errors: check.errors };
	return { ok: true, value: def };
}

/**
 * Build a fresh empty `Dictionary` with the given display name.
 * Returns validation errors if `name` is empty.
 */
export function draftDictionary(input: { id: string; name: string }): DraftResult<Dictionary> {
	const name = input.name.trim();
	if (name.length === 0) return { ok: false, errors: ["name must be non-empty"] };
	return { ok: true, value: { id: input.id, name, items: [] } };
}

/**
 * Rename a dictionary. Returns the dictionary unchanged when the new
 * name is identical (post-trim); rejects an empty new name.
 */
export function renameDictionary(dict: Dictionary, nextName: string): DraftResult<Dictionary> {
	const trimmed = nextName.trim();
	if (trimmed.length === 0) return { ok: false, errors: ["name must be non-empty"] };
	if (trimmed === dict.name) return { ok: true, value: dict };
	return { ok: true, value: { ...dict, name: trimmed } };
}

/**
 * Append an item with the given label. The new item's `sortIndex` is
 * `max(existing) + 1`. Caller supplies the id so the function stays
 * pure for the unit tests; the React layer mints via
 * `newDictionaryItemId()`. Rejects empty labels.
 */
export function appendDictionaryItem(
	dict: Dictionary,
	input: { id?: string; label: string },
): DraftResult<Dictionary> {
	const label = input.label.trim();
	if (label.length === 0) return { ok: false, errors: ["label must be non-empty"] };
	const maxIndex = dict.items.reduce((acc, it) => Math.max(acc, it.sortIndex), -1);
	const id = input.id ?? newDictionaryItemId();
	const next: DictionaryItem = {
		id,
		label,
		icon: null,
		sortIndex: maxIndex + 1,
	};
	return { ok: true, value: { ...dict, items: [...dict.items, next] } };
}

/**
 * Move the item at `index` up (-1) or down (+1). Items get sortIndex
 * values normalised to the array position so the visible order matches
 * what the user sees. Out-of-bounds / no-op cases return the input
 * unchanged.
 */
export function moveDictionaryItem(dict: Dictionary, index: number, delta: -1 | 1): Dictionary {
	const target = index + delta;
	if (index < 0 || index >= dict.items.length) return dict;
	if (target < 0 || target >= dict.items.length) return dict;
	const items = [...dict.items];
	const a = items[index];
	const b = items[target];
	if (!a || !b) return dict;
	items[index] = b;
	items[target] = a;
	const normalised = items.map((it, i) => ({ ...it, sortIndex: i }));
	return { ...dict, items: normalised };
}

/**
 * Drop the item with the given id; remaining items keep their relative
 * order with `sortIndex` re-normalised to array position. No-op when
 * the id isn't present.
 */
export function removeDictionaryItem(dict: Dictionary, itemId: string): Dictionary {
	if (!dict.items.some((it) => it.id === itemId)) return dict;
	const items = dict.items
		.filter((it) => it.id !== itemId)
		.map((it, i) => ({ ...it, sortIndex: i }));
	return { ...dict, items };
}

/**
 * Replace an existing item's label in place. Rejects empty labels.
 * No-op when the id isn't present.
 */
export function renameDictionaryItem(
	dict: Dictionary,
	itemId: string,
	nextLabel: string,
): DraftResult<Dictionary> {
	const label = nextLabel.trim();
	if (label.length === 0) return { ok: false, errors: ["label must be non-empty"] };
	if (!dict.items.some((it) => it.id === itemId)) return { ok: true, value: dict };
	const items = dict.items.map((it) => (it.id === itemId ? { ...it, label } : it));
	return { ok: true, value: { ...dict, items } };
}

/** The presets the form currently exposes — Link is not yet wired here
 *  because its entity-type ref UI lands with Stage 9 entities. */
export const SUPPORTED_PRESETS: readonly PropertyKindPreset[] = Object.freeze([
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

export function requiresDictionary(preset: PropertyKindPreset): boolean {
	return preset === PropertyKindPreset.Select || preset === PropertyKindPreset.MultiSelect;
}
