import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDIT_SETTLE_MS, createTrailingCoalescer } from "./settle";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createTrailingCoalescer", () => {
	it("runs only the last task, once the calls stop", () => {
		const coalescer = createTrailingCoalescer(100);
		const first = vi.fn();
		const last = vi.fn();
		coalescer.schedule(first);
		vi.advanceTimersByTime(90);
		coalescer.schedule(last);
		vi.advanceTimersByTime(90);
		expect(first).not.toHaveBeenCalled();
		expect(last).not.toHaveBeenCalled();

		vi.advanceTimersByTime(20);
		expect(first).not.toHaveBeenCalled();
		expect(last).toHaveBeenCalledTimes(1);
	});

	it("collapses a burst of N calls into one run", () => {
		const coalescer = createTrailingCoalescer(100);
		const task = vi.fn();
		for (let i = 0; i < 50; i++) {
			coalescer.schedule(task);
			vi.advanceTimersByTime(20);
		}
		vi.advanceTimersByTime(200);
		expect(task).toHaveBeenCalledTimes(1);
	});

	it("cancel drops the pending task", () => {
		const coalescer = createTrailingCoalescer(100);
		const task = vi.fn();
		coalescer.schedule(task);
		coalescer.cancel();
		vi.advanceTimersByTime(500);
		expect(task).not.toHaveBeenCalled();
	});

	it("cancel is idempotent and leaves the coalescer usable", () => {
		const coalescer = createTrailingCoalescer(100);
		coalescer.cancel();
		coalescer.cancel();
		const task = vi.fn();
		coalescer.schedule(task);
		vi.advanceTimersByTime(150);
		expect(task).toHaveBeenCalledTimes(1);
	});
});

describe("EDIT_SETTLE_MS", () => {
	it("sits above a fluent typist's keystroke gap and below the perceptible-lag mark", () => {
		expect(EDIT_SETTLE_MS).toBeGreaterThan(200);
		expect(EDIT_SETTLE_MS).toBeLessThanOrEqual(300);
	});
});
