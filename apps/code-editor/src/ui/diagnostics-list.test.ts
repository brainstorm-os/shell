// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { type Diagnostic, DiagnosticCode, DiagnosticSeverity } from "../logic/diagnostics";
import { createDiagnosticsList } from "./diagnostics-list";

const t = (key: string, params?: Record<string, string>) =>
	params ? `${key}:${Object.values(params).join(",")}` : key;

// Mirrors `@brainstorm-os/sdk/i18n`'s `plural`: the count === 1 selection lives
// in the shared helper, never in the builder under test.
const plural = (count: number, oneKey: string, otherKey: string) =>
	t(count === 1 ? oneKey : otherKey, { count: String(count) });

function diag(over: Partial<Diagnostic> = {}): Diagnostic {
	return {
		severity: DiagnosticSeverity.Warning,
		code: DiagnosticCode.TrailingWhitespace,
		line: 3,
		...over,
	};
}

function render(diagnostics: readonly Diagnostic[], onReveal = vi.fn()) {
	const handle = createDiagnosticsList({ t, plural, onReveal });
	handle.update(diagnostics);
	return handle;
}

describe("createDiagnosticsList", () => {
	it("shows a clean state with no diagnostics", () => {
		const { element } = render([]);
		expect(element.querySelector(".editor__diagnostics-head")?.textContent).toBe("diagnostics.clean");
		expect(element.querySelector(".editor__diagnostics-list")).toBeNull();
	});

	it("lists each diagnostic with severity class + line", () => {
		const { element } = render([
			diag({
				severity: DiagnosticSeverity.Error,
				code: DiagnosticCode.UnmatchedBracket,
				line: 1,
				params: { ch: ")" },
			}),
			diag(),
		]);
		expect(element.querySelector(".editor__diagnostic--error")).not.toBeNull();
		expect(element.querySelector(".editor__diagnostic--warning")).not.toBeNull();
		expect(element.querySelectorAll(".editor__diagnostic")).toHaveLength(2);
	});

	it("localises the message from the diagnostic code + params (no baked prose)", () => {
		const { element } = render([
			diag({ code: DiagnosticCode.UnmatchedBracket, params: { ch: ")" } }),
			diag({ code: DiagnosticCode.TrailingWhitespace }),
		]);
		const msgs = [...element.querySelectorAll(".editor__diagnostic-msg")].map((n) => n.textContent);
		expect(msgs).toContain("diagnostics.msg.unmatchedBracket:)");
		expect(msgs).toContain("diagnostics.msg.trailingWhitespace");
	});

	it("pluralises each half of the summary on its own count (never “1 errors”)", () => {
		const { element } = render([
			diag({ severity: DiagnosticSeverity.Error }),
			diag({ severity: DiagnosticSeverity.Warning }),
			diag({ severity: DiagnosticSeverity.Warning }),
		]);
		expect(element.querySelector(".editor__diagnostics-head")?.textContent).toBe(
			"diagnostics.summary:diagnostics.errors.one:1,diagnostics.warnings.other:2",
		);
	});

	it("uses the plural branch for a zero count", () => {
		const { element } = render([diag({ severity: DiagnosticSeverity.Warning })]);
		expect(element.querySelector(".editor__diagnostics-head")?.textContent).toBe(
			"diagnostics.summary:diagnostics.errors.other:0,diagnostics.warnings.one:1",
		);
	});

	it("reveals the line on click", () => {
		const onReveal = vi.fn();
		const { element } = render([diag({ line: 7 })], onReveal);
		element.querySelector<HTMLButtonElement>(".editor__diagnostic")?.click();
		expect(onReveal).toHaveBeenCalledWith(7);
	});

	describe("in-place reconcile", () => {
		it("re-uses the row nodes across an identical update and writes nothing", () => {
			const handle = render([diag({ line: 2 }), diag({ line: 5 })]);
			const before = [...handle.element.querySelectorAll(".editor__diagnostic")];
			const setSpies = before.map((row) => {
				const msg = row.querySelector<HTMLElement>(".editor__diagnostic-msg");
				return vi.spyOn(msg as HTMLElement, "textContent", "set");
			});
			handle.update([diag({ line: 2 }), diag({ line: 5 })]);
			const after = [...handle.element.querySelectorAll(".editor__diagnostic")];
			expect(after[0]).toBe(before[0]);
			expect(after[1]).toBe(before[1]);
			for (const spy of setSpies) expect(spy).not.toHaveBeenCalled();
		});

		it("patches only the row that changed", () => {
			const handle = render([diag({ line: 2 }), diag({ line: 5 })]);
			const rows = [...handle.element.querySelectorAll(".editor__diagnostic")];
			const firstLoc = rows[0]?.querySelector<HTMLElement>(".editor__diagnostic-loc");
			const secondLoc = rows[1]?.querySelector<HTMLElement>(".editor__diagnostic-loc");
			const firstSpy = vi.spyOn(firstLoc as HTMLElement, "textContent", "set");
			const secondSpy = vi.spyOn(secondLoc as HTMLElement, "textContent", "set");
			handle.update([diag({ line: 2 }), diag({ line: 9 })]);
			expect(firstSpy).not.toHaveBeenCalled();
			expect(secondSpy).toHaveBeenCalledWith("diagnostics.lineLabel:9");
			expect(handle.element.querySelectorAll(".editor__diagnostic")[1]).toBe(rows[1]);
		});

		it("grows, shrinks and clears the list without rebuilding surviving rows", () => {
			const handle = render([diag({ line: 1 })]);
			const first = handle.element.querySelector(".editor__diagnostic");
			handle.update([diag({ line: 1 }), diag({ line: 4 }), diag({ line: 6 })]);
			expect(handle.element.querySelectorAll(".editor__diagnostic")).toHaveLength(3);
			expect(handle.element.querySelector(".editor__diagnostic")).toBe(first);
			handle.update([diag({ line: 1 })]);
			expect(handle.element.querySelectorAll(".editor__diagnostic")).toHaveLength(1);
			expect(handle.element.querySelector(".editor__diagnostic")).toBe(first);
			handle.update([]);
			expect(handle.element.querySelector(".editor__diagnostics-list")).toBeNull();
			expect(handle.element.querySelector(".editor__diagnostics-head")?.textContent).toBe(
				"diagnostics.clean",
			);
		});

		it("reveals the reused row's CURRENT line after a patch", () => {
			const onReveal = vi.fn();
			const handle = render([diag({ line: 7 })], onReveal);
			handle.update([diag({ line: 12 })]);
			handle.element.querySelector<HTMLButtonElement>(".editor__diagnostic")?.click();
			expect(onReveal).toHaveBeenCalledWith(12);
			expect(onReveal).not.toHaveBeenCalledWith(7);
		});

		it("re-uses a row when only the severity flips", () => {
			const handle = render([diag({ severity: DiagnosticSeverity.Warning })]);
			const row = handle.element.querySelector(".editor__diagnostic");
			handle.update([diag({ severity: DiagnosticSeverity.Error })]);
			expect(handle.element.querySelector(".editor__diagnostic")).toBe(row);
			expect(row?.className).toContain("editor__diagnostic--error");
		});
	});
});
