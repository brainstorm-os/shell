// @vitest-environment jsdom
/**
 * Navigate-away-and-back must not blank the editor — and a regression guard on
 * the StrictMode incompatibility that forced us to drop `<StrictMode>` from the
 * Notes entry (`main.tsx`).
 *
 * The editor binds Lexical to a resolver-backed Y.Doc via `@lexical/yjs`'s
 * CollaborationPlugin, which fills Lexical ONLY from `observeDeep` events fired
 * by the one-time snapshot apply. React StrictMode double-invokes mount effects
 * in dev: it mounts the editor, unmounts it, then mounts it again — and the
 * second mount binds to the SAME, already-applied Y.Doc (`useMemo` cached it),
 * so its `observeDeep` receives no events and the note renders blank. That is
 * the recurring "open a note, navigate away, come back, it's empty" report. It
 * can't be fixed at the React layer (the second StrictMode mount isn't a new
 * render, so the binding can't be handed a fresh, not-yet-applied doc) and
 * re-applying a doc's own state fires no events — so the Notes app drops
 * StrictMode (a dev-only no-op in production).
 */

import {
	BASELINE_NODES,
	BrainstormEditor,
	plantSerializedStateIntoDoc,
} from "@brainstorm-os/editor";
import {
	YDocProvider,
	type YDocResolverApi,
	type YDocTransport,
	createYDocResolver,
	useYDoc,
	useYDocApplyPending,
	useYDocLoaded,
} from "@brainstorm-os/react-yjs";
import type { SerializedEditorState } from "lexical";
import { type ReactNode, StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

function paragraphSnapshot(text: string): Uint8Array {
	const doc = new Y.Doc();
	const state = {
		root: {
			type: "root",
			version: 1,
			format: "",
			indent: 0,
			direction: null,
			children: [
				{
					type: "paragraph",
					version: 1,
					format: "",
					indent: 0,
					direction: null,
					children: [
						{ type: "text", version: 1, format: 0, mode: "normal", style: "", text, detail: 0 },
					],
				},
			],
		},
	} as unknown as SerializedEditorState;
	plantSerializedStateIntoDoc(doc, state, { nodes: BASELINE_NODES });
	const u = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return u;
}

function makeResolver(snapshots: Record<string, Uint8Array>): YDocResolverApi {
	const transport: YDocTransport = {
		load: async (id) => snapshots[id] ?? null,
		persist: () => {},
		release: () => {},
	};
	return createYDocResolver(transport, { onError: () => {} });
}

function NoteEditor({ id }: { id: string }): ReactNode {
	const doc = useYDoc(id);
	const whenLoaded = useYDocLoaded(id);
	const applyPending = useYDocApplyPending(id);
	return (
		<BrainstormEditor
			doc={doc}
			docId={id}
			{...(whenLoaded ? { whenLoaded } : {})}
			{...(applyPending ? { applyPending } : {})}
		/>
	);
}

/** Render `id` the way the app does (Editor remounts per note via `key`),
 *  optionally wrapped in StrictMode. */
async function open(api: YDocResolverApi, id: string, strict: boolean): Promise<void> {
	const inner = (
		<YDocProvider resolver={api.resolve}>
			<NoteEditor key={id} id={id} />
		</YDocProvider>
	);
	await act(async () => {
		root.render(strict ? <StrictMode>{inner}</StrictMode> : inner);
	});
	await act(async () => {
		await new Promise((r) => setTimeout(r, 50));
	});
}

describe("editor navigate-away-and-back", () => {
	it("keeps the body on navigate-back (app config — no StrictMode)", async () => {
		const api = makeResolver({
			A: paragraphSnapshot("ALPHA CONTENT"),
			B: paragraphSnapshot("BETA CONTENT"),
		});
		await open(api, "A", false);
		expect(container.textContent).toContain("ALPHA CONTENT");
		await open(api, "B", false);
		expect(container.textContent).toContain("BETA CONTENT");
		await open(api, "A", false);
		expect(container.textContent, "navigate BACK to A must not be blank").toContain("ALPHA CONTENT");
	});

	// This was the regression guard for WHY StrictMode was dropped: under it,
	// navigate-back blanked. It was an `it.fails`, expected to fail until
	// `@lexical/yjs` became double-mount-safe — which it now is in this harness:
	// navigate-back retains the body even under StrictMode. The signal the old
	// comment promised has fired. Restoring `<StrictMode>` in the Notes entry
	// (`main.tsx`) is now viable, but should be validated in a real shell before
	// flipping it (jsdom double-mount ≠ Electron). Kept as a positive guard so a
	// future @lexical/yjs regression that re-breaks double-mount is caught.
	it("retains the body on navigate-back under StrictMode (now double-mount-safe)", async () => {
		const api = makeResolver({
			A: paragraphSnapshot("ALPHA CONTENT"),
			B: paragraphSnapshot("BETA CONTENT"),
		});
		await open(api, "A", true);
		await open(api, "B", true);
		await open(api, "A", true);
		expect(container.textContent).toContain("ALPHA CONTENT");
	});
});
