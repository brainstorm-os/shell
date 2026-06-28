/**
 * Code-pane controller — owns the lifecycle of the editing surface for
 * one open `CodeFile/v1`. Glues:
 *
 *   - the `<textarea>` (caret / selection / IME / accessibility owner)
 *   - the Shiki highlight overlay (`ui/highlight-overlay.ts`)
 *   - the Y.Text binding that round-trips edits through the entities
 *     service when the shell exposes it (`logic/code-y-buffer.ts`)
 *   - the inline citation hover popover (`ui/citation-hover.ts`)
 *   - the line-number gutter
 *
 * Re-creating this controller per render would tear down the textarea
 * mid-typing (caret loss, IME state loss). `app.ts` keeps one
 * controller alive across selection changes — calling `update(row)`
 * swaps the file in place, and `dispose()` runs only when the pane
 * itself is destroyed (e.g. last file deleted).
 */

import {
	attachFindBar,
	attachFindShortcuts,
	createFindController,
} from "@brainstorm/sdk/find-replace";
import { IconName, createIconElement } from "@brainstorm/sdk/icon";
import type { ObjectMenuContext } from "@brainstorm/sdk/object-menu";
import { type ShortcutDisposer, attachShortcut } from "@brainstorm/sdk/shortcut";
import { TextSurfaceKind, spellcheckForSurface } from "@brainstorm/sdk/spellcheck";
import * as Y from "yjs";
import {
	autoCloseOnBackspace,
	autoCloseOnClose,
	autoCloseOnOpen,
	isAutoPairCloser,
	isAutoPairOpener,
} from "../logic/auto-close";
import { type CompletionItem, applyCompletion, computeCompletions } from "../logic/autocomplete";
import { matchBracket } from "../logic/brackets";
import { type CitationIndex, lookupCitation } from "../logic/citation-index";
import { scanCitations } from "../logic/citation-scan";
import type { CodeFileRow } from "../logic/code-projection";
import { fileName, gutterWidthCh } from "../logic/code-view";
import {
	type CodeBufferBinding,
	bindCodeBuffer,
	getCodeBuffer,
	seedCodeBuffer,
} from "../logic/code-y-buffer";
import { diagnosticRanges, lintCode } from "../logic/diagnostics";
import {
	type FoldRegion,
	type FoldView,
	activeFoldRegions,
	buildFoldView,
	foldableRegions,
	regionAtHeader,
	regionContaining,
	viewToDoc,
} from "../logic/folding";
import { canFormat, formatCode } from "../logic/format";
import { type GutterLine, gutterLines } from "../logic/gutter-markers";
import { tokenizeCode } from "../logic/highlight";
import { indentGuideDepths } from "../logic/indent-guides";
import { keywordsForLanguage } from "../logic/language-keywords";
import { LineChange } from "../logic/line-diff";
import {
	type BufferSelection,
	LineMoveDirection,
	deleteLines,
	duplicateLines,
	lineCommentToken,
	moveLines,
	toggleLineComment,
} from "../logic/line-ops";
import {
	type CursorRange,
	MultiEditKind,
	VerticalDirection,
	addCursorVertically,
	applyMultiCursorEdit,
	selectNextOccurrence,
} from "../logic/multi-cursor";
import {
	SYNTAX_THEME_OPTIONS,
	SyntaxThemePreference,
	resolveSyntaxTheme,
} from "../logic/syntax-theme";
import { CODE_EDITOR_CHORDS, CodeEditorAction } from "../shortcuts";
import type { LanguageKey } from "../types/code-file";
import {
	type CitationHoverHandle,
	type CitationHoverLabels,
	type CitationOpen,
	attachCitationHover,
} from "./citation-hover";
import { createCodeSearchProvider } from "./code-find";
import { type CompletionAnchor, createCompletionPopup } from "./completion-popup";
import { DiffViewMode } from "./diff-view";
import { type HighlightOverlayHandle, createHighlightOverlay } from "./highlight-overlay";

export interface CodePaneLabels {
	bufferLabel: (name: string) => string;
	pathTitle: (path: string) => string;
	menuMoreActions: (name: string) => string;
	citationHover: CitationHoverLabels;
	/** Object-menu item label when word-wrap is currently OFF (turning it on). */
	wrapEnable: string;
	/** Object-menu item label when word-wrap is currently ON (turning it off). */
	wrapDisable: string;
	/** Heading for the syntax-theme group inside the object menu. */
	syntaxThemeHeading: string;
	/** Label for a single syntax-theme choice, by its preference id. The
	 *  active choice is marked with a trailing ✓ by the menu builder. */
	syntaxThemeOption: (preference: SyntaxThemePreference) => string;
	/** Object-menu item that opens the diff view (shown only when the buffer
	 *  has unsaved changes against the baseline). */
	diffShow: string;
	/** Heading for the diff-layout group inside the object menu. */
	diffModeHeading: string;
	/** Label for a single diff-layout choice, by its mode. The active choice is
	 *  marked with a trailing ✓ by the menu builder. */
	diffModeOption: (mode: DiffViewMode) => string;
	/** Object-menu item label when format-on-save is currently OFF (9.7.8). */
	formatOnSaveEnable: string;
	/** Object-menu item label when format-on-save is currently ON. */
	formatOnSaveDisable: string;
	/** Accessible name for the autocomplete completion list (9.7.3). */
	completionListLabel: string;
}

export interface CodePaneOptions {
	row: CodeFileRow;
	citationIndex: CitationIndex;
	labels: CodePaneLabels;
	/** Build the file's object-menu context. Pulled in fresh on every
	 *  open so a re-built runtime (capability change, etc.) is picked up. */
	objectMenuContext: (row: CodeFileRow) => ObjectMenuContext;
	/** Open a citation entry — the parent wires this to the shared
	 *  `open` intent so the inline-hover and the References panel share
	 *  one path. */
	openCitation: CitationOpen;
	/** Called with the latest in-buffer content after every settled
	 *  edit. Used to refresh the dirty-dot + the meta line + the
	 *  References panel. Persistence is NOT this callback — it flows
	 *  through the Y.Doc resolver transparently. */
	onContentChange: (id: string, content: string) => void;
	/** Initial word-wrap state (persisted by the host across sessions). */
	wrap?: boolean;
	/** Called when the user toggles word-wrap, so the host can persist it. */
	onWrapChange?: (wrapped: boolean) => void;
	/** Initial syntax-theme preference (persisted by the host across
	 *  sessions). Defaults to `Auto` — follow the shell appearance. */
	syntaxTheme?: SyntaxThemePreference;
	/** Called when the user picks a syntax theme, so the host can persist it. */
	onSyntaxThemeChange?: (preference: SyntaxThemePreference) => void;
	/** Initial diff-view layout (persisted by the host). Defaults to
	 *  side-by-side. */
	diffMode?: DiffViewMode;
	/** Called when the user picks a diff layout, so the host can persist it. */
	onDiffModeChange?: (mode: DiffViewMode) => void;
	/** Initial format-on-save state (9.7.8; persisted by the host — the
	 *  host owns the save path, the pane only surfaces the menu toggle). */
	formatOnSave?: boolean;
	/** Called when the user flips the format-on-save toggle. */
	onFormatOnSaveChange?: (enabled: boolean) => void;
	/** Initial read-only lock (the file's synced `locked` property). When true
	 *  the textarea is read-only; toggle live via `setLocked`. */
	locked?: boolean;
	/** Open the diff view for the current buffer vs the saved baseline. The
	 *  host owns the overlay mount + lifecycle; the pane just supplies the
	 *  baseline + live content and the chosen layout. */
	showDiff?: (params: { baseline: string; current: string; mode: DiffViewMode }) => void;
	/** Optional Y.Doc handle from the resolver. When set, the controller
	 *  binds the textarea to the doc's `Y.Text` root and edits persist
	 *  through the resolver's transport. When omitted, the controller
	 *  falls back to a private in-memory `Y.Doc` — edits live for the
	 *  session and call `onContentChange` for the UI mirror. */
	docHandle?: {
		doc: Y.Doc;
		loaded?: Promise<void> | undefined;
		applyPending?: (() => Promise<void>) | undefined;
		release: () => void;
	};
}

export interface CodePaneController {
	/** The mounted root element (a `<section class="editor__pane">`). */
	readonly element: HTMLElement;
	/** The rich object menu for the open file (base file actions + the
	 *  editor-buffer toggles: diff layout, wrap, format-on-save, syntax
	 *  theme). Hoisted to the shell `.app-header` ⋯ — the pane no longer
	 *  draws its own header. */
	menuContext(): ObjectMenuContext;
	/** Swap the open file in place. Cheap — same textarea + overlay,
	 *  only the bindings + initial content rebind. */
	update(opts: {
		row: CodeFileRow;
		citationIndex: CitationIndex;
		docHandle?: CodePaneOptions["docHandle"];
	}): void;
	/** Toggle the read-only lock — the textarea becomes read-only (and stays
	 *  so while folded). Drives the file's synced `locked` property. */
	setLocked(locked: boolean): void;
	/** Refresh the highlight overlay + citations against the current
	 *  buffer content. Cheap (it just re-tokenises + repaints) — called
	 *  after the language or the citation index changes. */
	refresh(): void;
	/** Focus the editing surface. */
	focus(): void;
	/** Flip word-wrap; returns the new state. Also offered as an object-menu
	 *  item, but exposed for tests + any future header affordance. */
	toggleWrap(): boolean;
	/** Current word-wrap state. */
	isWrapped(): boolean;
	/** Pick a syntax-theme preference; repaints the overlay + notifies the
	 *  host so it can persist. Offered as object-menu items, exposed for
	 *  tests + any future header affordance. */
	setSyntaxTheme(preference: SyntaxThemePreference): void;
	/** Current syntax-theme preference. */
	syntaxThemePreference(): SyntaxThemePreference;
	/** Open the find/replace bar over the buffer (B9.3); also bound to
	 *  the shared find chords. */
	openFind(mode?: "find" | "find-replace"): void;
	/** Run Prettier over the buffer (9.7.8). Resolves true when the
	 *  buffer changed; false for unformattable languages / parse errors /
	 *  already-formatted content. */
	formatBuffer(): Promise<boolean>;
	/** Whether the open file's language has a formatter. */
	canFormatBuffer(): boolean;
	/** Fold the innermost region at the caret (9.7.3). */
	foldAtCaret(): void;
	/** Unfold the region at the caret. */
	unfoldAtCaret(): void;
	/** Drop every active fold. */
	unfoldAll(): void;
	/** Whether any fold is active (the buffer is read-only while folded). */
	isFolded(): boolean;
	/** Add a secondary cursor above/below the caret (9.7.3 multi-cursor /
	 *  column selection). */
	addCursorVertical(direction: VerticalDirection): void;
	/** Cmd+D — select the word at the caret, then grow one occurrence
	 *  selection per invocation. */
	selectNextOccurrenceAtCaret(): void;
	/** Count of live cursors (primary + secondaries) — for tests + the
	 *  host's affordances. */
	cursorCount(): number;
	/** Open autocomplete state (9.7.3): the shown items + the highlighted
	 *  index, or null when the popup is closed. For tests + host affordances. */
	completionState(): { items: readonly CompletionItem[]; selected: CompletionItem | null } | null;
	dispose(): void;
}

export function createCodePane(opts: CodePaneOptions): CodePaneController {
	const section = document.createElement("section");
	section.className = "editor__pane";

	const code = document.createElement("div");
	code.className = "editor__code";

	const gutter = document.createElement("div");
	gutter.className = "editor__gutter";
	gutter.setAttribute("aria-hidden", "true");

	const editArea = document.createElement("div");
	editArea.className = "editor__edit-area";

	const overlay = createHighlightOverlay();
	editArea.appendChild(overlay.element);

	const textarea = document.createElement("textarea");
	textarea.className = "editor__buffer";
	textarea.spellcheck = spellcheckForSurface(TextSurfaceKind.Code);
	textarea.autocapitalize = "off";
	textarea.setAttribute("autocomplete", "off");
	editArea.appendChild(textarea);

	// ── Autocomplete (9.7.3) ──────────────────────────────────────────────
	// The popup sits ON TOP of the textarea (appended after it) so its rows
	// are clickable; its keydown listener is registered FIRST (before the
	// multi-cursor + auto-close handlers below) so it can claim Enter / Tab /
	// arrows / Escape while open, before they act.
	const completion = createCompletionPopup({
		listLabel: opts.labels.completionListLabel,
		input: textarea,
		onAccept: (item) => acceptCompletion(item),
	});
	editArea.appendChild(completion.element);
	let completionResult: { from: number; to: number } | null = null;
	/** Set across an accept so the synthetic `input` it dispatches doesn't
	 *  immediately re-open the popup on the just-completed word. */
	let suppressAutoShow = false;

	function caretCompletionAnchor(offset: number): CompletionAnchor | null {
		const rect = overlay.caretRect(offset);
		if (!rect) return null;
		const host = editArea.getBoundingClientRect();
		return { left: rect.left - host.left, top: rect.top - host.top, bottom: rect.bottom - host.top };
	}

	function hideCompletion(): void {
		completion.hide();
		completionResult = null;
	}

	/** Recompute completions at the caret and show/hide the popup. Offered
	 *  only for an unambiguous single caret over a word prefix. */
	function maybeShowCompletions(): void {
		if (state.disposed || suppressAutoShow) return;
		if (
			state.foldView ||
			state.extraCursors.length > 0 ||
			textarea.selectionStart !== textarea.selectionEnd
		) {
			hideCompletion();
			return;
		}
		const result = computeCompletions(textarea.value, textarea.selectionStart, {
			keywords: keywordsForLanguage(state.row.language),
		});
		const anchor = result ? caretCompletionAnchor(result.from) : null;
		if (!result || !anchor) {
			hideCompletion();
			return;
		}
		completionResult = { from: result.from, to: result.to };
		completion.show(result.items, anchor);
	}

	function acceptCompletion(item: CompletionItem): void {
		if (!completionResult) return;
		const applied = applyCompletion(textarea.value, completionResult, item);
		completion.hide();
		completionResult = null;
		suppressAutoShow = true;
		applyEdit({ text: applied.text, selStart: applied.caret, selEnd: applied.caret });
		suppressAutoShow = false;
		textarea.focus();
	}

	function onCompletionKeydown(event: KeyboardEvent): void {
		// Explicit trigger (Ctrl+Space) works whether or not the popup is open.
		if (
			event.ctrlKey &&
			!event.metaKey &&
			!event.altKey &&
			(event.key === " " || event.code === "Space")
		) {
			event.preventDefault();
			event.stopImmediatePropagation();
			maybeShowCompletions();
			return;
		}
		if (!completion.isOpen || event.isComposing) return;
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				event.stopImmediatePropagation();
				completion.move(1);
				return;
			case "ArrowUp":
				event.preventDefault();
				event.stopImmediatePropagation();
				completion.move(-1);
				return;
			case "Enter":
			case "Tab": {
				const item = completion.selected();
				if (!item) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				acceptCompletion(item);
				return;
			}
			case "Escape":
				event.preventDefault();
				event.stopImmediatePropagation();
				hideCompletion();
				return;
			case "ArrowLeft":
			case "ArrowRight":
			case "Home":
			case "End":
			case "PageUp":
			case "PageDown":
				// The caret is leaving the word — dismiss, let the motion through.
				hideCompletion();
				return;
			default:
				return;
		}
	}
	textarea.addEventListener("keydown", onCompletionKeydown); // keyboard-exempt
	textarea.addEventListener("input", maybeShowCompletions);

	code.append(gutter, editArea);
	section.append(code);

	const state = {
		row: opts.row,
		citationIndex: opts.citationIndex,
		ownedDoc: null as Y.Doc | null,
		docHandle: opts.docHandle ?? null,
		binding: null as CodeBufferBinding | null,
		tokenizeSeq: 0,
		wrap: opts.wrap ?? false,
		syntaxTheme: opts.syntaxTheme ?? SyntaxThemePreference.Auto,
		diffMode: opts.diffMode ?? DiffViewMode.SideBySide,
		formatOnSave: opts.formatOnSave ?? false,
		/** Read-only lock (the file's synced `locked` property). When set the
		 *  textarea is read-only regardless of fold state. */
		locked: opts.locked ?? false,
		/** Secondary multi-cursor selections (9.7.3); the primary lives in
		 *  the textarea's own selection. */
		extraCursors: [] as CursorRange[],
		/** Folded region header lines (doc-space, 9.7.3). */
		folds: new Set<number>(),
		/** Active fold view, or null when nothing is folded. While folded
		 *  the textarea shows `foldView.text` (read-only); the doc text is
		 *  `foldDocText`. */
		foldView: null as FoldView | null,
		foldDocText: "",
		disposed: false,
	};
	code.classList.toggle("editor__code--wrap", state.wrap);

	function setWrap(next: boolean): boolean {
		if (next === state.wrap) return state.wrap;
		state.wrap = next;
		code.classList.toggle("editor__code--wrap", next);
		// Wrapping resets horizontal scroll; keep the overlay in lockstep.
		overlay.syncScroll(textarea.scrollTop, textarea.scrollLeft);
		opts.onWrapChange?.(next);
		return next;
	}

	function setSyntaxTheme(next: SyntaxThemePreference): void {
		if (next === state.syntaxTheme) return;
		state.syntaxTheme = next;
		opts.onSyntaxThemeChange?.(next);
		// Re-tokenise against the new theme so the overlay recolours in
		// place (against the view text while folded).
		if (state.binding)
			void tokenizeAndPaint(
				state.foldView ? textarea.value : state.binding.snapshot(),
				state.row.language,
			);
	}

	// The pane's own object menu adds a word-wrap toggle below the host's
	// base items (Open / Pin / …). The file-list rows use the host context
	// directly, so wrap stays a property of the open editing surface only.
	function setDiffMode(next: DiffViewMode): void {
		if (next === state.diffMode) return;
		state.diffMode = next;
		opts.onDiffModeChange?.(next);
	}

	function paneMenuContext(): ObjectMenuContext {
		const base = opts.objectMenuContext(state.row);
		if (!base) return base;
		const liveContent = state.binding?.snapshot() ?? textarea.value;
		const dirty = liveContent !== state.row.content;
		return {
			...base,
			extraItems: [
				...(base.extraItems ?? []),
				...(opts.showDiff && dirty
					? [
							{
								id: "diff-show",
								label: opts.labels.diffShow,
								icon: IconName.View,
								run: () => {
									opts.showDiff?.({
										baseline: state.row.content,
										current: state.binding?.snapshot() ?? textarea.value,
										mode: state.diffMode,
									});
								},
							},
							// Diff layout is a pick-one set → a cascade submenu (the shared
							// menu pattern), not a heading + loose rows.
							{
								id: "diff-layout",
								label: opts.labels.diffModeHeading,
								icon: IconName.Copy,
								run() {},
								submenu: DIFF_MODE_OPTIONS.map((mode) => ({
									id: `diff-mode-${mode}`,
									label:
										mode === state.diffMode
											? `${opts.labels.diffModeOption(mode)} ✓`
											: opts.labels.diffModeOption(mode),
									run: () => {
										setDiffMode(mode);
									},
								})),
							},
						]
					: []),
				{
					id: "wrap",
					label: state.wrap ? opts.labels.wrapDisable : opts.labels.wrapEnable,
					icon: IconName.KindText,
					run: () => {
						setWrap(!state.wrap);
					},
				},
				...(canFormat(state.row.language)
					? [
							{
								id: "format-on-save",
								label: state.formatOnSave
									? opts.labels.formatOnSaveDisable
									: opts.labels.formatOnSaveEnable,
								icon: IconName.Sparkle,
								run: () => {
									state.formatOnSave = !state.formatOnSave;
									opts.onFormatOnSaveChange?.(state.formatOnSave);
								},
							},
						]
					: []),
				// Syntax theme is likewise a pick-one set → its own cascade submenu.
				{
					id: "syntax-theme",
					label: opts.labels.syntaxThemeHeading,
					icon: IconName.Palette,
					run() {},
					submenu: SYNTAX_THEME_OPTIONS.map((option) => ({
						id: `syntax-theme-${option.id}`,
						label:
							option.id === state.syntaxTheme
								? `${opts.labels.syntaxThemeOption(option.id)} ✓`
								: opts.labels.syntaxThemeOption(option.id),
						run: () => {
							setSyntaxTheme(option.id);
						},
					})),
				},
			],
		};
	}

	const hover = attachCitationHover({
		host: overlay.element,
		lookup: (key) => lookupCitation(state.citationIndex, key),
		open: opts.openCitation,
		labels: opts.labels.citationHover,
	});

	function repaintCitations(content: string): void {
		const spans = scanCitations(content, state.citationIndex);
		overlay.setCitations(spans);
	}

	function repaintGuides(content: string): void {
		overlay.setIndentGuides(indentGuideDepths(content));
	}

	/** Repaint the inline diagnostic squiggles (9.7.6) for the unfolded
	 *  buffer. Offsets are doc-absolute, so this is only valid against full
	 *  content — the folded view clears them (see `repaintView`). */
	function repaintDiagnostics(content: string, language: LanguageKey): void {
		overlay.setDiagnostics(diagnosticRanges(content, lintCode(content, language)));
	}

	/** Highlight the bracket pair adjacent to the caret (9.7.3). Only a
	 *  collapsed selection matches — a range selection clears the highlight.
	 *  Reads the live textarea so it tracks the caret on move + edit. */
	function repaintBracket(): void {
		const { selectionStart, selectionEnd, value } = textarea;
		const match = selectionStart === selectionEnd ? matchBracket(value, selectionStart) : null;
		overlay.setBracketMatch(match);
	}

	async function tokenizeAndPaint(content: string, language: LanguageKey): Promise<void> {
		const seq = ++state.tokenizeSeq;
		const theme = resolveSyntaxTheme(state.syntaxTheme, prefersDarkScheme());
		const tokens = await tokenizeCode(content, language, theme);
		if (state.disposed || seq !== state.tokenizeSeq) return;
		overlay.setTokens(tokens, content);
		repaintCitations(content);
		repaintBracket();
	}

	/** Rebuild the gutter for `docContent`. While folded, only the view's
	 *  visible lines render (numbers skip the hidden span); every fold
	 *  header carries a chevron toggle (mouse path — the keyboard path is
	 *  the fold chords; the gutter stays `aria-hidden`). */
	function refreshGutter(docContent: string): void {
		const lines = gutterLines(state.row.content, docContent);
		const regions = foldableRegions(docContent);
		const headerSet = new Set(regions.map((r) => r.header));
		const visible: { line: GutterLine; docLine: number }[] = state.foldView
			? state.foldView.docLines.flatMap((docLine) => {
					const line = lines[docLine];
					return line ? [{ line, docLine }] : [];
				})
			: lines.map((line, docLine) => ({ line, docLine }));
		// border-box width = digit column + the gutter/line-no chrome that
		// would otherwise eat into it (gutter left pad + line-no inline pad on
		// both sides + the fold-chevron reserve + the inline-end border). A
		// bare `+2`ch ignored that chrome and clipped two-digit line numbers.
		gutter.style.width = `calc(${gutterWidthCh(lines.length)}ch + var(--space-4) + var(--space-2) * 2 + var(--gutter-fold-reserve) + var(--border-width))`;
		gutter.replaceChildren(
			...visible.map(({ line, docLine }) =>
				renderGutterLine(line, {
					foldable: headerSet.has(docLine),
					folded: state.folds.has(docLine),
					docLine,
				}),
			),
		);
		gutter.scrollTop = textarea.scrollTop;
	}

	function applyContent(content: string, language: LanguageKey): void {
		// While folded the textarea shows VIEW text — repaint against that
		// instead of the doc text the callers pass (citation refreshes).
		if (state.foldView) {
			repaintView();
			return;
		}
		refreshGutter(content);
		// Paint un-tokenised first so the overlay reflects content
		// immediately; Shiki tokens (async) replace this snapshot when ready.
		overlay.setTokens(null, content);
		repaintCitations(content);
		repaintGuides(content);
		repaintDiagnostics(content, language);
		repaintBracket();
		void tokenizeAndPaint(content, language);
	}

	function bindFor(row: CodeFileRow, handle: CodePaneOptions["docHandle"] | null): void {
		// A different buffer invalidates every offset-addressed surface.
		find.close();
		setExtraCursors([]);
		hideCompletion();
		dropFoldState();
		state.binding?.dispose();
		state.binding = null;
		if (state.ownedDoc) {
			state.ownedDoc.destroy();
			state.ownedDoc = null;
		}
		if (state.docHandle && state.docHandle !== handle) {
			// Releasing the previous resolver-issued handle is the caller's
			// job (they own the handle lifecycle so they can refcount across
			// multiple subscribers). We just drop our reference here.
		}
		state.docHandle = handle ?? null;
		let buffer: Y.Text;
		if (handle) {
			buffer = getCodeBuffer(handle.doc);
			// The resolver's snapshot apply is lazy — it only fires when
			// SOMEONE triggers `applyPending()`, otherwise `handle.loaded`
			// hangs forever (see `packages/react-yjs/src/resolver.ts`).
			// Notes piggy-backs on Lexical's CollaborationPlugin which
			// triggers it from inside its binding's connect path; the
			// code-editor binds a plain textarea, so we trigger it here.
			// Without this the buffer stays empty + the seed never runs +
			// the textarea + overlay render blank for a freshly-bridged
			// CodeFile row.
			const ready = handle.applyPending?.() ?? handle.loaded ?? Promise.resolve();
			void ready.then(() => {
				if (state.disposed) return;
				if (buffer.length === 0 && row.content.length > 0) {
					seedCodeBuffer(buffer, row.content);
				}
				const content = buffer.toString();
				// `seedCodeBuffer` transacts with `LOCAL_BUFFER_ORIGIN`, which
				// `bindCodeBuffer`'s observer intentionally treats as "textarea
				// is already authoritative" and skips writing back — so an
				// explicit re-sync is needed after the seed, or the textarea
				// stays empty and the first keystroke diffs against a stale
				// `lastSnapshot`, wiping the seeded content.
				if (textarea.value !== content) textarea.value = content;
				applyContent(content, row.language);
			});
		} else {
			const doc = new Y.Doc();
			state.ownedDoc = doc;
			buffer = getCodeBuffer(doc);
			if (row.content.length > 0) seedCodeBuffer(buffer, row.content);
		}
		textarea.value = buffer.toString();
		state.binding = bindCodeBuffer({
			buffer,
			textarea,
			onChange: (content) => {
				if (state.disposed) return;
				// A remote Y.Text change lands as full doc text in the
				// textarea (the binding writes it) — stale folds (shifted
				// line numbers) drop rather than misrender.
				dropFoldState();
				refreshGutter(content);
				overlay.setTokens(null, content);
				repaintCitations(content);
				repaintGuides(content);
				repaintBracket();
				void tokenizeAndPaint(content, state.row.language);
				opts.onContentChange(state.row.id, content);
			},
		});
		applyContent(buffer.toString(), row.language);
	}

	function applyRowMetadata(row: CodeFileRow): void {
		state.row = row;
		textarea.setAttribute("aria-label", opts.labels.bufferLabel(fileName(row.path)));
	}

	textarea.addEventListener("scroll", () => {
		gutter.scrollTop = textarea.scrollTop;
		overlay.syncScroll(textarea.scrollTop, textarea.scrollLeft);
		// Keep the open completion popup glued to the caret as the buffer scrolls.
		if (completion.isOpen && completionResult) {
			// Drop a popup whose range no longer fits the buffer (e.g. a remote
			// edit shrank it while the popup was open) rather than re-anchor stale.
			if (completionResult.to > textarea.value.length) hideCompletion();
			else {
				const anchor = caretCompletionAnchor(completionResult.from);
				if (anchor) completion.reposition(anchor);
				else hideCompletion();
			}
		}
	});

	// Track the caret so the bracket-match highlight (9.7.3) follows arrow-key
	// moves, clicks, and selection changes. `input` already repaints via the
	// Y.Text binding's `onChange`, so this only covers pure caret motion.
	function onCaretMove(): void {
		repaintBracket();
	}
	textarea.addEventListener("keyup", onCaretMove); // keyboard-exempt
	textarea.addEventListener("click", onCaretMove);
	textarea.addEventListener("select", onCaretMove);

	function currentSelection(): BufferSelection {
		return {
			text: textarea.value,
			selStart: textarea.selectionStart,
			selEnd: textarea.selectionEnd,
		};
	}

	function applyEdit(next: BufferSelection, editOpts?: { keepExtraCursors?: boolean }): void {
		// Every content edit invalidates the secondary cursors' offsets —
		// except the multi-cursor path itself, which re-derives them.
		if (!editOpts?.keepExtraCursors) setExtraCursors([]);
		if (
			next.text === textarea.value &&
			next.selStart === textarea.selectionStart &&
			next.selEnd === textarea.selectionEnd
		) {
			return;
		}
		textarea.value = next.text;
		textarea.setSelectionRange(next.selStart, next.selEnd);
		// Programmatic value writes don't fire `input`, so re-run the Y.Text
		// binding's input path to persist the edit + repaint overlay/gutter.
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	}

	function runLineOp(op: (current: BufferSelection) => BufferSelection): void {
		// The textarea shows VIEW text while folded — line ops would write
		// it back as doc text and lose the hidden lines. Read-only stance:
		// unfold first (the chord user gets the full buffer back).
		if (state.foldView) {
			unfoldAll();
			return;
		}
		applyEdit(op(currentSelection()));
	}

	// ── Multi-cursor + column selection (9.7.3) ───────────────────────────

	function setExtraCursors(next: CursorRange[]): void {
		if (state.extraCursors.length === 0 && next.length === 0) return;
		state.extraCursors = next;
		overlay.setExtraCursors(
			next.map((c) => ({
				from: Math.min(c.anchor, c.head),
				to: Math.max(c.anchor, c.head),
				caret: c.head,
			})),
		);
	}

	/** Primary (textarea) cursor first, secondaries after — index 0 stays
	 *  the textarea selection across every multi-cursor operation. */
	function fullCursorSet(): CursorRange[] {
		const backward = textarea.selectionDirection === "backward";
		const primary: CursorRange = backward
			? { anchor: textarea.selectionEnd, head: textarea.selectionStart }
			: { anchor: textarea.selectionStart, head: textarea.selectionEnd };
		return [primary, ...state.extraCursors];
	}

	function applyCursorSet(cursors: CursorRange[]): void {
		const primary = cursors[0];
		if (!primary) return;
		textarea.setSelectionRange(
			Math.min(primary.anchor, primary.head),
			Math.max(primary.anchor, primary.head),
			primary.head < primary.anchor ? "backward" : "forward",
		);
		setExtraCursors(cursors.slice(1));
	}

	function addCursor(direction: VerticalDirection): void {
		if (state.foldView) return;
		applyCursorSet(addCursorVertically(textarea.value, fullCursorSet(), direction));
	}

	function growOccurrenceSelection(): void {
		if (state.foldView) return;
		applyCursorSet(selectNextOccurrence(textarea.value, fullCursorSet()));
	}

	/** Intercept edit keys while secondary cursors exist and fan the edit
	 *  out to every cursor in ONE buffer write. Raw keydown (printable
	 *  input, the auto-close precedent) — registered before the
	 *  auto-close listener so a fanned-out edit wins. */
	function onMultiCursorKeydown(event: KeyboardEvent): void {
		if (state.extraCursors.length === 0) return;
		if (event.defaultPrevented || event.isComposing) return;
		const key = event.key; // keyboard-exempt
		if (key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			setExtraCursors([]);
			return;
		}
		if (event.metaKey || event.ctrlKey) return;
		let edit: { kind: MultiEditKind; text?: string } | null = null;
		if (key === "Backspace") edit = { kind: MultiEditKind.DeleteBackward };
		else if (key === "Delete") edit = { kind: MultiEditKind.DeleteForward };
		else if (key === "Enter") edit = { kind: MultiEditKind.Insert, text: "\n" };
		else if (key.length === 1 && !event.altKey) edit = { kind: MultiEditKind.Insert, text: key };
		if (!edit) {
			// Plain navigation collapses back to the primary cursor (the
			// textarea can only move ONE caret).
			if (!event.altKey && NAV_KEYS.has(key)) setExtraCursors([]);
			return;
		}
		event.preventDefault();
		const result = applyMultiCursorEdit(textarea.value, fullCursorSet(), edit);
		const primary = result.cursors[0];
		if (!primary) return;
		applyEdit(
			{ text: result.text, selStart: primary.head, selEnd: primary.head },
			{ keepExtraCursors: true },
		);
		setExtraCursors(result.cursors.slice(1));
	}
	textarea.addEventListener("keydown", onMultiCursorKeydown); // keyboard-exempt
	function onPointerCollapse(): void {
		setExtraCursors([]);
		hideCompletion();
	}
	textarea.addEventListener("mousedown", onPointerCollapse);

	// ── Code folding (9.7.3) ──────────────────────────────────────────────

	function docText(): string {
		return state.foldView ? state.foldDocText : textarea.value;
	}

	/** Repaint every surface for the current (possibly folded) view. */
	function repaintView(): void {
		const viewText = textarea.value;
		refreshGutter(docText());
		overlay.setFoldBadges(state.foldView?.foldedViewLines ?? []);
		overlay.setTokens(null, viewText);
		repaintCitations(viewText);
		repaintGuides(viewText);
		// Doc-absolute squiggle offsets don't map onto folded view text; clear
		// them while folded (they repaint on unfold via applyContent).
		overlay.setDiagnostics([]);
		repaintBracket();
		void tokenizeAndPaint(viewText, state.row.language);
	}

	/** Hard-reset the fold state WITHOUT touching the textarea — for paths
	 *  where the buffer content is being replaced wholesale (file switch,
	 *  remote Y.Text change, refresh) and the doc text is authoritative. */
	function dropFoldState(): void {
		if (!state.foldView) return;
		state.folds = new Set();
		state.foldView = null;
		state.foldDocText = "";
		textarea.readOnly = state.locked;
		overlay.setFoldBadges([]);
	}

	/** Re-apply the fold set against the current doc text. An empty set
	 *  restores the doc text into the textarea (caret mapped back). */
	function applyFolds(nextFolds: ReadonlySet<number>): void {
		const content = docText();
		const regions = foldableRegions(content);
		const active = activeFoldRegions(regions, nextFolds);
		const caretView = textarea.selectionStart;
		const previousView = state.foldView;
		if (active.length === 0) {
			state.folds = new Set();
			state.foldView = null;
			state.foldDocText = "";
			textarea.readOnly = state.locked;
			if (textarea.value !== content) {
				const caretDoc = previousView ? viewToDoc(previousView, content, caretView) : caretView;
				textarea.value = content;
				textarea.setSelectionRange(caretDoc, caretDoc);
			}
			repaintView();
			return;
		}
		const view = buildFoldView(content, active);
		state.folds = new Set(active.map((r) => r.header));
		state.foldView = view;
		state.foldDocText = content;
		setExtraCursors([]);
		// Editing a partial view would silently drop the hidden lines on
		// the next Y.Text diff — the surface is read-only while folded and
		// the first edit intent unfolds (see onFoldedEditIntent).
		textarea.readOnly = true;
		textarea.value = view.text;
		const caret = Math.min(caretView, view.text.length);
		textarea.setSelectionRange(caret, caret);
		repaintView();
	}

	function foldAtCaret(): void {
		const content = docText();
		const view = state.foldView;
		const caret = view ? viewToDoc(view, content, textarea.selectionStart) : textarea.selectionStart;
		const line = lineOfOffset(content, caret);
		const region = regionContaining(foldableRegions(content), line);
		if (!region || state.folds.has(region.header)) return;
		applyFolds(new Set([...state.folds, region.header]));
	}

	function unfoldAtCaret(): void {
		if (!state.foldView) return;
		const content = docText();
		const caret = viewToDoc(state.foldView, content, textarea.selectionStart);
		const line = lineOfOffset(content, caret);
		const regions = foldableRegions(content);
		const next = new Set(state.folds);
		const direct = regionAtHeader(regions, line);
		if (direct && next.has(direct.header)) next.delete(direct.header);
		else {
			const containing = regionContaining(regions, line);
			if (containing && next.has(containing.header)) next.delete(containing.header);
			else return;
		}
		applyFolds(next);
	}

	function unfoldAll(): void {
		if (state.folds.size === 0) return;
		applyFolds(new Set());
	}

	/** First edit intent while folded unfolds everything (caret mapped to
	 *  doc space); a printable key / Enter still lands as the first
	 *  character of the resumed editing session. */
	function onFoldedEditIntent(event: KeyboardEvent): void {
		if (!state.foldView) return;
		if (event.defaultPrevented || event.isComposing) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		const key = event.key; // keyboard-exempt
		const printable = key.length === 1;
		if (!printable && key !== "Enter" && key !== "Backspace" && key !== "Delete") return;
		event.preventDefault();
		event.stopPropagation();
		unfoldAll();
		if (printable || key === "Enter") {
			const caret = textarea.selectionStart;
			const insert = printable ? key : "\n";
			const value = textarea.value;
			applyEdit({
				text: value.slice(0, caret) + insert + value.slice(caret),
				selStart: caret + insert.length,
				selEnd: caret + insert.length,
			});
		}
	}
	textarea.addEventListener("keydown", onFoldedEditIntent); // keyboard-exempt

	function onGutterClick(event: MouseEvent): void {
		const target = event.target as HTMLElement | null;
		const headerAttr = target?.closest(`[${FOLD_HEADER_ATTR}]`)?.getAttribute(FOLD_HEADER_ATTR);
		if (headerAttr === null || headerAttr === undefined) return;
		const header = Number.parseInt(headerAttr, 10);
		if (Number.isNaN(header)) return;
		const next = new Set(state.folds);
		if (next.has(header)) next.delete(header);
		else next.add(header);
		applyFolds(next);
	}
	gutter.addEventListener("click", onGutterClick);

	// ── Find & replace (B9.3 — shared FindBar over @codemirror/search) ────

	function scrollOffsetIntoView(offset: number): void {
		const lines = textarea.value.split("\n");
		const line = lineOfOffset(textarea.value, offset);
		const lineHeight = textarea.scrollHeight / Math.max(1, lines.length);
		textarea.scrollTop = Math.max(0, line * lineHeight - textarea.clientHeight / 2);
		overlay.syncScroll(textarea.scrollTop, textarea.scrollLeft);
		gutter.scrollTop = textarea.scrollTop;
	}

	const findProvider = createCodeSearchProvider({
		getContent: () => {
			// Find operates on the full DOC text; a folded view would hide
			// matches AND misalign decorations, so searching unfolds first.
			if (state.foldView) unfoldAll();
			return textarea.value;
		},
		getSelection: () => ({ start: textarea.selectionStart, end: textarea.selectionEnd }),
		revealRange: (from, to) => {
			if (state.foldView) unfoldAll();
			// No focus steal — the user is typing in the find input; the
			// overlay's active-match decoration is the visible feedback.
			textarea.setSelectionRange(from, to);
			scrollOffsetIntoView(from);
		},
		replaceRange: (from, to, replacement) => {
			if (state.foldView) unfoldAll();
			const value = textarea.value;
			const caret = from + replacement.length;
			applyEdit({
				text: value.slice(0, from) + replacement + value.slice(to),
				selStart: caret,
				selEnd: caret,
			});
		},
		setContent: (content) => {
			if (state.foldView) unfoldAll();
			const caret = Math.min(textarea.selectionStart, content.length);
			applyEdit({ text: content, selStart: caret, selEnd: caret });
		},
		setMatches: (matches, active) => overlay.setFindMatches(matches, active),
	});
	const find = createFindController(findProvider, { persist: { key: "code-editor:find" } });
	const detachFindBar = attachFindBar(section, find, { mode: "find-replace" });
	const detachFindShortcuts = attachFindShortcuts(window, find);
	const unsubscribeFind = find.subscribe(() => {
		if (!find.getState().open) findProvider.clear();
	});

	// ── Formatter (9.7.8) ────────────────────────────────────────────────

	let formatSeq = 0;
	async function formatBuffer(): Promise<boolean> {
		if (state.foldView) unfoldAll();
		if (!canFormat(state.row.language)) return false;
		const content = textarea.value;
		const seq = ++formatSeq;
		const result = await formatCode(content, state.row.language, textarea.selectionStart);
		// Stale guards: pane disposed, a newer format started, or the user
		// kept typing while Prettier ran — never clobber newer content.
		if (!result || state.disposed || seq !== formatSeq) return false;
		if (textarea.value !== content || result.formatted === content) return false;
		applyEdit({
			text: result.formatted,
			selStart: result.cursorOffset,
			selEnd: result.cursorOffset,
		});
		return true;
	}

	// Auto-close bracket/quote pairs. These intercept printable input (not
	// command chords), so they bind a raw keydown rather than the shortcut
	// registry — `attachShortcut` deliberately suppresses single keys inside
	// editable fields, which is exactly where this behaviour must fire.
	function onAutoCloseKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing) return;
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const key = event.key; // keyboard-exempt
		let next: BufferSelection | null = null;
		if (key === "Backspace") {
			next = autoCloseOnBackspace(currentSelection());
		} else if (isAutoPairOpener(key)) {
			// Quotes are both opener and closer — prefer typing over an
			// adjacent matching quote, else open a fresh pair.
			const selection = currentSelection();
			next = autoCloseOnClose(selection, key) ?? autoCloseOnOpen(selection, key);
		} else if (isAutoPairCloser(key)) {
			next = autoCloseOnClose(currentSelection(), key);
		}
		if (!next) return;
		event.preventDefault();
		applyEdit(next);
	}
	textarea.addEventListener("keydown", onAutoCloseKeydown); // keyboard-exempt

	// Buffer-scoped line ops. Bound to the textarea (not the window) so the
	// move/duplicate chords claim Alt+Arrow only while the caret is in the
	// buffer; `attachShortcut` stops propagation, leaving the window-level
	// file-nav binding to handle Alt+Arrow when focus is on the file list.
	const lineOpDisposers: ShortcutDisposer[] = [
		attachShortcut(textarea, CODE_EDITOR_CHORDS[CodeEditorAction.MoveLineUp], () =>
			runLineOp((s) => moveLines(s, LineMoveDirection.Up)),
		),
		attachShortcut(textarea, CODE_EDITOR_CHORDS[CodeEditorAction.MoveLineDown], () =>
			runLineOp((s) => moveLines(s, LineMoveDirection.Down)),
		),
		attachShortcut(textarea, CODE_EDITOR_CHORDS[CodeEditorAction.DuplicateLineUp], () =>
			runLineOp((s) => duplicateLines(s, LineMoveDirection.Up)),
		),
		attachShortcut(textarea, CODE_EDITOR_CHORDS[CodeEditorAction.DuplicateLineDown], () =>
			runLineOp((s) => duplicateLines(s, LineMoveDirection.Down)),
		),
		attachShortcut(textarea, CODE_EDITOR_CHORDS[CodeEditorAction.DeleteLine], () =>
			runLineOp(deleteLines),
		),
		attachShortcut(textarea, CODE_EDITOR_CHORDS[CodeEditorAction.ToggleComment], () =>
			runLineOp((s) => toggleLineComment(s, lineCommentToken(state.row.language))),
		),
		// Multi-cursor / column selection (9.7.3).
		attachShortcut(textarea, CODE_EDITOR_CHORDS[CodeEditorAction.AddCursorAbove], () =>
			addCursor(VerticalDirection.Up),
		),
		attachShortcut(textarea, CODE_EDITOR_CHORDS[CodeEditorAction.AddCursorBelow], () =>
			addCursor(VerticalDirection.Down),
		),
		attachShortcut(textarea, CODE_EDITOR_CHORDS[CodeEditorAction.SelectNextOccurrence], () =>
			growOccurrenceSelection(),
		),
		// Code folding (9.7.3).
		attachShortcut(textarea, CODE_EDITOR_CHORDS[CodeEditorAction.FoldAtCaret], () => foldAtCaret()),
		attachShortcut(textarea, CODE_EDITOR_CHORDS[CodeEditorAction.UnfoldAtCaret], () =>
			unfoldAtCaret(),
		),
		attachShortcut(textarea, CODE_EDITOR_CHORDS[CodeEditorAction.UnfoldAll], () => unfoldAll()),
	];

	applyRowMetadata(opts.row);
	bindFor(opts.row, opts.docHandle ?? null);

	return {
		element: section,
		menuContext: () => paneMenuContext(),
		update(next) {
			if (next.row.id === state.row.id && state.docHandle?.doc === next.docHandle?.doc) {
				state.citationIndex = next.citationIndex;
				applyRowMetadata(next.row);
				applyContent(state.binding?.snapshot() ?? "", next.row.language);
				return;
			}
			state.citationIndex = next.citationIndex;
			applyRowMetadata(next.row);
			bindFor(next.row, next.docHandle ?? null);
		},
		refresh() {
			if (!state.binding) return;
			// A refresh repaints from the DOC snapshot — restore the full
			// text first so the textarea and overlay stay aligned.
			if (state.foldView) applyFolds(new Set());
			applyContent(state.binding.snapshot(), state.row.language);
		},
		setLocked(locked) {
			state.locked = locked;
			// Folded views are always read-only; otherwise mirror the lock.
			textarea.readOnly = locked || state.foldView !== null;
		},
		focus() {
			textarea.focus();
		},
		toggleWrap() {
			return setWrap(!state.wrap);
		},
		isWrapped() {
			return state.wrap;
		},
		setSyntaxTheme(preference) {
			setSyntaxTheme(preference);
		},
		syntaxThemePreference() {
			return state.syntaxTheme;
		},
		openFind(mode) {
			find.open(mode ?? "find");
		},
		formatBuffer() {
			return formatBuffer();
		},
		canFormatBuffer() {
			return canFormat(state.row.language);
		},
		foldAtCaret() {
			foldAtCaret();
		},
		unfoldAtCaret() {
			unfoldAtCaret();
		},
		unfoldAll() {
			unfoldAll();
		},
		isFolded() {
			return state.foldView !== null;
		},
		addCursorVertical(direction) {
			addCursor(direction);
		},
		selectNextOccurrenceAtCaret() {
			growOccurrenceSelection();
		},
		cursorCount() {
			return 1 + state.extraCursors.length;
		},
		completionState() {
			return completion.isOpen ? { items: completion.items, selected: completion.selected() } : null;
		},
		dispose() {
			if (state.disposed) return;
			state.disposed = true;
			unsubscribeFind();
			find.close();
			detachFindBar();
			detachFindShortcuts();
			for (const dispose of lineOpDisposers) dispose();
			textarea.removeEventListener("keydown", onAutoCloseKeydown);
			textarea.removeEventListener("keydown", onCompletionKeydown);
			textarea.removeEventListener("input", maybeShowCompletions);
			textarea.removeEventListener("keydown", onMultiCursorKeydown);
			textarea.removeEventListener("keydown", onFoldedEditIntent);
			textarea.removeEventListener("mousedown", onPointerCollapse);
			textarea.removeEventListener("keyup", onCaretMove);
			textarea.removeEventListener("click", onCaretMove);
			textarea.removeEventListener("select", onCaretMove);
			gutter.removeEventListener("click", onGutterClick);
			hover.dispose();
			completion.dispose();
			state.binding?.dispose();
			state.binding = null;
			overlay.dispose();
			if (state.ownedDoc) {
				state.ownedDoc.destroy();
				state.ownedDoc = null;
			}
			section.remove();
		},
	};
}

/** Diff-layout choices offered in the object menu, in display order. */
const DIFF_MODE_OPTIONS: readonly DiffViewMode[] = [DiffViewMode.SideBySide, DiffViewMode.Unified];

/** Plain navigation keys that collapse a multi-cursor set back to the
 *  primary (the textarea can only physically move one caret). */
const NAV_KEYS: ReadonlySet<string> = new Set([
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"PageUp",
	"PageDown",
]);

/** 0-based line containing `offset` in `text`. */
function lineOfOffset(text: string, offset: number): number {
	let line = 0;
	const max = Math.min(offset, text.length);
	for (let i = 0; i < max; i++) {
		if (text.charCodeAt(i) === 10) line++;
	}
	return line;
}

/** Diff-marker modifier class per change status. `Unchanged` carries no
 *  modifier so a clean file's gutter is unadorned. The markers paint against
 *  the last-saved baseline (9.7.7). */
const GUTTER_CHANGE_CLASS: Readonly<Record<LineChange, string | null>> = Object.freeze({
	[LineChange.Unchanged]: null,
	[LineChange.Added]: "editor__line-no--added",
	[LineChange.Modified]: "editor__line-no--modified",
	[LineChange.DeletedBefore]: "editor__line-no--deleted",
});

interface GutterFoldInfo {
	foldable: boolean;
	folded: boolean;
	docLine: number;
}

/** Attribute carrying the 0-based doc line of a fold chevron; the gutter
 *  click delegation reads it back to toggle the region. */
export const FOLD_HEADER_ATTR = "data-fold-header";

/** One gutter row: the line number plus a change-marker modifier, plus a
 *  fold chevron on region headers (9.7.3). Kept as a per-line element
 *  (not a single text node) so each line can carry its own decorations
 *  without disturbing the others. */
function renderGutterLine(line: GutterLine, fold?: GutterFoldInfo): HTMLElement {
	const el = document.createElement("div");
	el.className = "editor__line-no";
	const modifier = GUTTER_CHANGE_CLASS[line.change];
	if (modifier) el.classList.add(modifier);
	el.textContent = String(line.number);
	if (fold?.foldable) {
		const chevron = document.createElement("span");
		chevron.className = fold.folded
			? "editor__fold-chevron editor__fold-chevron--folded"
			: "editor__fold-chevron";
		chevron.setAttribute(FOLD_HEADER_ATTR, String(fold.docLine));
		chevron.appendChild(
			createIconElement(fold.folded ? IconName.CaretRight : IconName.CaretDown, { size: 12 }),
		);
		el.appendChild(chevron);
	}
	return el;
}

/**
 * Whether the renderer is currently in dark mode. The shell theme is the
 * source of truth — we read `prefers-color-scheme` here because the shell's
 * `color-scheme: light dark` declaration is what the renderer honours. The
 * `Auto` syntax-theme preference resolves through this.
 */
export function prefersDarkScheme(): boolean {
	if (typeof window === "undefined" || !window.matchMedia) return false;
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
