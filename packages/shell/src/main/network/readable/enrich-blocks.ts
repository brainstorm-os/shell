/**
 * Pure helpers for 9.18.9 — rewriting captured-article image blocks to point at
 * locally-stored encrypted assets. The readable extractor already emits
 * `{type:"image", src, …}` blocks with the article's REMOTE image URLs; the app
 * CSP (`img-src 'self' data: brainstorm:`) blocks those remote URLs, so they'd
 * never render. `enrich-blocks` finds those remote images so the handler can
 * sub-fetch each (through the same SSRF/size/MIME guards as favicon/cover),
 * store it encrypted, and rewrite the `src` to a `brainstorm://asset/<id>` URL —
 * which renders, works offline, and auto-binds an `asset_refs` row (the bind
 * writer derives refs from `brainstorm://asset/` URLs in the entity body).
 *
 * These two functions are the pure, network-free core (walk + rewrite); the
 * handler owns the guarded fetch + the count/size/concurrency caps.
 */

import type { SerializedBlock } from "@brainstorm/sdk-types";

/** A block that carries an image `src` — the shape the readable extractor emits
 *  (`html-to-blocks.ts` `imageNode`). */
type ImageBlock = SerializedBlock & { type: "image"; src?: unknown };

function isImageBlock(node: SerializedBlock): node is ImageBlock {
	return (node as { type?: unknown }).type === "image";
}

/** A remote `http(s)` image the app CSP can't render — the ones worth fetching +
 *  storing locally. `brainstorm://asset/…` (already local) and `data:` are left
 *  alone. */
export function isRemoteHttpImageSrc(src: unknown): src is string {
	return typeof src === "string" && /^https?:\/\//i.test(src);
}

function childrenOf(node: SerializedBlock): SerializedBlock[] | undefined {
	const children = (node as { children?: unknown }).children;
	return Array.isArray(children) ? (children as SerializedBlock[]) : undefined;
}

/**
 * Collect up to `max` DISTINCT remote image `src`s from a block tree (recursing
 * into `children`). Bounded by `max` so a hostile page listing thousands of
 * images can't drive thousands of sub-fetches — the walk stops once `max`
 * distinct URLs are found.
 */
export function collectRemoteImageSrcs(blocks: readonly SerializedBlock[], max: number): string[] {
	const found = new Set<string>();
	const walk = (nodes: readonly SerializedBlock[]): void => {
		for (const node of nodes) {
			if (found.size >= max) return;
			if (isImageBlock(node) && isRemoteHttpImageSrc(node.src)) found.add(node.src);
			if (found.size >= max) return;
			const children = childrenOf(node);
			if (children) walk(children);
		}
	};
	walk(blocks);
	return [...found];
}

/**
 * Return a new block tree with every image `src` present in `rewrites` replaced
 * by its mapped value. Immutable — nodes without a rewrite are returned as-is
 * (referential identity preserved where possible). An image whose fetch failed
 * (absent from `rewrites`) keeps its remote `src` and is dropped at render.
 */
export function rewriteImageSrcs(
	blocks: readonly SerializedBlock[],
	rewrites: ReadonlyMap<string, string>,
): SerializedBlock[] {
	if (rewrites.size === 0) return blocks as SerializedBlock[];
	const rewrite = (node: SerializedBlock): SerializedBlock => {
		let next = node;
		if (isImageBlock(node) && typeof node.src === "string" && rewrites.has(node.src)) {
			next = { ...node, src: rewrites.get(node.src) };
		}
		const children = childrenOf(next);
		if (children) {
			next = { ...next, children: children.map(rewrite) } as SerializedBlock;
		}
		return next;
	};
	return blocks.map(rewrite);
}
