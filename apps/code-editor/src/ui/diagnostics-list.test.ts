// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { type Diagnostic, DiagnosticCode, DiagnosticSeverity } from "../logic/diagnostics";
import { renderDiagnosticsList } from "./diagnostics-list";

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

describe("renderDiagnosticsList", () => {
	it("shows a clean state with no diagnostics", () => {
		const el = renderDiagnosticsList({ diagnostics: [], t, plural, onReveal: vi.fn() });
		expect(el.querySelector(".editor__diagnostics-head")?.textContent).toBe("diagnostics.clean");
		expect(el.querySelector(".editor__diagnostics-list")).toBeNull();
	});

	it("lists each diagnostic with severity class + line", () => {
		const el = renderDiagnosticsList({
			diagnostics: [
				diag({
					severity: DiagnosticSeverity.Error,
					code: DiagnosticCode.UnmatchedBracket,
					line: 1,
					params: { ch: ")" },
				}),
				diag(),
			],
			t,
			plural,
			onReveal: vi.fn(),
		});
		expect(el.querySelector(".editor__diagnostic--error")).not.toBeNull();
		expect(el.querySelector(".editor__diagnostic--warning")).not.toBeNull();
		expect(el.querySelectorAll(".editor__diagnostic")).toHaveLength(2);
	});

	it("localises the message from the diagnostic code + params (no baked prose)", () => {
		const el = renderDiagnosticsList({
			diagnostics: [
				diag({ code: DiagnosticCode.UnmatchedBracket, params: { ch: ")" } }),
				diag({ code: DiagnosticCode.TrailingWhitespace }),
			],
			t,
			plural,
			onReveal: vi.fn(),
		});
		const msgs = [...el.querySelectorAll(".editor__diagnostic-msg")].map((n) => n.textContent);
		expect(msgs).toContain("diagnostics.msg.unmatchedBracket:)");
		expect(msgs).toContain("diagnostics.msg.trailingWhitespace");
	});

	it("pluralises each half of the summary on its own count (never “1 errors”)", () => {
		const el = renderDiagnosticsList({
			diagnostics: [
				diag({ severity: DiagnosticSeverity.Error }),
				diag({ severity: DiagnosticSeverity.Warning }),
				diag({ severity: DiagnosticSeverity.Warning }),
			],
			t,
			plural,
			onReveal: vi.fn(),
		});
		expect(el.querySelector(".editor__diagnostics-head")?.textContent).toBe(
			"diagnostics.summary:diagnostics.errors.one:1,diagnostics.warnings.other:2",
		);
	});

	it("uses the plural branch for a zero count", () => {
		const el = renderDiagnosticsList({
			diagnostics: [diag({ severity: DiagnosticSeverity.Warning })],
			t,
			plural,
			onReveal: vi.fn(),
		});
		expect(el.querySelector(".editor__diagnostics-head")?.textContent).toBe(
			"diagnostics.summary:diagnostics.errors.other:0,diagnostics.warnings.one:1",
		);
	});

	it("reveals the line on click", () => {
		const onReveal = vi.fn();
		const el = renderDiagnosticsList({ diagnostics: [diag({ line: 7 })], t, plural, onReveal });
		el.querySelector<HTMLButtonElement>(".editor__diagnostic")?.click();
		expect(onReveal).toHaveBeenCalledWith(7);
	});
});
