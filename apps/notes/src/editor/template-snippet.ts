/**
 * Pure helpers behind the Notes template surfaces (B11.10 surface #2):
 * turning a mixed `Template/v1` query into the block-snippet options the
 * `/template` picker inserts, and deriving a snippet template's name from the
 * captured selection's first block. Kept dependency-free (no editor / shell)
 * so the filtering + naming rules are unit-tested without a real shell — the
 * picker + menu interactions themselves are real-shell dogfood-gated.
 */

import type { Template } from "@brainstorm-os/sdk-types";
import { snippetFromTemplate } from "@brainstorm-os/sdk/templates";

/** A block-snippet template reduced to what the `/template` picker renders and
 *  inserts: its display name, the serialized-blocks JSON fragment, and its
 *  optional icon (block-snippets carry none today, but the shape mirrors the
 *  codec so a future authored icon flows through untouched). */
export type SnippetOption = {
	id: string;
	name: string;
	snippet: string;
	icon: Template["icon"];
};

/** Keep only the block-snippet templates that carry an insertable fragment, in
 *  the order given. Object templates — and snippet rows whose fragment is
 *  missing / empty / malformed — drop out (`snippetFromTemplate` returns
 *  `null`). Pure: the async `entities.query` + `entityToTemplate` mapping stays
 *  at the call site so this is trivially testable. */
export function templatesToSnippetOptions(templates: readonly Template[]): SnippetOption[] {
	const options: SnippetOption[] = [];
	for (const template of templates) {
		const snippet = snippetFromTemplate(template);
		if (snippet === null) continue;
		options.push({ id: template.id, name: template.name, snippet, icon: template.icon });
	}
	return options;
}

/** Longest a derived snippet-template name runs before truncation. */
export const SNIPPET_NAME_MAX = 60;

/** Derive a block-snippet template name from the first selected block's text:
 *  whitespace collapsed + trimmed, then truncated to `maxLen` chars. A blank
 *  selection falls back to `fallback` — a caller-supplied, already-localised
 *  default (so this helper stays i18n-free). */
export function deriveSnippetName(
	firstBlockText: string,
	fallback: string,
	maxLen: number = SNIPPET_NAME_MAX,
): string {
	const cleaned = firstBlockText.replace(/\s+/g, " ").trim();
	if (cleaned === "") return fallback;
	return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trimEnd() : cleaned;
}
