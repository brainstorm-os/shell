/**
 * clip-plain-text — single source of truth for the body snippet
 * clip-and-ellipsis primitive shared by every `@brainstorm-os/editor`
 * consumer's autosave denormaliser and list/preview fallbacks. The
 * whitespace-collapse pass is idempotent on already-collapsed input (a
 * producer like `extractPlainText` that already collapses doesn't
 * double-pay; callers fed raw text get the same answer).
 */

export const DEFAULT_SNIPPET_LENGTH = 120 as const;

export function clipPlainText(text: string, maxChars: number = DEFAULT_SNIPPET_LENGTH): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return "";
	if (collapsed.length <= maxChars) return collapsed;
	return `${collapsed.slice(0, maxChars).trimEnd()}…`;
}
