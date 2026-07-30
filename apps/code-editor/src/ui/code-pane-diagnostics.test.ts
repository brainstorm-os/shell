/**
 * @vitest-environment jsdom
 *
 * The inline squiggles (9.7.6) follow the same quiet period as the inspector's
 * problem list: one repaint after typing stops, never one per keystroke — and
 * never a buffer the list and the overlay disagree about.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { CodeFileRow } from "../logic/code-projection";
import { getCodeBuffer, seedCodeBuffer } from "../logic/code-y-buffer";
import { EDIT_SETTLE_MS } from "../logic/settle";
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

let pane: CodePaneController | null = null;
let doc: Y.Doc | null = null;

function mount(content: string) {
	doc = new Y.Doc();
	seedCodeBuffer(getCodeBuffer(doc), content);
	pane = createCodePane({
		row: makeRow(content),
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

const squiggles = () => document.querySelectorAll(".editor__squiggle").length;

function type(textarea: HTMLTextAreaElement, text: string): void {
	for (const ch of text) {
		textarea.value = `${textarea.value}${ch}`;
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	}
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	pane?.dispose();
	pane = null;
	doc?.destroy();
	doc = null;
	document.body.replaceChildren();
	localStorage.clear();
	sessionStorage.clear();
	vi.useRealTimers();
});

describe("inline diagnostics coalescing (9.7.6)", () => {
	it("paints squiggles for the bound buffer up front", () => {
		mount("const a = 1;   \n");
		expect(squiggles()).toBeGreaterThan(0);
	});

	it("holds the painted squiggles through a typing burst, then repaints once", () => {
		const { textarea } = mount("const a = 1;\n");
		expect(squiggles()).toBe(0);

		type(textarea, "const b = 2;   ");
		// Mid-burst the overlay is untouched — the repaint waits for the pause.
		expect(squiggles()).toBe(0);

		vi.advanceTimersByTime(EDIT_SETTLE_MS + 10);
		expect(squiggles()).toBeGreaterThan(0);
	});

	it("drops the pending repaint on dispose", () => {
		const { pane: p, textarea } = mount("const a = 1;\n");
		type(textarea, "const b = 2;   ");
		p.dispose();
		pane = null;
		expect(() => vi.advanceTimersByTime(EDIT_SETTLE_MS + 10)).not.toThrow();
	});
});
