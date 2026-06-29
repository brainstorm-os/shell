// @vitest-environment jsdom
/**
 * DictionaryEditor render + interaction tests: sort-mode select drives
 * row order, archive vs delete take the right shape edit, and merge via
 * the row menu rewrites bound note values through `onRewriteNotes`.
 */

import type { Dictionary, PropertyDef } from "@brainstorm/sdk-types";
import { ValueType } from "@brainstorm/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BrainstormMenuProvider,
	CONTEXT_MENU_ID,
	type ContextMenuItem,
	closeContextMenu,
	getActiveMenuStore,
} from "../menus";
import { DictionaryEditor } from "./dictionary-editor";
import { DictionarySortMode } from "./dictionary-helpers";
import type { NoteValues } from "./dictionary-ops";

const DICT: Dictionary = {
	id: "dict_status",
	name: "Status",
	items: [
		{ id: "todo", label: "Beta", icon: null, sortIndex: 0 },
		{ id: "doing", label: "alpha", icon: null, sortIndex: 1 },
		{ id: "old", label: "Legacy", icon: null, sortIndex: 2, archivedAt: 1 },
	],
};

const PROP: PropertyDef = {
	key: "prop_status",
	name: "Status",
	icon: null,
	valueType: ValueType.Text,
	vocabulary: { dictionaryId: "dict_status" },
	count: { min: 0, max: 1 },
};

/** React tracks a controlled input's value via its own setter; a bare
 *  `el.value = …` is invisible to it. Go through the prototype setter
 *  then dispatch so `onChange` fires. */
function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	const proto =
		el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
	setter?.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
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

function render(
	h: Harness,
	over: Partial<Parameters<typeof DictionaryEditor>[0]> = {},
): {
	onCommit: ReturnType<typeof vi.fn>;
	onRewriteNotes: ReturnType<typeof vi.fn>;
	onSortModeChange: ReturnType<typeof vi.fn>;
} {
	const onCommit = vi.fn();
	const onRewriteNotes = vi.fn();
	const onSortModeChange = vi.fn();
	const notes: NoteValues[] = over.notes
		? [...over.notes]
		: [{ id: "n1", values: { prop_status: "doing" } }];
	act(() => {
		h.root.render(
			<BrainstormMenuProvider>
				<DictionaryEditor
					dictionary={over.dictionary ?? DICT}
					properties={over.properties ?? [PROP]}
					notes={notes}
					sortMode={over.sortMode ?? DictionarySortMode.Manual}
					onSortModeChange={onSortModeChange}
					onCommit={onCommit}
					onRewriteNotes={onRewriteNotes}
					onClose={over.onClose ?? vi.fn()}
				/>
			</BrainstormMenuProvider>,
		);
	});
	return { onCommit, onRewriteNotes, onSortModeChange };
}

/** Open row `idx`'s ⋯ menu (now the shared `openAnchoredMenu` runtime) and
 *  invoke the action labelled `label`. The menu registers in the active store;
 *  find it by its (unique) item label rather than a derived id. */
function invokeRowMenuAction(h: Harness, idx: number, label: string): void {
	act(() => {
		h.container.querySelectorAll<HTMLButtonElement>(".notes__dict-row-menu-btn")[idx]?.click();
	});
	// getAll() is the open *stack* (a just-closed menu lingers in its Closing
	// transition), so read the top — the menu we just opened — not a flatMap of
	// all entries (which would pick up the previous row's stale items).
	const top = getActiveMenuStore()?.getAll().at(-1);
	const items = (top?.param?.data as { items?: ContextMenuItem[] })?.items ?? [];
	const action = items.find((it) => it.label === label);
	if (!action) throw new Error(`row menu action not found: ${label}`);
	act(() => action.onSelect?.());
	act(() => closeContextMenu());
}

describe("DictionaryEditor", () => {
	let h: Harness;
	beforeEach(() => {
		h = mount();
	});
	afterEach(() => h.cleanup());

	it("lists active items in manual order and hides archived", () => {
		render(h);
		const labels = [...h.container.querySelectorAll<HTMLInputElement>(".notes__dict-row-input")].map(
			(i) => i.value,
		);
		expect(labels).toEqual(["Beta", "alpha"]);
		expect(h.container.querySelector(".notes__dict-archived-list")).toBeNull();
	});

	it("alpha sort reorders rows", () => {
		render(h, { sortMode: DictionarySortMode.Alpha });
		const labels = [...h.container.querySelectorAll<HTMLInputElement>(".notes__dict-row-input")].map(
			(i) => i.value,
		);
		expect(labels).toEqual(["alpha", "Beta"]);
	});

	it("changing the sort select calls onSortModeChange", () => {
		const { onSortModeChange } = render(h);
		const trigger = h.container.querySelector<HTMLButtonElement>(".notes__dict-sort .bs-select");
		if (!trigger) throw new Error("no sort select trigger");
		act(() => trigger.click());
		const store = getActiveMenuStore();
		// Default seam label for the sort control is "Sort".
		const open = store?.getAll().find((m) => m.id === `${CONTEXT_MENU_ID}:Sort`);
		expect(open, "sort menu should be open").toBeDefined();
		const items = (open?.param.data as { items: ContextMenuItem[] }).items;
		const mostUsed = items.find((it) => it.label === "Most used");
		act(() => mostUsed?.onSelect?.());
		act(() => closeContextMenu());
		expect(onSortModeChange).toHaveBeenCalledWith(DictionarySortMode.MostUsed);
	});

	it("Show archived reveals the archived list with an unarchive action", () => {
		const { onCommit } = render(h);
		act(() => {
			h.container.querySelector<HTMLButtonElement>(".notes__dict-archived-toggle")?.click();
		});
		expect(h.container.querySelector(".notes__dict-archived-list")).not.toBeNull();
		act(() => {
			h.container.querySelector<HTMLButtonElement>(".notes__dict-unarchive")?.click();
		});
		const next = onCommit.mock.calls.at(-1)?.[0] as Dictionary;
		expect(next.items.find((i) => i.id === "old")?.archivedAt).toBeUndefined();
	});

	it("archive (row menu) sets archivedAt; delete rewrites bound notes", () => {
		const { onCommit, onRewriteNotes } = render(h);
		// Open the first row's (Beta) menu via the shared runtime, archive it.
		invokeRowMenuAction(h, 0, "Archive");
		let next = onCommit.mock.calls.at(-1)?.[0] as Dictionary;
		expect(next.items.find((i) => i.id === "todo")?.archivedAt).toBeDefined();

		// Delete the 'doing' row (bound by n1) — rewrites that note.
		invokeRowMenuAction(h, 1, "Delete");
		next = onCommit.mock.calls.at(-1)?.[0] as Dictionary;
		expect(next.items.some((i) => i.id === "doing")).toBe(false);
		expect(onRewriteNotes).toHaveBeenCalledWith([{ id: "n1", values: {} }]);
	});

	it("merge: arm on one row, confirm on another, rewrites notes", () => {
		const { onCommit, onRewriteNotes } = render(h, {
			notes: [{ id: "n1", values: { prop_status: "doing" } }],
		});
		// Arm merge from 'doing' (row 1).
		invokeRowMenuAction(h, 1, "Merge into…");
		// 'Beta' (todo) now shows a merge-here target.
		const target = h.container.querySelector<HTMLButtonElement>(".notes__dict-merge-target");
		expect(target).not.toBeNull();
		act(() => target?.click());
		const next = onCommit.mock.calls.at(-1)?.[0] as Dictionary;
		expect(next.items.some((i) => i.id === "doing")).toBe(false);
		expect(onRewriteNotes).toHaveBeenCalledWith([{ id: "n1", values: { prop_status: "todo" } }]);
	});

	it("editing the name + adding a value commit through onCommit", () => {
		const { onCommit } = render(h);
		const name = h.container.querySelector<HTMLInputElement>(".notes__dict-name");
		if (!name) throw new Error("no name input");
		act(() => setInputValue(name, "Statuses"));
		expect((onCommit.mock.calls.at(-1)?.[0] as Dictionary).name).toBe("Statuses");
		act(() => {
			h.container.querySelector<HTMLButtonElement>(".notes__dict-add")?.click();
		});
		expect((onCommit.mock.calls.at(-1)?.[0] as Dictionary).items.length).toBe(4);
	});

	it("import via the JSON textarea appends parsed rows", () => {
		const { onCommit } = render(h);
		act(() => {
			h.container.querySelector<HTMLButtonElement>(".notes__dict-io-btn")?.click();
		});
		const ta = h.container.querySelector<HTMLTextAreaElement>(".notes__dict-io-input");
		if (!ta) throw new Error("no import textarea");
		act(() => setInputValue(ta, '[{"label":"Imported","colour":"#00ff00"}]'));
		act(() => {
			const commit = [
				...h.container.querySelectorAll<HTMLButtonElement>(".notes__dict-io-action"),
			].find((b) => b.textContent === "Import");
			commit?.click();
		});
		const next = onCommit.mock.calls.at(-1)?.[0] as Dictionary;
		const imported = next.items.find((i) => i.label === "Imported");
		expect(imported?.colour).toBe("#00ff00");
	});
});
