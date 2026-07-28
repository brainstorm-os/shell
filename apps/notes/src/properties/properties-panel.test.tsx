// @vitest-environment jsdom
/**
 * Notes' properties-panel adapter (Props-4) — pins the migration onto the
 * shared `<EntityPropertiesPanel>`: bag keys become rows, the lock renders
 * everything read-only (no add / no remove — the panel-side half of the
 * read-only lock; the write no-op lives in `app.tsx`), and edits funnel
 * through the ONE whole-bag `onWriteValues` persister.
 */

import { type PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import { PropertiesProvider, type PropertiesRuntime } from "@brainstorm-os/sdk/property-ui";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredNote } from "../store/note";
import { PropertiesPanel } from "./properties-panel";

function defText(key: string, name: string): PropertyDef {
	return { key, name, icon: null, valueType: ValueType.Text };
}

function buildRuntime(properties: Record<string, PropertyDef>): PropertiesRuntime {
	return {
		app: { id: "io.brainstorm.notes", version: "0.1.0", sdkVersion: "1" },
		launch: { reason: "fresh" },
		services: {
			storage: {
				put: async () => undefined,
				get: async () => null,
				list: async () => [],
				delete: async () => true,
			},
			properties: {
				list: async () => ({ properties, dictionaries: {} }),
				getProperty: async () => null,
				setProperty: async () => undefined,
				removeProperty: async () => undefined,
				getDictionary: async () => null,
				setDictionary: async () => undefined,
				removeDictionary: async () => undefined,
				onChange: () => ({ unsubscribe: () => undefined }),
			},
		},
		on: () => ({ unsubscribe: () => undefined }),
	} as unknown as PropertiesRuntime;
}

function note(values: Record<string, unknown>): StoredNote {
	return {
		id: "note_1",
		title: "A note",
		icon: null,
		cover: null,
		body: "",
		values,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_100_000,
	} as StoredNote;
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("Notes PropertiesPanel (shared EntityPropertiesPanel adapter)", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		Element.prototype.scrollIntoView = () => undefined;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function render(props: Partial<Parameters<typeof PropertiesPanel>[0]> = {}): void {
		act(() => {
			root.render(
				<PropertiesProvider runtime={buildRuntime({ author: defText("author", "Author") })}>
					<PropertiesPanel
						note={note({ author: "Tolkien" })}
						onWriteValues={() => undefined}
						onClose={() => undefined}
						{...props}
					/>
				</PropertiesProvider>,
			);
		});
	}

	it("maps the note's values bag onto shared rows with a meta footer", async () => {
		render();
		await flush();

		expect(container.querySelector(".bs-props__row-label")?.textContent).toBe("Author");
		// Editable: add + remove affordances present.
		expect(container.querySelector(".bs-props__add")).not.toBeNull();
		expect(container.querySelector(".bs-props__row-remove")).not.toBeNull();
		// Created / updated meta rows survive the migration.
		expect(container.querySelectorAll(".bs-props__meta-row")).toHaveLength(2);
	});

	it("locked note: rows render read-only, no add / no remove", async () => {
		render({ readOnly: true });
		await flush();

		expect(container.querySelector(".bs-props__row-label")?.textContent).toBe("Author");
		expect(container.querySelector(".bs-props__add")).toBeNull();
		expect(container.querySelector(".bs-props__row-remove")).toBeNull();
	});

	it("remove computes the next bag through the whole-bag persister", async () => {
		const writes: Array<Record<string, unknown>> = [];
		render({ onWriteValues: (next) => writes.push(next) });
		await flush();

		act(() => {
			container.querySelector<HTMLButtonElement>(".bs-props__row-remove")?.click();
		});
		expect(writes).toEqual([{}]);
	});
});
