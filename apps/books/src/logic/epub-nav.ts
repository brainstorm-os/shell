/**
 * EPUB navigation (NCX / nav-doc) → per-section chapter titles. Split out of
 * the epub.js glue so the href matching — the part that actually varies between
 * producers — is pure and unit-testable without an archive.
 *
 * The matching is deliberately forgiving: a nav entry's `href` and a spine
 * item's `href` are both relative to the OPF, but producers disagree about
 * `./` prefixes, percent-encoding, and fragments (`content_1.html#ch1`), so
 * entries are indexed under both their normalized path and their bare
 * filename.
 */

/** One entry of an epub.js `navigation.toc` (recursive). */
export type NavEntry = {
	href?: string;
	label?: string;
	subitems?: readonly NavEntry[];
};

function decode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** Strip the fragment and any leading `./` or `/`, then percent-decode. */
export function normalizeHref(href: string): string {
	const path = href.split("#")[0] ?? "";
	return decode(path.replace(/^\.?\//, ""));
}

/** The bare filename of an href — the last-resort key when two producers
 *  disagree about how deep the path is. */
function basename(path: string): string {
	return path.split("/").pop() ?? path;
}

/**
 * Flatten a nav tree into a lookup of href → label. Each entry is registered
 * under its normalized path AND its bare filename; the first entry to claim a
 * key wins, so a chapter's own top-level label beats a deep sub-heading that
 * points into the same file.
 */
export function navigationTitles(toc: readonly NavEntry[]): ReadonlyMap<string, string> {
	const titles = new Map<string, string>();
	const walk = (entries: readonly NavEntry[]): void => {
		for (const entry of entries) {
			const label = (entry.label ?? "").replace(/\s+/g, " ").trim();
			const href = entry.href ?? "";
			if (label && href) {
				const path = normalizeHref(href);
				if (path && !titles.has(path)) titles.set(path, label);
				const file = basename(path);
				if (file && !titles.has(file)) titles.set(file, label);
			}
			if (entry.subitems?.length) walk(entry.subitems);
		}
	};
	walk(toc);
	return titles;
}

/** The navigation label for a spine item's href, or `""` when the book's
 *  navigation doesn't cover it (a cover page, or no nav document at all). */
export function titleForHref(
	titles: ReadonlyMap<string, string>,
	href: string | undefined,
): string {
	if (!href) return "";
	const path = normalizeHref(href);
	return titles.get(path) ?? titles.get(basename(path)) ?? "";
}
