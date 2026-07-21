/**
 * Y.Text ↔ textarea bidirectional binding (9.7.2).
 *
 * The code buffer's source of truth is a `Y.Text` named `"content"`
 * inside the entity's Y.Doc — a deliberately separate root from the
 * universal `Y.XmlText` body Notes uses, because code is plain text
 * (preserved indentation, no inline formatting nodes). Editing a code
 * file via this binding round-trips through the same
 * `services.entities.loadDoc / applyDoc / closeDoc` transport every
 * other Yjs-bound app uses; the entity property bag's `content` field
 * becomes a denormalised projection (rebuilt from the Y.Text by the
 * shell migration that follows 9.7.2). Until that migration lands the
 * binding still works end-to-end inside one renderer session: edits
 * persist into the doc, the doc replicates across windows, and the
 * highlight overlay updates from the same `Y.Text` change signal.
 *
 * Why direct Y.Text and not `<BrainstormEditor>` (Notes' Lexical
 * surface)? Lexical's RichText plugin is paragraph-based — it wraps,
 * normalises whitespace, and inserts paragraph nodes per line. That's
 * the OPPOSITE semantics of code, where indentation and trailing
 * spaces are load-bearing. The Yjs collaboration model is the same;
 * only the surface differs. The shared keystone (the resolver,
 * loadDoc/applyDoc transport, refcounting) carries straight through —
 * see `apps/journal/src/store/ydoc-resolver.ts` for the canonical
 * resolver shape this code reuses.
 *
 * Echo handling: a remote update arrives via the resolver and applies
 * with `REMOTE_ORIGIN`. We listen on the `Y.Text` change event and
 * update the textarea only when our cached snapshot differs (cheap
 * string equality — same-value commits hit the no-op early-return).
 * Local typing fires a `transact(…, LOCAL_ORIGIN)` whose update DOES
 * go through the resolver -> `entities.applyDoc` (since the resolver's
 * `onUpdate` is what writes back), but the textarea is already
 * up-to-date, so the change observer's diff is empty.
 */

import * as Y from "yjs";

/** Stable name for the code-buffer root inside the entity's Y.Doc.
 *  Disjoint from `UNIVERSAL_BODY_FRAGMENT_NAME` (`"root"`) — Notes /
 *  Journal use `Y.XmlText` for rich text; code files use `Y.Text` for
 *  raw source. Yjs's per-name type guard makes a collision a hard
 *  error at `doc.get(name, Type)`, which is the protection we want. */
export const CODE_BUFFER_ROOT = "content";

/** Origin tag for transactions originating in the textarea binding.
 *  Used so a future server-driven update path can tell local edits
 *  from canonical broadcasts. Disjoint from `REMOTE_ORIGIN` in
 *  `@brainstorm-os/react-yjs/resolver`. */
export const LOCAL_BUFFER_ORIGIN = Symbol("code-editor.local");

export function getCodeBuffer(doc: Y.Doc): Y.Text {
	return doc.get(CODE_BUFFER_ROOT, Y.Text);
}

/**
 * Seed a Y.Text from a string snapshot. Idempotent: a no-op if the
 * Y.Text already contains the exact same content. Used to migrate the
 * property-bag `content` into the Y.Doc on first edit (the legacy
 * read path keeps working until the shell-side migration lands).
 */
export function seedCodeBuffer(buffer: Y.Text, initial: string): void {
	if (buffer.toString() === initial) return;
	const doc = buffer.doc;
	const apply = () => {
		buffer.delete(0, buffer.length);
		if (initial.length > 0) buffer.insert(0, initial);
	};
	if (doc) doc.transact(apply, LOCAL_BUFFER_ORIGIN);
	else apply();
}

export interface CodeBufferBindingOptions {
	buffer: Y.Text;
	textarea: HTMLTextAreaElement;
	/** Called after a remote OR local change settles, with the latest
	 *  buffer text. The owner uses this to repaint the highlight overlay
	 *  + gutter; it's NOT a persistence hook (Yjs persistence flows
	 *  through the resolver). */
	onChange: (content: string) => void;
}

export interface CodeBufferBinding {
	dispose(): void;
	/** Snapshot the current Y.Text content. */
	snapshot(): string;
}

/**
 * Bind a Y.Text bidirectionally to a textarea. Local edits go through
 * a single `replaceRange` Y.Text mutation (computed from the textarea
 * diff between events) so a remote peer sees one minimal patch per
 * keystroke instead of a full delete+insert. Remote updates apply to
 * the textarea while preserving the local caret position to the
 * extent possible (caret offset clamps to the new content length).
 */
export function bindCodeBuffer(opts: CodeBufferBindingOptions): CodeBufferBinding {
	const { buffer, textarea, onChange } = opts;
	let lastSnapshot = buffer.toString();
	if (textarea.value !== lastSnapshot) textarea.value = lastSnapshot;

	const onYChange = (_event: Y.YTextEvent, transaction: Y.Transaction): void => {
		if (transaction.origin === LOCAL_BUFFER_ORIGIN) {
			// Our own write — the textarea is already authoritative; the
			// input handler has already called `onChange`. Refresh the
			// cached snapshot so the next diff is correct.
			lastSnapshot = buffer.toString();
			return;
		}
		const next = buffer.toString();
		if (next === textarea.value) {
			lastSnapshot = next;
			return;
		}
		const caret = textarea.selectionStart;
		const selectionEnd = textarea.selectionEnd;
		textarea.value = next;
		lastSnapshot = next;
		const clampStart = Math.min(caret, next.length);
		const clampEnd = Math.min(selectionEnd, next.length);
		try {
			textarea.setSelectionRange(clampStart, clampEnd);
		} catch {
			// Detached / hidden textarea — silent (we'll re-sync on next focus).
		}
		onChange(next);
	};
	buffer.observe(onYChange);

	const onInput = (): void => {
		const next = textarea.value;
		if (next === lastSnapshot) return;
		const diff = diffStrings(lastSnapshot, next);
		const doc = buffer.doc;
		const apply = () => {
			if (diff.removed > 0) buffer.delete(diff.start, diff.removed);
			if (diff.added.length > 0) buffer.insert(diff.start, diff.added);
		};
		if (doc) doc.transact(apply, LOCAL_BUFFER_ORIGIN);
		else apply();
		lastSnapshot = next;
		onChange(next);
	};
	textarea.addEventListener("input", onInput);

	return {
		dispose() {
			buffer.unobserve(onYChange);
			textarea.removeEventListener("input", onInput);
		},
		snapshot() {
			return lastSnapshot;
		},
	};
}

interface StringDiff {
	start: number;
	removed: number;
	added: string;
}

/**
 * Minimal single-range diff between two strings — sufficient for
 * keystroke-level diffs in a textarea (a paste or selection-replace is
 * also a single contiguous range). Pure / exported for tests.
 */
export function diffStrings(prev: string, next: string): StringDiff {
	const prevLen = prev.length;
	const nextLen = next.length;
	if (prev === next) return { start: 0, removed: 0, added: "" };
	let start = 0;
	const maxStart = Math.min(prevLen, nextLen);
	while (start < maxStart && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
	let prevEnd = prevLen;
	let nextEnd = nextLen;
	while (
		prevEnd > start &&
		nextEnd > start &&
		prev.charCodeAt(prevEnd - 1) === next.charCodeAt(nextEnd - 1)
	) {
		prevEnd--;
		nextEnd--;
	}
	return {
		start,
		removed: prevEnd - start,
		added: next.slice(start, nextEnd),
	};
}
