/**
 * Pure CRUD helpers for `List/v1` + `ListView/v1`. Used by the database app's
 * sidebar (list operations) and tab strip (view operations). Functions return
 * new arrays / new entities; callers replace state and persist.
 *
 * Survives the Stage 9.3 entities-service swap: at that point these become
 * thin wrappers over `entities.create / update / delete`. Today they operate
 * on the in-memory `state.lists` / `state.views` arrays seeded from
 * `demo/dataset.ts` + persisted user mutations.
 */

import { uniqueName } from "@brainstorm-os/sdk";
import { type Icon, IconKind } from "@brainstorm-os/sdk-types";
import type { List } from "../types/list";
import type { ListSource } from "../types/list-source";
import { type ColumnSpec, type ListView, ListViewKind } from "../types/list-view";

let idCounter = 0;

function nowMs(): number {
	return Date.now();
}

function newId(prefix: string): string {
	idCounter += 1;
	return `${prefix}_${nowMs().toString(36)}_${idCounter.toString(36)}`;
}

/** Re-exported from `@brainstorm-os/sdk` — the Agent's proposed new database
 *  (Agent-11e) mints names against the same rule. */
export { uniqueName };

/* ── List CRUD ─────────────────────────────────────────────────────────── */

export type CreateListResult = {
	list: List;
	view: ListView;
};

/** Create a new List with a single default Grid view. Returns both — caller
 *  appends to `state.lists` and `state.views`.
 *
 *  `source` defaults to `null` (legacy empty list); the "New list" flow
 *  passes a `ByType` source chosen in the source picker so the list is
 *  populated on creation. `columnIds` seed the Grid view's columns — the
 *  caller derives them from the chosen types' data (`deriveColumns`). */
export function createList(opts: {
	name: string;
	existingLists: ReadonlyArray<List>;
	source?: ListSource | null;
	columnIds?: ReadonlyArray<string>;
}): CreateListResult {
	const now = nowMs();
	const name = uniqueName(opts.name, opts.existingLists);
	const listId = newId("list");
	const viewId = newId("view");
	const columns: ColumnSpec[] = (opts.columnIds ?? []).map((propertyId, i) => ({
		propertyId,
		width: i === 0 ? 280 : 160,
		visible: true,
	}));
	const view: ListView = {
		id: viewId,
		listId,
		name: "Grid",
		icon: null,
		kind: ListViewKind.Grid,
		filters: null,
		sorts: [],
		groupBy: null,
		coverProperty: null,
		cardSubtitleProperty: null,
		columns,
		defaultTypeUrl: null,
		defaultTemplate: null,
		pageSize: 50,
		layoutOptions: {
			rowHeight: "comfortable",
			showRowNumbers: false,
			pinFirstColumn: true,
		},
	};
	const list: List = {
		id: listId,
		name,
		icon: null,
		description: "",
		source: opts.source ?? null,
		members: { include: [], exclude: [] },
		views: [viewId],
		defaultViewId: viewId,
		defaultTemplate: null,
		createdAt: now,
		updatedAt: now,
	};
	return { list, view };
}

export function renameList(list: List, name: string): List {
	const trimmed = name.trim();
	if (!trimmed || trimmed === list.name) return list;
	return { ...list, name: trimmed, updatedAt: nowMs() };
}

function sameIcon(a: Icon | null, b: Icon | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.kind === b.kind &&
		a.value === b.value &&
		(a.kind === IconKind.Pack ? a.color : undefined) ===
			(b.kind === IconKind.Pack ? b.color : undefined)
	);
}

/** Set (or clear, with `null`) the list's own universal icon. */
export function setListIcon(list: List, icon: Icon | null): List {
	if (sameIcon(list.icon, icon)) return list;
	return { ...list, icon, updatedAt: nowMs() };
}

/** Clone a list (deep-copy members + clone every view). */
export function duplicateList(
	source: List,
	sourceViews: ReadonlyArray<ListView>,
	existing: ReadonlyArray<List>,
): { list: List; views: ListView[] } {
	const now = nowMs();
	const listId = newId("list");
	const idMap = new Map<string, string>();
	const clonedViews: ListView[] = [];
	for (const v of sourceViews) {
		if (v.listId !== source.id) continue;
		const newViewId = newId("view");
		idMap.set(v.id, newViewId);
		clonedViews.push({ ...v, id: newViewId, listId });
	}
	const list: List = {
		...source,
		id: listId,
		name: uniqueName(`${source.name} copy`, existing),
		views: clonedViews.map((v) => v.id),
		defaultViewId: source.defaultViewId ? (idMap.get(source.defaultViewId) ?? null) : null,
		members: {
			include: source.members.include.map((m) => ({ ...m })),
			exclude: source.members.exclude.map((m) => ({ ...m })),
		},
		createdAt: now,
		updatedAt: now,
	};
	return { list, views: clonedViews };
}

/** Remove a list and all its views. Returns the filtered arrays. */
export function deleteList(
	lists: ReadonlyArray<List>,
	views: ReadonlyArray<ListView>,
	id: string,
): { lists: List[]; views: ListView[] } {
	return {
		lists: lists.filter((l) => l.id !== id),
		views: views.filter((v) => v.listId !== id),
	};
}

/* ── View CRUD ─────────────────────────────────────────────────────────── */

/** Create a new view for the given list. Defaults to Grid. */
export function createView(opts: {
	listId: string;
	name: string;
	kind?: ListViewKind;
	existingViewsForList: ReadonlyArray<ListView>;
}): ListView {
	const kind = opts.kind ?? ListViewKind.Grid;
	const name = uniqueName(opts.name, opts.existingViewsForList);
	return {
		id: newId("view"),
		listId: opts.listId,
		name,
		icon: null,
		kind,
		filters: null,
		sorts: [],
		groupBy: null,
		coverProperty: null,
		cardSubtitleProperty: null,
		columns: [],
		defaultTypeUrl: null,
		defaultTemplate: null,
		pageSize: 50,
		layoutOptions: defaultLayoutFor(kind),
	};
}

/** Switch a view to another kind. Layout options are kind-specific, so
 *  they reset to that kind's defaults; identity / filters / sorts /
 *  columns / manual order are preserved. */
export function changeViewKind(view: ListView, kind: ListViewKind): ListView {
	if (view.kind === kind) return view;
	return { ...view, kind, layoutOptions: defaultLayoutFor(kind) };
}

export function renameView(view: ListView, name: string): ListView {
	const trimmed = name.trim();
	if (!trimmed || trimmed === view.name) return view;
	return { ...view, name: trimmed };
}

export function duplicateView(
	source: ListView,
	existingViewsForList: ReadonlyArray<ListView>,
): ListView {
	return {
		...source,
		id: newId("view"),
		name: uniqueName(`${source.name} copy`, existingViewsForList),
		columns: source.columns.map((c) => ({ ...c })),
		sorts: source.sorts.map((s) => ({ ...s })),
	};
}

export function deleteView(views: ReadonlyArray<ListView>, id: string): ListView[] {
	return views.filter((v) => v.id !== id);
}

/* ── Defaults ──────────────────────────────────────────────────────────── */

function defaultLayoutFor(kind: ListViewKind): ListView["layoutOptions"] {
	switch (kind) {
		case ListViewKind.Grid:
			return { rowHeight: "comfortable", showRowNumbers: false, pinFirstColumn: true };
		case ListViewKind.List:
			return { density: "comfortable", showIcon: true };
		case ListViewKind.Gallery:
			return { thumbnailSize: "medium", cardAspectRatio: "square", showFilename: true };
		case ListViewKind.Board:
			return { columnWidth: 280, collapseEmptyColumns: false, cardPreview: "rich" };
		case ListViewKind.Calendar:
			// Inline the enum values to avoid a circular import; types are
			// validated by TS against `CalendarLayoutOptions`.
			return {
				range: "month",
				startWeekOn: "mon",
				primaryDateProperty: "dueDate",
				colorBy: null,
			} as ListView["layoutOptions"];
		case ListViewKind.Timeline:
			return {
				primaryDateProperty: "dueDate",
				endDateProperty: null,
				swimlaneBy: null,
				pxPerDay: 24,
				showNow: true,
				showWeekends: true,
				dependencyLinkTypes: [],
				showDependencies: false,
				density: "comfortable",
				colorBy: null,
				labelProperty: null,
			} as ListView["layoutOptions"];
	}
}

/**
 * Which view to open when a List becomes active, in precedence order:
 *   1. the view the user last had open on this List, if it still exists;
 *   2. the List's explicit `defaultViewId`, if set;
 *   3. the List's first view.
 * `views` is already scoped to the target List. Returns `undefined` only
 * for a List with no views (caller no-ops the selection).
 */
export function resolveListView(
	views: ListView[],
	rememberedViewId: string | undefined,
	defaultViewId: string | null | undefined,
): string | undefined {
	if (rememberedViewId && views.some((v) => v.id === rememberedViewId)) {
		return rememberedViewId;
	}
	if (defaultViewId && views.some((v) => v.id === defaultViewId)) {
		return defaultViewId;
	}
	return views[0]?.id;
}
