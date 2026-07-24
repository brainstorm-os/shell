/**
 * `WebView` host-service wire contract — the **chrome-only / shell-engine
 * split keystone** (§The core tension).
 *
 * Shared home (Browser-2): both the shell-side host service and the Browser
 * app's chrome import these enums/types from here, so the two sides speak one
 * vocabulary. Browser-1 first froze this contract under the app
 * (`apps/browser/src/types/web-view.ts`); that module now re-exports from here
 * so the app's public surface — and the frozen wire values — are unchanged.
 *
 * Web content runs in shell-managed, partitioned, Node-less `WebContentsView`s.
 * The chrome has **no** access to the page DOM or bytes — it drives the host
 * through {@link WebViewMethod} calls and receives only {@link WebViewEvent}
 * *metadata* events. The dangerous engine is shell-side, exactly like Mailbox.
 */

/** Use the shell `WebView` host service to open navigable web pages. The
 *  broadest egress surface a user can grant — **High** severity. */
export const WEB_BROWSE_CAP = "web.browse";

/** Ask the shell to extract a reader snapshot of the current page into a
 *  `brainstorm/Bookmark/v1`. Medium — no raw bytes reach the app. */
export const WEB_CAPTURE_CAP = "web.capture";

/** Broadcast channel the shell uses to push {@link WebViewEvent}s to the
 *  Browser app's preload, mirroring `app:files-watch`. */
export const APP_WEBVIEW_EVENT_CHANNEL = "app:webview-event";

/** Channel the shell uses to forward a window-management chord (Cmd+T / Cmd+W)
 *  to an app that self-manages its own tabs (the Browser). The shell owns these
 *  chords globally; for a self-tabbing app it routes the intent to the renderer
 *  instead of acting on the window-container, so the app mutates its own tab
 *  model. The preload re-dispatches as a `brainstorm:tab-command` CustomEvent,
 *  mirroring the `brainstorm:app-visibility` seam. */
export const APP_TAB_COMMAND_CHANNEL = "window:tab-command";

/** Window-management commands a self-tabbing app receives over
 *  {@link APP_TAB_COMMAND_CHANNEL}. Values are the wire payload. */
export enum TabCommandKind {
	NewTab = "new-tab",
	CloseTab = "close-tab",
}

export type TabCommand = { kind: TabCommandKind };

/** Device permissions a site may be granted per-origin (Browser-7). Everything
 *  else a page can ask for stays deny-always — these are the only grantable
 *  kinds, chosen because each has an explicit user-facing consent story.
 *  Values are the wire payload AND the persisted form. */
export enum SitePermissionKind {
	Camera = "camera",
	Microphone = "microphone",
	Geolocation = "geolocation",
}

/** Wire identifier of the `WebView` host service. The IPC envelope's `service`
 *  field is lowercase-only (`/^[a-z][a-z0-9-]{0,63}$/`), so the wire name is
 *  `webview` even though the JS proxy property is `webView`. Both the shell
 *  registration and the SDK proxy reference this constant so they can't drift
 *  into a name the broker rejects. */
export const WEBVIEW_SERVICE = "webview";

/** Page load lifecycle, driven by `WebView` host load-state events. Runtime
 *  only — never persisted (a restored tab starts {@link TabLoadState.Idle}
 *  and re-navigates). The wire value is the string itself. */
export enum TabLoadState {
	Idle = "idle",
	Loading = "loading",
	Loaded = "loaded",
	Failed = "failed",
}

/** Connection-security badge shown in the URL bar, from the host's
 *  security-state events. Runtime only. */
export enum TabSecurityState {
	/** `https://` with a valid certificate chain. */
	Secure = "secure",
	/** `http://` — no transport security. */
	Insecure = "insecure",
	/** `https://` page that pulled insecure subresources. */
	Mixed = "mixed",
	/** `about:blank` / new-tab chrome — no remote origin yet. */
	Local = "local",
}

/** Methods the chrome calls on the host service. Every call names a `tabId`
 *  except {@link WebViewMethod.Open} (which mints one) — the host maps it to a
 *  `WebContentsView` in the window's partitioned session. */
export enum WebViewMethod {
	/** Create a `WebContentsView` in the window partition and load `url`. */
	Open = "open",
	Navigate = "navigate",
	Back = "back",
	Forward = "forward",
	Reload = "reload",
	Stop = "stop",
	/** Destroy the view and its throwaway partition (private-by-default). */
	Close = "close",
	/** Bring `tabId`'s view to the front of the window's content area. */
	Activate = "activate",
	/** Position the active view under the chrome (the chrome owns layout). */
	SetBounds = "set-bounds",
	FindInPage = "find-in-page",
	StopFind = "stop-find",
	/** Reader-extract the current page → `Bookmark/v1` (needs `web.capture`). */
	Capture = "capture",
	/** Persist a per-origin device-permission decision (Browser-7). The next
	 *  page request for that origin+kind resolves from the grant store. */
	SetSitePermission = "set-site-permission",
	/** Browser-10 — wipe the persistent cookie jar (the encrypted `cookies.db`
	 *  AND the live persistent partition's cookies). Settings → Privacy →
	 *  "Clear browsing data". No `tabId` — it spans the whole jar. */
	ClearBrowsingData = "clear-browsing-data",
	/** Browser-8 — trust (or untrust) `origin`: relax the tracker blocklist +
	 *  third-party-cookie strip for pages whose first party is that origin. The
	 *  in-browser twin of Settings → Privacy → Trusted sites. */
	SetSiteTrust = "set-site-trust",
	/** Browser-8 — whether `origin` is currently trusted (drives the chrome's
	 *  Trust / Untrust affordance). */
	IsSiteTrusted = "is-site-trusted",
}

/** Why a browser download did not land in the vault (Browser-6). Wire payload
 *  of a {@link WebViewEventKind.DownloadFailed} event — a small closed set, so
 *  it is an enum, never a raw string. */
export enum DownloadFailReason {
	/** Declared or received size exceeded the download ceiling. */
	TooLarge = "too-large",
	/** The transfer was cancelled or interrupted before completing. */
	Interrupted = "interrupted",
	/** Completed with zero bytes — nothing to seal. */
	Empty = "empty",
	/** Sealing the bytes / writing the File/v1 entity failed vault-side. */
	WriteFailed = "write-failed",
}

export type WebViewRect = { x: number; y: number; width: number; height: number };

export type WebViewRequest =
	| { method: WebViewMethod.Open; tabId: string; url: string; private?: boolean }
	| { method: WebViewMethod.Navigate; tabId: string; url: string }
	| { method: WebViewMethod.Back; tabId: string }
	| { method: WebViewMethod.Forward; tabId: string }
	| { method: WebViewMethod.Reload; tabId: string }
	| { method: WebViewMethod.Stop; tabId: string }
	| { method: WebViewMethod.Close; tabId: string }
	| { method: WebViewMethod.Activate; tabId: string }
	| { method: WebViewMethod.SetBounds; tabId: string; bounds: WebViewRect }
	| { method: WebViewMethod.FindInPage; tabId: string; query: string; forward: boolean }
	| { method: WebViewMethod.StopFind; tabId: string }
	| { method: WebViewMethod.Capture; tabId: string; selectionOnly: boolean }
	| {
			method: WebViewMethod.SetSitePermission;
			tabId: string;
			origin: string;
			permission: SitePermissionKind;
			allow: boolean;
	  }
	| { method: WebViewMethod.ClearBrowsingData }
	| { method: WebViewMethod.SetSiteTrust; origin: string; trusted: boolean }
	| { method: WebViewMethod.IsSiteTrusted; origin: string };

/** Metadata-only events the host pushes to the chrome. The page DOM, bytes,
 *  and live history never cross this boundary — only these projections. */
export enum WebViewEventKind {
	TitleChanged = "title-changed",
	FaviconChanged = "favicon-changed",
	/** In-page navigation / redirect changed the visible URL. */
	UrlChanged = "url-changed",
	LoadStateChanged = "load-state-changed",
	SecurityStateChanged = "security-state-changed",
	/** A tracker/ad request was blocked — the chrome increments its shield. */
	TrackerBlocked = "tracker-blocked",
	/** Find-in-page match count + active-match ordinal (coordinates stay in
	 *  the view; the host highlights, the chrome only counts). */
	FindResult = "find-result",
	/** The site requested a deny-by-default device permission (camera/mic/geo/…)
	 *  — the chrome surfaces an explicit per-site grant in the address bar. */
	PermissionRequested = "permission-requested",
	/** A capture finished; carries the written `Bookmark/v1` entity id. */
	Captured = "captured",
	/** Browser-6 — a download began; the host is buffering + sealing it into
	 *  the vault (the bytes never reach the chrome). */
	DownloadStarted = "download-started",
	/** Browser-6 — a download was sealed into the vault as a `File/v1` entity;
	 *  carries the created entity id + the stored (sanitized) filename. */
	DownloadCompleted = "download-completed",
	/** Browser-6 — a download did not land in the vault (too large, cancelled,
	 *  empty, or a vault-side write failure). */
	DownloadFailed = "download-failed",
	/** The view closed (crash, host-side teardown, or user close). */
	Closed = "closed",
}

/** The chrome-side client surface (`runtime.services.webView`). Each method
 *  maps 1:1 to a {@link WebViewMethod}; `onEvent` subscribes to the per-app
 *  metadata-event stream (the preload routes the broadcast channel into it). */
export interface WebViewClient {
	/** Open `url` in a new tab. `isPrivate` tabs get a throwaway per-tab
	 *  partition (no persistence, never written to the cookie jar); normal tabs
	 *  share the persistent partition (Browser-10). */
	open(tabId: string, url: string, isPrivate?: boolean): Promise<void>;
	navigate(tabId: string, url: string): Promise<void>;
	back(tabId: string): Promise<void>;
	forward(tabId: string): Promise<void>;
	reload(tabId: string): Promise<void>;
	stop(tabId: string): Promise<void>;
	close(tabId: string): Promise<void>;
	activate(tabId: string): Promise<void>;
	setBounds(tabId: string, bounds: WebViewRect): Promise<void>;
	findInPage(tabId: string, query: string, forward: boolean): Promise<void>;
	stopFind(tabId: string): Promise<void>;
	capture(tabId: string, selectionOnly: boolean): Promise<{ bookmarkId: string } | null>;
	setSitePermission(
		tabId: string,
		origin: string,
		permission: SitePermissionKind,
		allow: boolean,
	): Promise<void>;
	/** Wipe the persistent cookie jar (encrypted store + live session). */
	clearBrowsingData(): Promise<void>;
	/** Browser-8 — trust / untrust `origin` (relax the strict tracker + cookie
	 *  blocking for pages it's the first party of). Reload the tab to apply. */
	setSiteTrust(origin: string, trusted: boolean): Promise<void>;
	/** Browser-8 — whether `origin` is currently trusted. */
	isSiteTrusted(origin: string): Promise<boolean>;
	/** Subscribe to metadata events; returns an unsubscribe fn. */
	onEvent(listener: (event: WebViewEvent) => void): () => void;
}

export type WebViewEvent =
	| { kind: WebViewEventKind.TitleChanged; tabId: string; title: string }
	| { kind: WebViewEventKind.FaviconChanged; tabId: string; faviconUrl: string | null }
	| { kind: WebViewEventKind.UrlChanged; tabId: string; url: string }
	| { kind: WebViewEventKind.LoadStateChanged; tabId: string; loadState: TabLoadState }
	| { kind: WebViewEventKind.SecurityStateChanged; tabId: string; securityState: TabSecurityState }
	| { kind: WebViewEventKind.TrackerBlocked; tabId: string; blockedTrackerCount: number }
	| { kind: WebViewEventKind.FindResult; tabId: string; matches: number; activeMatch: number }
	| {
			kind: WebViewEventKind.PermissionRequested;
			tabId: string;
			/** `https://example.com` origin asking for the device. */
			origin: string;
			permission: SitePermissionKind;
	  }
	| { kind: WebViewEventKind.Captured; tabId: string; bookmarkId: string }
	| { kind: WebViewEventKind.DownloadStarted; tabId: string; downloadId: string; filename: string }
	| {
			kind: WebViewEventKind.DownloadCompleted;
			tabId: string;
			downloadId: string;
			/** The stored (server-side sanitized) filename. */
			filename: string;
			/** The created `brainstorm/File/v1` entity id. */
			fileId: string;
	  }
	| {
			kind: WebViewEventKind.DownloadFailed;
			tabId: string;
			downloadId: string;
			filename: string;
			reason: DownloadFailReason;
	  }
	| { kind: WebViewEventKind.Closed; tabId: string };
