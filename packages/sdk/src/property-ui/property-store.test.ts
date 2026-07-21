import type { PropertyDef } from "@brainstorm-os/sdk-types";
import { ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { type PropertyBackend, PropertyStore } from "./property-store";

function makeBackend(overrides: Partial<PropertyBackend> = {}): {
	backend: PropertyBackend;
	setProperty: ReturnType<typeof vi.fn>;
	removeProperty: ReturnType<typeof vi.fn>;
} {
	const setProperty = vi.fn(overrides.setProperty ?? (async () => undefined));
	const removeProperty = vi.fn(overrides.removeProperty ?? (async () => undefined));
	return { backend: { setProperty, removeProperty }, setProperty, removeProperty };
}

const textDef = (key: string, name = "Title"): PropertyDef => ({
	key,
	name,
	icon: null,
	valueType: ValueType.Text,
});

describe("PropertyStore (VP-5 SDK proxy)", () => {
	it("starts empty and not-loaded; getSnapshot is reference-stable", () => {
		const { backend } = makeBackend();
		const store = new PropertyStore({ backend });
		expect(store.getSnapshot().size).toBe(0);
		expect(store.isLoaded()).toBe(false);
		expect(store.getSnapshot()).toBe(store.getSnapshot());
	});

	it("applySnapshot hydrates the map + flips isLoaded + notifies subscribers", () => {
		const { backend } = makeBackend();
		const store = new PropertyStore({ backend });
		const listener = vi.fn();
		store.subscribe(listener);
		store.applySnapshot({
			prop_a: textDef("prop_a", "A"),
			prop_b: textDef("prop_b", "B"),
		});
		expect(store.isLoaded()).toBe(true);
		expect(store.getSnapshot().size).toBe(2);
		expect(store.get("prop_a")?.name).toBe("A");
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("put() updates the snapshot synchronously and dispatches setProperty", () => {
		const { backend, setProperty } = makeBackend();
		const store = new PropertyStore({ backend });
		const listener = vi.fn();
		store.subscribe(listener);
		store.put(textDef("prop_a"));
		expect(store.get("prop_a")?.name).toBe("Title");
		expect(listener).toHaveBeenCalledTimes(1);
		expect(setProperty).toHaveBeenCalledOnce();
		expect(setProperty).toHaveBeenCalledWith(textDef("prop_a"));
	});

	it("put() reverts the optimistic snapshot when the service rejects", async () => {
		const { backend } = makeBackend({
			setProperty: vi.fn().mockRejectedValue(new Error("CapabilityDenied")),
		});
		const onPersistError = vi.fn();
		const store = new PropertyStore({ backend, onPersistError });
		const listener = vi.fn();
		store.subscribe(listener);
		store.put(textDef("prop_a"));
		expect(store.get("prop_a")?.name).toBe("Title");
		await flushMicrotasks();
		expect(store.get("prop_a")).toBeUndefined();
		expect(onPersistError).toHaveBeenCalledOnce();
		expect(onPersistError.mock.calls[0]?.[0]).toBe("prop_a");
		// Optimistic apply + revert = two emit ticks.
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("put() does NOT revert when a later snapshot has moved the entry on", async () => {
		const setProperty = vi
			.fn()
			.mockRejectedValueOnce(new Error("CapabilityDenied"))
			.mockResolvedValueOnce(undefined);
		const store = new PropertyStore({
			backend: { setProperty, removeProperty: vi.fn() },
			onPersistError: () => undefined,
		});
		store.put(textDef("prop_a", "v1"));
		// A second successful write replaces v1 with v2 before the v1
		// rejection lands. The revert handler for v1 must see that the
		// current entry is no longer v1 and skip the revert.
		store.put(textDef("prop_a", "v2"));
		await flushMicrotasks();
		expect(store.get("prop_a")?.name).toBe("v2");
	});

	it("remove() updates the snapshot synchronously and dispatches removeProperty", async () => {
		const { backend, removeProperty } = makeBackend();
		const store = new PropertyStore({ backend });
		store.applySnapshot({ prop_a: textDef("prop_a") });
		await store.remove("prop_a");
		expect(store.get("prop_a")).toBeUndefined();
		expect(removeProperty).toHaveBeenCalledWith("prop_a");
	});

	it("remove() is a no-op when the key is absent (no service call)", async () => {
		const { backend, removeProperty } = makeBackend();
		const store = new PropertyStore({ backend });
		await store.remove("prop_missing");
		expect(removeProperty).not.toHaveBeenCalled();
	});

	it("remove() restores the entry when the service rejects", async () => {
		const { backend } = makeBackend({
			removeProperty: vi.fn().mockRejectedValue(new Error("Unavailable")),
		});
		const onPersistError = vi.fn();
		const store = new PropertyStore({ backend, onPersistError });
		store.applySnapshot({ prop_a: textDef("prop_a", "Title") });
		const before = store.get("prop_a");
		await store.remove("prop_a");
		expect(store.get("prop_a")).toEqual(before);
		expect(onPersistError).toHaveBeenCalledOnce();
	});

	it("subscribe() returns an unsubscribe that stops further notifications", () => {
		const { backend } = makeBackend();
		const store = new PropertyStore({ backend });
		const listener = vi.fn();
		const unsubscribe = store.subscribe(listener);
		store.put(textDef("prop_a"));
		expect(listener).toHaveBeenCalledTimes(1);
		unsubscribe();
		store.put(textDef("prop_b"));
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("dispose() drops listeners + ignores subsequent puts (no service call)", () => {
		const { backend, setProperty } = makeBackend();
		const store = new PropertyStore({ backend });
		const listener = vi.fn();
		store.subscribe(listener);
		store.dispose();
		store.put(textDef("prop_a"));
		expect(setProperty).not.toHaveBeenCalled();
		expect(listener).not.toHaveBeenCalled();
	});

	it("a service-error landing AFTER dispose does not throw / notify / revert", async () => {
		// Pending rejection should be swallowed; the dispose flag short-circuits
		// the catch handler so we don't touch listeners or emit a revert.
		let reject!: (e: unknown) => void;
		const setProperty = vi.fn(
			() =>
				new Promise<void>((_, r) => {
					reject = r;
				}),
		);
		const onPersistError = vi.fn();
		const store = new PropertyStore({
			backend: { setProperty, removeProperty: vi.fn() },
			onPersistError,
		});
		store.put(textDef("prop_a"));
		store.dispose();
		reject(new Error("late"));
		await flushMicrotasks();
		expect(onPersistError).not.toHaveBeenCalled();
	});

	it("applySnapshot after dispose is a no-op", () => {
		const { backend } = makeBackend();
		const store = new PropertyStore({ backend });
		store.dispose();
		store.applySnapshot({ prop_a: textDef("prop_a") });
		expect(store.getSnapshot().size).toBe(0);
		expect(store.isLoaded()).toBe(false);
	});
});

function flushMicrotasks(): Promise<void> {
	return new Promise<void>((resolve) => queueMicrotask(resolve));
}
