// @vitest-environment jsdom
/**
 * The inspector must not recompute per keystroke (the References panel + the
 * problem list used to, which read on screen as a blink while typing).
 *
 * Boots the React app against the demo dataset (no `window.brainstorm`), types
 * into the real buffer textarea, and asserts the derivation is coalesced to a
 * quiet period, that the panel never blanks mid-edit, and that unchanged
 * problem rows keep their DOM nodes.
 */
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logic/citation-scan", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./logic/citation-scan")>();
	return { ...actual, collectReferences: vi.fn(actual.collectReferences) };
});

import { CodeEditorApp } from "./app";
import { buildDemoCitationIndex } from "./demo/dataset";
import { collectReferences } from "./logic/citation-scan";
import { EDIT_SETTLE_MS } from "./logic/settle";

const collectSpy = vi.mocked(collectReferences);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const buffer = (): HTMLTextAreaElement => {
	const area = document.querySelector<HTMLTextAreaElement>(".editor__buffer");
	if (!area) throw new Error("no buffer textarea");
	return area;
};
const refRows = () => [...document.querySelectorAll(".editor__ref")];
const refCodes = () => refRows().map((row) => row.querySelector(".editor__ref-code")?.textContent);
const refsEmpty = () => document.querySelector(".editor__refs-empty");
const problemRows = () => [...document.querySelectorAll(".editor__diagnostic")];
const problemHead = () => document.querySelector(".editor__diagnostics-head")?.textContent;

function selectFile(name: string): void {
	const row = [...document.querySelectorAll<HTMLElement>(".editor__file")].find((el) =>
		el.textContent?.includes(name),
	);
	act(() => row?.querySelector<HTMLElement>(".editor__file-open")?.click());
}

/** One `input` event per character — exactly what the editor sees. */
function type(text: string): void {
	const area = buffer();
	for (const ch of text) {
		act(() => {
			area.value = `${area.value}${ch}`;
			area.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}
}

function settle(): void {
	act(() => {
		vi.advanceTimersByTime(EDIT_SETTLE_MS + 10);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	sessionStorage.clear();
	container = document.createElement("div");
	document.body.append(container);
	act(() => {
		root = createRoot(container);
		root.render(<CodeEditorApp />);
	});
	// The citation-bearing demo file, so the panel has non-empty content to
	// preserve while typing.
	selectFile("sh-14.md");
	settle();
	collectSpy.mockClear();
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
	window.brainstorm = undefined;
});

describe("inspector coalescing (references + problem list)", () => {
	it("scans once per quiet period, not once per keystroke", () => {
		expect(refRows().length).toBeGreaterThan(0);

		const burst = "// SH-13 and a good deal of extra prose here";
		type(burst);
		// Nothing during the burst — the previously derived refs stay on screen.
		expect(collectSpy).not.toHaveBeenCalled();

		settle();
		expect(collectSpy).toHaveBeenCalledTimes(1);
		expect(burst.length).toBeGreaterThan(40);
	});

	it("keeps the rendered references while typing and never shows the empty state", () => {
		const before = refRows().length;
		const head = problemHead();
		expect(before).toBeGreaterThan(0);

		// Breaking a citation mid-word would resolve to fewer refs if the panel
		// tracked every intermediate buffer.
		const area = buffer();
		for (const ch of "xxxxxxxx") {
			act(() => {
				area.value = area.value.replace("SH-14", `SH-1${ch}4`);
				area.dispatchEvent(new Event("input", { bubbles: true }));
			});
			expect(refsEmpty()).toBeNull();
			expect(refRows()).toHaveLength(before);
			expect(problemHead()).toBe(head);
		}
	});

	it("matches the eager computation once typing stops", async () => {
		type("\n<!-- follows 9.7.1.5, see also OQ-GR-1 -->\n");
		settle();

		const eager =
			await vi.importActual<typeof import("./logic/citation-scan")>("./logic/citation-scan");
		const expected = eager
			.collectReferences(buffer().value, buildDemoCitationIndex())
			.map((ref) => ref.entry.code);
		expect(refCodes()).toEqual(expected);
	});

	it("flushes immediately on a file switch (no stale other-file references)", () => {
		expect(refRows().length).toBeGreaterThan(0);
		selectFile("greet.ts");
		// No timer advance — the swap lands in the same commit as the selection.
		expect(refRows()).toHaveLength(0);
		expect(refsEmpty()).not.toBeNull();
	});

	it("re-uses the problem-list row nodes across an edit", () => {
		// Trailing whitespace — a warning the linter re-reports on every pass.
		type("\nconst x = 1;   \n");
		settle();
		const before = problemRows();
		expect(before).toHaveLength(1);

		type("a following line\n");
		settle();
		expect(problemRows()[0]).toBe(before[0]);
	});
});
