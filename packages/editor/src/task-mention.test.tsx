// @vitest-environment jsdom
import { NoteReferenceKind, extractNoteReferences } from "@brainstorm-os/sdk/note-references";
import {
	$createListItemNode,
	$createListNode,
	$isListItemNode,
	ListItemNode,
	ListNode,
} from "@lexical/list";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	type LexicalEditor,
	type LexicalNode,
	createEditor,
} from "lexical";
import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditorT } from "./i18n";
import { $isMentionNode, MentionNode } from "./nodes/mention-node";
import { setEditorHost } from "./plugins/editor-host";
import { setEntityIndexSource, subscribeEntityIcons } from "./plugins/entity-index";
import { TaskCheckbox } from "./task-checkbox";
import {
	TASK_ENTITY_TYPE,
	isTaskDone,
	newTaskProperties,
	taskCompletionPatch,
} from "./task-entity";

const picker = vi.hoisted(() => ({
	open: vi.fn<(options: Record<string, unknown>) => boolean>(() => true),
}));

vi.mock("@brainstorm-os/sdk/menus", () => ({
	openSearchPicker: (options: Record<string, unknown>) => picker.open(options),
}));

import {
	type TaskCaret,
	createTaskCommand,
	insertTaskMention,
	taskPickerRows,
} from "./task-mention";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = createEditorT();

function makeEditor(): LexicalEditor {
	return createEditor({
		nodes: [MentionNode, ListNode, ListItemNode],
		onError(error) {
			throw error;
		},
	});
}

function seed(editor: LexicalEditor): TaskCaret {
	let caret: TaskCaret | null = null;
	editor.update(
		() => {
			const text = $createTextNode("Ship ");
			const p = $createParagraphNode().append(text);
			$getRoot().clear().append(p);
			text.select(5, 5);
			caret = { key: text.getKey(), offset: 5, type: "text" };
		},
		{ discrete: true },
	);
	if (caret === null) throw new Error("seed failed");
	return caret;
}

function mentions(editor: LexicalEditor): MentionNode[] {
	return editor.getEditorState().read(() => {
		const out: MentionNode[] = [];
		const walk = (node: LexicalNode) => {
			if ($isMentionNode(node)) out.push(node);
			if ("getChildren" in node && typeof node.getChildren === "function") {
				for (const child of (node as { getChildren: () => LexicalNode[] }).getChildren()) walk(child);
			}
		};
		walk($getRoot());
		return out;
	});
}

afterEach(() => {
	setEditorHost({});
	setEntityIndexSource(null);
	picker.open.mockReset();
	picker.open.mockImplementation(() => true);
});

describe("task entity facts", () => {
	it("reads done from completedAt or the done status", () => {
		expect(isTaskDone(undefined)).toBe(false);
		expect(isTaskDone({ completedAt: null, statusKey: null })).toBe(false);
		expect(isTaskDone({ completedAt: 5 })).toBe(true);
		expect(isTaskDone({ statusKey: "done" })).toBe(true);
	});

	it("writes the same completion patch as the Tasks inline-task block", () => {
		expect(taskCompletionPatch(true, 7)).toEqual({ statusKey: "done", completedAt: 7 });
		expect(taskCompletionPatch(false)).toEqual({ statusKey: null, completedAt: null });
	});

	it("builds a schema-valid task bag", () => {
		const props = newTaskProperties("Write spec", 3);
		expect(props).toMatchObject({
			name: "Write spec",
			createdAt: 3,
			updatedAt: 3,
			completedAt: null,
		});
	});
});

describe("insertTaskMention", () => {
	it("inserts a task mention into the block and creates the Task/v1 entity with that id", async () => {
		const create = vi.fn(async () => ({}));
		setEditorHost({ entities: { create, update: vi.fn() } });
		const editor = makeEditor();
		const block = seed(editor);
		const id = insertTaskMention(editor, "  Write the spec  ", block);
		expect(id).toMatch(/^task-/);
		const [chip] = mentions(editor);
		expect(chip?.getEntityId()).toBe(id);
		expect(chip?.getEntityType()).toBe(TASK_ENTITY_TYPE);
		expect(chip?.getLabel()).toBe("Write the spec");
		expect(create).toHaveBeenCalledWith(
			TASK_ENTITY_TYPE,
			expect.objectContaining({ name: "Write the spec" }),
			id,
		);
	});

	it("lands at the caret mid-paragraph, not at the end of the block", () => {
		setEditorHost({ entities: { create: vi.fn(async () => ({})), update: vi.fn() } });
		const editor = makeEditor();
		let caret: TaskCaret | null = null;
		editor.update(
			() => {
				const text = $createTextNode("before after");
				$getRoot().clear().append($createParagraphNode().append(text));
				caret = { key: text.getKey(), offset: 7, type: "text" };
			},
			{ discrete: true },
		);
		insertTaskMention(editor, "Mid", caret);
		const text = editor.getEditorState().read(() => $getRoot().getTextContent());
		expect(text.indexOf("before")).toBe(0);
		expect(text.endsWith("after")).toBe(true);
		expect(text.startsWith("before after")).toBe(false);
	});

	it("stays inside the list item the caret is in, not new items at the list end", () => {
		setEditorHost({ entities: { create: vi.fn(async () => ({})), update: vi.fn() } });
		const editor = makeEditor();
		let caret: TaskCaret | null = null;
		editor.update(
			() => {
				const first = $createTextNode("first");
				const list = $createListNode("bullet").append(
					$createListItemNode().append(first),
					$createListItemNode().append($createTextNode("second")),
				);
				$getRoot().clear().append(list);
				caret = { key: first.getKey(), offset: 5, type: "text" };
			},
			{ discrete: true },
		);
		insertTaskMention(editor, "In list", caret);
		editor.getEditorState().read(() => {
			const list = $getRoot().getFirstChildOrThrow() as ListNode;
			expect(list.getChildrenSize()).toBe(2);
			const firstItem = list.getFirstChildOrThrow();
			expect($isListItemNode(firstItem)).toBe(true);
			expect((firstItem as ListItemNode).getChildren().some($isMentionNode)).toBe(true);
		});
	});

	it("is the note's reference to the task (the task's backlink)", () => {
		setEditorHost({ entities: { create: vi.fn(async () => ({})), update: vi.fn() } });
		const editor = makeEditor();
		const id = insertTaskMention(editor, "Ref me", seed(editor));
		const refs = extractNoteReferences(editor.getEditorState().toJSON());
		expect(refs).toContainEqual(
			expect.objectContaining({
				entityId: id,
				entityType: TASK_ENTITY_TYPE,
				kind: NoteReferenceKind.Mention,
			}),
		);
	});

	it("removes the chip when the create fails", async () => {
		setEditorHost({
			entities: { create: vi.fn(async () => Promise.reject(new Error("denied"))), update: vi.fn() },
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const editor = makeEditor();
		insertTaskMention(editor, "Doomed", seed(editor));
		await vi.waitFor(() => expect(mentions(editor)).toHaveLength(0));
		warn.mockRestore();
	});

	it("does nothing without a host or a name", () => {
		const editor = makeEditor();
		const block = seed(editor);
		expect(insertTaskMention(editor, "x", block)).toBeNull();
		setEditorHost({ entities: { create: vi.fn(async () => ({})), update: vi.fn() } });
		expect(insertTaskMention(editor, "   ", block)).toBeNull();
		expect(mentions(editor)).toHaveLength(0);
	});
});

describe("/task command", () => {
	it("offers a create row only once a name is typed", () => {
		expect(taskPickerRows(t, "")).toEqual([
			expect.objectContaining({ id: "task:empty", disabled: true }),
		]);
		expect(taskPickerRows(t, "Plan")[0]).toMatchObject({
			id: "task:create",
			label: "Create task “Plan”",
		});
	});

	it("opens the shared picker and creates the named task on Enter", async () => {
		const create = vi.fn(async () => ({}));
		setEditorHost({ entities: { create, update: vi.fn() } });
		const editor = makeEditor();
		seed(editor);
		const command = createTaskCommand(t);
		expect(command.id).toBe("block.task");
		command.run({ editor });
		const options = picker.open.mock.calls[0]?.[0] as {
			filter: (q: string) => unknown;
			onSelect: (id: string) => void;
			ariaLabel: string;
		};
		expect(options.ariaLabel).toBe("Create a task");
		options.filter("Plan launch");
		options.onSelect("task:create");
		await vi.waitFor(() => expect(create).toHaveBeenCalled());
		expect(mentions(editor)[0]?.getLabel()).toBe("Plan launch");
	});

	it("is a quiet no-op without an entities host", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		createTaskCommand(t).run({ editor: makeEditor() });
		expect(picker.open).not.toHaveBeenCalled();
		info.mockRestore();
	});
});

describe("<TaskCheckbox>", () => {
	let container: HTMLDivElement;
	let root: Root;
	let properties: Record<string, unknown>;
	let entityType: string;
	let notify: (() => void) | null;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		properties = { name: "T", completedAt: null, statusKey: null };
		entityType = TASK_ENTITY_TYPE;
		notify = null;
		setEntityIndexSource({
			list: async () => ({
				entities: [
					{
						id: "task-1",
						type: entityType,
						properties,
						createdAt: 0,
						updatedAt: 0,
						deletedAt: null,
						ownerAppId: "io.brainstorm.tasks",
					},
				],
			}),
			onChange: (listener) => {
				notify = listener;
				return { unsubscribe: () => {} };
			},
		});
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	async function render(editable?: boolean): Promise<HTMLInputElement | null> {
		const off = subscribeEntityIcons(() => {});
		const chip = <TaskCheckbox entityId="task-1" label="T" />;
		const tree: ReactNode =
			editable === undefined ? (
				chip
			) : (
				<LexicalComposer
					initialConfig={{
						namespace: "t",
						editable,
						onError: (e) => {
							throw e;
						},
					}}
				>
					{chip}
				</LexicalComposer>
			);
		await act(async () => root.render(tree));
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		off();
		return container.querySelector<HTMLInputElement>(".checkbox__input");
	}

	it("disables the checkbox outside an editable editor or without a host", async () => {
		const input = await render();
		expect(input?.disabled).toBe(true);
		expect(input?.getAttribute("aria-label")).toBe("Mark “T” done");
	});

	it("reflects the live done state", async () => {
		properties.completedAt = 9;
		const input = await render();
		expect(input?.checked).toBe(true);
		expect(notify).not.toBeNull();
	});

	it("writes the completion patch through the host when toggled in an editable editor", async () => {
		const update = vi.fn(async () => ({}));
		setEditorHost({ entities: { create: vi.fn(), update } });
		const input = await render(true);
		expect(input?.disabled).toBe(false);
		await act(async () => input?.click());
		expect(update).toHaveBeenCalledWith("task-1", expect.objectContaining({ statusKey: "done" }));
		expect(input?.checked).toBe(true);
	});

	it("refuses to write when the id resolves to something that is not a Task", async () => {
		const update = vi.fn(async () => ({}));
		setEditorHost({ entities: { create: vi.fn(), update } });
		entityType = "brainstorm/Note/v1";
		properties = { name: "Secret note" };
		const input = await render(true);
		expect(input?.disabled).toBe(true);
		await act(async () => input?.click());
		expect(update).not.toHaveBeenCalled();
	});

	it("reads won't do as closed and reopens it keeping no terminal status", async () => {
		const update = vi.fn(async () => ({}));
		setEditorHost({ entities: { create: vi.fn(), update } });
		properties.statusKey = "cancelled";
		const input = await render(true);
		expect(input?.checked).toBe(false);
		expect(input?.indeterminate).toBe(true);
		await act(async () => input?.click());
		expect(update).toHaveBeenCalledWith("task-1", { statusKey: null, completedAt: null });
	});

	it("reopening a done task keeps a non-terminal status", () => {
		expect(taskCompletionPatch(false, 1, "in-progress")).toEqual({
			statusKey: "in-progress",
			completedAt: null,
		});
	});

	it("stays read-only for a locked task or a read-only editor", async () => {
		setEditorHost({ entities: { create: vi.fn(), update: vi.fn() } });
		expect((await render(false))?.disabled).toBe(true);
		properties.locked = true;
		expect((await render(true))?.disabled).toBe(true);
	});
});
