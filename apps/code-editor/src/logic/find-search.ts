/**
 * Find engine for the code buffer (B9.3-code-editor).
 *
 * `@codemirror/search` is wrapped STRICTLY as the matching engine behind
 * the shared `<FindBar>` — CodeMirror's own panel is never surfaced
 * (consistent-interface decision, OQ-FR-2). `SearchCursor` handles
 * literal terms (with lowercase normalisation for case-insensitive
 * search) and `RegExpCursor` handles the regex option; both walk a
 * `Text` built from the live buffer string. Pure — no DOM, fully
 * unit-testable; the provider in `ui/code-find.ts` owns the textarea /
 * overlay side.
 */

import type { FindQuery } from "@brainstorm-os/sdk/find-replace";
import { RegExpCursor, SearchCursor } from "@codemirror/search";
import { Text } from "@codemirror/state";

/** A match over the buffer, in absolute character offsets. The opaque
 *  `Match` handle the shared FindController carries is exactly this. */
export interface CodeMatch {
	from: number;
	to: number;
}

/** Inclusive-start / exclusive-end search scope ("in selection"). */
export interface SearchScope {
	from: number;
	to: number;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordBoundary(content: string, from: number, to: number): boolean {
	const before = from > 0 ? content.charAt(from - 1) : "";
	const after = to < content.length ? content.charAt(to) : "";
	const startsWord = from < to && WORD_CHAR.test(content.charAt(from));
	const endsWord = from < to && WORD_CHAR.test(content.charAt(to - 1));
	if (startsWord && before && WORD_CHAR.test(before)) return false;
	if (endsWord && after && WORD_CHAR.test(after)) return false;
	return true;
}

/**
 * All matches of `query` inside `content`, optionally restricted to
 * `scope`. An invalid regex (while the user is mid-typing one) yields
 * zero matches rather than throwing — the FindBar shows "No results".
 */
export function searchCode(
	content: string,
	query: FindQuery,
	scope?: SearchScope | null,
): CodeMatch[] {
	const { term, options } = query;
	if (term.length === 0) return [];
	const doc = Text.of(content.split("\n"));
	const from = Math.max(0, scope?.from ?? 0);
	const to = Math.min(content.length, scope?.to ?? content.length);
	if (from >= to) return [];
	const matches: CodeMatch[] = [];
	try {
		if (options.regex) {
			const cursor = new RegExpCursor(doc, term, { ignoreCase: !options.caseSensitive }, from, to);
			while (!cursor.next().done) {
				const { from: mFrom, to: mTo } = cursor.value;
				if (mTo > mFrom) matches.push({ from: mFrom, to: mTo });
			}
		} else {
			const normalize = options.caseSensitive ? undefined : (s: string) => s.toLowerCase();
			const cursor = new SearchCursor(doc, term, from, to, normalize);
			while (!cursor.next().done) {
				matches.push({ from: cursor.value.from, to: cursor.value.to });
			}
		}
	} catch {
		// Mid-typed / invalid regex — treat as "no matches", never throw
		// into the controller's keystroke path.
		return [];
	}
	if (!options.wholeWord) return matches;
	return matches.filter((m) => isWordBoundary(content, m.from, m.to));
}

/**
 * Replace every match of `query` in `content` with the literal
 * `replacement` (the controller contract is literal replacement — group
 * substitution is OQ-FR-1 follow-on territory). Returns the new content
 * plus the count, so the caller can commit ONE buffer write (one Y.Text
 * transaction / one undo step).
 */
export function replaceAllInContent(
	content: string,
	query: FindQuery,
	replacement: string,
	scope?: SearchScope | null,
): { content: string; count: number } {
	const matches = searchCode(content, query, scope);
	if (matches.length === 0) return { content, count: 0 };
	let out = "";
	let cursor = 0;
	for (const m of matches) {
		out += content.slice(cursor, m.from) + replacement;
		cursor = m.to;
	}
	out += content.slice(cursor);
	return { content: out, count: matches.length };
}
