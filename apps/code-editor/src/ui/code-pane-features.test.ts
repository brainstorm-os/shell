/**
 * @vitest-environment jsdom
 *
 * Pane-level integration for the 9.7.3 / B9.3 / 9.7.8 surfaces: the
 * shared FindBar over the @codemirror/search engine (decorations +
 * replace through the Y.Text edit path), multi-cursor fan-out edits,
 * the read-only fold view with unfold-on-edit, and Prettier formatting.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { CodeFileRow } from "../logic/code-projection";
import { getCodeBuffer, seedCodeBuffer } from "../logic/code-y-buffer";
import { VerticalDirection } from "../logic/multi-cursor";
import type { SyntaxThemePreference } from "../logic/syntax-theme";
import { LanguageKey } from "../types/code-file";
import { type CodePaneController, createCodePane } from "./code-pane";
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

function makeRow(content: string, language: LanguageKey = LanguageKey.TypeScript): CodeFileRow {
	return {
		id: "code-1",
		path: "demo.ts",
		language,
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

let pane: CodePaneController | null = null;
let doc: Y.Doc | null = null;

function mount(content: string, language?: LanguageKey) {
	doc = new Y.Doc();
	seedCodeBuffer(getCodeBuffer(doc), content);
	pane = createCodePane({
		row: makeRow(content, language),
		citationIndex: new Map(),
		labels: NOOP_LABELS,
		objectMenuContext: () => null,
		openCitation: () => {},
		onContentChange: () => {},
		docHandle: { doc, release: () => {} },
	});
	document.body.appendChild(pane.element);
	const textarea = pane.element.querySelector(".editor__buffer") as HTMLTextAreaElement;
	return { pane, textarea };
}

afterEach(() => {
	pane?.dispose();
	pane = null;
	doc?.destroy();
	doc = null;
	document.body.replaceChildren();
	localStorage.clear();
	sessionStorage.clear();
});

function key(target: EventTarget, init: KeyboardEventInit): void {
	target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

describe("find & replace (B9.3)", () => {
	it("openFind mounts the shared bar, term input paints overlay matches, replace-all persists through Y.Text", () => {
		const { pane: p, textarea } = mount("foo bar\nfoo baz\n");
		p.openFind("find-replace");
		const bar = p.element.querySelector(".bs-find-bar");
		expect(bar).not.toBeNull();
		const term = bar?.querySelector<HTMLInputElement>('[data-testid="find-term"]');
		expect(term).not.toBeNull();
		if (!term) return;
		term.value = "foo";
		term.dispatchEvent(new Event("input", { bubbles: true }));
		// Both matches decorate the overlay; the first is revealed (active).
		const matches = p.element.querySelectorAll(".editor__find-match");
		expect(matches.length).toBeGreaterThanOrEqual(2);
		expect(p.element.querySelector(".editor__find-match--active")).not.toBeNull();
		const count = bar?.querySelector('[data-testid="find-count"]');
		expect(count?.textContent).toBe("1 of 2");
		// Replace all routes ONE buffer write through the binding.
		const replacement = bar?.querySelector<HTMLInputElement>('[data-testid="find-replacement"]');
		const replaceAll = bar?.querySelector<HTMLButtonElement>('[data-testid="find-replace-all"]');
		if (!replacement || !replaceAll) throw new Error("replace row missing");
		replacement.value = "qux";
		replacement.dispatchEvent(new Event("input", { bubbles: true }));
		replaceAll.click();
		expect(textarea.value).toBe("qux bar\nqux baz\n");
		expect(getCodeBuffer(doc as Y.Doc).toString()).toBe("qux bar\nqux baz\n");
	});

	it("closing the bar clears the overlay decorations", () => {
		const { pane: p } = mount("foo foo\n");
		p.openFind();
		const term = p.element.querySelector<HTMLInputElement>('[data-testid="find-term"]');
		if (!term) throw new Error("bar missing");
		term.value = "foo";
		term.dispatchEvent(new Event("input", { bubbles: true }));
		expect(p.element.querySelectorAll(".editor__find-match").length).toBe(2);
		key(term, { key: "Escape" });
		expect(p.element.querySelector(".bs-find-bar")).toBeNull();
		expect(p.element.querySelectorAll(".editor__find-match").length).toBe(0);
	});
});

describe("multi-cursor (9.7.3)", () => {
	it("add-cursor-below paints a secondary caret and fans a typed char to both lines", () => {
		const { pane: p, textarea } = mount("one\ntwo\n");
		textarea.setSelectionRange(1, 1);
		p.addCursorVertical(VerticalDirection.Down);
		expect(p.cursorCount()).toBe(2);
		expect(p.element.querySelectorAll(".editor__extra-caret").length).toBe(1);
		key(textarea, { key: "X" });
		expect(textarea.value).toBe("oXne\ntXwo\n");
		// The fanned edit persisted through the SAME Y.Text path.
		expect(getCodeBuffer(doc as Y.Doc).toString()).toBe("oXne\ntXwo\n");
		// Cursors survive the edit, advanced past the insert.
		expect(p.cursorCount()).toBe(2);
		key(textarea, { key: "Backspace" });
		expect(textarea.value).toBe("one\ntwo\n");
	});

	it("Escape collapses to the primary cursor", () => {
		const { pane: p, textarea } = mount("one\ntwo\n");
		textarea.setSelectionRange(0, 0);
		p.addCursorVertical(VerticalDirection.Down);
		expect(p.cursorCount()).toBe(2);
		key(textarea, { key: "Escape" });
		expect(p.cursorCount()).toBe(1);
		expect(p.element.querySelectorAll(".editor__extra-caret").length).toBe(0);
	});

	it("select-next-occurrence grows word selections (Cmd+D semantics)", () => {
		const { pane: p, textarea } = mount("foo bar foo\n");
		textarea.setSelectionRange(1, 1);
		p.selectNextOccurrenceAtCaret();
		expect(textarea.selectionStart).toBe(0);
		expect(textarea.selectionEnd).toBe(3);
		expect(p.cursorCount()).toBe(1);
		p.selectNextOccurrenceAtCaret();
		expect(p.cursorCount()).toBe(2);
		expect(p.element.querySelectorAll(".editor__extra-selection").length).toBe(1);
	});
});

describe("code folding (9.7.3)", () => {
	const SRC = "function a() {\n  one;\n  two;\n}\nconst x = 1;\n";

	it("foldAtCaret collapses the region into a read-only view with skip-numbered gutter + badge", () => {
		const { pane: p, textarea } = mount(SRC);
		textarea.setSelectionRange(SRC.indexOf("one"), SRC.indexOf("one"));
		p.foldAtCaret();
		expect(p.isFolded()).toBe(true);
		expect(textarea.readOnly).toBe(true);
		expect(textarea.value).toBe("function a() {\n}\nconst x = 1;\n");
		const numbers = [...p.element.querySelectorAll(".editor__line-no")].map(
			(el) => el.textContent?.replace(/[▸▾]/g, "") ?? "",
		);
		expect(numbers).toEqual(["1", "4", "5", "6"]);
		expect(p.element.querySelector(".editor__fold-badge")).not.toBeNull();
		expect(
			p.element.querySelector(".editor__fold-chevron--folded"),
			"header chevron flips to folded",
		).not.toBeNull();
	});

	it("an edit intent unfolds and applies the keystroke to the full buffer", () => {
		const { pane: p, textarea } = mount(SRC);
		textarea.setSelectionRange(0, 0);
		p.foldAtCaret();
		expect(p.isFolded()).toBe(true);
		key(textarea, { key: "Z" });
		expect(p.isFolded()).toBe(false);
		expect(textarea.readOnly).toBe(false);
		expect(textarea.value).toBe(`Z${SRC}`);
		expect(getCodeBuffer(doc as Y.Doc).toString()).toBe(`Z${SRC}`);
	});

	it("gutter chevron click toggles the fold; unfoldAll restores everything", () => {
		const { pane: p, textarea } = mount(SRC);
		const chevron = p.element.querySelector<HTMLElement>(".editor__fold-chevron");
		expect(chevron).not.toBeNull();
		chevron?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(p.isFolded()).toBe(true);
		p.unfoldAll();
		expect(p.isFolded()).toBe(false);
		expect(textarea.value).toBe(SRC);
		expect(textarea.readOnly).toBe(false);
	});
});

describe("autocomplete (9.7.3)", () => {
	// Simulate the browser inserting typed text + firing `input` (jsdom does
	// neither for a bare keydown), the same way the find-replace test drives
	// the binding's input path.
	function type(textarea: HTMLTextAreaElement, value: string, caret: number): void {
		textarea.value = value;
		textarea.setSelectionRange(caret, caret);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	}

	it("auto-shows buffer completions for a typed prefix, ranked shortest-first", () => {
		const { pane: p, textarea } = mount("alpha alphabet\n");
		type(textarea, "alpha alphabet\nal", 17);
		const st = p.completionState();
		expect(st).not.toBeNull();
		expect(st?.items.map((i) => i.label)).toEqual(["alpha", "alphabet"]);
		expect(st?.selected?.label).toBe("alpha");
		expect(p.element.querySelectorAll(".editor__completion-item").length).toBe(2);
	});

	it("ArrowDown moves the selection; Enter accepts it through the Y.Text edit path", () => {
		const { pane: p, textarea } = mount("alpha alphabet\n");
		type(textarea, "alpha alphabet\nal", 17);
		key(textarea, { key: "ArrowDown" });
		expect(p.completionState()?.selected?.label).toBe("alphabet");
		key(textarea, { key: "Enter" });
		expect(p.completionState()).toBeNull();
		expect(textarea.value).toBe("alpha alphabet\nalphabet");
		expect(getCodeBuffer(doc as Y.Doc).toString()).toBe("alpha alphabet\nalphabet");
	});

	it("Escape dismisses without inserting", () => {
		const { pane: p, textarea } = mount("alpha alphabet\n");
		type(textarea, "alpha alphabet\nal", 17);
		expect(p.completionState()).not.toBeNull();
		key(textarea, { key: "Escape" });
		expect(p.completionState()).toBeNull();
		expect(textarea.value).toBe("alpha alphabet\nal");
	});

	it("offers nothing once the prefix resolves to no other candidate", () => {
		const { pane: p, textarea } = mount("alpha\n");
		// Caret after the only occurrence: the word completes to itself → no list.
		type(textarea, "alpha\nalpha", 11);
		expect(p.completionState()).toBeNull();
	});

	it("offers language keywords even when the buffer lacks the identifier", () => {
		const { pane: p, textarea } = mount("fun\n", LanguageKey.TypeScript);
		type(textarea, "fun", 3);
		const labels = p.completionState()?.items.map((i) => i.label) ?? [];
		expect(labels).toContain("function");
	});

	it("does not offer completions while secondary cursors exist", () => {
		const { pane: p, textarea } = mount("alpha\nalpha\n");
		textarea.setSelectionRange(5, 5);
		p.addCursorVertical(VerticalDirection.Down);
		expect(p.cursorCount()).toBe(2);
		key(textarea, { key: "x" });
		expect(textarea.value).toBe("alphax\nalphax\n");
		expect(p.completionState()).toBeNull();
	});
});

describe("formatter (9.7.8)", () => {
	it("formatBuffer rewrites through the edit path and persists to Y.Text", async () => {
		const { pane: p, textarea } = mount("const   x:number=1;");
		expect(p.canFormatBuffer()).toBe(true);
		const changed = await p.formatBuffer();
		expect(changed).toBe(true);
		expect(textarea.value).toBe("const x: number = 1;\n");
		expect(getCodeBuffer(doc as Y.Doc).toString()).toBe("const x: number = 1;\n");
	});

	it("is a safe no-op for unformattable languages", async () => {
		const { pane: p, textarea } = mount("x = 1\n", LanguageKey.Python);
		expect(p.canFormatBuffer()).toBe(false);
		expect(await p.formatBuffer()).toBe(false);
		expect(textarea.value).toBe("x = 1\n");
	});
});
