/**
 * `TextSearchProvider` for the code pane (B9.3-code-editor) — bridges
 * the shared FindController to the textarea + Y.Text buffer through a
 * thin host interface, with `logic/find-search.ts` (the
 * `@codemirror/search` wrapper) as the matching engine. The pane owns
 * the DOM; this file owns the provider semantics, so the whole contract
 * is testable against a fake host.
 */

import {
	FIND_SEED_MAX_LEN,
	type FindQuery,
	type ModelRange,
	type TextSearchProvider,
} from "@brainstorm-os/sdk/find-replace";
import {
	type CodeMatch,
	type SearchScope,
	replaceAllInContent,
	searchCode,
} from "../logic/find-search";

export interface CodeFindHost {
	/** The authoritative buffer text (the Y.Text snapshot / textarea value). */
	getContent(): string;
	/** Current textarea selection, in absolute offsets (start ≤ end). */
	getSelection(): { start: number; end: number };
	/** Select a range in the textarea + scroll its line into view. Must
	 *  NOT steal focus — the user is typing in the find input. */
	revealRange(from: number, to: number): void;
	/** Replace `[from, to)` with `replacement` through the pane's ONE
	 *  edit path (textarea write + input dispatch → Y.Text diff). */
	replaceRange(from: number, to: number, replacement: string): void;
	/** Replace the whole buffer in one edit (replace-all commit). */
	setContent(content: string): void;
	/** Paint the match decorations into the highlight overlay. */
	setMatches(matches: readonly CodeMatch[], active: CodeMatch | null): void;
}

export interface CodeSearchProvider extends TextSearchProvider {
	/** Drop decorations + the in-selection scope (bar closed / file switch). */
	clear(): void;
}

export function createCodeSearchProvider(host: CodeFindHost): CodeSearchProvider {
	// "In selection" scope, captured when the option turns on (so stepping
	// through matches — which moves the textarea selection — doesn't
	// shrink the scope to the active match). Cleared when the option turns
	// off or the provider is cleared.
	let scope: SearchScope | null = null;
	let scopeActive = false;
	let lastMatches: CodeMatch[] = [];

	function resolveScope(query: FindQuery): SearchScope | null {
		if (!query.options.inSelection) {
			scope = null;
			scopeActive = false;
			return null;
		}
		if (!scopeActive) {
			const sel = host.getSelection();
			scope = sel.end > sel.start ? { from: sel.start, to: sel.end } : null;
			scopeActive = true;
		}
		return scope;
	}

	return {
		search(query) {
			const content = host.getContent();
			lastMatches = searchCode(content, query, resolveScope(query));
			host.setMatches(lastMatches, null);
			return lastMatches;
		},
		revealMatch(match) {
			const m = match as CodeMatch;
			host.setMatches(lastMatches, m);
			host.revealRange(m.from, m.to);
		},
		replaceMatch(match, replacement) {
			const m = match as CodeMatch;
			host.replaceRange(m.from, m.to, replacement);
		},
		replaceAll(query, replacement) {
			const content = host.getContent();
			const result = replaceAllInContent(content, query, replacement, resolveScope(query));
			if (result.count > 0) host.setContent(result.content);
			return result.count;
		},
		get selectionRange(): ModelRange | null {
			const sel = host.getSelection();
			return sel.end > sel.start ? ({ from: sel.start, to: sel.end } satisfies SearchScope) : null;
		},
		seedTerm() {
			const sel = host.getSelection();
			if (sel.end <= sel.start) return null;
			const text = host.getContent().slice(sel.start, sel.end);
			if (text.length === 0 || text.length > FIND_SEED_MAX_LEN) return null;
			if (text.includes("\n")) return null;
			return text;
		},
		clear() {
			scope = null;
			scopeActive = false;
			lastMatches = [];
			host.setMatches([], null);
		},
	};
}
