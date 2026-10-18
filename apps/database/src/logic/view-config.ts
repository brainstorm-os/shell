/**
 * Pure view-config reducer for `ListView/v1` (9.12.6).
 *
 * `app.ts` mutates a view's display config (columns / sorts / filters /
 * group-by / card fields / layout / manual row order / kind) from a dozen
 * call sites, each previously re-spelling the same `{ ...prev, <oneKey>:
 * next }` immutable update inline — past the DRY ceiling, and the *kind*
 * switch additionally hand-rolled the "Board/Calendar with no group-by
 * renders blank → auto-pick a property" rule at its single call site.
 *
 * This module is the single home for "apply one config change to a view".
 * `applyViewConfig(view, action)` takes a live `ListView` plus a typed,
 * enum-discriminated action and returns a NEW `ListView` (or the same
 * reference when the action is a no-op — e.g. switching to the kind a view
 * already has). It composes the existing `changeViewKind` (layout reset)
 * and `autoGroupBy` (sensible default axis) helpers rather than
 * re-deriving them, so the kind-switch domain rule lives in one tested
 * place. Callers do the `findIndex` / array-splice / persist / re-render
 * bookkeeping; the transform itself is pure data-in / data-out.
 */

import {
	type ColumnSpec,
	type FilterNode,
	type GroupBy,
	type LayoutOptions,
	type ListView,
	ListViewKind,
	type SortKey,
	type TimelineLayoutOptions,
} from "../types";
import { autoGroupBy, datePropertyCandidates } from "./auto-group";
import type { EntityRow } from "./in-memory-entities";
import { changeViewKind, renameView, uniqueName } from "./list-crud";

/** Discriminator for a view-config change. String enum so the wire/debug
 *  value reads itself and a `switch` is exhaustive (CLAUDE.md: no raw
 *  string-literal discriminators). */
export enum ViewConfigAction {
	SetColumns = "set-columns",
	SetSorts = "set-sorts",
	SetFilters = "set-filters",
	SetGroupBy = "set-group-by",
	SetCardFields = "set-card-fields",
	SetLayout = "set-layout",
	SetManualOrder = "set-manual-order",
	SetKind = "set-kind",
	SetName = "set-name",
}

/** The card-field subset a Gallery/Board view exposes for cover + subtitle. */
export type CardFields = Partial<Pick<ListView, "coverProperty" | "cardSubtitleProperty">>;

export type ViewConfigChange =
	| { action: ViewConfigAction.SetColumns; columns: ColumnSpec[] }
	| { action: ViewConfigAction.SetSorts; sorts: SortKey[] }
	| { action: ViewConfigAction.SetFilters; filters: FilterNode | null }
	| { action: ViewConfigAction.SetGroupBy; groupBy: GroupBy | null }
	| { action: ViewConfigAction.SetCardFields; fields: CardFields }
	| { action: ViewConfigAction.SetLayout; layoutOptions: LayoutOptions }
	| { action: ViewConfigAction.SetManualOrder; order: string[] }
	| { action: ViewConfigAction.SetKind; kind: ListViewKind }
	| { action: ViewConfigAction.SetName; name: string };

/**
 * Apply one config change to a view, returning a new `ListView`.
 *
 * `rows` and `siblingViews` are only consulted for `SetKind`: switching to
 * Board/Calendar with no existing group-by auto-picks a sensible axis from
 * the live data, and switching to Timeline auto-binds the obvious date
 * property (F-211) — a bare switch otherwise renders blank. `siblingViews`
 * are the list's OTHER views; an existing Calendar view's date axis wins
 * the Timeline pick so the two date views agree. Every other action
 * ignores both. Returns the SAME reference for a true no-op (kind already
 * matches) so a re-render can bail.
 */
export function applyViewConfig(
	view: ListView,
	change: ViewConfigChange,
	rows: ReadonlyArray<EntityRow> = [],
	siblingViews: ReadonlyArray<ListView> = [],
): ListView {
	switch (change.action) {
		case ViewConfigAction.SetColumns:
			return { ...view, columns: change.columns };
		case ViewConfigAction.SetSorts:
			return { ...view, sorts: change.sorts };
		case ViewConfigAction.SetFilters:
			return { ...view, filters: change.filters };
		case ViewConfigAction.SetGroupBy:
			return { ...view, groupBy: change.groupBy };
		case ViewConfigAction.SetCardFields:
			return { ...view, ...change.fields };
		case ViewConfigAction.SetLayout:
			return { ...view, layoutOptions: change.layoutOptions };
		case ViewConfigAction.SetManualOrder:
			return { ...view, manualOrder: change.order };
		case ViewConfigAction.SetKind:
			return applyKind(view, change.kind, rows, siblingViews);
		case ViewConfigAction.SetName:
			// `renameView` trims and returns the SAME reference for a no-op
			// (empty / whitespace-only / unchanged name) so callers can bail.
			return renameView(view, change.name);
	}
}

/** Display name per view kind — the single home for the kind→label map on
 *  the logic side (`view-settings.ts` keeps its own label+icon meta table
 *  for the kind picker UI). */
const VIEW_KIND_LABELS: Readonly<Record<ListViewKind, string>> = {
	[ListViewKind.Grid]: "Grid",
	[ListViewKind.List]: "List",
	[ListViewKind.Gallery]: "Gallery",
	[ListViewKind.Board]: "Board",
	[ListViewKind.Calendar]: "Calendar",
	[ListViewKind.Timeline]: "Timeline",
	[ListViewKind.Chart]: "Chart",
};

export function viewKindLabel(kind: ListViewKind): string {
	return VIEW_KIND_LABELS[kind];
}

/**
 * The default name for a freshly-created view: its kind's display name,
 * de-collided against the list's existing views (`Grid`, `Grid 2`, …) —
 * never an anonymous constant like "New view" (F-038 / F-208). The create
 * flow drops straight into inline rename, so this is the fallback the user
 * keeps by pressing Escape.
 */
export function defaultViewName(
	kind: ListViewKind,
	existingViewsForList: ReadonlyArray<{ name: string }>,
): string {
	return uniqueName(viewKindLabel(kind), existingViewsForList);
}

/** Switch a view's kind, resetting its layout to that kind's default
 *  (`changeViewKind`) and back-filling the axis the new kind needs to
 *  render at all: a group-by for Board/Calendar, the primary date
 *  property for Timeline (F-211) — otherwise those views render blank. */
function applyKind(
	view: ListView,
	kind: ListViewKind,
	rows: ReadonlyArray<EntityRow>,
	siblingViews: ReadonlyArray<ListView>,
): ListView {
	const switched = changeViewKind(view, kind);
	if (switched === view) return view;
	if (kind === ListViewKind.Timeline) return bindTimelineDate(switched, rows, siblingViews);
	if (switched.groupBy) return switched;
	if (kind !== ListViewKind.Board && kind !== ListViewKind.Calendar && kind !== ListViewKind.Chart)
		return switched;
	const axis = autoGroupBy(kind === ListViewKind.Calendar, rows);
	return axis ? { ...switched, groupBy: axis } : switched;
}

/**
 * Auto-bind the freshly-switched Timeline's `primaryDateProperty` when the
 * default binding (`dueDate`) carries no values in the live rows: prefer
 * the date axis an existing Calendar sibling already uses, else the
 * best-ranked date-typed property in the data (`datePropertyCandidates` —
 * deterministic: a single date property is THE pick; several pick by
 * preference rank then property order). No candidates → the layout is left
 * as-is and the view shows the empty state pointing at the Dates page.
 */
export function bindTimelineDate(
	view: ListView,
	rows: ReadonlyArray<EntityRow>,
	siblingViews: ReadonlyArray<ListView> = [],
): ListView {
	const layout = view.layoutOptions as TimelineLayoutOptions;
	const candidates = datePropertyCandidates(rows);
	if (candidates.length === 0 || candidates.includes(layout.primaryDateProperty)) return view;
	const calendarAxis = siblingViews.find(
		(v) => v.kind === ListViewKind.Calendar && v.groupBy?.propertyId,
	)?.groupBy?.propertyId;
	const pick =
		calendarAxis && candidates.includes(calendarAxis) ? calendarAxis : (candidates[0] as string);
	return { ...view, layoutOptions: { ...layout, primaryDateProperty: pick } };
}
