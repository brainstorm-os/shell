// @vitest-environment happy-dom
import type { EntityRow } from "@brainstorm/sdk/in-memory-entities";
import { DictionaryStore, PropertiesContext } from "@brainstorm/sdk/property-ui";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InspectorProperties } from "./inspector-properties";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTITY: EntityRow = {
	id: "e1",
	type: "brainstorm/Task/v1",
	properties: { summary: "ship it" },
	createdAt: 1,
	updatedAt: 1,
	deletedAt: null,
};

describe("InspectorProperties — locked records are read-only", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		document.body.innerHTML = "";
	});

	function render(onEdit: ((e: EntityRow, k: string, v: unknown) => void) | undefined): void {
		const dictionaryStore = new DictionaryStore({
			backend: {
				setDictionary: () => Promise.resolve(undefined),
				removeDictionary: () => Promise.resolve(undefined),
			},
		});
		act(() => {
			root.render(
				createElement(
					PropertiesContext.Provider,
					{ value: { propertyStore: null as never, dictionaryStore, ready: true } },
					createElement(InspectorProperties, { entity: ENTITY, onEdit }),
				),
			);
		});
	}

	it("renders an interactive cell when onEdit is supplied (unlocked)", () => {
		render(() => {});
		expect(container.querySelector("[class*='bs-cell']")).not.toBeNull();
	});

	it("paints read-only — no editable cell — when onEdit is absent (locked)", () => {
		// The database inspector passes `onEdit: undefined` for a locked record;
		// `EditableCell` then renders the read-only paint instead of an SDK cell,
		// so no property in the inspector can be committed.
		render(undefined);
		expect(container.querySelector("[class*='bs-cell']")).toBeNull();
		expect(container.querySelector(".dbv-value")).not.toBeNull();
	});
});
