/**
 * IE-12 — a page and its sub-pages → the bytes of a zipped, self-contained
 * static site, in two steps so the set of pages is never implicit:
 *
 *   1. {@link planSite} works out which pages BELONG to the site;
 *   2. the user confirms that list;
 *   3. {@link buildSiteArchive} writes exactly the confirmed pages.
 *
 * Belonging is structural, and vouched for from both ends: the parent's body
 * shows a `page-ref` to the child AND the child's own record names that parent
 * AND the child is shared with exactly the people the root is. A `page-ref`
 * alone confers nothing — anyone who can edit a shared page can write one,
 * pointing at any id they have seen. The child's record is the half they
 * cannot write unless the child is already shared with them, and in that case
 * the scope rule keeps it out of any site whose root they could not already
 * read in full.
 *
 * The same reasoning covers images. A vault asset id typed into a page other
 * people can write may name any asset in the vault, and nothing an app can
 * read says which page an asset was uploaded to — so vault assets are copied
 * only from pages nobody else can write.
 */

import { b64ToBytes } from "@brainstorm-os/react-yjs";
import {
	type SiteAsset,
	type SiteBodyState,
	type SiteLabels,
	type SiteNode,
	type SitePage,
	assembleSite,
	collectAssetIds,
	zipStore,
} from "@brainstorm-os/sdk/site-export";
import { Doc, applyUpdate } from "yjs";
import { serializedStateToHtml } from "./serialize-html";
import { serializedStateFromDoc } from "./serialized-state-from-doc";

export const MAX_SITE_PAGES = 200;
/** Every copied or inlined image is held in memory until the archive is
 *  written. */
export const MAX_SITE_ASSET_BYTES = 100 * 1024 * 1024;
const SUB_PAGE_NODE_TYPE = "page-ref";
const DATA_URL_PREFIX = "data:";
const BASE64_MARKER = ";base64,";

export type SitePageInfo = {
	readonly title: string;
	/** The page this one was created under, as its own record says. */
	readonly parentId: string | null;
};

export type SitePageAccess = {
	/** Names exactly who can write the page; equal keys ⇔ the same people. */
	readonly scope: string;
	/** True when nobody but the vault's owner can write it. */
	readonly solo: boolean;
};

export type SitePlanInput = {
	readonly rootId: string;
	/** The page's own record, or `null` when the id is not publishable. */
	readonly getPage: (id: string) => SitePageInfo | null;
	/** Who can write the page, or `null` when that cannot be established. */
	readonly pageAccess: (id: string) => Promise<SitePageAccess | null>;
	readonly transport: {
		loadDoc(id: string): Promise<{ snapshotB64: string }>;
		closeDoc(id: string): Promise<void>;
	};
	readonly maxPages?: number;
};

export type SitePlan = {
	readonly rootId: string;
	/** The root first, then every sub-page that belongs, in reading order. */
	readonly pages: ReadonlyArray<{ readonly id: string; readonly title: string }>;
	/** True when the page cap cut the tree short. */
	readonly truncated: boolean;
	readonly bodies: ReadonlyMap<string, SiteBodyState | null>;
	readonly soloPageIds: ReadonlySet<string>;
};

export type SiteArchiveLabels = SiteLabels & {
	/** Stands in for a reference to a page that is not part of the site. */
	readonly unpublished: string;
};

export type SiteArchiveInput = {
	readonly plan: SitePlan;
	/** The pages the user confirmed. Ids outside the plan are ignored; the
	 *  root is always published. */
	readonly confirmedIds: readonly string[];
	/** Bytes + served MIME of one vault asset, or `null` when unavailable. */
	readonly fetchAsset: (assetId: string) => Promise<SiteAsset | null>;
	readonly tokens: Readonly<Record<string, string>>;
	readonly labels: SiteArchiveLabels;
	readonly maxAssetBytes?: number;
	readonly modifiedAt?: Date;
};

export type SiteArchive = {
	readonly bytes: Uint8Array;
	readonly pageCount: number;
	readonly truncated: boolean;
	/** Images left out because the site's images reached the size cap. */
	readonly skippedAssets: number;
	/** Vault images left out because they sit on a page other people can write. */
	readonly withheldAssets: number;
};

async function loadBody(
	transport: SitePlanInput["transport"],
	id: string,
): Promise<SiteBodyState | null> {
	try {
		const { snapshotB64 } = await transport.loadDoc(id);
		const doc = new Doc();
		try {
			if (snapshotB64.length > 0) applyUpdate(doc, b64ToBytes(snapshotB64));
			return serializedStateFromDoc(doc);
		} finally {
			doc.destroy();
		}
	} finally {
		await transport.closeDoc(id).catch(() => {});
	}
}

/** Every node of a body in document order, without recursion. */
function* walkBody(state: SiteBodyState | null): Generator<SiteNode> {
	const pending: SiteNode[] = state?.root ? [state.root] : [];
	for (let node = pending.pop(); node; node = pending.pop()) {
		yield node;
		const children = Array.isArray(node.children) ? (node.children as SiteNode[]) : [];
		for (let index = children.length - 1; index >= 0; index -= 1) {
			pending.push(children[index] as SiteNode);
		}
	}
}

function subPageIds(state: SiteBodyState | null): string[] {
	const ids: string[] = [];
	for (const node of walkBody(state)) {
		if (node.type === SUB_PAGE_NODE_TYPE && typeof node.entityId === "string") {
			ids.push(node.entityId);
		}
	}
	return ids;
}

export async function planSite(input: SitePlanInput): Promise<SitePlan> {
	const root = input.getPage(input.rootId);
	if (!root) throw new Error("publish-site: the root page is not publishable");
	const maxPages = Math.max(1, input.maxPages ?? MAX_SITE_PAGES);
	const access = (id: string) => input.pageAccess(id).catch(() => null);

	const rootAccess = await access(input.rootId);
	const pages: Array<{ id: string; title: string }> = [];
	const bodies = new Map<string, SiteBodyState | null>();
	const soloPageIds = new Set<string>();
	const considered = new Set<string>([input.rootId]);
	const queue: string[] = [input.rootId];
	let truncated = false;

	for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
		if (pages.length >= maxPages) {
			truncated = true;
			break;
		}
		const page = input.getPage(id);
		if (!page) continue;
		const isRoot = id === input.rootId;
		let body: SiteBodyState | null;
		try {
			body = await loadBody(input.transport, id);
		} catch (error) {
			if (isRoot) throw error;
			continue;
		}
		pages.push({ id, title: page.title });
		bodies.set(id, body);
		if (rootAccess?.solo) soloPageIds.add(id);
		if (!rootAccess) continue;

		for (const childId of subPageIds(body)) {
			if (considered.has(childId)) continue;
			considered.add(childId);
			if (input.getPage(childId)?.parentId !== id) continue;
			const childAccess = await access(childId);
			if (childAccess?.scope !== rootAccess.scope) continue;
			queue.push(childId);
		}
	}
	return { rootId: input.rootId, pages, truncated, bodies, soloPageIds };
}

function dataImageBytes(url: string): number {
	const marker = url.indexOf(BASE64_MARKER);
	const payload = marker === -1 ? url.length : url.length - marker - BASE64_MARKER.length;
	return Math.floor((payload * 3) / 4);
}

export async function buildSiteArchive(input: SiteArchiveInput): Promise<SiteArchive> {
	const { plan } = input;
	const confirmed = new Set(input.confirmedIds);
	const pages: SitePage[] = plan.pages
		.filter((page) => page.id === plan.rootId || confirmed.has(page.id))
		.map((page) => ({ ...page, state: plan.bodies.get(page.id) ?? null }));

	const maxAssetBytes = Math.max(0, input.maxAssetBytes ?? MAX_SITE_ASSET_BYTES);
	let usedBytes = 0;
	let skippedAssets = 0;

	const dataImages = new Map<string, number>();
	for (const page of pages) {
		for (const node of walkBody(page.state)) {
			if (typeof node.src !== "string" || !node.src.startsWith(DATA_URL_PREFIX)) continue;
			dataImages.set(node.src, (dataImages.get(node.src) ?? 0) + 1);
		}
	}
	const keptDataImages = new Set<string>();
	for (const [url, occurrences] of dataImages) {
		const cost = dataImageBytes(url) * occurrences;
		if (usedBytes + cost > maxAssetBytes) {
			skippedAssets += occurrences;
			continue;
		}
		usedBytes += cost;
		keptDataImages.add(url);
	}

	const copyable = new Set<string>();
	const shown = new Set<string>();
	for (const page of pages) {
		for (const assetId of collectAssetIds(page.state)) {
			shown.add(assetId);
			if (plan.soloPageIds.has(page.id)) copyable.add(assetId);
		}
	}
	const withheldAssets = shown.size - copyable.size;

	const assets = new Map<string, SiteAsset>();
	let capReached = false;
	for (const assetId of copyable) {
		// Once one image does not fit, the rest are not fetched at all: each
		// fetch buffers a whole file just to learn its size.
		if (capReached) {
			skippedAssets += 1;
			continue;
		}
		const asset = await input.fetchAsset(assetId).catch(() => null);
		if (!asset) continue;
		if (usedBytes + asset.bytes.length > maxAssetBytes) {
			capReached = true;
			skippedAssets += 1;
			continue;
		}
		usedBytes += asset.bytes.length;
		assets.set(assetId, asset);
	}

	const { files } = assembleSite({
		pages,
		homeId: plan.rootId,
		siteTitle: pages[0]?.title ?? "",
		tokens: input.tokens,
		labels: input.labels,
		assets,
		renderBody: (state, links) =>
			serializedStateToHtml(state, {
				...links,
				unpublishedLabel: input.labels.unpublished,
				allowDataImages: (url) => keptDataImages.has(url),
			}),
	});
	return {
		bytes: zipStore(files, input.modifiedAt ? { modifiedAt: input.modifiedAt } : {}),
		pageCount: pages.length,
		truncated: plan.truncated,
		skippedAssets,
		withheldAssets,
	};
}
