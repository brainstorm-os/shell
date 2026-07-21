/**
 * Plant a `SerializedEditorState` into a Yjs doc's universal body via a
 * one-shot headless `@lexical/yjs` binding.
 *
 * Why this lives in `@brainstorm-os/editor`: the operation is mechanically
 * the same across every app that backs an editor with the
 * shared-Y.Doc-root contract (Notes for legacy-body migration; Journal
 * for first-open seeding when the note's body lives in
 * `entity.properties.body` but the Y.Doc is still empty). Each consumer
 * passes its own node set — Notes brings MIGRATION_NODES (the full
 * Notes editor surface), Journal brings BASELINE_NODES only — and a
 * namespace string used by the throwaway editor + provider.
 *
 * Lifetime: the entire plant runs inside one `doc.transact()` so it
 * becomes a single Yjs transaction (one undo step, one update message).
 * The headless editor + binding + provider are disposed in `finally`,
 * even on parse failure — there is no observable cost beyond the parse
 * + plant itself.
 *
 * Throws on parse failure. Callers either catch and surface a
 * recovery hint (the Notes migrate-body path) or wrap in try/catch and
 * fall back to read-only rendering.
 */

import { createHeadlessEditor } from "@lexical/headless";
import { createBinding, syncLexicalUpdateToYjs } from "@lexical/yjs";
import type { Klass, LexicalNode, SerializedEditorState } from "lexical";
import type { Doc } from "yjs";
import { createLocalProvider } from "./local-provider";

export type PlantStateOptions = {
	/** Lexical node set the headless editor should register. The plant
	 *  must include every node type the serialized state references —
	 *  consumers that share a node set (e.g. BASELINE_NODES) just spread
	 *  it; consumers with custom nodes (Notes' migration) append theirs. */
	readonly nodes: ReadonlyArray<Klass<LexicalNode>>;
	/** Namespace tag for the headless editor + provider. Must be unique
	 *  per concurrent plant on the same doc to avoid binding-id
	 *  collisions; defaults to `"brainstorm-plant"`. */
	readonly namespace?: string;
};

export function plantSerializedStateIntoDoc(
	doc: Doc,
	serialized: SerializedEditorState,
	options: PlantStateOptions,
): void {
	const namespace = options.namespace ?? "brainstorm-plant";
	const editor = createHeadlessEditor({
		namespace,
		nodes: [...options.nodes],
		onError(err) {
			throw err;
		},
	});

	const provider = createLocalProvider(doc);
	const binding = createBinding(editor, provider, namespace, doc, new Map([[namespace, doc]]));

	const off = editor.registerUpdateListener(
		({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
			if (tags.has("skip-collab")) return;
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
		},
	);

	try {
		doc.transact(() => {
			const parsed = editor.parseEditorState(serialized);
			editor.setEditorState(parsed);
		});
	} finally {
		off();
		teardownEditor(editor);
		provider.disconnect();
	}
}

/** Lexical's headless editor exposes no public dispose hook; the
 *  `_destroyed` flag + dropping references is the documented pattern
 *  (the React composer does the same on unmount via internal teardown).
 *  Best-effort: no observers were registered we can't unhook here. */
function teardownEditor(editor: ReturnType<typeof createHeadlessEditor>): void {
	type WithDestroy = typeof editor & { _destroyed?: boolean };
	(editor as WithDestroy)._destroyed = true;
}
