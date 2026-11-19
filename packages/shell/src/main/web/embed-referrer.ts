/**
 * Embedder identity for web-embed players that refuse to run without one.
 *
 * An app page is served from the `brainstorm:` scheme, so Chromium sends no
 * `Referer` on its iframes whatever their `referrerpolicy`. YouTube's player
 * rejects that ("Error 153"). For the player DOCUMENT request of a provider
 * whose catalogue row asks for it, this sets `Referer` to the fixed
 * `EMBEDDER_REFERRER`. Nothing else is touched: not other hosts, not the
 * player's subresources, not cookies, not any other header — and the value is
 * a constant, so nothing about the vault or the document reaches the provider.
 */

import { EMBEDDER_REFERRER, EMBED_FRAMES } from "@brainstorm-os/sdk-types";
import {
	type HeaderRewriteRequest,
	type HeaderRewriteSession,
	type RequestHeaderRewriter,
	addRequestHeaderRewriter,
} from "./request-header-rewriters";

const SUB_FRAME = "subFrame";

const REFERRER_FRAMES = Object.values(EMBED_FRAMES).flatMap((frame) =>
	frame.embedderReferrerPath === null
		? []
		: [{ origin: frame.frameOrigin, pathPrefix: frame.embedderReferrerPath }],
);

/** True only for an iframe document request on a referrer-requiring
 *  provider's exact origin and player path. */
export function needsEmbedderReferrer(request: HeaderRewriteRequest): boolean {
	if (request.resourceType !== SUB_FRAME) return false;
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
	return REFERRER_FRAMES.some(
		(frame) =>
			url.origin === frame.origin &&
			url.pathname.startsWith(frame.pathPrefix) &&
			url.pathname.length > frame.pathPrefix.length,
	);
}

export const embedReferrerRewriter: RequestHeaderRewriter = (request, headers) => {
	if (!needsEmbedderReferrer(request)) return headers;
	const next: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== "referer") next[key] = value;
	}
	next.Referer = EMBEDDER_REFERRER;
	return next;
};

const installedSessions = new WeakSet<HeaderRewriteSession>();

/** Install on an APP-RENDERER session (they share `session.defaultSession`).
 *  Idempotent per session. Browser web views run in their own partitions and
 *  never get this rule. */
export function installEmbedReferrer(session: HeaderRewriteSession): void {
	if (installedSessions.has(session)) return;
	installedSessions.add(session);
	addRequestHeaderRewriter(session, embedReferrerRewriter);
}
