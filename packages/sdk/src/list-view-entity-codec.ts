/**
 * ListView ⇄ `brainstorm/ListView/v1` entity codec (9.12.8).
 *
 * The view-lifecycle iteration promotes user-created views from the
 * Database app's per-device kv payload to first-class vault entities, so a
 * view created on one device exists on every device (and a `ListView` id is
 * a real openable object — the manifest already registers the type + a
 * primary opener). Mirrors `list-entity-codec` exactly: `ListView.id` ⇄
 * `Entity.id`; everything else lives in `properties`; the entity owns the
 * timestamps (a `ListView` carries none).
 *
 * `entityToListView` is defensive — a partially-written or hand-edited
 * entity coerces field-by-field to safe defaults, but a row with a missing
 * `listId` or an unknown `kind` returns `null` (the two fields without
 * which a view cannot render), so one bad row never takes down the app.
 */

import {
	type ColumnSpec,
	type Entity,
	type FilterNode,
	type GroupBy,
	type Icon,
	type LayoutOptions,
	type ListView,
	ListViewKind,
	type SortKey,
} from "@brainstorm-os/sdk-types";

export const LIST_VIEW_ENTITY_TYPE = "brainstorm/ListView/v1";

/** The `properties` bag persisted on a `brainstorm/ListView/v1` entity —
 *  the `ListView` minus the entity-owned `id`. */
export type ListViewEntityProperties = {
	listId: string;
	name: string;
	icon: Icon | null;
	kind: ListViewKind;
	filters: FilterNode | null;
	sorts: SortKey[];
	groupBy: GroupBy | null;
	coverProperty: string | null;
	cardSubtitleProperty: string | null;
	columns: ColumnSpec[];
	manualOrder?: string[];
	defaultTypeUrl: string | null;
	defaultTemplate: string | null;
	pageSize: number;
	layoutOptions: LayoutOptions;
};

export function listViewToEntityProperties(view: ListView): ListViewEntityProperties {
	return {
		listId: view.listId,
		name: view.name,
		icon: view.icon,
		kind: view.kind,
		filters: view.filters,
		sorts: view.sorts,
		groupBy: view.groupBy,
		coverProperty: view.coverProperty,
		cardSubtitleProperty: view.cardSubtitleProperty,
		columns: view.columns,
		...(view.manualOrder !== undefined ? { manualOrder: view.manualOrder } : {}),
		defaultTypeUrl: view.defaultTypeUrl,
		defaultTemplate: view.defaultTemplate,
		pageSize: view.pageSize,
		layoutOptions: view.layoutOptions,
	};
}

const VIEW_KINDS = new Set<string>(Object.values(ListViewKind));

/** Default page size when a persisted row lacks a usable number — matches
 *  the Database app's own view-creation default. */
const DEFAULT_PAGE_SIZE = 50;

export function entityToListView(entity: Entity): ListView | null {
	if (entity.type !== LIST_VIEW_ENTITY_TYPE) return null;
	const p = entity.properties as Record<string, unknown>;
	const listId = typeof p.listId === "string" ? p.listId : null;
	const kind =
		typeof p.kind === "string" && VIEW_KINDS.has(p.kind) ? (p.kind as ListViewKind) : null;
	if (!listId || !kind) return null;
	const manualOrder = asStringArrayOrUndefined(p.manualOrder);
	return {
		id: entity.id,
		listId,
		name: asString(p.name, ""),
		icon: asObjectOrNull<Icon>(p.icon),
		kind,
		filters: asFilters(p.filters),
		sorts: asObjectArray<SortKey>(p.sorts),
		groupBy: asObjectOrNull<GroupBy>(p.groupBy),
		coverProperty: asStringOrNull(p.coverProperty),
		cardSubtitleProperty: asStringOrNull(p.cardSubtitleProperty),
		columns: asObjectArray<ColumnSpec>(p.columns),
		...(manualOrder !== undefined ? { manualOrder } : {}),
		defaultTypeUrl: asStringOrNull(p.defaultTypeUrl),
		defaultTemplate: asStringOrNull(p.defaultTemplate),
		pageSize:
			typeof p.pageSize === "number" && Number.isFinite(p.pageSize) ? p.pageSize : DEFAULT_PAGE_SIZE,
		layoutOptions: asObject<LayoutOptions>(p.layoutOptions),
	};
}

function asString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function asStringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asStringArrayOrUndefined(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

function asObjectOrNull<T>(value: unknown): T | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null;
}

function asObject<T>(value: unknown): T {
	return (asObjectOrNull<T>(value) ?? {}) as T;
}

function asObjectArray<T>(value: unknown): T[] {
	return Array.isArray(value)
		? (value.filter((v) => v !== null && typeof v === "object") as T[])
		: [];
}

/** `filters` is a `FilterNode` tree (an object) — but pre-9.12 payloads
 *  carried a legacy array form the manifest schema still allows; both
 *  coerce, anything else is null. */
function asFilters(value: unknown): FilterNode | null {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as FilterNode;
	return null;
}
