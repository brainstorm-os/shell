/**
 * React-island mount helper for the Journal day-body editor.
 *
 * `apps/journal/src/app.ts` is a plain-DOM scaffold; only the day body
 * needs the editor stack. Rather than convert the whole app to React,
 * we mount a single `createRoot()` whose tree wraps `<BrainstormEditor>`
 * in the shell-installed `YDocResolverProvider`. The root is keyed by
 * the host element + the note id — when the user navigates to a
 * different day, `mountJournalEntryEditor` is re-called with the new
 * `noteId` and React reconciles in place.
 *
 * Standalone (`vite preview`) has no preload-exposed entities doc
 * surface; `getYDocResolverApi()` returns null, this helper returns
 * `null`, and the caller falls back to the read-only paragraph. The
 * editor never mounts there.
 */

import type { SelectionCommentAnchor } from "@brainstorm-os/editor";
import { YDocProvider } from "@brainstorm-os/react-yjs";
import type { SerializedEditorState } from "lexical";
import { type Root, createRoot } from "react-dom/client";
import { getYDocResolverApi } from "../store/ydoc-resolver";
import { JournalEntryEditor } from "./entry-editor";

/** Persist the body's denormalised mirror (`body` snippet) for `noteId`.
 *  Supplied by `app.ts`, which closes over `services.entities.update`. */
export type JournalDenormalizeFn = (noteId: string, body: SerializedEditorState) => void;

/** Comments wiring (B11.9) — both callbacks land the user on the right
 *  panel's Comments tab; supplied once at mount (stable `app.ts` closures). */
export type JournalCommentHooks = {
	onSelection: (anchor: SelectionCommentAnchor) => void;
	onBlockClick: (blockId: string) => void;
};

export type JournalEditorHandle = {
	/** Re-render with a new note id + seed body. Cheap — same root,
	 *  React diffs. `seedBody` may be omitted (no seed) or stale on
	 *  subsequent calls; the inner component captures the first valid
	 *  Lexical state per noteId and ignores later passes so a snippet-
	 *  only re-projection can't clobber edits. */
	update(noteId: string, seedBody?: unknown): void;
	/** Tear down the React tree + release the resolver refcount. */
	dispose(): void;
};

/** Mount the editor island into `host`. Returns a handle, or `null` if
 *  the resolver isn't available (preview / standalone mode) — in that
 *  case the caller keeps its read-only fallback. */
export function mountJournalEntryEditor(
	host: HTMLElement,
	noteId: string,
	seedBody?: unknown,
	onDenormalize?: JournalDenormalizeFn,
	comments?: JournalCommentHooks,
): JournalEditorHandle | null {
	const resolverApi = getYDocResolverApi();
	if (!resolverApi) return null;

	const root: Root = createRoot(host);
	// Per-note blank-render recovery budget (F-236): when the Y.Doc has
	// content but Lexical rendered none (an apply/observeDeep race that lost a
	// seeded / cold-reopened body), `BlankRecoveryPlugin` asks us to remount.
	// We fold a nonce into the React `key` and re-render; capped at 2 per note
	// so a genuinely unhydratable doc can't loop. A clean hydrate releases the
	// note's spent budget (a later session-race can recover again).
	const MAX_RECOVERY_ATTEMPTS = 2;
	const recoveryByNote = new Map<string, number>();
	let currentId = noteId;
	let currentBody: unknown = seedBody;
	const render = (id: string, body: unknown): void => {
		currentId = id;
		currentBody = body;
		const nonce = recoveryByNote.get(id) ?? 0;
		// `key={id}` on `<JournalEntryEditor>` is load-bearing: when the
		// user clicks a different calendar day, React must FULLY unmount
		// the prior subtree (its `useYDoc(id)` + Lexical
		// `<CollaborationPlugin>` provider) and remount against the new
		// noteId. Without the key, React reconciles in place — `useYDoc`
		// returns a fresh doc but `CollaborationPlugin`'s binding stays
		// attached to the prior Y.Doc, so the title header swaps but the
		// contenteditable keeps showing the previous day's text. The
		// Notes app uses the same `key={noteId}` discipline at its caller.
		// NOT wrapped in <StrictMode>: its dev double-mount re-binds the
		// `@lexical/yjs` editor to an already-applied Y.Doc, whose `observeDeep`
		// then fires no events → the entry renders blank on reopen. StrictMode
		// is a production no-op; dropping it makes dev match the shipped app.
		// (Same fix + rationale as `apps/notes/src/main.tsx`.)
		root.render(
			<YDocProvider resolver={resolverApi.resolve}>
				<JournalEntryEditor
					key={`${id}:${nonce}`}
					noteId={id}
					seedBody={body}
					onRecoverBlank={() => {
						const attempts = recoveryByNote.get(id) ?? 0;
						if (attempts >= MAX_RECOVERY_ATTEMPTS) return;
						recoveryByNote.set(id, attempts + 1);
						if (currentId === id) render(id, currentBody);
					}}
					onRecoverReset={() => recoveryByNote.delete(id)}
					{...(onDenormalize ? { onDenormalize } : {})}
					{...(comments
						? {
								onCommentSelection: comments.onSelection,
								onCommentBlockClick: comments.onBlockClick,
							}
						: {})}
				/>
			</YDocProvider>,
		);
	};
	render(noteId, seedBody);

	return {
		update(nextNoteId, nextSeedBody) {
			render(nextNoteId, nextSeedBody);
		},
		dispose() {
			root.unmount();
		},
	};
}
