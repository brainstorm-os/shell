/**
 * Per-view settings popover. Anchored under the toolbar "Settings" button.
 *
 * Rather than one long scroll of every control, the popover is a small
 * **navigated panel**: a root page lists the setting categories (View type,
 * Layout, Group / Dates, Properties, Shown objects) as rows that drill into
 * a focused sub-page with a back arrow — the Notion / Anytype shape. View
 * type is itself a sub-page of icon-labelled options.
 *
 * The host re-opens the popover on every `onChange` (to reflect kind-driven
 * section changes), so the active sub-page is held in module state and
 * restored on re-open; a fresh open from the toolbar resets it to the root
 * via `resetViewSettingsPage`.
 *
 * The popover is intentionally a plain DOM panel (per the [[avoid-blocking-
 * on-deps]] memory). State changes flow back to the renderer via
 * `onChange(patch)`; in-page navigation (drill / back) re-renders locally
 * without a host round-trip.
 */

import type { PropertyDef } from "@brainstorm/sdk-types";
import { IconName, createIconElement } from "@brainstorm/sdk/icon";
import { openAnchoredMenu } from "@brainstorm/sdk/object-menu";
import { createSelectMenu } from "@brainstorm/sdk/select-menu";
import {
	ColumnAdderOptionKind,
	appendColumnForProperty,
	buildColumnAdderOptions,
} from "../logic/column-adder";
import {
	FormulaDraftErrorKind,
	type FormulaDraftResult,
	defaultFormulaName,
	validateFormulaDraft,
} from "../logic/formula-author";
import { computePopoverPlacement } from "../logic/popover-placement";
import {
	type RelationCandidate,
	type TargetCandidate,
	buildRollupColumn,
	rollupAggregationOptions,
} from "../logic/rollup-builder";
import type {
	BoardLayoutOptions,
	CalendarLayoutOptions,
	ColumnSpec,
	GalleryLayoutOptions,
	GridLayoutOptions,
	ListLayoutOptions,
	ListView,
	TimelineLayoutOptions,
} from "../types/list-view";
import {
	CalendarRange,
	CalendarWeekStart,
	ListViewKind,
	TimelineDensity,
} from "../types/list-view";
import { humanize } from "./humanize";
import { DatabaseIcon, setIcon, setSharedIcon } from "./icons";
import { type SourceTypeOption, buildTypeChecklist } from "./source-picker";

export type ViewSettingsPatch = Partial<{
	name: string;
	kind: ListViewKind;
	layoutOptions: ListView["layoutOptions"];
	columns: ColumnSpec[];
	/** Board group-by property (or `null` to clear). */
	groupBy: ListView["groupBy"];
	/** Gallery cover property (or `null` for the type-tinted fallback). */
	coverProperty: string | null;
	/** Gallery / board card subtitle property (or `null`). */
	cardSubtitleProperty: string | null;
}>;

export type ViewSettingsProps = {
	view: ListView;
	/** Property keys present on the list's entities but not yet a
	 *  column — offered in the "Add column" picker. */
	availableProperties?: string[];
	/** Vault-catalog `PropertyDef`s — drives the Existing branch of the
	 *  column-adder (9.3.5.U.b). Empty / omitted means the picker only
	 *  surfaces data-derived properties + the Create-new option. */
	vaultProperties?: ReadonlyArray<PropertyDef>;
	/** Host hook invoked when the user picks "+ Create new property"
	 *  in the column-adder. The app opens the shared
	 *  `<InlinePropertyForm>` via `openInlinePropertyForm`, persists
	 *  the result via `services.properties`, and then drives the column
	 *  attachment via `onChange({columns: ...})`. Omitted → the
	 *  "Create new" option is hidden (legacy column-add only). */
	onCreateProperty?: (seedName: string) => void;
	/** Host hook for "+ Add collection property" — present only for collections
	 *  you can manually add members to. Creates a list-scoped property every
	 *  member inherits (surfaced in inspectors), not a view column. */
	onCreateCollectionProperty?: () => void;
	/** Rollup creation (9.12.17). Present only when the list has ≥1 relation
	 *  to roll up across; drives the relation → target-property → aggregation
	 *  picker on the Properties page and appends the resulting computed column. */
	rollup?: {
		relations: ReadonlyArray<RelationCandidate>;
		targetsFor: (relationKey: string) => ReadonlyArray<TargetCandidate>;
		onAdd: (column: ColumnSpec) => void;
	};
	/** Formula creation (9.12.17 — formula slice-2 creation flow). Drives the
	 *  "Add formula…" authoring page: a free-text arithmetic expression over the
	 *  row's other properties plus an optional name. `onAdd` appends the built
	 *  computed column. Omitted → the affordance is hidden. */
	formula?: {
		onAdd: (column: ColumnSpec) => void;
	};
	/** Distinct object types in the vault — the option set for the "Shown
	 *  objects" section. Omitted (or empty) hides the section. */
	availableTypes?: ReadonlyArray<SourceTypeOption>;
	/** The list's currently-selected `ByType` types. */
	listSourceTypes?: ReadonlyArray<string>;
	/** Whether the list's source can be edited inline here — only the
	 *  `ByType` / empty source is editable; link / vocabulary / composite
	 *  sources are surfaced read-only. */
	sourceEditable?: boolean;
	/** Live-applies a new type set to the list's source. */
	onChangeSource?: (types: string[]) => void;
	onChange: (patch: ViewSettingsPatch) => void;
	onClose: () => void;
};

/** The synthetic Name/title column id (mirrors `grid-view`'s `TITLE_COL`).
 *  The title column is the collection's identity — never removable. */
const TITLE_COLUMN_ID = "__title__";

/** The drill-down pages the popover can show. Held in module state (not a
 *  closure) so the page survives the host's re-open-on-`onChange`. */
enum SettingsPage {
	Root = "root",
	ViewType = "view-type",
	Layout = "layout",
	Grouping = "grouping",
	Properties = "properties",
	Formula = "formula",
	ShownObjects = "shown-objects",
}

const VIEW_KIND_META: ReadonlyArray<[ListViewKind, string, DatabaseIcon]> = [
	[ListViewKind.Grid, "Grid", DatabaseIcon.Grid],
	[ListViewKind.List, "List", DatabaseIcon.List],
	[ListViewKind.Gallery, "Gallery", DatabaseIcon.Gallery],
	[ListViewKind.Board, "Board", DatabaseIcon.Board],
	[ListViewKind.Calendar, "Calendar", DatabaseIcon.Calendar],
	[ListViewKind.Timeline, "Timeline", DatabaseIcon.Timeline],
];

function viewKindLabel(kind: ListViewKind): string {
	return VIEW_KIND_META.find((m) => m[0] === kind)?.[1] ?? kind;
}

function viewKindIcon(kind: ListViewKind): DatabaseIcon {
	return VIEW_KIND_META.find((m) => m[0] === kind)?.[2] ?? DatabaseIcon.Grid;
}

let activePage: SettingsPage = SettingsPage.Root;
/** The in-progress formula draft, held in module state so it survives the
 *  host's re-open-on-`onChange` (same rationale as `activePage`). Reset on a
 *  successful add and on a fresh open from the toolbar. */
let formulaDraft = { expression: "", name: "" };
let openPopover: HTMLElement | null = null;
let openCleanup: (() => void) | null = null;
let currentProps: ViewSettingsProps | null = null;
let currentAnchor: HTMLElement | null = null;

/** Reset to the root page. Called by the host on a *fresh* open from the
 *  toolbar so settings always start at the top level; the re-open-on-change
 *  path deliberately skips this so the user stays on their sub-page. */
export function resetViewSettingsPage(): void {
	activePage = SettingsPage.Root;
	formulaDraft = { expression: "", name: "" };
}

export function closeViewSettings(): void {
	if (openCleanup) openCleanup();
	openCleanup = null;
	openPopover?.remove();
	openPopover = null;
	currentProps = null;
	// Drop the trigger's open/active state (mirrors the fancy-menus anchor
	// behaviour the filter/sort buttons get for free).
	currentAnchor?.removeAttribute("aria-expanded");
	currentAnchor = null;
}

export function openViewSettings(anchor: HTMLElement, props: ViewSettingsProps): void {
	closeViewSettings();

	const backdrop = document.createElement("div");
	backdrop.className = "db-popover__backdrop";
	const popover = document.createElement("div");
	popover.className = "db-popover glass--strong";
	popover.setAttribute("role", "dialog");
	popover.setAttribute("aria-label", "View settings");

	const header = document.createElement("header");
	header.className = "db-popover__header";
	popover.appendChild(header);

	const body = document.createElement("div");
	body.className = "db-popover__body";
	popover.appendChild(body);

	document.body.appendChild(backdrop);
	document.body.appendChild(popover);

	openPopover = popover;
	currentProps = props;
	currentAnchor = anchor;
	anchor.setAttribute("aria-expanded", "true");
	renderPage();

	backdrop.addEventListener("click", () => props.onClose());

	const keyListener = (event: KeyboardEvent): void => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		// Escape steps back out of a sub-page first, then closes from the root —
		// so deep settings don't dump the user out in one keystroke.
		if (activePage === SettingsPage.Root) {
			props.onClose();
		} else {
			navigate(parentPage(activePage));
		}
	};
	document.addEventListener("keydown", keyListener);

	const reposition = (): void => positionPopover(anchor, popover);
	window.addEventListener("resize", reposition);
	window.addEventListener("scroll", reposition, true);

	openCleanup = () => {
		document.removeEventListener("keydown", keyListener);
		window.removeEventListener("resize", reposition);
		window.removeEventListener("scroll", reposition, true);
		backdrop.remove();
	};
}

/** Local navigation — swap the page and re-render in place (no host
 *  round-trip). Re-positions because the panel height changes per page. */
function navigate(page: SettingsPage): void {
	activePage = page;
	renderPage();
}

function positionPopover(anchor: HTMLElement, popover: HTMLElement): void {
	const rect = anchor.getBoundingClientRect();
	const width = 320;
	popover.style.width = `${width}px`;
	const placement = computePopoverPlacement(
		{ top: rect.top, bottom: rect.bottom, right: rect.right },
		{ width: window.innerWidth, height: window.innerHeight },
		{ width, margin: 8, minHeight: 160 },
	);
	popover.style.left = `${placement.left}px`;
	popover.style.top = placement.top === null ? "auto" : `${placement.top}px`;
	popover.style.bottom = placement.bottom === null ? "auto" : `${placement.bottom}px`;
	// Clamp to the room on the chosen side so the panel — and the bottom of its
	// own scroll area — always sits inside the viewport (F-015).
	popover.style.maxHeight = `${placement.maxHeight}px`;
}

/** True when `page` has content worth showing for the current view (e.g.
 *  Grouping only exists for board/calendar/timeline). Drives both the root
 *  row list and the restore-after-reopen fallback. */
function pageAvailable(page: SettingsPage, props: ViewSettingsProps): boolean {
	switch (page) {
		case SettingsPage.Root:
		case SettingsPage.ViewType:
		case SettingsPage.Layout:
			return true;
		case SettingsPage.Grouping:
			return groupingApplies(props.view.kind);
		case SettingsPage.Properties:
			return (
				props.view.columns.length > 0 ||
				Boolean(props.onCreateProperty) ||
				Boolean(props.rollup) ||
				Boolean(props.formula)
			);
		case SettingsPage.Formula:
			return Boolean(props.formula);
		case SettingsPage.ShownObjects:
			return (props.availableTypes?.length ?? 0) > 0 && Boolean(props.onChangeSource);
	}
}

/** The page a sub-page's back arrow / Escape returns to. Most pages return to
 *  the root; the Formula authoring page is a child of Properties, so it steps
 *  back there. */
function parentPage(page: SettingsPage): SettingsPage {
	return page === SettingsPage.Formula ? SettingsPage.Properties : SettingsPage.Root;
}

function groupingApplies(kind: ListViewKind): boolean {
	return (
		kind === ListViewKind.Board || kind === ListViewKind.Calendar || kind === ListViewKind.Timeline
	);
}

function pageTitle(page: SettingsPage, props: ViewSettingsProps): string {
	switch (page) {
		case SettingsPage.Root:
			return `${props.view.name} settings`;
		case SettingsPage.ViewType:
			return "View type";
		case SettingsPage.Layout:
			return layoutPageLabel(props.view.kind);
		case SettingsPage.Grouping:
			return groupingPageLabel(props.view.kind);
		case SettingsPage.Properties:
			return "Properties";
		case SettingsPage.Formula:
			return "New formula";
		case SettingsPage.ShownObjects:
			return "Shown objects";
	}
}

function layoutPageLabel(kind: ListViewKind): string {
	if (kind === ListViewKind.Gallery) return "Cards";
	if (kind === ListViewKind.Calendar) return "Calendar";
	if (kind === ListViewKind.Timeline) return "Timeline";
	return "Layout";
}

function groupingPageLabel(kind: ListViewKind): string {
	if (kind === ListViewKind.Board) return "Grouping";
	return "Dates";
}

function renderPage(): void {
	const popover = openPopover;
	const props = currentProps;
	if (!popover || !props) return;
	const header = popover.querySelector<HTMLElement>(".db-popover__header");
	const body = popover.querySelector<HTMLElement>(".db-popover__body");
	if (!header || !body) return;

	// Restore to the root if a remembered sub-page no longer applies (e.g. the
	// kind switched away from board while sitting on the Grouping page).
	if (!pageAvailable(activePage, props)) activePage = SettingsPage.Root;
	const page = activePage;

	header.replaceChildren();
	if (page !== SettingsPage.Root) {
		const back = document.createElement("button");
		back.type = "button";
		back.className = "db-popover__back";
		back.setAttribute("aria-label", "Back");
		setSharedIcon(back, IconName.CaretLeft);
		back.addEventListener("click", () => navigate(parentPage(page)));
		header.appendChild(back);
	}
	const title = document.createElement("h3");
	title.className = "db-popover__title";
	title.textContent = pageTitle(page, props);
	header.appendChild(title);
	const close = document.createElement("button");
	close.type = "button";
	close.className = "db-popover__close";
	close.setAttribute("aria-label", "Close settings");
	setSharedIcon(close, IconName.Close);
	close.addEventListener("click", () => props.onClose());
	header.appendChild(close);

	body.replaceChildren();
	body.dataset.page = page;
	switch (page) {
		case SettingsPage.Root:
			renderRoot(body, props);
			break;
		case SettingsPage.ViewType:
			renderViewTypePage(body, props);
			break;
		case SettingsPage.Layout:
			renderLayoutPage(body, props);
			break;
		case SettingsPage.Grouping:
			renderGroupingPage(body, props);
			break;
		case SettingsPage.Properties:
			renderPropertiesPage(body, props);
			break;
		case SettingsPage.Formula:
			renderFormulaPage(body, props);
			break;
		case SettingsPage.ShownObjects:
			renderShownObjectsPage(body, props);
			break;
	}

	if (currentAnchor) positionPopover(currentAnchor, popover);
}

// ─── Root page ─────────────────────────────────────────────────────────────

function renderRoot(body: HTMLElement, props: ViewSettingsProps): void {
	const view = props.view;

	// View name — quick-access inline at the top of the root. Commits on
	// blur / Enter (not per-keystroke) so the popover doesn't re-render
	// mid-edit.
	const nameSection = document.createElement("section");
	nameSection.className = "db-popover__section db-popover__section--name";
	const nameLabel = document.createElement("label");
	nameLabel.className = "db-popover__field";
	const nameText = document.createElement("span");
	nameText.className = "db-popover__field-label";
	nameText.textContent = "View name";
	const nameInput = document.createElement("input");
	nameInput.type = "text";
	nameInput.className = "db-popover__input";
	nameInput.value = view.name;
	const commitName = (): void => {
		const next = nameInput.value.trim();
		if (next && next !== view.name) props.onChange({ name: next });
	};
	nameInput.addEventListener("change", commitName);
	nameInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			commitName();
		}
	});
	nameLabel.append(nameText, nameInput);
	nameSection.appendChild(nameLabel);
	body.appendChild(nameSection);

	const nav = document.createElement("div");
	nav.className = "db-popover__nav";

	nav.appendChild(
		navRow({
			icon: viewKindIcon(view.kind),
			label: "View type",
			value: viewKindLabel(view.kind),
			onClick: () => navigate(SettingsPage.ViewType),
		}),
	);

	nav.appendChild(
		navRow({
			icon: IconName.Settings,
			label: layoutPageLabel(view.kind),
			onClick: () => navigate(SettingsPage.Layout),
		}),
	);

	if (pageAvailable(SettingsPage.Grouping, props)) {
		nav.appendChild(
			navRow({
				icon: view.kind === ListViewKind.Board ? DatabaseIcon.Board : DatabaseIcon.Calendar,
				label: groupingPageLabel(view.kind),
				onClick: () => navigate(SettingsPage.Grouping),
			}),
		);
	}

	if (pageAvailable(SettingsPage.Properties, props)) {
		const visible = view.columns.filter((c) => c.visible !== false).length;
		const count = view.columns.length > 0 ? `${visible}/${view.columns.length}` : undefined;
		nav.appendChild(
			navRow({
				icon: DatabaseIcon.List,
				label: "Properties",
				...(count ? { value: count } : {}),
				onClick: () => navigate(SettingsPage.Properties),
			}),
		);
	}

	if (pageAvailable(SettingsPage.ShownObjects, props)) {
		nav.appendChild(
			navRow({
				icon: DatabaseIcon.Database,
				label: "Shown objects",
				onClick: () => navigate(SettingsPage.ShownObjects),
			}),
		);
	}

	body.appendChild(nav);
}

/** Paint either a Database-local view-kind glyph or a shared SDK glyph into a
 *  host, so nav / option rows can carry whichever the registry provides. */
function setRowIcon(host: Element, glyph: DatabaseIcon | IconName): void {
	if (isDatabaseIcon(glyph)) setIcon(host, glyph);
	else setSharedIcon(host, glyph);
}

function isDatabaseIcon(glyph: DatabaseIcon | IconName): glyph is DatabaseIcon {
	return (Object.values(DatabaseIcon) as string[]).includes(glyph);
}

function navRow(opts: {
	icon?: DatabaseIcon | IconName;
	label: string;
	value?: string;
	onClick: () => void;
}): HTMLElement {
	const row = document.createElement("button");
	row.type = "button";
	row.className = "db-popover__nav-row";
	row.setAttribute("aria-haspopup", "true");

	if (opts.icon) {
		const icon = document.createElement("span");
		icon.className = "db-popover__nav-icon";
		icon.setAttribute("aria-hidden", "true");
		setRowIcon(icon, opts.icon);
		row.appendChild(icon);
	}

	const label = document.createElement("span");
	label.className = "db-popover__nav-label";
	label.textContent = opts.label;
	row.appendChild(label);

	if (opts.value) {
		const value = document.createElement("span");
		value.className = "db-popover__nav-value";
		value.textContent = opts.value;
		row.appendChild(value);
	}

	const chevron = document.createElement("span");
	chevron.className = "db-popover__nav-chevron";
	chevron.setAttribute("aria-hidden", "true");
	setSharedIcon(chevron, IconName.CaretRight);
	row.appendChild(chevron);

	row.addEventListener("click", opts.onClick);
	return row;
}

// ─── View-type page ──────────────────────────────────────────────────────────

function renderViewTypePage(body: HTMLElement, props: ViewSettingsProps): void {
	const list = document.createElement("div");
	list.className = "db-popover__options";
	for (const [kind, label, icon] of VIEW_KIND_META) {
		list.appendChild(
			optionRow({
				icon,
				label,
				selected: props.view.kind === kind,
				onClick: () => {
					if (kind !== props.view.kind) props.onChange({ kind });
				},
			}),
		);
	}
	body.appendChild(list);
}

function optionRow(opts: {
	icon?: DatabaseIcon;
	label: string;
	selected: boolean;
	onClick: () => void;
}): HTMLElement {
	const row = document.createElement("button");
	row.type = "button";
	row.className = "db-popover__option";
	row.dataset.selected = String(opts.selected);
	row.setAttribute("aria-pressed", String(opts.selected));

	if (opts.icon) {
		const icon = document.createElement("span");
		icon.className = "db-popover__option-icon";
		icon.setAttribute("aria-hidden", "true");
		setIcon(icon, opts.icon);
		row.appendChild(icon);
	}

	const label = document.createElement("span");
	label.className = "db-popover__option-label";
	label.textContent = opts.label;
	row.appendChild(label);

	const check = document.createElement("span");
	check.className = "db-popover__option-check";
	check.setAttribute("aria-hidden", "true");
	if (opts.selected) setSharedIcon(check, IconName.Check);
	row.appendChild(check);

	row.addEventListener("click", opts.onClick);
	return row;
}

// ─── Layout page (kind-specific) ─────────────────────────────────────────────

function renderLayoutPage(body: HTMLElement, props: ViewSettingsProps): void {
	const view = props.view;
	const rows = document.createElement("div");
	rows.className = "db-popover__rows";
	switch (view.kind) {
		case ListViewKind.Grid:
			gridControls(rows, view.layoutOptions as GridLayoutOptions, (p) =>
				props.onChange({ layoutOptions: { ...(view.layoutOptions as GridLayoutOptions), ...p } }),
			);
			break;
		case ListViewKind.List:
			listControls(rows, view.layoutOptions as ListLayoutOptions, (p) =>
				props.onChange({ layoutOptions: { ...(view.layoutOptions as ListLayoutOptions), ...p } }),
			);
			break;
		case ListViewKind.Gallery:
			galleryControls(rows, props);
			break;
		case ListViewKind.Board:
			boardControls(rows, view.layoutOptions as BoardLayoutOptions, (p) =>
				props.onChange({ layoutOptions: { ...(view.layoutOptions as BoardLayoutOptions), ...p } }),
			);
			break;
		case ListViewKind.Calendar:
			calendarControls(rows, view.layoutOptions as CalendarLayoutOptions, (p) =>
				props.onChange({ layoutOptions: { ...(view.layoutOptions as CalendarLayoutOptions), ...p } }),
			);
			break;
		case ListViewKind.Timeline:
			timelineControls(rows, view.layoutOptions as TimelineLayoutOptions, (p) =>
				props.onChange({ layoutOptions: { ...(view.layoutOptions as TimelineLayoutOptions), ...p } }),
			);
			break;
	}
	body.appendChild(rows);
}

function gridControls(
	rows: HTMLElement,
	layout: GridLayoutOptions,
	patch: (p: Partial<GridLayoutOptions>) => void,
): void {
	rows.appendChild(
		segmented(
			"Row height",
			[
				["compact", "Compact"],
				["comfortable", "Normal"],
				["tall", "Tall"],
			],
			layout.rowHeight,
			(v) => patch({ rowHeight: v as GridLayoutOptions["rowHeight"] }),
		),
	);
	rows.appendChild(
		toggleRow("Row numbers", layout.showRowNumbers, (v) => patch({ showRowNumbers: v })),
	);
	rows.appendChild(
		toggleRow("Pin first column", layout.pinFirstColumn, (v) => patch({ pinFirstColumn: v })),
	);
	rows.appendChild(toggleRow("Wrap text", layout.wrap ?? false, (v) => patch({ wrap: v })));
}

function listControls(
	rows: HTMLElement,
	layout: ListLayoutOptions,
	patch: (p: Partial<ListLayoutOptions>) => void,
): void {
	rows.appendChild(
		segmented(
			"Density",
			[
				["compact", "Compact"],
				["comfortable", "Comfortable"],
			],
			layout.density,
			(v) => patch({ density: v as ListLayoutOptions["density"] }),
		),
	);
	rows.appendChild(toggleRow("Show type icon", layout.showIcon, (v) => patch({ showIcon: v })));
}

function galleryControls(rows: HTMLElement, props: ViewSettingsProps): void {
	const view = props.view;
	const layout = view.layoutOptions as GalleryLayoutOptions;
	const patch = (p: Partial<GalleryLayoutOptions>): void =>
		props.onChange({ layoutOptions: { ...layout, ...p } });
	const propOpts = propertyOptions(props.availableProperties ?? [], true, nameMap(props));

	rows.appendChild(
		segmented(
			"Size",
			[
				["small", "S"],
				["medium", "M"],
				["large", "L"],
			],
			layout.thumbnailSize,
			(v) => patch({ thumbnailSize: v as GalleryLayoutOptions["thumbnailSize"] }),
		),
	);
	rows.appendChild(
		segmented(
			"Aspect",
			[
				["square", "1:1"],
				["video", "16:9"],
				["portrait", "3:4"],
			],
			layout.cardAspectRatio,
			(v) => patch({ cardAspectRatio: v as GalleryLayoutOptions["cardAspectRatio"] }),
		),
	);
	rows.appendChild(
		selectRow("Cover", propOpts, view.coverProperty ?? "", (v) =>
			props.onChange({ coverProperty: v || null }),
		),
	);
	rows.appendChild(
		selectRow("Subtitle", propOpts, view.cardSubtitleProperty ?? "", (v) =>
			props.onChange({ cardSubtitleProperty: v || null }),
		),
	);
}

function boardControls(
	rows: HTMLElement,
	layout: BoardLayoutOptions,
	patch: (p: Partial<BoardLayoutOptions>) => void,
): void {
	rows.appendChild(
		segmented(
			"Card",
			[
				["minimal", "Minimal"],
				["rich", "Rich"],
			],
			layout.cardPreview,
			(v) => patch({ cardPreview: v as BoardLayoutOptions["cardPreview"] }),
		),
	);
	rows.appendChild(
		sliderRow("Column width", layout.columnWidth, 220, 380, 20, (v) => patch({ columnWidth: v })),
	);
	rows.appendChild(
		toggleRow("Collapse empty columns", layout.collapseEmptyColumns, (v) =>
			patch({ collapseEmptyColumns: v }),
		),
	);
}

function calendarControls(
	rows: HTMLElement,
	layout: CalendarLayoutOptions,
	patch: (p: Partial<CalendarLayoutOptions>) => void,
): void {
	rows.appendChild(
		segmented(
			"Range",
			[
				[CalendarRange.Week, "Week"],
				[CalendarRange.Month, "Month"],
				[CalendarRange.Year, "Year"],
			],
			layout.range,
			(v) => patch({ range: v as CalendarRange }),
		),
	);
	rows.appendChild(
		segmented(
			"Week starts",
			[
				[CalendarWeekStart.Sunday, "Sun"],
				[CalendarWeekStart.Monday, "Mon"],
			],
			layout.startWeekOn,
			(v) => patch({ startWeekOn: v as CalendarWeekStart }),
		),
	);
}

function timelineControls(
	rows: HTMLElement,
	layout: TimelineLayoutOptions,
	patch: (p: Partial<TimelineLayoutOptions>) => void,
): void {
	rows.appendChild(
		sliderRow("Zoom (px / day)", layout.pxPerDay, 4, 320, 4, (v) => patch({ pxPerDay: v })),
	);
	rows.appendChild(toggleRow('Show "Now" line', layout.showNow, (v) => patch({ showNow: v })));
	rows.appendChild(
		toggleRow("Show weekends", layout.showWeekends, (v) => patch({ showWeekends: v })),
	);
	// 9.12.10 — arrows draw for the layout's `dependencyLinkTypes` (a
	// data-configured allow-list); the toggle only controls visibility.
	rows.appendChild(
		toggleRow("Show dependencies", layout.showDependencies, (v) => patch({ showDependencies: v })),
	);
	rows.appendChild(
		segmented(
			"Density",
			[
				[TimelineDensity.Compact, "Compact"],
				[TimelineDensity.Comfortable, "Comfortable"],
			],
			layout.density,
			(v) => patch({ density: v as TimelineDensity }),
		),
	);
}

// ─── Grouping / Dates page ───────────────────────────────────────────────────

function renderGroupingPage(body: HTMLElement, props: ViewSettingsProps): void {
	const view = props.view;
	const keys = props.availableProperties ?? [];
	const names = nameMap(props);
	const rows = document.createElement("div");
	rows.className = "db-popover__rows";

	if (view.kind === ListViewKind.Board) {
		rows.appendChild(
			selectRow("Group by", propertyOptions(keys, true, names), view.groupBy?.propertyId ?? "", (v) =>
				props.onChange({ groupBy: v ? { propertyId: v } : null }),
			),
		);
	} else if (view.kind === ListViewKind.Calendar) {
		const layout = view.layoutOptions as CalendarLayoutOptions;
		rows.appendChild(
			selectRow(
				"Place on",
				propertyOptions(keys, false, names),
				layout.primaryDateProperty ?? "",
				(v) => props.onChange({ layoutOptions: { ...layout, primaryDateProperty: v } }),
			),
		);
	} else if (view.kind === ListViewKind.Timeline) {
		const layout = view.layoutOptions as TimelineLayoutOptions;
		rows.appendChild(
			selectRow("Start", propertyOptions(keys, false, names), layout.primaryDateProperty ?? "", (v) =>
				props.onChange({ layoutOptions: { ...layout, primaryDateProperty: v } }),
			),
		);
		rows.appendChild(
			selectRow("End", propertyOptions(keys, true, names), layout.endDateProperty ?? "", (v) =>
				props.onChange({ layoutOptions: { ...layout, endDateProperty: v || null } }),
			),
		);
	}
	body.appendChild(rows);
}

// ─── Properties (columns) page ───────────────────────────────────────────────

function renderPropertiesPage(body: HTMLElement, props: ViewSettingsProps): void {
	renderColumns(
		body,
		props.view.columns,
		(cols) => props.onChange({ columns: cols }),
		props.availableProperties ?? [],
		props.vaultProperties ?? [],
		props.onCreateProperty,
	);

	// "Add rollup…" — a computed column aggregating a property of the row's
	// related entities (9.12.17). Only when the list actually has a relation.
	const rollup = props.rollup;
	if (rollup && rollup.relations.length > 0) {
		const adderBtn = document.createElement("button");
		adderBtn.type = "button";
		adderBtn.className = "db-popover__add-column";
		adderBtn.dataset.testid = "db-view-settings-add-rollup";
		adderBtn.setAttribute("aria-haspopup", "menu");
		adderBtn.textContent = "Add rollup…";
		adderBtn.addEventListener("click", () => openRollupRelationPicker(adderBtn, rollup));
		body.appendChild(adderBtn);
	}

	// "Add formula…" — a computed column whose value is an arithmetic expression
	// over the row's other properties (9.12.17). Drills into a focused authoring
	// sub-page (free-text expression needs a form, not a menu).
	if (props.formula) {
		const formulaBtn = document.createElement("button");
		formulaBtn.type = "button";
		formulaBtn.className = "db-popover__add-column";
		formulaBtn.dataset.testid = "db-view-settings-add-formula";
		formulaBtn.textContent = "Add formula…";
		formulaBtn.addEventListener("click", () => navigate(SettingsPage.Formula));
		body.appendChild(formulaBtn);
	}

	// "Add collection property…" — a property scoped to this collection that
	// every member inherits (surfaced in member inspectors, not as a column).
	if (props.onCreateCollectionProperty) {
		const collBtn = document.createElement("button");
		collBtn.type = "button";
		collBtn.className = "db-popover__add-column";
		collBtn.dataset.testid = "db-view-settings-add-collection-property";
		collBtn.textContent = "Add collection property…";
		collBtn.addEventListener("click", () => props.onCreateCollectionProperty?.());
		body.appendChild(collBtn);
	}
}

// ─── Formula authoring page ──────────────────────────────────────────────────

function renderFormulaPage(body: HTMLElement, props: ViewSettingsProps): void {
	const formula = props.formula;
	if (!formula) return;

	const availableKeys = props.availableProperties ?? [];
	const nameByKey = nameMap(props);

	const rows = document.createElement("div");
	rows.className = "db-popover__rows";

	// Expression field.
	const exprField = document.createElement("label");
	exprField.className = "db-popover__field";
	const exprLabel = document.createElement("span");
	exprLabel.className = "db-popover__field-label";
	exprLabel.textContent = "Formula";
	const exprInput = document.createElement("input");
	exprInput.type = "text";
	exprInput.className = "db-popover__input db-popover__input--mono";
	exprInput.placeholder = "{fee} * {quantity}";
	exprInput.value = formulaDraft.expression;
	exprInput.dataset.testid = "db-formula-expression";
	exprInput.setAttribute("aria-label", "Formula expression");
	exprField.append(exprLabel, exprInput);
	rows.appendChild(exprField);

	// "+ Insert property" — a fancy-menus picker of the list's properties; the
	// chosen key is inserted as a `{key}` reference at the caret. Shown only when
	// there are properties to reference.
	if (availableKeys.length > 0) {
		const insertBtn = document.createElement("button");
		insertBtn.type = "button";
		insertBtn.className = "db-popover__formula-insert";
		insertBtn.dataset.testid = "db-formula-insert-property";
		insertBtn.setAttribute("aria-haspopup", "menu");
		insertBtn.textContent = "+ Insert property";
		insertBtn.addEventListener("click", () => {
			const items = availableKeys.map((key) => ({
				label: nameByKey.get(key)?.trim() ? (nameByKey.get(key) as string) : humanize(key),
				onSelect: () => {
					insertReference(exprInput, key);
					formulaDraft = { ...formulaDraft, expression: exprInput.value };
					validate();
				},
			}));
			openAnchoredMenu(anchorPoint(insertBtn), items, {
				menuLabel: "Insert property reference",
				anchor: insertBtn,
			});
		});
		rows.appendChild(insertBtn);
	}

	// Name field (optional — blank uses the expression as the name).
	const nameField = document.createElement("label");
	nameField.className = "db-popover__field";
	const nameLabel = document.createElement("span");
	nameLabel.className = "db-popover__field-label";
	nameLabel.textContent = "Name";
	const nameInput = document.createElement("input");
	nameInput.type = "text";
	nameInput.className = "db-popover__input";
	nameInput.value = formulaDraft.name;
	nameInput.dataset.testid = "db-formula-name";
	nameInput.setAttribute("aria-label", "Formula name");
	nameField.append(nameLabel, nameInput);
	rows.appendChild(nameField);

	// Inline validation message (error / unknown-reference warning).
	const message = document.createElement("p");
	message.className = "db-popover__formula-message";
	message.dataset.testid = "db-formula-message";
	message.hidden = true;
	rows.appendChild(message);

	const addBtn = document.createElement("button");
	addBtn.type = "button";
	addBtn.className = "db-popover__formula-add";
	addBtn.dataset.testid = "db-formula-submit";
	addBtn.textContent = "Add formula";
	rows.appendChild(addBtn);

	body.appendChild(rows);

	const clearMessage = (): void => {
		message.hidden = true;
		message.textContent = "";
		message.removeAttribute("data-kind");
	};
	const setMessage = (result: FormulaDraftResult): void => {
		if (result.ok) {
			clearMessage();
			return;
		}
		message.hidden = false;
		message.textContent = result.message;
		message.dataset.kind = result.kind;
	};

	const validate = (): void => {
		nameInput.placeholder = defaultFormulaName(exprInput.value.trim() || "formula");
		const result = validateFormulaDraft(
			{ expression: exprInput.value, name: nameInput.value },
			availableKeys,
		);
		// Don't nag about an empty expression before the user has typed — only a
		// real syntax / unknown-ref result shows inline; the empty case surfaces on
		// a submit attempt. Syntax + empty are blocking; unknown-ref is recoverable.
		if (result.ok || result.kind === FormulaDraftErrorKind.Empty) clearMessage();
		else setMessage(result);
		addBtn.disabled = !result.ok && result.kind === FormulaDraftErrorKind.Syntax;
	};

	exprInput.addEventListener("input", () => {
		formulaDraft = { ...formulaDraft, expression: exprInput.value };
		validate();
	});
	nameInput.addEventListener("input", () => {
		formulaDraft = { ...formulaDraft, name: nameInput.value };
	});

	const submit = (): void => {
		const draft = { expression: exprInput.value, name: nameInput.value };
		const result = validateFormulaDraft(draft, availableKeys);
		// Empty / syntax errors block the add; surface them and stay on the page.
		if (!result.ok && result.kind !== FormulaDraftErrorKind.UnknownReference) {
			setMessage(result);
			return;
		}
		// `UnknownReference` is recoverable — the engine compiled the expression,
		// the property just isn't on any row yet. Treat the flagged refs as known
		// so the builder runs and the author can add the column ahead of the data.
		const built = result.ok
			? result
			: validateFormulaDraft(draft, [...availableKeys, ...(result.unknownRefs ?? [])]);
		if (!built.ok) {
			setMessage(built);
			return;
		}
		formula.onAdd(built.column);
		formulaDraft = { expression: "", name: "" };
		navigate(SettingsPage.Properties);
	};
	addBtn.addEventListener("click", submit);
	exprInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			submit();
		}
	});

	validate();
	exprInput.focus();
}

/** Insert a `{key}` reference at the input's caret (or append when no
 *  selection), keeping focus + caret after the inserted text. */
function insertReference(input: HTMLInputElement, key: string): void {
	const ref = `{${key}}`;
	const start = input.selectionStart ?? input.value.length;
	const end = input.selectionEnd ?? input.value.length;
	input.value = input.value.slice(0, start) + ref + input.value.slice(end);
	const caret = start + ref.length;
	input.setSelectionRange(caret, caret);
	input.focus();
}

type RollupHost = NonNullable<ViewSettingsProps["rollup"]>;

/** Anchored point just below the trigger button — shared by the three rollup
 *  picker steps. */
function anchorPoint(anchor: HTMLElement): { x: number; y: number } {
	const rect = anchor.getBoundingClientRect();
	return { x: rect.left, y: rect.bottom + 4 };
}

/** Step 1 — which relation to roll up across. */
function openRollupRelationPicker(anchor: HTMLElement, rollup: RollupHost): void {
	const items = rollup.relations.map((relation) => ({
		label: relation.name,
		onSelect: () => openRollupTargetPicker(anchor, rollup, relation),
	}));
	openAnchoredMenu(anchorPoint(anchor), items, { menuLabel: "Roll up which relation?", anchor });
}

/** Step 2 — which property of the related entities to aggregate. */
function openRollupTargetPicker(
	anchor: HTMLElement,
	rollup: RollupHost,
	relation: RelationCandidate,
): void {
	const targets = rollup.targetsFor(relation.key);
	if (targets.length === 0) return;
	const items = targets.map((target) => ({
		label: target.name,
		onSelect: () => openRollupAggregationPicker(anchor, rollup, relation, target),
	}));
	openAnchoredMenu(anchorPoint(anchor), items, {
		menuLabel: `Aggregate which property of ${relation.name}?`,
		anchor,
	});
}

/** Step 3 — which aggregation; commits the new column. */
function openRollupAggregationPicker(
	anchor: HTMLElement,
	rollup: RollupHost,
	relation: RelationCandidate,
	target: TargetCandidate,
): void {
	const items = rollupAggregationOptions(target.valueType).map((option) => ({
		label: option.label,
		onSelect: () =>
			rollup.onAdd(
				buildRollupColumn({
					relationKey: relation.key,
					targetPropertyKey: target.key,
					targetName: target.name,
					aggregation: option.kind,
				}),
			),
	}));
	openAnchoredMenu(anchorPoint(anchor), items, { menuLabel: "Aggregate how?", anchor });
}

function renderColumns(
	body: HTMLElement,
	columns: ColumnSpec[],
	onChange: (next: ColumnSpec[]) => void,
	available: string[],
	vaultProperties: ReadonlyArray<PropertyDef>,
	onCreateProperty: ((seedName: string) => void) | undefined,
): void {
	// A user-created property has a generated key (`prop_<…>`) but a real display
	// name in the catalog — show the name, not "Prop Mpx6xww2 2vzk7i" (F-017,
	// view-settings surface). Mirrors the grid header + inspector.
	const nameByKey = new Map(vaultProperties.map((d) => [d.key, d.name]));

	const list = document.createElement("ul");
	list.className = "db-popover__column-list";

	columns.forEach((column, index) => {
		const li = document.createElement("li");
		li.className = "db-popover__column-row";
		li.draggable = true;
		li.dataset.index = String(index);

		const handle = document.createElement("span");
		handle.className = "db-popover__column-handle";
		handle.setAttribute("aria-hidden", "true");
		handle.appendChild(createIconElement(IconName.DragHandle, { size: 16 }));
		li.appendChild(handle);

		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.className = "db-popover__column-toggle";
		checkbox.checked = column.visible !== false;
		checkbox.addEventListener("change", () => {
			const next = columns.map((c, i) => (i === index ? { ...c, visible: checkbox.checked } : c));
			onChange(next);
		});
		li.appendChild(checkbox);

		const label = document.createElement("span");
		label.className = "db-popover__column-name";
		const defName = column.rollup?.name ?? nameByKey.get(column.propertyId);
		label.textContent = defName?.trim() ? defName : humanize(column.propertyId);
		li.appendChild(label);

		// Remove the column from this collection (F-022). Drops it from the
		// view's columns only — the property def stays in the vault catalog, so
		// it can be re-added later via "Add column". The Name column is the
		// collection's identity and can't be removed.
		if (column.propertyId !== TITLE_COLUMN_ID) {
			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "db-popover__column-remove";
			remove.dataset.testid = "db-view-settings-remove-column";
			remove.setAttribute("aria-label", `Remove column ${label.textContent}`);
			remove.dataset.bsTooltip = "Remove column";
			setSharedIcon(remove, IconName.Close);
			remove.addEventListener("click", (event) => {
				event.stopPropagation();
				onChange(columns.filter((_, i) => i !== index));
			});
			li.appendChild(remove);
		}

		li.addEventListener("dragstart", (event) => {
			event.dataTransfer?.setData("text/plain", String(index));
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
			li.dataset.dragging = "true";
		});
		li.addEventListener("dragend", () => {
			delete li.dataset.dragging;
		});
		li.addEventListener("dragover", (event) => {
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		});
		li.addEventListener("drop", (event) => {
			event.preventDefault();
			const raw = event.dataTransfer?.getData("text/plain");
			if (!raw) return;
			const from = Number.parseInt(raw, 10);
			if (Number.isNaN(from) || from === index) return;
			const next = columns.slice();
			const [moved] = next.splice(from, 1);
			if (!moved) return;
			next.splice(index, 0, moved);
			onChange(next);
		});

		list.appendChild(li);
	});

	body.appendChild(list);

	// Add-column picker (9.3.5.U.b). Three groups via `buildColumnAdderOptions`:
	// existing-vault catalog defs, data-derived properties, and the
	// always-present "+ Create new property" affordance (omitted when the
	// host can't accept new property defs — `onCreateProperty` undefined).
	const adderBtn = document.createElement("button");
	adderBtn.type = "button";
	adderBtn.className = "db-popover__add-column";
	adderBtn.dataset.testid = "db-view-settings-add-column";
	adderBtn.setAttribute("aria-haspopup", "menu");
	adderBtn.textContent = "Add column…";
	adderBtn.addEventListener("click", () => {
		openColumnAdderPicker({
			anchor: adderBtn,
			existingColumns: columns,
			vaultProperties,
			dataDerivedProps: available,
			onPickExisting: (propertyId) => onChange(appendColumnForProperty(columns, propertyId)),
			...(onCreateProperty ? { onCreateProperty } : {}),
		});
	});
	body.appendChild(adderBtn);
}

type OpenColumnAdderPickerOptions = {
	anchor: HTMLElement;
	existingColumns: ReadonlyArray<ColumnSpec>;
	vaultProperties: ReadonlyArray<PropertyDef>;
	dataDerivedProps: ReadonlyArray<string>;
	onPickExisting: (propertyId: string) => void;
	onCreateProperty?: (seedName: string) => void;
};

function openColumnAdderPicker(opts: OpenColumnAdderPickerOptions): void {
	const rect = opts.anchor.getBoundingClientRect();
	const options = buildColumnAdderOptions({
		existingColumns: opts.existingColumns,
		vaultProperties: opts.vaultProperties,
		dataDerivedProps: opts.dataDerivedProps,
	});
	const items = options
		.filter((o) => {
			// Drop the CreateNew option entirely when the host can't accept
			// new defs — explained-no-show beats a greyed-out option.
			if (o.kind !== ColumnAdderOptionKind.CreateNew) return true;
			return Boolean(opts.onCreateProperty);
		})
		.map((option) => ({
			label: option.label,
			onSelect: () => {
				if (option.kind === ColumnAdderOptionKind.CreateNew) {
					opts.onCreateProperty?.(option.seedName);
				} else {
					opts.onPickExisting(option.propertyId);
				}
			},
		}));
	openAnchoredMenu({ x: rect.left, y: rect.bottom + 4 }, items, {
		menuLabel: "Add column",
		anchor: opts.anchor,
	});
}

// ─── Shown objects page ──────────────────────────────────────────────────────

function renderShownObjectsPage(body: HTMLElement, props: ViewSettingsProps): void {
	const available = props.availableTypes ?? [];
	const onChangeSource = props.onChangeSource;
	if (available.length === 0 || !onChangeSource) return;

	if (!props.sourceEditable) {
		const note = document.createElement("p");
		note.className = "db-popover__note";
		note.textContent = "This list's contents are defined by a link or filter rule.";
		body.appendChild(note);
		return;
	}

	const selected = new Set(props.listSourceTypes ?? []);
	const host = document.createElement("div");
	host.className = "db-source__list-host db-source__list-host--inline";
	host.appendChild(
		buildTypeChecklist({
			types: available,
			selected,
			onToggle: (type, checked) => {
				if (checked) selected.add(type);
				else selected.delete(type);
				onChangeSource([...selected]);
			},
		}),
	);
	body.appendChild(host);
}

// ─── Low-level control builders ──────────────────────────────────────────────

function segmented(
	label: string,
	options: ReadonlyArray<[string, string]>,
	value: string,
	onSelect: (v: string) => void,
): HTMLElement {
	const row = document.createElement("div");
	row.className = "db-popover__row";
	const lbl = document.createElement("span");
	lbl.className = "db-popover__row-label";
	lbl.textContent = label;
	row.appendChild(lbl);
	const seg = document.createElement("div");
	seg.className = "db-popover__segments";
	for (const [val, text] of options) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "db-popover__segment";
		btn.dataset.active = String(value === val);
		btn.textContent = text;
		btn.addEventListener("click", () => onSelect(val));
		seg.appendChild(btn);
	}
	row.appendChild(seg);
	return row;
}

/** A labelled select row — used for the group-by / date-axis pickers. */
function selectRow(
	label: string,
	options: ReadonlyArray<[string, string]>,
	value: string,
	onSelect: (v: string) => void,
): HTMLElement {
	const row = document.createElement("div");
	row.className = "db-popover__row";
	const lbl = document.createElement("span");
	lbl.className = "db-popover__row-label";
	lbl.textContent = label;
	row.appendChild(lbl);
	const select = createSelectMenu({
		options: options.map(([val, text]) => ({ value: val, label: text })),
		value,
		ariaLabel: label,
		className: "db-popover__select",
		onChange: onSelect,
	});
	row.appendChild(select.element);
	return row;
}

/** `[value,label]` pairs for a property select row, optionally led by a
 *  "— none —" clear option. Shared by grouping, date-axis, and gallery
 *  cover/subtitle pickers.
 *
 *  Labels resolve to the catalog **display name** (`nameByKey`), falling back
 *  to `humanize(key)` only for keys with no def (the built-ins name/createdAt/
 *  updatedAt). Without this, a property created via the inline form — whose key
 *  is an opaque `prop_…` id — rendered as "Prop mpye0tff 8acd19" in every one of
 *  these pickers (F-036), the same class of bug the grid header fixed (F-017). */
function propertyOptions(
	keys: ReadonlyArray<string>,
	withNone: boolean,
	nameByKey?: ReadonlyMap<string, string>,
): [string, string][] {
	return [
		...(withNone ? ([["", "— none —"]] as [string, string][]) : []),
		...keys.map((k) => {
			const name = nameByKey?.get(k);
			return [k, name?.trim() ? name : humanize(k)] as [string, string];
		}),
	];
}

/** Catalog `key → display name` map for the active list's properties, so the
 *  property select pickers above show names instead of opaque keys. */
function nameMap(props: ViewSettingsProps): ReadonlyMap<string, string> {
	return new Map((props.vaultProperties ?? []).map((d) => [d.key, d.name]));
}

function toggleRow(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
	const row = document.createElement("label");
	row.className = "db-popover__row db-popover__row--toggle";
	const lbl = document.createElement("span");
	lbl.className = "db-popover__row-label";
	lbl.textContent = label;
	const sw = document.createElement("span");
	sw.className = "db-popover__switch";
	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked;
	input.addEventListener("change", () => onChange(input.checked));
	sw.appendChild(input);
	const track = document.createElement("span");
	track.className = "db-popover__switch-track";
	sw.appendChild(track);
	row.append(lbl, sw);
	return row;
}

function sliderRow(
	label: string,
	value: number,
	min: number,
	max: number,
	step: number,
	onChange: (v: number) => void,
): HTMLElement {
	const row = document.createElement("div");
	row.className = "db-popover__row db-popover__row--slider";
	const lbl = document.createElement("span");
	lbl.className = "db-popover__row-label";
	lbl.textContent = label;
	row.appendChild(lbl);
	const slider = document.createElement("input");
	slider.type = "range";
	slider.min = String(min);
	slider.max = String(max);
	slider.step = String(step);
	slider.value = String(value);
	slider.className = "db-popover__slider";
	const valueEl = document.createElement("span");
	valueEl.className = "db-popover__row-value";
	valueEl.textContent = String(value);
	slider.addEventListener("input", () => {
		const next = Number.parseInt(slider.value, 10);
		valueEl.textContent = String(next);
	});
	slider.addEventListener("change", () => {
		const next = Number.parseInt(slider.value, 10);
		onChange(next);
	});
	row.appendChild(slider);
	row.appendChild(valueEl);
	return row;
}
