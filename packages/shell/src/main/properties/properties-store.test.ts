import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dictionary, PropertyDef } from "@brainstorm-os/sdk-types";
import { ValueType } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { YDocStore } from "../storage/ydoc-store";
import { PROPERTIES_DOC_ID, PropertiesStore, migratePropertyShape } from "./properties-store";

const textProperty = (key: string, name = "Title"): PropertyDef => ({
	key,
	name,
	icon: null,
	valueType: ValueType.Text,
});

const selectProperty = (key: string, dictionaryId: string, name = "Status"): PropertyDef => ({
	key,
	name,
	icon: null,
	valueType: ValueType.Text,
	vocabulary: { dictionaryId },
	count: { min: 0, max: 1 },
});

const dictionary = (id: string, name = "Status"): Dictionary => ({
	id,
	name,
	items: [
		{ id: "di_a", label: "Todo", icon: null, sortIndex: 0 },
		{ id: "di_b", label: "Doing", icon: null, sortIndex: 1, colour: "#3b82f6" },
	],
});

describe("PropertiesStore", () => {
	let vaultDir: string;
	let yStore: YDocStore;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-properties-"));
		yStore = new YDocStore(vaultDir);
	});

	afterEach(async () => {
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("opens with an empty snapshot", async () => {
		const store = await PropertiesStore.open(yStore);
		const snap = store.snapshot();
		expect(snap.properties).toEqual({});
		expect(snap.dictionaries).toEqual({});
		await store.close();
	});

	it("uses the fixed PROPERTIES_DOC_ID by default", async () => {
		expect(PROPERTIES_DOC_ID).toBe("brainstorm-Properties");
		const store = await PropertiesStore.open(yStore);
		// File must land at the expected logical doc id; the assertion is
		// that re-opening with the same id sees the same data.
		store.setProperty(textProperty("prop_a", "A"));
		await store.flush();
		await store.close();

		const reopened = await PropertiesStore.open(yStore, { docId: PROPERTIES_DOC_ID });
		expect(reopened.snapshot().properties.prop_a?.name).toBe("A");
		await reopened.close();
	});

	it("setProperty persists and round-trips across re-open", async () => {
		const store = await PropertiesStore.open(yStore);
		store.setProperty(textProperty("prop_a", "Title"));
		store.setProperty(textProperty("prop_b", "Author"));
		await store.flush();
		await store.close();

		const reopened = await PropertiesStore.open(yStore);
		const snap = reopened.snapshot();
		expect(Object.keys(snap.properties).sort()).toEqual(["prop_a", "prop_b"]);
		expect(snap.properties.prop_a?.valueType).toBe(ValueType.Text);
		await reopened.close();
	});

	it("setProperty broadcasts a snapshot update to subscribers", async () => {
		const store = await PropertiesStore.open(yStore);
		const seen: string[][] = [];
		const unsubscribe = store.subscribe((snap) => seen.push(Object.keys(snap.properties).sort()));
		store.setProperty(textProperty("prop_a"));
		store.setProperty(textProperty("prop_b"));
		await store.flush();
		// First notification is the empty snapshot from subscribe(); then the
		// two updates land. We assert that the final state appeared.
		expect(seen.some((keys) => keys.length === 2 && keys.includes("prop_a"))).toBe(true);
		unsubscribe();
		await store.close();
	});

	it("setDictionary broadcasts a snapshot update to subscribers", async () => {
		// The Notes app's `runtime.services.properties.onChange` push
		// channel (VP-6) fans out from this subscribe callback. Without
		// it the broadcast wouldn't fire when a second device's sync peer
		// or another renderer renames / reorders a Dictionary, leaving
		// the running app with stale vocabulary data.
		const store = await PropertiesStore.open(yStore);
		const seen: string[][] = [];
		const unsubscribe = store.subscribe((snap) => seen.push(Object.keys(snap.dictionaries).sort()));
		store.setDictionary(dictionary("dict_a"));
		store.setDictionary(dictionary("dict_b", "Priority"));
		await store.flush();
		expect(
			seen.some((ids) => ids.length === 2 && ids.includes("dict_a") && ids.includes("dict_b")),
		).toBe(true);
		unsubscribe();
		await store.close();
	});

	it("setProperty validates kind-correct options", async () => {
		const store = await PropertiesStore.open(yStore);
		expect(() => store.setProperty({ ...textProperty("prop_bad"), name: "" })).toThrow(
			/name must be non-empty/,
		);
		// Snapshot stays empty since the throw aborts the write.
		expect(store.snapshot().properties).toEqual({});
		await store.close();
	});

	it("removeProperty erases the record without touching dictionaries", async () => {
		const store = await PropertiesStore.open(yStore);
		store.setProperty(textProperty("prop_a"));
		store.setDictionary(dictionary("dict_a"));
		store.removeProperty("prop_a");
		await store.flush();
		const snap = store.snapshot();
		expect(snap.properties).toEqual({});
		expect(snap.dictionaries.dict_a?.name).toBe("Status");
		await store.close();
	});

	it("removeProperty is a no-op when the key is absent", async () => {
		const store = await PropertiesStore.open(yStore);
		// No throw; the snapshot stays empty.
		expect(() => store.removeProperty("prop_missing")).not.toThrow();
		expect(store.snapshot().properties).toEqual({});
		await store.close();
	});

	it("setDictionary stores items and round-trips across re-open", async () => {
		const store = await PropertiesStore.open(yStore);
		const dict = dictionary("dict_status");
		store.setDictionary(dict);
		await store.flush();
		await store.close();

		const reopened = await PropertiesStore.open(yStore);
		const restored = reopened.snapshot().dictionaries.dict_status;
		expect(restored?.items.length).toBe(2);
		expect(restored?.items[0]?.label).toBe("Todo");
		expect(restored?.items[1]?.colour).toBe("#3b82f6");
		await reopened.close();
	});

	it("setDictionary rejects duplicate item ids at the boundary", async () => {
		const store = await PropertiesStore.open(yStore);
		const bad: Dictionary = {
			id: "dict_bad",
			name: "Bad",
			items: [
				{ id: "di_dup", label: "One", icon: null, sortIndex: 0 },
				{ id: "di_dup", label: "Two", icon: null, sortIndex: 1 },
			],
		};
		expect(() => store.setDictionary(bad)).toThrow(/duplicate/);
		expect(store.snapshot().dictionaries).toEqual({});
		await store.close();
	});

	it("removeDictionary erases the record", async () => {
		const store = await PropertiesStore.open(yStore);
		store.setDictionary(dictionary("dict_x"));
		store.removeDictionary("dict_x");
		await store.flush();
		expect(store.snapshot().dictionaries).toEqual({});
		await store.close();
	});

	it("malformed on-disk JSON for a property is dropped silently on read", async () => {
		// Simulate a corrupted row (older build / disk corruption / sync
		// race) by writing a bogus string directly into the underlying
		// Y.Map. Real callers go through setProperty, which validates.
		const store = await PropertiesStore.open(yStore);
		const doc = (store as unknown as { doc: Y.Doc }).doc;
		doc.getMap<string>("properties").set("prop_corrupt", "not-json-{{");
		await store.flush();
		expect(store.snapshot().properties).toEqual({});
		await store.close();
	});

	it("a row whose JSON-decoded key disagrees with the Y.Map key is dropped", async () => {
		const store = await PropertiesStore.open(yStore);
		const doc = (store as unknown as { doc: Y.Doc }).doc;
		const def = textProperty("prop_inner");
		doc.getMap<string>("properties").set("prop_outer", JSON.stringify(def));
		await store.flush();
		// The outer key doesn't match the inner def.key — dropped to avoid
		// confusing callers who index by the map key.
		expect(store.snapshot().properties).toEqual({});
		await store.close();
	});

	it("malformed dictionary JSON is dropped on read", async () => {
		const store = await PropertiesStore.open(yStore);
		const doc = (store as unknown as { doc: Y.Doc }).doc;
		doc.getMap<string>("dictionaries").set("dict_corrupt", "[invalid");
		await store.flush();
		expect(store.snapshot().dictionaries).toEqual({});
		await store.close();
	});

	it("subscribe fires synchronously with the current snapshot on attach", async () => {
		const store = await PropertiesStore.open(yStore);
		store.setProperty(textProperty("prop_a"));
		await store.flush();
		const seen: PropertyDef[][] = [];
		store.subscribe((snap) => seen.push(Object.values(snap.properties)));
		expect(seen.length).toBe(1);
		expect(seen[0]?.[0]?.key).toBe("prop_a");
		await store.close();
	});

	it("subscribe's unsubscribe stops further notifications", async () => {
		const store = await PropertiesStore.open(yStore);
		let count = 0;
		const unsubscribe = store.subscribe(() => count++);
		expect(count).toBe(1); // initial sync fire
		store.setProperty(textProperty("prop_a"));
		await store.flush();
		expect(count).toBe(2);
		unsubscribe();
		store.setProperty(textProperty("prop_b"));
		await store.flush();
		expect(count).toBe(2);
		await store.close();
	});

	it("flush before close drains every write to disk", async () => {
		const store = await PropertiesStore.open(yStore);
		store.setProperty(textProperty("prop_a"));
		store.setProperty(textProperty("prop_b"));
		// Same contract as DashboardStore: callers flush() to wait for the
		// in-flight persist chain, then close() releases observers. The
		// `closed` flag in the update handler short-circuits any chain
		// scheduled *after* close — so flushing first is required for the
		// rows to land on disk.
		await store.flush();
		await store.close();

		const reopened = await PropertiesStore.open(yStore);
		expect(Object.keys(reopened.snapshot().properties).sort()).toEqual(["prop_a", "prop_b"]);
		await reopened.close();
	});

	it("close idempotency: snapshot returns empty after close, listeners cleared", async () => {
		const store = await PropertiesStore.open(yStore);
		store.setProperty(textProperty("prop_a"));
		await store.flush();
		await store.close();
		expect(store.snapshot()).toEqual({ properties: {}, dictionaries: {} });
	});

	it("setProperty for an existing key replaces (last-write-wins)", async () => {
		const store = await PropertiesStore.open(yStore);
		store.setProperty(textProperty("prop_a", "First"));
		store.setProperty(textProperty("prop_a", "Second"));
		await store.flush();
		expect(store.snapshot().properties.prop_a?.name).toBe("Second");
		await store.close();
	});

	it("Select property + its dictionary co-exist in the same snapshot", async () => {
		const store = await PropertiesStore.open(yStore);
		store.setDictionary(dictionary("dict_status"));
		store.setProperty(selectProperty("prop_status", "dict_status"));
		await store.flush();
		const snap = store.snapshot();
		expect(snap.properties.prop_status?.valueType).toBe(ValueType.Text);
		expect(snap.properties.prop_status?.vocabulary?.dictionaryId).toBe("dict_status");
		expect(snap.dictionaries.dict_status?.items.length).toBe(2);
		await store.close();
	});
});

describe("migratePropertyShape (legacy `kind` → canonical `valueType`)", () => {
	it("leaves a canonical def untouched", () => {
		const def = { key: "k", name: "N", icon: null, valueType: "text" };
		expect(migratePropertyShape({ ...def })).toEqual(def);
	});

	it("rebuilds simple kinds to their base valueType", () => {
		expect(
			migratePropertyShape({ key: "p1", name: "Test", icon: null, kind: "text" }).valueType,
		).toBe(ValueType.Text);
		expect(
			migratePropertyShape({ key: "p2", name: "Price", icon: null, kind: "number" }).valueType,
		).toBe(ValueType.Number);
	});

	it("rebuilds the File preset to entityRef (not the invalid `file` valueType)", () => {
		// This is the exact row from the user's vault that was being
		// dropped — `kind:"file"` is a preset, not a ValueType.
		const out = migratePropertyShape({
			key: "prop_mp44rn5b_0y80pp",
			name: "Files",
			icon: null,
			kind: "file",
		});
		expect(out.valueType).toBe(ValueType.EntityRef);
		expect(out.kind).toBeUndefined();
		expect(Array.isArray(out.allowedTypes)).toBe(true);
	});

	it("preserves a stored vocabulary for select-family, else degrades to text", () => {
		const withVocab = migratePropertyShape({
			key: "s1",
			name: "Status",
			icon: null,
			kind: "select",
			vocabulary: { dictionaryId: "dict_x" },
		});
		expect(withVocab.valueType).toBe(ValueType.Text);
		expect((withVocab.vocabulary as { dictionaryId: string }).dictionaryId).toBe("dict_x");

		const noVocab = migratePropertyShape({ key: "s2", name: "Status", icon: null, kind: "select" });
		expect(noVocab.valueType).toBe(ValueType.Text);
	});

	it("an unknown legacy kind survives as text rather than vanishing", () => {
		const out = migratePropertyShape({ key: "u", name: "Mystery", icon: null, kind: "wat" });
		expect(out.valueType).toBe(ValueType.Text);
		expect(out.kind).toBeUndefined();
	});
});
