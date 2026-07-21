/**
 * Vault-level property + dictionary usage index (B5.10 shell half).
 *
 * Pure counting + a lazy-invalidating cache. The Settings → Data pane
 * uses the counts to show "used by N entities" affordances on each
 * registered property and on each vocabulary entry, so the user can
 * tell apart a property that's load-bearing across the vault from one
 * that's leftover from an old experiment.
 *
 * Two parallel indices land in one snapshot:
 *
 *  - `propertyUsage[propertyKey]` — number of live entities whose
 *    `properties[propertyKey]` carries a non-empty value. A key that
 *    isn't in the catalog (entity-type-private fields like `title` /
 *    `body`) still counts; the Settings pane filters by registered
 *    properties when rendering.
 *
 *  - `dictionaryUsage[dictionaryId]` — number of live entities whose
 *    value at a vocabulary-backed property names an item from that
 *    dictionary. Items the entity holds that aren't in the
 *    dictionary's `items[]` (stale ids that survived an item delete)
 *    are skipped so the count reflects *live* references only.
 *
 * Counts are **per entity**, not per value: an entity that puts three
 * MultiSelect tags from one dictionary on a single property still
 * contributes `+1` to that dictionary's usage. This matches the user's
 * mental model — "how many things use this" beats "how many slots".
 *
 * Lazy: the stateful `UsageIndex` caches the latest snapshot it built
 * and marks itself dirty when the vault tells it the entity graph
 * changed. The recompute happens on the next consumer read (typically
 * one tick after the broadcast), so a burst of writes during a paste /
 * import collapses to one scan.
 *
 * Pure module (no Electron / IO deps) so it can unit-test against
 * plain in-memory snapshots — same shape as `note-entities-codec`.
 */

import type { Dictionary, PropertyDef } from "@brainstorm-os/sdk-types";
import type { VaultEntity } from "../entities/vault-entities-service";

export type UsageCounts = {
	/** propertyKey → number of entities with a non-empty value there. */
	propertyUsage: Record<string, number>;
	/** Dictionary-item id → number of entities citing this specific item
	 *  through any vocabulary-backed property. Keyed by **item** id (not
	 *  dictionary id); items have stable globally-unique ids so a flat
	 *  map suffices and the Vocabulary editor can render a per-item
	 *  "used by N" affordance next to each label. Per-dictionary totals
	 *  are derived by the consumer when needed (a multi-select cite of
	 *  two items inside one dictionary still counts as one entity at the
	 *  dictionary level — see `computeDictionaryTotalsFromItems`). */
	dictionaryUsage: Record<string, number>;
};

export const EMPTY_USAGE_COUNTS: UsageCounts = Object.freeze({
	propertyUsage: Object.freeze({}) as Record<string, number>,
	dictionaryUsage: Object.freeze({}) as Record<string, number>,
});

/** Treat `null`, `undefined`, `""`, `[]`, and `{}` as "no value". A
 *  property explicitly set to `false` or `0` IS a value — those carry
 *  meaning in boolean / number columns. */
function hasValue(v: unknown): boolean {
	if (v == null) return false;
	if (typeof v === "string") return v.length > 0;
	if (Array.isArray(v)) return v.length > 0;
	if (typeof v === "object") return Object.keys(v as object).length > 0;
	return true;
}

/** Count entities that have a non-empty value at each property key.
 *  Pure. `O(entities × propertiesPerEntity)`. */
export function computePropertyUsage(entities: readonly VaultEntity[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const e of entities) {
		const props = e.properties;
		if (!props || typeof props !== "object") continue;
		for (const key of Object.keys(props)) {
			if (!hasValue(props[key])) continue;
			out[key] = (out[key] ?? 0) + 1;
		}
	}
	return out;
}

/** Count entities citing each dictionary item, keyed by **item** id.
 *  Pure. An item is "cited" when any vocabulary-backed property on the
 *  entity holds its id (string value) or contains it in a multi-value
 *  array. Each (entity, item) pair credits at most one — repeated tags
 *  inside the same array still count as one entity. Items that are
 *  archived (`archivedAt != null`) never receive credit, so deleting a
 *  vocabulary item by archive doesn't ghost its count back from older
 *  entities that still mention the id. */
export function computeDictionaryUsage(
	entities: readonly VaultEntity[],
	propertyDefs: Record<string, PropertyDef>,
	dictionaries: Record<string, Dictionary>,
): Record<string, number> {
	const liveItemIdsByDict = new Map<string, Set<string>>();
	for (const [dictId, dict] of Object.entries(dictionaries)) {
		const ids = new Set<string>();
		for (const item of dict.items) {
			if (item.archivedAt == null) ids.add(item.id);
		}
		liveItemIdsByDict.set(dictId, ids);
	}

	const vocabPropToItems = new Map<string, ReadonlySet<string>>();
	for (const def of Object.values(propertyDefs)) {
		const dictId = def.vocabulary?.dictionaryId;
		if (!dictId) continue;
		const live = liveItemIdsByDict.get(dictId);
		if (live && live.size > 0) vocabPropToItems.set(def.key, live);
	}
	if (vocabPropToItems.size === 0) return {};

	const out: Record<string, number> = {};
	for (const e of entities) {
		const props = e.properties;
		if (!props || typeof props !== "object") continue;
		const credited = new Set<string>();
		for (const [propKey, liveItems] of vocabPropToItems) {
			collectCitedItems(props[propKey], liveItems, credited);
		}
		for (const itemId of credited) out[itemId] = (out[itemId] ?? 0) + 1;
	}
	return out;
}

function collectCitedItems(
	value: unknown,
	liveItems: ReadonlySet<string>,
	credited: Set<string>,
): void {
	if (typeof value === "string") {
		if (liveItems.has(value)) credited.add(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) {
			if (typeof v === "string" && liveItems.has(v)) credited.add(v);
		}
	}
}

/** Optional derived view: per-dictionary entity counts. Sums per-item
 *  counts but de-dupes entities that cite multiple items inside the
 *  same dictionary (e.g. a multi-select with both "red" and "blue"
 *  from one Tags dictionary counts as one entity). Recomputed from the
 *  same source entities — the per-item flat map alone can't recover it
 *  without re-walking the entity values, hence this convenience. */
export function computeDictionaryTotalsFromItems(
	entities: readonly VaultEntity[],
	propertyDefs: Record<string, PropertyDef>,
	dictionaries: Record<string, Dictionary>,
): Record<string, number> {
	const liveByDict = new Map<string, Set<string>>();
	for (const [dictId, dict] of Object.entries(dictionaries)) {
		const live = new Set<string>();
		for (const item of dict.items) {
			if (item.archivedAt == null) live.add(item.id);
		}
		liveByDict.set(dictId, live);
	}
	const vocabPropToDict = new Map<string, string>();
	for (const def of Object.values(propertyDefs)) {
		const dictId = def.vocabulary?.dictionaryId;
		if (dictId && liveByDict.has(dictId)) vocabPropToDict.set(def.key, dictId);
	}

	const out: Record<string, number> = {};
	for (const e of entities) {
		const props = e.properties;
		if (!props || typeof props !== "object") continue;
		const seen = new Set<string>();
		for (const [propKey, dictId] of vocabPropToDict) {
			if (seen.has(dictId)) continue;
			const value = props[propKey];
			const live = liveByDict.get(dictId);
			if (!live) continue;
			if (referencesLiveItem(value, live)) seen.add(dictId);
		}
		for (const dictId of seen) out[dictId] = (out[dictId] ?? 0) + 1;
	}
	return out;
}

function referencesLiveItem(value: unknown, liveIds: ReadonlySet<string> | undefined): boolean {
	if (!liveIds || liveIds.size === 0) return false;
	if (typeof value === "string") return liveIds.has(value);
	if (Array.isArray(value)) {
		for (const v of value) if (typeof v === "string" && liveIds.has(v)) return true;
	}
	return false;
}

/** Compose both indices in one pass over `entities`. Convenience over
 *  computePropertyUsage + computeDictionaryUsage — the latter walks
 *  entities a second time, which is fine for clarity but the index
 *  fast-path takes this one. */
export function computeUsageCounts(
	entities: readonly VaultEntity[],
	propertyDefs: Record<string, PropertyDef>,
	dictionaries: Record<string, Dictionary>,
): UsageCounts {
	return {
		propertyUsage: computePropertyUsage(entities),
		dictionaryUsage: computeDictionaryUsage(entities, propertyDefs, dictionaries),
	};
}

export type EntitiesSnapshotReader = () => Promise<readonly VaultEntity[]>;
export type PropertiesCatalogReader = () => {
	properties: Record<string, PropertyDef>;
	dictionaries: Record<string, Dictionary>;
};

/**
 * Lazy + invalidating wrapper around `computeUsageCounts`. The shell
 * wires `invalidate()` to the same channel that fires the
 * `app:vault-entities-changed` broadcast (every entity write the shell
 * cares about); the next consumer call to `snapshot()` returns the
 * recomputed result, all earlier consumers in the same tick share the
 * one in-flight computation.
 *
 * Construct via `new UsageIndex({ readEntities, readCatalog })`. Both
 * readers stay alive across vault re-opens — the session owns the
 * UsageIndex's lifetime and re-creates a fresh one on vault switch.
 */
export class UsageIndex {
	private readonly readEntities: EntitiesSnapshotReader;
	private readonly readCatalog: PropertiesCatalogReader;
	private cached: UsageCounts | null = null;
	private inflight: Promise<UsageCounts> | null = null;
	private dirty = true;

	constructor(opts: { readEntities: EntitiesSnapshotReader; readCatalog: PropertiesCatalogReader }) {
		this.readEntities = opts.readEntities;
		this.readCatalog = opts.readCatalog;
	}

	/** Mark the cache dirty; the next `snapshot()` triggers one recompute. */
	invalidate(): void {
		this.dirty = true;
	}

	/** Resolve to the latest counts. Returns the cached value if clean;
	 *  otherwise runs one recompute (concurrent callers share it). Never
	 *  rejects — a reader failure resolves to the empty snapshot. */
	async snapshot(): Promise<UsageCounts> {
		if (!this.dirty && this.cached) return this.cached;
		if (this.inflight) return this.inflight;
		this.inflight = this.recompute().finally(() => {
			this.inflight = null;
		});
		return this.inflight;
	}

	private async recompute(): Promise<UsageCounts> {
		let entities: readonly VaultEntity[];
		try {
			entities = await this.readEntities();
		} catch (error) {
			const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			console.error(`[shell/usage-index] entities read failed (empty counts): ${detail}`);
			this.cached = EMPTY_USAGE_COUNTS;
			this.dirty = false;
			return this.cached;
		}
		let catalog: {
			properties: Record<string, PropertyDef>;
			dictionaries: Record<string, Dictionary>;
		};
		try {
			catalog = this.readCatalog();
		} catch (error) {
			const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			console.error(`[shell/usage-index] catalog read failed (empty counts): ${detail}`);
			this.cached = EMPTY_USAGE_COUNTS;
			this.dirty = false;
			return this.cached;
		}
		this.cached = computeUsageCounts(entities, catalog.properties, catalog.dictionaries);
		this.dirty = false;
		return this.cached;
	}
}
