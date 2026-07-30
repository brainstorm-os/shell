// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettledValue } from "./use-settled-value";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DELAY = 100;

let container: HTMLDivElement;
let root: Root;
let renders: string[];

function Probe({ value, flushKey }: { value: string; flushKey: unknown }) {
	const settled = useSettledValue(value, DELAY, flushKey);
	renders.push(settled);
	return <span data-testid="settled">{settled}</span>;
}

const shown = () => document.querySelector("[data-testid=settled]")?.textContent;

function render(value: string, flushKey: unknown): void {
	act(() => root.render(<Probe value={value} flushKey={flushKey} />));
}

function advance(ms: number): void {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	renders = [];
	container = document.createElement("div");
	document.body.append(container);
	act(() => {
		root = createRoot(container);
	});
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
});

describe("useSettledValue", () => {
	it("shows the first value immediately", () => {
		render("a", "k");
		expect(shown()).toBe("a");
	});

	it("holds the previous value until the quiet period elapses", () => {
		render("a", "k");
		render("b", "k");
		expect(shown()).toBe("a");
		advance(DELAY - 10);
		expect(shown()).toBe("a");
		advance(20);
		expect(shown()).toBe("b");
	});

	it("emits once for a burst of changes", () => {
		render("a", "k");
		for (const value of ["b", "c", "d", "e", "f"]) {
			render(value, "k");
			advance(DELAY - 20);
		}
		advance(DELAY + 10);
		// One settled emission for five changes — never an intermediate value.
		expect(new Set(renders)).toEqual(new Set(["a", "f"]));
		expect(shown()).toBe("f");
	});

	it("flushes without waiting when the flush key changes", () => {
		render("a", "k1");
		render("b", "k2");
		expect(shown()).toBe("b");
	});

	it("does not resurrect a pending value after a flush-key change", () => {
		render("a", "k1");
		render("b", "k1");
		render("c", "k2");
		expect(shown()).toBe("c");
		advance(DELAY * 3);
		expect(shown()).toBe("c");
	});

	it("settles back to the original value when a change is reverted", () => {
		render("a", "k");
		render("b", "k");
		render("a", "k");
		advance(DELAY + 10);
		expect(shown()).toBe("a");
	});
});
