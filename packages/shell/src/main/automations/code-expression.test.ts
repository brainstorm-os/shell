/**
 * Sandboxed `Code`-step expression evaluator (11b.9, OQ-167 → (a)) — the
 * grammar, the curated built-ins, and (critically) the security posture:
 * no host globals, no prototype access, no foreign code path.
 */

import { StepKind, WorkflowRunStatus, type WorkflowStep } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { type ExprScope, ExpressionError, evaluateExpression } from "./code-expression";
import { codeExpressionScope, createCoreInterpreters } from "./step-interpreters";
import type { InterpreterPorts } from "./step-interpreters";
import type { RunContext } from "./workflow-runner";

const evalAt = (src: string, scope: ExprScope = {}, now = 1_000): unknown =>
	evaluateExpression(src, scope, { now });

describe("evaluateExpression — literals & arithmetic", () => {
	it("evaluates literals", () => {
		expect(evalAt("1")).toBe(1);
		expect(evalAt("1.5")).toBe(1.5);
		expect(evalAt('"hi"')).toBe("hi");
		expect(evalAt("'hi'")).toBe("hi");
		expect(evalAt("true")).toBe(true);
		expect(evalAt("false")).toBe(false);
		expect(evalAt("null")).toBe(null);
	});

	it("respects arithmetic precedence and grouping", () => {
		expect(evalAt("1 + 2 * 3")).toBe(7);
		expect(evalAt("(1 + 2) * 3")).toBe(9);
		expect(evalAt("10 % 3")).toBe(1);
		expect(evalAt("-5 + 2")).toBe(-3);
	});

	it("treats + as concatenation when either side is a string", () => {
		expect(evalAt('"a" + 1')).toBe("a1");
		expect(evalAt('1 + "a"')).toBe("1a");
	});

	it("parses escapes in string literals", () => {
		expect(evalAt('"a\\nb"')).toBe("a\nb");
		expect(evalAt('"say \\"hi\\""')).toBe('say "hi"');
	});
});

describe("evaluateExpression — comparison, logic, ternary", () => {
	it("compares with strict equality (no coercion)", () => {
		expect(evalAt("1 == 1")).toBe(true);
		expect(evalAt('1 == "1"')).toBe(false);
		expect(evalAt("1 != 2")).toBe(true);
		expect(evalAt("2 > 1 && 1 < 2")).toBe(true);
		expect(evalAt('"a" < "b"')).toBe(true);
	});

	it("short-circuits && / || and returns the operand value", () => {
		expect(evalAt("false && missing")).toBe(false);
		expect(evalAt('"x" || "y"')).toBe("x");
		expect(evalAt("null || 5")).toBe(5);
	});

	it("evaluates ternary", () => {
		expect(evalAt("1 > 0 ? 'yes' : 'no'")).toBe("yes");
		expect(evalAt("0 > 1 ? 'yes' : 'no'")).toBe("no");
	});
});

describe("evaluateExpression — scope & member access", () => {
	const scope: ExprScope = {
		input: { name: "Ada", tags: ["a", "b"], meta: { score: 9 } },
		step1: 42,
	};

	it("reads variables, dotted members, and indices", () => {
		expect(evalAt("input.name", scope)).toBe("Ada");
		expect(evalAt("input.meta.score", scope)).toBe(9);
		expect(evalAt("input.tags[1]", scope)).toBe("b");
		expect(evalAt("step1", scope)).toBe(42);
	});

	it("returns undefined for missing members rather than throwing", () => {
		expect(evalAt("input.nope", scope)).toBe(undefined);
		expect(evalAt("missing.deep", scope)).toBe(undefined);
	});
});

describe("evaluateExpression — built-ins", () => {
	it("string helpers", () => {
		expect(evalAt('upper("ab")')).toBe("AB");
		expect(evalAt('lower("AB")')).toBe("ab");
		expect(evalAt('trim("  x ")')).toBe("x");
		expect(evalAt('replace("a-b-c", "-", "_")')).toBe("a_b_c");
		expect(evalAt('contains("hello", "ell")')).toBe(true);
		expect(evalAt('concat("a", 1, true)')).toBe("a1true");
	});

	it("collection & numeric helpers", () => {
		expect(evalAt('len("abc")')).toBe(3);
		expect(evalAt("len(input.tags)", { input: { tags: [1, 2] } })).toBe(2);
		expect(evalAt('contains(input, "a")', { input: ["a", "b"] })).toBe(true);
		expect(evalAt('join(split("a,b,c", ","), "|")')).toBe("a|b|c");
		expect(evalAt("round(3.14159, 2)")).toBe(3.14);
		expect(evalAt("max(1, 9, 4)")).toBe(9);
		expect(evalAt('coalesce(null, "", "x")')).toBe("");
		expect(evalAt("coalesce(null, missing, 7)")).toBe(7);
	});

	it("now() returns the injected clock", () => {
		expect(evalAt("now()", {}, 555)).toBe(555);
	});
});

describe("evaluateExpression — security & errors", () => {
	it("cannot reach prototype-pollution keys", () => {
		expect(evalAt("input.__proto__", { input: {} })).toBe(undefined);
		expect(evalAt("input.constructor", { input: {} })).toBe(undefined);
		expect(evalAt('input["__proto__"]', { input: {} })).toBe(undefined);
	});

	it("cannot read inherited (non-own) properties", () => {
		const scope: ExprScope = { input: Object.create({ inherited: "leak" }) };
		expect(evalAt("input.inherited", scope)).toBe(undefined);
	});

	it("rejects unknown functions (no host globals)", () => {
		expect(() => evalAt('require("fs")')).toThrow(ExpressionError);
		expect(() => evalAt("eval('1')")).toThrow(ExpressionError);
		expect(() => evalAt("fetch('x')")).toThrow(ExpressionError);
	});

	it("rejects malformed expressions", () => {
		expect(() => evalAt("1 +")).toThrow(ExpressionError);
		expect(() => evalAt('"unterminated')).toThrow(ExpressionError);
		expect(() => evalAt("(1 + 2")).toThrow(ExpressionError);
	});

	it("rejects pathological input (length / nesting caps)", () => {
		const deeplyNested = `${"(".repeat(200)}1${")".repeat(200)}`;
		expect(() => evalAt(deeplyNested)).toThrow(ExpressionError);
		expect(() => evalAt("1".padEnd(5000, "1"))).toThrow(/too long/);
	});
});

describe("evaluateExpression — output size cap", () => {
	// The source cap bounds the wrong axis. Amplification is a function of the
	// SCOPE VALUES, not the source: each expression below is a couple of dozen
	// characters and, before the cap, produced tens of megabytes in milliseconds
	// — which then *succeeded* and got written onto an entity (11b.18's Entity
	// step evaluates field values through this same grammar).
	const field = (bytes: number): ExprScope => ({ f: "a".repeat(bytes) });

	it("blocks the quadratic amplifier — 21 characters over an 8KB field was 64MB", () => {
		expect(() => evalAt('join(split(f, ""), f)', field(8192))).toThrow(/result too large/);
	});

	it("blocks it at sizes that used to exhaust the allocator outright", () => {
		// |f|=100KB predicted 10.4 billion characters; unguarded this threw
		// RangeError from the allocator rather than a clean step failure.
		expect(() => evalAt('join(split(f, ""), f)', field(100 * 1024))).toThrow(/result too large/);
	});

	it("blocks the cubic chain — nesting the trick raises the exponent, not the source length", () => {
		expect(() => evalAt('join(split(join(split(f, ""), f), ""), f)', field(200))).toThrow(
			/result too large/,
		);
	});

	it("blocks every multiplicative operator, not just join", () => {
		expect(() => evalAt(`concat(${Array(400).fill("f").join(",")})`, field(64 * 1024))).toThrow(
			/result too large/,
		);
		expect(() => evalAt("f+f+f+f", field(1024 * 1024))).toThrow(/result too large/);
		expect(() => evalAt('replace(f, "a", "bbbb")', field(1024 * 1024))).toThrow(/result too large/);
		expect(() => evalAt('split(f, "")', field(2 * 1024 * 1024))).toThrow(/result too large/);
	});

	it("rejects BEFORE allocating — a predicted size, not a post-hoc check", () => {
		// `Array.prototype.join` builds the whole string internally, so a guard on
		// the return value would run only once the damage was done. The predicted
		// size appears in the message, which is only knowable pre-allocation.
		expect(() => evalAt('join(split(f, ""), f)', field(100 * 1024))).toThrow(/10485760000/);
	});

	it("still allows large READS — scanning a 50MB body is legitimate", () => {
		// The cap is on what an operation PRODUCES. `contains` over a big email
		// body returns a boolean and must keep working, or the cap has broken the
		// feature it was meant to protect.
		expect(evalAt('contains(f, "urgent")', { f: `${"a".repeat(4 * 1024 * 1024)}urgent` })).toBe(true);
	});

	it("still allows a big haystack that splits into few pieces", () => {
		// Counted, not assumed from the haystack length — otherwise splitting a
		// large log on a rare delimiter would be rejected for no reason.
		expect(evalAt('len(split(f, "|"))', { f: `${"a".repeat(4 * 1024 * 1024)}|b|c` })).toBe(3);
	});

	it("leaves ordinary field mapping untouched", () => {
		expect(evalAt('concat("Task: ", f)', { f: "review PR" })).toBe("Task: review PR");
		expect(evalAt('join(split("a,b,c", ","), "-")', {})).toBe("a-b-c");
		expect(evalAt('replace(f, "o", "0")', { f: "foo" })).toBe("f00");
	});
});

describe("evaluateExpression — work budget", () => {
	// The size cap bounds SPACE, not TIME. Fifty nested `replace()` calls over a
	// 1MB field each stay under the 1MB per-result cap and still burned ~4.5s —
	// on the Electron main process, which freezes every window. The budget is
	// counted in characters rather than measured on a wall clock so the limit is
	// deterministic instead of varying with machine speed.
	const megabyte = { f: "a".repeat(1024 * 1024) };
	const nestedReplace = (n: number) => `len(${"replace(".repeat(n)}f${', "a", "a")'.repeat(n)})`;

	it("rejects an expression whose operations are individually legal but collectively huge", () => {
		expect(() => evalAt(nestedReplace(50), megabyte)).toThrow(/too expensive/);
	});

	it("still permits repeated scans of a large field, which is the legitimate case", () => {
		// An email-triage workflow checking a 1MB body for several keywords is
		// exactly what this feature is for and must not trip the budget.
		const body = { f: `${"word ".repeat(200_000)}urgent` };
		expect(
			evalAt(
				'contains(lower(f), "urgent") || contains(lower(f), "asap") || contains(lower(f), "help")',
				body,
			),
		).toBe(true);
	});

	it("charges scans, not just allocations — a boolean result is still work", () => {
		// `contains` returns one boolean however big the haystack, so charging only
		// on produced values would leave the scan free and the budget bypassable.
		const huge = { f: "a".repeat(1024 * 1024) };
		expect(() =>
			evalAt(`${Array(16).fill('contains(f, "zzz")').join(" || ")} || true`, huge),
		).toThrow(/too expensive/);
	});
});

// ─── Code-step interpreter ───────────────────────────────────────────

function fakeContext(input: unknown, outputs: Record<string, unknown> = {}): RunContext {
	return {
		workflowId: "wf",
		triggeredBy: "fire",
		input,
		outputs: new Map(Object.entries(outputs)),
		runChildren: async () => ({ status: WorkflowRunStatus.Succeeded, lastOutput: null }),
	};
}

const codeStep = (expression: string): WorkflowStep => ({
	id: "s1",
	kind: StepKind.Code,
	expression,
});

describe("Code step interpreter", () => {
	const code = createCoreInterpreters({} as InterpreterPorts)[StepKind.Code];

	it("is registered in the core set", () => {
		expect(code).toBeTypeOf("function");
	});

	it("evaluates the expression against input + prior outputs", async () => {
		const ctx = fakeContext({ amount: 10 }, { tax: 2 });
		const outcome = await code?.(codeStep("input.amount + tax"), ctx);
		expect(outcome).toEqual({ ok: true, output: 12 });
	});

	it("fails the step non-retriably on an expression error", async () => {
		const outcome = await code?.(codeStep("nope("), fakeContext(null));
		expect(outcome?.ok).toBe(false);
		if (outcome && !outcome.ok) expect(outcome.retriable).toBe(false);
	});

	it("scope exposes input authoritatively over a step named input", () => {
		const scope = codeExpressionScope(fakeContext("canonical", { input: "shadow" }));
		expect(scope.input).toBe("canonical");
	});
});
