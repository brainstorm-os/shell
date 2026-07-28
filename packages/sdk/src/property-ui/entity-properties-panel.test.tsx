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

// jsdom has no scrollIntoView; the picker scrolls its active row on open.
beforeEach(() => {
	Element.prototype.scrollIntoView = () => undefined;
});

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

	it("renders host extraRows ahead of the bag rows in the same grid (Props-3)", async () => {
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
						values={{ author: "Tolkien", rating: "5" }}
						canMutate
						onWriteValues={() => undefined}
						extraRows={[
							{ def: defText("t.status", "Zz Status"), value: "open", readOnly: true },
							{ def: defText("t.due", "Aa Due"), value: "", readOnly: true },
						]}
						{...LABELS}
					/>
				</PropertiesProvider>,
			);
		});
		await flush();

		// Host order first (NOT name-sorted), then the alphabetised bag rows —
		// all inside one `.bs-props__list`, so the grid stays aligned.
		expect(harness.container.querySelectorAll(".bs-props__list")).toHaveLength(1);
		const labels = Array.from(harness.container.querySelectorAll(".bs-props__row-label")).map(
			(n) => n.textContent,
		);
		expect(labels).toEqual(["Zz Status", "Aa Due", "Author", "Rating"]);
	});

	it("keeps extraRows-only hosts working without an emptyLabel", async () => {
		const runtime = buildRuntime({});
		act(() => {
			harness.root.render(
				<PropertiesProvider runtime={runtime}>
					<EntityPropertiesPanel
						title="Details"
						entityId="ent_1"
						values={{}}
						canMutate={false}
						onWriteValues={() => undefined}
						extraRows={[{ def: defText("t.status", "Status"), value: "open", readOnly: true }]}
						addLabel={LABELS.addLabel}
						removeLabel={LABELS.removeLabel}
					/>
				</PropertiesProvider>,
			);
		});
		await flush();

		expect(harness.container.querySelector(".bs-props__status")).toBeNull();
		expect(harness.container.querySelector(".bs-props__row-label")?.textContent).toBe("Status");
	});

	it("threads pickerExcludeKeys + pickerLabels into the add-property picker", async () => {
		const runtime = buildRuntime({
			assigneeId: defText("assigneeId", "Assignee"),
			mood: defText("mood", "Mood"),
		});
		act(() => {
			harness.root.render(
				<PropertiesProvider runtime={runtime}>
					<EntityPropertiesPanel
						title="Details"
						entityId="ent_1"
						values={{}}
						canMutate
						onWriteValues={() => undefined}
						pickerExcludeKeys={new Set(["assigneeId"])}
						pickerLabels={{ region: "Ajouter une propriété" }}
						{...LABELS}
					/>
				</PropertiesProvider>,
			);
		});
		await flush();

		act(() => {
			harness.container.querySelector<HTMLButtonElement>(".bs-props__add")?.click();
		});
		await flush();

		const picker = document.querySelector(".bs-add-property");
		expect(picker?.getAttribute("aria-label")).toBe("Ajouter une propriété");
		const rowNames = Array.from(document.querySelectorAll(".bs-add-property .fm-row__name")).map(
			(n) => n.textContent,
		);
		expect(rowNames).toContain("Mood");
		expect(rowNames).not.toContain("Assignee");
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
