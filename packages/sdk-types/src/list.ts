/**
 * Collection shapes (9.3.5.1b) — `List/v1`, its `ListSource` membership
 * criteria, and `ListView/v1` (the six view kinds + their per-kind layout
 * options). Promoted here from the app-local
 * `apps/database/src/types/{list,list-source,list-view}.ts` so there is ONE
 * canonical definition shared by the Database app, the SH-8/SH-8a seed, and
 * any future consumer.
 *
 * The membership sub-contract (`MemberOverrides`, `ListMode`,
 * `COLLECTION_TYPE_URL`) was promoted in 9.3.5.1 and lives in
 * `./collections`; this file owns the rest now that the `Icon` /
 * `PropertyPredicate` reconciliation (9.3.5.1b) cleared the app-local-dep
 * blocker. See,
 *  and
 * .
 */

import type { MemberOverrides } from "./collections";
import type { Icon } from "./icon";
import type { FilterNode, PropertyPredicate } from "./predicate";

// ─── ListSource — dynamic membership criteria ───────────────────────────────

export enum ListSourceKind {
	ByType = "byType",
	ByFilter = "byFilter",
	ByLink = "byLink",
	ByVocabulary = "byVocabulary",
	Composite = "composite",
}

export enum LinkDirection {
	In = "in",
	Out = "out",
}

export enum CompositeOp {
	And = "and",
	Or = "or",
}

export type ListSourceByType = {
	kind: ListSourceKind.ByType;
	types: string[];
};

export type ListSourceByFilter = {
	kind: ListSourceKind.ByFilter;
	where: PropertyPredicate;
};

export type ListSourceByLink = {
	kind: ListSourceKind.ByLink;
	linkType: string;
	direction: LinkDirection;
	/** Single anchor (legacy / the common case). */
	anchorEntityId?: string;
	/** Multiple anchors with implicit OR — "members reachable from *any* of
	 *  these entities by `linkType`" (OQ-LD-1 (b), 9.12.22). Additive: a source
	 *  carrying only `anchorEntityId` still resolves; a reader unions both. At
	 *  least one of the two must be set. */
	anchorEntityIds?: string[];
};

export type ListSourceByVocabulary = {
	kind: ListSourceKind.ByVocabulary;
	vocabularyId: string;
	values?: string[];
};

export type ListSourceComposite = {
	kind: ListSourceKind.Composite;
	op: CompositeOp;
	sources: ListSource[];
};

export type ListSource =
	| ListSourceByType
	| ListSourceByFilter
	| ListSourceByLink
	| ListSourceByVocabulary
	| ListSourceComposite;

// ─── ListView — one view onto a List ────────────────────────────────────────

export enum ListViewKind {
	Grid = "grid",
	List = "list",
	Gallery = "gallery",
	Board = "board",
	Calendar = "calendar",
	Timeline = "timeline",
	/** Chart (9.12.30) — the group-by × aggregation engine drawn as a bar /
	 *  line / pie chart or a single number. */
	Chart = "chart",
}

export enum SortDirection {
	Asc = "asc",
	Desc = "desc",
	Manual = "manual",
}

export enum EmptyPlacement {
	None = "none",
	Start = "start",
	End = "end",
}

export type SortKey = {
	propertyId: string;
	direction: SortDirection;
	emptyPlacement: EmptyPlacement;
};

export type GroupBy = {
	propertyId: string;
};

/** A computed *rollup* column's spec (9.12.17): no backing entity property —
 *  the cell value is derived by walking the source row's `relationKey` relation
 *  to its linked entities, reading each one's `targetPropertyKey`, and reducing
 *  the gathered values with `aggregation`. `aggregation` is kept a plain string
 *  (an `AggregationKind` value) so this leaf type stays free of the Database
 *  app's `AggregationKind` enum — the same reason the `$relativeDate` predicate
 *  RHS is a plain token string. */
export type ColumnRollup = {
	relationKey: string;
	targetPropertyKey: string;
	aggregation: string;
	/** Display label for the column header / settings row. */
	name: string;
};

/** A computed *formula* column's spec (9.12.17 formula half): no backing
 *  entity property — the cell value is an arithmetic expression over the row's
 *  other properties (`{fee} * {quantity}`), evaluated read-only per row. The
 *  expression grammar lives in the Database app's `logic/formula.ts`; this leaf
 *  type stays a plain `expression` string for the same reason `ColumnRollup`
 *  keeps `aggregation` a string. */
export type ColumnFormula = {
	expression: string;
	/** Display label for the column header / settings row. */
	name: string;
};

export type ColumnSpec = {
	propertyId: string;
	width?: number;
	visible: boolean;
	displayOverride?: Record<string, unknown>;
	/** When present, this column is a computed rollup (9.12.17): `propertyId`
	 *  is a synthetic, spec-derived identity (no entity carries it) and the
	 *  cell renders the read-only aggregated value. */
	rollup?: ColumnRollup;
	/** When present, this column is a computed formula (9.12.17): `propertyId`
	 *  is a synthetic, spec-derived identity and the cell renders the read-only
	 *  evaluated expression. */
	formula?: ColumnFormula;
	/** The footer aggregation chosen for this column (9.12.18) — an
	 *  `AggregationKind` value (a plain string, same rationale as
	 *  `ColumnRollup.aggregation`). Absent → the column's type default. */
	aggregation?: string;
	/** Per-VIEW short label (9.12.29) — renames the column header in this view
	 *  only; the property's catalog name is untouched. */
	label?: string;
	/** Compact header (9.12.29): the property-kind glyph instead of the label
	 *  (the label stays the accessible name + tooltip). */
	iconOnly?: boolean;
	/** Per-column text-wrap override (9.12.29). Absent → the view's Wrap
	 *  setting. */
	wrap?: ColumnWrap;
};

/** A column's text-wrap override (9.12.29). */
export enum ColumnWrap {
	Wrap = "wrap",
	NoWrap = "no-wrap",
}

/** Per-kind layout option shapes. Discriminated by `ListView.kind`.
 *
 *  The narrow string-literal sub-fields below (`rowHeight`, `density`,
 *  `thumbnailSize`, …) are deliberately NOT enums: they are not
 *  discriminators (the discriminator is `ListView.kind`, an enum), and
 *  per CLAUDE.md §"Enums, not string constants" pre-existing literal
 *  unions are migrated as adjacent code is touched — enum-ifying them
 *  here would be an unrelated app-wide churn. Wire format is unchanged. */
export type GridLayoutOptions = {
	rowHeight: "compact" | "comfortable" | "tall";
	showRowNumbers: boolean;
	pinFirstColumn: boolean;
	/** Wrap cell content onto multiple lines. Default (false / undefined)
	 *  is single-line with ellipsis. Toggled in view settings. */
	wrap?: boolean;
};

export type ListLayoutOptions = {
	density: "compact" | "comfortable";
	showIcon: boolean;
};

/** Where a gallery card's cover comes from (9.12.31). `Default` keeps the
 *  existing rule (the view's cover property, else the object's own cover). */
export enum GalleryCoverSource {
	Default = "default",
	/** The first image in the object's body. */
	FirstMedia = "first-media",
	/** No cover band at all in this view. */
	None = "none",
}

export type GalleryLayoutOptions = {
	thumbnailSize: "small" | "medium" | "large";
	cardAspectRatio: "square" | "video" | "portrait";
	showFilename: boolean;
	coverSource?: GalleryCoverSource;
	/** Hide the field names on cards — values only (9.12.31). */
	hideFieldLabels?: boolean;
};

/** How a grouped view orders its groups (9.12.28). `Default` = the group
 *  property's option rank, then any manual `groupOrder`; the count modes
 *  sort by how many items each group holds and ignore `groupOrder`. */
export enum GroupOrderMode {
	Default = "default",
	CountDesc = "count-desc",
	CountAsc = "count-asc",
}

export type BoardLayoutOptions = {
	columnWidth: number;
	collapseEmptyColumns: boolean;
	cardPreview: "minimal" | "rich";
	/** User-chosen column order, by group key (the empty string is the
	 *  null / "Uncategorized" group). Keys not listed render after, in
	 *  data order; unknown keys are ignored. Absent → pure data order. */
	groupOrder?: string[];
	/** Horizontal swimlanes (9.12.28): a second property splitting the board
	 *  into rows; each lane holds the full set of columns. Absent / null → one
	 *  unlaned board. */
	swimlaneBy?: string | null;
	/** Group ordering mode (9.12.28). Absent → `GroupOrderMode.Default`. */
	groupOrderMode?: GroupOrderMode;
	/** Column group keys rendered collapsed (same `""` null-key wire form as
	 *  `groupOrder`). */
	collapsedGroups?: string[];
	/** Swimlane keys rendered collapsed. */
	collapsedLanes?: string[];
};

export enum CalendarRange {
	Day = "day",
	Week = "week",
	Month = "month",
	Year = "year",
	Agenda = "agenda",
}

export enum CalendarWeekStart {
	Sunday = "sun",
	Monday = "mon",
}

/** Optional recurrence projection for a calendar view's date property.
 *  `Yearly` = the `primaryDateProperty` is a day-of-year (a birthday /
 *  anniversary): place each row on the *displayed period's* occurrence
 *  of its month-day, not the absolute stored year. Resolves the
 *  9.12.13(b) Birthdays-view gate (OQ-CT-3, jointly with OQ-CAL-2). */
export enum CalendarRecurring {
	Yearly = "yearly",
}

export type CalendarLayoutOptions = {
	range: CalendarRange;
	startWeekOn: CalendarWeekStart;
	/** Property whose date value places a card on the grid (e.g.
	 *  `completedAt`, `dueAt`). Cards whose value is empty/unparseable
	 *  are simply not shown that month. */
	primaryDateProperty: string;
	colorBy: string | null;
	dateRangeStart?: string;
	dateRangeEnd?: string;
	/** When set, the date property is projected as a recurrence rather
	 *  than an absolute instant (e.g. `Yearly` for a Birthdays view). */
	recurring?: CalendarRecurring;
};

/** Timeline density — how items pack vertically within a swimlane. */
export enum TimelineDensity {
	Compact = "compact",
	Comfortable = "comfortable",
}

/** Derived from data + config; not stored on the entity.
 *  See §Timeline. */
export enum TimelineMode {
	Event = "event",
	Span = "span",
	Mixed = "mixed",
}

export type TimelineLayoutOptions = {
	primaryDateProperty: string;
	endDateProperty: string | null;
	swimlaneBy: string | null;
	pxPerDay: number;
	showNow: boolean;
	showWeekends: boolean;
	dependencyLinkTypes: string[];
	showDependencies: boolean;
	density: TimelineDensity;
	colorBy: string | null;
	labelProperty: string | null;
};

/** Chart form (9.12.30). */
export enum ChartType {
	Bar = "bar",
	Line = "line",
	Pie = "pie",
	Number = "number",
}

export type ChartLayoutOptions = {
	chartType: ChartType;
	/** An `AggregationKind` value (plain string, same rationale as
	 *  `ColumnSpec.aggregation`). `countAll` needs no `valueProperty`. */
	aggregation: string;
	/** The property the aggregation reduces; null for a row count. */
	valueProperty: string | null;
	/** Render the accessible data table instead of the plot. */
	showTable?: boolean;
};

export type LayoutOptions =
	| ChartLayoutOptions
	| GridLayoutOptions
	| ListLayoutOptions
	| GalleryLayoutOptions
	| BoardLayoutOptions
	| CalendarLayoutOptions
	| TimelineLayoutOptions;

export type ListView = {
	id: string;
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
	/** Explicit drag-reordered row order (entity ids). When set it wins
	 *  over sorts — the user dragged rows into this order. Ids not listed
	 *  keep their post-sort order, appended after. */
	manualOrder?: string[];
	defaultTypeUrl: string | null;
	defaultTemplate: string | null;
	pageSize: number;
	layoutOptions: LayoutOptions;
};

/** Compiled view filter — what the entities service actually consumes once
 *  the filter tree is flattened. Kept separate from the editable `FilterNode`
 *  tree so the UI can present groups while the service sees a single
 *  predicate. */
export type CompiledViewFilter = PropertyPredicate | null;

// ─── List/v1 — the single canonical Collection entity ───────────────────────

export type List = {
	id: string;
	name: string;
	icon: Icon | null;
	description: string;
	source: ListSource | null;
	members: MemberOverrides;
	views: string[];
	defaultViewId: string | null;
	/** Entity id of this Collection's default `Template/v1` for "+ New", or
	 *  `null`. Second rung of the default-template ladder
	 *  (`view.defaultTemplate → collection.defaultTemplate → type-default →
	 *  blank`); see 66-templates.md. */
	defaultTemplate: string | null;
	/** The shared read-only lock (`properties.locked`), decoded so every
	 *  membership writer can refuse a locked List. Read-side only: the codec
	 *  never writes it back — the lock flips through its own lock-only patch. */
	locked?: true;
	createdAt: number;
	updatedAt: number;
};
