/**
 * `buildSiteArchive` — IE-12: a page and the sub-pages it embeds → the bytes
 * of a zipped, self-contained static site.
 *
 * The published set is the root plus every page reachable through `page-ref`
 * nodes, and only pages the caller's `getPage` vouches for: an id it does not
 * know (deleted, another type, never existed) is not loaded, not published,
 * and not named in the output. Asset bytes are fetched for the published
 * pages' own images and nothing else.
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
/** Every copied image is held in memory until the archive is written. */
export const MAX_SITE_ASSET_BYTES = 100 * 1024 * 1024;
const SUB_PAGE_NODE_TYPE = "page-ref";

export type SiteArchiveLabels = SiteLabels & {
	/** Stands in for a reference to a page that is not part of the site. */
	readonly unpublished: string;
};

export type SiteArchiveInput = {
	readonly rootId: string;
	/** The page's current title, or `null` when the id is not publishable. */
	readonly getPage: (id: string) => { readonly title: string } | null;
	readonly transport: {
		loadDoc(id: string): Promise<{ snapshotB64: string }>;
		closeDoc(id: string): Promise<void>;
	};
	/** Bytes + served MIME of one vault asset, or `null` when unavailable. */
	readonly fetchAsset: (assetId: string) => Promise<SiteAsset | null>;
	readonly tokens: Readonly<Record<string, string>>;
	readonly labels: SiteArchiveLabels;
	readonly maxPages?: number;
	readonly maxAssetBytes?: number;
	readonly modifiedAt?: Date;
};

export type SiteArchive = {
	readonly bytes: Uint8Array;
	readonly pageCount: number;
	/** True when the page cap cut the tree short. */
	readonly truncated: boolean;
	/** Images left out because the copied assets reached the size cap. */
	readonly skippedAssets: number;
};

async function loadBody(
	transport: SiteArchiveInput["transport"],
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

function walkSubPageIds(node: SiteNode, into: string[]): void {
	if (node.type === SUB_PAGE_NODE_TYPE && typeof node.entityId === "string") {
		into.push(node.entityId);
	}
	if (Array.isArray(node.children)) {
		for (const child of node.children as SiteNode[]) walkSubPageIds(child, into);
	}
}

export async function buildSiteArchive(input: SiteArchiveInput): Promise<SiteArchive> {
	const root = input.getPage(input.rootId);
	if (!root) throw new Error("publish-site: the root page is not publishable");
	const maxPages = Math.max(1, input.maxPages ?? MAX_SITE_PAGES);

	const pages: SitePage[] = [];
	const queued = new Set<string>([input.rootId]);
	const queue: string[] = [input.rootId];
	let truncated = false;
	for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
		if (pages.length >= maxPages) {
			truncated = true;
			break;
		}
		const page = input.getPage(next);
		if (!page) continue;
		const isRoot = next === input.rootId;
		let state: SiteBodyState | null;
		try {
			state = await loadBody(input.transport, next);
		} catch (error) {
			if (isRoot) throw error;
			continue;
		}
		pages.push({ id: next, title: page.title, state });
		const subPageIds: string[] = [];
		if (state?.root) walkSubPageIds(state.root, subPageIds);
		for (const id of subPageIds) {
			if (queued.has(id)) continue;
			queued.add(id);
			queue.push(id);
		}
	}

	const maxAssetBytes = Math.max(0, input.maxAssetBytes ?? MAX_SITE_ASSET_BYTES);
	const assets = new Map<string, SiteAsset>();
	const assetIds = new Set(pages.flatMap((page) => collectAssetIds(page.state)));
	let assetBytes = 0;
	let skippedAssets = 0;
	for (const assetId of assetIds) {
		// Once one image does not fit, the rest are not fetched at all: each
		// fetch buffers a whole file just to learn its size.
		if (skippedAssets > 0) {
			skippedAssets += 1;
			continue;
		}
		const asset = await input.fetchAsset(assetId).catch(() => null);
		if (!asset) continue;
		if (assetBytes + asset.bytes.length > maxAssetBytes) {
			skippedAssets += 1;
			continue;
		}
		assetBytes += asset.bytes.length;
		assets.set(assetId, asset);
	}

	const { files } = assembleSite({
		pages,
		homeId: input.rootId,
		siteTitle: root.title,
		tokens: input.tokens,
		labels: input.labels,
		assets,
		renderBody: (state, links) =>
			serializedStateToHtml(state, {
				...links,
				unpublishedLabel: input.labels.unpublished,
				allowDataImages: true,
			}),
	});
	return {
		bytes: zipStore(files, input.modifiedAt ? { modifiedAt: input.modifiedAt } : {}),
		pageCount: pages.length,
		truncated,
		skippedAssets,
	};
}
