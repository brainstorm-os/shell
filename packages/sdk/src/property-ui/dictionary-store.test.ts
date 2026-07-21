import type { Dictionary, DictionaryItem } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { type DictionaryBackend, DictionaryStore } from "./dictionary-store";

function makeBackend(overrides: Partial<DictionaryBackend> = {}): {
	backend: DictionaryBackend;
	setDictionary: ReturnType<typeof vi.fn>;
	removeDictionary: ReturnType<typeof vi.fn>;
} {
	const setDictionary = vi.fn(overrides.setDictionary ?? (async () => undefined));
	const removeDictionary = vi.fn(overrides.removeDictionary ?? (async () => undefined));
	return { backend: { setDictionary, removeDictionary }, setDictionary, removeDictionary };
}

const item = (id: string, label = id, sortIndex = 0): DictionaryItem => ({
	id,
	label,
	icon: null,
	sortIndex,
});

const dict = (id: string, name = "Status", items: DictionaryItem[] = []): Dictionary => ({
	id,
	name,
	items,
});

describe("DictionaryStore (VP-5 SDK proxy)", () => {
	it("starts empty and not-loaded", () => {
		const { backend } = makeBackend();
		const store = new DictionaryStore({ backend });
		expect(store.getSnapshot().size).toBe(0);
		expect(store.isLoaded()).toBe(false);
	});

	it("applySnapshot hydrates the map + flips isLoaded", () => {
		const { backend } = makeBackend();
		const store = new DictionaryStore({ backend });
		const listener = vi.fn();
		store.subscribe(listener);
		store.applySnapshot({
			dict_a: dict("dict_a", "Status", [item("di_1")]),
		});
		expect(store.isLoaded()).toBe(true);
		expect(store.get("dict_a")?.items.length).toBe(1);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("put() optimistically updates and dispatches setDictionary", () => {
		const { backend, setDictionary } = makeBackend();
		const store = new DictionaryStore({ backend });
		store.put(dict("dict_a"));
		expect(store.get("dict_a")?.name).toBe("Status");
		expect(setDictionary).toHaveBeenCalledOnce();
	});

	it("put() reverts when the service rejects", async () => {
		const { backend } = makeBackend({
			setDictionary: vi.fn().mockRejectedValue(new Error("Invalid")),
		});
		const onPersistError = vi.fn();
		const store = new DictionaryStore({ backend, onPersistError });
		store.put(dict("dict_bad"));
		await flushMicrotasks();
		expect(store.get("dict_bad")).toBeUndefined();
		expect(onPersistError).toHaveBeenCalledOnce();
	});

	it("remove() optimistically deletes and dispatches removeDictionary", async () => {
		const { backend, removeDictionary } = makeBackend();
		const store = new DictionaryStore({ backend });
		store.applySnapshot({ dict_a: dict("dict_a") });
		await store.remove("dict_a");
		expect(store.get("dict_a")).toBeUndefined();
		expect(removeDictionary).toHaveBeenCalledWith("dict_a");
	});

	it("remove() is a no-op when the id is absent", async () => {
		const { backend, removeDictionary } = makeBackend();
		const store = new DictionaryStore({ backend });
		await store.remove("dict_missing");
		expect(removeDictionary).not.toHaveBeenCalled();
	});

	it("remove() restores when the service rejects", async () => {
		const { backend } = makeBackend({
			removeDictionary: vi.fn().mockRejectedValue(new Error("Unavailable")),
		});
		const onPersistError = vi.fn();
		const store = new DictionaryStore({ backend, onPersistError });
		store.applySnapshot({ dict_a: dict("dict_a") });
		await store.remove("dict_a");
		expect(store.get("dict_a")).toBeDefined();
		expect(onPersistError).toHaveBeenCalledOnce();
	});

	it("subscribe() returns an unsubscribe that stops further notifications", () => {
		const { backend } = makeBackend();
		const store = new DictionaryStore({ backend });
		const listener = vi.fn();
		const unsubscribe = store.subscribe(listener);
		store.put(dict("dict_a"));
		expect(listener).toHaveBeenCalledTimes(1);
		unsubscribe();
		store.put(dict("dict_b"));
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("dispose() ignores subsequent puts and applySnapshot", () => {
		const { backend, setDictionary } = makeBackend();
		const store = new DictionaryStore({ backend });
		store.dispose();
		store.put(dict("dict_a"));
		store.applySnapshot({ dict_b: dict("dict_b") });
		expect(setDictionary).not.toHaveBeenCalled();
		expect(store.getSnapshot().size).toBe(0);
	});
});

function flushMicrotasks(): Promise<void> {
	return new Promise<void>((resolve) => queueMicrotask(resolve));
}
