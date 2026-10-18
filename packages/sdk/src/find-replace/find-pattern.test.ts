import { describe, expect, it } from "vitest";
import { DEFAULT_FIND_OPTIONS, type FindOptions } from "./find-controller";
import {
	FIND_MAX_MATCHES,
	FIND_MAX_SEGMENT_CHARS,
	FindPatternError,
	compileFindQuery,
	createFindBudget,
	expandReplacement,
	findRanges,
	unsafeRegexReason,
} from "./find-pattern";

const opts = (over: Partial<FindOptions> = {}): FindOptions => ({
	...DEFAULT_FIND_OPTIONS,
	...over,
});
const ranges = (text: string, term: string, over: Partial<FindOptions> = {}) =>
	findRanges(text, compileFindQuery({ term, options: opts(over) }), createFindBudget());

describe("compileFindQuery", () => {
	it("escapes a literal term", () => {
		expect(ranges("a.b axb", "a.b").map((r) => r.start)).toEqual([0]);
	});

	it("treats the term as a regex when asked", () => {
		expect(ranges("a.b axb", "a.b", { regex: true }).map((r) => r.start)).toEqual([0, 4]);
	});

	it("reports an invalid pattern instead of throwing", () => {
		expect(compileFindQuery({ term: "(unclosed", options: opts({ regex: true }) })).toEqual({
			ok: false,
			error: FindPatternError.Invalid,
		});
	});

	it("refuses a catastrophic pattern before it runs", () => {
		expect(compileFindQuery({ term: "(a+)+$", options: opts({ regex: true }) })).toEqual({
			ok: false,
			error: FindPatternError.Unsafe,
		});
	});

	it("honours case sensitivity and whole word in regex mode", () => {
		expect(ranges("Cat cat cats", "cat", { regex: true }).length).toBe(3);
		expect(ranges("Cat cat cats", "cat", { regex: true, caseSensitive: true }).length).toBe(2);
		expect(ranges("Cat cat cats", "cats?", { regex: true, wholeWord: true }).length).toBe(3);
		expect(ranges("Cat cat cats", "cat", { regex: true, wholeWord: true }).length).toBe(2);
	});

	it("skips zero-length matches", () => {
		expect(ranges("abc", "x*", { regex: true })).toEqual([]);
		expect(ranges("abc", "^", { regex: true })).toEqual([]);
	});
});

describe("unsafeRegexReason", () => {
	it.each([
		"(a+)+",
		"(a*)*b",
		"(x+x+)+y",
		"(a|aa)+",
		"(?:\\w+\\s?)*$",
		"((ab)*)+",
		"(a{1,})+",
		".*.*.*x",
		"\\S+\\S+\\S+!",
	])("refuses %s", (src) => {
		expect(unsafeRegexReason(src)).not.toBeNull();
	});

	it.each([
		"foo",
		"\\d{3}-\\d{4}",
		"(ab)+",
		"(a{2})*",
		"colou?r",
		"[a-z]+@[a-z]+\\.com",
		".*foo.*",
		"(?<year>\\d{4})-(?<m>\\d\\d)",
		"[(+*]+",
		"\\(a+\\)+",
	])("accepts %s", (src) => {
		expect(unsafeRegexReason(src)).toBeNull();
	});
});

describe("findRanges budget", () => {
	it("caps the number of matches and marks the search truncated", () => {
		const budget = createFindBudget();
		const out = findRanges(
			"a".repeat(FIND_MAX_MATCHES + 50),
			compileFindQuery({ term: "a", options: opts() }),
			budget,
		);
		expect(out).toHaveLength(FIND_MAX_MATCHES);
		expect(budget.exhausted).toBe(true);
	});

	it("shares one budget across segments", () => {
		const budget = createFindBudget();
		const c = compileFindQuery({ term: "a", options: opts() });
		const first = findRanges("a".repeat(FIND_MAX_MATCHES - 1), c, budget);
		const second = findRanges("aaaa", c, budget);
		expect(first.length + second.length).toBe(FIND_MAX_MATCHES);
		expect(budget.exhausted).toBe(true);
		expect(findRanges("aaaa", c, budget)).toEqual([]);
	});

	it("stops at the time budget", () => {
		let t = 0;
		const now = () => t;
		const budget = createFindBudget(now);
		const c = compileFindQuery({ term: "a", options: opts() }, () => {
			t += 10;
			return t;
		});
		const out = findRanges("a".repeat(100), c, budget);
		expect(out.length).toBeLessThan(10);
		expect(budget.exhausted).toBe(true);
	});

	it("reads at most FIND_MAX_SEGMENT_CHARS of one segment in regex mode", () => {
		const budget = createFindBudget();
		const text = `${"b".repeat(FIND_MAX_SEGMENT_CHARS)}a`;
		expect(
			findRanges(text, compileFindQuery({ term: "a", options: opts({ regex: true }) }), budget),
		).toEqual([]);
		expect(budget.exhausted).toBe(true);
	});

	it("refuses an exponential pattern outright", () => {
		expect(compileFindQuery({ term: "(a|a)*b", options: opts({ regex: true }) }).ok).toBe(false);
	});

	it("a polynomial pattern on a long segment stops at the time budget", () => {
		// `.*.*x` is cubic over a whole-string scan (~1s for 1k chars, unbounded
		// beyond); sticky per-position matching hands each position back to the
		// budget, so the search returns promptly and reports truncation.
		const c = compileFindQuery({ term: ".*.*x", options: opts({ regex: true }) });
		expect(c.ok).toBe(true);
		const budget = createFindBudget();
		const started = Date.now();
		expect(findRanges("a".repeat(FIND_MAX_SEGMENT_CHARS), c, budget)).toEqual([]);
		expect(Date.now() - started).toBeLessThan(500);
		expect(budget.exhausted).toBe(true);
	});
});

describe("expandReplacement", () => {
	const [m] = ranges("2026-10-18", "(\\d{4})-(?<month>\\d\\d)", { regex: true });

	it("expands $&, $n, $<name> and $$", () => {
		expect(m).toBeDefined();
		if (!m) return;
		expect(expandReplacement("[$&]", m)).toBe("[2026-10]");
		expect(expandReplacement("$2/$1", m)).toBe("10/2026");
		expect(expandReplacement("$<month>", m)).toBe("10");
		expect(expandReplacement("$$1", m)).toBe("$1");
		expect(expandReplacement("$9", m)).toBe("$9");
		expect(expandReplacement("$10", m)).toBe("20260");
	});

	it("is literal for a literal search", () => {
		const [lit] = ranges("x", "x");
		expect(lit && expandReplacement("$&", lit)).toBe("$&");
	});
});
