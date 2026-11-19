/**
 * `assembleSite` — a set of pages → the files of a self-contained static
 * site (`index.html`, one `<slug>.html` per page, `styles.css`, `assets/…`).
 *
 * The published set is exactly `pages`. Everything that decides what leaves
 * the vault is decided here, from that set alone: a link resolves only to a
 * page in it, and an asset is copied only when a page in it shows the asset.
 * The body renderer is injected (the editor package depends on the SDK, not
 * the reverse) and gets nothing but those two resolvers.
 */

import { textToBytes } from "../export-file";
import { ASSETS_DIR, HOME_PAGE_PATH, STYLESHEET_PATH, planPagePaths } from "./page-paths";
import { themeToCss } from "./theme-css";

export type SiteNode = { type?: unknown; children?: unknown; [key: string]: unknown };
export type SiteBodyState = { root?: SiteNode };

export type SitePage = {
	readonly id: string;
	readonly title: string;
	readonly state: SiteBodyState | null;
};

export type SiteAsset = {
	readonly bytes: Uint8Array;
	readonly mime: string;
};

export type SiteFile = {
	readonly path: string;
	readonly bytes: Uint8Array;
};

export type SiteLinkResolvers = {
	resolveEntityHref(entityId: string): string | null;
	/** The published page's current title, or `null` outside the set. */
	resolveEntityLabel(entityId: string): string | null;
	resolveAssetSrc(assetId: string): string | null;
};

export type SiteLabels = {
	/** Heading over the home page's list of every page. */
	readonly pages: string;
	/** Title for a page that has none. */
	readonly untitled: string;
};

export type AssembleSiteInput = {
	readonly pages: readonly SitePage[];
	readonly homeId: string;
	readonly siteTitle: string;
	/** Flattened design tokens (`--color-…` → value) of the theme to publish. */
	readonly tokens: Readonly<Record<string, string>>;
	readonly labels: SiteLabels;
	/** Asset bytes by id. Only those a published page shows are written. */
	readonly assets?: ReadonlyMap<string, SiteAsset>;
	/** Body → escaped HTML, resolving references through `links` only. */
	readonly renderBody: (state: SiteBodyState, links: SiteLinkResolvers) => string;
};

const ASSET_URL_PREFIX = "brainstorm://asset/";
const ASSET_ID = /^[A-Za-z0-9_-]+$/;
const TITLE_NODE_TYPE = "title";
/** Raster images only. SVG is a document that can carry script, and anything
 *  else has no place in an `<img>`. */
const ASSET_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/avif": "avif",
};
/** Names only what a published page must never do. A fetch directive with
 *  `'self'` is left out on purpose: the site is opened straight from disk as
 *  often as from a host, and its own stylesheet and images must load there. */
const CONTENT_SECURITY_POLICY =
	"script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function assetIdFromSrc(src: unknown): string | null {
	if (typeof src !== "string" || !src.startsWith(ASSET_URL_PREFIX)) return null;
	const id = src.slice(ASSET_URL_PREFIX.length).split(/[/?#]/)[0] ?? "";
	return ASSET_ID.test(id) ? id : null;
}

/** The vault assets a body shows, in first-seen order — what a caller should
 *  fetch for a page it is about to publish, and nothing more. */
export function collectAssetIds(state: SiteBodyState | null): string[] {
	const ids = new Set<string>();
	const pending: SiteNode[] = state?.root ? [state.root] : [];
	for (let node = pending.pop(); node; node = pending.pop()) {
		const id = assetIdFromSrc(node.src);
		if (id) ids.add(id);
		const children = Array.isArray(node.children) ? (node.children as SiteNode[]) : [];
		for (let index = children.length - 1; index >= 0; index -= 1) {
			pending.push(children[index] as SiteNode);
		}
	}
	return [...ids];
}

function opensWithTitle(state: SiteBodyState | null): boolean {
	const first = Array.isArray(state?.root?.children) ? (state.root.children as SiteNode[])[0] : null;
	return first?.type === TITLE_NODE_TYPE;
}

function pageDocument(input: {
	pageTitle: string;
	siteTitle: string;
	isHome: boolean;
	body: string;
	pageList: string;
}): string {
	const { pageTitle, siteTitle, isHome } = input;
	const documentTitle =
		isHome || pageTitle === siteTitle ? siteTitle : `${pageTitle} · ${siteTitle}`;
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />
<meta name="referrer" content="no-referrer" />
<title>${escapeHtml(documentTitle)}</title>
<link rel="stylesheet" href="${STYLESHEET_PATH}" />
</head>
<body>
<header class="site-header"><a class="site-title" href="${HOME_PAGE_PATH}">${escapeHtml(siteTitle)}</a></header>
<main>
${input.body}
</main>
${input.pageList}</body>
</html>
`;
}

export function assembleSite(input: AssembleSiteInput): { files: SiteFile[] } {
	const pages: SitePage[] = [];
	const seen = new Set<string>();
	for (const page of input.pages) {
		if (seen.has(page.id)) continue;
		seen.add(page.id);
		pages.push({ ...page, title: page.title.trim() || input.labels.untitled });
	}
	if (!seen.has(input.homeId)) throw new Error("site-export: the home page is not in the site");

	const paths = planPagePaths(pages, input.homeId);
	const titles = new Map(pages.map((page) => [page.id, page.title]));
	const siteTitle = input.siteTitle.trim() || input.labels.untitled;

	const assetPaths = new Map<string, string>();
	const assetFiles: SiteFile[] = [];
	const links: SiteLinkResolvers = {
		resolveEntityHref: (entityId) => paths.get(entityId) ?? null,
		resolveEntityLabel: (entityId) => titles.get(entityId) ?? null,
		resolveAssetSrc: (assetId) => {
			const known = assetPaths.get(assetId);
			if (known) return known;
			const asset = input.assets?.get(assetId);
			const extension = asset ? ASSET_EXTENSION_BY_MIME[asset.mime.toLowerCase().trim()] : undefined;
			if (!asset || !extension) return null;
			const path = `${ASSETS_DIR}/${assetFiles.length + 1}.${extension}`;
			assetPaths.set(assetId, path);
			assetFiles.push({ path, bytes: asset.bytes });
			return path;
		},
	};

	const others = pages.filter((page) => page.id !== input.homeId);
	const pageList =
		others.length > 0
			? `<nav class="site-pages" aria-label="${escapeHtml(input.labels.pages)}">
<h2>${escapeHtml(input.labels.pages)}</h2>
<ul>
${others
	.map((page) => `<li><a href="${paths.get(page.id) ?? ""}">${escapeHtml(page.title)}</a></li>`)
	.join("\n")}
</ul>
</nav>
`
			: "";

	const files: SiteFile[] = pages.map((page) => {
		const isHome = page.id === input.homeId;
		const rendered = page.state ? input.renderBody(page.state, links) : "";
		const heading = opensWithTitle(page.state) ? "" : `<h1>${escapeHtml(page.title)}</h1>\n`;
		return {
			path: paths.get(page.id) ?? HOME_PAGE_PATH,
			bytes: textToBytes(
				pageDocument({
					pageTitle: page.title,
					siteTitle,
					isHome,
					body: `${heading}${rendered}`,
					pageList: isHome ? pageList : "",
				}),
			),
		};
	});

	files.push({ path: STYLESHEET_PATH, bytes: textToBytes(themeToCss(input.tokens)) });
	return { files: [...files, ...assetFiles] };
}
