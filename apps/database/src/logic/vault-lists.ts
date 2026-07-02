/**
 * vault-lists — 9.12.2 (read half).
 *
 * Derives the Database app's Lists + Views from a live vault snapshot
 * (`services.vaultEntities.list()`) instead of the in-memory demo. One
 * `byType` query List per entity type the vault actually contains, plus a
 * combined "All vault items" List, each with a Grid view whose columns are
 * the most common property keys for that type — so the grid is useful over
 * whatever real data exists rather than assuming a fixed schema.
 *
 * Pure + deterministic: ids are derived from the type id so a live
 * `onChange` rebuild keeps the same List/View identity (selection survives
 * a refresh), ordering is stable (count desc, then type asc), and
 * soft-deleted rows are dropped. This is a long-term keystone — when the
 * real entities service (Stage 9.3) lands it feeds the same `{ entities,
 * links }` shape and this module is unchanged; only the call site swaps
 * the snapshot source.
 */

import { COLLECTION_TYPE_URL } from "@brainstorm/sdk-types";
import { friendlyTypeName, isChildEntityType } from "@brainstorm/sdk/system-entities";
import { plural, t } from "../i18n";
import type { List } from "../types/list";
import { ListSourceKind } from "../types/list-source";
import {
	CalendarRange,
	CalendarRecurring,
	CalendarWeekStart,
	EmptyPlacement,
	type GroupBy,
	type ListView,
	ListViewKind,
	SortDirection,
	type SortKey,
} from "../types/list-view";
import type { EntityRow, InMemoryEntities, LinkRow } from "./in-memory-entities";
import { isSystemList } from "./system-lists";

export type VaultEntityInput = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
};

export type VaultLinkInput = {
	id: string;
	sourceEntityId: string;
	destEntityId: string;
	linkType: string;
	createdAt: number;
	deletedAt: number | null;
};

export type VaultSnapshotInput = {
	entities: ReadonlyArray<VaultEntityInput>;
	links: ReadonlyArray<VaultLinkInput>;
};

export type VaultListsResult = {
	db: InMemoryEntities;
	lists: List[];
	views: ListView[];
};

export const ALL_VAULT_LIST_ID = "list_vault_all";
export const ALL_VAULT_VIEW_ID = "view_vault_all_grid";

/** Max grid columns derived per type — beyond this the grid is noise; the
 *  user adds more via the (future) column picker. */
const MAX_DERIVED_COLUMNS = 7;

export function buildVaultLists(
	snapshot: VaultSnapshotInput,
	now: number = Date.now(),
): VaultListsResult {
	const liveEntities = snapshot.entities.filter((e) => e.deletedAt == null);
	const entities: EntityRow[] = liveEntities.map((e) => ({
		id: e.id,
		type: e.type,
		properties: e.properties,
		createdAt: e.createdAt,
		updatedAt: e.updatedAt,
		deletedAt: e.deletedAt,
	}));
	const links: LinkRow[] = snapshot.links
		.filter((l) => l.deletedAt == null)
		.map((l) => ({
			id: l.id,
			sourceEntityId: l.sourceEntityId,
			destEntityId: l.destEntityId,
			linkType: l.linkType,
			createdAt: l.createdAt,
			deletedAt: l.deletedAt,
		}));

	const db: InMemoryEntities = { entities, links };

	const byType = new Map<string, EntityRow[]>();
	for (const e of entities) {
		const bucket = byType.get(e.type);
		if (bucket) bucket.push(e);
		else byType.set(e.type, [e]);
	}

	// Stable order: most-populous type first, ties broken by type id so the
	// sidebar doesn't reshuffle when counts move.
	const orderedTypes = [...byType.entries()].sort(
		(a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
	);

	const lists: List[] = [];
	const views: ListView[] = [];

	for (const [type, rows] of orderedTypes) {
		const slug = typeSlug(type);
		const listId = `list_vault_${slug}`;
		const curated = CURATED_TYPE_LISTS[type];
		if (curated) {
			const curatedViews = buildCuratedViews(listId, slug, curated);
			lists.push({
				id: listId,
				name: curated.name,
				icon: null,
				description: curated.description(rows.length),
				source: { kind: ListSourceKind.ByType, types: [type] },
				members: { include: [], exclude: [] },
				views: curatedViews.map((v) => v.id),
				defaultViewId: curatedViews[0]?.id ?? null,
				defaultTemplate: null,
				createdAt: now,
				updatedAt: now,
			});
			views.push(...curatedViews);
			continue;
		}
		const viewId = `view_vault_${slug}_grid`;
		const columns = deriveColumns(rows);
		lists.push({
			id: listId,
			name: friendlyTypeName(type),
			icon: null,
			description: t("brainstorm.database.vault.typeList.description", {
				items: itemCountLabel(rows.length),
				type,
			}),
			source: { kind: ListSourceKind.ByType, types: [type] },
			members: { include: [], exclude: [] },
			views: [viewId],
			defaultViewId: viewId,
			defaultTemplate: null,
			createdAt: now,
			updatedAt: now,
		});
		views.push(gridView(viewId, listId, columns));
	}

	// Combined list — every top-level type at once. Useful as a single
	// landing pane and so an empty-but-typed vault still has one selectable
	// List. Parent-scoped child rows (Messages, Comments — F-318) live inside
	// their containers and keep their dedicated type-List above, but are
	// excluded here so they don't bury the vault's real documents.
	const topLevelTypes = orderedTypes.filter(([type]) => !isChildEntityType(type));
	if (topLevelTypes.length > 0) {
		const topLevel = topLevelTypes.flatMap(([, rows]) => rows);
		lists.push({
			id: ALL_VAULT_LIST_ID,
			name: t("brainstorm.database.vault.allItems"),
			icon: null,
			description: t("brainstorm.database.vault.allItems.description", {
				items: itemCountLabel(topLevel.length),
				types: plural(
					topLevelTypes.length,
					"brainstorm.database.vault.types.one",
					"brainstorm.database.vault.types.other",
				),
			}),
			source: { kind: ListSourceKind.ByType, types: topLevelTypes.map(([type]) => type) },
			members: { include: [], exclude: [] },
			views: [ALL_VAULT_VIEW_ID],
			defaultViewId: ALL_VAULT_VIEW_ID,
			defaultTemplate: null,
			createdAt: now,
			updatedAt: now,
		});
		views.push(gridView(ALL_VAULT_VIEW_ID, ALL_VAULT_LIST_ID, deriveColumns(topLevel)));
	}

	return { db, lists, views };
}

/** Distinct entity types present in `rows`, as relation-picker targets
 *  (`{ type, label }`), most-populous first (ties by type id). The List
 *  meta-type is dropped — a row links to records, not to a collection
 *  definition. Feeds the inline property form's "Links to" picker so an
 *  Engagements column can target Clients / People / Tasks, not just notes. */
export function relationTargetTypesFromEntities(
	rows: ReadonlyArray<{ type: string }>,
): { type: string; label: string }[] {
	const counts = new Map<string, number>();
	for (const r of rows) {
		if (r.type === COLLECTION_TYPE_URL) continue;
		counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([type]) => ({ type, label: friendlyTypeName(type) }));
}

/** Every list built by `buildVaultLists` is vault-derived by construction,
 *  so the sidebar's system classification reduces to the source-type test. */
const isBuiltSystemList = (list: List): boolean => isSystemList(list, () => true);

/** First selectable `{ listId, viewId }` for a freshly-built vault set, or
 *  `null` when the vault has no entities (the caller shows the empty
 *  state). Prefers a list that is VISIBLE in the sidebar: system-classified
 *  type-lists (F-212/F-318) live under the collapsed-by-default System
 *  disclosure, so defaulting to the most-populous list on a chat-heavy
 *  vault landed on a hidden Messages row (stage full, sidebar blank). Order:
 *  most-populous non-system List → the All-vault List → only when nothing
 *  else exists, a system List (the caller reveals it via
 *  `selectionNeedsSystemReveal`). */
export function firstVaultSelection(
	result: VaultListsResult,
): { listId: string; viewId: string } | null {
	const pick =
		result.lists.find((l) => l.id !== ALL_VAULT_LIST_ID && !isBuiltSystemList(l)) ??
		result.lists.find((l) => l.id === ALL_VAULT_LIST_ID) ??
		result.lists[0];
	if (!pick || !pick.defaultViewId) return null;
	return { listId: pick.id, viewId: pick.defaultViewId };
}

/** True when the active selection resolves to a system-classified list —
 *  its sidebar row hides under the System disclosure (collapsed by
 *  default), so the caller must open the disclosure or the active row is
 *  invisible. Covers both the `firstVaultSelection` fallback (child-only
 *  vault) and a persisted selection restored onto a system list. */
export function selectionNeedsSystemReveal(
	lists: ReadonlyArray<List>,
	activeListId: string,
	isVaultDerived: (id: string) => boolean,
): boolean {
	const list = lists.find((l) => l.id === activeListId);
	return list != null && isSystemList(list, isVaultDerived);
}

export { friendlyTypeName };

/** "{count} item(s)" fragment shared by the vault-list descriptions. */
function itemCountLabel(count: number): string {
	return plural(
		count,
		"brainstorm.database.vault.items.one",
		"brainstorm.database.vault.items.other",
	);
}

/** DOM/id-safe slug for deriving stable List/View ids from a type id. */
export function typeSlug(typeId: string): string {
	const slug = typeId
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "type";
}

/** Property keys ordered by how many of `rows` carry a non-empty value
 *  (desc), ties broken alphabetically, `title` always first when present.
 *  Capped at `MAX_DERIVED_COLUMNS`. */
export function deriveColumns(rows: ReadonlyArray<EntityRow>): string[] {
	const freq = new Map<string, number>();
	for (const row of rows) {
		for (const [key, value] of Object.entries(row.properties)) {
			if (value == null || value === "") continue;
			freq.set(key, (freq.get(key) ?? 0) + 1);
		}
	}
	const ordered = [...freq.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([k]) => k);
	const withTitleFirst = ordered.includes("title")
		? ["title", ...ordered.filter((k) => k !== "title")]
		: ordered;
	const cols = withTitleFirst.slice(0, MAX_DERIVED_COLUMNS);
	// Always show at least the title column so an empty type still renders
	// a sane grid header rather than a zero-column table.
	return cols.length > 0 ? cols : ["title"];
}

function gridView(id: string, listId: string, columnIds: string[]): ListView {
	return {
		id,
		listId,
		name: "Grid",
		icon: null,
		kind: ListViewKind.Grid,
		filters: null,
		sorts: [
			{
				propertyId: "updatedAt",
				direction: SortDirection.Desc,
				emptyPlacement: EmptyPlacement.End,
			},
		],
		groupBy: null,
		coverProperty: null,
		cardSubtitleProperty: null,
		columns: columnIds.map((propertyId, i) => ({
			propertyId,
			width: i === 0 ? 280 : 160,
			visible: true,
		})),
		defaultTypeUrl: null,
		defaultTemplate: null,
		pageSize: 50,
		layoutOptions: {
			rowHeight: "comfortable",
			showRowNumbers: false,
			pinFirstColumn: true,
		},
	};
}

/**
 * Curated overlay (9.12.13(b) People · 9.14.4 Tasks): for a few
 * well-known canonical types, a generic single-grid List undersells the
 * data. A curated spec gives the List a human name, a focused column set,
 * and multiple purpose-built views. Stable ids
 * (`view_vault_<slug>_<suffix>`) keep selection +
 * per-view-delta persistence intact across an `onChange` rebuild, exactly
 * like the generic path. Non-curated types are unchanged.
 */
type CuratedViewSpec = {
	suffix: string;
	name: string;
	kind: ListViewKind;
	sorts: SortKey[];
	layoutOptions: ListView["layoutOptions"];
	/** Board-kind views group cards by a property (`statusKey`,
	 *  `priority`, …); omit for flat kinds. */
	groupBy?: GroupBy | null;
	/** Secondary line on Board / Gallery cards. */
	cardSubtitleProperty?: string | null;
};
type CuratedListSpec = {
	name: string;
	description: (count: number) => string;
	columns: string[];
	views: CuratedViewSpec[];
};

const ASC_NAME: SortKey = {
	propertyId: "name",
	direction: SortDirection.Asc,
	emptyPlacement: EmptyPlacement.End,
};
const RECENT: SortKey = {
	propertyId: "updatedAt",
	direction: SortDirection.Desc,
	emptyPlacement: EmptyPlacement.End,
};
const SCHEDULED_ASC: SortKey = {
	propertyId: "scheduledAt",
	direction: SortDirection.Asc,
	emptyPlacement: EmptyPlacement.End,
};
const DUE_ASC: SortKey = {
	propertyId: "dueAt",
	direction: SortDirection.Asc,
	emptyPlacement: EmptyPlacement.End,
};

const CURATED_TYPE_LISTS: Record<string, CuratedListSpec> = {
	// 9.14.4 — the "All tasks" Database type-List shortcut. A generic
	// single-grid List undersells `Task/v1`: the canonical Tasks-app
	// surfaces (a status board, a date-ordered Upcoming list, a calendar)
	// are exactly what makes the project's real task data legible here.
	// Columns mirror the `brainstorm/Task/v1` shape (apps/tasks task.ts).
	"brainstorm/Task/v1": {
		name: "Tasks",
		description: (n) => `${n} ${n === 1 ? "task" : "tasks"} · brainstorm/Task/v1`,
		columns: ["name", "statusKey", "priority", "scheduledAt", "dueAt"],
		views: [
			{
				suffix: "board",
				name: "Board",
				kind: ListViewKind.Board,
				sorts: [DUE_ASC],
				groupBy: { propertyId: "statusKey" },
				cardSubtitleProperty: "priority",
				layoutOptions: {
					columnWidth: 320,
					collapseEmptyColumns: false,
					cardPreview: "rich",
				},
			},
			{
				suffix: "upcoming",
				name: "Upcoming",
				kind: ListViewKind.List,
				sorts: [SCHEDULED_ASC],
				layoutOptions: { density: "comfortable", showIcon: true },
			},
			{
				// Schedule on `scheduledAt` (when the user plans to do it) —
				// the same date the Tasks app's Today / Upcoming surfaces key
				// off. Undated backlog items simply don't appear that month.
				suffix: "schedule",
				name: "Schedule",
				kind: ListViewKind.Calendar,
				sorts: [],
				layoutOptions: {
					range: CalendarRange.Month,
					startWeekOn: CalendarWeekStart.Monday,
					primaryDateProperty: "scheduledAt",
					colorBy: null,
				},
			},
		],
	},
	"brainstorm/Person/v1": {
		name: "People",
		description: (n) => `${n} ${n === 1 ? "contact" : "contacts"} · brainstorm/Person/v1`,
		columns: ["name", "email", "phone", "company", "role"],
		views: [
			{
				suffix: "directory",
				name: "Directory",
				kind: ListViewKind.Grid,
				sorts: [ASC_NAME],
				layoutOptions: { rowHeight: "comfortable", showRowNumbers: false, pinFirstColumn: true },
			},
			{
				suffix: "recent",
				name: "Recent",
				kind: ListViewKind.List,
				sorts: [RECENT],
				layoutOptions: { density: "comfortable", showIcon: true },
			},
			{
				// Birthdays recur every year: `recurring: Yearly` projects
				// each Person's `birthday` onto the displayed period via the
				// shared 9.15.5 engine (OQ-CT-3 / OQ-CAL-2 resolved 9.15.5).
				suffix: "birthdays",
				name: "Birthdays",
				kind: ListViewKind.Calendar,
				sorts: [],
				layoutOptions: {
					range: "month",
					startWeekOn: "mon",
					primaryDateProperty: "birthday",
					colorBy: null,
					recurring: CalendarRecurring.Yearly,
				} as ListView["layoutOptions"],
			},
		],
	},
};

function buildCuratedViews(listId: string, slug: string, spec: CuratedListSpec): ListView[] {
	const columns = spec.columns.map((propertyId, i) => ({
		propertyId,
		width: i === 0 ? 280 : 160,
		visible: true,
	}));
	return spec.views.map((v) => ({
		id: `view_vault_${slug}_${v.suffix}`,
		listId,
		name: v.name,
		icon: null,
		kind: v.kind,
		filters: null,
		sorts: v.sorts,
		groupBy: v.groupBy ?? null,
		coverProperty: null,
		cardSubtitleProperty: v.cardSubtitleProperty ?? null,
		columns,
		defaultTypeUrl: null,
		defaultTemplate: null,
		pageSize: 50,
		layoutOptions: v.layoutOptions,
	}));
}
