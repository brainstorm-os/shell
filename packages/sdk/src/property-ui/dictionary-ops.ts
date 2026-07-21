/**
 * Pure dictionary mutation + value-rewrite operations behind the
 * DictionaryEditor (B5.8). DOM-free so the destructive paths (delete,
 * merge) get full node-env coverage.
 *
 * Two layers:
 *   - dictionary-shape edits (add / patch / archive / unarchive / delete
 *     / merge) return a NEW `Dictionary`;
 *   - value-rewrites take the vault's notes (id → values bag) and the
 *     properties bound to this dictionary, and return the notes whose
 *     bound values changed (so the host persists only those).
 *
 * A note's bound value for a `text + vocabulary` property is either a
 * scalar item id (Select) or a `LabeledValue<string>[]` (MultiSelect);
 * the rewrite handles both shapes.
 */

import type {
	Dictionary,
	DictionaryItem,
	LabeledValue,
	PropertyDef,
} from "@brainstorm-os/sdk-types";
import { isMultiValued } from "@brainstorm-os/sdk-types";
import { newDictionaryItemId } from "../properties-keys";
import { nextSortIndex } from "./dictionary-helpers";

export type NoteValues = { id: string; values: Record<string, unknown> };

function withItems(dict: Dictionary, items: DictionaryItem[]): Dictionary {
	return { ...dict, items };
}

export function addItem(dict: Dictionary, label = ""): { dict: Dictionary; item: DictionaryItem } {
	const item: DictionaryItem = {
		id: newDictionaryItemId(),
		label,
		icon: null,
		sortIndex: nextSortIndex(dict),
	};
	return { dict: withItems(dict, [...dict.items, item]), item };
}

export function patchItem(
	dict: Dictionary,
	id: string,
	patch: Partial<Omit<DictionaryItem, "id">>,
): Dictionary {
	return withItems(
		dict,
		dict.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
	);
}

export function archiveItem(dict: Dictionary, id: string, now = Date.now()): Dictionary {
	return patchItem(dict, id, { archivedAt: now });
}

export function unarchiveItem(dict: Dictionary, id: string): Dictionary {
	return withItems(
		dict,
		dict.items.map((it) => {
			if (it.id !== id) return it;
			const { archivedAt: _drop, ...rest } = it;
			return rest;
		}),
	);
}

export function renameDictionary(dict: Dictionary, name: string): Dictionary {
	return { ...dict, name };
}

/** Reorder `id` to sit at array index `toIndex` among the items and
 *  renumber every `sortIndex` densely (0..n-1) so Manual order is
 *  stable regardless of prior gaps. */
export function reorderItem(dict: Dictionary, id: string, toIndex: number): Dictionary {
	const ordered = [...dict.items].sort((a, b) => a.sortIndex - b.sortIndex);
	const from = ordered.findIndex((it) => it.id === id);
	if (from < 0) return dict;
	const clamped = Math.max(0, Math.min(toIndex, ordered.length - 1));
	const [moved] = ordered.splice(from, 1);
	if (!moved) return dict;
	ordered.splice(clamped, 0, moved);
	const reindexed = ordered.map((it, i) => ({ ...it, sortIndex: i }));
	const byId = new Map(reindexed.map((it) => [it.id, it]));
	return withItems(
		dict,
		dict.items.map((it) => byId.get(it.id) ?? it),
	);
}

/** Hard-delete `id` from the dictionary AND null it out of every bound
 *  note value. Returns the new dictionary + the notes that changed. */
export function deleteItem(
	dict: Dictionary,
	id: string,
	props: readonly PropertyDef[],
	notes: readonly NoteValues[],
): { dict: Dictionary; changed: NoteValues[] } {
	const nextDict = withItems(
		dict,
		dict.items.filter((it) => it.id !== id),
	);
	const changed = rewriteValues(props, notes, (current) => (current === id ? null : current));
	return { dict: nextDict, changed };
}

/** Merge `fromId` into `toId`: drop the source item, rewrite every
 *  note's bound value from the source id to the target id (de-duping
 *  multi-value envelopes), optionally relabel the target. */
export function mergeItems(
	dict: Dictionary,
	fromId: string,
	toId: string,
	props: readonly PropertyDef[],
	notes: readonly NoteValues[],
	relabel?: string,
): { dict: Dictionary; changed: NoteValues[] } {
	let items = dict.items.filter((it) => it.id !== fromId);
	if (relabel !== undefined) {
		items = items.map((it) => (it.id === toId ? { ...it, label: relabel } : it));
	}
	const changed = rewriteValues(props, notes, (current) => (current === fromId ? toId : current));
	return { dict: withItems(dict, items), changed };
}

/** Apply `map` to every bound value of every `dictionary`-backed
 *  property on every note. Scalar → `map(id)`; multi → map each
 *  element, drop nulls, de-dupe by value. Returns only changed notes. */
function rewriteValues(
	props: readonly PropertyDef[],
	notes: readonly NoteValues[],
	map: (current: string) => string | null,
): NoteValues[] {
	const out: NoteValues[] = [];
	for (const note of notes) {
		let mutated = false;
		const nextValues: Record<string, unknown> = { ...note.values };
		for (const def of props) {
			const raw = note.values[def.key];
			if (raw === undefined || raw === null) continue;
			if (isMultiValued(def.count)) {
				if (!Array.isArray(raw)) continue;
				const arr = raw as readonly LabeledValue<string>[];
				const seen = new Set<string>();
				const rebuilt: LabeledValue<string>[] = [];
				for (const el of arr) {
					const mapped = map(el.value);
					if (mapped === null || seen.has(mapped)) continue;
					seen.add(mapped);
					rebuilt.push(mapped === el.value ? el : { value: mapped });
				}
				if (rebuilt.length !== arr.length || rebuilt.some((el, i) => el.value !== arr[i]?.value)) {
					nextValues[def.key] = rebuilt;
					mutated = true;
				}
			} else if (typeof raw === "string") {
				const mapped = map(raw);
				if (mapped !== raw) {
					if (mapped === null) delete nextValues[def.key];
					else nextValues[def.key] = mapped;
					mutated = true;
				}
			}
		}
		if (mutated) out.push({ id: note.id, values: nextValues });
	}
	return out;
}

/** The properties whose vocabulary points at `dictionaryId`. */
export function propertiesForDictionary(
	props: Iterable<PropertyDef>,
	dictionaryId: string,
): PropertyDef[] {
	const out: PropertyDef[] = [];
	for (const def of props) {
		if (def.vocabulary?.dictionaryId === dictionaryId) out.push(def);
	}
	return out;
}

/** Usage index: item id → number of notes that bind it through any
 *  `dictionary`-backed property. Powers the "used by N notes" badge +
 *  Most-used sort. */
export function usageIndex(
	props: readonly PropertyDef[],
	notes: readonly NoteValues[],
): Map<string, number> {
	const counts = new Map<string, number>();
	const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
	for (const note of notes) {
		const seenForNote = new Set<string>();
		for (const def of props) {
			const raw = note.values[def.key];
			if (raw === undefined || raw === null) continue;
			if (isMultiValued(def.count) && Array.isArray(raw)) {
				for (const el of raw as readonly LabeledValue<string>[]) {
					if (typeof el.value === "string") seenForNote.add(el.value);
				}
			} else if (typeof raw === "string") {
				seenForNote.add(raw);
			}
		}
		for (const id of seenForNote) bump(id);
	}
	return counts;
}
