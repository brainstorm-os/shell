/**
 * HTML-body rendering safety for the reading pane (doc 53 §Capabilities &
 * security). `bodyHtmlSafe` is already sanitised by the shell-side worker
 * (no scripts), but the **viewer** adds two privacy guarantees:
 *
 *   1. The body renders inside a `sandbox`ed iframe with **no** `allow-scripts`
 *      / `allow-same-origin`, and a per-frame CSP `<meta>` — so even hostile
 *      HTML cannot run JS, read cookies, or reach the parent (hostile HTML
 *      mail is the same threat class as a hostile embed, doc 38).
 *   2. Remote images / CSS are **blocked by default** (`img-src data:`), so a
 *      tracking pixel never fires an open-receipt on render. The user clicks
 *      "Show remote content" to relax the frame CSP to `img-src https:`.
 *
 * Blocking lives in the frame CSP rather than in HTML rewriting: a request
 * the CSP refuses is never made, which is exactly the tracking-pixel defeat
 * (rewriting can be defeated by `srcset`/`<picture>`/`background:url()`; a
 * `default-src 'none'` CSP cannot).
 */

/** Does this HTML reference any remote (http/https/protocol-relative)
 *  resource that the blocked-mode CSP would suppress? Drives whether the
 *  "Show remote content" banner appears. `cid:`/`data:` are local and never
 *  count. */
export function hasRemoteContent(html: string): boolean {
	if (html.length === 0) return false;
	// Any absolute or protocol-relative URL in an attribute or a CSS url(...).
	const remoteUrl = /(?:src|srcset|background|href|url\()\s*=?\s*["'(]?\s*(?:https?:)?\/\//i;
	return remoteUrl.test(html);
}

/** Strip frame-level overrides a body must not carry: a `<base>` that could
 *  retarget relative URLs, and any author `<meta http-equiv>` (incl. an
 *  author CSP that would override ours). The worker's sanitiser removes
 *  `<script>`; this is defence-in-depth for the viewer. */
function stripFrameOverrides(html: string): string {
	return html
		.replace(/<base\b[^>]*>/gi, "")
		.replace(/<meta\b[^>]*http-equiv[^>]*>/gi, "")
		.replace(/<script\b[\s\S]*?<\/script>/gi, "")
		.replace(/<script\b[^>]*>/gi, "");
}

const FRAME_STYLE = `
	:root { color-scheme: light dark; }
	html, body { margin: 0; padding: 12px; }
	body {
		font: 14px/1.5 -apple-system, system-ui, sans-serif;
		color: #1a1a1a; background: #fff; word-break: break-word;
	}
	@media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #1a1a1a; } }
	img, video, table { max-width: 100%; height: auto; }
	a { color: #2563eb; }
	blockquote { margin: 0 0 0 12px; padding-left: 12px; border-left: 3px solid #ccc; color: #666; }
`;

/** Build the complete `srcdoc` for the body iframe. `showRemote` relaxes the
 *  frame CSP to permit remote images/styles once the user opts in. */
export function buildFrameSrcDoc(bodyHtmlSafe: string, showRemote: boolean): string {
	const body = stripFrameOverrides(bodyHtmlSafe);
	const csp = showRemote
		? "default-src 'none'; img-src data: cid: https:; style-src 'unsafe-inline'; font-src data: https:; media-src data: https:"
		: "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:";
	// In blocked mode the CSP suppresses the fetch but the engine still paints
	// a broken-image glyph per remote <img> — hide those; inline data:/cid:
	// images stay visible.
	const blockedStyle = showRemote
		? ""
		: '<style>img[src^="http" i], img[srcset], source[srcset] { display: none; }</style>';
	return [
		"<!doctype html><html><head>",
		'<meta charset="utf-8">',
		`<meta http-equiv="Content-Security-Policy" content="${csp}">`,
		`<style>${FRAME_STYLE}</style>`,
		blockedStyle,
		"</head><body>",
		body,
		"</body></html>",
	].join("");
}
