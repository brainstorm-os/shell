/**
 * @vitest-environment jsdom
 *
 * Regression: `CodePane` must hydrate the textarea + overlay from
 * `row.content` even when the resolver hands back a Y.Doc handle whose
 * snapshot apply is deferred (the normal resolver shape — `loaded` only
 * resolves once SOMEONE triggers `applyPending()`; the Notes editor does
 * this from inside `@lexical/yjs`'s LocalProvider.connect, but the
 * code-editor binds a plain textarea so it must trigger it itself).
 *
 * Bug this guards: on a freshly-bridged `CodeFile/v1` row both surfaces
 * rendered blank — `handle.loaded` hung forever, the seeded `row.content`
 * never reached the buffer, the overlay painted an empty placeholder,
 * and the first keystroke would diff against a stale empty `lastSnapshot`
 * and wipe the seeded content.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CitationKind } from "../logic/citation-index";
import type { CodeFileRow } from "../logic/code-projection";
import { getCodeBuffer } from "../logic/code-y-buffer";
import { SyntaxThemePreference } from "../logic/syntax-theme";
import { LanguageKey } from "../types/code-file";
import { createCodePane, prefersDarkScheme } from "./code-pane";
import type { DiffViewMode } from "./diff-view";

const NOOP_LABELS = {
	bufferLabel: (n: string) => n,
	pathTitle: (p: string) => p,
	menuMoreActions: (n: string) => n,
	citationHover: { heading: () => "", close: "close", openAction: "open" },
	wrapEnable: "Enable line wrap",
	wrapDisable: "Disable line wrap",
	syntaxThemeHeading: "Syntax theme",
	syntaxThemeOption: (p: SyntaxThemePreference) => p,
	diffShow: "Show changes since save",
	diffModeHeading: "Diff layout",
	diffModeOption: (m: DiffViewMode) => m,
	formatOnSaveEnable: "Enable format on save",
	formatOnSaveDisable: "Disable format on save",
	completionListLabel: "Completions",
};

/** A resolver-shaped handle whose deferred snapshot apply resolves the
 *  moment the pane triggers `applyPending` (the real resolver contract). */
function eagerHandle(doc: Y.Doc) {
	let triggerLoad: () => void = () => {};
	const loaded = new Promise<void>((res) => {
		triggerLoad = res;
	});
	return {
		doc,
		loaded,
		applyPending: () => {
			triggerLoad();
			return loaded;
		},
		release: () => {},
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function makeRow(content: string): CodeFileRow {
	return {
		id: "code-1",
		path: "demo.ts",
		language: LanguageKey.TypeScript,
		content,
		contentKey: "content",
		icon: null,
		sizeBytes: null,
		lineCount: null,
		isDirty: false,
		locked: false,
		lastOpenedAt: null,
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("createCodePane", () => {
	it("seeds the textarea + overlay from row.content via applyPending → loaded", async () => {
		const doc = new Y.Doc();
		// Mirror the real resolver: `loaded` only resolves once
		// `applyPending` is called. If the pane never triggers it, the
		// gate sits open forever and the seed never runs.
		let triggerLoad: () => void = () => {};
		const loaded = new Promise<void>((res) => {
			triggerLoad = res;
		});
		let applyCalls = 0;
		const handle = {
			doc,
			loaded,
			applyPending: () => {
				applyCalls += 1;
				triggerLoad();
				return loaded;
			},
			release: () => {},
		};

		const pane = createCodePane({
			row: makeRow("const x: number = 1;\n"),
			citationIndex: new Map(),
			labels: NOOP_LABELS,
			// `null` makes the SDK trigger inert; this test only asserts the
			// textarea+overlay hydration, never opens the menu.
			objectMenuContext: () => null,
			openCitation: () => {},
			onContentChange: () => {},
			docHandle: handle,
		});

		// Mount so getBoundingClientRect-driven paths don't trip over a
		// detached node; not strictly required for the textarea+overlay
		// strings we assert.
		document.body.appendChild(pane.element);

		// Yield twice: once for the `applyPending().then(...)` microtask,
		// once for the synchronous repaint inside it.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(applyCalls, "pane must trigger applyPending so loaded resolves").toBeGreaterThan(0);

		const textarea = pane.element.querySelector(".editor__buffer") as HTMLTextAreaElement;
		const overlay = pane.element.querySelector(".editor__highlight") as HTMLElement;

		expect(textarea.value, "textarea must reflect seeded content post-load").toBe(
			"const x: number = 1;\n",
		);
		// Overlay paints the seeded content (plain first; Shiki tokenize
		// is async but we assert the un-tokenised fallback render here).
		// `innerText` isn't implemented in jsdom — `textContent` is the
		// right primitive for this assertion.
		expect(overlay.textContent ?? "").toContain("const x: number = 1;");
		expect(overlay.dataset.empty).toBe("false");

		pane.dispose();
	});

	it("stamps indent guides on the overlay for indented seeded content", async () => {
		const doc = new Y.Doc();
		const pane = createCodePane({
			row: makeRow("a\n  b\n    c\n"),
			citationIndex: new Map(),
			labels: NOOP_LABELS,
			objectMenuContext: () => null,
			openCitation: () => {},
			onContentChange: () => {},
			docHandle: eagerHandle(doc),
		});
		document.body.appendChild(pane.element);
		await flushMicrotasks();

		const lines = pane.element.querySelectorAll(".editor__highlight-line");
		expect(lines[0]?.querySelectorAll(".editor__indent-guide")).toHaveLength(0);
		expect(lines[1]?.querySelectorAll(".editor__indent-guide")).toHaveLength(1);
		expect(lines[2]?.querySelectorAll(".editor__indent-guide")).toHaveLength(2);

		pane.dispose();
	});

	it("highlights the matched bracket pair adjacent to the caret", async () => {
		const doc = new Y.Doc();
		const pane = createCodePane({
			row: makeRow("fn(x)\n"),
			citationIndex: new Map(),
			labels: NOOP_LABELS,
			objectMenuContext: () => null,
			openCitation: () => {},
			onContentChange: () => {},
			docHandle: eagerHandle(doc),
		});
		document.body.appendChild(pane.element);
		await flushMicrotasks();

		const textarea = pane.element.querySelector(".editor__buffer") as HTMLTextAreaElement;
		textarea.focus();
		// Caret right after "(" (offset 3) → matches the pair at 2 and 4.
		textarea.setSelectionRange(3, 3);
		textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
		expect(pane.element.querySelectorAll(".editor__bracket-match")).toHaveLength(2);

		// Move the caret away from any bracket → highlight clears.
		textarea.setSelectionRange(0, 0);
		textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "Home", bubbles: true }));
		expect(pane.element.querySelectorAll(".editor__bracket-match")).toHaveLength(0);

		pane.dispose();
	});

	it("runs a line op from its chord and round-trips through the Y.Text buffer", async () => {
		const doc = new Y.Doc();
		const pane = createCodePane({
			row: makeRow("a\nb\nc\n"),
			citationIndex: new Map(),
			labels: NOOP_LABELS,
			objectMenuContext: () => null,
			openCitation: () => {},
			onContentChange: () => {},
			docHandle: eagerHandle(doc),
		});
		document.body.appendChild(pane.element);
		await flushMicrotasks();

		const textarea = pane.element.querySelector(".editor__buffer") as HTMLTextAreaElement;
		textarea.focus();
		textarea.setSelectionRange(0, 0); // caret on line "a"

		// Alt+ArrowDown = move line down (platform-independent modifier).
		textarea.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "ArrowDown",
				altKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);

		expect(textarea.value).toBe("b\na\nc\n");
		expect(getCodeBuffer(doc).toString(), "edit must persist into the Y.Text").toBe("b\na\nc\n");

		// Shift+Alt+ArrowDown = duplicate line down. Caret is now on the
		// moved "a" (offset 2 → start of "a").
		textarea.setSelectionRange(2, 2);
		textarea.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "ArrowDown",
				altKey: true,
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		expect(textarea.value).toBe("b\na\na\nc\n");
		expect(getCodeBuffer(doc).toString()).toBe("b\na\na\nc\n");

		pane.dispose();
	});

	it("auto-closes a typed bracket and persists through the Y.Text buffer", async () => {
		const doc = new Y.Doc();
		const pane = createCodePane({
			row: makeRow(""),
			citationIndex: new Map(),
			labels: NOOP_LABELS,
			objectMenuContext: () => null,
			openCitation: () => {},
			onContentChange: () => {},
			docHandle: eagerHandle(doc),
		});
		document.body.appendChild(pane.element);
		await flushMicrotasks();

		const textarea = pane.element.querySelector(".editor__buffer") as HTMLTextAreaElement;
		textarea.focus();
		textarea.setSelectionRange(0, 0);

		const evt = new KeyboardEvent("keydown", { key: "(", bubbles: true, cancelable: true });
		textarea.dispatchEvent(evt);

		expect(evt.defaultPrevented, "the native '(' insertion must be suppressed").toBe(true);
		expect(textarea.value).toBe("()");
		expect(textarea.selectionStart).toBe(1); // caret between the pair
		expect(getCodeBuffer(doc).toString()).toBe("()");

		// Backspace between the empty pair removes both halves.
		const back = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
		textarea.dispatchEvent(back);
		expect(textarea.value).toBe("");
		expect(getCodeBuffer(doc).toString()).toBe("");

		pane.dispose();
	});

	it("detaches its line-op chords on dispose", async () => {
		const doc = new Y.Doc();
		const pane = createCodePane({
			row: makeRow("a\nb\n"),
			citationIndex: new Map(),
			labels: NOOP_LABELS,
			objectMenuContext: () => null,
			openCitation: () => {},
			onContentChange: () => {},
			docHandle: eagerHandle(doc),
		});
		document.body.appendChild(pane.element);
		await flushMicrotasks();

		const textarea = pane.element.querySelector(".editor__buffer") as HTMLTextAreaElement;
		pane.dispose();

		textarea.setSelectionRange(0, 0);
		textarea.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "ArrowDown",
				altKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
		// Listener removed → buffer unchanged.
		expect(textarea.value).toBe("a\nb\n");

		// Auto-close keydown is also detached.
		const paren = new KeyboardEvent("keydown", { key: "(", bubbles: true, cancelable: true });
		textarea.dispatchEvent(paren);
		expect(paren.defaultPrevented).toBe(false);
		expect(textarea.value).toBe("a\nb\n");
	});

	it("applies the initial wrap state to the code host", async () => {
		const doc = new Y.Doc();
		const pane = createCodePane({
			row: makeRow("x"),
			citationIndex: new Map(),
			labels: NOOP_LABELS,
			objectMenuContext: () => null,
			openCitation: () => {},
			onContentChange: () => {},
			wrap: true,
			docHandle: eagerHandle(doc),
		});
		document.body.appendChild(pane.element);
		await flushMicrotasks();
		expect(
			pane.element.querySelector(".editor__code")?.classList.contains("editor__code--wrap"),
		).toBe(true);
		expect(pane.isWrapped()).toBe(true);
		pane.dispose();
	});

	it("toggleWrap flips the host class, the state, and notifies onWrapChange", async () => {
		const doc = new Y.Doc();
		const changes: boolean[] = [];
		const pane = createCodePane({
			row: makeRow("x"),
			citationIndex: new Map(),
			labels: NOOP_LABELS,
			objectMenuContext: () => null,
			openCitation: () => {},
			onContentChange: () => {},
			onWrapChange: (w) => changes.push(w),
			docHandle: eagerHandle(doc),
		});
		document.body.appendChild(pane.element);
		await flushMicrotasks();
		const code = pane.element.querySelector(".editor__code") as HTMLElement;

		expect(pane.isWrapped()).toBe(false);
		expect(pane.toggleWrap()).toBe(true);
		expect(code.classList.contains("editor__code--wrap")).toBe(true);
		expect(pane.toggleWrap()).toBe(false);
		expect(code.classList.contains("editor__code--wrap")).toBe(false);
		expect(changes).toEqual([true, false]);
		pane.dispose();
	});

	it("renders one gutter line per buffer line with no markers when clean", async () => {
		const doc = new Y.Doc();
		const pane = createCodePane({
			row: makeRow("a\nb\nc\n"),
			citationIndex: new Map(),
			labels: NOOP_LABELS,
			objectMenuContext: () => null,
			openCitation: () => {},
			onContentChange: () => {},
			docHandle: eagerHandle(doc),
		});
		document.body.appendChild(pane.element);
		await flushMicrotasks();

		const gutter = pane.element.querySelector(".editor__gutter") as HTMLElement;
		const lines = gutter.querySelectorAll(".editor__line-no");
		// "a\nb\nc\n" → 4 logical lines (trailing newline yields an empty 4th).
		expect(lines).toHaveLength(4);
		expect(Array.from(lines).map((l) => l.textContent)).toEqual(["1", "2", "3", "4"]);
		// Clean buffer (matches its own baseline) → no diff markers.
		expect(gutter.querySelectorAll(".editor__line-no--added")).toHaveLength(0);
		expect(gutter.querySelectorAll(".editor__line-no--modified")).toHaveLength(0);
		expect(gutter.querySelectorAll(".editor__line-no--deleted")).toHaveLength(0);
		pane.dispose();
	});

	it("marks an edited line Modified in the gutter against the saved baseline", async () => {
		const doc = new Y.Doc();
		const pane = createCodePane({
			row: makeRow("a\nb\nc"),
			citationIndex: new Map(),
			labels: NOOP_LABELS,
			objectMenuContext: () => null,
			openCitation: () => {},
			onContentChange: () => {},
			docHandle: eagerHandle(doc),
		});
		document.body.appendChild(pane.element);
		await flushMicrotasks();

		const textarea = pane.element.querySelector(".editor__buffer") as HTMLTextAreaElement;
		textarea.value = "a\nB\nc";
		textarea.dispatchEvent(new Event("input", { bubbles: true }));

		const gutter = pane.element.querySelector(".editor__gutter") as HTMLElement;
		const modified = gutter.querySelectorAll(".editor__line-no--modified");
		expect(modified).toHaveLength(1);
		expect((modified[0] as HTMLElement).textContent).toBe("2");
		pane.dispose();
	});

	it("marks an appended line Added in the gutter", async () => {
		const doc = new Y.Doc();
		const pane = createCodePane({
			row: makeRow("a\nb"),
			citationIndex: new Map(),
			labels: NOOP_LABELS,
			objectMenuContext: () => null,
			openCitation: () => {},
			onContentChange: () => {},
			docHandle: eagerHandle(doc),
		});
		document.body.appendChild(pane.element);
		await flushMicrotasks();

		const textarea = pane.element.querySelector(".editor__buffer") as HTMLTextAreaElement;
		textarea.value = "a\nb\nc";
		textarea.dispatchEvent(new Event("input", { bubbles: true }));

		const gutter = pane.element.querySelector(".editor__gutter") as HTMLElement;
		const added = gutter.querySelectorAll(".editor__line-no--added");
		expect(added).toHaveLength(1);
		expect((added[0] as HTMLElement).textContent).toBe("3");
		pane.dispose();
	});

	it("defaults the syntax-theme preference to Auto", async () => {
		const doc = new Y.Doc();
		const pane = createCodePane({
			row: makeRow("x"),
			citationIndex: new Map(),
			labels: NOOP_LABELS,
			objectMenuContext: () => null,
			openCitation: () => {},
			onContentChange: () => {},
			docHandle: eagerHandle(doc),
		});
		document.body.appendChild(pane.element);
		await flushMicrotasks();
		expect(pane.syntaxThemePreference()).toBe(SyntaxThemePreference.Auto);
		pane.dispose();
	});

	it("setSyntaxTheme updates the preference and notifies onSyntaxThemeChange once", async () => {
		const doc = new Y.Doc();
		const changes: SyntaxThemePreference[] = [];
		const pane = createCodePane({
			row: makeRow("x"),
			citationIndex: new Map(),
			labels: NOOP_LABELS,
			objectMenuContext: () => null,
			openCitation: () => {},
			onContentChange: () => {},
			syntaxTheme: SyntaxThemePreference.Light,
			onSyntaxThemeChange: (p) => changes.push(p),
			docHandle: eagerHandle(doc),
		});
		document.body.appendChild(pane.element);
		await flushMicrotasks();

		expect(pane.syntaxThemePreference()).toBe(SyntaxThemePreference.Light);
		pane.setSyntaxTheme(SyntaxThemePreference.Dark);
		expect(pane.syntaxThemePreference()).toBe(SyntaxThemePreference.Dark);
		// Re-picking the same preference is a no-op (no duplicate persist).
		pane.setSyntaxTheme(SyntaxThemePreference.Dark);
		expect(changes).toEqual([SyntaxThemePreference.Dark]);
		pane.dispose();
	});
});

describe("prefersDarkScheme — the shell appearance wins over the OS media query", () => {
	// The preload paints the resolved appearance as `color-scheme` on <body>
	// (#brainstorm-tokens). Reading the OS-level `prefers-color-scheme` first
	// is exactly how a Dark-appearance shell on a light-mode OS shipped
	// github-light tokens on a near-black editor (dark-sweep 2026-07-29).
	it("follows the body's computed color-scheme in both directions", () => {
		document.body.style.setProperty("color-scheme", "dark");
		expect(prefersDarkScheme()).toBe(true);
		document.body.style.setProperty("color-scheme", "light");
		expect(prefersDarkScheme()).toBe(false);
		document.body.style.removeProperty("color-scheme");
	});

	it("falls back to the media query when no scheme is painted (no shell)", () => {
		document.body.style.removeProperty("color-scheme");
		// jsdom's matchMedia never matches — the no-shell fallback is light.
		expect(prefersDarkScheme()).toBe(false);
	});
});
