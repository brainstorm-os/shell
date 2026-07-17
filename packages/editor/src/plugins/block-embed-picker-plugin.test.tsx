// @vitest-environment jsdom
/**
 * The `/embed` (+ Notes' type-scoped `/database` / `/graph`) picker renders
 * through the shared `openSearchPicker` runtime, so keyboard operability (the
 * original F-209 concern — arrows / Enter / Escape with the search input
 * focused) is the runtime's job, proven once in
 * `packages/sdk/src/menus/search-picker.test.tsx`.
 *
 * What stays plugin-specific, and is proven here through the picker's store
 * contract:
 *   - the entity source (the injected entity-index) loads once per open and
 *     the current entity is excluded (a document can't embed itself),
 *   - a typed query filters the rows; no match shows a single disabled
 *     empty-state row,
 *   - committing a row inserts a `BlockEmbedNode` for that entity and closes
 *     the host store.
 */

import type { VaultEntity } from "@brainstorm/sdk-types";
import {
	BrainstormMenuProvider,
	SEARCH_PICKER_ID,
	type SearchPickerItem,
	getActiveMenuStore,
} from "@brainstorm/sdk/menus";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createParagraphNode, $getRoot, type LexicalEditor } from "lexical";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASELINE_NODES } from "../nodes";
import { $isBlockEmbedNode } from "../nodes/block-embed-node";
import { FULL_EDITOR_NODES } from "../standard-nodes";
import { BlockEmbedPickerPlugin } from "./block-embed-picker-plugin";
import { embedPickerStore } from "./embed-picker-store";
import { setEntityIndexSource } from "./entity-index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COLLECTION_TYPE = "brainstorm/List/v1";
const CURRENT_NOTE = "current-note";
const NOTE_TYPE = "io.brainstorm.notes/Note/v1";

function entity(id: string, type: string, title: string): VaultEntity {
	return {
		id,
		type,
		properties: { title },
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
		ownerAppId: "test",
	};
}

const ENTITIES: readonly VaultEntity[] = [
	entity("col-alpha", COLLECTION_TYPE, "Alpha board"),
	entity("col-beta", COLLECTION_TYPE, "Beta board"),
	// The open note itself — must be excluded from the picker.
	entity(CURRENT_NOTE, NOTE_TYPE, "This note"),
];

let container: HTMLDivElement;
let root: Root;
let editorRoot: HTMLDivElement;
let capturedEditor: LexicalEditor | null = null;

function CaptureEditor() {
	const [editor] = useLexicalComposerContext();
	capturedEditor = editor;
	return null;
}

beforeEach(() => {
	// The picker closes behind an animation timer (onClose → embedPickerStore
	// close); fake timers let the close-on-commit assertion flush it. Microtask
	// flushes (the async entity snapshot) are unaffected.
	vi.useFakeTimers();
	Element.prototype.scrollIntoView = () => {};
	// The plugin loads its candidates through the injected entity-index
	// source (`fetchEntities`) — no app runtime involved.
	setEntityIndexSource({
		list: () => Promise.resolve({ entities: ENTITIES }),
		onChange: () => ({ unsubscribe: () => {} }),
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	editorRoot = document.createElement("div");
	editorRoot.contentEditable = "true";
	editorRoot.tabIndex = 0;
	document.body.appendChild(editorRoot);
});

afterEach(() => {
	embedPickerStore.close();
	act(() => vi.runAllTimers());
	act(() => root.unmount());
	container.remove();
	editorRoot.remove();
	capturedEditor = null;
	setEntityIndexSource(null);
	vi.useRealTimers();
});

/** Mount the provider + plugin + a Lexical editor, then open the embed store on
 *  a fresh paragraph and flush the async entity snapshot into the picker. */
async function mountWithOpenPicker(): Promise<LexicalEditor> {
	await act(async () => {
		root.render(
			<BrainstormMenuProvider>
				<LexicalComposer
					initialConfig={{
						namespace: "embed-picker-test",
						nodes: [...BASELINE_NODES, ...FULL_EDITOR_NODES],
						onError: (e) => {
							throw e;
						},
					}}
				>
					<CaptureEditor />
					<BlockEmbedPickerPlugin currentNoteId={CURRENT_NOTE} />
				</LexicalComposer>
			</BrainstormMenuProvider>,
		);
	});
	const editor = capturedEditor;
	if (!editor) throw new Error("editor did not mount");
	editor.setRootElement(editorRoot);

	let paragraphKey = "";
	editor.update(
		() => {
			const p = $createParagraphNode();
			$getRoot().append(p);
			paragraphKey = p.getKey();
		},
		{ discrete: true },
	);

	await act(async () => {
		embedPickerStore.open({ paragraphKey, anchor: { top: 0, left: 0, bottom: 20 } });
	});
	// Flush the async vaultEntities.list() snapshot into the picker.
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
	return editor;
}

function pickerMenu() {
	const store = getActiveMenuStore();
	return { store, open: store?.getAll().find((m) => m.id === SEARCH_PICKER_ID) };
}

function items(): SearchPickerItem[] {
	return (
		(pickerMenu().open?.param.data as { items: SearchPickerItem[] } | undefined)?.items ?? []
	).slice();
}

/** Re-run the picker's host filter the way the runtime's filter input does. */
function type(query: string): void {
	const { open } = pickerMenu();
	const filter = (open?.config.chrome as { filter: { onChange: (v: string) => void } }).filter;
	act(() => filter.onChange(query));
}

function commit(id: string): void {
	const { store, open } = pickerMenu();
	const item = items().find((i) => i.id === id);
	const spec = (
		open?.config.body as {
			rows: ReadonlyArray<{
				onClick: (i: SearchPickerItem, e: unknown, ctx: { closeAll: () => void }) => void;
			}>;
		}
	).rows[0];
	act(() =>
		spec?.onClick(item as SearchPickerItem, new MouseEvent("click"), {
			closeAll: () => store?.close(open?.id),
		}),
	);
}

function embeddedEntityIds(editor: LexicalEditor): string[] {
	const ids: string[] = [];
	editor.getEditorState().read(() => {
		for (const node of $getRoot().getChildren()) {
			if ($isBlockEmbedNode(node)) ids.push(node.getEntityId());
		}
	});
	return ids;
}

describe("block-embed picker", () => {
	it("opens with every entity except the current note", async () => {
		await mountWithOpenPicker();
		expect(items().map((i) => i.id)).toEqual(["col-alpha", "col-beta"]);
		expect(items().map((i) => i.id)).not.toContain(CURRENT_NOTE);
	});

	it("filters by title and shows a disabled empty-state row for no match", async () => {
		await mountWithOpenPicker();
		type("beta");
		expect(items().map((i) => i.id)).toEqual(["col-beta"]);

		type("zzz nothing");
		expect(items()).toHaveLength(1);
		expect(items()[0]?.disabled).toBe(true);
	});

	it("commits a row into a BlockEmbedNode and closes the host store", async () => {
		const editor = await mountWithOpenPicker();
		commit("col-beta");
		await act(async () => {
			await Promise.resolve();
		});
		expect(embeddedEntityIds(editor)).toEqual(["col-beta"]);
		// onClose (→ embedPickerStore.close) fires on the close-animation timer.
		act(() => vi.runAllTimers());
		expect(embedPickerStore.getSnapshot()).toBeNull();
	});

	it("never commits the disabled empty-state row", async () => {
		const editor = await mountWithOpenPicker();
		type("zzz nothing");
		commit("__empty");
		expect(embeddedEntityIds(editor)).toEqual([]);
	});
});
