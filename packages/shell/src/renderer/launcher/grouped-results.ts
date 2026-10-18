/**
 * Pure result-grouping for the launcher (Stage 9.22.2). Replaces the flat
 * `filterResults` of 7.4 with a two-section model:
 *
 *   1. **Apps** — apps whose name or description matches the query (plus,
 *      with an empty query, the full installed list).
 *   2. **Entities** — FTS5 hits from the vault-wide search index, grouped
 *      by the owning app (visible when the query has any non-whitespace).
 *
 * An empty query (9.22.7) leads with the user's saved searches and recently
 * opened objects above the app list; a typed query ends with a "save this
 * search" row unless that text is already saved.
 *
 * Result rendering, keyboard navigation, and activation operate on the
 * **flat** `LauncherRow[]` returned by `buildRows` — selection-only rows
 * (`section-header`) are skipped by `moveSelectionGrouped` so arrow keys
 * never land on a heading. `firstSelectableIndex` returns the initial
 * cursor position to use when results change.
 *
 * Kept pure (no React, no IPC) so the entire selection model is testable
 * under Vitest without rendering.
 */

import type { InstalledApp, SavedSearch, SearchHit } from "../../preload";

export enum LauncherRowKind {
	SectionHeader = "section-header",
	App = "app",
	Entity = "entity",
	SavedSearch = "saved-search",
	SaveSearch = "save-search",
}

export type LauncherSectionHeaderRow = {
	rowKind: LauncherRowKind.SectionHeader;
	id: string;
	label: string;
};

export type LauncherAppRow = {
	rowKind: LauncherRowKind.App;
	id: string;
	app: InstalledApp;
};

export type LauncherEntityRow = {
	rowKind: LauncherRowKind.Entity;
	id: string;
	hit: SearchHit;
	/** Display name of the owning app — used in the result subtitle. Falls
	 *  back to the raw appId if the app isn't installed (orphaned index
	 *  row — should be vanishingly rare since the indexer rebuilds on
	 *  vault switch). */
	ownerAppName: string;
};

export type LauncherSavedSearchRow = {
	rowKind: LauncherRowKind.SavedSearch;
	id: string;
	search: SavedSearch;
};

export type LauncherSaveSearchRow = {
	rowKind: LauncherRowKind.SaveSearch;
	id: string;
	text: string;
};

export type LauncherRow =
	| LauncherSectionHeaderRow
	| LauncherAppRow
	| LauncherEntityRow
	| LauncherSavedSearchRow
	| LauncherSaveSearchRow;

export type BuildRowsOptions = {
	query: string;
	apps: readonly InstalledApp[];
	entities: readonly SearchHit[];
	recents?: readonly SearchHit[];
	savedSearches?: readonly SavedSearch[];
	/** Append the "save this search" row to a typed query. */
	offerSaveSearch?: boolean;
	labels: {
		sectionApps: string;
		sectionEntities: string;
		sectionRecent: string;
		sectionSaved: string;
	};
};

export function buildRows(options: BuildRowsOptions): LauncherRow[] {
	const norm = options.query.trim().toLowerCase();
	const filteredApps = filterApps(norm, options.apps);
	const rows: LauncherRow[] = [];
	const appNamesById = new Map<string, string>();
	for (const app of options.apps) appNamesById.set(app.id, app.name);
	const saved = options.savedSearches ?? [];
	if (norm.length === 0) {
		if (saved.length > 0) {
			rows.push({
				rowKind: LauncherRowKind.SectionHeader,
				id: "section:saved",
				label: options.labels.sectionSaved,
			});
			for (const search of saved) {
				rows.push({ rowKind: LauncherRowKind.SavedSearch, id: `saved:${search.id}`, search });
			}
		}
		const recents = options.recents ?? [];
		if (recents.length > 0) {
			rows.push({
				rowKind: LauncherRowKind.SectionHeader,
				id: "section:recent",
				label: options.labels.sectionRecent,
			});
			for (const hit of recents) rows.push(entityRow("recent", hit, appNamesById));
		}
	}
	if (filteredApps.length > 0) {
		rows.push({
			rowKind: LauncherRowKind.SectionHeader,
			id: "section:apps",
			label: options.labels.sectionApps,
		});
		for (const app of filteredApps) {
			rows.push({ rowKind: LauncherRowKind.App, id: `app:${app.id}`, app });
		}
	}
	// Entities only surface when the user is actually searching — an empty
	// query would otherwise dump the entire vault.
	if (norm.length > 0 && options.entities.length > 0) {
		rows.push({
			rowKind: LauncherRowKind.SectionHeader,
			id: "section:entities",
			label: options.labels.sectionEntities,
		});
		for (const hit of options.entities) rows.push(entityRow("entity", hit, appNamesById));
	}
	const typed = options.query.replace(/\s+/g, " ").trim();
	if (
		options.offerSaveSearch &&
		typed.length > 0 &&
		!saved.some((s) => s.text.toLowerCase() === typed.toLowerCase())
	) {
		rows.push({ rowKind: LauncherRowKind.SaveSearch, id: "save-search", text: typed });
	}
	return rows;
}

function entityRow(
	prefix: string,
	hit: SearchHit,
	appNamesById: ReadonlyMap<string, string>,
): LauncherEntityRow {
	return {
		rowKind: LauncherRowKind.Entity,
		id: `${prefix}:${hit.entityId}`,
		hit,
		ownerAppName: appNamesById.get(hit.ownerAppId) ?? hit.ownerAppId,
	};
}

/** Apps that match the query via name or description (case-insensitive,
 *  substring). Empty query passes everything through unfiltered. Ranking
 *  promotes prefix matches over substring matches; ties break by app
 *  name (locale-aware) so the order is stable. */
export function filterApps(normalizedQuery: string, apps: readonly InstalledApp[]): InstalledApp[] {
	if (normalizedQuery === "") return [...apps].sort((a, b) => a.name.localeCompare(b.name));
	type Scored = { app: InstalledApp; rank: number };
	const scored: Scored[] = [];
	for (const app of apps) {
		const name = app.name.toLowerCase();
		const description = app.description?.toLowerCase() ?? "";
		let rank = -1;
		if (name.startsWith(normalizedQuery)) rank = 0;
		else if (name.includes(normalizedQuery)) rank = 1;
		else if (description.includes(normalizedQuery)) rank = 2;
		if (rank >= 0) scored.push({ app, rank });
	}
	scored.sort((a, b) => a.rank - b.rank || a.app.name.localeCompare(b.app.name));
	return scored.map((s) => s.app);
}

/** Selection-aware Down/Up that skips section headers. Wrap-free — at the
 *  ends, the cursor sits. Returns `-1` when there are no selectable rows
 *  (no apps + no entities — the caller renders the empty state). */
export function moveSelectionGrouped(
	direction: "down" | "up",
	current: number,
	rows: readonly LauncherRow[],
): number {
	const selectables: number[] = [];
	for (let i = 0; i < rows.length; i += 1) {
		const row = rows[i];
		if (row && isSelectable(row)) selectables.push(i);
	}
	if (selectables.length === 0) return -1;
	const currentPos = selectables.indexOf(current);
	if (currentPos === -1) return selectables[0] ?? -1;
	if (direction === "down") {
		const next = selectables[Math.min(currentPos + 1, selectables.length - 1)];
		return next ?? selectables[0] ?? -1;
	}
	const prev = selectables[Math.max(currentPos - 1, 0)];
	return prev ?? selectables[0] ?? -1;
}

/** First selectable row index — `-1` when there are no selectable rows.
 *  Used as the initial cursor when results change. */
export function firstSelectableIndex(rows: readonly LauncherRow[]): number {
	for (let i = 0; i < rows.length; i += 1) {
		const row = rows[i];
		if (row && isSelectable(row)) return i;
	}
	return -1;
}

/** Clamp a selection index back onto a selectable row when the results
 *  shrink underneath it. Walks toward the start, then toward the end. */
export function clampSelectionGrouped(current: number, rows: readonly LauncherRow[]): number {
	if (rows.length === 0) return -1;
	const target = Math.max(0, Math.min(current, rows.length - 1));
	for (let i = target; i >= 0; i -= 1) {
		const row = rows[i];
		if (row && isSelectable(row)) return i;
	}
	for (let i = target + 1; i < rows.length; i += 1) {
		const row = rows[i];
		if (row && isSelectable(row)) return i;
	}
	return -1;
}

function isSelectable(row: LauncherRow): boolean {
	return row.rowKind !== LauncherRowKind.SectionHeader;
}
