import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryStore, shallowArrayEquals } from "./query-store";

/** A `load()` whose every call returns a promise the test resolves by hand,
 *  so out-of-order completion is deterministic. */
function deferredLoader<T>() {
	const resolvers: Array<(value: T) => void> = [];
	const calls = { count: 0 };
	const load = (): Promise<T> => {
		calls.count++;
		return new Promise<T>((resolve) => resolvers.push(resolve));
	};
	const resolve = (index: number, value: T): void => {
		const r = resolvers[index];
		if (!r) throw new Error(`no pending load #${index}`);
		r(value);
	};
	return { load, resolve, calls };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("createQueryStore", () => {
	beforeEach(() => vi.useRealTimers());
	afterEach(() => vi.useRealTimers());

	it("returns `initial` until the first load resolves, then the loaded value", async () => {
		const store = createQueryStore<number[]>({
			initial: [],
			load: () => Promise.resolve([1, 2, 3]),
			subscribe: () => () => {},
		});
		expect(store.getSnapshot()).toEqual([]);

		const notified = vi.fn();
		store.subscribe(notified); // first subscriber kicks the initial load
		await flush();

		expect(store.getSnapshot()).toEqual([1, 2, 3]);
		expect(notified).toHaveBeenCalledTimes(1);
		store.dispose();
	});

	it("reloads on the coarse signal and coalesces a burst into one load", async () => {
		let value = 0;
		const calls = { count: 0 };
		let fire: () => void = () => {};
		const store = createQueryStore<number>({
			initial: -1,
			coalesceMs: 10,
			load: () => {
				calls.count++;
				return Promise.resolve(value);
			},
			subscribe: (onInvalidate) => {
				fire = onInvalidate;
				return () => {};
			},
		});
		store.subscribe(() => {});
		await flush();
		expect(calls.count).toBe(1); // the initial load

		value = 42;
		fire();
		fire();
		fire(); // a 3-signal burst within the debounce window
		await new Promise((r) => setTimeout(r, 25));

		expect(calls.count).toBe(2); // collapsed to ONE reload
		expect(store.getSnapshot()).toBe(42);
		store.dispose();
	});

	it("does not notify when the reloaded snapshot is equal under `equals`", async () => {
		const store = createQueryStore<number[]>({
			initial: [],
			equals: shallowArrayEquals,
			load: () => Promise.resolve([1, 2]),
			subscribe: () => () => {},
		});
		const notified = vi.fn();
		store.subscribe(notified);
		await flush();
		expect(notified).toHaveBeenCalledTimes(1);
		const first = store.getSnapshot();

		await store.refresh(); // same *content*, but a fresh array each call
		expect(notified).toHaveBeenCalledTimes(1); // short-circuited
		expect(store.getSnapshot()).toBe(first); // identity preserved
		store.dispose();
	});

	it("applies only the newest result when loads resolve out of order", async () => {
		const { load, resolve } = deferredLoader<string>();
		const store = createQueryStore<string>({
			initial: "init",
			load,
			subscribe: () => () => {},
		});
		store.subscribe(() => {}); // load #0 (initial)

		const a = store.refresh(); // load #1
		const b = store.refresh(); // load #2 (newer)
		// Resolve the NEWER one first, then the older straggler.
		resolve(2, "new");
		resolve(1, "stale");
		resolve(0, "initial-load");
		await Promise.all([a, b]);
		await flush();

		expect(store.getSnapshot()).toBe("new"); // stale + initial dropped
		store.dispose();
	});

	it("keeps the cached snapshot when a reload rejects, and reports the error", async () => {
		let mode: "ok" | "fail" = "ok";
		const onError = vi.fn();
		const store = createQueryStore<string>({
			initial: "init",
			onError,
			load: () =>
				mode === "ok" ? Promise.resolve("loaded") : Promise.reject(new Error("Unavailable")),
			subscribe: () => () => {},
		});
		store.subscribe(() => {});
		await flush();
		expect(store.getSnapshot()).toBe("loaded");

		mode = "fail";
		await store.refresh();
		expect(store.getSnapshot()).toBe("loaded"); // not blanked
		expect(onError).toHaveBeenCalledTimes(1);
		store.dispose();
	});

	it("binds the source on the first subscriber and unbinds on the last unsubscribe", async () => {
		const unbind = vi.fn();
		const bind = vi.fn(() => unbind);
		const store = createQueryStore<number>({
			initial: 0,
			load: () => Promise.resolve(1),
			subscribe: bind,
		});
		const off1 = store.subscribe(() => {});
		const off2 = store.subscribe(() => {});
		expect(bind).toHaveBeenCalledTimes(1); // bound once, ref-counted
		expect(unbind).not.toHaveBeenCalled();

		off1();
		expect(unbind).not.toHaveBeenCalled(); // still one listener
		off2();
		expect(unbind).toHaveBeenCalledTimes(1); // idle → unbound

		store.subscribe(() => {});
		expect(bind).toHaveBeenCalledTimes(2); // rebinds on a fresh subscriber
		store.dispose();
	});

	it("dispose cancels a pending reload, unbinds, and ignores later signals", async () => {
		const unbind = vi.fn();
		let fire: () => void = () => {};
		const calls = { count: 0 };
		const store = createQueryStore<number>({
			initial: 0,
			coalesceMs: 10,
			load: () => {
				calls.count++;
				return Promise.resolve(1);
			},
			subscribe: (onInvalidate) => {
				fire = onInvalidate;
				return unbind;
			},
		});
		const notified = vi.fn();
		store.subscribe(notified);
		await flush();
		const loadsBeforeDispose = calls.count;

		fire(); // arm a debounced reload...
		store.dispose(); // ...then dispose inside the window
		await new Promise((r) => setTimeout(r, 25));

		expect(calls.count).toBe(loadsBeforeDispose); // the pending reload was cancelled
		expect(unbind).toHaveBeenCalledTimes(1);
		fire(); // post-dispose signal is inert
		await new Promise((r) => setTimeout(r, 25));
		expect(calls.count).toBe(loadsBeforeDispose);
	});

	it("never loads when nobody subscribes (idle stores carry no work)", async () => {
		const calls = { count: 0 };
		createQueryStore<number>({
			initial: 0,
			load: () => {
				calls.count++;
				return Promise.resolve(1);
			},
			subscribe: () => () => {},
		});
		await flush();
		expect(calls.count).toBe(0);
	});
});

describe("shallowArrayEquals", () => {
	it("is true for the same reference and for equal-by-index arrays", () => {
		const a = [1, 2, 3];
		expect(shallowArrayEquals(a, a)).toBe(true);
		expect(shallowArrayEquals([1, 2, 3], [1, 2, 3])).toBe(true);
	});
	it("is false on differing length or any index", () => {
		expect(shallowArrayEquals([1, 2], [1, 2, 3])).toBe(false);
		expect(shallowArrayEquals([1, 2, 3], [1, 9, 3])).toBe(false);
	});
});

describe("createQueryStore — reconcile", () => {
	// `equals` can only answer "is this change worth a render". Two apps (Notes,
	// Files) need "keep part of what I had" and were hand-rolling the entire
	// subscribe/debounce/refetch/short-circuit dance purely to own this one step.
	it("merges the cached snapshot into a freshly-loaded one", async () => {
		let loaded = ["disk-a", "disk-b"];
		const store = createQueryStore<string[]>({
			initial: [],
			load: async () => loaded,
			subscribe: () => () => {},
			// The Notes shape: pin an item the loaded snapshot may not have yet.
			reconcile: (prev, next) => (prev.includes("open") ? [...next, "open"] : next),
			equals: shallowArrayEquals,
		});
		store.subscribe(() => {});
		await store.refresh();
		expect(store.getSnapshot()).toEqual(["disk-a", "disk-b"]);

		// Simulate the open item existing locally but missing from disk.
		loaded = ["disk-a", "disk-b", "open"];
		await store.refresh();
		loaded = ["disk-a"];
		await store.refresh();
		expect(store.getSnapshot()).toContain("open");
		store.dispose();
	});

	it("runs BEFORE equals, so a merge that restores the status quo does not re-render", async () => {
		// This ordering is the whole point: reconciling after the comparison would
		// notify on every reload that dropped the pinned item, which is exactly the
		// sidebar thrash the shared store exists to prevent.
		const notified = vi.fn();
		const store = createQueryStore<string[]>({
			initial: ["keep"],
			load: async () => [],
			subscribe: () => () => {},
			reconcile: (prev) => prev,
			equals: shallowArrayEquals,
		});
		store.subscribe(notified);
		await store.refresh();
		expect(notified).not.toHaveBeenCalled();
		expect(store.getSnapshot()).toEqual(["keep"]);
		store.dispose();
	});

	it("takes next wholesale when no reconciler is given", async () => {
		const store = createQueryStore<string[]>({
			initial: ["old"],
			load: async () => ["new"],
			subscribe: () => () => {},
			equals: shallowArrayEquals,
		});
		store.subscribe(() => {});
		await store.refresh();
		expect(store.getSnapshot()).toEqual(["new"]);
		store.dispose();
	});

	it("is not consulted for a load that lost the race", async () => {
		// A superseded load is dropped before reconcile, so a stale merge can never
		// resurrect content the newer snapshot deliberately removed.
		const seen: string[][] = [];
		const { load, resolve } = deferredLoader<string[]>();
		const store = createQueryStore<string[]>({
			initial: [],
			load,
			subscribe: () => () => {},
			reconcile: (prev, next) => {
				seen.push(next);
				return next;
			},
			equals: shallowArrayEquals,
		});
		store.subscribe(() => {}); // load #0 (initial)
		const slow = store.refresh(); // load #1
		const fast = store.refresh(); // load #2 (newer)
		resolve(2, ["fast"]);
		resolve(1, ["slow"]); // the straggler, superseded
		resolve(0, ["initial"]);
		await Promise.all([slow, fast]);
		await flush();
		expect(seen).toEqual([["fast"]]);
		expect(store.getSnapshot()).toEqual(["fast"]);
		store.dispose();
	});
});
