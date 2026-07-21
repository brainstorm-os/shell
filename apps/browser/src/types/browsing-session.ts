/**
 * `brainstorm/BrowsingSession/v1` — the tab set + per-tab history of one
 * browser window (§Entity types).
 *
 * **Ephemeral and vault-local by default.** A closed tab leaves no trace
 * unless the user pins it or opts into history retention (`retainHistory`).
 * This type exists so a crashed window restores its tabs and "reopen closed
 * tab" works — *not* as a surveillance log. Never synced cross-device in v1.
 *
 * Two shapes share the model:
 *   - {@link BrowserTab} / {@link BrowsingSession} — the **live** chrome state.
 *     Carries runtime-only metadata (load/security/tracker counts) the chrome
 *     paints from `WebView` host events.
 *   - {@link TabSnapshot} / {@link BrowsingSessionRecord} — the **persisted**
 *     slice written to the entities store. Runtime metadata is dropped; a
 *     restore re-navigates each tab, so load/security state is recomputed.
 *
 * The captured-page artifact is the shared `brainstorm/Bookmark/v1`
 * (OQ-RX-5: `WebPage/v1` retired) — clipping lives in the Bookmarks types,
 * not here. This module owns only the *session*.
 */

/** Canonical Block-Protocol type id this app owns. Single source of truth —
 *  the manifest registration, the entities-service writes, and the session
 *  reducer all read it from here. */
export const BROWSING_SESSION_ENTITY_TYPE = "brainstorm/BrowsingSession/v1";

/** The blank page a fresh tab shows before the user navigates. Stays in the
 *  `WebContentsView`'s own origin — never a Brainstorm renderer surface. */
export const NEW_TAB_URL = "about:blank";

/** Bound on the reopen-closed-tab ring. Closing the (N+1)th tab drops the
 *  oldest closed snapshot — the stack is a convenience, not a history log. */
export const MAX_RECENTLY_CLOSED = 16;

// The runtime load/security enums are the shared WebView wire contract
// (Browser-2 lifted them to `@brainstorm-os/sdk-types` so the shell host service
// speaks the same vocabulary). Imported for the local type definitions below
// and re-exported so this module stays the app's one import home for session
// types.
import { TabLoadState, TabSecurityState } from "@brainstorm-os/sdk-types";

export { TabLoadState, TabSecurityState };

/** The persisted slice of one tab — what {@link BrowsingSessionRecord} stores.
 *  No runtime metadata: a restore re-navigates `history[historyIndex]`. */
export type TabSnapshot = {
	id: string;
	/** The tab's current URL (`history[historyIndex]` when history is non-empty). */
	url: string;
	title: string;
	/** Local `brainstorm://asset/<id>` favicon, or null until the host reports
	 *  one (never a remote URL — same offline-first contract as bookmarks). */
	faviconUrl: string | null;
	pinned: boolean;
	/** URLs visited in this tab, oldest first. Back/forward move the cursor. */
	history: readonly string[];
	/** Cursor into `history`; `-1` only for a never-navigated blank tab. */
	historyIndex: number;
};

/** The live chrome state of one tab — a {@link TabSnapshot} plus the runtime
 *  metadata the chrome paints from `WebView` host events. The page DOM and
 *  bytes never reach this model; only metadata does (the chrome-only split). */
export type BrowserTab = TabSnapshot & {
	loadState: TabLoadState;
	securityState: TabSecurityState;
	/** Trackers/ads the partitioned session blocked on this tab (Browser-4) —
	 *  surfaced as a shield count in the URL bar. */
	blockedTrackerCount: number;
	/** Browser-10 — a private (incognito) tab: a throwaway per-tab partition,
	 *  never written to the persistent cookie jar, never persisted to the
	 *  session record (it is deliberately absent from {@link TabSnapshot}, so a
	 *  private tab cannot be snapshotted by construction). */
	private: boolean;
};

/** The persisted entity (`brainstorm/BrowsingSession/v1`). */
export type BrowsingSessionRecord = {
	/** The shell window id this session restores into. */
	windowId: string;
	tabs: readonly TabSnapshot[];
	activeTabId: string | null;
	/** Reopen-closed-tab ring, most-recently-closed last. Bounded by
	 *  {@link MAX_RECENTLY_CLOSED}. */
	recentlyClosed: readonly TabSnapshot[];
	/** Opt-in (Settings → Privacy). When false (default), the session is a
	 *  pure restore aid and is cleared on a clean window close. */
	retainHistory: boolean;
	createdAt: number;
	updatedAt: number;
};

/** The live, in-memory session the chrome drives. Same shape as the persisted
 *  record but with live {@link BrowserTab}s. */
export type BrowsingSession = Omit<BrowsingSessionRecord, "tabs"> & {
	tabs: readonly BrowserTab[];
};
