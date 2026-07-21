/**
 * Journal dev hook — the Journal-side mirror of Notes'
 * `window.__brainstormNotesDev`, so the dogfood harness can write a
 * daily-log body without synthetic keystrokes (which corrupt the
 * Yjs-bound editor in headless Electron — see the shared
 * `@brainstorm-os/editor` dev-bench primitives this builds on).
 *
 * Minimal surface: Journal's in-place day editor is intentionally light
 * (no tables / code / embeds — power users open the day in Notes for the
 * full suite), so the hook needs only paragraph append + the open
 * entry's id. The capture + append mechanics come from the shared
 * primitives; this file is just the Journal-named global adapter.
 *
 * Always installed (mirrors the Notes rationale): the per-app renderer is
 * sandboxed, so the global is only reachable from code already running in
 * the Journal renderer, and unconditional install keeps the packaged-mode
 * harness working without a rebuild.
 */

import { EditorCapturePlugin, devAppendParagraph } from "@brainstorm-os/editor";
import type { LexicalEditor } from "lexical";
import { type ReactElement, useCallback } from "react";

type JournalDevGlobal = {
	appendParagraph: (text: string) => Promise<void>;
	currentEntryId: () => string | null;
};

declare global {
	interface Window {
		__brainstormJournalDev?: JournalDevGlobal;
	}
}

let capturedEditor: LexicalEditor | null = null;
let capturedEntryId: string | null = null;

function installGlobal(): void {
	if (typeof window === "undefined") return;
	if (window.__brainstormJournalDev) return;
	window.__brainstormJournalDev = {
		appendParagraph: async (text) => {
			if (!capturedEditor) {
				throw new Error("[journal/dev] appendParagraph called before an editor mounted.");
			}
			await devAppendParagraph(capturedEditor, text);
		},
		currentEntryId: () => capturedEntryId,
	};
}

export function JournalDevPlugin({ entryId }: { entryId: string }): ReactElement | null {
	const onMount = useCallback(
		(editor: LexicalEditor) => {
			capturedEditor = editor;
			capturedEntryId = entryId;
			installGlobal();
		},
		[entryId],
	);
	const onUnmount = useCallback((editor: LexicalEditor) => {
		if (capturedEditor === editor) capturedEditor = null;
	}, []);
	return <EditorCapturePlugin onMount={onMount} onUnmount={onUnmount} />;
}
