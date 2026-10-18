import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_FIND_OPTIONS,
	type FindOptions,
	type FindQuery,
	FindStatus,
	type FindStorage,
	type Match,
	type TextSearchProvider,
	createFindController,
} from "./find-controller";
import { FindPatternError } from "./find-pattern";

/** A trivial in-memory text model so the pure controller is exercised
 *  without a real editor. A `Match` here is just a `[start,end]` span. */
function fakeProvider(initial: string) {
	let text = initial;
	let seed: string | null = null;
	const calls = { reveal: 0, replaceMatch: 0, replaceAll: 0, search: 0 };
	const provider: TextSearchProvider & {
		setText(t: string): void;
		text(): string;
		setSeed(s: string | null): void;
	} = {
		get selectionRange() {
			return null;
		},
		seedTerm() {
			return seed;
		},
		setSeed(s) {
			seed = s;
		},
		search(query: FindQuery): Match[] {
			calls.search++;
			const { term, options } = query;
			if (term.length === 0) return [];
			const hay = options.caseSensitive ? text : text.toLowerCase();
			const needle = options.caseSensitive ? term : term.toLowerCase();
			const out: Match[] = [];
			let i = hay.indexOf(needle);
			while (i !== -1) {
				out.push([i, i + needle.length]);
				i = hay.indexOf(needle, i + needle.length);
			}
			return out;
		},
		revealMatch() {
			calls.reveal++;
		},
		replaceMatch(m, replacement) {
			calls.replaceMatch++;
			const [s, e] = m as [number, number];
			text = text.slice(0, s) + replacement + text.slice(e);
		},
		replaceAll(query, replacement) {
			calls.replaceAll++;
			const before = text.split(query.term).length - 1;
			text = text.split(query.term).join(replacement);
			return before;
		},
		setText(t) {
			text = t;
		},
		text() {
			return text;
		},
	};
	return { provider, calls };
}

describe("createFindController", () => {
	it("is Idle until opened; open runs search + reveals the first match", () => {
		const { provider, calls } = fakeProvider("the cat sat on the cat mat");
		const c = createFindController(provider);
		expect(c.getState().status).toBe(FindStatus.Idle);
		c.setTerm("cat"); // closed → no search yet
		expect(calls.search).toBe(0);
		c.open();
		const s = c.getState();
		expect(s.open).toBe(true);
		expect(s.status).toBe(FindStatus.Matches);
		expect(s.matchCount).toBe(2);
		expect(s.activeIndex).toBe(0);
		expect(calls.reveal).toBe(1);
	});

	it("Empty vs NoMatches status", () => {
		const { provider } = fakeProvider("abc");
		const c = createFindController(provider);
		c.open();
		expect(c.getState().status).toBe(FindStatus.Empty);
		c.setTerm("zzz");
		expect(c.getState().status).toBe(FindStatus.NoMatches);
		expect(c.getState().matchCount).toBe(0);
	});

	it("next/previous wrap around and reveal", () => {
		const { provider, calls } = fakeProvider("a a a");
		const c = createFindController(provider);
		c.open();
		c.setTerm("a"); // 3 matches, active 0
		const r0 = calls.reveal;
		c.next();
		expect(c.getState().activeIndex).toBe(1);
		c.next();
		c.next(); // wraps 2 → 0
		expect(c.getState().activeIndex).toBe(0);
		c.previous(); // wraps 0 → 2
		expect(c.getState().activeIndex).toBe(2);
		expect(calls.reveal).toBe(r0 + 4);
	});

	it("setOptions re-runs search (case-sensitive narrows)", () => {
		const { provider } = fakeProvider("Cat cat CAT");
		const c = createFindController(provider);
		c.open();
		c.setTerm("cat");
		expect(c.getState().matchCount).toBe(3); // case-insensitive
		c.setOptions({ caseSensitive: true });
		expect(c.getState().matchCount).toBe(1);
	});

	it("replace edits via the provider, re-searches, and marches the cursor forward", () => {
		const { provider, calls } = fakeProvider("x x x");
		const c = createFindController(provider);
		c.open();
		c.setTerm("x"); // 3 matches
		c.next(); // active 1
		c.replace("y");
		expect(calls.replaceMatch).toBe(1);
		expect(provider.text()).toBe("x y x");
		expect(c.getState().matchCount).toBe(2); // re-derived
		expect(c.getState().activeIndex).toBe(1); // clamped, marches on
	});

	it("replaceAll is one provider call, returns count, recounts (→ 0)", () => {
		const { provider, calls } = fakeProvider("dog dog dog");
		const c = createFindController(provider);
		c.open();
		c.setTerm("dog");
		const n = c.replaceAll("cow");
		expect(n).toBe(3);
		expect(calls.replaceAll).toBe(1);
		expect(provider.text()).toBe("cow cow cow");
		expect(c.getState().matchCount).toBe(0);
		expect(c.getState().status).toBe(FindStatus.NoMatches);
	});

	it("close clears matches; reopening re-derives", () => {
		const { provider } = fakeProvider("hi hi");
		const c = createFindController(provider);
		c.open();
		c.setTerm("hi");
		expect(c.getState().matchCount).toBe(2);
		c.close();
		expect(c.getState().status).toBe(FindStatus.Idle);
		expect(c.getState().matchCount).toBe(0);
		c.open();
		expect(c.getState().matchCount).toBe(2); // term retained, re-searched
	});

	it("subscribe fires on state changes; unsubscribe stops it", () => {
		const { provider } = fakeProvider("aaa");
		const c = createFindController(provider);
		const spy = vi.fn();
		const off = c.subscribe(spy);
		c.open();
		c.setTerm("a");
		expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
		const n = spy.mock.calls.length;
		off();
		c.next();
		expect(spy.mock.calls.length).toBe(n);
	});

	it("persists term + options and restores them on a new controller", () => {
		const store = new Map<string, string>();
		const storage: FindStorage = {
			getItem: (k) => store.get(k) ?? null,
			setItem: (k, v) => {
				store.set(k, v);
			},
		};
		const a = createFindController(fakeProvider("foo foo").provider, {
			persist: { key: "notes:find", storage },
		});
		a.setTerm("foo");
		a.setOptions({ wholeWord: true });

		const b = createFindController(fakeProvider("foo foo").provider, {
			persist: { key: "notes:find", storage },
		});
		expect(b.getState().term).toBe("foo");
		expect(b.getState().options.wholeWord).toBe(true);
		// Unknown/blank key → clean defaults, never throws.
		const c = createFindController(fakeProvider("").provider, {
			persist: { key: "absent", storage },
		});
		expect(c.getState().term).toBe("");
		expect(c.getState().options).toEqual(DEFAULT_FIND_OPTIONS);
	});

	it("a corrupt persisted blob degrades to defaults", () => {
		const storage: FindStorage = {
			getItem: () => "{not json",
			setItem: () => undefined,
		};
		const c = createFindController(fakeProvider("z").provider, {
			persist: { key: "x", storage },
		});
		expect(c.getState().term).toBe("");
		expect(c.getState().options).toEqual<FindOptions>(DEFAULT_FIND_OPTIONS);
	});

	describe("OQ-FR-4 seed-from-selection", () => {
		it("prefills the term from the provider's seed on open + searches it", () => {
			const { provider, calls } = fakeProvider("the cat sat on the cat mat");
			provider.setSeed("cat");
			const c = createFindController(provider);
			c.open();
			expect(c.getState().term).toBe("cat");
			expect(c.getState().matchCount).toBe(2);
			expect(calls.search).toBeGreaterThan(0);
		});

		it("leaves the prior/persisted term when there's no seed (null)", () => {
			const storage: FindStorage = {
				getItem: () => JSON.stringify({ term: "mat", options: DEFAULT_FIND_OPTIONS }),
				setItem: () => undefined,
			};
			const { provider } = fakeProvider("the cat sat on the cat mat");
			provider.setSeed(null);
			const c = createFindController(provider, { persist: { key: "k", storage } });
			c.open();
			expect(c.getState().term).toBe("mat"); // persisted term survives
		});

		it("only seeds on the open transition, not while already open", () => {
			const { provider } = fakeProvider("alpha beta");
			provider.setSeed("alpha");
			const c = createFindController(provider);
			c.open();
			expect(c.getState().term).toBe("alpha");
			// User edits the term, then a re-`open()` (already open) must not
			// clobber it back to the stale selection seed.
			c.setTerm("beta");
			provider.setSeed("alpha");
			c.open();
			expect(c.getState().term).toBe("beta");
		});

		it("tolerates a provider without a seedTerm method", () => {
			const base = fakeProvider("plain").provider;
			const noSeed: typeof base = { ...base };
			(noSeed as { seedTerm?: unknown }).seedTerm = undefined;
			const c = createFindController(noSeed);
			expect(() => c.open()).not.toThrow();
			expect(c.getState().term).toBe("");
		});
	});

	describe("regex (B11.27)", () => {
		it("an invalid pattern reports InvalidPattern without calling the provider", () => {
			const { provider, calls } = fakeProvider("abc");
			const c = createFindController(provider);
			c.open();
			c.setOptions({ regex: true });
			const before = calls.search;
			c.setTerm("(abc");
			expect(c.getState().status).toBe(FindStatus.InvalidPattern);
			expect(c.getState().patternError).toBe(FindPatternError.Invalid);
			expect(calls.search).toBe(before);
			expect(c.replaceAll("x")).toBe(0);
		});

		it("an unsafe pattern is refused before it runs", () => {
			const { provider } = fakeProvider("aaaa");
			const c = createFindController(provider);
			c.open();
			c.setOptions({ regex: true });
			c.setTerm("(a+)+$");
			expect(c.getState().patternError).toBe(FindPatternError.Unsafe);
			c.setTerm("a+");
			expect(c.getState().patternError).toBeNull();
		});

		it("hands the provider a budget and surfaces truncation", () => {
			const { provider } = fakeProvider("aaa");
			const seen: FindQuery[] = [];
			const search = provider.search.bind(provider);
			provider.search = (query) => {
				seen.push(query);
				if (query.budget) query.budget.exhausted = true;
				return search(query);
			};
			const c = createFindController(provider);
			c.open();
			c.setTerm("a");
			expect(seen.at(-1)?.budget).toBeDefined();
			expect(c.getState().truncated).toBe(true);
		});
	});
});
