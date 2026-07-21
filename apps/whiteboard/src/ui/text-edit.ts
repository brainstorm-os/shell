/**
 * Inline node-text editor mechanics (extracted from `app.ts` for F-199;
 * rich-run formatting added for 9.17.12 rest).
 *
 * Turns a node's body element into a focused `contentEditable`, then
 * resolves exactly once: commit on blur or the commit-edit chord, cancel
 * on the cancel-edit chord. The previous in-app version leaked its chord
 * bindings on the blur-commit path (only the chord paths unbound); here
 * every exit path runs the same teardown, so a board that has seen many
 * edits never accumulates dead keydown listeners.
 *
 * The editor body is always seeded from rich runs (`rich` when present,
 * else the plain `text` as a single run) via the `rich-dom` bridge, and
 * commits read the DOM back into runs — so formatting survives typing in
 * the middle of a styled span. Formatting commands (the returned handle +
 * the body-scoped chords) re-read the DOM, transform the run model with
 * the pure `logic/rich-text` helpers, rebuild the span tree and restore
 * the selection; a collapsed/absent selection formats the whole body.
 *
 * Pure DOM + the app shortcut layer — jsdom-testable without the canvas.
 */

import { TextSurfaceKind, spellcheckForSurface } from "@brainstorm-os/sdk/spellcheck";
import {
	type SelectionStyles,
	plainToRich,
	richTextLength,
	richToPlain,
	setColorInRange,
	setSizeInRange,
	stylesInRange,
	toPersistedRich,
	toggleMarkInRange,
} from "../logic/rich-text";
import { appendRunsTo, domRangeOffsets, readRunsFromDom, selectOffsets } from "../render/rich-dom";
import { ActionId, bindShortcut } from "../shortcuts";
import type { TextColor, TextSize } from "../types/node";
import { RichMark, type RichRun } from "../types/rich-text";

const PLACEHOLDER_CLASS = "whiteboard__node-body--placeholder";
const EDITING_CLASS = "whiteboard__node-body--editing";

export type InlineTextEditOptions = {
	/** The node's current model text (the editor's starting content). */
	text: string;
	/** The node's rich runs; absent/undefined seeds from `text` alone. */
	rich?: readonly RichRun[] | undefined;
	/** Accessible name for the textbox. */
	ariaLabel: string;
	/** Fires once with the edited text + the persisted-form runs (`null`
	 *  when nothing is styled — the caller drops the `rich` field). */
	onCommit(next: string, rich: RichRun[] | null): void;
	/** Fires once when the edit is abandoned (cancel chord). */
	onCancel(): void;
	/** Fires whenever the selection's covering styles change — drives the
	 *  formatting toolbar's pressed reflection. */
	onFormatState?(styles: SelectionStyles): void;
};

export type InlineTextEditHandle = {
	/** Force-commit (used if the caller must close the editor programmatically). */
	commit(): void;
	/** Toggle a boolean mark over the selection (whole body when collapsed). */
	toggleMark(mark: RichMark): void;
	/** Set / clear (`null`) the per-run colour over the selection. */
	setColor(color: TextColor | null): void;
	/** Set / clear (`null`) the per-run size over the selection. */
	setSize(size: TextSize | null): void;
	/** The styles covering the whole current selection. */
	selectionStyles(): SelectionStyles;
};

/** Start an inline edit on `body`. Returns the formatting/commit handle. */
export function beginInlineTextEdit(
	body: HTMLElement,
	options: InlineTextEditOptions,
): InlineTextEditHandle {
	body.classList.remove(PLACEHOLDER_CLASS);
	const seed = options.rich && options.rich.length > 0 ? options.rich : plainToRich(options.text);
	appendRunsTo(body, seed);
	// The attribute, not the property: browsers reflect either into both, but
	// jsdom implements only the attribute — and the attribute is what the
	// shortcut layer's typing-target check (and this module's own teardown)
	// reads. Keeps the chord protection observable headless (F-213).
	body.setAttribute("contenteditable", "true");
	body.setAttribute("role", "textbox");
	body.setAttribute("aria-label", options.ariaLabel);
	// B11.16b — sticky/shape text is prose; opt the editor into spellcheck.
	body.spellcheck = spellcheckForSurface(TextSurfaceKind.Prose);
	body.classList.add(EDITING_CLASS);
	// Explicit tabindex: browsers make contentEditable focusable implicitly,
	// jsdom does not — without it the headless engine suite can't prove the
	// editor owns the keyboard the instant the spawn handler returns (the
	// F-213 head-loss contract: focus is SYNCHRONOUS, same task as spawn).
	body.tabIndex = 0;
	body.focus();
	selectAllIn(body);

	const doc = body.ownerDocument;
	const emitFormatState = (): void => {
		if (!options.onFormatState) return;
		options.onFormatState(selectionStyles());
	};
	const onSelectionChange = (): void => emitFormatState();
	doc.addEventListener("selectionchange", onSelectionChange);

	let done = false;
	const teardown = (): void => {
		body.removeEventListener("blur", onBlur);
		doc.removeEventListener("selectionchange", onSelectionChange);
		offCommit();
		offCancel();
		for (const off of formatUnbinders) off();
		// Strip the editor chrome too. The engine repaints after commit/cancel,
		// but `paintNodes` PRESERVES the element whose body carries the editing
		// class — leaving the chrome on would keep a listener-less, still-
		// contentEditable zombie alive across every repaint.
		body.classList.remove(EDITING_CLASS);
		body.removeAttribute("contenteditable");
		body.removeAttribute("role");
		body.removeAttribute("aria-label");
		body.removeAttribute("tabindex");
	};
	const commit = (): void => {
		if (done) return;
		done = true;
		const runs = readRunsFromDom(body);
		teardown();
		options.onCommit(richToPlain(runs), toPersistedRich(runs));
	};
	const cancel = (): void => {
		if (done) return;
		done = true;
		teardown();
		options.onCancel();
	};

	/** Selection as offsets; collapsed/outside selections format the whole
	 *  body (the node-level convention the Style ▾ menu set). */
	function effectiveRange(runs: readonly RichRun[]): { start: number; end: number } {
		const sel = domRangeOffsets(body);
		if (sel && sel.start !== sel.end) return sel;
		return { start: 0, end: richTextLength(runs) };
	}

	function applyTransform(fn: (runs: RichRun[], start: number, end: number) => RichRun[]): void {
		if (done) return;
		const runs = readRunsFromDom(body);
		const range = effectiveRange(runs);
		if (range.start === range.end) return;
		const next = fn(runs, range.start, range.end);
		appendRunsTo(body, next);
		body.focus();
		selectOffsets(body, range.start, range.end);
		emitFormatState();
	}

	function selectionStyles(): SelectionStyles {
		const runs = readRunsFromDom(body);
		const range = effectiveRange(runs);
		return stylesInRange(runs, range.start, range.end);
	}

	const toggleMark = (mark: RichMark): void =>
		applyTransform((runs, start, end) => toggleMarkInRange(runs, start, end, mark));

	// Deferred: a paint()'s `replaceChildren` detaching the focused editor
	// fires this blur synchronously MID-removal — committing (and repainting)
	// inside that window throws "node to be removed is no longer a child".
	// A microtask lets the outer DOM mutation finish first; the text is
	// captured from the (possibly detached) node, which is still readable.
	const onBlur = (): void => queueMicrotask(commit);
	body.addEventListener("blur", onBlur);
	const offCommit = bindShortcut(
		ActionId.CommitEdit,
		(e) => {
			e.preventDefault();
			commit();
		},
		{ target: body, allowInTyping: true },
	);
	const offCancel = bindShortcut(
		ActionId.CancelEdit,
		(e) => {
			e.preventDefault();
			cancel();
		},
		{ target: body, allowInTyping: true },
	);
	const FORMAT_CHORDS: ReadonlyArray<readonly [ActionId, RichMark]> = [
		[ActionId.ToggleBold, RichMark.Bold],
		[ActionId.ToggleItalic, RichMark.Italic],
		[ActionId.ToggleUnderline, RichMark.Underline],
		[ActionId.ToggleStrike, RichMark.Strike],
	];
	const formatUnbinders = FORMAT_CHORDS.map(([id, mark]) =>
		bindShortcut(
			id,
			(e) => {
				e.preventDefault();
				toggleMark(mark);
			},
			{ target: body, allowInTyping: true },
		),
	);

	return {
		commit,
		toggleMark,
		setColor: (color) =>
			applyTransform((runs, start, end) => setColorInRange(runs, start, end, color)),
		setSize: (size) => applyTransform((runs, start, end) => setSizeInRange(runs, start, end, size)),
		selectionStyles,
	};
}

/** Select the editor's whole content so typing replaces it (the
 *  double-click-to-edit convention). Guarded — a selection API gap in a
 *  headless env must never abort the edit itself. */
function selectAllIn(body: HTMLElement): void {
	try {
		const range = document.createRange();
		range.selectNodeContents(body);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
	} catch {
		// Selection is a nicety; the editor is already focused.
	}
}
