// @vitest-environment jsdom
/**
 * `PropertiesProvider` live-update tests — verify that the Notes
 * provider re-runs `properties.list()` whenever `properties.onChange`
 * fires, so an external write (Settings → Data, sibling apps, future
 * sync peers) lands in the provider's stores without polling.
 *
 * The provider used to fetch only on mount, leaving the Notes app
 * blind to Settings → Data writes until the next remount. That gap
 * was the symptom of the "list of properties is empty in notes app
 * though my vault has them" report.
 */

import { type Dictionary, type PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import { StrictMode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dictionaryEditorStore } from "./dictionary-editor-store";
import {
	PropertiesProvider,
	type PropertiesRuntime,
	useDictionaryStore,
	usePropertyStore,
} from "./use-properties";

function defText(key: string, name: string): PropertyDef {
	return { key, name, icon: null, valueType: ValueType.Text };
}

function dict(id: string, name: string, itemLabels: string[]): Dictionary {
	return {
		id,
		name,
		items: itemLabels.map((label, i) => ({
			id: `${id}_${i}`,
			label,
			icon: null,
			sortIndex: i,
		})),
	};
}

type Snapshot = {
	properties: Record<string, PropertyDef>;
	dictionaries: Record<string, Dictionary>;
};

type FakeRuntime = {
	runtime: PropertiesRuntime;
	emitChange: () => void;
	listCalls: number;
	setSnapshot: (snap: Snapshot) => void;
};

function buildFakeRuntime(
	initial: {
		properties?: Record<string, PropertyDef>;
		dictionaries?: Record<string, Dictionary>;
	} = {},
): FakeRuntime {
	const listeners = new Set<() => void>();
	let snapshot: Snapshot = {
		properties: initial.properties ?? {},
		dictionaries: initial.dictionaries ?? {},
	};
	const state: FakeRuntime = {
		runtime: {
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
					list: async () => {
						state.listCalls += 1;
						return snapshot;
					},
					getProperty: async () => null,
					setProperty: async () => undefined,
					removeProperty: async () => undefined,
					getDictionary: async () => null,
					setDictionary: async () => undefined,
					removeDictionary: async () => undefined,
					onChange: (listener: () => void) => {
						listeners.add(listener);
						return { unsubscribe: () => listeners.delete(listener) };
					},
				},
			},
			on: () => ({ unsubscribe: () => undefined }),
		} as unknown as PropertiesRuntime,
		emitChange: () => {
			for (const l of listeners) l();
		},
		listCalls: 0,
		setSnapshot: (snap) => {
			snapshot = snap;
		},
	};
	return state;
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

function Probe({
	onRead,
	onReadDictionaries,
}: {
	onRead: (props: ReadonlyMap<string, PropertyDef>) => void;
	onReadDictionaries?: (dicts: ReadonlyMap<string, Dictionary>) => void;
}) {
	const { properties } = usePropertyStore();
	const { dictionaries } = useDictionaryStore();
	onRead(properties);
	onReadDictionaries?.(dictionaries);
	return null;
}

async function flushMicrotasks(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("PropertiesProvider — live updates", () => {
	let harness: Harness;
	beforeEach(() => {
		harness = mount();
	});
	afterEach(() => {
		harness.cleanup();
	});

	it("hydrates from list() on mount and re-fetches properties on every onChange signal", async () => {
		const fake = buildFakeRuntime();
		const reads: ReadonlyMap<string, PropertyDef>[] = [];

		act(() => {
			harness.root.render(
				<PropertiesProvider runtime={fake.runtime}>
					<Probe onRead={(m) => reads.push(m)} />
				</PropertiesProvider>,
			);
		});
		await flushMicrotasks();
		expect(fake.listCalls).toBe(1);

		fake.setSnapshot({
			properties: { p1: defText("p1", "Date"), p2: defText("p2", "Price") },
			dictionaries: {},
		});
		await act(async () => {
			fake.emitChange();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fake.listCalls).toBe(2);
		const latest = reads[reads.length - 1];
		expect(latest?.size).toBe(2);
		expect(latest?.get("p1")?.name).toBe("Date");
		expect(latest?.get("p2")?.name).toBe("Price");
	});

	it("re-applies the dictionaries snapshot on every onChange signal", async () => {
		// Dictionaries can mutate independently of properties — Settings →
		// Data lets users rename a vocabulary, reorder its items, or add
		// new items on any device. A second device's edit must flow into
		// every running app the same way property writes do.
		const fake = buildFakeRuntime();
		const dictReads: ReadonlyMap<string, Dictionary>[] = [];

		act(() => {
			harness.root.render(
				<PropertiesProvider runtime={fake.runtime}>
					<Probe onRead={() => undefined} onReadDictionaries={(d) => dictReads.push(d)} />
				</PropertiesProvider>,
			);
		});
		await flushMicrotasks();

		const initial = dictReads[dictReads.length - 1];
		expect(initial?.size ?? 0).toBe(0);

		fake.setSnapshot({
			properties: {},
			dictionaries: {
				status: dict("status", "Status", ["Todo", "Doing", "Done"]),
				priority: dict("priority", "Priority", ["Low", "High"]),
			},
		});
		await act(async () => {
			fake.emitChange();
			await Promise.resolve();
			await Promise.resolve();
		});

		const latest = dictReads[dictReads.length - 1];
		expect(latest?.size).toBe(2);
		expect(latest?.get("status")?.items.map((i) => i.label)).toEqual(["Todo", "Doing", "Done"]);
		expect(latest?.get("priority")?.name).toBe("Priority");
	});

	it("refreshes properties AND dictionaries from the same onChange signal", async () => {
		// Both maps must update on a single broker round-trip so a write
		// that touches one doesn't strand the other on stale state.
		const fake = buildFakeRuntime();
		const propReads: ReadonlyMap<string, PropertyDef>[] = [];
		const dictReads: ReadonlyMap<string, Dictionary>[] = [];

		act(() => {
			harness.root.render(
				<PropertiesProvider runtime={fake.runtime}>
					<Probe onRead={(m) => propReads.push(m)} onReadDictionaries={(d) => dictReads.push(d)} />
				</PropertiesProvider>,
			);
		});
		await flushMicrotasks();
		expect(fake.listCalls).toBe(1);

		fake.setSnapshot({
			properties: { p1: defText("p1", "Tag") },
			dictionaries: { d1: dict("d1", "Status", ["Open"]) },
		});
		await act(async () => {
			fake.emitChange();
			await Promise.resolve();
			await Promise.resolve();
		});

		// One signal → one `list()` → both stores updated.
		expect(fake.listCalls).toBe(2);
		expect(propReads[propReads.length - 1]?.size).toBe(1);
		expect(dictReads[dictReads.length - 1]?.size).toBe(1);
	});

	it("unsubscribes from onChange on unmount", async () => {
		const fake = buildFakeRuntime();
		act(() => {
			harness.root.render(
				<PropertiesProvider runtime={fake.runtime}>
					<Probe onRead={() => undefined} />
				</PropertiesProvider>,
			);
		});
		await flushMicrotasks();
		expect(fake.listCalls).toBe(1);

		act(() => harness.root.unmount());

		// After unmount the listener must be gone, so emitting does
		// nothing — `list()` is not called again.
		fake.emitChange();
		await flushMicrotasks();
		expect(fake.listCalls).toBe(1);
	});

	it("StrictMode double-invoke does not brick the catalog (list() resolves → picker populated)", async () => {
		// THE production bug: <StrictMode> runs the effect twice (run →
		// cleanup → run). The cleanup used to dispose the useMemo-singleton
		// stores; useMemo never recreated them, so the second run's
		// resolved list() hit applySnapshot's `if (this.disposed) return`
		// and the picker showed "Loading properties…" forever even though
		// list() returned the catalog. Mounting under <StrictMode> here
		// reproduces it; with the fix the snapshot still lands.
		const fake = buildFakeRuntime({
			properties: { p1: defText("p1", "Test"), p2: defText("p2", "Files") },
		});
		const reads: ReadonlyMap<string, PropertyDef>[] = [];

		act(() => {
			harness.root.render(
				<StrictMode>
					<PropertiesProvider runtime={fake.runtime}>
						<Probe onRead={(m) => reads.push(m)} />
					</PropertiesProvider>
				</StrictMode>,
			);
		});
		await flushMicrotasks();

		const latest = reads[reads.length - 1];
		expect(latest?.size).toBe(2);
		expect(latest?.get("p1")?.name).toBe("Test");
		expect(latest?.get("p2")?.name).toBe("Files");
	});

	it("auto-mounts the dictionary editor host so 'Manage values' works in EVERY app, not just Notes", async () => {
		// The regression this guards: the DictionaryEditorHost used to live
		// in the Notes app, so a Tag cell's "Manage values" footer opened the
		// editor only there — in Bookmarks (and every other property app) the
		// dictionaryEditorStore signal fired into the void. The provider now
		// renders the host itself, so any PropertiesProvider consumer gets a
		// live editor with zero per-app wiring.
		const fake = buildFakeRuntime({
			dictionaries: { tags: dict("tags", "Tags", ["a11y", "crdt"]) },
		});
		// Warm the React.lazy chunk so its first render is synchronous.
		await import("./dictionary-editor");

		act(() => {
			harness.root.render(
				<PropertiesProvider runtime={fake.runtime}>
					<Probe onRead={() => undefined} />
				</PropertiesProvider>,
			);
		});
		await flushMicrotasks();

		// Closed: no overlay before the Tag cell asks to manage values.
		expect(harness.container.querySelector(".notes__dict-overlay")).toBeNull();

		// What a Tag cell's "Manage values" footer does:
		await act(async () => {
			dictionaryEditorStore.open("tags");
			// The 490-line editor is React.lazy; let the dynamic import settle.
			for (let i = 0; i < 8; i += 1) await Promise.resolve();
		});

		const overlay = harness.container.querySelector(".notes__dict-overlay");
		expect(overlay).not.toBeNull();
		expect(harness.container.querySelector<HTMLInputElement>(".notes__dict-name")?.value).toBe(
			"Tags",
		);

		dictionaryEditorStore.close();
	});
});
