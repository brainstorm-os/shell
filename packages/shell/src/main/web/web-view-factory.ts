/**
 * Electron glue for the `WebView` host service (Browser-2). Constructs the
 * locked-down, partitioned, Node-less `WebContentsView`, applies the security
 * policy from {@link web-policy}, wires native `webContents` events to the
 * service's metadata-event callback, and attaches the view to the target
 * window. The orchestration (registry, suspension, routing) is the pure
 * `web-view-service.ts`; this is the unavoidable Electron half.
 *
 * Not unit-tested — needs Electron, verified in the running shell (same posture
 * as `print-to-pdf.ts`). The *decisions* it applies are unit-tested in
 * `web-policy.test.ts`; the *routing* that drives it in `web-view-service.test.ts`.
 *
 * Security posture (§Privacy & security): per-tab ephemeral
 * partition, `sandbox`/`contextIsolation` on, `nodeIntegration` off, **no
 * preload** (no `window.brainstorm` bridge), deny-default device permissions,
 * tracker/ad blocklist, HTTPS-upgrade (top-level upgrade happens in the
 * service), and a navigation-scheme allowlist that fail-closes `file:` /
 * `javascript:` / custom schemes.
 */

import { type SitePermissionKind, TabLoadState, WebViewEventKind } from "@brainstorm/sdk-types";
import { type Session, WebContentsView } from "electron";
import { TabChord, type WebContentsViewHandle, tabChordFor } from "../apps/window-container";
import { networkEgressHostOf } from "../network/audit-log";
import { sitePermissionKindsFor, webOriginOf } from "./site-permissions";
import {
	DEFAULT_TRACKER_BLOCKLIST,
	isBlockedRequest,
	isNavigationAllowed,
	isThirdPartyRequest,
	securityStateForUrl,
	withoutCookieHeader,
	withoutSetCookieHeaders,
} from "./web-policy";
import { WebViewBackgroundController } from "./web-view-background";
import type { CreateViewSpec, ManagedWebView } from "./web-view-service";

export type WebViewFactoryDeps = {
	/** Tracker/ad host patterns to block (OQ-WV-4). Defaults to the bundled
	 *  static list. */
	blocklist?: readonly string[];
	/** Whether DevTools may open on a web view (off in packaged builds). */
	allowDevTools?: boolean;
	/** The close-tab chord (Cmd+W) was pressed while OS focus rested inside the
	 *  page. The factory swallows the input (so the menu's `role:"close"`
	 *  accelerator can't close the whole window); the caller routes it to the
	 *  owning chrome as a `window:tab-command`. */
	onCloseChord?: () => void;
	/** Resolve the active theme's primary background — painted as the view's
	 *  pre-paint / `about:blank` surface so a fresh tab matches the theme
	 *  instead of flashing white on dark themes. `null` keeps the web-default
	 *  white. Async because the theme lives in the vault's dashboard store. */
	resolveBackgroundColor?: () => Promise<string | null>;
	/** Browser-7 — the per-vault grant store's sync decision: `true` =
	 *  explicit allow, `false` = explicit block (silent deny), `null` = unset
	 *  (deny + surface the ask). Absent ⇒ deny-default everything silently
	 *  (the Browser-2 posture). */
	decidePermission?: (origin: string, kind: SitePermissionKind) => boolean | null;
	/** Browser-7 — per-host egress aggregate hook (host only, never the URL).
	 *  `blocked` marks a blocklist cancel. */
	recordEgress?: (host: string, blocked: boolean) => void;
	/** Browser-8 — sync per-origin trust check. `true` for a first-party origin
	 *  the user marked TRUSTED relaxes the tracker blocklist + third-party-cookie
	 *  strip for that page (the login-gated-SPA escape hatch). Absent / `false` ⇒
	 *  the strict Browser-2/4 default. Keyed by the page's FIRST PARTY, never the
	 *  request URL. */
	isTrustedOrigin?: (origin: string) => boolean;
};

/** Sessions whose locked-down policy (permissions + webRequest) is already
 *  installed. Browser-10's persistent partition is one shared session across
 *  many tabs, and each webRequest/permission slot is singular per session, so
 *  the policy must be wired exactly once — this guards re-registration. A
 *  WeakSet so a discarded private-tab session is collectable. */
const configuredSessions = new WeakSet<Session>();

/**
 * Build the {@link CreateViewSpec.window}-attached, locked-down view for one
 * tab. Returned {@link ManagedWebView} owns its teardown (detach + close).
 */
export function createLockedWebView(
	spec: CreateViewSpec,
	deps: WebViewFactoryDeps = {},
): ManagedWebView {
	const blocklist = deps.blocklist ?? DEFAULT_TRACKER_BLOCKLIST;

	const view = new WebContentsView({
		webPreferences: {
			// Browser-10: normal tabs share the persistent (still in-memory —
			// non-`persist:`) partition so a login sticks across tabs/restarts;
			// private tabs get a throwaway per-tab partition. Either way Chromium
			// writes nothing to disk — the encrypted `cookies.db` jar owns
			// persistence (see web-view-service.PERSISTENT_WEB_PARTITION).
			partition: spec.partition,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webSecurity: true,
			// No preload: the page reaches no Brainstorm bridge, no Node surface.
			devTools: deps.allowDevTools ?? false,
		},
	});
	// The theme background paints ONLY the empty surface (new-tab / about:blank).
	// Real pages get the web-default white underneath — sites with transparent
	// body backgrounds assume it, and the theme color bleeding through their
	// content is a rendering bug. The controller owns that decision across the
	// async theme-resolve / navigation race (see WebViewBackgroundController).
	const background = new WebViewBackgroundController();
	view.setBackgroundColor(background.backgroundColor);

	const wc = view.webContents;
	void deps
		.resolveBackgroundColor?.()
		.then((color) => {
			background.onThemeResolved(color);
			if (!wc.isDestroyed()) view.setBackgroundColor(background.backgroundColor);
		})
		.catch(() => {
			// Theme resolution failing must never break tab creation; the
			// white default stands.
		});
	// Session-level policy (permissions + webRequest) is installed ONCE per
	// session. Browser-10 normal tabs SHARE one persistent session, and a
	// `webRequest`/permission handler is singular per session — re-registering
	// per view would let the last tab's handler (and its captured first-party)
	// win for every sibling, silently breaking the third-party-cookie strip.
	// So the handlers attribute per request via `spec.resolveTabContext`. A
	// private tab's unique session is configured exactly the same way (its one
	// view is the only context). See configureSessionPolicy.
	configureSessionPolicy(wc.session, spec, deps, blocklist);

	// New windows / target=_blank never spawn an OS-level popup — deny (a
	// proper "open in new tab" is a Browser-3 chrome affordance, routed back
	// through the service, not an Electron popup).
	wc.setWindowOpenHandler(() => ({ action: "deny" }));

	// Navigation scheme allowlist — fail-closed against file:/javascript:/custom.
	wc.on("will-navigate", (event, url) => {
		if (!isNavigationAllowed(url)) event.preventDefault();
	});

	// page-favicon-updated carries favicon *URLs* — but the chrome's CSP forbids
	// it fetching arbitrary https hosts (and doing so would leak to the chrome's
	// session, sidestepping the tab's partition). So the favicon is fetched HERE,
	// in the page's own session, and projected as a `data:` URL — the only image
	// bytes the chrome can render and the same metadata-only posture as the title.
	let lastFaviconUrl: string | null = null;
	const emitFavicon = (faviconUrl: string | null): void => {
		spec.onEvent({ kind: WebViewEventKind.FaviconChanged, tabId: spec.tabId, faviconUrl });
	};

	// Leaving the empty surface reverts to the web-default white; returning
	// to it (new-tab reset) restores the theme background.
	wc.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
		if (!isMainFrame) return;
		background.onNavigationStart(url);
		view.setBackgroundColor(background.backgroundColor);
		// A real top-level navigation drops the old icon so a faviconless
		// destination doesn't keep the previous site's; in-place (fragment /
		// history) navigations keep it.
		if (!isInPlace && lastFaviconUrl !== null) {
			lastFaviconUrl = null;
			emitFavicon(null);
		}
	});

	// Cmd+W focused inside the page closes the BROWSER tab, not the OS window:
	// preventDefault stops the page keydown AND the menu accelerator; the
	// callback routes the chord back to the chrome (same interception the
	// window-container does for app-tab renderers).
	wc.on("before-input-event", (event, input) => {
		if (tabChordFor(input) !== TabChord.CloseTab) return;
		event.preventDefault();
		deps.onCloseChord?.();
	});

	// Metadata events → the chrome (the page DOM/bytes never cross this line).
	wc.on("page-title-updated", (_event, title) => {
		spec.onEvent({ kind: WebViewEventKind.TitleChanged, tabId: spec.tabId, title });
	});
	wc.on("page-favicon-updated", (_event, favicons) => {
		const url = favicons[0] ?? null;
		if (url === lastFaviconUrl) return;
		lastFaviconUrl = url;
		if (!url) return emitFavicon(null);
		if (url.startsWith("data:")) return emitFavicon(url);
		void resolveFaviconDataUrl(wc.session, url)
			.then((dataUrl) => {
				// A late resolve for a tab that has since navigated away is stale.
				if (wc.isDestroyed() || url !== lastFaviconUrl) return;
				emitFavicon(dataUrl);
			})
			.catch(() => {
				// A favicon that won't fetch just leaves the tab icon empty.
			});
	});
	wc.on("did-start-loading", () => {
		emitLoad(spec, TabLoadState.Loading);
	});
	wc.on("did-stop-loading", () => {
		emitLoad(spec, TabLoadState.Loaded);
	});
	wc.on("did-fail-load", (_event, errorCode, _desc, _url, isMainFrame) => {
		// -3 (ERR_ABORTED) is a normal user-cancel / redirect, not a failure.
		if (isMainFrame && errorCode !== -3) emitLoad(spec, TabLoadState.Failed);
	});
	wc.on("did-navigate", (_event, url) => {
		emitUrl(spec, url);
	});
	wc.on("did-navigate-in-page", (_event, url, isMainFrame) => {
		if (isMainFrame) emitUrl(spec, url);
	});
	wc.on("found-in-page", (_event, result) => {
		spec.onEvent({
			kind: WebViewEventKind.FindResult,
			tabId: spec.tabId,
			matches: result.matches,
			activeMatch: result.activeMatchOrdinal,
		});
	});

	spec.window.baseWindow.contentView.addChildView(view as unknown as WebContentsViewHandle);

	return {
		webContentsId: wc.id,
		loadUrl: (url) => {
			void wc.loadURL(url).catch(() => {
				// A bad URL / network error surfaces as a did-fail-load event.
			});
		},
		navigateBack: () => {
			if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
		},
		navigateForward: () => {
			if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
		},
		reload: () => wc.reload(),
		stop: () => wc.stop(),
		findInPage: (query, forward) => {
			if (query.length > 0) wc.findInPage(query, { forward });
		},
		stopFind: () => wc.stopFindInPage("clearSelection"),
		setBounds: (rect) => {
			// The chrome reports the web-region in its own viewport coords; offset
			// by the window body origin to land in window-content coords.
			const origin = spec.window.bodyOrigin();
			view.setBounds({
				x: rect.x + origin.x,
				y: rect.y + origin.y,
				width: rect.width,
				height: rect.height,
			});
		},
		setVisible: (visible) => view.setVisible(visible),
		focus: () => {
			if (!wc.isDestroyed()) wc.focus();
		},
		destroy: () => {
			if (!spec.window.baseWindow.isDestroyed()) {
				spec.window.baseWindow.contentView.removeChildView(view as unknown as WebContentsViewHandle);
			}
			if (!wc.isDestroyed()) wc.close();
		},
	};
}

/** A site's favicon is small by construction; cap the fetch so a hostile
 *  oversized "favicon" can't bloat the metadata event / IPC. */
const MAX_FAVICON_BYTES = 256 * 1024;

/**
 * Fetch `url` in the tab's own session and encode it as a `data:` URL the
 * chrome can render under its CSP. Returns `null` on any failure (non-OK
 * status, empty body, over the size cap) — a missing favicon is not an error.
 */
async function resolveFaviconDataUrl(ses: Session, url: string): Promise<string | null> {
	const response = await ses.fetch(url);
	if (!response.ok) return null;
	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.byteLength === 0 || buffer.byteLength > MAX_FAVICON_BYTES) return null;
	const contentType = response.headers.get("content-type") ?? "image/x-icon";
	return `data:${contentType};base64,${buffer.toString("base64")}`;
}

/**
 * Install the locked-down policy on `ses` exactly once (deny-default device
 * permissions, tracker/ad blocklist + egress audit, third-party-cookie strip).
 * Every decision attributes per request via `spec.resolveTabContext` — for the
 * shared persistent session (Browser-10) a single set of handlers serves all
 * its tabs, so a captured single-view `wc`/`tabId` would be wrong. Per-tab
 * tracker counts live here, keyed by the resolved tab.
 */
function configureSessionPolicy(
	ses: Session,
	spec: CreateViewSpec,
	deps: WebViewFactoryDeps,
	blocklist: readonly string[],
): void {
	if (configuredSessions.has(ses)) return;
	configuredSessions.add(ses);

	const decide = deps.decidePermission ?? (() => null);
	const trackerCounts = new Map<string, number>();

	// Deny-default device permissions (Browser-7): camera / microphone /
	// geolocation resolve from the per-vault grant store; an unset decision
	// denies AND surfaces the ask (on the requesting tab) so the chrome can
	// offer an explicit per-site grant. Everything else stays deny-always.
	ses.setPermissionRequestHandler((reqWc, permission, callback, details) => {
		const origin = webOriginOf(details.requestingUrl);
		const mediaTypes = (details as { mediaTypes?: readonly string[] }).mediaTypes;
		const kinds = sitePermissionKindsFor(permission, mediaTypes);
		if (!origin || kinds.length === 0) {
			callback(false);
			return;
		}
		const decisions = kinds.map((kind) => decide(origin, kind));
		if (decisions.every((d) => d === true)) {
			callback(true);
			return;
		}
		const tabId = spec.resolveTabContext(reqWc.id)?.tabId;
		for (let i = 0; i < kinds.length; i += 1) {
			// Only the unset kinds surface the ask — an explicit block is the
			// user saying "stop asking". Without a resolved tab we can't route
			// the ask, so we silently deny (fail-closed).
			if (decisions[i] === null && tabId !== undefined) {
				spec.emitForApp({
					kind: WebViewEventKind.PermissionRequested,
					tabId,
					origin,
					permission: kinds[i] as SitePermissionKind,
				});
			}
		}
		callback(false);
	});
	ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
		const origin = webOriginOf(requestingOrigin);
		const mediaTypes = (details as { mediaTypes?: readonly string[] }).mediaTypes;
		const kinds = sitePermissionKindsFor(permission, mediaTypes);
		if (!origin || kinds.length === 0) return false;
		return kinds.every((kind) => decide(origin, kind) === true);
	});

	// Browser-8 — a page whose FIRST PARTY origin the user marked TRUSTED opts
	// out of the strict tracker-blocklist + third-party-cookie strip (the escape
	// hatch for login-gated SPAs). Keyed by the requesting tab's top-level origin,
	// never the request URL; unknown / untrusted first party ⇒ strict default.
	const trustedFirstParty = (details: { webContentsId?: number }): boolean => {
		if (!deps.isTrustedOrigin) return false;
		const firstParty = spec.resolveTabContext(webContentsIdOf(details))?.firstPartyUrl;
		if (!firstParty) return false;
		const origin = webOriginOf(firstParty);
		return origin !== null && deps.isTrustedOrigin(origin);
	};

	// Tracker/ad blocklist (cancel only — top-level HTTPS-upgrade is done in the
	// service, so no risky per-subresource redirect here). Every request also
	// lands one per-host tick in the Browser-7 egress aggregate.
	ses.webRequest.onBeforeRequest((details, callback) => {
		const blocked = isBlockedRequest(details.url, blocklist) && !trustedFirstParty(details);
		const host = networkEgressHostOf(details.url);
		if (host.length > 0) deps.recordEgress?.(host, blocked);
		if (blocked) {
			const tabId = spec.resolveTabContext(webContentsIdOf(details))?.tabId;
			if (tabId !== undefined) {
				const next = (trackerCounts.get(tabId) ?? 0) + 1;
				trackerCounts.set(tabId, next);
				spec.emitForApp({
					kind: WebViewEventKind.TrackerBlocked,
					tabId,
					blockedTrackerCount: next,
				});
			}
			callback({ cancel: true });
			return;
		}
		callback({});
	});

	// Browser-4 — third-party-cookie block. The persistent partition shares one
	// jar across a site's tabs, but these two hooks still kill cross-SITE cookie
	// linkage: a third-party subresource neither sends nor stores cookies. First
	// party = the requesting TAB's current top-level URL (resolved per request,
	// since the shared session multiplexes many tabs). Fail CLOSED: a non-main-
	// frame request we can't attribute to a tab (unknown webContents — a
	// teardown race) is treated as third-party and stripped, never passed
	// through. Since the persistent jar is shared across a site's tabs this
	// strip is the only cross-site protection, so the safe default is to strip.
	const stripsThirdPartyCookies = (details: {
		url: string;
		webContentsId?: number;
		resourceType?: string;
	}): boolean => {
		if (details.resourceType === "mainFrame") return false;
		const firstParty = spec.resolveTabContext(webContentsIdOf(details))?.firstPartyUrl;
		// Unknown first-party ⇒ unattributable subresource ⇒ fail closed (strip).
		if (!firstParty) return true;
		// Browser-8 — a trusted first party opts out of the 3p-cookie strip so its
		// SSO / cross-subdomain cookies flow (the reason the strict default breaks
		// login-gated SPAs). Untrusted ⇒ the strict strip stands.
		if (trustedFirstParty(details)) return false;
		return isThirdPartyRequest(details.url, firstParty);
	};
	ses.webRequest.onBeforeSendHeaders((details, callback) => {
		if (stripsThirdPartyCookies(details)) {
			callback({ requestHeaders: withoutCookieHeader(details.requestHeaders) });
			return;
		}
		callback({ requestHeaders: details.requestHeaders });
	});
	ses.webRequest.onHeadersReceived((details, callback) => {
		if (details.responseHeaders && stripsThirdPartyCookies(details)) {
			callback({ responseHeaders: withoutSetCookieHeaders(details.responseHeaders) });
			return;
		}
		callback({});
	});
}

/** The webContents id on a webRequest details object (present for requests that
 *  originate from a page). Typed loosely because Electron's per-method details
 *  shapes don't all surface it in the public types. */
function webContentsIdOf(details: { webContentsId?: number }): number {
	return details.webContentsId ?? -1;
}

function emitLoad(spec: CreateViewSpec, loadState: TabLoadState): void {
	spec.onEvent({ kind: WebViewEventKind.LoadStateChanged, tabId: spec.tabId, loadState });
}

function emitUrl(spec: CreateViewSpec, url: string): void {
	spec.onEvent({ kind: WebViewEventKind.UrlChanged, tabId: spec.tabId, url });
	spec.onEvent({
		kind: WebViewEventKind.SecurityStateChanged,
		tabId: spec.tabId,
		securityState: securityStateForUrl(url),
	});
}
