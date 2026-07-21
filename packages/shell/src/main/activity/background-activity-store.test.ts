import {
	ActivityKind,
	ActivityPhase,
	type BackgroundOperation,
} from "@brainstorm-os/protocol/activity-types";
import { describe, expect, it, vi } from "vitest";
import { BackgroundActivityStore } from "./background-activity-store";

const op = (over: Partial<BackgroundOperation> = {}): BackgroundOperation => ({
	id: "a",
	kind: ActivityKind.Indexing,
	detail: null,
	phase: ActivityPhase.Running,
	percent: null,
	...over,
});

describe("BackgroundActivityStore", () => {
	it("starts empty", () => {
		expect(new BackgroundActivityStore().snapshot().operations).toEqual([]);
	});

	it("set adds an op and pushes a snapshot", () => {
		const store = new BackgroundActivityStore();
		const seen = vi.fn();
		store.onChange(seen);
		store.set(op());
		expect(store.snapshot().operations).toHaveLength(1);
		expect(seen).toHaveBeenCalledTimes(1);
	});

	it("re-setting an id updates in place (no duplicate) and re-emits", () => {
		const store = new BackgroundActivityStore();
		const seen = vi.fn();
		store.onChange(seen);
		store.set(op({ percent: 10 }));
		store.set(op({ percent: 50 }));
		expect(store.snapshot().operations).toHaveLength(1);
		expect(store.snapshot().operations[0]?.percent).toBe(50);
		expect(seen).toHaveBeenCalledTimes(2);
	});

	it("skips the push when a re-set is byte-identical", () => {
		const store = new BackgroundActivityStore();
		const seen = vi.fn();
		store.onChange(seen);
		store.set(op({ percent: 50 }));
		store.set(op({ percent: 50 }));
		expect(seen).toHaveBeenCalledTimes(1);
	});

	it("orders most-recently-updated first", () => {
		const store = new BackgroundActivityStore();
		store.set(op({ id: "a" }));
		store.set(op({ id: "b" }));
		// Touch "a" again — it should move to the front.
		store.set(op({ id: "a", percent: 5 }));
		expect(store.snapshot().operations.map((o) => o.id)).toEqual(["a", "b"]);
	});

	it("clear removes an op and pushes; clearing a missing id is a no-op", () => {
		const store = new BackgroundActivityStore();
		const seen = vi.fn();
		store.set(op());
		store.onChange(seen);
		store.clear("a");
		expect(store.snapshot().operations).toEqual([]);
		expect(seen).toHaveBeenCalledTimes(1);
		store.clear("missing");
		expect(seen).toHaveBeenCalledTimes(1);
	});

	it("keeps an Error op visible until cleared", () => {
		const store = new BackgroundActivityStore();
		store.set(op({ phase: ActivityPhase.Error, detail: "offline" }));
		expect(store.snapshot().operations[0]).toMatchObject({
			phase: ActivityPhase.Error,
			detail: "offline",
		});
	});

	it("stops notifying after unsubscribe", () => {
		const store = new BackgroundActivityStore();
		const seen = vi.fn();
		const off = store.onChange(seen);
		off();
		store.set(op());
		expect(seen).not.toHaveBeenCalled();
	});

	it("isolates a throwing listener from the others", () => {
		const store = new BackgroundActivityStore();
		const good = vi.fn();
		store.onChange(() => {
			throw new Error("boom");
		});
		store.onChange(good);
		expect(() => store.set(op())).not.toThrow();
		expect(good).toHaveBeenCalledTimes(1);
	});
});
