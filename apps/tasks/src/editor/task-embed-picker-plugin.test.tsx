// @vitest-environment jsdom
/**
 * The `/task` picker now renders through the shared `openSearchPicker`
 * runtime, so keyboard operability (arrows / Enter / Escape with the search
 * input focused) is the runtime's job, proven once in
 * `packages/sdk/src/menus/search-picker.test.tsx`.
 *
 * What stays tasks-specific, and is proven here through the picker's store
 * contract:
 *   - the entity source loads once per open, is scoped to Task entities, and
 *     the current task is excluded (a task can't embed itself),
 *   - a typed query filters the rows; no match shows a single disabled
 *     empty-state row,
 *   - committing a row inserts a `TaskEmbedNode` for that task and closes the
 *     host store.
 */

import { BASELINE_NODES } from "@brainstorm-os/editor";
import {
	BrainstormMenuProvider,
	SEARCH_PICKER_ID,
	type SearchPickerItem,
	getActiveMenuStore,
} from "@brainstorm-os/sdk/menus";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createParagraphNode, $getRoot, type LexicalEditor } from "lexical";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TasksBrainstorm } from "../storage/runtime";
import { $isTaskEmbedNode, TaskEmbedNode } from "./task-embed-node";
import { TaskEmbedPickerPlugin } from "./task-embed-picker-plugin";
import { taskEmbedPickerStore } from "./task-embed-picker-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TASK_TYPE = "brainstorm/Task/v1";
const PROJECT_TYPE = "brainstorm/Project/v1";
const CURRENT_TASK = "current-task";

const ENTITIES = [
	{ id: "task-alpha", type: TASK_TYPE, properties: { name: "Alpha task" } },
	{ id: "task-beta", type: TASK_TYPE, properties: { name: "Beta task" } },
	// A non-task entity — must be dropped by the Task scope.
	{ id: "proj-gamma", type: PROJECT_TYPE, properties: { name: "Gamma project" } },
	// The open task itself — must be excluded.
	{ id: CURRENT_TASK, type: TASK_TYPE, properties: { name: "This task" } },
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
	// The picker closes behind an animation timer (onClose → taskEmbedPickerStore
	// close); fake timers let the close-on-commit assertion flush it. Microtask
	// flushes (the async entity snapshot) are unaffected.
	vi.useFakeTimers();
	Element.prototype.scrollIntoView = () => {};
	window.brainstorm = {
		services: {
			vaultEntities: {
				list: () => Promise.resolve({ entities: ENTITIES }),
			},
		},
	} as unknown as TasksBrainstorm;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	editorRoot = document.createElement("div");
	editorRoot.contentEditable = "true";
	editorRoot.tabIndex = 0;
	document.body.appendChild(editorRoot);
});

afterEach(() => {
	taskEmbedPickerStore.close();
	act(() => vi.runAllTimers());
	act(() => root.unmount());
	container.remove();
	editorRoot.remove();
	capturedEditor = null;
	window.brainstorm = undefined;
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
						namespace: "task-embed-picker-test",
						nodes: [...BASELINE_NODES, TaskEmbedNode],
						onError: (e) => {
							throw e;
						},
					}}
				>
					<CaptureEditor />
					<TaskEmbedPickerPlugin currentTaskId={CURRENT_TASK} />
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
		taskEmbedPickerStore.open({ paragraphKey, anchor: { top: 0, left: 0, bottom: 20 } });
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
			if ($isTaskEmbedNode(node)) ids.push(node.getEntityId());
		}
	});
	return ids;
}

describe("task-embed picker", () => {
	it("opens with every task except the current one, dropping non-tasks", async () => {
		await mountWithOpenPicker();
		expect(items().map((i) => i.id)).toEqual(["task-alpha", "task-beta"]);
		expect(items().map((i) => i.id)).not.toContain(CURRENT_TASK);
		expect(items().map((i) => i.id)).not.toContain("proj-gamma");
	});

	it("filters by title and shows a disabled empty-state row for no match", async () => {
		await mountWithOpenPicker();
		type("beta");
		expect(items().map((i) => i.id)).toEqual(["task-beta"]);

		type("zzz nothing");
		expect(items()).toHaveLength(1);
		expect(items()[0]?.disabled).toBe(true);
	});

	it("commits a row into a TaskEmbedNode and closes the host store", async () => {
		const editor = await mountWithOpenPicker();
		commit("task-beta");
		await act(async () => {
			await Promise.resolve();
		});
		expect(embeddedEntityIds(editor)).toEqual(["task-beta"]);
		// onClose (→ taskEmbedPickerStore.close) fires on the close-animation timer.
		act(() => vi.runAllTimers());
		expect(taskEmbedPickerStore.getSnapshot()).toBeNull();
	});

	it("never commits the disabled empty-state row", async () => {
		const editor = await mountWithOpenPicker();
		type("zzz nothing");
		commit("__empty");
		expect(embeddedEntityIds(editor)).toEqual([]);
	});
});
