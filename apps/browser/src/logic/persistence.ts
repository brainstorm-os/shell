/**
 * `BrowsingSession/v1` persistence codec — the pure half of tab restore.
 *
 * The chrome debounce-writes its live session (projected through the
 * reducer's `toRecord`) into ONE `brainstorm/BrowsingSession/v1` entity per
 * window, and re-hydrates it on launch. This module owns the property-bag
 * codec both directions plus the restore-time id remap: persisted tab ids
 * collide with the fresh chrome's `tab-N` counter, so every restored tab
 * (and reopen-ring snapshot) gets a newly minted id before it touches the
 * reducer or the `WebView` host.
 *
 * Fail-soft on read: a malformed record (schema drift, partial write)
 * decodes to `null` and the chrome starts a fresh session — never a crash,
 * never a half-restored ghost.
 */

import { sanitizeInlineText } from "@brainstorm-os/sdk/sanitize-text";
import type { BrowsingSessionRecord, TabSnapshot } from "../types/browsing-session";
import { MAX_RECENTLY_CLOSED } from "../types/browsing-session";
import { isWebUrl } from "./external-open";

/** Per-tab history bound in the persisted record — a long-lived tab's
 *  back-stack is capped to its most recent entries (the cursor adjusts). */
export const PERSIST_HISTORY_MAX = 50;

/** Persisted-title bound (same posture as the clip codec). */
const TITLE_MAX_LEN = 300;

/** Debounce for the chrome's session writes. */
export const PERSIST_DEBOUNCE_MS = 800;

function capHistory(tab: TabSnapshot): TabSnapshot {
	if (tab.history.length <= PERSIST_HISTORY_MAX) return tab;
	const drop = tab.history.length - PERSIST_HISTORY_MAX;
	return {
		...tab,
		history: tab.history.slice(drop),
		historyIndex: Math.max(0, tab.historyIndex - drop),
	};
}

function persistableTab(tab: TabSnapshot): TabSnapshot {
	return capHistory({ ...tab, title: sanitizeInlineText(tab.title, TITLE_MAX_LEN) });
}

/** Project a session record onto the entity property bag (the manifest's
 *  inline schema shape — field-for-field, arrays cloned). */
export function sessionRecordToProperties(record: BrowsingSessionRecord): Record<string, unknown> {
	return {
		windowId: record.windowId,
		tabs: record.tabs.map((tab) => persistableTab(tab)),
		activeTabId: record.activeTabId,
		recentlyClosed: record.recentlyClosed.slice(-MAX_RECENTLY_CLOSED).map((t) => persistableTab(t)),
		retainHistory: record.retainHistory,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

function parseTab(input: unknown): TabSnapshot | null {
	if (!input || typeof input !== "object") return null;
	const raw = input as Record<string, unknown>;
	if (typeof raw.id !== "string" || raw.id.length === 0) return null;
	if (typeof raw.url !== "string") return null;
	if (typeof raw.title !== "string") return null;
	if (typeof raw.pinned !== "boolean") return null;
	if (!Array.isArray(raw.history) || !raw.history.every((h) => typeof h === "string")) return null;
	if (typeof raw.historyIndex !== "number" || !Number.isInteger(raw.historyIndex)) return null;
	// -1 is legal only for a never-navigated blank tab; otherwise the cursor
	// must land inside the history array.
	const validIndex =
		(raw.history.length === 0 && raw.historyIndex === -1) ||
		(raw.historyIndex >= 0 && raw.historyIndex < raw.history.length);
	if (!validIndex) return null;
	const faviconUrl = raw.faviconUrl;
	// A restored / CRDT-synced session entity is untrusted input, so apply the
	// same http(s) front door `parseVisit` and `external-open` already enforce on
	// every other URL path: drop any non-web history entry (file:/javascript:/
	// data:) and rewrite a non-web tab url before either can reach webView.open.
	const rawHistory = raw.history as string[];
	const currentEntry = raw.historyIndex >= 0 ? rawHistory[raw.historyIndex] : undefined;
	const history = rawHistory.filter(isWebUrl);
	const historyIndex =
		history.length === 0
			? -1
			: currentEntry !== undefined && isWebUrl(currentEntry)
				? Math.max(history.indexOf(currentEntry), 0)
				: history.length - 1;
	const url = isWebUrl(raw.url) ? raw.url : (history[historyIndex] ?? "");
	return {
		id: raw.id,
		url,
		title: raw.title,
		faviconUrl: typeof faviconUrl === "string" ? faviconUrl : null,
		pinned: raw.pinned,
		history,
		historyIndex,
	};
}

/** Decode an entity property bag back into a session record, or `null` when
 *  the shape is unusable (malformed, or zero restorable tabs). */
export function sessionRecordFromProperties(
	properties: Record<string, unknown> | null | undefined,
): BrowsingSessionRecord | null {
	if (!properties || typeof properties !== "object") return null;
	if (typeof properties.windowId !== "string") return null;
	if (typeof properties.retainHistory !== "boolean") return null;
	if (typeof properties.createdAt !== "number" || typeof properties.updatedAt !== "number") {
		return null;
	}
	if (!Array.isArray(properties.tabs)) return null;
	const tabs: TabSnapshot[] = [];
	for (const raw of properties.tabs) {
		const tab = parseTab(raw);
		if (tab) tabs.push(tab);
	}
	if (tabs.length === 0) return null;
	const recentlyClosed: TabSnapshot[] = [];
	if (Array.isArray(properties.recentlyClosed)) {
		for (const raw of properties.recentlyClosed.slice(-MAX_RECENTLY_CLOSED)) {
			const tab = parseTab(raw);
			if (tab) recentlyClosed.push(tab);
		}
	}
	const activeTabId =
		typeof properties.activeTabId === "string" &&
		tabs.some((tab) => tab.id === properties.activeTabId)
			? properties.activeTabId
			: (tabs[0]?.id ?? null);
	return {
		windowId: properties.windowId,
		tabs,
		activeTabId,
		recentlyClosed,
		retainHistory: properties.retainHistory,
		createdAt: properties.createdAt,
		updatedAt: properties.updatedAt,
	};
}

/** Re-mint every tab id in `record` via `makeId` so restored ids can never
 *  collide with the live chrome's counter (or a second restore of the same
 *  record). Active-tab marker follows its tab. */
export function assignFreshIds(
	record: BrowsingSessionRecord,
	makeId: () => string,
): BrowsingSessionRecord {
	let activeTabId = record.activeTabId;
	const tabs = record.tabs.map((tab) => {
		const id = makeId();
		if (tab.id === record.activeTabId) activeTabId = id;
		return { ...tab, id };
	});
	const recentlyClosed = record.recentlyClosed.map((tab) => ({ ...tab, id: makeId() }));
	return { ...record, tabs, recentlyClosed, activeTabId };
}

/** The URL a restored tab re-navigates to. */
export function restoreUrlFor(tab: TabSnapshot): string {
	return tab.history[tab.historyIndex] ?? tab.url;
}
