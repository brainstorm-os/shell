// @vitest-environment jsdom
/**
 * Regression: the journal day-body editor must hand `<CollaborationPlugin>` a
 * STABLE `initialEditorState` identity across re-renders.
 *
 * `seedBody` (the entry's `properties.body`) is rebuilt with a fresh object
 * identity on every projection — each live vault snapshot makes a new
 * `JournalEntry`. `initialEditorState` rides CollaborationPlugin's effect
 * deps, and its cleanup runs `docMap.delete` + `provider.disconnect()`
 * (→ `awareness.destroy()`). So a seed whose identity tracked `seedBody`
 * tore the Yjs binding down + reconnected it on every live update, blanking
 * a previously-opened (saved-body) entry on reopen. The fix captures the seed
 * once per mount; this pins the identity invariant.
 */

import type { SerializedEditorState } from "lexical";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seenInitialStates: unknown[] = [];

// Capture every `initialEditorState` the editor wrapper receives; render
// children so the plugin tree still mounts (all stubbed to no-ops).
vi.mock("@brainstorm-os/editor", () => {
	const Passthrough = ({ children }: { children?: unknown }) => children ?? null;
	const Noop = () => null;
	return {
		BrainstormEditor: ({
			initialEditorState,
			children,
		}: { initialEditorState?: unknown; children?: unknown }) => {
			seenInitialStates.push(initialEditorState);
			return children ?? null;
		},
		FullEditorPlugins: Passthrough,
		AutosavePlugin: Noop,
		BlankRecoveryPlugin: Noop,
		CommentHighlightPlugin: Noop,
		EditorCapturePlugin: Noop,
		TitlePlugin: Noop,
		FULL_EDITOR_NODES: [],
		TitleNode: class {},
		richTextTheme: {},
	};
});

vi.mock("@brainstorm-os/react-yjs", () => {
	const doc = {};
	return {
		useYDoc: () => doc,
		useYDocLoaded: () => undefined,
		useYDocApplyPending: () => undefined,
	};
});

vi.mock("../store/comments-bindings", () => ({ useOpenCommentBlockIds: () => new Set() }));
vi.mock("./editor-bridge", () => ({ setJournalEditor: () => {}, clearJournalEditor: () => {} }));
vi.mock("./journal-dev-plugin", () => ({ JournalDevPlugin: () => null }));
vi.mock("./mention-click-plugin", () => ({ JournalMentionClickPlugin: () => null }));

import { JournalEntryEditor } from "./entry-editor";

function lexicalBody(text: string): SerializedEditorState {
	return {
		root: {
			type: "root",
			children: [
				{
					type: "paragraph",
					version: 1,
					children: [{ type: "text", text, version: 1 }],
				},
			],
		},
	} as unknown as SerializedEditorState;
}

describe("journal entry editor — stable seed identity", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		seenInitialStates.length = 0;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("keeps the same initialEditorState across a seedBody-identity change", () => {
		const render = (seedBody: SerializedEditorState) =>
			act(() => {
				root.render(<JournalEntryEditor noteId="journal-2026-06-05" seedBody={seedBody} />);
			});

		// Re-render with structurally-equal but referentially-NEW seed objects,
		// the way a live projection rebuild does.
		render(lexicalBody("hello"));
		render(lexicalBody("hello"));
		render(lexicalBody("hello"));

		const states = seenInitialStates.filter((s) => s !== undefined);
		expect(states.length).toBeGreaterThan(0);
		const first = states[0];
		for (const s of states) expect(s).toBe(first);
	});
});
