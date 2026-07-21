/**
 * `bsblock://` protocol — serves a BP block's HTML document from its OWN
 * origin so the document carries its own Content-Security-Policy instead of
 * inheriting the embedding app's `script-src 'self'` (which a `srcdoc` iframe
 * would, blocking the block bundle's inline script). The iframe sandbox still
 * forces an opaque origin + no ambient authority; this scheme only decouples
 * the document's CSP from the embedder's.
 *
 * URL shape: `bsblock://frame/?b=<blockId>&c=<channelId>&e=<entityId>` — built
 * by `makeBlockFrameUrl` in `@brainstorm-os/sdk/block-frame`. The handler looks up
 * the providing app's installed bundle by `blockId` (registry `blocks.source`)
 * and returns `buildBlockSrcdoc(bundle, {channelId, entityId})` with the block
 * frame's own CSP as a response header.
 *
 * Trust: the bundle is installed app code (first-party in v1), already readable
 * via the `blocks.read`-gated `blocks.source`; serving it here leaks nothing
 * new. The served document has no authority — its graph calls round-trip
 * through the embedding app's `bp.dispatch`, enforced per-type downstream. The
 * scheme is registered with the narrowest privileges (`standard` for a real
 * origin, `secure` for a secure context; no fetch / CORS / stream).
 */

import {
	BLOCK_FRAME_CSP,
	BLOCK_FRAME_SCHEME,
	buildBlockSrcdoc,
} from "@brainstorm-os/sdk/block-frame";
import { protocol } from "electron";
import { isValidBlockId } from "../apps/block-id";
import type { BlocksRepository } from "../storage/registry-repo/blocks-repo";

export type BlockFrameProtocolDeps = {
	/** The active vault's blocks repo, or null when no session is open. Async
	 *  to mirror the blocks-service accessor (`registry.db` opens lazily). */
	getBlocksRepo: () => Promise<BlocksRepository | null>;
};

/** Privilege descriptor for `protocol.registerSchemesAsPrivileged` — call at
 *  module load, BEFORE `app.whenReady`. `standard` gives the scheme a real
 *  origin (so the document doesn't inherit the embedder CSP); `secure` marks
 *  it a secure context. No `supportFetchAPI` / `corsEnabled` / `stream` — the
 *  block has `connect-src 'none'` and never fetches. */
export const BLOCK_FRAME_SCHEME_PRIVILEGE = {
	scheme: BLOCK_FRAME_SCHEME,
	privileges: { standard: true, secure: true },
} as const;

/** Pure request handler (no Electron) — exported so it's unit-testable. Maps a
 *  `bsblock://frame/?b&c&e` request to the served block document Response.
 *  404 for an unknown host / unregistered block, 400 for malformed params. */
export async function serveBlockFrameRequest(
	requestUrl: string,
	deps: BlockFrameProtocolDeps,
): Promise<Response> {
	const url = new URL(requestUrl);
	if (url.host !== "frame") return new Response(null, { status: 404 });
	const blockId = url.searchParams.get("b") ?? "";
	const channelId = url.searchParams.get("c") ?? "";
	const entityId = url.searchParams.get("e") ?? "";
	if (!isValidBlockId(blockId) || channelId === "" || entityId === "") {
		return new Response(null, { status: 400 });
	}
	const repo = await deps.getBlocksRepo();
	const source = repo?.getSource(blockId) ?? null;
	if (!source) return new Response(null, { status: 404 });
	const html = buildBlockSrcdoc(source, { channelId, entityId });
	return new Response(html, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			// The block document's OWN policy — authoritative now that it's a
			// real origin. `script-src 'unsafe-inline'` lets the installed bundle
			// run; `default-src` / `connect-src 'none'` + the opaque-origin
			// sandbox bound it (no network, no host reach except the postMessage
			// transport).
			"content-security-policy": BLOCK_FRAME_CSP,
			"cache-control": "no-store",
		},
	});
}

/** Register the `bsblock://` handler. Call once after `app.whenReady`. */
export function registerBlockFrameProtocol(deps: BlockFrameProtocolDeps): void {
	protocol.handle(BLOCK_FRAME_SCHEME, (request) => serveBlockFrameRequest(request.url, deps));
}
