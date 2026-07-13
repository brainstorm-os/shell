// @vitest-environment jsdom
/**
 * `<TextField>` numeric bounds — `min`/`max`/`step` forward to the underlying
 * `<input>` so a constrained numeric field ("keep the last N days") can ride the
 * shared face instead of hand-rolling `<input type=number>` just to get bounds.
 * They're omitted entirely when unset (no `min=""` polluting the DOM).
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TextField } from "./text-field";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("TextField numeric bounds", () => {
	let host: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	const input = () => {
		const el = host.querySelector("input");
		if (!el) throw new Error("no input");
		return el;
	};

	it("forwards min/max/step to the input", () => {
		act(() =>
			root.render(
				<TextField
					type="number"
					value="30"
					onChange={() => {}}
					min={1}
					max={3650}
					step={1}
					aria-label="days"
				/>,
			),
		);
		const el = input();
		expect(el.getAttribute("min")).toBe("1");
		expect(el.getAttribute("max")).toBe("3650");
		expect(el.getAttribute("step")).toBe("1");
		expect(el.type).toBe("number");
	});

	it("omits the bounds attributes entirely when unset", () => {
		act(() => root.render(<TextField value="hi" onChange={() => {}} aria-label="name" />));
		const el = input();
		expect(el.hasAttribute("min")).toBe(false);
		expect(el.hasAttribute("max")).toBe(false);
		expect(el.hasAttribute("step")).toBe(false);
	});
});
