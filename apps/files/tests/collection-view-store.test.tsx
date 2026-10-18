// @vitest-environment jsdom
/**
 * 9.8.16 — Files as a collection, at the store level: property filters
 * narrow the visible rows (and compose with the folder listing), and the
 * vault-wide Duplicates view groups File rows by content hash, showing only
 * groups of ≥2 and leaving on any folder navigation.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KindFilter } from "../src/logic/filters";
import { useFilesStore } from "../src/store/use-files-store";
import { ROOT_FOLDER_ID } from "../src/types/entity";

type Probe = { store: ReturnType<typeof useFilesStore> | null };

function mount(probe: Probe): Root {
	const el = document.createElement("div");
	document.body.appendChild(el);
	const root = createRoot(el);
	function Harness() {
		probe.store = useFilesStore();
		return null;
	}
	act(() => root.render(<Harness />));
	return root;
}

const enc = new TextEncoder();
const BYTES: Record<string, Uint8Array> = {
	"h-1": enc.encode("same bytes"),
	"h-2": enc.encode("same bytes"),
	"h-3": enc.encode("different"),
};

let probe: Probe;

beforeEach(() => {
	localStorage.clear();
	probe = { store: null };
	(window as unknown as { brainstorm: unknown }).brainstorm = {
		app: { id: "io.brainstorm.files", version: "0.1.0", sdkVersion: "1" },
		capabilities: ["files.read"],
		services: {
			files: {
				requestOpen: vi.fn().mockResolvedValue([
					{ handleId: "h-1", displayName: "photo.png" },
					{ handleId: "h-2", displayName: "photo copy.png" },
					{ handleId: "h-3", displayName: "notes.txt" },
				]),
				read: vi.fn(async (h: { handleId: string }) => BYTES[h.handleId] ?? new Uint8Array()),
			},
		},
	};
});

afterEach(() => {
	(window as unknown as { brainstorm: unknown }).brainstorm = undefined;
	document.body.innerHTML = "";
	localStorage.clear();
});

async function mountWithUploads(): Promise<Root> {
	const root = mount(probe);
	await act(async () => {
		await probe.store?.uploadFiles();
	});
	return root;
}

describe("Files collection view (9.8.16)", () => {
	it("filters the folder listing by kind and clears back", async () => {
		const root = await mountWithUploads();
		expect(probe.store?.visibleRows).toHaveLength(3);
		expect(probe.store?.availableExtensions).toEqual(["png", "txt"]);

		act(() => probe.store?.setFilter({ kind: KindFilter.Document }));
		expect(probe.store?.visibleRows.map((e) => e.properties.name)).toEqual(["notes.txt"]);

		act(() => probe.store?.setFilter({ extension: "png" }));
		expect(probe.store?.visibleRows).toHaveLength(0);

		act(() => probe.store?.clearFilters());
		expect(probe.store?.visibleRows).toHaveLength(3);
		act(() => root.unmount());
	});

	it("shows only content-hash groups of two or more in the Duplicates view", async () => {
		const root = await mountWithUploads();
		act(() => probe.store?.showDuplicates());

		expect(probe.store?.duplicatesActive).toBe(true);
		expect(probe.store?.duplicateGroups).toHaveLength(1);
		expect(probe.store?.visibleRows.map((e) => e.properties.name).sort()).toEqual([
			"photo copy.png",
			"photo.png",
		]);
		expect(probe.store?.visibleSections).toHaveLength(1);
		expect(probe.store?.visibleSections?.[0]?.label).toMatch(/^2 copies/);
		act(() => root.unmount());
	});

	it("applies filters before grouping duplicates", async () => {
		const root = await mountWithUploads();
		act(() => probe.store?.showDuplicates());
		act(() => probe.store?.setFilter({ kind: KindFilter.Document }));
		expect(probe.store?.duplicateGroups).toEqual([]);
		expect(probe.store?.visibleRows).toHaveLength(0);
		act(() => root.unmount());
	});

	it("leaves the Duplicates view on folder navigation, even to the current folder", async () => {
		const root = await mountWithUploads();
		act(() => probe.store?.showDuplicates());
		act(() => probe.store?.navigateToFolder(ROOT_FOLDER_ID));
		expect(probe.store?.duplicatesActive).toBe(false);
		expect(probe.store?.visibleRows).toHaveLength(3);
		act(() => root.unmount());
	});
});
