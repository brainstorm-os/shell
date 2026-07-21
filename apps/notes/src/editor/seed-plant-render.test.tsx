// @vitest-environment jsdom
/**
 * Regression: a body planted with `SEED_STANDIN_NODES` (the seeder /
 * Welcome-content path) must hydrate into a Notes editor that registers the
 * REAL node classes. Every stand-in MUST mirror the real node's KIND, because
 * `@lexical/yjs` encodes a `DecoratorNode` as an embedded element and a
 * `TextNode` as a text run — encode one kind and hydrate the other and the
 * binding throws `syncPropertiesAndTextFromYjs: could not find decorator node`
 * mid-`editor.update`, which rolls back the WHOLE update and leaves the note
 * body blank ("icon, empty body").
 *
 * The original break: `SeedMentionNode extends TextNode` while the real
 * `MentionNode` (apps/notes/src/editor/nodes/mention-node.tsx) is an inline
 * `DecoratorNode` — so every seeded / welcome note that contained an @-mention
 * (the Welcome hub note mentions all seven starter entities) rendered empty.
 */

import {
	BASELINE_NODES,
	SEED_STANDIN_NODES,
	createLocalProvider,
	plantSerializedStateIntoDoc,
} from "@brainstorm-os/editor";
import { type YDocTransport, createYDocResolver } from "@brainstorm-os/react-yjs";
import { createHeadlessEditor } from "@lexical/headless";
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from "@lexical/yjs";
import { $getRoot, type LexicalEditor, type SerializedEditorState } from "lexical";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { NOTES_ADDITIONAL_NODES } from "./notes-nodes";

function paraBlock(children: unknown[]) {
	return { type: "paragraph", version: 1, format: "", indent: 0, direction: null, children };
}
function textRun(text: string) {
	return { type: "text", version: 1, format: 0, mode: "normal", style: "", text, detail: 0 };
}
function mentionRun(entityId: string, label: string) {
	return { type: "mention", version: 1, entityId, entityType: "io.brainstorm.tasks/Task/v1", label };
}
function bodyOf(children: unknown[]): SerializedEditorState {
	return {
		root: { type: "root", version: 1, format: "", indent: 0, direction: null, children },
	} as unknown as SerializedEditorState;
}

function makeEditor(): LexicalEditor {
	return createHeadlessEditor({
		namespace: "notes-seed-plant",
		nodes: [...BASELINE_NODES, ...NOTES_ADDITIONAL_NODES],
		onError: (e) => {
			throw e;
		},
	});
}

/** Plant `body` with the seed stand-ins, then hydrate a Notes-node editor
 *  through the resolver → binding seam exactly as the running app does. */
async function plantThenRender(
	body: SerializedEditorState,
): Promise<{ size: number; text: string }> {
	const src = new Y.Doc();
	plantSerializedStateIntoDoc(src, body, { nodes: [...BASELINE_NODES, ...SEED_STANDIN_NODES] });
	const snapshot = Y.encodeStateAsUpdate(src);
	src.destroy();

	const transport: YDocTransport = {
		load: async () => snapshot,
		persist: () => {},
		release: () => {},
	};
	const handle = createYDocResolver(transport, { onError: () => {} }).resolve("e");
	const editor = makeEditor();

	const provider = createLocalProvider(
		handle.doc,
		handle.applyPending ? { applyPending: handle.applyPending } : {},
	);
	const binding = createBinding(
		editor,
		provider,
		"main",
		handle.doc,
		new Map([["main", handle.doc]]),
	);
	const onYjs = (events: unknown[], tx: { origin: unknown }) => {
		if (tx.origin !== binding) {
			// biome-ignore lint/suspicious/noExplicitAny: @lexical/yjs event types are internal
			syncYjsChangesToLexical(binding, provider, events as any, false);
		}
	};
	binding.root.getSharedType().observeDeep(onYjs);
	editor.registerUpdateListener(
		({ prevEditorState, editorState, dirtyLeaves, dirtyElements, normalizedNodes, tags }) => {
			if (!tags.has("skip-collab")) {
				syncLexicalUpdateToYjs(
					binding,
					provider,
					prevEditorState,
					editorState,
					dirtyElements,
					dirtyLeaves,
					normalizedNodes,
					tags,
				);
			}
		},
	);
	provider.connect();
	await handle.applyPending?.();
	await Promise.resolve();

	const out = editor.getEditorState().read(() => ({
		size: $getRoot().getChildrenSize(),
		text: $getRoot().getTextContent(),
	}));
	binding.root.getSharedType().unobserveDeep(onYjs);
	provider.disconnect();
	return out;
}

describe("seed plant → Notes-editor render", () => {
	it("renders a planted body that contains an inline mention (decorator)", async () => {
		const res = await plantThenRender(
			bodyOf([
				paraBlock([textRun("This is your dashboard.")]),
				paraBlock([textRun("We made you "), mentionRun("welcome-task-tour", "a task"), textRun(".")]),
			]),
		);
		expect(res.size).toBe(2);
		expect(res.text).toContain("This is your dashboard");
		expect(res.text).toContain("@a task");
	});

	it("the mention stand-in is a DecoratorNode, in lockstep with the real MentionNode kind", () => {
		// Guards against re-introducing the TextNode/DecoratorNode kind drift —
		// checked on the prototype (constructing a Lexical node needs an active
		// editor). A DecoratorNode subclass carries `decorate` + `isInline`; a
		// TextNode subclass carries neither.
		const standin = SEED_STANDIN_NODES.find((n) => n.getType() === "mention");
		expect(standin, "SEED_STANDIN_NODES must include a 'mention' stand-in").toBeDefined();
		const proto = (standin as { prototype: Record<string, unknown> }).prototype;
		expect(typeof proto.decorate, "a DecoratorNode stand-in defines decorate()").toBe("function");
		expect(typeof proto.isInline, "the mention stand-in defines isInline() (inline decorator)").toBe(
			"function",
		);
	});
});
