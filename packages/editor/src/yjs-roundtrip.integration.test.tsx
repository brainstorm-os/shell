// @vitest-environment jsdom
/**
 * End-to-end Yjs ↔ Lexical integration over the real seam where the
 * navigation bugs lived: resolver load → `applyPending()` → the
 * `@lexical/yjs` binding's `observeDeep`. The two sides are unit-tested
 * apart (resolver in react-yjs, plant/binding in editor); nothing pinned
 * them as ONE flow — a fresh editor binding receiving a resolver-hydrated
 * snapshot, and a Lexical edit shipping back out through the resolver.
 *
 * The wiring below mirrors `@lexical/react`'s CollaborationPlugin exactly
 * (createBinding → register `observeDeep` → register the update listener →
 * `provider.connect()`), so the test breaks if that ordering contract
 * regresses. Registering `observeDeep` BEFORE connect triggers the apply is
 * the whole point: applying the snapshot before the observer is attached
 * fires the Yjs events into a void and the editor renders blank (the
 * navigate-back regression, `tests/perf/specs/repro-note-loss.spec.ts`).
 *
 * jsdom: `createBinding` + the sync functions are DOM-free, but we run in
 * jsdom so a future change that reaches for `document` doesn't go silent.
 */

import { type YDocTransport, createYDocResolver, getUniversalBody } from "@brainstorm-os/react-yjs";
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from "@lexical/yjs";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	type SerializedEditorState,
} from "lexical";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createBrainstormHeadlessEditor } from "./headless";
import { createLocalProvider } from "./local-provider";
import { BASELINE_NODES } from "./nodes";
import { plantSerializedStateIntoDoc } from "./plant-state";

function paragraphState(text: string): SerializedEditorState {
	return {
		root: {
			children: [
				{
					children: [
						{ detail: 0, format: 0, mode: "normal", style: "", text, type: "text", version: 1 },
					],
					direction: "ltr",
					format: "",
					indent: 0,
					type: "paragraph",
					version: 1,
					textFormat: 0,
					textStyle: "",
				},
			],
			direction: "ltr",
			format: "",
			indent: 0,
			type: "root",
			version: 1,
		},
	} as unknown as SerializedEditorState;
}

/** Build the canonical snapshot the way production does: plant a Lexical
 *  state into a doc's universal body, then encode it as a Yjs update. */
function snapshotFromLexical(text: string): Uint8Array {
	const src = new Y.Doc();
	plantSerializedStateIntoDoc(src, paragraphState(text), { nodes: BASELINE_NODES });
	return Y.encodeStateAsUpdate(src);
}

function recordingTransport(snapshots: Record<string, Uint8Array>): {
	transport: YDocTransport;
	persisted: Array<{ id: string; update: Uint8Array }>;
} {
	const persisted: Array<{ id: string; update: Uint8Array }> = [];
	return {
		persisted,
		transport: {
			load: async (id) => snapshots[id] ?? null,
			persist: (id, update) => persisted.push({ id, update }),
			release: () => {},
		},
	};
}

/** Replicate CollaborationPlugin's binding lifecycle headlessly: observer
 *  registered BEFORE connect (which triggers the resolver's applyPending). */
function bindEditorToHandle(
	editor: ReturnType<typeof createBrainstormHeadlessEditor>,
	handle: { doc: Y.Doc; applyPending?: () => Promise<void>; loaded?: Promise<void> },
): { provider: ReturnType<typeof createLocalProvider>; teardown: () => void } {
	const id = "roundtrip";
	const docMap = new Map<string, Y.Doc>([[id, handle.doc]]);
	const provider = createLocalProvider(handle.doc, {
		...(handle.applyPending ? { applyPending: handle.applyPending } : {}),
		...(handle.loaded ? { whenLoaded: handle.loaded } : {}),
	});
	const binding = createBinding(editor, provider, id, handle.doc, docMap);

	const onYjsTreeChanges = (events: unknown[], transaction: { origin: unknown }) => {
		if (transaction.origin !== binding) {
			// biome-ignore lint/suspicious/noExplicitAny: @lexical/yjs event types are internal
			syncYjsChangesToLexical(binding, provider, events as any, false);
		}
	};
	binding.root.getSharedType().observeDeep(onYjsTreeChanges);

	const removeListener = editor.registerUpdateListener(
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

	return {
		provider,
		teardown: () => {
			binding.root.getSharedType().unobserveDeep(onYjsTreeChanges);
			removeListener();
			provider.disconnect();
		},
	};
}

function textContentOf(editor: ReturnType<typeof createBrainstormHeadlessEditor>): string {
	return editor.getEditorState().read(() => $getRoot().getTextContent());
}

describe("Yjs ↔ Lexical roundtrip (resolver → binding)", () => {
	it("plants a Lexical state into Yjs and reads it back through the universal body", async () => {
		const { transport } = recordingTransport({ note_1: snapshotFromLexical("hello roundtrip") });
		const r = createYDocResolver(transport, { onError: () => {} });

		const handle = r.resolve("note_1");
		await handle.applyPending?.();

		expect(getUniversalBody(handle.doc).toString()).toContain("hello roundtrip");
	});

	it("hydrates a fresh editor binding from a resolver-loaded snapshot", async () => {
		const { transport } = recordingTransport({ note_1: snapshotFromLexical("loaded into lexical") });
		const r = createYDocResolver(transport, { onError: () => {} });
		const handle = r.resolve("note_1");

		const editor = createBrainstormHeadlessEditor();
		const { teardown } = bindEditorToHandle(editor, handle);
		// connect() triggers applyPending; the snapshot applies AFTER observeDeep
		// is registered, so the Yjs events reach the binding and populate Lexical.
		await handle.applyPending?.();

		expect(textContentOf(editor)).toContain("loaded into lexical");
		teardown();
	});

	it("ships a Lexical edit back out through the resolver as a persisted update", async () => {
		const { transport, persisted } = recordingTransport({ note_1: snapshotFromLexical("start") });
		const r = createYDocResolver(transport, { onError: () => {} });
		const handle = r.resolve("note_1");

		const editor = createBrainstormHeadlessEditor();
		const { teardown } = bindEditorToHandle(editor, handle);
		await handle.applyPending?.();
		// Hydration applies under REMOTE_ORIGIN and is correctly NOT persisted
		// (echo suppression), so persist only ever ships local deltas — the
		// base state arrived via load. Capture it to compose the reconstruction.
		const baseState = Y.encodeStateAsUpdate(handle.doc);
		persisted.length = 0;

		editor.update(
			() => {
				const p = $createParagraphNode();
				p.append($createTextNode(" appended"));
				$getRoot().append(p);
			},
			{ discrete: true },
		);

		expect(persisted.length).toBeGreaterThan(0);
		// Base snapshot + the persisted local deltas reconstruct the edit.
		const replica = new Y.Doc();
		Y.applyUpdate(replica, baseState);
		for (const { update } of persisted) Y.applyUpdate(replica, update);
		expect(getUniversalBody(replica).toString()).toContain("appended");
		// ...and the live replica reflects it too.
		expect(getUniversalBody(handle.doc).toString()).toContain("appended");
		teardown();
	});

	it("does not render blank when observeDeep registers before the snapshot applies", async () => {
		// The explicit ordering guard: a fresh binding + late-applied snapshot
		// must still populate the editor (the navigate-back-blank regression).
		const { transport } = recordingTransport({ note_1: snapshotFromLexical("not blank") });
		const r = createYDocResolver(transport, { onError: () => {} });
		const handle = r.resolve("note_1");

		const editor = createBrainstormHeadlessEditor();
		const { teardown } = bindEditorToHandle(editor, handle);
		await handle.applyPending?.();

		expect(textContentOf(editor).trim()).not.toBe("");
		teardown();
	});
});
