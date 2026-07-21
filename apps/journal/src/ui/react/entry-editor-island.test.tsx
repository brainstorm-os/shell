// @vitest-environment jsdom
/**
 * Regression (F-236 follow-up): blank-render recovery must hand the remounted
 * editor a FRESH Y.Doc replica, not the same already-populated instance.
 *
 * `useYDoc` resolves during render but releases in an effect cleanup, so a
 * same-id key bump re-resolves (returns the same doc, ref still held) before
 * the old editor releases — the entry never reaches refs 0, never gets
 * retained/revived, and the new Lexical binding observes a full doc with no
 * `observeDeep` events → permanently blank. The island instead renders an
 * unmount gap so the replica fully releases before the remount revives it.
 * This test asserts the post-recovery editor receives a different doc instance
 * (the revived replica) than the pre-recovery one.
 */

import { createYDocResolver } from "@brainstorm-os/react-yjs";
import { useYDoc } from "@brainstorm-os/react-yjs";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc } from "yjs";

const seenDocs: Doc[] = [];
const recoverFns: Array<() => void> = [];

vi.mock("../entry-editor", () => ({
	JournalEntryEditor: ({
		noteId,
		onRecoverBlank,
	}: { noteId: string; onRecoverBlank?: () => void }) => {
		// Exercise the real resolve/release lifecycle so a remount actually
		// re-resolves through the resolver (the bug lives in that interaction).
		const doc = useYDoc(noteId);
		seenDocs.push(doc);
		if (onRecoverBlank) recoverFns.push(onRecoverBlank);
		return null;
	},
}));

import { EntryEditorIsland } from "./entry-editor-island";

describe("EntryEditorIsland — blank recovery revives a fresh replica", () => {
	let container: HTMLDivElement;
	let root: Root;
	let originalRaf: typeof globalThis.requestAnimationFrame;

	beforeEach(() => {
		seenDocs.length = 0;
		recoverFns.length = 0;
		// Run the unmount-gap rAF synchronously so the release→revive cycle
		// completes inside `act`.
		originalRaf = globalThis.requestAnimationFrame;
		globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
			cb(0);
			return 0;
		}) as typeof globalThis.requestAnimationFrame;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		globalThis.requestAnimationFrame = originalRaf;
	});

	it("hands the remounted editor a different doc instance after onRecoverBlank", () => {
		const resolver = createYDocResolver({
			load: async () => null,
			persist: () => {},
			release: () => {},
		});

		act(() => {
			root.render(<EntryEditorIsland resolver={resolver.resolve} noteId="journal-2026-06-16" />);
		});
		const before = seenDocs.at(-1);
		expect(before).toBeDefined();

		// Editor reports a blank-with-content render → recovery.
		act(() => {
			recoverFns.at(-1)?.();
		});
		const after = seenDocs.at(-1);

		expect(after).toBeDefined();
		expect(after).not.toBe(before);
	});
});
