/**
 * Resolution of a `propertyId` against the **real** vault
 * `PropertiesSnapshot`: the `PropertyDef` (drives scalar formatting via
 * the shared pure core) and the vocabulary colour (a Select-shaped
 * PropertyDef → its `vocabulary.dictionaryId` → the matching
 * DictionaryItem's `colour`).
 *
 * Both walks go through `@brainstorm-os/sdk/property-ui/pure` so the
 * Database app and Notes share one implementation of the colour /
 * dictionary algebra (the VP-7 point — zero duplicated property logic).
 * Standalone (no `window.brainstorm`) keeps the demo fallbacks: no
 * PropertyDef (the cells.ts heuristic paints) and a null colour.
 *
 * Per [[feedback_vocabulary_colors_arent_tokens]]: a value's colour is
 * the dictionary entry's colour — chrome tokens never substitute for it.
 */

import type { Dictionary, PropertiesSnapshot, PropertyDef } from "@brainstorm-os/sdk-types";
import { activeItems } from "@brainstorm-os/sdk/property-ui/pure";

export type VocabResolver = (propertyId: string, value: string) => string | null;
export type VocabLabelResolver = (propertyId: string, optionId: string) => string | undefined;
export type PropertyDefResolver = (propertyId: string) => PropertyDef | undefined;

/** Build a `propertyId → PropertyDef` lookup over the vault snapshot.
 *  A `propertyId` may be a dotted path (`phones.value`); only the head
 *  segment names a property, so the lookup strips the tail. */
export function buildPropertyDefResolver(snapshot: PropertiesSnapshot | null): PropertyDefResolver {
	if (!snapshot) return () => undefined;
	return (propertyId) => {
		const dot = propertyId.indexOf(".");
		const key = dot === -1 ? propertyId : propertyId.slice(0, dot);
		return snapshot.properties[key];
	};
}

export function buildVocabularyResolver(
	snapshot: PropertiesSnapshot | null,
	fallback: VocabResolver,
): VocabResolver {
	if (!snapshot) return fallback;
	// `resolveVocabularyColor` is called synchronously per vocabulary
	// cell during board/calendar/timeline/grid paint. Materialising
	// `activeItems(dict)` per call (alloc + full scan) would be O(items)
	// per visible cell; instead the shared active-item algebra runs once
	// per dictionary into a `label → colour` index, lazily on first use.
	const indexByDict = new Map<string, Map<string, string>>();
	const indexFor = (dictId: string): Map<string, string> => {
		let index = indexByDict.get(dictId);
		if (!index) {
			index = new Map();
			const dict: Dictionary | undefined = snapshot.dictionaries[dictId];
			for (const item of activeItems(dict)) {
				// Select values store the option id (system option id == its key,
				// user option id is opaque) — index by id so a user-created
				// option's colour resolves, not just seeded ones.
				if (item.colour) index.set(item.id, item.colour);
			}
			indexByDict.set(dictId, index);
		}
		return index;
	};
	return (propertyId, value) => {
		const dot = propertyId.indexOf(".");
		const key = dot === -1 ? propertyId : propertyId.slice(0, dot);
		const dictId = snapshot.properties[key]?.vocabulary?.dictionaryId;
		if (dictId) {
			const colour = indexFor(dictId).get(value);
			if (colour) return colour;
		}
		return fallback(propertyId, value);
	};
}

/** Build a `(propertyId, optionId) → label` lookup over the snapshot — a Select
 *  value is stored as the option's id, but read-only paints (board / gallery
 *  cards, etc.) must show its human label, not "di_…" (F-031). Mirrors the
 *  colour resolver's lazy per-dictionary index. */
export function buildVocabularyLabelResolver(
	snapshot: PropertiesSnapshot | null,
): VocabLabelResolver {
	if (!snapshot) return () => undefined;
	const indexByDict = new Map<string, Map<string, string>>();
	const indexFor = (dictId: string): Map<string, string> => {
		let index = indexByDict.get(dictId);
		if (!index) {
			index = new Map();
			const dict: Dictionary | undefined = snapshot.dictionaries[dictId];
			for (const item of activeItems(dict)) index.set(item.id, item.label);
			indexByDict.set(dictId, index);
		}
		return index;
	};
	return (propertyId, optionId) => {
		const dot = propertyId.indexOf(".");
		const key = dot === -1 ? propertyId : propertyId.slice(0, dot);
		const dictId = snapshot.properties[key]?.vocabulary?.dictionaryId;
		return dictId ? indexFor(dictId).get(optionId) : undefined;
	};
}

// The renderers (board / calendar / timeline / cells) call the active
// resolvers synchronously during paint. They're installed once at app
// boot (demo / no-schema fallbacks) and swapped to the
// real-properties-backed ones when the vault snapshot loads / changes.
let activeColour: VocabResolver = () => null;
let activeLabel: VocabLabelResolver = () => undefined;
let activeDef: PropertyDefResolver = () => undefined;

export function installVocabularyResolver(resolver: VocabResolver): void {
	activeColour = resolver;
}

export function installVocabularyLabelResolver(resolver: VocabLabelResolver): void {
	activeLabel = resolver;
}

export function installPropertyDefResolver(resolver: PropertyDefResolver): void {
	activeDef = resolver;
}

export function resolveVocabularyColor(propertyId: string, value: string): string | null {
	return activeColour(propertyId, value);
}

/** A Select option's display label by its stored id, or `undefined` when not a
 *  known option (the caller falls back to the raw value). */
export function resolveVocabularyLabel(propertyId: string, optionId: string): string | undefined {
	return activeLabel(propertyId, optionId);
}

export function resolvePropertyDef(propertyId: string): PropertyDef | undefined {
	return activeDef(propertyId);
}
