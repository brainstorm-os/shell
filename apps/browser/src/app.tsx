/**
 * Web Browser — **chrome only** (§The core tension). This renderer
 * draws tabs, the address bar, and navigation controls; the page itself lives
 * in a shell-managed, partitioned `WebContentsView` the chrome drives through
 * `services.webView` and observes via metadata events. The page DOM and bytes
 * never enter this renderer.
 *
 * Tab state is the pure `logic/session.ts` reducer; `BrowsingSession/v1`
 * persists the tab set across relaunch and `BrowsingHistory/v1`
 * (`logic/history.ts`) remembers visited pages — omnibox suggestions + the
 * History menu. The web region is a placeholder div the shell's
 * `WebContentsView` floats over — the chrome reports that div's rect via
 * `setBounds`, the shell positions the view under it.
 */

import {
	type TabCommand,
	TabCommandKind,
	type WebViewClient,
	type WebViewEvent,
	WebViewEventKind,
} from "@brainstorm/sdk-types";
import { Icon, IconDirection, IconName, IconWeight } from "@brainstorm/sdk/icon";
import {
	MenuAlign,
	closeTypeaheadMenu,
	mountMenuHost,
	openTypeaheadMenu,
} from "@brainstorm/sdk/menus";
import { type AnchoredMenuItem, openAnchoredMenu } from "@brainstorm/sdk/object-menu";
import { attachShortcut, useShortcut } from "@brainstorm/sdk/shortcut";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { FindBar, type FindMatchState } from "./find-bar";
import { plural, t } from "./i18n";
import {
	BOOKMARK_ENTITY_TYPE,
	CLIP_SAVED_RESET_MS,
	type ClipAttempt,
	type ClipCapture,
	ClipPhase,
	canClip,
	clipBookmarkProperties,
	clipPhaseFor,
} from "./logic/clip";
import { externalUrlFromIntent, externalUrlFromLaunch } from "./logic/external-open";
import {
	BROWSING_HISTORY_ENTITY_TYPE,
	type HistoryVisit,
	historyRecordFromProperties,
	historyRecordToProperties,
	matchHistory,
	mergeVisits,
	recentVisits,
	recordVisit,
	retitleVisit,
	visitLabel,
} from "./logic/history";
import {
	PERSIST_DEBOUNCE_MS,
	assignFreshIds,
	restoreUrlFor,
	sessionRecordFromProperties,
	sessionRecordToProperties,
} from "./logic/persistence";
import { recentlyClosedEntries } from "./logic/recently-closed";
import {
	activateTab,
	activeTab as activeTabOf,
	applyTabMeta,
	canGoBack,
	canGoForward,
	closeTab,
	createSession,
	fromRecord,
	goBack,
	goForward,
	navigateTab,
	openTab,
	reopenClosedTab,
	reopenClosedTabAt,
	toRecord,
} from "./logic/session";
import { type PendingPermission, PermissionBanner } from "./permission-banner";
import {
	type EntitiesClient,
	type NetworkReadableService,
	getEntities,
	getLaunch,
	getNetwork,
	getWebView,
	onIntent,
} from "./runtime";
import {
	BROWSING_SESSION_ENTITY_TYPE,
	type BrowserTab,
	type BrowsingSession,
	NEW_TAB_URL,
	TabLoadState,
	TabSecurityState,
} from "./types/browsing-session";

/** Turn an omnibox entry into a navigable URL: a bare host or `scheme://`
 *  passes through (https-prefixed if scheme-less); anything word-like becomes a
 *  web search. */
function normalizeOmnibox(input: string): string {
	const text = input.trim();
	if (text.length === 0) return NEW_TAB_URL;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
	const looksLikeHost = /^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(text) && !text.includes(" ");
	if (looksLikeHost) return `https://${text}`;
	return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

function clipLabel(phase: ClipPhase): string {
	switch (phase) {
		case ClipPhase.Saving:
			return t("clip.saving");
		case ClipPhase.Saved:
			return t("clip.saved");
		case ClipPhase.Failed:
			return t("clip.failed");
		case ClipPhase.Idle:
			return t("clip.save");
	}
}

function securityLabel(state: TabSecurityState): string {
	switch (state) {
		case TabSecurityState.Secure:
			return t("security.secure");
		case TabSecurityState.Insecure:
			return t("security.insecure");
		case TabSecurityState.Mixed:
			return t("security.mixed");
		case TabSecurityState.Local:
			return t("security.local");
	}
}

/** The connection badge's glyph. A blank/new-tab (`Local`) page has no remote
 *  origin, so there's nothing to indicate — the badge is dropped entirely
 *  rather than rendered as a meaningless dot. */
function securityIconFor(state: TabSecurityState): IconName | null {
	switch (state) {
		case TabSecurityState.Secure:
			return IconName.Lock;
		case TabSecurityState.Insecure:
		case TabSecurityState.Mixed:
			return IconName.Warning;
		case TabSecurityState.Local:
			return null;
	}
}

export function BrowserApp(): ReactElement {
	const webView = useRef<WebViewClient | null>(getWebView()).current;
	const entities = useRef<EntitiesClient | null>(getEntities()).current;
	const network = useRef<NetworkReadableService | null>(getNetwork()).current;
	const idSeq = useRef(0);
	const nextId = useCallback(() => {
		idSeq.current += 1;
		return `tab-${idSeq.current}`;
	}, []);
	const clock = useRef(0);
	const now = useCallback(() => {
		clock.current += 1;
		return clock.current;
	}, []);

	const [session, setSession] = useState<BrowsingSession>(() => {
		idSeq.current += 1;
		clock.current += 1;
		// A deep-link launch (a link clicked in another app — Browser is the
		// http/https opener) seeds the first tab; otherwise it's a blank tab.
		const launchUrl = externalUrlFromLaunch(getLaunch());
		return createSession({
			windowId: "main",
			tabId: `tab-${idSeq.current}`,
			now: clock.current,
			...(launchUrl ? { url: launchUrl } : {}),
		});
	});
	const active = activeTabOf(session);
	const [omnibox, setOmnibox] = useState("");
	const regionRef = useRef<HTMLDivElement | null>(null);
	const omniboxRef = useRef<HTMLInputElement | null>(null);

	// The seed tab the state initializer minted — the restore effect only
	// replaces the session while it is still this untouched single tab.
	const initialTabRef = useRef<{ id: string; url: string } | null>(null);
	if (initialTabRef.current === null) {
		const seed = session.tabs[0];
		initialTabRef.current = seed ? { id: seed.id, url: seed.url } : { id: "", url: NEW_TAB_URL };
	}
	// Tabs whose `WebContentsView` exists host-side. Restored tabs stay
	// unopened until first activation (no N-view burst on relaunch).
	const openedTabs = useRef(
		new Set<string>(initialTabRef.current.id ? [initialTabRef.current.id] : []),
	);
	// Measure the web-region and push it as `tabId`'s view bounds. The host
	// DROPS SetBounds for a tab it doesn't know yet, and a view mounted without
	// bounds is 0×0 — the page loads invisibly. So every `open` is chased by a
	// bounds push for that tab (the active-tab layout effect alone can't be
	// trusted to run after the open reaches the host).
	const pushBoundsFor = useCallback(
		(tabId: string) => {
			const el = regionRef.current;
			if (!el || !webView) return;
			const r = el.getBoundingClientRect();
			void webView.setBounds(tabId, {
				x: Math.round(r.left),
				y: Math.round(r.top),
				width: Math.round(r.width),
				height: Math.round(r.height),
			});
		},
		[webView],
	);
	const openView = useCallback(
		(tabId: string, url: string, isPrivate = false) => {
			openedTabs.current.add(tabId);
			void webView?.open(tabId, url, isPrivate);
			pushBoundsFor(tabId);
		},
		[webView, pushBoundsFor],
	);

	// BrowsingSession/v1 persistence (restore across relaunch).
	const sessionEntityId = useRef<string | null>(null);
	const persistReady = useRef(false);

	// BrowsingHistory/v1 — the vault's visit log (Browser-9). Fed from the
	// shell's UrlChanged/TitleChanged events, surfaced as omnibox suggestions
	// and the History menu. The event subscription reads tab URLs through
	// `sessionRef` so it never re-subscribes per session change.
	const [visits, setVisits] = useState<readonly HistoryVisit[]>([]);
	const historyEntityId = useRef<string | null>(null);
	const historyReady = useRef(false);
	const historyCreatedAt = useRef<number | null>(null);
	const sessionRef = useRef(session);
	sessionRef.current = session;

	// Omnibox suggestion dropdown (combobox pattern) — open while the user is
	// typing, highlight driven by ArrowUp/ArrowDown, Enter navigates.
	const [suggestOpen, setSuggestOpen] = useState(false);
	const [suggestIndex, setSuggestIndex] = useState(-1);
	const suggestions = useMemo(
		() => (suggestOpen ? matchHistory(visits, omnibox) : []),
		[suggestOpen, visits, omnibox],
	);

	// Find-in-page chrome state. Match counts arrive per tab as FindResult
	// metadata events; only the active tab's count renders.
	const [findOpen, setFindOpen] = useState(false);
	const [findQuery, setFindQuery] = useState("");
	const [findResults, setFindResults] = useState<Record<string, FindMatchState>>({});

	// Per-site permission asks pushed by the shell (deny-default; the banner
	// is the explicit grant surface).
	const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);

	// Stand up the fancy-menus runtime once so the recently-closed anchored menu
	// renders through the shared menu host (theme + keyboard + glass chrome).
	useEffect(() => mountMenuHost(), []);

	// Open the initial tab's view in the shell once (mount only — deps
	// intentionally empty so a later tab/url change doesn't re-open the first tab).
	// A LAYOUT effect declared above the bounds-push one so `open` is queued
	// before the first `setBounds` — sent the other way round, the bounds call
	// finds no tab (dropped) and the view mounts 0×0: an intermittent blank
	// first page, rescued only by the ResizeObserver race.
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-once open of the seed tab
	useLayoutEffect(() => {
		if (!webView || !active) return;
		void webView.open(active.id, active.url, active.private);
	}, []);

	// Subscribe to shell metadata events → reflect into tab state. Find
	// counts + permission asks are chrome-local state, not session state.
	useEffect(() => {
		if (!webView) return;
		return webView.onEvent((event: WebViewEvent) => {
			if (event.kind === WebViewEventKind.FindResult) {
				setFindResults((prev) => ({
					...prev,
					[event.tabId]: { matches: event.matches, activeMatch: event.activeMatch },
				}));
				return;
			}
			if (event.kind === WebViewEventKind.PermissionRequested) {
				setPendingPermissions((prev) =>
					prev.some(
						(p) =>
							p.tabId === event.tabId && p.origin === event.origin && p.permission === event.permission,
					)
						? prev
						: [...prev, { tabId: event.tabId, origin: event.origin, permission: event.permission }],
				);
				return;
			}
			if (event.kind === WebViewEventKind.Closed) {
				openedTabs.current.delete(event.tabId);
				setFindResults(({ [event.tabId]: _dropped, ...rest }) => rest);
				setPendingPermissions((prev) => prev.filter((p) => p.tabId !== event.tabId));
			}
			// History feeds off the same metadata stream: a committed navigation
			// records the visit; the page's title backfills the recorded row.
			if (event.kind === WebViewEventKind.UrlChanged) {
				setVisits((v) => recordVisit(v, { url: event.url, now: Date.now() }));
			}
			if (event.kind === WebViewEventKind.TitleChanged) {
				const tab = sessionRef.current.tabs.find((candidate) => candidate.id === event.tabId);
				if (tab) setVisits((v) => retitleVisit(v, tab.url, event.title));
			}
			setSession((s) => reduceEvent(s, event, now));
		});
	}, [webView, now]);

	// Restore the persisted BrowsingSession/v1 (if any) once on mount. The
	// restore only applies while the session is still the untouched seed tab
	// — anything the user did in the meantime wins. A deep-link seed tab is
	// kept (foreground) alongside the restored tabs.
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-once restore
	useEffect(() => {
		let cancelled = false;
		const run = async () => {
			const query = entities?.query;
			if (!entities || !query) return;
			const rows = await query.call(entities, { type: BROWSING_SESSION_ENTITY_TYPE });
			if (cancelled) return;
			const seed = initialTabRef.current as { id: string; url: string };
			const mine = rows
				.filter((row) => row.properties?.windowId === session.windowId)
				.sort((a, b) => b.updatedAt - a.updatedAt)[0];
			if (!mine) return;
			sessionEntityId.current = mine.id;
			const record = sessionRecordFromProperties(mine.properties);
			if (!record) return;
			const fresh = assignFreshIds(record, nextId);
			// Decide "is the session still the untouched seed?" from the last
			// RENDERED session — never from a flag mutated inside the updater.
			// React defers updaters whenever other updates are already queued
			// (the seed's about:blank load events always are in the real shell),
			// so a flag read back synchronously after setSession is stale
			// `false`: the seed view then never closed, the restored active tab
			// never mounted, and its later navigate landed in a 0×0 view — the
			// "restored browser never shows a page" bug. Meta events between
			// renders only touch loadState/title, never the id+url this checks.
			const current = sessionRef.current;
			const rendered = current.tabs.length === 1 ? current.tabs[0] : undefined;
			if (!rendered || rendered.id !== seed.id || rendered.url !== seed.url) return;
			setSession((s) => {
				const only = s.tabs.length === 1 ? s.tabs[0] : undefined;
				if (!only || only.id !== seed.id || only.url !== seed.url) return s;
				const live = fromRecord(fresh);
				if (seed.url !== NEW_TAB_URL) {
					// Deep-link launch: restored tabs come back, the link stays
					// the foreground tab.
					return { ...live, tabs: [...live.tabs, only], activeTabId: only.id };
				}
				return live;
			});
			if (seed.url === NEW_TAB_URL) {
				// The blank seed view is replaced by the restored active tab.
				openedTabs.current.delete(seed.id);
				void webView?.close(seed.id);
				const activeRestored = fresh.tabs.find((tab) => tab.id === fresh.activeTabId);
				if (activeRestored) openView(activeRestored.id, restoreUrlFor(activeRestored));
			}
		};
		run()
			.catch(() => {
				// A failed read restores nothing — fresh session stands.
			})
			.finally(() => {
				if (!cancelled) persistReady.current = true;
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Persist the session (debounced) so tabs survive a relaunch. Gated on
	// the restore attempt so a fresh seed never clobbers the stored record
	// before it has been read.
	useEffect(() => {
		if (!entities) return;
		const handle = window.setTimeout(() => {
			if (!persistReady.current) return;
			const properties = sessionRecordToProperties(toRecord(session));
			const save = async () => {
				if (sessionEntityId.current && entities.update) {
					await entities.update(sessionEntityId.current, properties);
				} else {
					const created = await entities.create(BROWSING_SESSION_ENTITY_TYPE, properties);
					sessionEntityId.current = created.id;
				}
			};
			save().catch(() => {
				// Best-effort: a failed save retries on the next session change.
			});
		}, PERSIST_DEBOUNCE_MS);
		return () => window.clearTimeout(handle);
	}, [session, entities]);

	// Load the stored BrowsingHistory/v1 once on mount. Visits recorded while
	// the read was in flight win (mergeVisits keeps them newest).
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-once load
	useEffect(() => {
		let cancelled = false;
		const run = async () => {
			const query = entities?.query;
			if (!entities || !query) return;
			const rows = await query.call(entities, { type: BROWSING_HISTORY_ENTITY_TYPE });
			if (cancelled) return;
			const stored = [...rows].sort((a, b) => b.updatedAt - a.updatedAt)[0];
			if (!stored) return;
			historyEntityId.current = stored.id;
			const record = historyRecordFromProperties(stored.properties);
			if (!record) return;
			historyCreatedAt.current = record.createdAt;
			setVisits((live) => mergeVisits(live, record.visits));
		};
		run()
			.catch(() => {
				// A failed read loads nothing — recording starts fresh.
			})
			.finally(() => {
				if (!cancelled) historyReady.current = true;
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Persist the visit log (debounced, one entity per vault). Gated on the
	// load attempt so a fresh boot never clobbers the stored record.
	useEffect(() => {
		if (!entities) return;
		const handle = window.setTimeout(() => {
			if (!historyReady.current) return;
			// Nothing recorded and nothing stored — don't mint an empty entity.
			if (visits.length === 0 && historyEntityId.current === null) return;
			const stamp = Date.now();
			if (historyCreatedAt.current === null) historyCreatedAt.current = stamp;
			const properties = historyRecordToProperties({
				visits,
				createdAt: historyCreatedAt.current,
				updatedAt: stamp,
			});
			const save = async () => {
				if (historyEntityId.current && entities.update) {
					await entities.update(historyEntityId.current, properties);
				} else {
					const created = await entities.create(BROWSING_HISTORY_ENTITY_TYPE, properties);
					historyEntityId.current = created.id;
				}
			};
			save().catch(() => {
				// Best-effort: a failed save retries on the next visit.
			});
		}, PERSIST_DEBOUNCE_MS);
		return () => window.clearTimeout(handle);
	}, [visits, entities]);

	// A link clicked elsewhere while this window is already open arrives as
	// a pushed `open` intent (the shell focuses the window instead of
	// re-launching) — each becomes a fresh foreground tab.
	useEffect(() => {
		return (
			onIntent((intent) => {
				const url = externalUrlFromIntent(intent);
				if (!url) return;
				const tabId = nextId();
				setSession((s) => openTab(s, { tabId, url, now: now(), activate: true }));
				openView(tabId, url);
			}) ?? undefined
		);
	}, [nextId, now, openView]);

	// Keep the omnibox in sync with the active tab's URL (unless it's blank).
	// Keyed on id+url only — re-syncing on every meta event (title/load) would
	// fight the user's typing.
	// biome-ignore lint/correctness/useExhaustiveDependencies: narrow id+url sync is intentional
	useEffect(() => {
		setOmnibox(active && active.url !== NEW_TAB_URL ? active.url : "");
		closeSuggestions();
	}, [active?.id, active?.url]);

	// Report the web-region rect to the shell so it positions the WebContentsView
	// under the chrome. Re-measure on resize + active-tab change (keyed on id, not
	// the whole tab, so meta events don't re-run the measurement).
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on tab switch, not every meta change
	useLayoutEffect(() => {
		if (!webView || !active) return;
		const el = regionRef.current;
		if (!el) return;
		const push = () => pushBoundsFor(active.id);
		push();
		const ro = new ResizeObserver(push);
		ro.observe(el);
		window.addEventListener("resize", push);
		return () => {
			ro.disconnect();
			window.removeEventListener("resize", push);
		};
	}, [webView, active?.id, pushBoundsFor]);

	const closeSuggestions = useCallback(() => {
		setSuggestOpen(false);
		setSuggestIndex(-1);
	}, []);

	const navigateTo = useCallback(
		(url: string) => {
			if (!active) return;
			setSession((s) => navigateTab(s, { tabId: active.id, url, now: now() }));
			void webView?.navigate(active.id, url);
			setOmnibox(url);
			closeSuggestions();
		},
		[active, webView, now, closeSuggestions],
	);

	const submitOmnibox = useCallback(
		(event: React.FormEvent) => {
			event.preventDefault();
			const highlighted = suggestIndex >= 0 ? suggestions[suggestIndex] : undefined;
			navigateTo(highlighted ? highlighted.url : normalizeOmnibox(omnibox));
		},
		[suggestions, suggestIndex, omnibox, navigateTo],
	);

	// Suggestion-list keyboard model: ArrowDown/ArrowUp move the highlight
	// (wrapping through "nothing highlighted"), Escape dismisses the list.
	// Bound through the SDK binder on the input itself with the while-editable
	// opt-in; no preventDefault while the list is closed so the caret keeps its
	// native Home/End moves.
	const suggestionsRef = useRef(suggestions);
	suggestionsRef.current = suggestions;
	useEffect(() => {
		const el = omniboxRef.current;
		if (!el) return;
		const step = (delta: number) => (event: KeyboardEvent) => {
			const count = suggestionsRef.current.length;
			if (count === 0) return;
			event.preventDefault();
			setSuggestIndex((i) => {
				const span = count + 1;
				return ((i + 1 + delta + span) % span) - 1;
			});
		};
		const offDown = attachShortcut(el, "ArrowDown", step(1), {
			allowWhileSuppressed: true,
			preventDefault: false,
		});
		const offUp = attachShortcut(el, "ArrowUp", step(-1), {
			allowWhileSuppressed: true,
			preventDefault: false,
		});
		const offEscape = attachShortcut(
			el,
			"Escape",
			(event) => {
				if (suggestionsRef.current.length === 0) return;
				event.preventDefault();
				setSuggestOpen(false);
				setSuggestIndex(-1);
			},
			{ allowWhileSuppressed: true, preventDefault: false },
		);
		return () => {
			offDown();
			offUp();
			offEscape();
		};
	}, []);

	// Render the suggestion list through the shared typeahead runtime (the
	// omnibox is the external owner: it keeps focus + the keyboard above, the
	// menu is a display-only controlled list anchored under the address bar and
	// painted at `suggestIndex`). Mirrors the editor caret typeaheads.
	useEffect(() => {
		if (suggestions.length === 0) {
			closeTypeaheadMenu();
			return;
		}
		openTypeaheadMenu({
			items: suggestions.map((visit) => ({
				id: visit.url,
				label: visitLabel(visit),
				description: visit.url,
			})),
			...(omniboxRef.current ? { anchor: omniboxRef.current } : {}),
			activeIndex: suggestIndex,
			ariaLabel: t("url.suggestions"),
			onSelect: (url) => navigateTo(url),
		});
	}, [suggestions, suggestIndex, navigateTo]);

	useEffect(() => () => closeTypeaheadMenu(), []);

	const onNewTab = useCallback(() => {
		const tabId = nextId();
		setSession((s) => openTab(s, { tabId, now: now(), activate: true }));
		openView(tabId, NEW_TAB_URL);
	}, [nextId, openView, now]);

	// Browser-10 — a private (incognito) tab: throwaway per-tab partition, never
	// persisted, never written to the cookie jar.
	const onNewPrivateTab = useCallback(() => {
		const tabId = nextId();
		setSession((s) => openTab(s, { tabId, now: now(), activate: true, private: true }));
		openView(tabId, NEW_TAB_URL, true);
	}, [nextId, openView, now]);

	// Browser-10 — wipe the persistent cookie jar (encrypted store + live
	// session). Does not touch private tabs (they never persisted anything).
	const onClearBrowsingData = useCallback(() => {
		void webView?.clearBrowsingData();
		setDataCleared(true);
		if (dataClearedTimer.current !== null) window.clearTimeout(dataClearedTimer.current);
		dataClearedTimer.current = window.setTimeout(() => setDataCleared(false), 4000);
	}, [webView]);

	const onActivate = useCallback(
		(tabId: string) => {
			setSession((s) => activateTab(s, { tabId, now: now() }));
			// A restored tab has no host-side view until first activation —
			// mount it now by re-navigating its history tip.
			if (!openedTabs.current.has(tabId)) {
				const tab = session.tabs.find((candidate) => candidate.id === tabId);
				if (tab) {
					openView(tabId, tab.history[tab.historyIndex] ?? tab.url);
					return;
				}
			}
			void webView?.activate(tabId);
		},
		[webView, now, openView, session.tabs],
	);

	const onClose = useCallback(
		(tabId: string) => {
			openedTabs.current.delete(tabId);
			void webView?.close(tabId);
			setSession((s) => {
				const next = closeTab(s, { tabId, now: now() });
				// Closing the last tab opens a fresh blank one (never an empty window).
				if (next.tabs.length === 0) {
					const fresh = nextId();
					openView(fresh, NEW_TAB_URL);
					return openTab(next, { tabId: fresh, now: now(), activate: true });
				}
				return next;
			});
		},
		[webView, now, nextId, openView],
	);

	const onBack = useCallback(() => {
		if (!active) return;
		setSession((s) => goBack(s, { tabId: active.id, now: now() }));
		void webView?.back(active.id);
	}, [active, webView, now]);

	const onForward = useCallback(() => {
		if (!active) return;
		setSession((s) => goForward(s, { tabId: active.id, now: now() }));
		void webView?.forward(active.id);
	}, [active, webView, now]);

	const onReload = useCallback(() => {
		if (active) void webView?.reload(active.id);
	}, [active, webView]);

	// Reopen a closed tab: drive the reducer, then mount the restored tab's view
	// in the shell. The reducer reuses the snapshot's id (history intact), so the
	// `open` call carries that same id — the shell re-navigates `history`'s tip.
	const reopen = useCallback(
		(restore: (s: BrowsingSession) => BrowsingSession, restoredId: string, url: string) => {
			setSession((s) => {
				const next = restore(s);
				if (next === s) return s;
				return next;
			});
			openView(restoredId, url);
		},
		[openView],
	);

	const onReopenLast = useCallback(() => {
		const entry = recentlyClosedEntries(session, t("tab.untitled"))[0];
		if (!entry) return;
		const id = session.recentlyClosed[entry.index]?.id;
		if (!id) return;
		reopen((s) => reopenClosedTab(s, { now: now() }), id, entry.url);
	}, [session, reopen, now]);

	const clearHistory = useCallback(() => {
		setVisits([]);
	}, []);

	// The History menu — recently-closed tabs (reopen) + recently-visited
	// pages (navigate) + clear, all through the shared fancy-menus runtime.
	const recentButtonRef = useRef<HTMLButtonElement | null>(null);
	const onOpenHistoryMenu = useCallback(() => {
		const anchor = recentButtonRef.current;
		if (!anchor) return;
		const closedEntries = recentlyClosedEntries(session, t("tab.untitled"));
		const recent = recentVisits(visits);
		const items: AnchoredMenuItem[] = [];
		if (closedEntries.length > 0) {
			items.push({ label: t("recent.menu"), section: true });
			for (const entry of closedEntries) {
				items.push({
					label: entry.label,
					icon: IconName.Update,
					onSelect: () => {
						const id = session.recentlyClosed[entry.index]?.id;
						if (!id) return;
						reopen((s) => reopenClosedTabAt(s, { index: entry.index, now: now() }), id, entry.url);
					},
				});
			}
		}
		if (recent.length > 0) {
			items.push({ label: t("history.section"), section: true });
			for (const visit of recent) {
				items.push({
					label: visitLabel(visit),
					icon: IconName.History,
					onSelect: () => navigateTo(visit.url),
				});
			}
			// Fence the destructive Clear off from the navigable history rows so
			// it can't be fat-fingered (mirrors the object-menu Remove fence).
			items.push({ divider: true });
			items.push({
				label: t("history.clear"),
				icon: IconName.Trash,
				destructive: true,
				onSelect: clearHistory,
			});
		}
		if (items.length === 0) items.push({ label: t("history.empty"), disabled: true });
		const rect = anchor.getBoundingClientRect();
		openAnchoredMenu({ x: rect.left, y: rect.bottom }, items, {
			menuLabel: t("history.menu"),
			anchor,
		});
	}, [session, visits, reopen, now, navigateTo, clearHistory]);

	// Browser overflow ⋯ menu — the trailing element in the toolbar (catch-all
	// for actions without a dedicated control): new private tab + clear data.
	const menuButtonRef = useRef<HTMLButtonElement | null>(null);
	const onOpenBrowserMenu = useCallback(() => {
		const anchor = menuButtonRef.current;
		if (!anchor) return;
		const items: AnchoredMenuItem[] = [
			{
				label: t("tab.newPrivate"),
				icon: IconName.Lock,
				onSelect: onNewPrivateTab,
			},
			{ label: t("menu.label"), section: true },
			{
				label: t("data.clear"),
				icon: IconName.Trash,
				destructive: true,
				onSelect: onClearBrowsingData,
			},
		];
		const rect = anchor.getBoundingClientRect();
		openAnchoredMenu({ x: rect.right, y: rect.bottom }, items, {
			menuLabel: t("menu.label"),
			anchor,
			align: MenuAlign.End,
		});
	}, [onNewPrivateTab, onClearBrowsingData]);

	const [clipAttempt, setClipAttempt] = useState<ClipAttempt | null>(null);
	const clipResetTimer = useRef<number | null>(null);
	const [dataCleared, setDataCleared] = useState(false);
	const dataClearedTimer = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (dataClearedTimer.current !== null) window.clearTimeout(dataClearedTimer.current);
		},
		[],
	);
	useEffect(
		() => () => {
			if (clipResetTimer.current !== null) window.clearTimeout(clipResetTimer.current);
		},
		[],
	);

	const onClip = useCallback(async () => {
		if (!active || !entities) return;
		const tabId = active.id;
		const url = active.url;
		const title = active.title;
		if (clipResetTimer.current !== null) {
			window.clearTimeout(clipResetTimer.current);
			clipResetTimer.current = null;
		}
		setClipAttempt({ tabId, phase: ClipPhase.Saving });
		// Capture the page's readable body so the saved bookmark renders content
		// instead of a blank body (F-235). Best-effort: a withheld grant, a
		// blocked egress, or a non-extractable page (SPA / paywall) leaves a
		// link-only bookmark — never a failed clip.
		let capture: ClipCapture | undefined;
		if (network) {
			try {
				capture = await network.readable({ url });
			} catch {
				capture = undefined;
			}
		}
		const properties = clipBookmarkProperties({ url, title }, Date.now(), capture);
		if (!properties) {
			setClipAttempt({ tabId, phase: ClipPhase.Failed });
			return;
		}
		try {
			await entities.create(BOOKMARK_ENTITY_TYPE, properties);
			setClipAttempt({ tabId, phase: ClipPhase.Saved });
			clipResetTimer.current = window.setTimeout(() => {
				clipResetTimer.current = null;
				setClipAttempt(null);
			}, CLIP_SAVED_RESET_MS);
		} catch {
			setClipAttempt({ tabId, phase: ClipPhase.Failed });
		}
	}, [active, entities, network]);

	const focusOmnibox = useCallback(() => {
		const el = omniboxRef.current;
		if (!el) return;
		el.focus();
		el.select();
	}, []);

	// Find-in-page: query changes re-issue the engine search (Chromium
	// advances the active match on repeated calls with the same text).
	const onFindQueryChange = useCallback(
		(next: string) => {
			setFindQuery(next);
			if (!active) return;
			if (next.length > 0) {
				void webView?.findInPage(active.id, next, true);
			} else {
				void webView?.stopFind(active.id);
				setFindResults(({ [active.id]: _dropped, ...rest }) => rest);
			}
		},
		[active, webView],
	);

	const onFindStep = useCallback(
		(forward: boolean) => {
			if (!active || findQuery.length === 0) return;
			void webView?.findInPage(active.id, findQuery, forward);
		},
		[active, findQuery, webView],
	);

	const onFindClose = useCallback(() => {
		setFindOpen(false);
		if (active) {
			void webView?.stopFind(active.id);
			setFindResults(({ [active.id]: _dropped, ...rest }) => rest);
		}
	}, [active, webView]);

	// Tab switch while the bar is open: re-run the query on the new tab so
	// the count tracks what's on screen.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the active tab id only
	useEffect(() => {
		if (!findOpen || !active || findQuery.length === 0) return;
		void webView?.findInPage(active.id, findQuery, true);
	}, [active?.id]);

	// Per-site permission decisions. Allow persists the grant then reloads
	// the tab so the page re-requests under it; Block persists the refusal
	// (the site stops asking); Dismiss just hides this ask.
	const resolvePermission = useCallback(
		(request: PendingPermission, allow: boolean | null) => {
			setPendingPermissions((prev) =>
				prev.filter((p) => !(p.origin === request.origin && p.permission === request.permission)),
			);
			if (allow === null) return;
			void (async () => {
				await webView?.setSitePermission(request.tabId, request.origin, request.permission, allow);
				if (allow) await webView?.reload(request.tabId);
			})();
		},
		[webView],
	);

	// Cmd+L focuses the address bar — a plain renderer chord the shell doesn't
	// claim. Cmd+T / Cmd+W are owned by the shell globally and arrive as
	// `brainstorm:tab-command` (the shell routes them here for the Browser
	// because it self-manages tabs), so we don't bind them as renderer chords.
	useShortcut("CmdOrCtrl+L", focusOmnibox);

	// Cmd+F opens the find bar (the FindBar autofocuses its input).
	useShortcut("CmdOrCtrl+F", () => {
		if (active) setFindOpen(true);
	});

	// Escape closes the find bar — bound through the SDK binder with the
	// while-editable opt-in (focus sits in the find input) and without the
	// default swallow so sibling Escape handlers still see the event when
	// the bar is closed.
	const findOpenRef = useRef(findOpen);
	findOpenRef.current = findOpen;
	const onFindCloseRef = useRef(onFindClose);
	onFindCloseRef.current = onFindClose;
	useEffect(() => {
		return attachShortcut(
			window,
			"Escape",
			(event) => {
				if (!findOpenRef.current) return;
				event.preventDefault();
				onFindCloseRef.current();
			},
			{ allowWhileSuppressed: true, preventDefault: false },
		);
	}, []);

	// Cmd+Shift+T reopens the most-recently-closed tab — a plain renderer chord
	// (the shell doesn't claim it; the Browser self-manages its tab strip).
	useShortcut("CmdOrCtrl+Shift+T", onReopenLast);

	useEffect(() => {
		const onCommand = (event: Event) => {
			const command = (event as CustomEvent<TabCommand>).detail;
			if (command?.kind === TabCommandKind.NewTab) onNewTab();
			else if (command?.kind === TabCommandKind.CloseTab && active) onClose(active.id);
		};
		window.addEventListener("brainstorm:tab-command", onCommand);
		return () => window.removeEventListener("brainstorm:tab-command", onCommand);
	}, [onNewTab, onClose, active]);

	const securityState = active?.securityState ?? TabSecurityState.Local;
	const securityIcon = securityIconFor(securityState);
	const blockedTrackers = active?.blockedTrackerCount ?? 0;
	const clipPhase = clipPhaseFor(clipAttempt, active?.id ?? null);
	const clipEnabled = entities !== null && canClip(active?.url, clipPhase);
	const activeFindResult = active ? (findResults[active.id] ?? null) : null;
	const activePermissionAsk = active
		? (pendingPermissions.find((p) => p.tabId === active.id) ?? null)
		: null;

	if (!webView) {
		return (
			<div className="browser browser--unavailable">
				<h1>{t("unavailable.title")}</h1>
				<p>{t("unavailable.blurb")}</p>
			</div>
		);
	}

	return (
		<div className="browser">
			<TabStrip session={session} onActivate={onActivate} onClose={onClose} onNewTab={onNewTab} />
			<form className="browser__toolbar" onSubmit={submitOmnibox}>
				<NavButton
					label={t("nav.back")}
					icon={IconName.CaretLeft}
					direction={IconDirection.Inline}
					disabled={!active || !canGoBack(active)}
					onClick={onBack}
				/>
				<NavButton
					label={t("nav.forward")}
					icon={IconName.CaretRight}
					direction={IconDirection.Inline}
					disabled={!active || !canGoForward(active)}
					onClick={onForward}
				/>
				<NavButton
					label={active?.loadState === TabLoadState.Loading ? t("nav.stop") : t("nav.reload")}
					icon={active?.loadState === TabLoadState.Loading ? IconName.Close : IconName.Reload}
					disabled={!active}
					onClick={active?.loadState === TabLoadState.Loading ? () => webView.stop(active.id) : onReload}
				/>
				<button
					ref={recentButtonRef}
					type="button"
					className="browser__navbtn"
					aria-label={t("history.open")}
					data-bs-tooltip={t("history.open")}
					aria-haspopup="menu"
					onClick={onOpenHistoryMenu}
				>
					<Icon name={IconName.History} size={16} />
				</button>
				{securityIcon !== null && (
					<span
						className={`browser__security browser__security--${securityState}`}
						role="img"
						data-bs-tooltip={securityLabel(securityState)}
						aria-label={securityLabel(securityState)}
					>
						<Icon name={securityIcon} size={14} />
					</span>
				)}
				<div className="browser__omnibox-wrap">
					<input
						ref={omniboxRef}
						className="bs-input browser__omnibox"
						type="text"
						value={omnibox}
						onChange={(e) => {
							setOmnibox(e.target.value);
							setSuggestOpen(e.target.value.trim().length > 0);
							setSuggestIndex(-1);
						}}
						onBlur={closeSuggestions}
						placeholder={t("url.placeholder")}
						aria-label={t("url.aria")}
						// Suggestions render through the shared typeahead runtime, which
						// owns the `role="listbox"` + active-row a11y; the address field
						// stays a plain input (a `combobox` role without an id-linked
						// listbox would be a half-wired pattern).
						aria-autocomplete="list"
						spellCheck={false}
						autoCapitalize="off"
						autoCorrect="off"
					/>
				</div>
				{blockedTrackers > 0 && (
					<span
						className="browser__shield"
						aria-label={plural(blockedTrackers, "shield.blocked.one", "shield.blocked.other")}
						data-bs-tooltip={plural(blockedTrackers, "shield.blocked.one", "shield.blocked.other")}
					>
						<span aria-hidden="true">🛡</span> <span aria-hidden="true">{blockedTrackers}</span>
					</span>
				)}
				<button
					type="button"
					className={`browser__clip browser__clip--${clipPhase}`}
					aria-label={clipLabel(clipPhase)}
					data-bs-tooltip={clipLabel(clipPhase)}
					title={!clipEnabled ? clipLabel(clipPhase) : undefined}
					disabled={!clipEnabled}
					onClick={() => void onClip()}
				>
					{clipPhase === ClipPhase.Saving ? (
						<span className="browser__tab-spin" aria-hidden="true" />
					) : (
						<Icon
							name={IconName.Star}
							size={16}
							weight={clipPhase === ClipPhase.Saved ? IconWeight.Fill : IconWeight.Regular}
						/>
					)}
				</button>
				<span className="browser__clip-status" role="status">
					{clipPhase === ClipPhase.Saved || clipPhase === ClipPhase.Failed ? clipLabel(clipPhase) : ""}
				</span>
				<span className="browser__clip-status" role="status">
					{dataCleared ? t("data.cleared") : ""}
				</span>
				<button
					ref={menuButtonRef}
					type="button"
					className="browser__navbtn"
					aria-label={t("menu.open")}
					data-bs-tooltip={t("menu.open")}
					aria-haspopup="menu"
					onClick={onOpenBrowserMenu}
				>
					<Icon name={IconName.More} size={16} />
				</button>
			</form>
			{findOpen && (
				<FindBar
					query={findQuery}
					result={activeFindResult}
					onQueryChange={onFindQueryChange}
					onNext={() => onFindStep(true)}
					onPrevious={() => onFindStep(false)}
					onClose={onFindClose}
				/>
			)}
			{activePermissionAsk && (
				<PermissionBanner
					request={activePermissionAsk}
					onAllow={() => resolvePermission(activePermissionAsk, true)}
					onBlock={() => resolvePermission(activePermissionAsk, false)}
					onDismiss={() => resolvePermission(activePermissionAsk, null)}
				/>
			)}
			<div ref={regionRef} className="browser__region" />
		</div>
	);
}

/** Fold a shell metadata event into the session's tab state. */
function reduceEvent(
	session: BrowsingSession,
	event: WebViewEvent,
	now: () => number,
): BrowsingSession {
	switch (event.kind) {
		case WebViewEventKind.TitleChanged:
			return applyTabMeta(session, { tabId: event.tabId, now: now(), patch: { title: event.title } });
		case WebViewEventKind.FaviconChanged:
			return applyTabMeta(session, {
				tabId: event.tabId,
				now: now(),
				patch: { faviconUrl: event.faviconUrl },
			});
		case WebViewEventKind.UrlChanged:
			// A shell-reported URL change (redirect / in-page nav) updates the bar
			// without re-driving the engine.
			return navigateTab(session, { tabId: event.tabId, url: event.url, now: now() });
		case WebViewEventKind.LoadStateChanged:
			return applyTabMeta(session, {
				tabId: event.tabId,
				now: now(),
				patch: { loadState: event.loadState },
			});
		case WebViewEventKind.SecurityStateChanged:
			return applyTabMeta(session, {
				tabId: event.tabId,
				now: now(),
				patch: { securityState: event.securityState },
			});
		case WebViewEventKind.TrackerBlocked:
			return applyTabMeta(session, {
				tabId: event.tabId,
				now: now(),
				patch: { blockedTrackerCount: event.blockedTrackerCount },
			});
		case WebViewEventKind.Closed:
			// The shell tore the view down host-side (crash, or `open` could not
			// resolve a window so the tab never mounted). Drop the orphaned tab
			// rather than leave a phantom that never loads.
			return closeTab(session, { tabId: event.tabId, now: now() });
		default:
			return session;
	}
}

function NavButton({
	label,
	icon,
	direction,
	disabled,
	onClick,
}: {
	label: string;
	icon: IconName;
	direction?: IconDirection;
	disabled: boolean;
	onClick: () => void;
}): ReactElement {
	return (
		<button
			type="button"
			className="browser__navbtn"
			aria-label={label}
			data-bs-tooltip={label}
			title={disabled ? label : undefined}
			disabled={disabled}
			onClick={onClick}
		>
			<Icon name={icon} size={16} {...(direction ? { direction } : {})} />
		</button>
	);
}

function TabStrip({
	session,
	onActivate,
	onClose,
	onNewTab,
}: {
	session: BrowsingSession;
	onActivate: (tabId: string) => void;
	onClose: (tabId: string) => void;
	onNewTab: () => void;
}): ReactElement {
	const tabs = useMemo(() => session.tabs, [session.tabs]);
	return (
		<header className="app-header browser__tabstrip" aria-label={t("app.title")}>
			{tabs.map((tab: BrowserTab) => {
				const activeTab = tab.id === session.activeTabId;
				return (
					<div key={tab.id} className={`browser__tab${activeTab ? " browser__tab--active" : ""}`}>
						<button
							type="button"
							className="browser__tab-label"
							aria-current={activeTab ? "page" : undefined}
							aria-label={tab.title || tab.url || t("tab.untitled")}
							onClick={() => onActivate(tab.id)}
							data-bs-tooltip={tab.title || tab.url || t("tab.untitled")}
						>
							{tab.loadState === TabLoadState.Loading ? (
								<span className="browser__tab-spin" aria-hidden="true" />
							) : tab.faviconUrl ? (
								<img className="browser__tab-favicon" src={tab.faviconUrl} alt="" aria-hidden="true" />
							) : (
								<Icon className="browser__tab-favicon" name={IconName.KindUrl} size={14} />
							)}
							<span className="app-header__title browser__tab-title">
								{tab.title || t("tab.untitled")}
							</span>
						</button>
						<button
							type="button"
							className="browser__tab-close"
							aria-label={t("tab.close")}
							data-bs-tooltip={t("tab.close")}
							onClick={() => onClose(tab.id)}
						>
							<Icon name={IconName.Close} size={11} />
						</button>
					</div>
				);
			})}
			<button
				type="button"
				className="browser__newtab"
				aria-label={t("tab.newAria")}
				data-bs-tooltip={t("tab.new")}
				onClick={onNewTab}
			>
				<Icon name={IconName.Plus} size={15} />
			</button>
		</header>
	);
}
