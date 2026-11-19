/**
 * The one `onBeforeSendHeaders` owner per session.
 *
 * Electron keeps a single listener per webRequest event per session — a
 * second `onBeforeSendHeaders` call silently REPLACES the first. Every
 * request-header rule therefore registers a rewriter here, and this module
 * installs the session's only listener, running the rewriters in
 * registration order, each seeing the previous one's result.
 */

export type HeaderRewriteRequest = {
	url: string;
	resourceType?: string;
	webContentsId?: number;
};

/** Returns the headers to send — the same reference when nothing changed. */
export type RequestHeaderRewriter = (
	request: HeaderRewriteRequest,
	headers: Record<string, string>,
) => Record<string, string>;

type BeforeSendHeadersDetails = HeaderRewriteRequest & { requestHeaders: Record<string, string> };

/** The slice of Electron's `Session` this module touches. */
export type HeaderRewriteSession = {
	webRequest: {
		onBeforeSendHeaders(
			listener: (
				details: BeforeSendHeadersDetails,
				callback: (response: { requestHeaders: Record<string, string> }) => void,
			) => void,
		): void;
	};
};

const rewritersBySession = new WeakMap<HeaderRewriteSession, RequestHeaderRewriter[]>();

/** A rewriter that throws must not take the request down with it, nor skip
 *  the rules after it: its step is dropped and the chain carries on. */
export function applyRequestHeaderRewriters(
	rewriters: readonly RequestHeaderRewriter[],
	request: HeaderRewriteRequest,
	headers: Record<string, string>,
): Record<string, string> {
	let current = headers;
	for (const rewrite of rewriters) {
		try {
			current = rewrite(request, current);
		} catch {
			// Fail open on the header rewrite only; the request proceeds unchanged.
		}
	}
	return current;
}

export function addRequestHeaderRewriter(
	session: HeaderRewriteSession,
	rewriter: RequestHeaderRewriter,
): void {
	const existing = rewritersBySession.get(session);
	if (existing) {
		existing.push(rewriter);
		return;
	}
	const rewriters = [rewriter];
	rewritersBySession.set(session, rewriters);
	session.webRequest.onBeforeSendHeaders((details, callback) => {
		callback({
			requestHeaders: applyRequestHeaderRewriters(rewriters, details, details.requestHeaders),
		});
	});
}
