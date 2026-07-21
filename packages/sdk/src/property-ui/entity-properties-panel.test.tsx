// @vitest-environment jsdom
/**
 * `<EntityPropertiesPanel>` — the shared editable-properties body extracted at
 * copy three (Notes / Journal / Preview). These tests pin the generic
 * contract: bound `properties.values` keys become rows, an "add" control shows
 * only when there are unbound defs AND the host can mutate, and remove
 * write-throughs compute the next bag via the pure value-store helpers.
 */

import { type PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EntityPropertiesPanel } from "./entity-properties-panel";
import { PropertiesProvider, type PropertiesRuntime } from "./use-properties";

function defText(key: string, name: string): PropertyDef {
	return { key, name, icon: null, valueType: ValueType.Text };
}

function buildRuntime(properties: Record<string, PropertyDef>): PropertiesRuntime {
	return {
		app: { id: "io.brainstorm.preview", version: "0.1.0", sdkVersion: "1" },
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

type Harness = { container: HTMLDivElement; root: Root; cleanup: () => void };

function mount(): Harness {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	return {
		container,
		root,
		cleanup: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

const LABELS = {
	emptyLabel: "No properties",
	addLabel: "Add property",
	removeLabel: (name: string) => `Remove ${name}`,
};

describe("EntityPropertiesPanel", () => {
	let harness: Harness;
	beforeEach(() => {
		harness = mount();
	});
	afterEach(() => {
		harness.cleanup();
	});

	it("renders a row per bound property and an add control for unbound defs", async () => {
		const runtime = buildRuntime({
			author: defText("author", "Author"),
			rating: defText("rating", "Rating"),
		});
		act(() => {
			harness.root.render(
				<PropertiesProvider runtime={runtime}>
					<EntityPropertiesPanel
						title="Details"
						entityId="ent_1"
						values={{ author: "Tolkien" }}
						canMutate
						onWriteValues={() => undefined}
						{...LABELS}
					/>
				</PropertiesProvider>,
			);
		});
		await flush();

		const labels = Array.from(harness.container.querySelectorAll(".bs-props__row-label")).map(
			(n) => n.textContent,
		);
		expect(labels).toEqual(["Author"]);
		// `rating` is unbound, so the add control is offered.
		expect(harness.container.querySelector(".bs-props__add")?.textContent).toContain("Add property");
	});

	it("hides the add control and remove buttons when canMutate is false", async () => {
		const runtime = buildRuntime({ author: defText("author", "Author") });
		act(() => {
			harness.root.render(
				<PropertiesProvider runtime={runtime}>
					<EntityPropertiesPanel
						title="Details"
						entityId="ent_1"
						values={{ author: "Tolkien" }}
						canMutate={false}
						onWriteValues={() => undefined}
						{...LABELS}
					/>
				</PropertiesProvider>,
			);
		});
		await flush();

		expect(harness.container.querySelector(".bs-props__add")).toBeNull();
		expect(harness.container.querySelector(".bs-props__row-remove")).toBeNull();
	});

	it("computes the next bag on remove and hands it to onWriteValues", async () => {
		const runtime = buildRuntime({ author: defText("author", "Author") });
		const writes: Array<Record<string, unknown>> = [];
		act(() => {
			harness.root.render(
				<PropertiesProvider runtime={runtime}>
					<EntityPropertiesPanel
						title="Details"
						entityId="ent_1"
						values={{ author: "Tolkien" }}
						canMutate
						onWriteValues={(next) => writes.push(next)}
						{...LABELS}
					/>
				</PropertiesProvider>,
			);
		});
		await flush();

		const removeBtn = harness.container.querySelector<HTMLButtonElement>(".bs-props__row-remove");
		expect(removeBtn).not.toBeNull();
		act(() => {
			removeBtn?.click();
		});
		expect(writes).toHaveLength(1);
		expect(writes[0]).toEqual({});
	});

	it("shows the empty label when nothing is bound", async () => {
		const runtime = buildRuntime({});
		act(() => {
			harness.root.render(
				<PropertiesProvider runtime={runtime}>
					<EntityPropertiesPanel
						title="Details"
						entityId="ent_1"
						values={{}}
						canMutate
						onWriteValues={() => undefined}
						{...LABELS}
					/>
				</PropertiesProvider>,
			);
		});
		await flush();

		expect(harness.container.querySelector(".bs-props__status")?.textContent).toBe("No properties");
	});
});
