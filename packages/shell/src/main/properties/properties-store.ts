/**
 * Vault-level property + dictionary store (VP-2).
 *
 * Properties + dictionaries are vault-scoped foundations shared across
 * every first-party app (Notes, Database, Graph) and future apps — per
 *
 * and the [[properties-are-vault-level]] memory. Their authoritative
 * store lives here in the shell; apps consume them through the SDK
 * service surface (VP-3).
 *
 * Schema (top-level on the Yjs doc):
 *
 *   properties   : Y.Map<string, string>   — propertyKey → JSON(PropertyDef)
 *   dictionaries : Y.Map<string, string>   — dictionaryId → JSON(Dictionary)
 *
 * Each entry is stored as a JSON-stringified blob (rather than a nested
 * `Y.Map` per entry, the way `DashboardStore` does for icons + widgets)
 * because property defs + dictionaries carry nested data (icons,
 * options, items) that doesn't benefit from per-field CRDT merge. The
 * typical edit replaces the whole entry from the constructor; Stage-10
 * sync uses entry-level last-write-wins, which matches the user's
 * mental model. When CRDT-merge use cases appear (concurrent rename +
 * options-edit on the same property from two devices), we can promote
 * to nested `Y.Map`s without changing the snapshot API.
 *
 * Persists via the existing YDocStore (one file per logical doc) at a
 * fixed id `brainstorm-Properties` — file lands at
 * `<vault>/data/`.
 *
 * Stage-9 promotion: each entry becomes a `PropertySchema/v2` or
 * `Vocabulary/v1` entity via a one-shot read-and-store importer. The
 * on-disk shape doesn't change.
 *
 * Pure module (no Electron imports) so it can be unit-tested under
 * Bun's Vitest with an on-disk `YDocStore` against a temp dir, just
 * like `DashboardStore`.
 */

import { defForPreset, validateDictionary, validatePropertyDef } from "@brainstorm-os/sdk";
import type { Dictionary, PropertyDef } from "@brainstorm-os/sdk-types";
import { PropertyKindPreset } from "@brainstorm-os/sdk-types";
import type * as Y from "yjs";
import type { YDocStore } from "../storage/ydoc-store";

export const PROPERTIES_DOC_ID = "brainstorm-Properties";

export type PropertiesSnapshot = {
	properties: Record<string, PropertyDef>;
	dictionaries: Record<string, Dictionary>;
};

const EMPTY_SNAPSHOT: PropertiesSnapshot = Object.freeze({
	properties: Object.freeze({}) as Record<string, PropertyDef>,
	dictionaries: Object.freeze({}) as Record<string, Dictionary>,
});

export type PropertiesStoreOptions = {
	docId?: string;
};

/**
 * Reactive wrapper around the properties Yjs doc. Persists every
 * committed update to the YDocStore tail (compacted past 256 KB) and
 * surfaces a typed snapshot stream for the IPC broker (VP-3) +
 * settings UI (VP-4).
 *
 * Construct via `PropertiesStore.open(yStore)` — the static factory
 * loads any existing file before wiring observers, which prevents the
 * constructor from persisting the initial empty state.
 */
export class PropertiesStore {
	private readonly doc: Y.Doc;
	private readonly yStore: YDocStore;
	private readonly docId: string;
	private readonly listeners = new Set<(snap: PropertiesSnapshot) => void>();
	private updateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;
	private pendingPersist: Promise<void> = Promise.resolve();
	private closed = false;

	private constructor(doc: Y.Doc, yStore: YDocStore, docId: string) {
		this.doc = doc;
		this.yStore = yStore;
		this.docId = docId;
	}

	/**
	 * Open (or create) the properties store. Loads any persisted state,
	 * then wires the update observer so subsequent changes flow back to
	 * disk.
	 */
	static async open(
		yStore: YDocStore,
		options: PropertiesStoreOptions = {},
	): Promise<PropertiesStore> {
		const docId = options.docId ?? PROPERTIES_DOC_ID;
		const { doc } = await yStore.load(docId);
		const store = new PropertiesStore(doc, yStore, docId);
		store.wireObservers();
		return store;
	}

	private wireObservers(): void {
		const handler = (update: Uint8Array, origin: unknown) => {
			if (origin === "load") return;
			this.pendingPersist = this.pendingPersist.then(async () => {
				if (this.closed) return;
				try {
					await this.yStore.appendAndMaybeCompact(this.docId, update);
				} catch (err) {
					// A failed tail append (disk error, or the vault dir torn
					// down while close() drains in the background — dispose()
					// fire-and-forgets close()) must not poison the persist
					// chain into an unhandled rejection. The in-memory doc keeps
					// the update; surface it as a log, not a process crash.
					console.warn(`[shell/properties-store] persist failed for ${this.docId}:`, err);
				}
			});
			this.notify();
		};
		this.updateHandler = handler;
		this.doc.on("update", handler);
	}

	/** Subscribe to typed snapshots. Fires once synchronously with the
	 *  current snapshot, then on every subsequent update. Returns an
	 *  unsubscribe function. */
	subscribe(listener: (snap: PropertiesSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.snapshot());
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Wait for any in-flight persist to settle — useful in tests. */
	async flush(): Promise<void> {
		await this.pendingPersist;
	}

	/** Release observers; persist queue is drained before resolving. */
	async close(): Promise<void> {
		this.closed = true;
		if (this.updateHandler) {
			this.doc.off("update", this.updateHandler);
			this.updateHandler = null;
		}
		this.listeners.clear();
		await this.pendingPersist;
	}

	snapshot(): PropertiesSnapshot {
		if (this.closed) return EMPTY_SNAPSHOT;
		return {
			properties: this.readProperties(),
			dictionaries: this.readDictionaries(),
		};
	}

	/** Insert or update a PropertyDef. Validation happens here at the
	 *  authoritative boundary — apps + UI revalidate on their side, but
	 *  the shell enforces. Invalid defs throw `Error` synchronously so
	 *  the IPC handler can surface a structured `Invalid` to the caller. */
	setProperty(def: PropertyDef): void {
		const validation = validatePropertyDef(def);
		if (!validation.ok) {
			throw new Error(`PropertiesStore.setProperty(${def.key}): ${validation.errors.join("; ")}`);
		}
		const map = this.doc.getMap<string>("properties");
		this.doc.transact(() => {
			map.set(def.key, JSON.stringify(def));
		});
	}

	removeProperty(key: string): void {
		const map = this.doc.getMap<string>("properties");
		if (!map.has(key)) return;
		this.doc.transact(() => {
			map.delete(key);
		});
	}

	setDictionary(dict: Dictionary): void {
		const validation = validateDictionary(dict);
		if (!validation.ok) {
			throw new Error(`PropertiesStore.setDictionary(${dict.id}): ${validation.errors.join("; ")}`);
		}
		const map = this.doc.getMap<string>("dictionaries");
		this.doc.transact(() => {
			map.set(dict.id, JSON.stringify(dict));
		});
	}

	removeDictionary(id: string): void {
		const map = this.doc.getMap<string>("dictionaries");
		if (!map.has(id)) return;
		this.doc.transact(() => {
			map.delete(id);
		});
	}

	private readProperties(): Record<string, PropertyDef> {
		const map = this.doc.getMap<string>("properties");
		const out: Record<string, PropertyDef> = {};
		for (const [key, raw] of map.entries()) {
			const def = decodeProperty(raw);
			if (def && def.key === key) out[key] = def;
		}
		return out;
	}

	private readDictionaries(): Record<string, Dictionary> {
		const map = this.doc.getMap<string>("dictionaries");
		const out: Record<string, Dictionary> = {};
		for (const [id, raw] of map.entries()) {
			const dict = decodeDictionary(raw);
			if (dict && dict.id === id) out[id] = dict;
		}
		return out;
	}

	private notify(): void {
		if (this.listeners.size === 0) return;
		const snap = this.snapshot();
		for (const listener of this.listeners) listener(snap);
	}
}

function decodeProperty(raw: unknown): PropertyDef | null {
	if (typeof raw !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const def = migratePropertyShape(parsed as Record<string, unknown>);
	const validation = validatePropertyDef(def as PropertyDef);
	if (!validation.ok) {
		console.warn(
			"[shell/properties-store] dropping malformed property:",
			validation.errors.join("; "),
		);
		return null;
	}
	return def as PropertyDef;
}

const LEGACY_KIND_PRESETS = new Set<string>(Object.values(PropertyKindPreset));

/** Read-time migration for legacy persisted shapes. An earlier build of
 *  the inline property creator stored the user-facing *preset* under
 *  `kind` (e.g. `"file"`, `"select"`, `"url"`) before the model moved
 *  to the canonical `valueType` + modifiers (composable property model:
 *  File = entityRef + allowedTypes, URL = text + format, …). A naive
 *  `kind → valueType` rename is wrong — `"file"` is not a `ValueType`
 *  and would still be dropped. Instead, treat the legacy `kind` as a
 *  `PropertyKindPreset` and rebuild the canonical def via the same
 *  `defForPreset` the current creator uses, preserving the stable key /
 *  name / icon (+ a pre-existing vocabulary for select-family).
 *  Without this, every property a user made on the old build fails
 *  `validatePropertyDef` ("unknown valueType undefined") and is
 *  silently dropped on read, so the whole catalog reads empty. The
 *  canonical shape is rewritten to disk the next time the property is
 *  edited; mirrors the Notes codec's read-time migrations. */
export function migratePropertyShape(raw: Record<string, unknown>): Record<string, unknown> {
	if (raw.valueType !== undefined || typeof raw.kind !== "string") return raw;
	const kind = raw.kind;
	const key = typeof raw.key === "string" ? raw.key : "";
	const name = typeof raw.name === "string" ? raw.name : key;
	if (!key || !LEGACY_KIND_PRESETS.has(kind)) {
		// Unknown legacy kind — fall back to a plain text def so the
		// property survives (visible + editable) rather than vanishing.
		const { kind: _dropped, ...rest } = raw;
		return { ...rest, key, name, valueType: "text" };
	}
	const vocabulary =
		raw.vocabulary && typeof raw.vocabulary === "object"
			? (raw.vocabulary as { dictionaryId: string })
			: undefined;
	try {
		const rebuilt = defForPreset(kind as PropertyKindPreset, {
			key,
			name,
			icon: (raw.icon as never) ?? null,
			...(vocabulary ? { vocabulary } : {}),
		});
		return rebuilt as unknown as Record<string, unknown>;
	} catch {
		// Select/MultiSelect with no stored vocabulary → defForPreset
		// throws; degrade to text so the property is still recoverable.
		const { kind: _dropped, ...rest } = raw;
		return { ...rest, key, name, valueType: "text" };
	}
}

function decodeDictionary(raw: unknown): Dictionary | null {
	if (typeof raw !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const validation = validateDictionary(parsed as Dictionary);
	if (!validation.ok) {
		console.warn(
			"[shell/properties-store] dropping malformed dictionary:",
			validation.errors.join("; "),
		);
		return null;
	}
	return parsed as Dictionary;
}
