/**
 * Pure security-policy decisions for the partitioned web session (Browser-2,
 *  §Privacy & security). The Electron glue in
 * `locked-session.ts` applies these to a real `Session` / `WebContents`; this
 * module holds only the *decisions* so they're exhaustively unit-testable
 * without Electron (the same pure-core split `network/` uses).
 *
 * Posture: deny-default device permissions, HTTPS-upgrade, third-party-cookie
 * block, and a tracker/ad blocklist — the [38] embed sandbox generalized to a
 * full navigable page. The blocklist source is a bundled static set in v1
 * (OQ-WV-4 lean; a signed updatable feed is post-v1).
 */

import { TabSecurityState } from "@brainstorm-os/sdk-types";
import { matchesHostPattern } from "../network/host-patterns";

/** Bundled tracker/ad host patterns blocked by default (OQ-WV-4: static v1
 *  list; the updatable signed feed is post-v1). Patterns match per
 *  {@link matchesHostPattern} (`*.` prefix = subdomain wildcard). Deliberately
 *  small + well-known — a real list ships via the feed, not hard-coded here. */
export const DEFAULT_TRACKER_BLOCKLIST: readonly string[] = [
	"*.doubleclick.net",
	"*.google-analytics.com",
	"*.googletagmanager.com",
	"*.googlesyndication.com",
	"*.adservice.google.com",
	"*.scorecardresearch.com",
	"*.adnxs.com",
	"*.facebook.net",
	"*.hotjar.com",
	"*.segment.io",
	"*.mixpanel.com",
	"*.amplitude.com",
];

/** Loopback / link-local hosts that must NOT be HTTPS-upgraded — a dev server
 *  on `http://localhost` has no TLS and upgrading would just break it. */
function isLoopbackHost(host: string): boolean {
	const h = host.toLowerCase();
	return (
		h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h.endsWith(".localhost")
	);
}

/**
 * HTTPS-upgrade target for an `http://` URL, or `null` when no upgrade applies
 * (already https, a non-http scheme, loopback, or unparseable). The browser
 * rewrites the request to the returned URL before it hits the network.
 */
export function upgradeToHttps(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:") return null;
	if (isLoopbackHost(parsed.hostname)) return null;
	parsed.protocol = "https:";
	return parsed.toString();
}

/**
 * The session UA with the embedded-browser tokens removed (`Electron/x.y.z`
 * and the app's own `<name>/x.y.z`), leaving what the same Chromium would send
 * as Chrome. Anti-bot systems (X's Castle, Google sign-in) treat the Electron
 * token as an automation signal and 403 login/write flows even for a fully
 * interactive user — the page capabilities are identical either way, so the
 * honest-Chromium UA is the correct presentation (F-433).
 */
export function chromeEquivalentUserAgent(defaultUserAgent: string, appName?: string): string {
	let ua = defaultUserAgent.replace(/\sElectron\/\S+/gi, "");
	if (appName) {
		const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		ua = ua.replace(new RegExp(`\\s${escaped}/\\S+`, "gi"), "");
	}
	return ua.replace(/ {2,}/g, " ").trim();
}

/** Whether a request to `url` matches the tracker/ad blocklist and should be
 *  cancelled. An unparseable URL is never blocked (let the engine reject it). */
export function isBlockedRequest(url: string, blocklist: readonly string[]): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (host.length === 0) return false;
	return matchesHostPattern(host, blocklist);
}

/**
 * The security badge for a URL, from the chrome's point of view. `https` →
 * Secure, `http` → Insecure, `about:`/blank/empty → Local. The Mixed state
 * (https page with insecure subresources) is reported separately by the host
 * from live load events, not derivable from the URL alone.
 */
export function securityStateForUrl(url: string): TabSecurityState {
	if (url === "" || url === "about:blank" || url.startsWith("about:")) {
		return TabSecurityState.Local;
	}
	if (url.startsWith("https://")) return TabSecurityState.Secure;
	if (url.startsWith("http://")) return TabSecurityState.Insecure;
	return TabSecurityState.Local;
}

/** Multi-label public suffixes the registrable-domain heuristic must keep
 *  together (so `news.bbc.co.uk` and `shop.bbc.co.uk` are the same site but
 *  `evil.co.uk` is not). Deliberately small + well-known — the full PSL ships
 *  with the OQ-WV-4 feed work, not hard-coded here. */
const MULTI_LABEL_SUFFIXES = new Set([
	"co.uk",
	"org.uk",
	"gov.uk",
	"ac.uk",
	"com.au",
	"net.au",
	"org.au",
	"co.jp",
	"or.jp",
	"ne.jp",
	"co.nz",
	"co.kr",
	"co.in",
	"com.br",
	"com.mx",
	"com.cn",
	"com.tw",
	"com.hk",
	"com.sg",
]);

/** eTLD+1-ish registrable domain for first/third-party comparison. IP
 *  literals and single-label hosts return themselves. Heuristic, not the
 *  PSL — see {@link MULTI_LABEL_SUFFIXES}. */
export function registrableDomain(host: string): string {
	const h = host.toLowerCase().replace(/\.$/, "");
	if (h.length === 0) return h;
	// IPv6 literal or IPv4 — never split.
	if (h.startsWith("[") || /^[0-9.]+$/.test(h)) return h;
	const labels = h.split(".");
	if (labels.length <= 2) return h;
	const lastTwo = labels.slice(-2).join(".");
	const take = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
	return labels.slice(-take).join(".");
}

/**
 * Whether `requestUrl` is third-party relative to the page at
 * `firstPartyUrl` (registrable-domain comparison). Third-party requests get
 * their cookies stripped both ways — the partition isolation already gives
 * per-tab jars; this kills cross-SITE linkage within a tab. Fail-closed:
 * an unparseable request URL with a real first party reads as third-party.
 * No first-party context yet (empty / about:blank) → first-party (the
 * top-level document request must carry its own cookies).
 */
export function isThirdPartyRequest(requestUrl: string, firstPartyUrl: string): boolean {
	let firstHost: string;
	try {
		const fp = new URL(firstPartyUrl);
		if (fp.protocol !== "http:" && fp.protocol !== "https:") return false;
		firstHost = fp.hostname;
	} catch {
		return false;
	}
	if (firstHost.length === 0) return false;
	let requestHost: string;
	try {
		requestHost = new URL(requestUrl).hostname;
	} catch {
		return true;
	}
	if (requestHost.length === 0) return true;
	return registrableDomain(requestHost) !== registrableDomain(firstHost);
}

/** `requestHeaders` minus any `Cookie` header (case-insensitive). Returns the
 *  same reference when nothing was stripped so callers can skip the write. */
export function withoutCookieHeader(
	requestHeaders: Record<string, string>,
): Record<string, string> {
	const keys = Object.keys(requestHeaders).filter((k) => k.toLowerCase() === "cookie");
	if (keys.length === 0) return requestHeaders;
	const next: Record<string, string> = {};
	for (const [key, value] of Object.entries(requestHeaders)) {
		if (key.toLowerCase() !== "cookie") next[key] = value;
	}
	return next;
}

/** `responseHeaders` minus any `Set-Cookie` header (case-insensitive). Same
 *  same-reference contract as {@link withoutCookieHeader}. */
export function withoutSetCookieHeaders(
	responseHeaders: Record<string, string[]>,
): Record<string, string[]> {
	const keys = Object.keys(responseHeaders).filter((k) => k.toLowerCase() === "set-cookie");
	if (keys.length === 0) return responseHeaders;
	const next: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(responseHeaders)) {
		if (key.toLowerCase() !== "set-cookie") next[key] = value;
	}
	return next;
}

/** Schemes a navigable web view is allowed to load. Anything else (`file:`,
 *  `javascript:`, custom app schemes) is refused before navigation — the web
 *  engine must never reach the local filesystem or a privileged scheme. */
const ALLOWED_NAVIGATION_SCHEMES = new Set(["http:", "https:", "about:"]);

/** Whether the web view may navigate to `url`. Fail-closed: an unparseable or
 *  off-allowlist scheme is refused. */
export function isNavigationAllowed(url: string): boolean {
	if (url === "about:blank") return true;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	return ALLOWED_NAVIGATION_SCHEMES.has(parsed.protocol);
}
