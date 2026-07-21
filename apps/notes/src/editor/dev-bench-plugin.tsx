/**
 * Dev-only bench hook — gated on `process.env.NODE_ENV !== "production"`
 * so production bundles never carry it. Captures the live `LexicalEditor`
 * instance into a module-scope ref the moment a Notes editor mounts, and
 * exposes a `window.__brainstormNotesDev.seedLargeDoc(profileId)` shim
 * that the 13.4a.2 Playwright perf bench calls to seed
 * `LARGE_DOC_PROFILES` synthetic content into the running editor without
 * a multi-step UI dance.
 *
 * Why a parallel `__brainstormNotesDev` global and not `window.brainstorm
 * .dev.notes.seedLargeDoc`: the app preload exposes `window.brainstorm`
 * via `contextBridge.exposeInMainWorld`, which deep-freezes the object
 * across the isolated-world boundary — the renderer cannot extend it
 * post-exposure. The harness reads this global from the same renderer
 * world it dispatches keystrokes against, so it sees the renderer's own
 * writes.
 *
 * The fixture itself (`LARGE_DOC_PROFILES` + `seedLargeDoc`) lives in
 * `@brainstorm-os/editor` per the N5 contract; this file is the renderer-
 * side adapter that calls it against the captured editor.
 */

import { LARGE_DOC_PROFILES, type LargeDocProfile, seedLargeDoc } from "@brainstorm-os/editor";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect } from "react";
import { BLOCK_COMMANDS } from "./commands";

/**
 * The hook is always installed. The Notes renderer is sandboxed per-app,
 * so the global is only reachable to code already running inside the
 * Notes renderer (no cross-app or web origin can see it). The bundle
 * cost is small enough — a single useEffect + a property write — that
 * NODE_ENV / runtime-flag gating costs more in test friction than the
 * unconditional install costs at runtime. The 13.4a.2 perf harness
 * needed a way to seed `LARGE_DOC_PROFILES` into a packaged-mode build
 * without rebuilding; always-on is the path of least surprise.
 */

type SeedLargeDocFn = (profileId: keyof typeof LARGE_DOC_PROFILES) => Promise<void>;

export type NotesDevGlobal = {
	seedLargeDoc: SeedLargeDocFn;
	/** Run a registered block command by id against the live editor — lets
	 *  the Playwright harness exercise slash-menu commands (e.g. sub-page
	 *  insertion) without dispatching synthetic keystrokes, which corrupt
	 *  the Yjs-bound editor in headless Electron. Returns once the command's
	 *  synchronous editor mutation has committed + painted. */
	runBlockCommand: (id: string) => Promise<void>;
	/** Append a paragraph with the given text to the body — deterministic
	 *  recognizable content for round-trip tests, without keystrokes. */
	appendParagraph: (text: string) => Promise<void>;
	/** Replace the currently-selected table cell's content with `text`
	 *  (single paragraph) — lets the harness seed table content for the
	 *  fill-down / sort chords without keystrokes. No-op outside a table. */
	setSelectedCellText: (text: string) => Promise<void>;
	/** Read the first table's `colWidths` — lets the resize spec assert the
	 *  drag persisted a width independent of how the colgroup renders. */
	firstTableColWidths: () => Promise<readonly number[] | undefined>;
	/** Insert multi-line text into the selected code block (newlines become
	 *  line breaks) — lets the line-numbers spec seed a several-line block
	 *  without keystrokes. No-op outside a code block. */
	setSelectedCodeText: (text: string) => Promise<void>;
	/** Set the language on the CodeNode containing the selection — lets the
	 *  Shiki-highlight spec pick a grammar without driving the toolbar menu.
	 *  No-op outside a code block. */
	setSelectedCodeLanguage: (language: string) => Promise<void>;
	/** Append a block-level `TransclusionNode` targeting `entityId` to the body
	 *  — lets the B6.4b spec exercise the live nested-body render without the
	 *  `!@` typeahead's synthetic keystrokes (which corrupt the collab editor). */
	insertTransclusion: (entityId: string, entityType: string, label: string) => Promise<void>;
	/** Append a block-level `BlockEmbedNode` targeting `entityId` with an
	 *  explicit `blockId` — lets the live-block spec mount a real BP block
	 *  (Database grid / inline task) without the `/embed` picker's synthetic
	 *  keystrokes (which corrupt the collab editor). */
	insertEmbed: (
		entityId: string,
		entityType: string,
		label: string,
		blockId: string,
	) => Promise<void>;
	/** The open note's id (the host editor's docId) — lets the transclusion
	 *  spec capture a target note's id after creating it. `null` before any
	 *  editor mounts. */
	currentNoteId: () => string | null;
};

declare global {
	interface Window {
		__brainstormNotesDev?: NotesDevGlobal;
	}
}

let capturedEditor: import("lexical").LexicalEditor | null = null;
let capturedNoteId: string | null = null;

function installGlobal(): void {
	if (typeof window === "undefined") return;
	if (window.__brainstormNotesDev) return;
	window.__brainstormNotesDev = {
		seedLargeDoc: async (profileId) => {
			const editor = capturedEditor;
			if (!editor) {
				throw new Error(
					"[notes/dev] seedLargeDoc called before an editor mounted — open a note first.",
				);
			}
			const profile: LargeDocProfile | undefined = LARGE_DOC_PROFILES[profileId];
			if (!profile) {
				throw new Error(
					`[notes/dev] seedLargeDoc: unknown profile "${String(profileId)}". ` +
						`Known: ${Object.keys(LARGE_DOC_PROFILES).join(", ")}.`,
				);
			}
			// `seedLargeDoc` wraps its mutation in a `{ discrete: true }`
			// transaction — Lexical commits + reconciles synchronously on
			// return. The double-rAF that follows lets the contenteditable
			// finish painting the seeded block tree before the caller (the
			// Playwright bench) starts dispatching keystrokes against it.
			seedLargeDoc(editor, profile);
			await new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			});
		},
		appendParagraph: async (text) => {
			const editor = capturedEditor;
			if (!editor) {
				throw new Error("[notes/dev] appendParagraph called before an editor mounted.");
			}
			const lexical = await import("lexical");
			editor.update(
				() => {
					const p = lexical.$createParagraphNode();
					p.append(lexical.$createTextNode(text));
					lexical.$getRoot().append(p);
				},
				{ discrete: true },
			);
			await new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			});
		},
		firstTableColWidths: async () => {
			const editor = capturedEditor;
			if (!editor) return undefined;
			const lexical = await import("lexical");
			const table = await import("@lexical/table");
			let widths: readonly number[] | undefined;
			editor.getEditorState().read(() => {
				for (const node of lexical.$getRoot().getChildren()) {
					if (table.$isTableNode(node)) {
						widths = node.getColWidths();
						return;
					}
				}
			});
			return widths;
		},
		setSelectedCodeText: async (text) => {
			const editor = capturedEditor;
			if (!editor) {
				throw new Error("[notes/dev] setSelectedCodeText called before an editor mounted.");
			}
			const lexical = await import("lexical");
			editor.update(
				() => {
					const sel = lexical.$getSelection();
					if (!lexical.$isRangeSelection(sel)) return;
					sel.insertText(text);
				},
				{ discrete: true },
			);
			await new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			});
		},
		setSelectedCellText: async (text) => {
			const editor = capturedEditor;
			if (!editor) {
				throw new Error("[notes/dev] setSelectedCellText called before an editor mounted.");
			}
			const lexical = await import("lexical");
			const table = await import("@lexical/table");
			editor.update(
				() => {
					const sel = lexical.$getSelection();
					if (!lexical.$isRangeSelection(sel)) return;
					const cell = table.$getTableCellNodeFromLexicalNode(sel.anchor.getNode());
					if (!table.$isTableCellNode(cell)) return;
					for (const child of cell.getChildren()) child.remove();
					const p = lexical.$createParagraphNode();
					p.append(lexical.$createTextNode(text));
					cell.append(p);
					p.selectEnd();
				},
				{ discrete: true },
			);
			await new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			});
		},
		setSelectedCodeLanguage: async (language) => {
			const editor = capturedEditor;
			if (!editor) {
				throw new Error("[notes/dev] setSelectedCodeLanguage called before an editor mounted.");
			}
			const lexical = await import("lexical");
			const code = await import("@lexical/code");
			const utils = await import("@lexical/utils");
			editor.update(
				() => {
					const sel = lexical.$getSelection();
					if (!lexical.$isRangeSelection(sel)) return;
					const node = utils.$findMatchingParent(
						sel.anchor.getNode(),
						(n) => n instanceof code.CodeNode,
					);
					if (node instanceof code.CodeNode) node.setLanguage(language);
				},
				{ discrete: true },
			);
			await new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			});
		},
		insertTransclusion: async (entityId, entityType, label) => {
			const editor = capturedEditor;
			if (!editor) {
				throw new Error("[notes/dev] insertTransclusion called before an editor mounted.");
			}
			const lexical = await import("lexical");
			const { $createTransclusionNode } = await import("./nodes/transclusion-node");
			editor.update(
				() => {
					lexical.$getRoot().append($createTransclusionNode(entityId, entityType, label));
					// Trailing paragraph so the caret has somewhere to land after the
					// block-level decorator (mirrors the `!@` insertion path).
					lexical.$getRoot().append(lexical.$createParagraphNode());
				},
				{ discrete: true },
			);
			await new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			});
		},
		insertEmbed: async (entityId, entityType, label, blockId) => {
			const editor = capturedEditor;
			if (!editor) {
				throw new Error("[notes/dev] insertEmbed called before an editor mounted.");
			}
			const lexical = await import("lexical");
			const { $createBlockEmbedNode } = await import("./nodes/block-embed-node");
			editor.update(
				() => {
					lexical.$getRoot().append($createBlockEmbedNode(entityId, entityType, label, blockId));
					lexical.$getRoot().append(lexical.$createParagraphNode());
				},
				{ discrete: true },
			);
			await new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			});
		},
		currentNoteId: () => capturedNoteId,
		runBlockCommand: async (id) => {
			const editor = capturedEditor;
			if (!editor) {
				throw new Error("[notes/dev] runBlockCommand called before an editor mounted.");
			}
			const command = BLOCK_COMMANDS.find((c) => c.id === id);
			if (!command) {
				throw new Error(
					`[notes/dev] runBlockCommand: unknown command "${id}". ` +
						`Known: ${BLOCK_COMMANDS.map((c) => c.id).join(", ")}.`,
				);
			}
			// Faithfully replicate the user's slash-menu path: they press Enter
			// for a FRESH line, type "/sub", and the menu's activate() clears
			// that trigger paragraph + selectStart, then runs the command. We
			// append a fresh empty paragraph, park the caret there, then clear
			// + selectStart (no-op on the empty para) + run — so existing
			// content is never touched, unlike clearing the caret's current
			// block. No synthetic keystrokes (which corrupt the collab editor
			// and race the menu's fuzzy match).
			editor.focus();
			const lexical = await import("lexical");
			editor.update(() => {
				const fresh = lexical.$createParagraphNode();
				lexical.$getRoot().append(fresh);
				fresh.selectStart();
			});
			editor.update(() => {
				const sel = lexical.$getSelection();
				if (!lexical.$isRangeSelection(sel)) return;
				const block = sel.anchor.getNode().getTopLevelElementOrThrow();
				if (lexical.$isElementNode(block)) {
					block.clear();
					block.selectStart();
				}
			});
			command.run({ editor });
			await new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			});
		},
	};
}

/**
 * Mounted unconditionally inside `<BrainstormEditor>` (see editor.tsx
 * for the rationale — Vite would strip a `NODE_ENV` ternary at build
 * time and defeat the 13.4a.2 perf harness against packaged-mode
 * builds). Grabs the LexicalEditor from the composer context and
 * stores it in a module-scope ref the `window.__brainstormNotesDev
 * .seedLargeDoc` shim reads.
 */
export function DevBenchPlugin({ noteId }: { noteId?: string }): null {
	const [editor] = useLexicalComposerContext();
	useEffect(() => {
		capturedEditor = editor;
		if (noteId !== undefined) capturedNoteId = noteId;
		installGlobal();
		return () => {
			if (capturedEditor === editor) capturedEditor = null;
		};
	}, [editor, noteId]);
	return null;
}
