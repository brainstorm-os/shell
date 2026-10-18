/**
 * Find pattern engine (B11.27, resolves OQ-FR-1) — the one place a find
 * term becomes a matcher, shared by every `TextSearchProvider` that walks a
 * text model (Lexical, the DOM provider). Literal and regex terms go
 * through the same bounded loop.
 *
 * Why a budget: a find runs synchronously on the renderer's main thread on
 * every keystroke, and a user-typed regex can backtrack catastrophically.
 * JavaScript cannot interrupt a single `RegExp.exec`, so safety is layered:
 *   1. `unsafeRegexReason` statically rejects the shapes that backtrack
 *      exponentially (a quantified group holding an unbounded quantifier or
 *      an alternation) and the polynomial "three greedy wildcards" shape.
 *   2. Matching runs per text segment (one Lexical text node), capped at
 *      `FIND_MAX_SEGMENT_CHARS`, and a regex is run *sticky*, one start
 *      position per `exec` — so the engine's own scan over start positions
 *      (where a polynomial pattern like `.*.*x` spends its cubic time) is
 *      our loop, and the budget is checked between positions.
 *   3. A per-search `FindBudget` caps total matches, `exec` steps and wall
 *      time; an exhausted budget stops the walk and reports `truncated`.
 *  The residual worst case is one `exec` from one position: quadratic in
 *  the segment cap for the accepted two-wildcard shapes (~tens of ms).
 */

import type { FindQuery } from "./find-controller";

export enum FindPatternError {
	/** The term is not a valid regular expression. */
	Invalid = "invalid",
	/** Valid, but shaped to backtrack catastrophically — refused. */
	Unsafe = "unsafe",
}

/** Matches past this are not collected; the count reads "1000+". */
export const FIND_MAX_MATCHES = 1000;
/** Total `exec` calls one search may make across every segment. */
export const FIND_MAX_STEPS = 200_000;
/** Wall-time budget for one search, checked between `exec` calls. */
export const FIND_TIME_BUDGET_MS = 60;
/** Regex mode reads at most this many chars of one segment. */
export const FIND_MAX_SEGMENT_CHARS = 5_000;

export type FindBudget = {
	matches: number;
	steps: number;
	readonly deadline: number;
	exhausted: boolean;
};

export function createFindBudget(now: () => number = Date.now): FindBudget {
	return { matches: 0, steps: 0, deadline: now() + FIND_TIME_BUDGET_MS, exhausted: false };
}

export type CompiledFind =
	| { ok: true; re: RegExp; regex: boolean; wholeWord: boolean; now: () => number }
	| { ok: false; error: FindPatternError };

export type FindRange = {
	start: number;
	end: number;
	/** Regex mode only — `$1…$n` sources for the replacement. */
	captures?: readonly (string | undefined)[];
	groups?: Readonly<Record<string, string | undefined>>;
	/** Regex mode only — `$&`. */
	matched?: string;
};

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Frame = { unbounded: boolean; alternation: boolean };

type Prev = { group: Frame } | { broad: boolean } | null;

/** `[length, unbounded]` of the quantifier at `j`, or `null` if none. */
function quantifierAt(source: string, j: number): [number, boolean] | null {
	const c = source[j];
	let len = 0;
	let unbounded = false;
	if (c === "*" || c === "+") {
		len = 1;
		unbounded = true;
	} else if (c === "?") {
		len = 1;
	} else if (c === "{") {
		const m = /^\{\d+(,(\d*))?\}/.exec(source.slice(j));
		if (!m) return null;
		len = m[0].length;
		unbounded = m[1] !== undefined && (m[2] ?? "") === "";
	} else {
		return null;
	}
	if (source[j + len] === "?") len++;
	return [len, unbounded];
}

/** Length of a group opener at `j` (`(`, `(?:`, `(?=`, `(?<name>` …). */
function groupOpenLength(source: string, j: number): number {
	if (source[j + 1] !== "?") return 1;
	if (source[j + 2] === "<" && source[j + 3] !== "=" && source[j + 3] !== "!") {
		const close = source.indexOf(">", j);
		return close === -1 ? 3 : close - j + 1;
	}
	return source[j + 2] === "<" ? 4 : 3;
}

/** Null when the pattern is safe to run on the main thread, else why not.
 *  A conservative scanner over the source — it may refuse an exotic safe
 *  pattern (`(foo|bar)+`), never accept a nested-quantifier one. */
export function unsafeRegexReason(source: string): string | null {
	const stack: Frame[] = [{ unbounded: false, alternation: false }];
	let broadUnbounded = 0;
	let prev: Prev = null;
	let i = 0;
	while (i < source.length) {
		const c = source[i];
		const top = stack[stack.length - 1] as Frame;
		const q = quantifierAt(source, i);
		if (q && prev !== null) {
			const [len, unbounded] = q;
			if (unbounded) {
				if ("group" in prev && (prev.group.unbounded || prev.group.alternation)) {
					return "nested-quantifier";
				}
				if ("broad" in prev && prev.broad && ++broadUnbounded >= 3) return "greedy-wildcards";
				top.unbounded = true;
			}
			prev = null;
			i += len;
			continue;
		}
		if (c === "\\") {
			prev = { broad: /[SsWwDd]/.test(source[i + 1] ?? "") };
			i += 2;
		} else if (c === "[") {
			prev = { broad: source[i + 1] === "^" };
			let j = i + 1;
			if (source[j] === "^") j++;
			if (source[j] === "]") j++;
			while (j < source.length && source[j] !== "]") j += source[j] === "\\" ? 2 : 1;
			i = j + 1;
		} else if (c === "(") {
			stack.push({ unbounded: false, alternation: false });
			prev = null;
			i += groupOpenLength(source, i);
		} else if (c === ")" && stack.length > 1) {
			const group = stack.pop() as Frame;
			const parent = stack[stack.length - 1] as Frame;
			parent.unbounded ||= group.unbounded;
			parent.alternation ||= group.alternation;
			prev = { group };
			i += 1;
		} else if (c === "|") {
			top.alternation = true;
			prev = null;
			i += 1;
		} else {
			prev = { broad: c === "." };
			i += 1;
		}
	}
	return null;
}

export function compileFindQuery(
	query: Pick<FindQuery, "term" | "options">,
	now: () => number = Date.now,
): CompiledFind {
	const { term, options } = query;
	const flags = options.caseSensitive ? "gu" : "giu";
	if (!options.regex) {
		return {
			ok: true,
			re: new RegExp(escapeRegExp(term), flags),
			regex: false,
			wholeWord: options.wholeWord,
			now,
		};
	}
	let re: RegExp;
	try {
		re = new RegExp(term, flags);
	} catch {
		return { ok: false, error: FindPatternError.Invalid };
	}
	if (unsafeRegexReason(term) !== null) return { ok: false, error: FindPatternError.Unsafe };
	return { ok: true, re, regex: true, wholeWord: options.wholeWord, now };
}

const WORD = /[\p{L}\p{N}_]/u;

function isWordBoundary(text: string, start: number, end: number): boolean {
	const before = start > 0 ? text[start - 1] : "";
	const after = end < text.length ? text[end] : "";
	return !(before && WORD.test(before)) && !(after && WORD.test(after));
}

/** Non-overlapping, non-empty ranges of the compiled term in `text`,
 *  charged to `budget`. Stops early (setting `budget.exhausted`) the moment
 *  any cap is hit. */
export function findRanges(text: string, compiled: CompiledFind, budget: FindBudget): FindRange[] {
	if (!compiled.ok || budget.exhausted) return [];
	const hay =
		compiled.regex && text.length > FIND_MAX_SEGMENT_CHARS
			? text.slice(0, FIND_MAX_SEGMENT_CHARS)
			: text;
	if (hay.length < text.length) budget.exhausted = true;
	const re = new RegExp(
		compiled.re.source,
		compiled.regex ? `${compiled.re.flags}y` : compiled.re.flags,
	);
	const out: FindRange[] = [];
	let pos = 0;
	while (pos <= hay.length) {
		if (budget.steps >= FIND_MAX_STEPS || compiled.now() > budget.deadline) {
			budget.exhausted = true;
			break;
		}
		budget.steps++;
		re.lastIndex = pos;
		const m = re.exec(hay);
		if (!m) {
			if (!compiled.regex) break;
			pos++;
			continue;
		}
		const matched = m[0];
		const start = m.index;
		const end = start + matched.length;
		if (matched.length === 0) {
			pos = start + 1;
			continue;
		}
		pos = end;
		if (compiled.wholeWord && !isWordBoundary(hay, start, end)) {
			if (compiled.regex) pos = start + 1;
			continue;
		}
		if (budget.matches >= FIND_MAX_MATCHES) {
			budget.exhausted = true;
			break;
		}
		budget.matches++;
		out.push(
			compiled.regex
				? {
						start,
						end,
						matched,
						captures: m.slice(1),
						...(m.groups ? { groups: { ...m.groups } } : {}),
					}
				: { start, end },
		);
	}
	return out;
}

/** The text a replace writes for `range`: literal for a literal search;
 *  for a regex search, `$&` / `$1…$99` / `$<name>` / `$$` expand. */
export function expandReplacement(replacement: string, range: FindRange): string {
	if (range.captures === undefined) return replacement;
	const captures = range.captures;
	return replacement.replace(/\$(\$|&|<([^>]*)>|(\d{1,2}))/g, (whole, token, name, digits) => {
		if (token === "$") return "$";
		if (token === "&") return range.matched ?? "";
		if (name !== undefined) {
			if (!range.groups || !(name in range.groups)) return whole;
			return range.groups[name] ?? "";
		}
		const two = Number(digits);
		if (two >= 1 && two <= captures.length) return captures[two - 1] ?? "";
		const one = Number(String(digits).slice(0, 1));
		if (String(digits).length === 2 && one >= 1 && one <= captures.length) {
			return (captures[one - 1] ?? "") + String(digits).slice(1);
		}
		return whole;
	});
}
