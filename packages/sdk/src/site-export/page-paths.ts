/**
 * Where each published page lands in the site. A slug is built only from
 * `[a-z0-9-]`, so nothing a title contains — separators, dots, a drive
 * letter, control characters — can shape the path; two pages that slug the
 * same get numbered apart instead of overwriting each other.
 */

export const HOME_PAGE_PATH = "index.html";
export const STYLESHEET_PATH = "styles.css";
export const ASSETS_DIR = "assets";

const PAGE_EXTENSION = ".html";
const FALLBACK_SLUG = "page";
const MAX_SLUG_CHARS = 60;
/** Names the site itself owns, plus the device names Windows refuses. */
const RESERVED_SLUG = /^(index|styles|assets|con|prn|aux|nul|com\d|lpt\d)$/;

export function slugify(title: string): string {
	const slug = title
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, MAX_SLUG_CHARS)
		.replace(/^-+|-+$/g, "");
	if (slug.length === 0) return FALLBACK_SLUG;
	return RESERVED_SLUG.test(slug) ? `${slug}-${FALLBACK_SLUG}` : slug;
}

/** id → file path for every page: the home page is `index.html`, the rest
 *  `<slug>.html`, unique in the order given. A repeated id keeps its first
 *  path. */
export function planPagePaths(
	pages: ReadonlyArray<{ readonly id: string; readonly title: string }>,
	homeId: string,
): Map<string, string> {
	const paths = new Map<string, string>();
	const taken = new Set<string>();
	for (const page of pages) {
		if (paths.has(page.id)) continue;
		if (page.id === homeId) {
			paths.set(page.id, HOME_PAGE_PATH);
			continue;
		}
		const base = slugify(page.title);
		let slug = base;
		for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
		taken.add(slug);
		paths.set(page.id, `${slug}${PAGE_EXTENSION}`);
	}
	return paths;
}
