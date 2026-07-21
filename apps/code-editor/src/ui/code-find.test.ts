/**
 * B9.3 — the code pane's `TextSearchProvider` semantics over a fake
 * host: decoration fan-out, reveal, single + bulk replace, the
 * captured in-selection scope, and the seed-term contract.
 */
import { DEFAULT_FIND_OPTIONS, type FindQuery } from "@brainstorm-os/sdk/find-replace";
import { describe, expect, it } from "vitest";
import type { CodeMatch } from "../logic/find-search";
import { type CodeFindHost, createCodeSearchProvider } from "./code-find";

function makeHost(initial: string) {
	let content = initial;
	let selection = { start: 0, end: 0 };
	const calls: string[] = [];
	let painted: { matches: readonly CodeMatch[]; active: CodeMatch | null } = {
		matches: [],
		active: null,
	};
	const host: CodeFindHost = {
		getContent: () => content,
		getSelection: () => selection,
		revealRange: (from, to) => {
			calls.push(`reveal:${from}-${to}`);
			selection = { start: from, end: to };
		},
		replaceRange: (from, to, replacement) => {
			content = content.slice(0, from) + replacement + content.slice(to);
		},
		setContent: (next) => {
			content = next;
		},
		setMatches: (matches, active) => {
			painted = { matches, active };
		},
	};
	return {
		host,
		calls,
		getContent: () => content,
		getPainted: () => painted,
		setSelection: (start: number, end: number) => {
			selection = { start, end };
		},
	};
}

function query(term: string, options: Partial<typeof DEFAULT_FIND_OPTIONS> = {}): FindQuery {
	return { term, options: { ...DEFAULT_FIND_OPTIONS, ...options } };
}

describe("createCodeSearchProvider", () => {
	it("search paints every match (no active yet) and returns the handles", () => {
		const h = makeHost("foo bar foo");
		const provider = createCodeSearchProvider(h.host);
		const matches = provider.search(query("foo"));
		expect(matches).toHaveLength(2);
		expect(h.getPainted().matches).toHaveLength(2);
		expect(h.getPainted().active).toBeNull();
	});

	it("revealMatch repaints with the active match and reveals its range", () => {
		const h = makeHost("foo bar foo");
		const provider = createCodeSearchProvider(h.host);
		const matches = provider.search(query("foo"));
		provider.revealMatch(matches[1]);
		expect(h.getPainted().active).toEqual({ from: 8, to: 11 });
		expect(h.calls).toContain("reveal:8-11");
	});

	it("replaceMatch routes one edit through the host", () => {
		const h = makeHost("foo bar foo");
		const provider = createCodeSearchProvider(h.host);
		const matches = provider.search(query("foo"));
		provider.replaceMatch(matches[0], "qux");
		expect(h.getContent()).toBe("qux bar foo");
	});

	it("replaceAll commits ONE content write and returns the count", () => {
		const h = makeHost("a b a b a");
		const provider = createCodeSearchProvider(h.host);
		expect(provider.replaceAll(query("a"), "Z")).toBe(3);
		expect(h.getContent()).toBe("Z b Z b Z");
		expect(provider.replaceAll(query("missing"), "Z")).toBe(0);
	});

	it("captures the in-selection scope when the option turns on, and keeps it while stepping", () => {
		const h = makeHost("foo foo foo");
		const provider = createCodeSearchProvider(h.host);
		h.setSelection(3, 9);
		const scoped = provider.search(query("foo", { inSelection: true }));
		expect(scoped).toEqual([{ from: 4, to: 7 }]);
		// Revealing moves the host selection to the match — the captured
		// scope must NOT shrink to it on the next search.
		provider.revealMatch(scoped[0]);
		expect(provider.search(query("foo", { inSelection: true }))).toEqual([{ from: 4, to: 7 }]);
		// Turning the option off restores the full-buffer search AND drops
		// the captured scope for the next capture.
		expect(provider.search(query("foo"))).toHaveLength(3);
	});

	it("seedTerm returns a short single-line selection, else null", () => {
		const h = makeHost("alpha beta\ngamma");
		const provider = createCodeSearchProvider(h.host);
		expect(provider.seedTerm?.()).toBeNull();
		h.setSelection(0, 5);
		expect(provider.seedTerm?.()).toBe("alpha");
		h.setSelection(6, 16);
		expect(provider.seedTerm?.()).toBeNull();
	});

	it("selectionRange reflects a ranged selection only", () => {
		const h = makeHost("abc");
		const provider = createCodeSearchProvider(h.host);
		expect(provider.selectionRange).toBeNull();
		h.setSelection(1, 3);
		expect(provider.selectionRange).toEqual({ from: 1, to: 3 });
	});

	it("clear drops decorations and the captured scope", () => {
		const h = makeHost("foo foo");
		const provider = createCodeSearchProvider(h.host);
		h.setSelection(0, 3);
		provider.search(query("foo", { inSelection: true }));
		provider.clear();
		expect(h.getPainted().matches).toHaveLength(0);
		h.setSelection(4, 7);
		// A fresh capture uses the NEW selection, proving the old scope died.
		expect(provider.search(query("foo", { inSelection: true }))).toEqual([{ from: 4, to: 7 }]);
	});
});
