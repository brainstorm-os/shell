// @vitest-environment jsdom
/**
 * Render tests for FormulaCell — the read-only computed cell. Verifies it
 * evaluates the property's expression against `siblings`, renders the formatted
 * result, and degrades gracefully (error chip / em-dash) without throwing.
 */

import type { CellProps, PropertyDef } from "@brainstorm-os/sdk-types";
import { PropertyFormat, PropertyView, ValueType } from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FormulaCell } from "./formula-cell";

function formulaDef(expression: string): PropertyDef {
	return {
		key: "prop_total",
		name: "Total",
		icon: null,
		valueType: ValueType.Number,
		format: PropertyFormat.Formula,
		formula: expression,
		display: { view: PropertyView.Formula },
	};
}

function props(overrides: Partial<CellProps>): CellProps {
	return {
		property: formulaDef("{qty} * {rate}"),
		value: null,
		onChange: () => undefined,
		noteId: "ent_1",
		...overrides,
	} as CellProps;
}

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

function render(p: CellProps): void {
	act(() => root.render(<FormulaCell {...p} />));
}

describe("FormulaCell", () => {
	it("evaluates the expression against sibling values", () => {
		render(props({ siblings: { qty: 10, rate: 250 } }));
		expect(host.textContent).toContain("2,500");
		expect(host.querySelector(".bs-cell-formula")).not.toBeNull();
		expect(host.querySelector(".bs-cell-formula--error")).toBeNull();
	});

	it("renders an em-dash when no sibling context is supplied", () => {
		render(props({}));
		expect(host.textContent).toContain("—");
		expect(host.querySelector(".bs-cell-formula--empty")).not.toBeNull();
	});

	it("renders an error chip for a syntactically invalid formula", () => {
		render(props({ property: formulaDef("{a} * * {b}"), siblings: { a: 1, b: 2 } }));
		const err = host.querySelector(".bs-cell-formula--error");
		expect(err).not.toBeNull();
		expect(err?.getAttribute("title")).toBeTruthy();
	});

	it("renders an error chip for a non-numeric reference", () => {
		render(props({ property: formulaDef("{a} + 1"), siblings: { a: "not a number" } }));
		const err = host.querySelector(".bs-cell-formula--error");
		expect(err).not.toBeNull();
		expect(err?.getAttribute("title")).toContain("{a}");
	});

	it("respects the property precision when formatting the result", () => {
		render(
			props({
				property: { ...formulaDef("{a} / {b}"), precision: 2 },
				siblings: { a: 10, b: 3 },
			}),
		);
		expect(host.textContent).toContain("3.33");
	});
});
