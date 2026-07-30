/**
 * SH-14 keystone — the pure buffer scanner.
 *
 * Given a code buffer and a {@link CitationIndex}, find every span that
 * resolves to a plan iteration or open question. The match set is built
 * *from the index keys themselves* (escaped, longest-first), not a
 * hand-written code grammar — so an exotic code shape (`9.3.5.N-notes.4`)
 * resolves iff it really exists in the plan, and arbitrary version-like
 * tokens (`1.0.0`, a date `2026.05.18`) never false-positive because
 * they aren't keys.
 *
 * Boundary lookarounds keep a code from matching inside a larger token
 * (a path segment, an identifier) so `v9.13.1` in a filename doesn't
 * light up as iteration `9.13.1`.
 */

import { type CitationEntry, type CitationIndex, normalizeCode } from "./citation-index";

export interface CitationSpan {
	/** Inclusive start offset into the scanned text. */
	start: number;
	/** Exclusive end offset. */
	end: number;
	/** The substring exactly as it appears in the buffer. */
	code: string;
	entry: CitationEntry;
}

export interface CitationReference {
	entry: CitationEntry;
	/** Number of times the code appears in the buffer. */
	count: number;
	/** Offset of the first occurrence (drives the panel ordering). */
	firstOffset: number;
	/** 1-based line of the first occurrence (for a future "go to" jump). */
	firstLine: number;
}

function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A token char — used in the boundary lookarounds. Codes legitimately
 *  contain `.` and `-`, so a citation is only "standalone" when it is
 *  not flanked by word chars, dots, hyphens, or path separators. */
const BOUNDARY = "[\\w.\\-/]";

/** Compiled patterns, keyed on the index they were built from. The
 *  alternation spans every citable code in the vault, so rebuilding it per
 *  scan dominated the cost of a scan — and the overlay scans on every
 *  keystroke. The index is rebuilt (never mutated) by `buildCitationIndex`,
 *  so identity is a sound cache key. */
const PATTERN_CACHE = new WeakMap<object, RegExp | null>();

function buildPattern(index: CitationIndex): RegExp | null {
	const cached = PATTERN_CACHE.get(index);
	if (cached !== undefined) return cached;
	const pattern = compilePattern(index);
	PATTERN_CACHE.set(index, pattern);
	return pattern;
}

function compilePattern(index: CitationIndex): RegExp | null {
	if (index.size === 0) return null;
	const keys = [...index.keys()].sort((a, b) => b.length - a.length);
	const alternation = keys.map(escapeRegExp).join("|");
	return new RegExp(`(?<!${BOUNDARY})(?:${alternation})(?!${BOUNDARY})`, "gi");
}

/**
 * Every resolved citation span in document order. Each match is
 * re-resolved through the index (case-folded) so the returned `entry`
 * is always the canonical one even when the buffer used a different case.
 */
export function scanCitations(text: string, index: CitationIndex): CitationSpan[] {
	// Safe against the cache: `matchAll` iterates a clone of the regexp, so the
	// shared instance's `lastIndex` never advances between scans.
	const pattern = buildPattern(index);
	if (!pattern || text.length === 0) return [];
	const spans: CitationSpan[] = [];
	for (const match of text.matchAll(pattern)) {
		const code = match[0];
		const entry = index.get(normalizeCode(code));
		if (!entry) continue;
		const start = match.index;
		spans.push({ start, end: start + code.length, code, entry });
	}
	return spans;
}

/**
 * Unique references for the panel: one row per cited entity, ordered by
 * first appearance, carrying an occurrence count and the line of the
 * first hit.
 */
export function collectReferences(text: string, index: CitationIndex): CitationReference[] {
	const byKey = new Map<string, CitationReference>();
	for (const span of scanCitations(text, index)) {
		const existing = byKey.get(span.entry.key);
		if (existing) {
			existing.count += 1;
			continue;
		}
		byKey.set(span.entry.key, {
			entry: span.entry,
			count: 1,
			firstOffset: span.start,
			firstLine: lineAtOffset(text, span.start),
		});
	}
	return [...byKey.values()].sort((a, b) => a.firstOffset - b.firstOffset);
}

/** 1-based line number containing `offset` (newline count + 1). */
export function lineAtOffset(text: string, offset: number): number {
	let line = 1;
	const limit = Math.min(offset, text.length);
	for (let i = 0; i < limit; i++) {
		if (text.charCodeAt(i) === 10 /* \n */) line += 1;
	}
	return line;
}
