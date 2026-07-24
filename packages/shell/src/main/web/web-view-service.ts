/**
 * The `WebView` host service (Browser-2, §The core
 * tension). Web content runs in shell-managed, partitioned, Node-less
 * `WebContentsView`s that the Browser app's chrome drives through this service;
 * the chrome never touches the page DOM or bytes — it sends {@link
 * WebViewMethod} calls and receives only {@link WebViewEvent} metadata.
 *
 * This module is the **pure orchestration core**: a tab registry, method
 * routing, OQ-WV-2 suspension, and metadata-event fan-out. Every Electron
 * touch-point — constructing the `WebContentsView`, applying the locked-down
 * session policy ({@link web-policy}/`locked-session`), wiring native events —
 * is injected via {@link WebViewServiceOptions.createView} so the whole
 * service is exhaustively unit-testable with fakes (the `files-service` /
 * `scheduler` injected-port discipline). The real glue is `web-view-factory.ts`
 * (verified in the running shell, like `print-to-pdf`).
 */

import {
	type SitePermissionKind,
	type WebViewEvent,
	WebViewEventKind,
	type WebViewExtractedText,
	WebViewMethod,
	type WebViewRect,
	type WebViewRequest,
} from "@brainstorm-os/sdk-types";
import type { Envelope } from "../../ipc/envelope";
import type { BaseWindowHandle } from "../apps/window-container";
import { clampLiveDomHtml } from "./web-live-dom";
import { upgradeToHttps } from "./web-policy";
import { BrowseMode, resolveBrowseMode } from "./web-readonly";

/** OQ-WV-1: one `WebContentsView` per tab with its own ephemeral partition.
 *  OQ-WV-2: this many stay live per service; beyond it the least-recently-
 *  active non-pinned tab is suspended (its view destroyed, URL retained for
 *  reload on re-activation). Pinned tabs are exempt. */
export const DEFAULT_MAX_LIVE_VIEWS = 6;

/** The window a tab's view is parented into. The factory attaches the view to
 *  `baseWindow.contentView`; the service only routes. `bodyOrigin` is the
 *  top-left of the app-renderer body region in window-content coords — the
 *  factory adds it to the chrome's viewport-relative `SetBounds` rect so the
 *  web view lands under the chrome (below the shell tab strip). */
export type WindowTarget = {
	baseWindow: BaseWindowHandle;
	windowId: string;
	bodyOrigin: () => { x: number; y: number };
};

/** The subset of an Electron `WebContentsView` + its `webContents` the service
 *  drives. The real factory backs it; tests fake it. */
export interface ManagedWebView {
	/** The view's webContents id — lets the shell map OS-level input focused on
	 *  the page (e.g. the Cmd+T menu accelerator) back to the owning tab. */
	readonly webContentsId: number;
	loadUrl(url: string): void;
	navigateBack(): void;
	navigateForward(): void;
	reload(): void;
	stop(): void;
	findInPage(query: string, forward: boolean): void;
	stopFind(): void;
	setBounds(rect: WebViewRect): void;
	setVisible(visible: boolean): void;
	focus(): void;
	/** Net-3 — the page's RENDERED DOM, read out of the live view (what the user
	 *  can actually see, not what a second GET would return). `null` when the
	 *  page can't be read (no live view, an internal page, a failed eval). */
	captureHtml(): Promise<string | null>;
	/** Destroy the view and its throwaway partition (private-by-default). */
	destroy(): void;
}

export type CreateViewSpec = {
	tabId: string;
	/** The app whose chrome drives this tab (the Browser). */
	appId: string;
	/** The Chromium partition. The shared {@link PERSISTENT_WEB_PARTITION} for a
	 *  normal tab, or a throwaway per-tab string for a private tab. */
	partition: string;
	/** True for a private tab (throwaway single-view partition); false for the
	 *  shared persistent partition (many views — session policy installs once). */
	private: boolean;
	/** Browser-8 — the mode this view runs in, decided ONCE from the caps the
	 *  broker verified on the opening call. `ReadOnly` makes the factory refuse
	 *  every state-changing request the page tries to send. */
	mode: BrowseMode;
	window: WindowTarget;
	/** Native metadata events for this tab, already tagged with `tabId`. */
	onEvent: (event: WebViewEvent) => void;
	/** Resolve the owning tab + its current top-level URL for a webContents id.
	 *  A request or permission ask in the SHARED persistent session can come
	 *  from any of its tabs, so session-level handlers (installed once) attribute
	 *  by webContents — for event tagging (`tabId`) and first-party comparison
	 *  in the third-party-cookie strip (`firstPartyUrl`). Null when unknown. */
	resolveTabContext: (webContentsId: number) => { tabId: string; firstPartyUrl: string } | null;
	/** Emit a tab-tagged event to the owning app, independent of which view
	 *  registered the shared-session handler. */
	emitForApp: (event: WebViewEvent) => void;
};

export type CaptureSpec = {
	tabId: string;
	url: string;
	title: string;
	selectionOnly: boolean;
};

/** Browser-6 — a completed download the factory hands to the vault-side seal.
 *  `bytes` are UNTRUSTED (the page's response body); the seal sanitizes the
 *  name, applies the served-mime allow-list, and writes a `File/v1` entity. */
export type DownloadCapture = {
	tabId: string;
	/** The app whose chrome owns the browsing session (the Browser). */
	appId: string;
	/** The download's originating URL (validated http(s) vault-side). */
	url: string;
	/** Server-supplied filename (Content-Disposition) — sanitized vault-side. */
	suggestedFilename: string;
	/** Server-reported Content-Type — advisory; the served mime is re-derived
	 *  from the sanitized name vault-side. */
	serverMimeType: string;
	bytes: Uint8Array;
};

/** The seal's reply: the created `File/v1` entity id + the stored (sanitized)
 *  filename the chrome surfaces on the DownloadCompleted event. */
export type DownloadOutcome = { fileId: string; name: string };

export type WebViewServiceOptions = {
	/** Construct + attach a locked-down view to the target window and wire its
	 *  native events to `spec.onEvent`. The Electron half lives here. */
	createView: (spec: CreateViewSpec) => ManagedWebView;
	/** Resolve which window of `appId` a new tab attaches to (the focused
	 *  browser window). `null` when the app has no live window. */
	resolveWindow: (appId: string) => WindowTarget | null;
	/** Push a metadata event to the app's chrome (the broadcast channel). */
	emitEvent: (appId: string, event: WebViewEvent) => void;
	/** Reader-extract the page → `Bookmark/v1`; returns the entity id. */
	capture?: (appId: string, spec: CaptureSpec) => Promise<string>;
	/** Browser-8 / Net-3 — turn a page's RENDERED DOM into its reader projection
	 *  (no vault write). The service pulls the DOM off the live view and passes
	 *  it here; production binds this to the Net-2 extraction worker, so the
	 *  CPU-heavy parse stays off the broker loop. Absent ⇒
	 *  {@link WebViewMethod.ExtractText} resolves `null`. */
	extractText?: (
		appId: string,
		spec: CaptureSpec & { html: string },
	) => Promise<WebViewExtractedText | null>;
	/** Browser-7 — persist a per-origin device-permission decision. Absent ⇒
	 *  the method is a no-op (deny-default stands). */
	setSitePermission?: (
		origin: string,
		permission: SitePermissionKind,
		allow: boolean,
	) => Promise<void> | void;
	/** OQ-WV-2 live-view cap. Defaults to {@link DEFAULT_MAX_LIVE_VIEWS}. */
	maxLiveViews?: number;
	/** Injected clock for LRU ordering (tests pass a deterministic counter). */
	now?: () => number;
	/** Browser-10 — wipe the persistent cookie jar (encrypted store + live
	 *  session). Absent ⇒ {@link WebViewMethod.ClearBrowsingData} is a no-op. */
	clearBrowsingData?: () => Promise<void> | void;
	/** Browser-8 — trust / untrust an origin (relaxes the strict tracker + cookie
	 *  blocking for it). Absent ⇒ {@link WebViewMethod.SetSiteTrust} is a no-op. */
	setSiteTrust?: (origin: string, trusted: boolean) => Promise<void> | void;
	/** Browser-8 — whether an origin is trusted. Absent ⇒ always `false`. */
	isSiteTrusted?: (origin: string) => boolean;
};

type TabEntry = {
	tabId: string;
	appId: string;
	window: WindowTarget;
	partition: string;
	/** Private tabs never touch the persistent partition or the cookie jar. */
	private: boolean;
	url: string;
	title: string;
	pinned: boolean;
	lastActiveAt: number;
	/** Live view, or null when suspended (URL retained for reload). */
	view: ManagedWebView | null;
	/** Browser-8 — the browse mode fixed at open. Carried on the entry so a
	 *  suspension remount rebuilds the same mode instead of silently widening. */
	mode: BrowseMode;
	/** Last bounds the chrome pushed. A freshly created `WebContentsView` is
	 *  0×0 until someone sizes it, and the chrome only re-pushes bounds when its
	 *  active-tab id changes — so a remount (suspension restore, omnibox
	 *  navigate on a suspended tab) must reapply these or the page loads into
	 *  an invisible view (the "navigation happened but the screen is blank" bug). */
	bounds: WebViewRect | null;
};

/** The single in-memory partition shared by all NON-private tabs (Browser-10).
 *  Electron keys sessions by partition string, so this one session — and its
 *  cookie jar — outlives individual tab open/close within a run. The encrypted
 *  `cookies.db` jar (`web-cookie-jar.ts`) re-injects saved cookies into it on
 *  vault open and mirrors changes back, giving persistence across restarts.
 *  Non-`persist:` ⇒ Chromium writes nothing to disk itself; WE own
 *  persistence, encrypted under the vault master key. The jar attaches to this
 *  exact partition string, so it is the single source of truth for its name. */
export const PERSISTENT_WEB_PARTITION = "bs-web-persist";

function partitionFor(tabId: string, isolated: boolean): string {
	// Private tabs keep a throwaway, per-tab, non-`persist:` partition (no
	// persistence, no cross-tab linkage — true incognito). Normal tabs share
	// the persistent partition so a login sticks across tabs and restarts.
	//
	// Browser-8: a READ-ONLY tab is isolated the same way. Two reasons — the
	// per-request method guard is a session-level handler (installed once per
	// session, so a read-only view must not share a session with a full one),
	// and an autonomous loop should never be browsing inside the user's logged-in
	// cookie jar in the first place.
	return isolated ? `bs-web-${tabId}` : PERSISTENT_WEB_PARTITION;
}

/**
 * Pure orchestration core behind {@link makeWebViewServiceHandler}. Exposed so
 * tests drive it without the broker envelope wrapper.
 */
export class WebViewService {
	private readonly tabs = new Map<string, TabEntry>();
	/** Reverse index for the shared-session handlers: a webContents id → the
	 *  tab that owns it. Populated on mount, cleared on suspend/close. */
	private readonly byWebContents = new Map<number, string>();
	private readonly maxLiveViews: number;
	private readonly now: () => number;
	private tick = 0;

	constructor(private readonly options: WebViewServiceOptions) {
		this.maxLiveViews = options.maxLiveViews ?? DEFAULT_MAX_LIVE_VIEWS;
		this.now = options.now ?? (() => ++this.tick);
	}

	/** Live (non-suspended) tab views, for tests + the suspension policy. */
	liveCount(): number {
		let n = 0;
		for (const t of this.tabs.values()) if (t.view !== null) n += 1;
		return n;
	}

	handle(
		appId: string,
		req: WebViewRequest,
		/** The capabilities the broker VERIFIED for this call — the only input
		 *  the browse mode is derived from (Browser-8). */
		declaredCaps: readonly string[] = [],
	): Promise<unknown> | unknown {
		switch (req.method) {
			case WebViewMethod.Open:
				return this.open(
					appId,
					req.tabId,
					req.url,
					req.private === true,
					resolveBrowseMode(declaredCaps),
				);
			case WebViewMethod.Navigate:
				return this.navigate(appId, req.tabId, req.url);
			case WebViewMethod.Back:
				return this.withLiveView(req.tabId, (v) => v.navigateBack());
			case WebViewMethod.Forward:
				return this.withLiveView(req.tabId, (v) => v.navigateForward());
			case WebViewMethod.Reload:
				return this.withLiveView(req.tabId, (v) => v.reload());
			case WebViewMethod.Stop:
				return this.withLiveView(req.tabId, (v) => v.stop());
			case WebViewMethod.Close:
				return this.close(req.tabId);
			case WebViewMethod.Activate:
				return this.activate(appId, req.tabId);
			case WebViewMethod.SetBounds:
				return this.setBounds(req.tabId, req.bounds);
			case WebViewMethod.FindInPage:
				return this.withLiveView(req.tabId, (v) => v.findInPage(req.query, req.forward));
			case WebViewMethod.StopFind:
				return this.withLiveView(req.tabId, (v) => v.stopFind());
			case WebViewMethod.Capture:
				return this.capture(appId, req.tabId, req.selectionOnly);
			case WebViewMethod.SetSitePermission:
				return this.options.setSitePermission?.(req.origin, req.permission, req.allow);
			case WebViewMethod.ClearBrowsingData:
				return this.options.clearBrowsingData?.();
			case WebViewMethod.SetSiteTrust:
				return this.options.setSiteTrust?.(req.origin, req.trusted);
			case WebViewMethod.IsSiteTrusted:
				return this.options.isSiteTrusted?.(req.origin) ?? false;
			case WebViewMethod.ExtractText:
				return this.extractText(appId, req.tabId);
		}
	}

	private open(
		appId: string,
		tabId: string,
		url: string,
		isPrivate: boolean,
		mode: BrowseMode,
	): void {
		if (this.tabs.has(tabId)) {
			// Idempotent re-open ⇒ treat as a navigate (privacy is fixed at mint).
			this.navigate(appId, tabId, url);
			return;
		}
		const window = this.options.resolveWindow(appId);
		if (!window) {
			// No live browser window to parent the view into — the tab can't be
			// mounted. Without a signal the chrome believes the tab opened and
			// shows a phantom that never loads / never errors, so emit the
			// closed/teardown event the chrome already understands; its reducer
			// surfaces or drops the tab instead of leaving it dangling.
			this.options.emitEvent(appId, { kind: WebViewEventKind.Closed, tabId });
			return;
		}
		const target = upgradeToHttps(url) ?? url;
		const entry: TabEntry = {
			tabId,
			appId,
			window,
			partition: partitionFor(tabId, isPrivate || mode === BrowseMode.ReadOnly),
			private: isPrivate,
			url: target,
			title: "",
			pinned: false,
			lastActiveAt: this.now(),
			view: null,
			bounds: null,
			mode,
		};
		this.tabs.set(tabId, entry);
		this.mountView(entry);
		entry.view?.loadUrl(entry.url);
		this.enforceSuspensionCap();
	}

	private navigate(appId: string, tabId: string, url: string): void {
		const entry = this.tabs.get(tabId);
		if (!entry) {
			// A navigate before open mints a normal (non-private) tab; a private
			// tab is always created through an explicit private open. The mode
			// is the fail-closed one — a tab that was never explicitly opened
			// with `web.browse` doesn't get full browsing by the back door.
			this.open(appId, tabId, url, false, BrowseMode.ReadOnly);
			return;
		}
		entry.url = upgradeToHttps(url) ?? url;
		entry.lastActiveAt = this.now();
		if (entry.view === null) this.mountView(entry);
		entry.view?.loadUrl(entry.url);
		this.enforceSuspensionCap();
	}

	private activate(appId: string, tabId: string): void {
		const entry = this.tabs.get(tabId);
		if (!entry) return;
		entry.lastActiveAt = this.now();
		// Restore a suspended tab by reloading its retained URL.
		if (entry.view === null) {
			this.mountView(entry).loadUrl(entry.url);
		}
		// Only the active tab's view is visible; hide the others in this window.
		for (const other of this.tabs.values()) {
			if (other.window.windowId !== entry.window.windowId || other.view === null) continue;
			other.view.setVisible(other.tabId === tabId);
		}
		entry.view?.focus();
		this.enforceSuspensionCap();
	}

	private close(tabId: string): void {
		const entry = this.tabs.get(tabId);
		if (!entry) return;
		this.teardownView(entry);
		this.tabs.delete(tabId);
		this.options.emitEvent(entry.appId, { kind: WebViewEventKind.Closed, tabId });
	}

	private async capture(appId: string, tabId: string, selectionOnly: boolean): Promise<unknown> {
		const entry = this.tabs.get(tabId);
		if (!entry || !this.options.capture) return undefined;
		const bookmarkId = await this.options.capture(appId, {
			tabId,
			url: entry.url,
			title: entry.title,
			selectionOnly,
		});
		this.options.emitEvent(appId, { kind: WebViewEventKind.Captured, tabId, bookmarkId });
		return { bookmarkId };
	}

	/** Browser-8 — the reader projection of a tab, returned to the caller. Same
	 *  extraction the capture path uses, minus the vault write; `null` when the
	 *  tab is unknown or the host wired no extractor. */
	private async extractText(appId: string, tabId: string): Promise<WebViewExtractedText | null> {
		const entry = this.tabs.get(tabId);
		if (!entry || !this.options.extractText) return null;
		// Net-3 — a suspended tab has no DOM to read; re-mounting one behind the
		// user's back to answer a read would be a surprising navigation, so an
		// unreadable tab honestly reports "nothing".
		const html = await entry.view?.captureHtml();
		if (!html) return null;
		return this.options.extractText(appId, {
			tabId,
			url: entry.url,
			title: entry.title,
			selectionOnly: false,
			html: clampLiveDomHtml(html),
		});
	}

	private withLiveView(tabId: string, fn: (view: ManagedWebView) => void): void {
		const view = this.tabs.get(tabId)?.view;
		if (view) fn(view);
	}

	/** Unlike the other live-view methods, bounds are retained on the entry —
	 *  a suspended tab's remount must restore them (see {@link TabEntry.bounds}). */
	private setBounds(tabId: string, bounds: WebViewRect): void {
		const entry = this.tabs.get(tabId);
		if (!entry) return;
		entry.bounds = bounds;
		entry.view?.setBounds(bounds);
	}

	private mountView(entry: TabEntry): ManagedWebView {
		entry.view = this.options.createView({
			tabId: entry.tabId,
			appId: entry.appId,
			partition: entry.partition,
			private: entry.private,
			mode: entry.mode,
			window: entry.window,
			onEvent: (event) => {
				// Keep the registry's title in sync so a later capture has it.
				if (event.kind === WebViewEventKind.TitleChanged) entry.title = event.title;
				if (event.kind === WebViewEventKind.UrlChanged) entry.url = event.url;
				this.options.emitEvent(entry.appId, event);
			},
			resolveTabContext: (webContentsId) => {
				const ownerTabId = this.byWebContents.get(webContentsId);
				if (ownerTabId === undefined) return null;
				const owner = this.tabs.get(ownerTabId);
				if (!owner) return null;
				return { tabId: owner.tabId, firstPartyUrl: owner.url };
			},
			emitForApp: (event) => this.options.emitEvent(entry.appId, event),
		});
		this.byWebContents.set(entry.view.webContentsId, entry.tabId);
		if (entry.bounds) entry.view.setBounds(entry.bounds);
		return entry.view;
	}

	/** Destroy a tab's view and drop its webContents index entry (suspend or
	 *  close). The URL stays on the entry for a later remount. */
	private teardownView(entry: TabEntry): void {
		if (entry.view === null) return;
		this.byWebContents.delete(entry.view.webContentsId);
		entry.view.destroy();
		entry.view = null;
	}

	/** OQ-WV-2: keep at most `maxLiveViews` live; suspend the LRU non-pinned
	 *  tab(s) past the cap. Suspend = destroy the view, retain the URL. */
	private enforceSuspensionCap(): void {
		let over = this.liveCount() - this.maxLiveViews;
		if (over <= 0) return;
		// The cap is service-global but each window's most-recently-active live
		// tab is the one on screen there — suspending it blanks a visible window
		// with no signal to its chrome. Exempt one tab per window (so the cap
		// degrades to "at most one live view per window" when windows abound).
		const onScreen = new Map<string, TabEntry>();
		for (const t of this.tabs.values()) {
			if (t.view === null) continue;
			const best = onScreen.get(t.window.windowId);
			if (!best || t.lastActiveAt > best.lastActiveAt) onScreen.set(t.window.windowId, t);
		}
		const candidates = [...this.tabs.values()]
			.filter((t) => t.view !== null && !t.pinned && onScreen.get(t.window.windowId) !== t)
			.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
		for (const entry of candidates) {
			if (over <= 0) break;
			entry.view?.setVisible(false);
			this.teardownView(entry);
			over -= 1;
		}
	}

	/** Pin/unpin a tab (pinned tabs are exempt from suspension). */
	setPinned(tabId: string, pinned: boolean): void {
		const entry = this.tabs.get(tabId);
		if (entry) entry.pinned = pinned;
	}

	/** Tear down every view (vault close / app teardown). */
	dispose(): void {
		for (const entry of this.tabs.values()) entry.view?.destroy();
		this.tabs.clear();
		this.byWebContents.clear();
	}
}

/** Broker service handler: unwraps the envelope and routes to {@link
 *  WebViewService}. The arg is a single {@link WebViewRequest}. */
export function makeWebViewServiceHandler(
	options: WebViewServiceOptions,
): (envelope: Envelope) => Promise<unknown> | unknown {
	const service = new WebViewService(options);
	return (envelope: Envelope) => {
		const req = envelope.args[0] as WebViewRequest | undefined;
		if (!req || typeof req !== "object" || !("method" in req)) {
			throw new Error("webView: malformed request");
		}
		return service.handle(envelope.app, req, envelope.caps ?? []);
	};
}
