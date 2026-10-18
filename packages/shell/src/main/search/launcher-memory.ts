/**
 * Launcher memory (9.22.7) — what the launcher shows before the user types:
 * the objects they opened most recently and the searches they saved.
 *
 * Both lists live in the vault's `settings.db` (per-device, encrypted at rest,
 * never synced) under a reserved scope no installed app can claim — an app id
 * never contains a `/`. Bounded: recents keep the newest {@link MAX_RECENTS},
 * saved searches cap at {@link MAX_SAVED_SEARCHES}, so neither list grows with
 * vault age. Parsing is defensive: a corrupt value reads as an empty list.
 */

import { randomUUID } from "node:crypto";

export const LAUNCHER_SETTINGS_SCOPE = "brainstorm.shell/launcher";
export const RECENTS_KEY = "recents";
export const SAVED_SEARCHES_KEY = "saved-searches";
export const MAX_RECENTS = 12;
export const MAX_SAVED_SEARCHES = 20;
export const MAX_SAVED_SEARCH_CHARS = 200;

export type RecentEntry = { entityId: string; openedAt: number };
export type SavedSearch = { id: string; text: string; createdAt: number };

/** The slice of `SettingsRepository` this module needs. */
export type LauncherSettingsStore = {
	get(appId: string, key: string): string | null;
	set(appId: string, key: string, value: string): void;
};

function parseArray(raw: string | null): unknown[] {
	if (raw === null) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function parseRecents(raw: string | null): RecentEntry[] {
	const out: RecentEntry[] = [];
	for (const item of parseArray(raw)) {
		if (!item || typeof item !== "object") continue;
		const { entityId, openedAt } = item as Record<string, unknown>;
		if (typeof entityId !== "string" || entityId.length === 0) continue;
		if (typeof openedAt !== "number" || !Number.isFinite(openedAt)) continue;
		out.push({ entityId, openedAt });
	}
	return out.slice(0, MAX_RECENTS);
}

export function parseSavedSearches(raw: string | null): SavedSearch[] {
	const out: SavedSearch[] = [];
	for (const item of parseArray(raw)) {
		if (!item || typeof item !== "object") continue;
		const { id, text, createdAt } = item as Record<string, unknown>;
		if (typeof id !== "string" || id.length === 0) continue;
		if (typeof text !== "string" || text.trim().length === 0) continue;
		if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) continue;
		out.push({ id, text, createdAt });
	}
	return out.slice(0, MAX_SAVED_SEARCHES);
}

/** Move `entityId` to the front (newest first), dropping any earlier entry
 *  for it, and trim to `cap`. */
export function pushRecent(
	list: readonly RecentEntry[],
	entityId: string,
	now: number,
	cap: number = MAX_RECENTS,
): RecentEntry[] {
	const rest = list.filter((entry) => entry.entityId !== entityId);
	return [{ entityId, openedAt: now }, ...rest].slice(0, cap);
}

/** Normalised query text for a saved search, or null when nothing is left to
 *  save. Whitespace collapses so "a  b" and "a b" are the same search. */
export function normalizeSavedSearchText(text: unknown): string | null {
	if (typeof text !== "string") return null;
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return null;
	return collapsed.slice(0, MAX_SAVED_SEARCH_CHARS);
}

/** Add a saved search (newest first). Saving text that is already saved
 *  (case-insensitively) returns the list unchanged with the existing entry,
 *  so a double-save never duplicates. The oldest entry falls off past `cap`. */
export function addSavedSearch(
	list: readonly SavedSearch[],
	text: string,
	now: number,
	id: string,
	cap: number = MAX_SAVED_SEARCHES,
): { list: SavedSearch[]; saved: SavedSearch } {
	const existing = list.find((s) => s.text.toLowerCase() === text.toLowerCase());
	if (existing) return { list: [...list], saved: existing };
	const saved: SavedSearch = { id, text, createdAt: now };
	return { list: [saved, ...list].slice(0, cap), saved };
}

export class LauncherMemory {
	constructor(
		private readonly store: LauncherSettingsStore,
		private readonly mintId: () => string = randomUUID,
	) {}

	recents(): RecentEntry[] {
		return parseRecents(this.store.get(LAUNCHER_SETTINGS_SCOPE, RECENTS_KEY));
	}

	recordOpen(entityId: string, now: number = Date.now()): void {
		if (entityId.length === 0) return;
		const next = pushRecent(this.recents(), entityId, now);
		this.store.set(LAUNCHER_SETTINGS_SCOPE, RECENTS_KEY, JSON.stringify(next));
	}

	savedSearches(): SavedSearch[] {
		return parseSavedSearches(this.store.get(LAUNCHER_SETTINGS_SCOPE, SAVED_SEARCHES_KEY));
	}

	saveSearch(text: unknown, now: number = Date.now()): SavedSearch | null {
		const normalized = normalizeSavedSearchText(text);
		if (!normalized) return null;
		const { list, saved } = addSavedSearch(this.savedSearches(), normalized, now, this.mintId());
		this.store.set(LAUNCHER_SETTINGS_SCOPE, SAVED_SEARCHES_KEY, JSON.stringify(list));
		return saved;
	}

	deleteSavedSearch(id: unknown): boolean {
		if (typeof id !== "string") return false;
		const current = this.savedSearches();
		const next = current.filter((s) => s.id !== id);
		if (next.length === current.length) return false;
		this.store.set(LAUNCHER_SETTINGS_SCOPE, SAVED_SEARCHES_KEY, JSON.stringify(next));
		return true;
	}
}
