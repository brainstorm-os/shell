/**
 * Database app — renderer (Stage 9.12.2 read half).
 *
 * When a vault runtime is present the app renders over **real** vault
 * entities: `services.vaultEntities.list()` drives one `byType` query List
 * per entity type the vault contains (see `logic/vault-lists.ts`), live-
 * updated via `vaultEntities.onChange`. The in-memory demo dataset is the
 * fallback only in standalone dev (no `window.brainstorm`) — an empty vault
 * shows an empty app, never demo data, per the established pattern. The
 * long-term keystones (predicate evaluator, source evaluator, view
 * compiler, in-memory entity mirror, vault-list builder) are unchanged when
 * the full entities service (Stage 9.3) replaces the aggregator shim; only
 * the snapshot source + the deferred write path (`entities.create/update/
 * delete`) swap.
 *
 * Composes five pieces:
 *   - `compileMembership` — resolve a List's effective entity ids against the
 *     entity mirror (source ∪ include \ exclude).
 *   - `compileView` — filter / sort / group-by for a given View.
 *   - `applyClick` / `clearSelection` — modifier-aware selection that every
 *     view renderer shares.
 *   - per-kind renderer in `render/*` — paint the result.
 *   - view-settings popover + drag-and-drop for in-place edits to the
 *     calendar's grouping property / the board's group property / the
 *     view's layout options.
 *
 * The entities-service swap (Stage 9.3) replaces the `DEMO_ENTITIES` source
 * with `entities.subscribe({list, viewId})` updates and the in-memory
 * mutate helpers with real `entities.update(...)` writes; renderers don't
 * change.
 */

import "@brainstorm/sdk/app-theme.css";
import "@brainstorm/editor/editor.css";
import "@brainstorm/sdk/virtual-list.css";
import "@brainstorm/sdk/property-ui/dictionary-editor.css";
import "@brainstorm/sdk/count-badge.css";
import { EntityCommentsPanel } from "@brainstorm/editor";
import { openEntity, quickLookEntity } from "@brainstorm/sdk";
import {
	COLLECTION_TYPE_URL,
	type Cover,
	type Dictionary,
	type Entity,
	type EntityQuery,
	type Icon,
	type ObjectDragPayload,
	type PropertiesService,
	type PropertiesSnapshot,
	type PropertyDef,
	PropertyFormat,
	type SourceQueryResult,
	ValueType,
	type VaultEntity,
	isMultiValued,
} from "@brainstorm/sdk-types";
import { createCountBadge } from "@brainstorm/sdk/count-badge";
import { coverOf, createEntityCoverElement } from "@brainstorm/sdk/entity-cover";
import { createEntityIconElement } from "@brainstorm/sdk/entity-icon";
import { IconName, createIconElement } from "@brainstorm/sdk/icon";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import { type NavHistory, createNavButtons, createNavHistory } from "@brainstorm/sdk/nav-history";
import {
	type CollectionsEntitiesService,
	attachObjectMenuTrigger,
	openAnchoredMenu,
	openObjectMenu,
} from "@brainstorm/sdk/object-menu";
import { PanelSide, panelToggleIcon } from "@brainstorm/sdk/panel-toggle";
import { createAddIconGlyph } from "@brainstorm/sdk/picker-host";
import { type EntityTitleSource, PropertiesProvider } from "@brainstorm/sdk/property-ui";
import { applyPersistedPanelWidth, attachResizable } from "@brainstorm/sdk/resizable";
import { attachShortcut } from "@brainstorm/sdk/shortcut";
import { mountSpellcheckMenuFromWindow } from "@brainstorm/sdk/spellcheck-menu";
import { type VirtualListHandle, createVirtualList } from "@brainstorm/sdk/virtual-list";

applyPersistedPanelWidth({
	storageKey: "database:sidebar-width",
	cssVar: "--db-sidebar-width",
	defaultWidth: 248,
});
applyPersistedPanelWidth({
	storageKey: "database:inspector-width",
	cssVar: "--db-inspector-width",
	defaultWidth: 320,
});

// Apply persisted chrome (sidebar open) to `#db-main` synchronously before
// first paint. Without this, `loadPersistedState` resolves after the worker
// round-trip and flipping `data-sidebar-open` post-paint fires the `.db-main`
// grid-template + panel `transform` transitions on every launch — the rule is
// that transitions express a user TOGGLE only, never a restore (see
// [[panel-transition-toggle-only]]). Mirrors notes' `readPref(NAV_PREF_KEY)`
// precedent — localStorage is the canonical store; the async payload still
// carries `chrome` for legacy reasons but is no longer read back.
//
// The inspector is the exception: it is selection-driven (F-064 closes it
// whenever nothing is selected) and selection is NOT persisted across
// sessions, so there is never anything to inspect at boot. Restoring it open
// would leave an empty "Details" shell — `renderInspector` doesn't run during
// init to apply the auto-close. So the inspector ALWAYS boots closed; the
// toggle (which seeds the first row) re-opens it.
const LS_SIDEBAR_OPEN_KEY = "database:sidebar-open";
function readBoolPref(key: string, fallback: boolean): boolean {
	try {
		const raw = globalThis.localStorage?.getItem(key);
		if (raw === null || raw === undefined) return fallback;
		return raw !== "false";
	} catch {
		return fallback;
	}
}
function writeBoolPref(key: string, value: boolean): void {
	try {
		globalThis.localStorage?.setItem(key, String(value));
	} catch {
		/* private mode / quota — silent, reverts to default on reload */
	}
}
{
	const dbMain = document.getElementById("db-main");
	if (dbMain) {
		dbMain.dataset.sidebarOpen = String(readBoolPref(LS_SIDEBAR_OPEN_KEY, true));
		dbMain.dataset.inspectorOpen = "false";
	}
}
import { ExportOptionKind, openExportPopover } from "@brainstorm/sdk/export-popover";
import { PopoverSize, createPopoverElement } from "@brainstorm/sdk/popover";
import { TYPE_LABELS } from "./demo/dataset";
import { t } from "./i18n";
import { PERSON_TYPE } from "./logic/contact-import";
import { commitCsvImport, csvToEntityImport } from "./logic/csv-import";
import { registerBuiltInImportMappers } from "./logic/import-registry";
import { ListExportFormat, type ListExportOptions } from "./logic/list-export";
import { runListExport } from "./ui/export-flow";
import { runImportFlow } from "./ui/import-flow";
import {
	createIconPickerButton,
	openCoverPicker,
	openIconPicker,
	openInlinePropertyForm,
} from "./ui/picker-host";

// 9.12.16-UI — surface every built-in import mapper at boot. Idempotent;
// safe to call any time (the registry deduplicates by typeUrl).
registerBuiltInImportMappers();

/** No demo data: Database renders the real vault only. When no vocabulary
 *  snapshot is loaded yet, chips simply have no colour (no demo palette). */
const NULL_VOCAB = () => null;

import { subscribe as subscribePerf, time } from "@brainstorm/sdk/perf";
import { type ReactElement, createElement } from "react";
import { type Backlink, backlinksFor } from "./logic/backlinks";
import { pickerCandidatesForEntity, sourceMatches } from "./logic/collections-for-entity";
import { appendColumnForProperty, findReusablePropertyDef } from "./logic/column-adder";
import {
	compileViewCached,
	filterEntitiesCached,
	groupLabelResolverCached,
	groupOrderResolverCached,
	resetCompileCache,
} from "./logic/compile-cache";
import { copyListBlockRef } from "./logic/copy-list-block-ref";
import {
	FILTER_OPERATORS,
	type FilterCompareTo,
	type FilterDraft,
	FilterOp,
	type FilterRule,
	countDraftRules,
	describeGroup,
	describeRule,
	draftToFilterNode,
	filterNodeToDraft,
	opAcceptsRef,
	opIsList,
	opLabel,
	opNeedsValue,
} from "./logic/filter-builder";
import { type EntityRow, type InMemoryEntities, emptyEntities } from "./logic/in-memory-entities";
import {
	createList,
	createView,
	deleteList as deleteListLogic,
	deleteView as deleteViewLogic,
	duplicateList,
	duplicateView,
	renameList as renameListLogic,
	resolveListView,
	setListIcon as setListIconLogic,
} from "./logic/list-crud";
import { deriveListMode } from "./logic/list-mode";
import {
	deleteUserList,
	loadUserLists,
	planListReconcile,
	saveUserList,
	serializeListForReconcile,
} from "./logic/list-persistence";
import { addToList } from "./logic/members";
import {
	buildPropertyDefResolver,
	buildVocabularyLabelResolver,
	buildVocabularyResolver,
	installPropertyDefResolver,
	installVocabularyLabelResolver,
	installVocabularyResolver,
} from "./logic/property-resolver";
import { ALL_RELATIVE_DATE_RANGES, relativeRangeLabel } from "./logic/relative-date";
import { entitiesById } from "./logic/rollup";
import { rollupRelationCandidates, rollupTargetCandidates } from "./logic/rollup-builder";
import { GENERIC_OBJECT_TYPE, decideRowCreate } from "./logic/row-create";
import { rowMenuPlan } from "./logic/row-menu";
import {
	type SelectionModifiers,
	type SelectionState,
	applyClick,
	clearSelection,
	createSelection,
} from "./logic/selection";
import { compileMembershipWith, createSourceIdsCache } from "./logic/source-ids-cache";
import { type SidebarNavRow, SidebarRowKind, sidebarNavRows } from "./logic/system-lists";
import { decideToggleMembership } from "./logic/toggle-membership";
import {
	buildVaultLists,
	deriveColumns,
	firstVaultSelection,
	friendlyTypeName,
	relationTargetTypesFromEntities,
} from "./logic/vault-lists";
import {
	ViewConfigAction,
	type ViewConfigChange,
	applyViewConfig,
	defaultViewName,
} from "./logic/view-config";
import {
	deleteUserView,
	loadUserViews,
	planViewReconcile,
	saveUserView,
	serializeViewForReconcile,
} from "./logic/view-persistence";
import {
	insertViewAfter,
	moveViewByStep,
	orderViewsForStrip,
	reorderViews,
} from "./logic/view-strip";
import { BoardView } from "./react/board-view";
import { CalendarView } from "./react/calendar-view";
import { GalleryView } from "./react/gallery-view";
import { GridView } from "./react/grid-view";
import { InspectorProperties } from "./react/inspector-properties";
// Aliased: the model type `ListView` (a `brainstorm/ListView/v1` value
// in app state, owned by `types/list-view.ts`) collides with the new
// React component of the same name. Keep the component name parity in
// the `react/` directory and disambiguate here.
import { ListView as ListViewComponent } from "./react/list-view";
import { EmptyState, mountInspectorProps, renderEmpty, renderViewBodyReact } from "./react/mount";
import { TimelineView } from "./react/timeline-view";
import { entityIcon, entityTitle, formatDate, formatDateTime, typeLabel } from "./render/cells";
import { IconKind } from "./types/icon";
import { IntentVerb } from "./types/intent";
import type { List } from "./types/list";
import { ListMode, type ListSource, ListSourceKind } from "./types/list-source";
import type {
	BoardLayoutOptions,
	CalendarLayoutOptions,
	ColumnSpec,
	GalleryLayoutOptions,
	GridLayoutOptions,
	ListLayoutOptions,
	ListView,
	TimelineLayoutOptions,
} from "./types/list-view";
import { CalendarRange, EmptyPlacement, ListViewKind, SortDirection } from "./types/list-view";
import { FilterGroupOp } from "./types/predicate";
import { type MenuItem, openContextMenu } from "./ui/context-menu";
import { humanize } from "./ui/humanize";
import { DatabaseIcon, createIcon, createSharedIcon, setIcon, setSharedIcon } from "./ui/icons";
import { renderInspectorCollections } from "./ui/inspector-collections";
import { type SourceTypeOption, closeSourcePicker, openSourcePicker } from "./ui/source-picker";
import { closeViewSettings, openViewSettings, resetViewSettingsPage } from "./ui/view-settings";

type ViewSelection = {
	listId: string;
	viewId: string;
};

type ChromeState = {
	sidebarOpen: boolean;
	inspectorOpen: boolean;
};

type AppState = {
	lists: List[];
	views: ListView[];
	db: InMemoryEntities;
	active: ViewSelection;
	selection: SelectionState;
	calendarCursor: number;
	chrome: ChromeState;
	/** Entity id whose grid title editor should open on the next paint — the
	 *  create→type→Enter keyboard handoff (F-215) and the row-menu Rename
	 *  (F-216). The grid consumes (clears) it once the editor has focus. */
	pendingTitleEdit: string | null;
};

const STORAGE_KEY = "database:state";

type PersistedStateV1 = {
	version: 1;
	active: ViewSelection;
	chrome: ChromeState;
};

type PersistedStateV2 = {
	version: 2;
	active: ViewSelection;
	chrome: ChromeState;
	userLists: List[];
	userViews: ListView[];
};

/** User tweaks to a *vault-derived* view (name / kind / layout / columns
 *  / sorts / filters / groupBy / manual row order). The view itself is
 *  regenerated by `buildVaultLists` every rebuild, but its id is stable
 *  (derived from the type id), so the override re-attaches by id and the
 *  user's per-view config survives a vault `onChange` rebuild. */
// `ViewOverride` + `viewOverrideOf` + `mergeOverlay` extracted to
// `./state/view-overlay.ts` (9.12.R1 closeout) so the reorder-persistence
// regression test can exercise the pure merge without standing up the
// whole app.
import { type ViewOverride, mergeOverlay, viewOverrideOf } from "./state/view-overlay";

type PersistedStateV3 = {
	version: 3;
	active: ViewSelection;
	chrome: ChromeState;
	userLists: List[];
	userViews: ListView[];
	viewOverrides: Record<string, ViewOverride>;
};

type PersistedStateV4 = {
	version: 4;
	active: ViewSelection;
	chrome: ChromeState;
	userLists: List[];
	userViews: ListView[];
	viewOverrides: Record<string, ViewOverride>;
	lastViewByList: Record<string, string>;
};

/** Since 9.3.5.V 7b-wire, user-created Lists are `brainstorm/List/v1`
 *  entities in `entities.db` (vault-level, cross-app visible) — they no
 *  longer ride in this kv payload. `userLists` from a pre-v5 payload is
 *  read once on load and migrated into `entities.db`, then this version is
 *  written and the field is gone. */
type PersistedStateV5 = {
	version: 5;
	active: ViewSelection;
	chrome: ChromeState;
	userViews: ListView[];
	viewOverrides: Record<string, ViewOverride>;
	lastViewByList: Record<string, string>;
};

/** Since 9.12.8, user-created views are `brainstorm/ListView/v1` entities
 *  in `entities.db` too (the view-lifecycle iteration) — `userViews` from a
 *  pre-v6 payload is read once on load and migrated, mirroring the v5
 *  `userLists` promotion. */
type PersistedState = {
	version: 6;
	active: ViewSelection;
	chrome: ChromeState;
	/** Per-vault-derived-view config overrides, keyed by stable view id. */
	viewOverrides: Record<string, ViewOverride>;
	/** Last view the user had open on each List, keyed by list id —
	 *  switching away from a List and back reopens that view instead of
	 *  falling to `defaultViewId`. Stale (now-deleted) view/list ids are
	 *  harmless: `selectList` only honours an entry that still resolves. */
	lastViewByList: Record<string, string>;
};

// ── Module state — ALL declared here, before `bootApp()` ───────────────
// `bootApp()` runs synchronously at module-eval and (with a real DOM)
// renders + binds handlers that read this state. A `let` declared *after*
// this call sits in the temporal dead zone during boot → the whole app
// throws `ReferenceError: Cannot access X before initialization` and
// every later handler that touches post-abort state stays broken. So
// every piece of module state lives above the call. (Caught by the
// real-DOM boot smoke test.)
let statusTimer: ReturnType<typeof setTimeout> | null = null;
let vaultReloadTimer: ReturnType<typeof setTimeout> | null = null;
let lastVaultSignature: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** Vault-catalog PropertyDefs cached for the column-adder picker
 *  (9.3.5.U.b). Refreshed lazily via `loadVaultProperties` — driven by
 *  `services.properties.list()` and refreshed by the runtime's
 *  `onChange` subscription. Stays an empty array until either the
 *  runtime resolves or the user opens View settings for the first time. */
let cachedVaultProperties: PropertyDef[] = [];

/** A property's human label: the vault-catalog def's `name` (so a user-created
 *  property reads "Deal size", not its generated key "prop_…"), else the
 *  humanized key. The single label rule shared by the grid header, inspector,
 *  view-settings columns list, sort menu, and export headers (F-017). */
function propertyDisplayName(propertyId: string): string {
	const def = cachedVaultProperties.find((d) => d.key === propertyId);
	return def?.name?.trim() ? def.name : humanize(propertyId);
}

/** The property-kind glyph for a column — drives the type icon shown beside
 *  each property in the filter picker (and anywhere a property reads as a
 *  typed field). A vocabulary-backed property is a Select; otherwise it maps
 *  off the catalog `valueType` + `format`. Built-ins with no def fall back by
 *  key (`__title__`/name → text, the `*At` timestamps → date). */
function propertyKindIcon(propertyId: string): IconName {
	if (propertyId === "__title__") return IconName.KindText;
	const def = cachedVaultProperties.find((d) => d.key === propertyId);
	if (!def) return /at$/i.test(propertyId) ? IconName.KindDate : IconName.KindText;
	if (def.vocabulary?.dictionaryId) {
		return isMultiValued(def.count) ? IconName.KindMultiSelect : IconName.KindSelect;
	}
	switch (def.valueType) {
		case ValueType.Number:
			return IconName.KindNumber;
		case ValueType.Boolean:
			return IconName.KindBoolean;
		case ValueType.Date:
			return IconName.KindDate;
		case ValueType.EntityRef:
			return IconName.KindLink;
		default:
			if (def.format === PropertyFormat.Email) return IconName.KindEmail;
			if (def.format === PropertyFormat.Url) return IconName.KindUrl;
			if (def.format === PropertyFormat.Phone) return IconName.KindPhone;
			return IconName.KindText;
	}
}

/** Vault dictionaries (vocabulary option sets), keyed by dictionary id —
 *  cached alongside `cachedVaultProperties` so filter value-pickers can offer a
 *  Select's options and resolve a stored option id back to its label (F-027). */
let cachedDictionaries: Record<
	string,
	{ id: string; items: ReadonlyArray<{ id: string; label: string }> }
> = {};

/** The selectable options (id + label) for a vocabulary/Select property, or
 *  `null` when the property isn't vocabulary-backed. Drives the filter value
 *  picker so a Select is filtered by its labels, not its opaque option ids. */
function selectOptionsFor(propertyId: string): ReadonlyArray<{ id: string; label: string }> | null {
	const dictId = cachedVaultProperties.find((d) => d.key === propertyId)?.vocabulary?.dictionaryId;
	if (!dictId) return null;
	const items = cachedDictionaries[dictId]?.items;
	return items && items.length > 0 ? items : null;
}

/** Resolve a stored option id to its label for a vocabulary property (so a
 *  filter chip reads "Status is Lead", not the raw id). Falls back to the
 *  value itself when it isn't a known option id. */
function selectLabelForValue(propertyId: string, value: string): string {
	return selectOptionsFor(propertyId)?.find((o) => o.id === value)?.label ?? value;
}

/** The human label for a rule's value in the filter chip / menu: a relative-
 *  date rule shows its range name ("Last 7 days"), a vocabulary value its
 *  option label, everything else the raw value. */
function ruleValueLabel(rule: FilterRule): string {
	return rule.op === FilterOp.RelativeDate
		? relativeRangeLabel(rule.value)
		: selectLabelForValue(rule.propertyId, rule.value);
}
/** Resolves once persisted user deltas (incl. per-view overrides like
 *  board column order) are loaded into `persistedUserDeltas`. The vault
 *  `ready` path awaits this before its first `applyVaultSnapshot` so the
 *  initial rebuild of vault-derived views re-layers the overrides instead
 *  of racing them away. */
let persistedReady: Promise<void> = Promise.resolve();
// Shared in-app back/forward controller — declared here (above the
// module-eval `bootApp()` call) so `bootApp` can assign it without a TDZ.
let dbNav: NavHistory<DbNavLoc> | null = null;
let applyingDbNav = false;
/** The windowed source-list. Created lazily on the first `renderListNav`
 *  (needs the live `#list-nav` element) and refreshed thereafter. */
let listNav: VirtualListHandle | null = null;
/** Source-list row height (px) — compact single line; mirrored by
 *  `.db-sidebar__list-item` in `styles.css` and the virtualizer estimate.
 *  Declared with module state (above `bootApp()`): the boot smoke fails
 *  any render-path read of a `const` that sits in the TDZ during boot. */
const LIST_ROW_HEIGHT = 32;
/** Ephemeral free-text search over the active view's rows. Module state
 *  (not persisted) — declared here, above `bootApp()`, like all other
 *  module state (TDZ-safe; caught by the real-DOM boot smoke). */
let searchQuery = "";
/** Sidebar "System" disclosure (F-212) — collapsed by default so
 *  infrastructure type-lists stay out of the way; the toggle persists. */
const LS_SYSTEM_SECTION_OPEN_KEY = "database:system-section-open";
let systemSectionOpen = readBoolPref(LS_SYSTEM_SECTION_OPEN_KEY, false);
/** Persisted user-created Lists/Views, captured by `loadPersistedState`
 *  so a vault rebuild (initial load + every `onChange`) can re-layer them
 *  on top of the freshly-derived vault Lists without a storage round-trip. */
let persistedUserDeltas: {
	lists: List[];
	views: ListView[];
	active: ViewSelection | null;
	viewOverrides: Record<string, ViewOverride>;
	lastViewByList: Record<string, string>;
} = { lists: [], views: [], active: null, viewOverrides: {}, lastViewByList: {} };

/** Serialized form of each user List last reconciled into `entities.db`,
 *  keyed by List id. `reconcileUserLists` skips any List whose serialized
 *  form is unchanged so a no-op persist never re-broadcasts an entity
 *  update — which would feed the vault `onChange` → rebuild → persist
 *  amplification loop ([[feedback_coalesce_staleSub_callbacks]]). */
const reconciledListSnapshot = new Map<string, string>();
const reconciledViewSnapshot = new Map<string, string>();

bootApp();

function bootApp(): void {
	// Stand up the fancy-menus runtime so object / context menus open through
	// the shared bridge (Stage 8.8).
	mountMenuHost();
	// B11.16c — spellcheck suggestion menu for editable text cells.
	mountSpellcheckMenuFromWindow();
	// Surface over-budget renders to the runtime error log. The doc-13
	// keystroke→paint budget is 16ms; the noise floor for a *warning* sits
	// at 50ms (three frames at 60fps — comfortably past first-paint /
	// view-switch overhead, so a hit means real work needs to move:
	// debounce, cache, virtualize). Per-name throttle (10s) keeps a single
	// pathological path from flooding the runtime error log that the
	// triage chore depends on as signal. Subscriber installed once at boot.
	const lastWarnAt = new Map<string, number>();
	const WARN_COOLDOWN_MS = 10_000;
	subscribePerf({ thresholdMs: 50, prefix: "db." }, (m) => {
		const last = lastWarnAt.get(m.name) ?? 0;
		if (m.startMs - last < WARN_COOLDOWN_MS) return;
		lastWarnAt.set(m.name, m.startMs);
		console.warn(`[database:perf] ${m.name} took ${m.durationMs.toFixed(1)}ms`);
	});

	// No demo data, ever. Database boots EMPTY and is filled only from the
	// real vault (`vaultEntities.list()` → `buildVaultLists`). An empty /
	// no-runtime / failed-load vault renders the honest empty state, never
	// fake rows — so a wiring failure is visible, not masked.
	const state: AppState = {
		lists: [],
		views: [],
		db: emptyEntities(),
		active: { listId: "", viewId: "" },
		selection: createSelection(),
		calendarCursor: Date.now(),
		chrome: {
			sidebarOpen: readBoolPref(LS_SIDEBAR_OPEN_KEY, true),
			inspectorOpen: false,
		},
		pendingTitleEdit: null,
	};

	installVocabularyResolver(buildVocabularyResolver(null, NULL_VOCAB));
	installPropertyDefResolver(buildPropertyDefResolver(null));

	renderHeaderIcons();
	renderToolbarIcons();
	bindHeaderButtons(state);
	bindToolbarButtons(state);
	bindStageKeyboard(state);
	bindViewTabKeyboard(state);
	bindResizableChrome();

	renderListNav(state);
	renderViewTabs(state);
	renderStageHeader(state);
	renderActiveView(state);
	bindStageObjectMenu(state);
	bindHeaderObjectMenu(state);
	applyChrome(state);

	dbNav = createNavHistory<DbNavLoc>({
		initial: { listId: state.active.listId, viewId: state.active.viewId },
	});
	const headerLeft = document.querySelector(".app-header__left");
	if (headerLeft) {
		// Header leads with the document: nav buttons first, then the
		// active-list subtitle. App chip/name/separator were removed.
		headerLeft.prepend(
			createNavButtons<DbNavLoc>({
				history: dbNav,
				onNavigate: (loc) => applyDbNav(state, loc),
			}).element,
		);
	}

	announceRuntime(state);
	watchTokenChanges(state);

	persistedReady = loadPersistedState(state);
}

/* ── Rendering ─────────────────────────────────────────────────────────── */

function viewsForList(state: AppState, listId: string): ListView[] {
	return state.views.filter((v) => v.listId === listId);
}

function activeList(state: AppState): List | undefined {
	return state.lists.find((l) => l.id === state.active.listId);
}

function activeView(state: AppState): ListView | undefined {
	return state.views.find((v) => v.id === state.active.viewId);
}

/** Shell-resolved source ids (9.12.3): filled asynchronously from
 *  `vaultEntities.querySource` by `refreshSourceIds`; the synchronous render
 *  path reads it through `effectiveMembershipOf` and falls back to the
 *  in-memory evaluator until the shell answer lands. */
const sourceIdsCache = createSourceIdsCache();

function effectiveMembershipOf(state: AppState, list: List): Set<string> {
	return compileMembershipWith(list, state.db, sourceIdsCache.lookup(list));
}

/** Re-resolve every sourced List's membership shell-side. Fired after a
 *  vault snapshot lands (initial load + every `onChange`) and after a
 *  source edit — so saved-List membership stays live (9.12.6) without the
 *  render path ever awaiting. Only re-renders when an id set changed. */
async function refreshSourceIds(state: AppState): Promise<void> {
	const service = getRuntime()?.services?.vaultEntities;
	const querySource = service?.querySource?.bind(service);
	if (!querySource) return;
	try {
		const changed = await sourceIdsCache.refresh(state.lists, { querySource });
		if (changed) {
			resetCompileCache();
			renderListNav(state);
			renderActiveView(state);
			renderStageHeader(state);
		}
	} catch (error) {
		console.warn("[database] querySource refresh failed:", error);
	}
}

function compileActive(
	state: AppState,
): { view: ListView; entities: ReadonlyArray<EntityRow> } | null {
	const list = activeList(state);
	const view = activeView(state);
	if (!list || !view) return null;
	const q = searchQuery.trim().toLowerCase();
	const entities = filterEntitiesCached(list, state.db, q, () => {
		const effectiveIds = effectiveMembershipOf(state, list);
		return (entity: EntityRow) => {
			if (!effectiveIds.has(entity.id)) return false;
			if (q && !entityMatchesQuery(entity, q)) return false;
			return true;
		};
	});
	return { view, entities };
}

/**
 * Resolves a group key that is an entity id to that entity's title, so a
 * board grouped by `projectId` shows the project name ("Stage 0 — …")
 * instead of the raw `proj-0`. Non-id keys (vocabulary, plain strings)
 * fall through to the key verbatim. Cached against `state.db` reference so
 * selection-only re-renders don't rebuild the id→title map.
 */
/** A vocabulary option's label by its (globally-unique) option id, across all
 *  cached dictionaries — so a board grouped by a Select column shows "Lead",
 *  not the raw option id "di_…" (F-030). */
function optionLabelById(id: string): string | undefined {
	for (const dict of Object.values(cachedDictionaries)) {
		const item = dict.items.find((it) => it.id === id);
		if (item) return item.label;
	}
	return undefined;
}

/** The option's position within its Select dictionary — its defined order. The
 *  `items` array IS the option order, so the index is the rank. `undefined` for
 *  a key that isn't a known option (e.g. a relation entity id), which then keeps
 *  first-seen order. Drives F-037 board-lane ordering. */
function optionOrderById(id: string): number | undefined {
	for (const dict of Object.values(cachedDictionaries)) {
		const idx = dict.items.findIndex((it) => it.id === id);
		if (idx !== -1) return idx;
	}
	return undefined;
}

function groupLabelResolver(state: AppState): (key: string) => string | undefined {
	return groupLabelResolverCached(state.db, () => {
		const byId = new Map<string, EntityRow>();
		for (const e of state.db.entities) byId.set(e.id, e);
		// Group key is an entity id (e.g. board grouped by a relation) → entity
		// title; else a vocabulary option id (board grouped by a Select) → its
		// label; else undefined (compile-view falls back to the raw key).
		return (key) => {
			const e = byId.get(key);
			if (e) return entityTitle(e);
			return optionLabelById(key);
		};
	});
}

/** Resolves a group key to its Select option rank so a grouped board's lanes
 *  read in the property's defined order (F-037). Cached per `db` so the
 *  memoised `compileViewCached` keeps its reference. */
function groupOrderResolver(state: AppState): (key: string) => number | undefined {
	return groupOrderResolverCached(state.db, () => (key) => optionOrderById(key));
}

/** Case-insensitive substring match over an entity's name/title and its
 *  scalar property values — the free-text search predicate. */
function entityMatchesQuery(entity: EntityRow, q: string): boolean {
	for (const value of Object.values(entity.properties)) {
		if (
			(typeof value === "string" || typeof value === "number") &&
			String(value).toLowerCase().includes(q)
		) {
			return true;
		}
	}
	return false;
}

function renderListNav(state: AppState): void {
	const root = document.getElementById("list-nav");
	if (!root) return;
	if (!listNav) {
		listNav = createVirtualList<SidebarNavRow>({
			scrollEl: root,
			rowHeight: LIST_ROW_HEIGHT,
			getItems: () =>
				sidebarNavRows(state.lists, {
					systemOpen: systemSectionOpen,
					isVaultDerived: isVaultDerivedListId,
				}),
			renderRow: (row) =>
				row.kind === SidebarRowKind.List
					? buildListNavRow(state, row.list)
					: buildSystemHeaderRow(state, row),
		});
		return;
	}
	listNav.refresh();
}

/** The collapsed "System" disclosure under the user's lists (F-212):
 *  vault-derived type-lists over infrastructure types (BrowsingHistories,
 *  ListViews, Triggers…) group here instead of posing as the user's data. */
function buildSystemHeaderRow(
	state: AppState,
	row: { count: number; open: boolean },
): HTMLButtonElement {
	const item = document.createElement("button");
	item.type = "button";
	item.className = "db-sidebar__system-header";
	item.setAttribute("aria-expanded", String(row.open));
	item.setAttribute("aria-label", t("brainstorm.database.sidebar.systemToggle"));

	// The disclosure caret rotates via CSS off `aria-expanded` (the shared
	// SDK glyph set has no CaretDown — same rotate approach as Files).
	const caret = document.createElement("span");
	caret.className = "db-sidebar__system-caret";
	caret.appendChild(createIconElement(IconName.CaretRight, { size: 12 }));
	item.appendChild(caret);

	const label = document.createElement("span");
	label.className = "db-sidebar__system-label";
	label.textContent = t("brainstorm.database.sidebar.system");
	item.appendChild(label);

	item.appendChild(createCountBadge(row.count));

	item.addEventListener("click", () => {
		systemSectionOpen = !systemSectionOpen;
		writeBoolPref(LS_SYSTEM_SECTION_OPEN_KEY, systemSectionOpen);
		renderListNav(state);
	});
	return item;
}

/**
 * A list shows its OWN universal icon (emoji / pack glyph / uploaded
 * image) when set; otherwise NOTHING is drawn — and per
 * [[feedback_no_default_type_icon_fallback]] (project-wide), no sized
 * empty slot either. Returns null when there's no icon so the caller can
 * skip the glyph wrapper entirely and let the row's flex gap collapse.
 */
function listIconElement(list: List, size: number): HTMLElement | null {
	return createEntityIconElement(list.icon ?? null, { size });
}

function buildListNavRow(state: AppState, list: List): HTMLButtonElement {
	const item = document.createElement("button");
	item.type = "button";
	item.className = "db-sidebar__list-item";
	item.setAttribute("role", "option");
	item.setAttribute("aria-selected", String(list.id === state.active.listId));
	item.dataset.listId = list.id;

	const iconEl = listIconElement(list, 20);
	if (iconEl) {
		const glyph = document.createElement("span");
		glyph.className = "db-sidebar__list-glyph";
		glyph.appendChild(iconEl);
		item.appendChild(glyph);
	}

	const name = document.createElement("span");
	name.className = "db-sidebar__list-name";
	name.textContent = list.name;
	item.appendChild(name);

	item.appendChild(createCountBadge(memberCount(list, state)));

	item.addEventListener("click", () => {
		selectList(state, list.id);
	});
	item.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		openListContextMenu(state, list, name, { x: event.clientX, y: event.clientY });
	});
	return item;
}

function memberCount(list: List, state: AppState): number {
	return effectiveMembershipOf(state, list).size;
}

/** Wire format for a tab drag (the dragged view id rides the dataTransfer
 *  under this MIME so a drop only reorders our own tabs). */
const VIEW_TAB_DND_MIME = "application/x-brainstorm-view-tab";

function renderViewTabs(state: AppState): void {
	const root = document.getElementById("view-tabs");
	if (!root) return;
	root.replaceChildren();
	const list = activeList(state);
	if (!list) return;
	// Render in the List's canonical `views` order (the order the user dragged
	// them into), not the unordered `state.views` pool order — `viewsForList`
	// is a flat filter; the strip honours the order array.
	const views = orderViewsForStrip(state.views, list.id, list.views);
	for (const view of views) {
		const tab = document.createElement("button");
		tab.type = "button";
		tab.className = "db-tab";
		tab.setAttribute("role", "tab");
		tab.setAttribute("aria-selected", String(view.id === state.active.viewId));
		tab.dataset.viewId = view.id;
		tab.draggable = true;

		const icon = document.createElement("span");
		icon.className = "db-tab__icon";
		icon.appendChild(createIcon(viewKindIcon(view.kind), { size: 14 }));
		tab.appendChild(icon);

		const label = document.createElement("span");
		label.className = "db-tab__label";
		label.textContent = view.name;
		tab.appendChild(label);

		tab.addEventListener("click", () => {
			selectView(state, view.id);
		});
		// Double-click renames in place (F-208). The first click may have
		// re-rendered the strip (selecting a non-active tab), so the rename
		// helper re-queries the LIVE label by view id rather than closing
		// over this render's element.
		tab.addEventListener("dblclick", (event) => {
			event.preventDefault();
			beginViewTabRename(state, view.id);
		});
		tab.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			openViewContextMenu(state, view, { x: event.clientX, y: event.clientY });
		});
		bindViewTabDrag(state, tab, view.id);
		root.appendChild(tab);
	}

	const addTab = document.createElement("button");
	addTab.type = "button";
	addTab.className = "db-tab db-tab--add";
	addTab.setAttribute("aria-label", t("brainstorm.database.view.new"));
	addTab.dataset.bsTooltip = t("brainstorm.database.view.new");
	const addIcon = document.createElement("span");
	addIcon.className = "db-tab__icon";
	addIcon.appendChild(createSharedIcon(IconName.Plus, { size: 14 }));
	addTab.appendChild(addIcon);
	addTab.addEventListener("click", () => {
		createNewViewAndSelect(state, list.id);
	});
	root.appendChild(addTab);
}

/** HTML5 drag-reorder for one tab. Dragging a tab over a sibling drops it
 *  immediately before that sibling (drop past the last tab → end), committed
 *  through the tested `reorderViews` arithmetic on `List.views`. Mid-edit tabs
 *  (contenteditable label) are not draggable — the browser keeps the rename
 *  selection. */
function bindViewTabDrag(state: AppState, tab: HTMLButtonElement, viewId: string): void {
	tab.addEventListener("dragstart", (event) => {
		if (!event.dataTransfer) return;
		event.dataTransfer.setData(VIEW_TAB_DND_MIME, viewId);
		event.dataTransfer.effectAllowed = "move";
		tab.dataset.dragging = "true";
	});
	tab.addEventListener("dragend", () => {
		delete tab.dataset.dragging;
	});
	tab.addEventListener("dragover", (event) => {
		if (!event.dataTransfer?.types.includes(VIEW_TAB_DND_MIME)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		tab.dataset.dropTarget = "true";
	});
	tab.addEventListener("dragleave", () => {
		delete tab.dataset.dropTarget;
	});
	tab.addEventListener("drop", (event) => {
		delete tab.dataset.dropTarget;
		const movingId = event.dataTransfer?.getData(VIEW_TAB_DND_MIME);
		if (!movingId || movingId === viewId) return;
		event.preventDefault();
		commitViewReorder(state, movingId, viewId);
	});
}

/** Commit a reorder of `movingId` to sit before `beforeId` (or end when
 *  `null`) in the active list's `List.views`. No-op when nothing changes —
 *  `reorderViews` returns the same reference, so we skip the render + persist. */
function commitViewReorder(state: AppState, movingId: string, beforeId: string | null): void {
	const list = activeList(state);
	if (!list) return;
	const next = reorderViews(list.views, movingId, beforeId);
	if (next === list.views) return;
	state.lists = state.lists.map((l) =>
		l.id === list.id ? { ...l, views: next, updatedAt: Date.now() } : l,
	);
	renderViewTabs(state);
	schedulePersist(state);
}

function viewKindIcon(kind: ListViewKind): DatabaseIcon {
	switch (kind) {
		case ListViewKind.Grid:
			return DatabaseIcon.Grid;
		case ListViewKind.List:
			return DatabaseIcon.List;
		case ListViewKind.Gallery:
			return DatabaseIcon.Gallery;
		case ListViewKind.Board:
			return DatabaseIcon.Board;
		case ListViewKind.Calendar:
			return DatabaseIcon.Calendar;
		case ListViewKind.Timeline:
			return DatabaseIcon.Timeline;
	}
}

function renderStageHeader(state: AppState): void {
	const list = activeList(state);
	const view = activeView(state);
	if (!list || !view) return;
	const iconHost = document.getElementById("stage-icon");
	if (iconHost) {
		iconHost.replaceChildren(
			createIconPickerButton({
				value: list.icon,
				size: 18,
				ariaLabel: "Change list icon",
				onChange: (icon) => commitListIcon(state, list.id, icon),
			}),
		);
	}
	const titleEl = document.getElementById("stage-title");
	if (titleEl && titleEl !== document.activeElement) {
		// The heading IS the rename field — click in and type, no
		// dedicated edit mode. Skip the rewrite while it's focused so a
		// re-render mid-edit can't clobber the caret / in-progress text.
		titleEl.textContent = list.name;
		titleEl.contentEditable = "plaintext-only";
		titleEl.spellcheck = false;
		titleEl.onkeydown = (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				titleEl.blur();
			} else if (event.key === "Escape") {
				event.preventDefault();
				titleEl.textContent = list.name;
				titleEl.blur();
			}
		};
		titleEl.onblur = () => {
			const next = (titleEl.textContent ?? "").trim();
			if (next && next !== list.name) commitListRename(state, list.id, next);
			else titleEl.textContent = list.name;
		};
	}
	const headerIcon = document.getElementById("header-list-icon");
	if (headerIcon) {
		// Object identity in the app header — same pattern as Notes (object
		// icon to the left of the name). Routes through the shared icon
		// picker; clicking opens the universal picker and commits the chosen
		// icon back to the list entity. Per
		// [[feedback_no_default_type_icon_fallback]] no type-default
		// fallback — when the list has no own icon, the picker shows
		// nothing (the button is still clickable to set one).
		headerIcon.replaceChildren(
			createIconPickerButton({
				value: list.icon,
				size: 18,
				ariaLabel: "Change list icon",
				onChange: (icon) => commitListIcon(state, list.id, icon),
			}),
		);
	}
	const headerName = document.getElementById("active-list-name");
	if (headerName) headerName.textContent = list.name;
	const descEl = document.getElementById("stage-description");
	if (descEl) descEl.textContent = list.description;
	const countEl = document.getElementById("stage-count");
	if (countEl) countEl.textContent = String(memberCount(list, state));

	const badge = document.getElementById("stage-mode-badge");
	if (badge) {
		const mode = deriveListMode(list);
		badge.textContent = badgeLabel(mode);
		badge.dataset.mode = mode;
	}
}

function badgeLabel(mode: ListMode): string {
	switch (mode) {
		case ListMode.Query:
			return "Query";
		case ListMode.Manual:
			return "Manual";
		case ListMode.Hybrid:
			return "Hybrid";
	}
}

/** Stage placeholder when there's nothing to compile — an empty vault
 *  (no entities yet) or a transient no-selection frame. Honest empty
 *  state per the "empty vault = empty app" pattern: no demo data leaks
 *  into a real vault. */
function emptyStateContent(state: AppState): { title: string; body: string } {
	if (state.lists.length === 0) {
		return {
			title: "Nothing here yet",
			body:
				"This vault has no entities. Create notes, tasks, or other items in their apps and they'll show up here automatically.",
		};
	}
	return {
		title: "No view selected",
		body: "Pick a list from the sidebar to get started.",
	};
}

/** Calendar / Board views need a property to lay items out by (a date for
 *  Calendar, a group for Board). When that property is unset the per-kind
 *  switch breaks without a body — surface a guiding empty-state instead of a
 *  blank stage so the user knows why it's empty and how to fix it. */
function grouplessViewEmptyState(kind: ListViewKind): { title: string; body: string } {
	if (kind === ListViewKind.Calendar) {
		return {
			title: "No date to schedule by",
			body:
				"This calendar view needs a date property. Open view settings (the gear icon) and pick a date to lay your items out on the calendar.",
		};
	}
	return {
		title: "Nothing to group by",
		body:
			"This board view needs a property to group by. Open view settings (the gear icon) and choose one to see columns.",
	};
}

function renderActiveView(state: AppState): void {
	time("db.renderActiveView", () => renderActiveViewInner(state));
}

function renderActiveViewInner(state: AppState): void {
	const body = document.getElementById("stage-body");
	if (!body) return;
	renderFilterBar(state);
	const compiled = compileActive(state);
	if (!compiled) {
		body.className = "db-stage__body";
		delete body.dataset.viewKind;
		renderEmpty(body, emptyStateContent(state));
		return;
	}
	const { view, entities } = compiled;
	const compiledView = time("db.compileView", () =>
		compileViewCached(view, entities, groupLabelResolver(state), groupOrderResolver(state)),
	);

	// className/data-view-kind stay imperative on the host (#stage-body);
	// React owns its children, not its host attributes.
	body.className = "db-stage__body";
	body.dataset.viewKind = view.kind;

	const handleSelect = (entity: EntityRow, modifiers: SelectionModifiers) =>
		onSelectEntity(state, entity, modifiers);
	const handleOpen = (entity: EntityRow) => onOpenEntity(state, entity);
	const handleOpenInspector = (entity: EntityRow) => onOpenInspector(state, entity);

	const selectionCount = state.selection.selectedIds.size;
	const selection =
		selectionCount > 1
			? {
					count: selectionCount,
					clearLabel: "Clear",
					onClear: () => {
						state.selection = clearSelection();
						renderActiveView(state);
						renderInspector(state);
					},
				}
			: null;

	// Every active view kind is React now (some still delegate their body
	// painting to imperative renderers from `render/` via `<DomPaint>`,
	// but the React tree owns them as first-class components).
	let reactBody: ReactElement | null = null;
	// One inline-edit commit shared by every editable view (grid / list / board
	// / gallery) — a property edit persists the same way regardless of surface.
	const editProperty = (entity: EntityRow, propertyId: string, value: unknown): void => {
		// A locked record is read-only — every view's cell commit no-ops (the
		// lock toggle itself writes through `persistEntityPatch` directly).
		if (entity.properties?.locked === true) return;
		void persistEntityPatch(state, entity, { [propertyId]: value });
	};
	switch (view.kind) {
		case ListViewKind.Grid: {
			reactBody = createElement(GridView, {
				compiled: compiledView,
				columns: view.columns,
				allRows: state.db.entities,
				layout: view.layoutOptions as GridLayoutOptions,
				selectedIds: state.selection.selectedIds,
				pendingTitleEditId: state.pendingTitleEdit,
				onPendingTitleEditHandled: () => {
					state.pendingTitleEdit = null;
				},
				onSelect: handleSelect,
				onOpen: handleOpen,
				onOpenInspector: handleOpenInspector,
				onReorderColumns: (cols) => {
					updateViewColumns(state, view.id, cols);
					renderActiveView(state);
					schedulePersist(state);
				},
				onResizeColumn: (propertyId, width) => {
					updateViewColumns(
						state,
						view.id,
						view.columns.map((c) => (c.propertyId === propertyId ? { ...c, width } : c)),
					);
					renderActiveView(state);
					schedulePersist(state);
				},
				onReorderRows: (ids) => updateViewManualOrder(state, view.id, ids),
				onEdit: editProperty,
				onSetColumnAggregation: (propertyId, aggregation) => {
					updateViewColumns(
						state,
						view.id,
						view.columns.map((c) => (c.propertyId === propertyId ? { ...c, aggregation } : c)),
					);
					renderActiveView(state);
					schedulePersist(state);
				},
			});
			break;
		}
		case ListViewKind.List: {
			reactBody = createElement(ListViewComponent, {
				compiled: compiledView,
				columns: view.columns,
				layout: view.layoutOptions as ListLayoutOptions,
				selectedIds: state.selection.selectedIds,
				onSelect: handleSelect,
				onOpen: handleOpen,
				onEdit: editProperty,
			});
			break;
		}
		case ListViewKind.Gallery: {
			reactBody = createElement(GalleryView, {
				compiled: compiledView,
				columns: view.columns,
				layout: view.layoutOptions as GalleryLayoutOptions,
				coverProperty: view.coverProperty,
				subtitleProperty: view.cardSubtitleProperty,
				selectedIds: state.selection.selectedIds,
				onSelect: handleSelect,
				onOpen: handleOpen,
				onEdit: editProperty,
			});
			break;
		}
		case ListViewKind.Board: {
			if (!view.groupBy) break;
			const groupBy = view.groupBy;
			reactBody = createElement(BoardView, {
				compiled: compiledView,
				columns: view.columns,
				layout: view.layoutOptions as BoardLayoutOptions,
				groupBy,
				subtitleProperty: view.cardSubtitleProperty,
				selectedIds: state.selection.selectedIds,
				onSelect: handleSelect,
				onOpen: handleOpen,
				onMoveToGroup: (entity, key) => onMoveToGroup(state, view, entity, key),
				onReorderGroups: (order) => reorderBoardColumns(state, view, order),
				onDropObject: (key, payload) => {
					void onDropObjectToGroup(state, view, groupBy.propertyId, key, payload);
				},
				onEdit: editProperty,
			});
			break;
		}
		case ListViewKind.Calendar: {
			if (!view.groupBy) break;
			const groupBy = view.groupBy;
			reactBody = createElement(CalendarView, {
				compiled: compiledView,
				layout: view.layoutOptions as CalendarLayoutOptions,
				groupBy,
				cursorMonth: state.calendarCursor,
				selectedIds: state.selection.selectedIds,
				onSelect: handleSelect,
				onOpen: handleOpen,
				onPrev: () => {
					state.calendarCursor = shiftCalendar(
						state.calendarCursor,
						(view.layoutOptions as CalendarLayoutOptions).range,
						-1,
					);
					renderActiveView(state);
				},
				onNext: () => {
					state.calendarCursor = shiftCalendar(
						state.calendarCursor,
						(view.layoutOptions as CalendarLayoutOptions).range,
						1,
					);
					renderActiveView(state);
				},
				onToday: () => {
					state.calendarCursor = Date.now();
					renderActiveView(state);
				},
				onRangeChange: (range) => updateCalendarRange(state, view, range),
				onMoveToDay: (entity, dayStart) => onMoveToDay(state, view, entity, dayStart),
			});
			break;
		}
		case ListViewKind.Timeline: {
			reactBody = createElement(TimelineView, {
				compiled: compiledView,
				layout: view.layoutOptions as TimelineLayoutOptions,
				selectedIds: state.selection.selectedIds,
				onSelect: handleSelect,
				onOpen: handleOpen,
				onMoveItem: (entity, newStart, newEnd) => onTimelineMove(state, view, entity, newStart, newEnd),
				onResizeItem: (entity, newEnd) => onTimelineResize(state, view, entity, newEnd),
				links: state.db.links,
			});
			break;
		}
	}

	if (reactBody) {
		renderViewBodyReact(body, { selection, element: withProperties(state, reactBody) });
	} else {
		// `groupBy === null` for a Board/Calendar view falls through here (the
		// per-kind switch breaks early). Render a guiding empty-state — not a
		// blank stage — so the user learns why it's empty and how to fix it
		// (a Calendar/Board with no layout property used to paint a silent void).
		renderViewBodyReact(body, {
			selection,
			element: createElement(EmptyState, grouplessViewEmptyState(view.kind)),
		});
	}
}

/** Wrap a view body in `<PropertiesProvider>` so the inline editing cells
 *  (Tag / Date / Link / …) reach the vault's property + dictionary catalog.
 *  No-op when the shell didn't expose `services.properties` (standalone /
 *  preview) — cells then render read-only via `EditableCell`'s fallback. */
function withProperties(state: AppState, element: ReactElement): ReactElement {
	const svc = getRuntime()?.services?.properties;
	if (!svc) return element;
	// The shell runtime types `properties` more narrowly than the SDK's
	// `PropertiesService`; the provider only calls `list` / `onChange` to
	// hydrate and the cells' own write methods (`setDictionary` for inline
	// tag-create), all present at runtime.
	const properties = svc as unknown as PropertiesService;
	return createElement(PropertiesProvider, {
		runtime: { services: { properties } },
		entityTitleSource: getTitleSource(state),
		// biome-ignore lint/correctness/noChildrenProp: app.ts is .ts (no JSX); the createElement overload for a component with a required `children` prop only type-checks when `children` is in the props object, not the variadic 3rd arg.
		children: element,
	});
}

/** A live `EntityTitleSource` over the in-memory entities, built once and
 *  closing over the (mutated-in-place) `state` so the Link picker resolves
 *  titles against the current rows. */
let dbTitleSource: EntityTitleSource | null = null;
function getTitleSource(state: AppState): EntityTitleSource {
	if (dbTitleSource) return dbTitleSource;
	dbTitleSource = {
		subscribe: () => () => undefined,
		snapshotTick: () => state.db.entities.length,
		list: () => state.db.entities as unknown as VaultEntity[],
		titleOf: (id) => {
			const e = state.db.entities.find((x) => x.id === id);
			return e ? entityTitle(e) : undefined;
		},
		displayTitle: (e) => entityTitle(e as unknown as EntityRow),
	};
	return dbTitleSource;
}

function shiftCalendar(ms: number, range: CalendarRange, delta: number): number {
	const d = new Date(ms);
	if (range === CalendarRange.Week) {
		d.setDate(d.getDate() + 7 * delta);
		return d.getTime();
	}
	if (range === CalendarRange.Year) {
		d.setFullYear(d.getFullYear() + delta);
		return d.getTime();
	}
	d.setDate(1);
	d.setMonth(d.getMonth() + delta);
	return d.getTime();
}

function renderInspector(state: AppState): void {
	const body = document.getElementById("inspector-body");
	const title = document.getElementById("inspector-title");
	if (!body || !title) return;
	body.replaceChildren();
	// The lock toggle shows only for a single inspected record (wired below).
	const lockBtn = document.getElementById("inspector-lock") as HTMLButtonElement | null;
	if (lockBtn) lockBtn.hidden = true;

	const selected = state.selection.selectedIds;
	if (selected.size === 0) {
		// Nothing selected → nothing to inspect, so close the panel rather than
		// leave an empty shell open eating horizontal space (the reported
		// friction). The header toggle re-opens it (on the first row); the
		// title-cell "Open" affordance opens it on a specific row.
		title.textContent = "Details";
		if (state.chrome.inspectorOpen) {
			state.chrome.inspectorOpen = false;
			applyChrome(state);
			schedulePersist(state);
		}
		return;
	}

	if (selected.size > 1) {
		title.textContent = `${selected.size} selected`;
		const summary = document.createElement("p");
		summary.className = "db-inspector__empty";
		summary.textContent = `${selected.size} items selected. Use Cmd/Ctrl-click to toggle, Shift-click for ranges.`;
		body.appendChild(summary);
		const list = document.createElement("ul");
		list.className = "db-inspector__multi-list";
		let i = 0;
		for (const id of selected) {
			i += 1;
			if (i > 25) {
				const more = document.createElement("li");
				more.className = "db-inspector__multi-more";
				more.textContent = `+${selected.size - 25} more`;
				list.appendChild(more);
				break;
			}
			const entity = state.db.entities.find((e) => e.id === id);
			if (!entity) continue;
			const item = document.createElement("li");
			item.className = "db-inspector__multi-item";
			const iconEl = entityIcon(entity);
			if (iconEl) {
				const glyph = document.createElement("span");
				glyph.className = "db-inspector__multi-glyph";
				glyph.appendChild(iconEl);
				item.appendChild(glyph);
			}
			const label = document.createElement("span");
			label.className = "db-inspector__multi-label";
			label.textContent = entityTitle(entity);
			item.appendChild(label);
			list.appendChild(item);
		}
		body.appendChild(list);
		return;
	}

	const onlyId = [...selected][0];
	const entity = onlyId ? state.db.entities.find((e) => e.id === onlyId) : undefined;
	if (!entity) {
		title.textContent = "Details";
		const empty = document.createElement("p");
		empty.className = "db-inspector__empty";
		empty.textContent = "Selection is no longer in the dataset.";
		body.appendChild(empty);
		return;
	}

	// Read-only lock — the record's synced `locked` property. The shared
	// `editProperty` commit no-ops for a locked record, so its cells are
	// read-only across every view; here we surface the toggle + freeze rename.
	const recordLocked = entity.properties?.locked === true;
	if (lockBtn) {
		lockBtn.hidden = false;
		lockBtn.replaceChildren(createIconElement(IconName.Lock));
		lockBtn.setAttribute("aria-pressed", String(recordLocked));
		const lockLabel = recordLocked
			? t("brainstorm.database.record.unlock")
			: t("brainstorm.database.record.lock");
		lockBtn.setAttribute("aria-label", lockLabel);
		lockBtn.setAttribute("data-bs-tooltip", lockLabel);
		lockBtn.onclick = () => {
			void persistEntityPatch(state, entity, { locked: !recordLocked });
		};
	}

	// The inspector heading IS the rename field, for every entity type — the
	// properties panel is where you edit an object's fields, and the name is
	// one of them (a typed entity can still rename in its own app too). The
	// `activeElement` guard keeps an in-progress edit from being clobbered by a
	// re-render.
	if (title !== document.activeElement) {
		const current = entityTitle(entity);
		title.textContent = current;
		title.contentEditable = recordLocked ? "false" : "plaintext-only";
		title.spellcheck = false;
		title.setAttribute("role", "textbox");
		title.setAttribute("aria-label", "Name");
		title.onkeydown = (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				title.blur();
			} else if (event.key === "Escape") {
				event.preventDefault();
				title.textContent = current;
				title.blur();
			}
		};
		title.onblur = () => {
			const next = (title.textContent ?? "").trim();
			if (next && next !== current) void persistEntityPatch(state, entity, { name: next });
			else title.textContent = current;
		};
	}

	// Cover band — the object's OWN cover (`properties.cover`), with the
	// id-seeded gradient fallback baked into the renderer; click to edit.
	// Per-object-covers-everywhere: never keyed off `entity.type`.
	const coverBtn = document.createElement("button");
	coverBtn.type = "button";
	coverBtn.className = "db-inspector__cover";
	coverBtn.dataset.bsTooltip = "Change cover";
	coverBtn.setAttribute("aria-label", "Change cover");
	coverBtn.appendChild(createEntityCoverElement(entity, { aspect: 16 / 6 }));
	coverBtn.addEventListener("click", () => {
		openCoverPicker({
			value: coverOf(entity),
			covers: getRuntime()?.services?.covers ?? {
				uploadBytes: () => Promise.reject(new Error("covers service unavailable")),
				list: () => Promise.resolve([]),
			},
			onChange: (cover) => void persistEntityPatch(state, entity, { cover }),
		});
	});
	body.appendChild(coverBtn);

	const meta = document.createElement("div");
	meta.className = "db-inspector__meta";
	// The object's OWN icon — the type glyph is fallback-only.
	const iconBtn = document.createElement("button");
	iconBtn.type = "button";
	iconBtn.className = "db-inspector__icon-btn";
	iconBtn.dataset.bsTooltip = "Change icon";
	iconBtn.setAttribute("aria-label", "Change icon");
	// Empty icon slot shows the dashed-plus add affordance (not a blank box) so
	// it reads as "click to add an icon".
	const iconBtnEl = createEntityIconElement(readEntityIcon(entity), {
		size: 18,
		fallback: createAddIconGlyph,
	});
	iconBtn.appendChild(iconBtnEl ?? createAddIconGlyph());
	iconBtn.addEventListener("click", () => {
		openIconPicker({
			value: readEntityIcon(entity),
			onChange: (icon) => void persistEntityPatch(state, entity, { icon }),
		});
	});
	meta.appendChild(iconBtn);
	const typeBadge = document.createElement("span");
	typeBadge.className = "db-inspector__type";
	typeBadge.textContent = typeLabel(entity.type);
	meta.appendChild(typeBadge);
	body.appendChild(meta);

	const actions = document.createElement("div");
	actions.className = "db-inspector__actions";
	const open = document.createElement("button");
	open.type = "button";
	open.className = "db-inspector__open";
	open.textContent = `Open in ${TYPE_LABELS[entity.type] ?? "default app"}`;
	open.addEventListener("click", () => onOpenEntity(state, entity));
	actions.appendChild(open);
	const quick = document.createElement("button");
	quick.type = "button";
	quick.className = "db-inspector__open";
	quick.textContent = "Quick Look";
	quick.title = "Quick Look (Space)";
	quick.addEventListener("click", () => void dispatchQuickLook(entity));
	actions.appendChild(quick);
	body.appendChild(actions);

	// Property values are editable through the shared SDK cells (same as the
	// grid + properties panels), now hosted inside the shared
	// `EntityCommentsPanel` Properties|Comments tab strip (the tab labels the
	// section, replacing the old imperative "Properties" h3). The subtree mounts
	// into a persistent host (re-appended across re-renders so its root
	// reconciles); `withProperties` wraps it so Tag / Link editors reach the
	// vault catalog. `EditableCell` falls back to read-only paint for
	// untyped / array / system values, so a heterogeneous bag stays safe.
	if (!inspectorPropsHost) inspectorPropsHost = document.createElement("div");
	inspectorPropsHost.className = "db-inspector__props-host";
	body.appendChild(inspectorPropsHost);
	const services = getRuntime()?.services;
	mountInspectorProps(
		inspectorPropsHost,
		withProperties(
			state,
			createElement(EntityCommentsPanel, {
				services,
				documentId: entity.id,
				properties: () =>
					createElement(InspectorProperties, {
						entity,
						onEdit: (target, propertyId, value) =>
							void persistEntityPatch(state, target, { [propertyId]: value }),
					}),
			}),
		),
	);

	body.appendChild(renderInspectorCollectionsSection(state, entity));

	const backlinks = renderInspectorBacklinksSection(state, entity);
	if (backlinks) body.appendChild(backlinks);

	const metaHeader = document.createElement("h3");
	metaHeader.className = "db-inspector__section-title";
	metaHeader.textContent = "System";
	body.appendChild(metaHeader);

	const metaList = document.createElement("dl");
	metaList.className = "db-inspector__props db-inspector__props--meta";
	const dt1 = document.createElement("dt");
	dt1.textContent = "Created";
	const dd1 = document.createElement("dd");
	dd1.textContent = formatDateTime(entity.createdAt);
	metaList.append(dt1, dd1);
	if (entity.updatedAt !== entity.createdAt) {
		const dt2 = document.createElement("dt");
		dt2.textContent = "Updated";
		const dd2 = document.createElement("dd");
		dd2.textContent = formatDateTime(entity.updatedAt);
		metaList.append(dt2, dd2);
	}
	const dt3 = document.createElement("dt");
	dt3.textContent = "ID";
	const dd3 = document.createElement("dd");
	dd3.className = "db-inspector__mono";
	dd3.textContent = entity.id;
	metaList.append(dt3, dd3);
	body.appendChild(metaList);
}

/** Persistent host for the inspector's React property list — created once,
 *  re-appended each `renderInspector` so `mountInspectorProps` reconciles
 *  instead of remounting. */
let inspectorPropsHost: HTMLElement | null = null;

/* ── 9.3.5.U: multi-membership UX ─────────────────────────────────────────
 *
 * Inspector "Collections" section — the reverse "collections containing
 * this object" panel from the 9.3.5.U scope. For the selected entity it
 * lists every List that effectively contains it (Source / Include) plus
 * any Lists actively excluding it (Excluded). Each row navigates to the
 * List on click and has an inline remove button that maps to the
 * minimum-write `removeFromList` / `addToList` op. The footer
 * "+ Add to collection…" button opens an anchored picker of Lists not
 * already containing the entity.
 *
 * Vault-derived "all X of type Y" lists are surfaced read-only — they
 * can't be removed-from (the membership IS the type), but they answer
 * the user's "what lists am I in?" question honestly.
 *
 * The DOM renderer lives in `ui/inspector-collections.ts` so it can be
 * driven by tests without booting the whole app. This function wires
 * the host side-effects (state mutation, picker open) into the renderer's
 * `InspectorCollectionsBindings`.
 */

function renderInspectorCollectionsSection(state: AppState, entity: EntityRow): HTMLElement {
	return renderInspectorCollections({
		entityId: entity.id,
		lists: state.lists,
		db: state.db,
		isVaultDerivedListId,
		createListIcon: (list, size) => listIconElement(list, size),
		createCloseIcon: (size) => createSharedIcon(IconName.Close, { size }),
		createPlusIcon: (size) => createSharedIcon(IconName.Plus, { size }),
		onSelectList: (listId) => selectList(state, listId),
		onToggleEntityInList: (listId, add) => toggleEntityInList(state, listId, entity, add),
		onAddRequest: (point) => openAddToCollectionMenu(state, entity, point),
	});
}

/* ── 9.12.22: reverse typed-relation browse ───────────────────────────────
 *
 * Inspector "Referenced by" section — the entity-to-entity complement of the
 * Collections panel (which answers list membership). For the selected entity
 * it lists every other entity that points AT it through one of its EntityRef
 * properties (`backlinksFor`), the reverse of the rollup's forward walk. Each
 * row names the source object + the relation it links through, and clicking it
 * focuses that object's inspector. Returns `null` when nothing references the
 * entity (no empty heading). */
function renderInspectorBacklinksSection(state: AppState, entity: EntityRow): HTMLElement | null {
	const backlinks = backlinksFor(entity.id, state.db.entities);
	if (backlinks.length === 0) return null;

	const section = document.createElement("section");
	section.className = "db-inspector__backlinks";
	section.dataset.testid = "db-inspector-backlinks";

	const title = document.createElement("h3");
	title.className = "db-inspector__section-title";
	title.textContent = "Referenced by";
	section.appendChild(title);

	const ul = document.createElement("ul");
	ul.className = "db-inspector__backlinks-list";
	for (const link of backlinks) {
		ul.appendChild(renderBacklinkRow(state, link));
	}
	section.appendChild(ul);
	return section;
}

function renderBacklinkRow(state: AppState, { source, relationKey }: Backlink): HTMLElement {
	const li = document.createElement("li");
	li.className = "db-inspector__backlink";

	const button = document.createElement("button");
	button.type = "button";
	button.className = "db-inspector__backlink-link";
	button.title = `Open ${entityTitle(source)}`;
	button.addEventListener("click", () => onOpenInspector(state, source));

	const glyph = document.createElement("span");
	glyph.className = "db-inspector__backlink-glyph";
	const icon = entityIcon(source);
	if (icon) glyph.appendChild(icon);
	button.appendChild(glyph);

	const label = document.createElement("span");
	label.className = "db-inspector__backlink-label";
	label.textContent = entityTitle(source);
	button.appendChild(label);

	const rel = document.createElement("span");
	rel.className = "db-inspector__backlink-rel";
	rel.textContent = `via ${propertyDisplayName(relationKey)}`;
	button.appendChild(rel);

	li.appendChild(button);
	return li;
}

function openAddToCollectionMenu(
	state: AppState,
	entity: EntityRow,
	point: { x: number; y: number },
): void {
	const candidates = pickerCandidatesForEntity(
		entity.id,
		state.lists,
		state.db,
		isVaultDerivedListId,
	);

	if (candidates.length === 0) {
		flashStatus("No more user collections to add to", "warn");
		return;
	}

	openAnchoredMenu(
		point,
		candidates.map((list) => ({
			label: list.name,
			onSelect: () => toggleEntityInList(state, list.id, entity, true),
		})),
		{ menuLabel: "Add to collection" },
	);
}

/** Commit a single add/remove against a List's `members` overrides.
 *  Decision is pure (`decideToggleMembership`); this wrapper applies the
 *  decision to `state.lists` and re-renders the surfaces that reflect
 *  membership. */
function toggleEntityInList(
	state: AppState,
	listId: string,
	entity: EntityRow,
	add: boolean,
): void {
	const decision = decideToggleMembership({
		listId,
		entityId: entity.id,
		add,
		lists: state.lists,
		db: state.db,
		isVaultDerived: isVaultDerivedListId,
	});
	if (decision.kind === "skip") return;

	const { next, verb } = decision;
	state.lists = state.lists.map((l) => (l.id === listId ? next : l));

	// The active list's effective member set may have changed — rebuild the
	// active view and the inspector + status bar to reflect it.
	renderActiveView(state);
	renderInspector(state);
	schedulePersist(state);

	flashStatus(`${verb} "${entity.id}" ${add ? "to" : "from"} "${next.name}"`, "ready");
}

/* ── Selection / open / chrome ─────────────────────────────────────────── */

function onSelectEntity(state: AppState, entity: EntityRow, modifiers: SelectionModifiers): void {
	const ordered = orderedVisibleIds(state);
	state.selection = applyClick(state.selection, entity.id, modifiers, ordered);
	// Selecting a row/cell must NOT open the inspector (F-023, owner ruling):
	// the auto-open turned editing the rightmost column into a close→click→
	// it-reopens fight and the open overlay swallowed clicks on the cells
	// beneath. The panel opens only on a deliberate action — the title cell's
	// "Open" affordance (onOpenInspector), the header toggle, or double-click.
	renderInspector(state);
	repaintSelection(state);
	updateSelectionBar(state);
}

/** Open the Details inspector for a single row — the explicit Notion
 *  "Open" affordance in the title cell (F-023). Selects the row and opens the
 *  right panel, but unlike `onOpenEntity` does NOT dispatch a cross-app open
 *  intent: this is the in-Database "peek", not "open it in its own app". */
function onOpenInspector(state: AppState, entity: EntityRow): void {
	state.selection = applyClick(
		state.selection,
		entity.id,
		{ shiftKey: false, metaKey: false },
		orderedVisibleIds(state),
	);
	state.chrome.inspectorOpen = true;
	applyChrome(state);
	renderInspector(state);
	repaintSelection(state);
	updateSelectionBar(state);
}

function orderedVisibleIds(state: AppState): string[] {
	const compiled = compileActive(state);
	if (!compiled) return [];
	const view = compiled.view;
	const compiledView = compileViewCached(
		view,
		compiled.entities,
		groupLabelResolver(state),
		groupOrderResolver(state),
	);
	if (compiledView.groups.length === 0) return compiledView.rows.map((e) => e.id);
	const out: string[] = [];
	for (const group of compiledView.groups) {
		for (const entity of group.rows) out.push(entity.id);
	}
	return out;
}

function repaintSelection(state: AppState): void {
	const body = document.getElementById("stage-body");
	if (!body) return;
	const rows = body.querySelectorAll<HTMLElement>("[data-entity-id]");
	for (const row of Array.from(rows)) {
		if (row.dataset.entityId && state.selection.selectedIds.has(row.dataset.entityId))
			row.dataset.selected = "true";
		else delete row.dataset.selected;
	}
}

function updateSelectionBar(state: AppState): void {
	const body = document.getElementById("stage-body");
	if (!body) return;
	let bar = body.querySelector<HTMLElement>(".db-selection-bar");
	const count = state.selection.selectedIds.size;
	if (count <= 1) {
		bar?.remove();
		return;
	}
	if (!bar) {
		bar = document.createElement("div");
		bar.className = "db-selection-bar";
		const text = document.createElement("span");
		text.className = "db-selection-bar__count";
		bar.appendChild(text);
		const clear = document.createElement("button");
		clear.type = "button";
		clear.className = "bs-btn bs-btn--secondary bs-btn--sm db-selection-bar__clear";
		clear.textContent = "Clear";
		clear.addEventListener("click", () => {
			state.selection = clearSelection();
			renderActiveView(state);
			renderInspector(state);
		});
		bar.appendChild(clear);
		body.prepend(bar);
	}
	const text = bar.querySelector<HTMLElement>(".db-selection-bar__count");
	if (text) text.textContent = `${count} selected`;
}

function onOpenEntity(state: AppState, entity: EntityRow): void {
	void dispatchOpenIntent(entity);
	state.selection = applyClick(
		state.selection,
		entity.id,
		{ shiftKey: false, metaKey: false },
		orderedVisibleIds(state),
	);
	state.chrome.inspectorOpen = true;
	applyChrome(state);
	renderInspector(state);
	repaintSelection(state);
}

/**
 * The shared **object menu** (Stage 7.13, §Object menu).
 * One delegated `contextmenu` on the stable stage body covers every
 * view kind (grid / list / gallery / board / calendar / timeline) —
 * each renders rows with `data-entity-id`, so there's a single
 * integration point, not one per renderer. Items come from
 * `@brainstorm/sdk/object-menu` so Database, the shell, and every other
 * app show the *same* Open / Pin·Unpin (/ future Print…) in the same
 * order with the same behaviour. Bound once at boot (the body element
 * survives `replaceChildren` across re-renders).
 */
function bindStageObjectMenu(state: AppState): void {
	const body = document.getElementById("stage-body");
	if (!body || body.dataset.objectMenuBound === "true") return;
	body.dataset.objectMenuBound = "true";
	body.addEventListener("contextmenu", (event) => {
		const el = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-entity-id]");
		const entityId = el?.dataset.entityId;
		if (!entityId) return;
		const entity = state.db.entities.find((e) => e.id === entityId);
		if (!entity) return;
		event.preventDefault();
		// 9.12.5 — member-override affordance on the row menu (
		// database/10 §Removing an entity from a List): a user list's row
		// offers "Hide from list" when the source matches it (→ exclude) or
		// "Remove from list" when it's only pinned in (→ drop include).
		// Vault-derived type-Lists are read-only membership (the membership
		// IS the type), so they get no item.
		const list = activeList(state);
		// Which app-owned items this row gets — pure + unit-tested
		// (`logic/row-menu.ts`): Rename where the grid title editor exists
		// (F-216), membership toggle on user lists only, Delete always (F-217).
		const plan = rowMenuPlan({
			entityType: entity.type,
			viewKind: activeView(state)?.kind,
			listId: list?.id,
			isVaultDerived: isVaultDerivedListId,
		});
		const membershipItems =
			plan.offerMembershipToggle && list
				? [
						{
							id: "remove-from-list",
							label: sourceMatches(entity.id, list, state.db)
								? `Hide from "${list.name}"`
								: `Remove from "${list.name}"`,
							icon: IconName.Close,
							run: () => toggleEntityInList(state, list.id, entity, false),
						},
					]
				: [];
		const renameItems = plan.offerRename
			? [
					{
						id: "rename",
						label: t("brainstorm.database.menu.rename"),
						icon: IconName.Pencil,
						run: () => beginRowTitleEdit(state, entity.id),
					},
				]
			: [];
		// One shared renderer: it pre-fetches the pin state and builds the
		// same Open / Pin·Unpin / … items every app shows, in the same
		// glass chrome (was a private hand-rolled map onto `openContextMenu`).
		const extraItems = [...renameItems, ...membershipItems];
		const runtime = getRuntime();
		const collectionsService = runtime?.services?.entities;
		void openObjectMenu(
			{ x: event.clientX, y: event.clientY },
			{
				target: { entityId, entityType: entity.type },
				runtime,
				labels: {
					remove: t("brainstorm.database.menu.delete"),
					addToCollection: t("brainstorm.database.menu.addToCollection"),
					collectionsRegion: t("brainstorm.database.menu.collectionsRegion"),
					noCollections: t("brainstorm.database.menu.noCollections"),
				},
				// F-217 — the app-owned destructive slot actually DELETES the
				// entity (after a confirm); "Remove from list" above only
				// unpins it, which left orphan Objects in the vault.
				onRemove: () => confirmDeleteEntity(state, entity),
				// DND-6 — the keyboard/a11y twin of "drop onto a collection": the
				// shared "Add to collection…" picker writes the same manual
				// membership (Database already holds `entities.write:List/v1`).
				...(collectionsService
					? {
							collections: {
								service: collectionsService as unknown as CollectionsEntitiesService,
								appId: runtime?.app?.id ?? "io.brainstorm.database",
							},
						}
					: {}),
				...(extraItems.length > 0 ? { extraItems } : {}),
			},
		);
	});
}

/** Open the grid title editor on a row, from the row menu (F-216). Same
 *  pending-edit seam the create flow uses; the grid consumes it on paint. */
function beginRowTitleEdit(state: AppState, entityId: string): void {
	state.pendingTitleEdit = entityId;
	renderActiveView(state);
}

/** F-217 — Delete on the row menu, behind an explicit confirm (the shared
 *  popover chrome, danger-styled primary — the Files pattern). Deleting is
 *  vault-wide: the entity leaves every list, search, and the graph. */
function confirmDeleteEntity(state: AppState, entity: EntityRow): void {
	const name = entityTitle(entity);
	const actions = document.createElement("div");
	actions.className = "db-confirm__actions";
	const cancelBtn = document.createElement("button");
	cancelBtn.type = "button";
	cancelBtn.className = "bs-btn bs-btn--ghost";
	cancelBtn.textContent = t("brainstorm.database.delete.cancel");
	const confirmBtn = document.createElement("button");
	confirmBtn.type = "button";
	confirmBtn.className = "bs-btn bs-btn--danger";
	confirmBtn.textContent = t("brainstorm.database.delete.confirm");
	actions.append(cancelBtn, confirmBtn);
	const handle = createPopoverElement({
		title: t("brainstorm.database.delete.title"),
		body: t("brainstorm.database.delete.body", { name }),
		footer: actions,
		size: PopoverSize.Small,
		testId: "delete-entity-confirm",
		onClose: () => handle.close(),
	});
	cancelBtn.addEventListener("click", () => handle.close());
	confirmBtn.addEventListener("click", () => {
		handle.close();
		void deleteEntity(state, entity);
	});
	confirmBtn.focus();
}

/** Hard-delete an entity through the shared `entities` service (the same
 *  call shape Files persists `deleteIds` through), then optimistically drop
 *  it from the in-memory mirror so the row disappears without waiting for
 *  the vault round-trip. */
async function deleteEntity(state: AppState, entity: EntityRow): Promise<void> {
	const entities = getRuntime()?.services?.entities;
	const del = entities?.delete;
	if (!del) {
		flashStatus(t("brainstorm.database.delete.unavailable"), "warn");
		return;
	}
	const name = entityTitle(entity);
	try {
		await del.call(entities, entity.id);
		state.db = {
			...state.db,
			entities: state.db.entities.filter((e) => e.id !== entity.id),
		};
		if (state.selection.selectedIds.has(entity.id)) {
			state.selection = clearSelection();
		}
		resetCompileCache();
		renderListNav(state);
		renderActiveView(state);
		renderStageHeader(state);
		renderInspector(state);
		await loadVaultEntities(state);
		flashStatus(t("brainstorm.database.delete.done", { name }), "ready");
	} catch (error) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		flashStatus(t("brainstorm.database.delete.failed", { message }), "warn");
	}
}

/** Wire the SHARED cross-app object menu to the header's open-list
 *  subtitle — right-click anywhere on the subtitle opens it — and place
 *  the ⋯ overflow button in `.app-header__right` so the header chrome
 *  reads identically across apps: object identity on the left, controls
 *  + ⋯ on the right (never glued to the title). App-specific
 *  Rename/Duplicate stay on the sidebar row context menu. */
function bindHeaderObjectMenu(state: AppState): void {
	const subtitle = document.getElementById("active-list-name");
	if (!subtitle || subtitle.dataset.objectMenuBound === "true") return;
	subtitle.dataset.objectMenuBound = "true";
	const runtime = getRuntime();
	if (!runtime) return;
	const menu = attachObjectMenuTrigger(
		subtitle,
		() => {
			const list = activeList(state);
			if (!list) return null;
			const canDelete = state.lists.length > 1;
			const extraItems = buildHeaderExtraItems(state, list);
			return {
				target: { entityId: list.id, entityType: COLLECTION_TYPE_URL, label: list.name },
				runtime,
				...(canDelete ? { onRemove: () => deleteListAndCleanup(state, list) } : {}),
				...(extraItems.length > 0 ? { extraItems } : {}),
			};
		},
		{ moreActionsLabel: "More actions" },
	);
	const headerRight = document.querySelector<HTMLElement>(".app-header__right");
	headerRight?.appendChild(menu.moreButton);
}

/** 9.12.16-UI — surface "Import contacts…" on the active list's object
 *  menu when (a) the list targets `Person/v1` (the only mapper today;
 *  the registry's other consumers will follow the same pattern) and
 *  (b) the host shell exposes both `services.files` and
 *  `services.entities` (the create-flow surface). Otherwise the item
 *  hides entirely — explained-no-show beats a greyed-out option that
 *  the user can't action. */
function buildHeaderExtraItems(
	state: AppState,
	list: List,
): { id: string; label: string; icon?: IconName; run: () => void | Promise<void> }[] {
	const items: { id: string; label: string; icon?: IconName; run: () => void | Promise<void> }[] =
		[];

	// Embed-this-list affordance (mirrors Calendar 9.15.3): copy the canonical
	// `brainstorm://entity/<listId>` URI so a host document (e.g. a Notes doc)
	// can paste it and mount this list inline as a live grid via the
	// `io.brainstorm.database/embedded-list` BP block (served by the bsblock://
	// loader). No files/entities services required — clipboard-only.
	items.push({
		id: "copy-block-ref",
		label: "Copy embed link",
		icon: IconName.Copy,
		run: async () => {
			if (await copyListBlockRef(list.id)) {
				flashStatus("Embed link copied — paste into a document to embed this list", "ready");
			}
		},
	});

	const runtime = getRuntime();
	const files = runtime?.services?.files;
	const entities = runtime?.services?.entities;
	if (!files || !entities) return items;

	// Export the active view's rows (any list) through one popover that owns
	// format choice + per-format options (column subset, CSV header/delimiter,
	// JSON pretty-print). Replaces the three flat "Export as X…" menu rows.
	const compiled = compileActive(state);
	if (compiled) {
		const { view, entities: viewEntities } = compiled;
		const compiledView = compileViewCached(
			view,
			viewEntities,
			groupLabelResolver(state),
			groupOrderResolver(state),
		);
		// Every exportable column (any visibility); the default selection is the
		// columns currently visible in the view.
		const exportableColumns = view.columns.filter(
			(c) => c.propertyId !== "title" && c.propertyId !== "name",
		);
		const columnChoices = exportableColumns.map((c) => ({
			value: c.propertyId,
			label: propertyDisplayName(c.propertyId),
		}));
		const visibleColumnIds = exportableColumns
			.filter((c) => c.visible !== false)
			.map((c) => c.propertyId);
		items.push({
			id: "export",
			label: "Export…",
			icon: IconName.Download,
			run: () =>
				void openExportPopover({
					spec: {
						commonOptions: [
							{
								kind: ExportOptionKind.Select,
								id: "scope",
								label: "Rows",
								choices: [
									{ value: "view", label: "Current view" },
									{ value: "all", label: "All rows in list" },
								],
								default: "view",
							},
							{
								kind: ExportOptionKind.Checklist,
								id: "columns",
								label: "Columns",
								choices: columnChoices,
								default: visibleColumnIds,
							},
						],
						formats: [
							{
								id: ListExportFormat.Csv,
								label: "CSV",
								options: [
									{
										kind: ExportOptionKind.Toggle,
										id: "header",
										label: "Include header row",
										default: true,
									},
									{
										kind: ExportOptionKind.Select,
										id: "delimiter",
										label: "Delimiter",
										choices: [
											{ value: ",", label: "Comma" },
											{ value: ";", label: "Semicolon" },
											{ value: "\t", label: "Tab" },
										],
										default: ",",
									},
								],
							},
							{
								id: ListExportFormat.Json,
								label: "JSON",
								options: [
									{
										kind: ExportOptionKind.Toggle,
										id: "pretty",
										label: "Pretty-print",
										default: true,
									},
								],
							},
							{ id: ListExportFormat.Markdown, label: "Markdown" },
						],
					},
					labels: {
						title: "Export list",
						formatLegend: "Format",
						exportAction: "Export",
						cancel: "Cancel",
					},
					onExport: ({ formatId, values }) => {
						const selected = new Set(Array.isArray(values.columns) ? (values.columns as string[]) : []);
						const columns = exportableColumns
							.filter((c) => selected.has(c.propertyId))
							.map((c) => ({ key: c.propertyId, header: propertyDisplayName(c.propertyId) }));
						const options: ListExportOptions = {
							csvIncludeHeader: values.header !== false,
							csvDelimiter: typeof values.delimiter === "string" ? values.delimiter : ",",
							jsonPretty: values.pretty !== false,
						};
						// "Current view" = the filtered + sorted rows on screen; "All rows
						// in list" = the full list membership before the view's filter.
						const rows = values.scope === "all" ? viewEntities : compiledView.rows;
						void runListExport({
							files,
							rows,
							columns,
							titleOf: (row) => entityTitle(row),
							listTitle: list.name,
							format: formatId as ListExportFormat,
							options,
							notify: (message) => flashStatus(message, "ready"),
						});
					},
				}),
		});
	}

	const source = list.source;
	if (!source || source.kind !== ListSourceKind.ByType) return items;
	if (!source.types.includes(PERSON_TYPE)) return items;
	items.push({
		id: "import-contacts",
		label: "Import contacts (vCard / CSV)…",
		icon: IconName.Inbox,
		run: () =>
			void runImportFlow(
				{
					files,
					entities,
					existing: state.db.entities
						.filter((e) => e.type === PERSON_TYPE)
						.map((e) => ({ id: e.id, properties: e.properties as Record<string, unknown> })),
					targetType: PERSON_TYPE,
					targetTypeLabel: "Contacts",
					notify: flashStatus,
					onCommitted: () => loadVaultEntities(state),
				},
				{
					title: "Import contacts",
					filterName: "Contacts (vCard / CSV)",
				},
			),
	});
	return items;
}

// Shared in-app back/forward (`@brainstorm/sdk/nav-history`) — same model
// + header chrome + chords as every other first-party app. The active
// {list, view} pair IS the navigable location. `applyingDbNav` guards the
// history-driven path so `selectList`/`selectView` (the user-nav
// recorders) don't re-record while a stepped-to location is being applied.
type DbNavLoc = { listId: string; viewId: string };

function recordDbNav(state: AppState): void {
	if (applyingDbNav || !dbNav) return;
	const loc = { listId: state.active.listId, viewId: state.active.viewId };
	// Empty origin (vault not loaded yet) → reset so "back" never lands on
	// the honest-empty no-list state once a real list is open.
	if (dbNav.current().listId === "") dbNav.reset(loc);
	else dbNav.push(loc);
}

function applyDbNav(state: AppState, loc: DbNavLoc): void {
	applyingDbNav = true;
	try {
		if (state.active.listId !== loc.listId) selectList(state, loc.listId);
		if (state.active.viewId !== loc.viewId) selectView(state, loc.viewId);
	} finally {
		applyingDbNav = false;
	}
}

function selectList(state: AppState, listId: string): void {
	if (state.active.listId === listId) return;
	const list = state.lists.find((l) => l.id === listId);
	if (!list) return;
	const views = viewsForList(state, listId);
	const desiredViewId = resolveListView(
		views,
		persistedUserDeltas.lastViewByList[listId],
		list.defaultViewId,
	);
	if (!desiredViewId) return;
	state.active = { listId, viewId: desiredViewId };
	state.selection = clearSelection();
	closeViewSettings();
	renderListNav(state);
	renderViewTabs(state);
	renderStageHeader(state);
	renderActiveView(state);
	renderInspector(state);
	schedulePersist(state);
	recordDbNav(state);
}

function selectView(state: AppState, viewId: string): void {
	if (state.active.viewId === viewId) return;
	const view = state.views.find((v) => v.id === viewId);
	if (!view) return;
	state.active = { listId: state.active.listId, viewId };
	state.selection = clearSelection();
	closeViewSettings();
	renderViewTabs(state);
	renderActiveView(state);
	renderInspector(state);
	schedulePersist(state);
	recordDbNav(state);
}

function applyChrome(state: AppState): void {
	const main = document.getElementById("db-main");
	if (main) {
		main.dataset.sidebarOpen = String(state.chrome.sidebarOpen);
		main.dataset.inspectorOpen = String(state.chrome.inspectorOpen);
	}
	writeBoolPref(LS_SIDEBAR_OPEN_KEY, state.chrome.sidebarOpen);
	const sidebarBtn = document.getElementById("header-btn-sidebar");
	const inspectorBtn = document.getElementById("header-btn-inspector");
	if (sidebarBtn) {
		sidebarBtn.setAttribute("aria-pressed", String(state.chrome.sidebarOpen));
		sidebarBtn.replaceChildren(panelToggleIcon(PanelSide.Left, state.chrome.sidebarOpen));
	}
	if (inspectorBtn) {
		inspectorBtn.setAttribute("aria-pressed", String(state.chrome.inspectorOpen));
		inspectorBtn.replaceChildren(panelToggleIcon(PanelSide.Right, state.chrome.inspectorOpen));
	}
}

/* ── View mutations (calendar drag, board drag, settings popover) ──── */

function onMoveToGroup(
	state: AppState,
	view: ListView,
	entity: EntityRow,
	groupKey: string | null,
): void {
	if (!view.groupBy) return;
	mutateEntityProperty(state, entity.id, view.groupBy.propertyId, groupKey ?? "");
	renderActiveView(state);
	renderInspector(state);
	flashStatus(groupKey === null ? "Cleared group" : `Moved to "${groupKey}"`, "ready");
}

/** DND-4 — a cross-app object dropped on a board column. Unlike `onMoveToGroup`
 *  (a native intra-app card move, entity already in this database), the dropped
 *  object may be FOREIGN, so the group property is written through the entities
 *  service (by id, capability-gated) and the object is pinned into the active
 *  collection's manual members so it surfaces in the column. */
async function onDropObjectToGroup(
	state: AppState,
	_view: ListView,
	propertyId: string,
	groupKey: string | null,
	payload: ObjectDragPayload,
): Promise<void> {
	const update = getRuntime()?.services?.entities?.update;
	if (!update) {
		flashStatus("Drop needs the entities service (not exposed by this shell)", "warn");
		return;
	}
	const list = activeList(state);
	const groupValue = groupKey ?? "";
	const now = Date.now();
	let members = list?.members;
	let added = 0;
	for (const item of payload.items) {
		try {
			await update(item.entityId, { [propertyId]: groupValue });
		} catch {
			continue; // a write the target can't make (fail-closed cap) — skip it
		}
		if (members)
			members = addToList(members, item.entityId, { matchesSource: false, by: "user", now }).members;
		added += 1;
	}
	if (added === 0) return;
	if (list && members) {
		const committed = members;
		state.lists = state.lists.map((l) =>
			l.id === list.id ? { ...l, members: committed, updatedAt: now } : l,
		);
		schedulePersist(state);
	}
	await loadVaultEntities(state);
	renderActiveView(state);
	renderInspector(state);
	flashStatus(groupKey === null ? "Added to column" : `Added to "${groupKey}"`, "ready");
}

function onMoveToDay(state: AppState, view: ListView, entity: EntityRow, dayStart: number): void {
	// The calendar buckets by `layoutOptions.primaryDateProperty` (the date
	// axis), NOT `groupBy` (that's only the colour fallback). Writing
	// groupBy here clobbered `statusKey` with a timestamp and the pill
	// never moved — i.e. drag looked broken.
	const dateProp = (view.layoutOptions as CalendarLayoutOptions)?.primaryDateProperty;
	if (!dateProp) return;
	mutateEntityProperty(state, entity.id, dateProp, dayStart);
	renderActiveView(state);
	renderInspector(state);
	flashStatus(`Moved to ${formatDate(dayStart)}`, "ready");
}

/** 9.12.10 — timeline bar drag-to-move: writes the whole-day-shifted
 *  dates back to the entity's primary (and, for spans, end) date
 *  properties — the horizontal analogue of the calendar's `onMoveToDay`. */
function onTimelineMove(
	state: AppState,
	view: ListView,
	entity: EntityRow,
	newStartMs: number,
	newEndMs: number | null,
): void {
	const layout = view.layoutOptions as TimelineLayoutOptions;
	if (!layout?.primaryDateProperty) return;
	mutateEntityProperty(state, entity.id, layout.primaryDateProperty, newStartMs);
	if (newEndMs !== null && layout.endDateProperty) {
		mutateEntityProperty(state, entity.id, layout.endDateProperty, newEndMs);
	}
	renderActiveView(state);
	renderInspector(state);
	flashStatus(`Moved to ${formatDate(newStartMs)}`, "ready");
}

/** 9.12.10 — timeline edge drag-to-resize: writes the resized span end
 *  (already clamped ≥ start by the drag math). */
function onTimelineResize(
	state: AppState,
	view: ListView,
	entity: EntityRow,
	newEndMs: number,
): void {
	const layout = view.layoutOptions as TimelineLayoutOptions;
	if (!layout?.endDateProperty) return;
	mutateEntityProperty(state, entity.id, layout.endDateProperty, newEndMs);
	renderActiveView(state);
	renderInspector(state);
	flashStatus(`Resized to end ${formatDate(newEndMs)}`, "ready");
}

function updateCalendarRange(state: AppState, view: ListView, range: CalendarRange): void {
	const next: CalendarLayoutOptions = {
		...(view.layoutOptions as CalendarLayoutOptions),
		range,
	};
	updateViewLayout(state, view.id, next);
	renderActiveView(state);
	schedulePersist(state);
}

function reorderBoardColumns(state: AppState, view: ListView, orderedKeys: string[]): void {
	const next: BoardLayoutOptions = {
		...(view.layoutOptions as BoardLayoutOptions),
		groupOrder: orderedKeys,
	};
	updateViewLayout(state, view.id, next);
	renderActiveView(state);
	schedulePersist(state);
}

/** Apply one pure `ViewConfigChange` to the live view by id and store the
 *  result. The `findIndex` / guard / immutable-update arithmetic lives here
 *  once; the transform itself is `applyViewConfig`. `rows` feeds the
 *  Board/Calendar auto-axis on a `SetKind` change. */
function mutateView(
	state: AppState,
	viewId: string,
	change: ViewConfigChange,
	rows?: ReadonlyArray<EntityRow>,
): void {
	const idx = state.views.findIndex((v) => v.id === viewId);
	if (idx === -1) return;
	const prev = state.views[idx];
	if (!prev) return;
	// Sibling views of the same list feed the Timeline date auto-bind on a
	// `SetKind` change (an existing Calendar's axis wins — F-211).
	const siblings = state.views.filter((v) => v.listId === prev.listId && v.id !== prev.id);
	state.views[idx] = applyViewConfig(prev, change, rows, siblings);
}

function updateViewLayout(
	state: AppState,
	viewId: string,
	layout: ListView["layoutOptions"],
): void {
	mutateView(state, viewId, { action: ViewConfigAction.SetLayout, layoutOptions: layout });
}

function updateViewColumns(state: AppState, viewId: string, columns: ListView["columns"]): void {
	mutateView(state, viewId, { action: ViewConfigAction.SetColumns, columns });
}

function updateViewGroupBy(state: AppState, viewId: string, groupBy: ListView["groupBy"]): void {
	mutateView(state, viewId, { action: ViewConfigAction.SetGroupBy, groupBy });
}

function updateViewCardFields(
	state: AppState,
	viewId: string,
	fields: Partial<Pick<ListView, "coverProperty" | "cardSubtitleProperty">>,
): void {
	mutateView(state, viewId, { action: ViewConfigAction.SetCardFields, fields });
}

function updateViewSorts(state: AppState, viewId: string, sorts: ListView["sorts"]): void {
	mutateView(state, viewId, { action: ViewConfigAction.SetSorts, sorts });
	renderActiveView(state);
	renderViewTabs(state);
	schedulePersist(state);
}

function updateViewManualOrder(state: AppState, viewId: string, orderedIds: string[]): void {
	mutateView(state, viewId, { action: ViewConfigAction.SetManualOrder, order: orderedIds });
	renderActiveView(state);
	schedulePersist(state);
}

function updateViewFilters(state: AppState, viewId: string, filters: ListView["filters"]): void {
	mutateView(state, viewId, { action: ViewConfigAction.SetFilters, filters });
	renderActiveView(state);
	renderViewTabs(state);
	schedulePersist(state);
}

function colLabel(propertyId: string): string {
	return propertyId === "__title__" ? "Name" : propertyDisplayName(propertyId);
}

function commitFilterDraft(state: AppState, viewId: string, draft: FilterDraft): void {
	updateViewFilters(state, viewId, draftToFilterNode(draft));
}

/** Filter v2 — a multi-rule builder over the full predicate language
 *  (`filter-builder.ts` is the pure model; this is the throwaway menu
 *  chain until fancy-menus). Top menu lists each live rule (click to
 *  delete) + a match-ALL/ANY toggle + "Add rule" + "Clear". "Add rule"
 *  walks property → operator → value. v1's single-`$contains` view loads
 *  as a one-rule AND draft, so persisted views need no migration. */
/** Open a submenu from within another menu's item click. The fancy-menu runtime
 *  closes the active menu on select AFTER the click handler returns, which tears
 *  down a submenu opened synchronously in that handler — so defer one frame. Without
 *  this the filter-builder cascade (Add filter rule → property → operator) silently
 *  closed with no submenu, making filtering impossible (F-026). */
function openSubmenuNextFrame(open: () => void): void {
	requestAnimationFrame(open);
}

function openFilterMenu(state: AppState, anchor: HTMLElement): void {
	const view = activeView(state);
	if (!view) return;
	const draft = filterNodeToDraft(view.filters ?? null);
	const r = anchor.getBoundingClientRect();
	const at = { x: r.left, y: r.bottom + 4 };

	const groups = draft.groups ?? [];

	// Nothing to manage yet — skip the one-item "Add filter rule" wrapper and
	// drop the user straight onto the property list (one fewer click to a first
	// filter, the common case).
	if (draft.rules.length === 0 && groups.length === 0) {
		openFilterPropertyMenu(state, anchor, view.id, draft);
		return;
	}

	// A rule row opens the same in-place edit menu as clicking its pill (edit
	// value / change condition / remove) — one consistent gesture across the
	// manager and the pills bar, instead of "click here = silently delete".
	const items: MenuItem[] = draft.rules.map((rule, i) => ({
		label: describeRule(rule, colLabel(rule.propertyId), ruleValueLabel(rule)),
		icon: propertyKindIcon(rule.propertyId),
		onClick: () => openFilterRulePillMenu(state, anchor, view.id, draft, i),
	}));

	// Each nested sub-group is one row that opens its own editor menu.
	groups.forEach((g, gi) => {
		items.push({
			label: `Group ${describeGroup(g)}`,
			icon: IconName.CaretRight,
			onClick: () => openFilterGroupMenu(state, anchor, view.id, draft, gi),
		});
	});

	if (draft.rules.length + groups.length > 1) {
		items.push({
			label: `Match: ${draft.op === FilterGroupOp.And ? "ALL" : "ANY"} (rules + groups)`,
			onClick: () =>
				commitFilterDraft(state, view.id, {
					...draft,
					op: draft.op === FilterGroupOp.And ? FilterGroupOp.Or : FilterGroupOp.And,
				}),
		});
	}

	if (draft.rules.length + groups.length > 0) {
		items.push({
			label: `Negate (NOT): ${draft.negate ? "on" : "off"}`,
			onClick: () => commitFilterDraft(state, view.id, { ...draft, negate: !draft.negate }),
		});
	}

	items.push({
		label: draft.rules.length === 0 ? "Add filter rule" : "Add another rule",
		icon: IconName.Plus,
		onClick: () => openFilterPropertyMenu(state, anchor, view.id, draft),
	});

	// A new sub-group defaults to the *opposite* join — the reason to
	// nest is almost always "… AND (x OR y)".
	items.push({
		label: "Add nested group",
		icon: IconName.Plus,
		onClick: () =>
			commitFilterDraft(state, view.id, {
				...draft,
				groups: [
					...groups,
					{
						op: draft.op === FilterGroupOp.And ? FilterGroupOp.Or : FilterGroupOp.And,
						rules: [],
					},
				],
			}),
	});

	if (countDraftRules(draft) > 0) {
		items.push({
			label: "Clear filter",
			icon: IconName.Trash,
			destructive: true,
			onClick: () => updateViewFilters(state, view.id, null),
		});
	}
	openContextMenu(at, items, anchor);
}

/** Editor for one nested sub-group (v2.1b). Mirrors the root menu but
 *  scoped to `draft.groups[groupIndex]`; every commit rebuilds the whole
 *  draft immutably so `commitFilterDraft` stays the single write path. */
function openFilterGroupMenu(
	state: AppState,
	anchor: HTMLElement,
	viewId: string,
	draft: FilterDraft,
	groupIndex: number,
): void {
	const groups = draft.groups ?? [];
	const group = groups[groupIndex];
	if (!group) return;
	const r = anchor.getBoundingClientRect();

	const replaceGroup = (next: FilterDraft | null): void => {
		const nextGroups =
			next === null
				? groups.filter((_, j) => j !== groupIndex)
				: groups.map((g, j) => (j === groupIndex ? next : g));
		commitFilterDraft(state, viewId, { ...draft, groups: nextGroups });
	};

	const items: MenuItem[] = group.rules.map((rule, i) => ({
		label: describeRule(rule, colLabel(rule.propertyId), ruleValueLabel(rule)),
		icon: IconName.Close,
		onClick: () => replaceGroup({ ...group, rules: group.rules.filter((_, j) => j !== i) }),
	}));

	if (group.rules.length > 1) {
		items.push({
			label: `Group match: ${group.op === FilterGroupOp.And ? "ALL" : "ANY"}`,
			onClick: () =>
				replaceGroup({
					...group,
					op: group.op === FilterGroupOp.And ? FilterGroupOp.Or : FilterGroupOp.And,
				}),
		});
	}

	if (group.rules.length > 0) {
		items.push({
			label: `Negate group (NOT): ${group.negate ? "on" : "off"}`,
			onClick: () => replaceGroup({ ...group, negate: !group.negate }),
		});
	}

	items.push({
		label: group.rules.length === 0 ? "Add rule to group" : "Add another rule to group",
		icon: IconName.Plus,
		onClick: () => openFilterPropertyMenu(state, anchor, viewId, draft, groupIndex),
	});

	items.push({
		label: "Remove group",
		icon: IconName.Trash,
		destructive: true,
		onClick: () => replaceGroup(null),
	});

	openSubmenuNextFrame(() => openContextMenu({ x: r.left, y: r.bottom + 4 }, items, anchor));
}

function openFilterPropertyMenu(
	state: AppState,
	anchor: HTMLElement,
	viewId: string,
	draft: FilterDraft,
	groupIndex?: number,
): void {
	const v = state.views.find((x) => x.id === viewId);
	if (!v) return;
	const r = anchor.getBoundingClientRect();
	openSubmenuNextFrame(() =>
		openContextMenu(
			{ x: r.left, y: r.bottom + 4 },
			v.columns
				.filter((c) => c.visible !== false)
				.map((c) => ({
					label: colLabel(c.propertyId),
					icon: propertyKindIcon(c.propertyId),
					onClick: () => openFilterOperatorMenu(state, anchor, viewId, draft, c.propertyId, groupIndex),
				})),
			anchor,
		),
	);
}

function openFilterOperatorMenu(
	state: AppState,
	anchor: HTMLElement,
	viewId: string,
	draft: FilterDraft,
	propertyId: string,
	groupIndex?: number,
): void {
	const r = anchor.getBoundingClientRect();
	// Relative-date ("is in") is only meaningful for a Date property — a
	// catalog Date def, or an un-catalogued `*At` timestamp key. Scope it out
	// of every other property's operator menu.
	const def = cachedVaultProperties.find((d) => d.key === propertyId);
	const isDateProperty = def ? def.valueType === ValueType.Date : /at$/i.test(propertyId);
	const operators = FILTER_OPERATORS.filter((o) => o.op !== FilterOp.RelativeDate || isDateProperty);
	openSubmenuNextFrame(() =>
		openContextMenu(
			{ x: r.left, y: r.bottom + 4 },
			operators.map((o) => ({
				label: o.label,
				onClick: () => {
					const append = (value: string, compareTo?: FilterCompareTo): void => {
						const rule: FilterRule = compareTo
							? { propertyId, op: o.op, value, compareTo }
							: { propertyId, op: o.op, value };
						// Root rule, or appended into the targeted sub-group —
						// either way commit the whole rebuilt draft.
						if (groupIndex === undefined) {
							commitFilterDraft(state, viewId, { ...draft, rules: [...draft.rules, rule] });
							return;
						}
						const groups = draft.groups ?? [];
						const g = groups[groupIndex];
						if (!g) return;
						commitFilterDraft(state, viewId, {
							...draft,
							groups: groups.map((cur, j) =>
								j === groupIndex ? { ...g, rules: [...g.rules, rule] } : cur,
							),
						});
					};
					if (!opNeedsValue(o.op)) {
						append("");
						return;
					}
					// Relative-date → pick a live-rolling range; the token IS the value
					// (no free text). The window re-rolls every recompile (9.12.20).
					if (o.op === FilterOp.RelativeDate) {
						openSubmenuNextFrame(() =>
							openContextMenu(
								{ x: r.left, y: r.bottom + 4 },
								ALL_RELATIVE_DATE_RANGES.map((range) => ({
									label: relativeRangeLabel(range),
									onClick: () => append(range),
								})),
								anchor,
							),
						);
						return;
					}
					// Select/vocabulary property → pick from its options and store the
					// option id (so is/contains matches the stored id), instead of
					// free-texting a label that never matches (F-027).
					// Comparison op → offer a literal, the clock (now), or another
					// property as the right-hand side (9.12.21 cross-property).
					if (opAcceptsRef(o.op)) {
						const cols = (state.views.find((x) => x.id === viewId)?.columns ?? []).filter(
							(c) => c.visible !== false && c.propertyId !== propertyId,
						);
						const refItems: MenuItem[] = [
							{
								label: "a value…",
								onClick: () => promptInline(anchor, "", (v) => append(v.trim())),
							},
							{ label: "now", onClick: () => append("", { kind: "now" }) },
							...cols.map((c) => ({
								label: `property: ${colLabel(c.propertyId)}`,
								onClick: () => append("", { kind: "prop", propertyId: c.propertyId }),
							})),
						];
						openSubmenuNextFrame(() => openContextMenu({ x: r.left, y: r.bottom + 4 }, refItems, anchor));
						return;
					}
					const options = selectOptionsFor(propertyId);
					if (options) {
						openSubmenuNextFrame(() =>
							openContextMenu(
								{ x: r.left, y: r.bottom + 4 },
								options.map((opt) => ({ label: opt.label, onClick: () => append(opt.id) })),
								anchor,
							),
						);
						return;
					}
					promptInline(anchor, "", (v) => append(v.trim()), {
						title: `${colLabel(propertyId)} ${o.label}`,
						placeholder: valuePlaceholder(o.op),
					});
				},
			})),
			anchor,
		),
	);
}

/** The placeholder hint for a filter value input — list ops want a
 *  comma-separated hint, everything else a generic prompt. */
function valuePlaceholder(op: FilterOp): string {
	return opIsList(op) ? "value, value…" : "Type a value…";
}

/** Teardown for the single open value prompt, so re-opening (or closing) one
 *  always removes its document mousedown listener — never orphans it. */
let activeValuePromptCleanup: (() => void) | null = null;

/** Small labelled value popover anchored under `anchor`. The title names the
 *  property + operator ("Name contains") so the input never reads as a stray
 *  search box; commits on Enter, dismisses on Escape / outside-click. */
function promptInline(
	anchor: HTMLElement,
	initial: string,
	onCommit: (value: string) => void,
	opts?: { title?: string; placeholder?: string },
): void {
	// Tear down any prompt already up THROUGH its own cleanup, so its document
	// mousedown listener is removed too (a bare `.remove()` would orphan it).
	activeValuePromptCleanup?.();
	const popover = document.createElement("div");
	popover.id = "db-value-prompt";
	popover.className = "db-value-prompt glass--strong";
	if (opts?.title) {
		const title = document.createElement("span");
		title.className = "db-value-prompt__title";
		title.textContent = opts.title;
		popover.appendChild(title);
	}
	const input = document.createElement("input");
	input.type = "text";
	input.className = "db-value-prompt__input";
	input.value = initial;
	input.placeholder = opts?.placeholder ?? "Type a value…";
	input.setAttribute("aria-label", opts?.title ?? "Filter value");
	popover.appendChild(input);

	const r = anchor.getBoundingClientRect();
	popover.style.position = "fixed";
	popover.style.left = `${r.left}px`;
	popover.style.top = `${r.bottom + 4}px`;
	popover.style.zIndex = "120";
	// Dismiss on a click OUTSIDE the popover (not on input blur) — blur fired
	// the moment the user clicked the popover's own title/padding, tearing the
	// prompt down before they could type.
	const onPointerDown = (event: MouseEvent): void => {
		if (!popover.contains(event.target as Node)) close();
	};
	const close = (): void => {
		document.removeEventListener("mousedown", onPointerDown, true);
		popover.remove();
		if (activeValuePromptCleanup === close) activeValuePromptCleanup = null;
	};
	activeValuePromptCleanup = close;
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			onCommit(input.value);
			close();
		} else if (e.key === "Escape") {
			e.preventDefault();
			close();
		}
	});
	document.body.appendChild(popover);
	input.focus();
	input.select();
	// Defer attaching so the click that opened this prompt doesn't immediately
	// match as an outside-click and close it.
	requestAnimationFrame(() => document.addEventListener("mousedown", onPointerDown, true));
}

/** A "+ New" create already in flight — the toolbar button stays focused
 *  until the grid hands the keyboard to the new row's title editor, so a
 *  re-fired Enter on the button must NOT mint another blank row (F-215:
 *  two name-entry attempts produced 13 Untitleds). */
let rowCreateInFlight = false;

/** Create flow (+ New). Creates a real entity through the shared
 *  `entities` service, of the active list's type when it's a `byType`
 *  list, then reloads the vault snapshot so the new row appears and
 *  hands the keyboard to the new row's title editor (F-215) via
 *  `state.pendingTitleEdit`. */
async function createEntityInActiveList(state: AppState): Promise<void> {
	if (rowCreateInFlight) return;
	const create = getRuntime()?.services?.entities?.create;
	if (!create) {
		flashStatus("Create needs the entities service (not exposed by this shell)", "warn");
		return;
	}
	const list = activeList(state);
	if (!list) {
		flashStatus("Open or create a collection to add an object here", "warn");
		return;
	}
	const plan = decideRowCreate(list);
	rowCreateInFlight = true;
	try {
		flashStatus("Creating…", "ready");
		const now = Date.now();
		const entity = await create(plan.type, { name: "Untitled", createdAt: now, updatedAt: now });
		// A manual / custom collection has no type source to pick the row up, so
		// pin the new generic Object into the collection's manual members.
		if (plan.addToMembers && entity?.id) {
			const { members } = addToList(list.members, entity.id, {
				matchesSource: false,
				by: "user",
				now,
			});
			state.lists = state.lists.map((l) => (l.id === list.id ? { ...l, members, updatedAt: now } : l));
			// Sync the membership into the overlay BEFORE the rebuild below, else
			// `applyVaultSnapshot` re-layers the pre-add collection and the new
			// row drops out of the manual members (same seam as F-010).
			schedulePersist(state);
		}
		// Hand focus off to the new row once the grid paints it: typing names
		// the row, Enter commits — the Notion/Anytype create pattern.
		if (entity?.id) state.pendingTitleEdit = entity.id;
		await loadVaultEntities(state); // re-list so the new row shows
		// The live `onChange` reload can land first and make `loadVaultEntities`
		// bail on an unchanged signature — re-render so the still-pending title
		// edit reaches the grid regardless of which reload painted the row.
		if (state.pendingTitleEdit) renderActiveView(state);
		flashStatus("Created", "ready");
	} catch (error) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		flashStatus(`Create failed — ${message}`, "warn");
	} finally {
		rowCreateInFlight = false;
	}
}

/** Single-key sort picker (compile-view already applies `view.sorts`).
 *  Cycles each column None → Asc → Desc; "Clear sort" resets. */
function openSortMenu(state: AppState, anchor: HTMLElement): void {
	const view = activeView(state);
	if (!view) return;
	const current = view.sorts[0] ?? null;
	const cols = view.columns.filter((c) => c.visible !== false);
	const r = anchor.getBoundingClientRect();
	const items: MenuItem[] = cols.map((c) => {
		const isActive = current?.propertyId === c.propertyId;
		const dir = isActive ? current?.direction : null;
		const mark = dir === SortDirection.Asc ? " ↑" : dir === SortDirection.Desc ? " ↓" : "";
		const label = (c.propertyId === "__title__" ? "Name" : propertyDisplayName(c.propertyId)) + mark;
		return {
			label,
			icon: propertyKindIcon(c.propertyId),
			onClick: () => {
				const next: SortDirection =
					!isActive || dir === SortDirection.Desc
						? SortDirection.Asc
						: dir === SortDirection.Asc
							? SortDirection.Desc
							: SortDirection.Asc;
				updateViewSorts(state, view.id, [
					{ propertyId: c.propertyId, direction: next, emptyPlacement: EmptyPlacement.End },
				]);
			},
		};
	});
	if (current) {
		items.push({
			label: "Clear sort",
			icon: IconName.Trash,
			destructive: true,
			onClick: () => updateViewSorts(state, view.id, []),
		});
	}
	openContextMenu({ x: r.left, y: r.bottom + 4 }, items, anchor);
}

/** Active filters + sorts as removable pills above the rows (the Notion /
 *  Anytype affordance). Each pill is the live condition: click the body to
 *  edit it in place, click the × to drop it. Derived from the same
 *  `filterNodeToDraft` the builder uses, so pills and the menu never disagree.
 *  Hidden entirely when the view has no filters or sorts. */
function renderFilterBar(state: AppState): void {
	const bar = document.getElementById("filter-bar");
	if (!bar) return;
	bar.replaceChildren();
	const view = activeView(state);
	if (!view) {
		bar.hidden = true;
		return;
	}
	const draft = filterNodeToDraft(view.filters ?? null);
	const groups = draft.groups ?? [];
	const sorts = view.sorts;
	const pillCount = draft.rules.length + groups.length + sorts.length;
	if (pillCount === 0) {
		bar.hidden = true;
		return;
	}
	bar.hidden = false;

	draft.rules.forEach((rule, i) =>
		bar.appendChild(buildFilterRulePill(state, view.id, draft, rule, i)),
	);

	groups.forEach((group, gi) => {
		const remove = (): void =>
			commitFilterDraft(state, view.id, {
				...draft,
				groups: groups.filter((_, j) => j !== gi),
			});
		bar.appendChild(
			createPill({
				variant: "filter",
				icon: DatabaseIcon.Filter,
				text: describeGroup(group),
				title: "Edit group",
				onClick: () => openFilterGroupMenu(state, bar, view.id, draft, gi),
				onRemove: remove,
				removeLabel: "Remove group",
			}),
		);
	});

	sorts.forEach((sort, si) => bar.appendChild(buildSortPill(state, view.id, sorts, sort, si)));

	// Add directly from the bar where the conditions live — no round-trip to the
	// toolbar. "+ Filter" drops onto the property list; "+ Sort" onto the sort menu.
	bar.appendChild(
		barAddButton("+ Filter", (anchor) => openFilterPropertyMenu(state, anchor, view.id, draft)),
	);
	if (sorts.length === 0) {
		bar.appendChild(barAddButton("+ Sort", (anchor) => openSortMenu(state, anchor)));
	}

	// One affordance to wipe the whole bar once it's carrying more than a single
	// pill — the per-pill × stays the primary path, this is the bulk escape.
	if (pillCount > 1) {
		const clear = document.createElement("button");
		clear.type = "button";
		clear.className = "db-filter-bar__clear";
		clear.textContent = "Clear all";
		clear.addEventListener("click", () => {
			updateViewFilters(state, view.id, null);
			updateViewSorts(state, view.id, []);
		});
		bar.appendChild(clear);
	}
}

function buildFilterRulePill(
	state: AppState,
	viewId: string,
	draft: FilterDraft,
	rule: FilterRule,
	index: number,
): HTMLElement {
	const remove = (): void =>
		commitFilterDraft(state, viewId, { ...draft, rules: draft.rules.filter((_, j) => j !== index) });
	return createPill({
		variant: "filter",
		icon: DatabaseIcon.Filter,
		text: describeRule(rule, colLabel(rule.propertyId), ruleValueLabel(rule)),
		title: "Edit filter",
		onClick: (anchor) => openFilterRulePillMenu(state, anchor, viewId, draft, index),
		onRemove: remove,
		removeLabel: "Remove filter",
	});
}

function buildSortPill(
	state: AppState,
	viewId: string,
	sorts: ListView["sorts"],
	sort: ListView["sorts"][number],
	index: number,
): HTMLElement {
	const arrow = sort.direction === SortDirection.Desc ? "↓" : "↑";
	const text = `${arrow} ${colLabel(sort.propertyId)}`;
	const flip = (): void => {
		const next = sort.direction === SortDirection.Asc ? SortDirection.Desc : SortDirection.Asc;
		updateViewSorts(
			state,
			viewId,
			sorts.map((s, j) => (j === index ? { ...s, direction: next } : s)),
		);
	};
	const remove = (): void =>
		updateViewSorts(
			state,
			viewId,
			sorts.filter((_, j) => j !== index),
		);
	return createPill({
		variant: "sort",
		text,
		title: "Toggle sort direction",
		onClick: flip,
		onRemove: remove,
		removeLabel: "Remove sort",
	});
}

/** Per-pill edit menu: change the value, change the condition, or remove.
 *  Every commit produces a *complete* rule so the pill never compiles away
 *  (an incomplete rule is pruned by `draftToFilterNode` and would vanish). */
function openFilterRulePillMenu(
	state: AppState,
	anchor: HTMLElement,
	viewId: string,
	draft: FilterDraft,
	index: number,
): void {
	const rule = draft.rules[index];
	if (!rule) return;
	const r = anchor.getBoundingClientRect();
	const at = { x: r.left, y: r.bottom + 4 };
	const replaceRule = (next: FilterRule): void =>
		commitFilterDraft(state, viewId, {
			...draft,
			rules: draft.rules.map((cur, j) => (j === index ? next : cur)),
		});

	const items: MenuItem[] = [];
	if (opNeedsValue(rule.op)) {
		items.push({
			label: "Edit value…",
			icon: IconName.Pencil,
			onClick: () =>
				pickRuleValue(anchor, rule.propertyId, rule.op, rule.value, (value) =>
					replaceRule({ ...rule, value }),
				),
		});
	}
	items.push({
		label: `Condition: ${opLabel(rule.op)}`,
		icon: IconName.CaretRight,
		onClick: () => openFilterPillConditionMenu(state, anchor, viewId, draft, index),
	});
	items.push({
		label: "Remove filter",
		icon: IconName.Trash,
		destructive: true,
		onClick: () =>
			commitFilterDraft(state, viewId, {
				...draft,
				rules: draft.rules.filter((_, j) => j !== index),
			}),
	});
	// Deferred a frame so opening this from inside the filter manager (a menu
	// row) doesn't get torn down when the parent menu closes on select (F-026);
	// harmless when opened straight from a pill (no parent menu).
	openSubmenuNextFrame(() => openContextMenu(at, items, anchor));
}

/** Change a pill rule's operator while keeping its property. A new
 *  value-taking op reuses the current value when present, else prompts; a
 *  value-less op (`is set` / `is empty`) commits immediately. */
function openFilterPillConditionMenu(
	state: AppState,
	anchor: HTMLElement,
	viewId: string,
	draft: FilterDraft,
	index: number,
): void {
	const rule = draft.rules[index];
	if (!rule) return;
	const r = anchor.getBoundingClientRect();
	const replaceWith = (op: (typeof FILTER_OPERATORS)[number]["op"], value: string): void =>
		commitFilterDraft(state, viewId, {
			...draft,
			rules: draft.rules.map((cur, j) =>
				j === index ? { propertyId: rule.propertyId, op, value } : cur,
			),
		});
	openSubmenuNextFrame(() =>
		openContextMenu(
			{ x: r.left, y: r.bottom + 4 },
			FILTER_OPERATORS.map((o) => ({
				label: `${o.op === rule.op ? "● " : ""}${o.label}`,
				onClick: () => {
					if (!opNeedsValue(o.op)) {
						replaceWith(o.op, "");
						return;
					}
					if (rule.value.trim() !== "") {
						replaceWith(o.op, rule.value);
						return;
					}
					pickRuleValue(anchor, rule.propertyId, o.op, "", (value) => replaceWith(o.op, value));
				},
			})),
			anchor,
		),
	);
}

/** Pick a new value for a rule: a vocabulary/Select property opens its
 *  options submenu (so the stored option id matches), everything else gets
 *  the labelled value prompt seeded with the current value. `op` drives the
 *  prompt's title + placeholder so the user sees "Name contains" context. */
function pickRuleValue(
	anchor: HTMLElement,
	propertyId: string,
	op: FilterOp,
	initial: string,
	onCommit: (value: string) => void,
): void {
	const options = selectOptionsFor(propertyId);
	if (options) {
		const r = anchor.getBoundingClientRect();
		openSubmenuNextFrame(() =>
			openContextMenu(
				{ x: r.left, y: r.bottom + 4 },
				options.map((opt) => ({ label: opt.label, onClick: () => onCommit(opt.id) })),
				anchor,
			),
		);
		return;
	}
	promptInline(anchor, initial, (v) => onCommit(v.trim()), {
		title: `${colLabel(propertyId)} ${opLabel(op)}`,
		placeholder: valuePlaceholder(op),
	});
}

/** A quiet "+ Filter" / "+ Sort" add affordance for the pills bar — opens its
 *  menu anchored on itself so the picker drops right where the user clicked. */
function barAddButton(label: string, onClick: (anchor: HTMLElement) => void): HTMLElement {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "db-filter-bar__add";
	btn.textContent = label;
	btn.addEventListener("click", () => onClick(btn));
	return btn;
}

type PillVariant = "filter" | "sort";

type PillSpec = {
	variant: PillVariant;
	text: string;
	icon?: DatabaseIcon;
	title?: string;
	onClick: (anchor: HTMLElement) => void;
	onRemove: () => void;
	removeLabel: string;
};

/** Build one removable pill: a clickable label half + a trailing × that
 *  removes it without opening the editor. Shared by filter, group, and sort
 *  pills so the chrome stays identical. */
function createPill(spec: PillSpec): HTMLElement {
	const pill = document.createElement("div");
	pill.className = `db-pill db-pill--${spec.variant}`;

	const main = document.createElement("button");
	main.type = "button";
	main.className = "db-pill__main";
	if (spec.title) main.title = spec.title;
	if (spec.icon) {
		const glyph = document.createElement("span");
		glyph.className = "db-pill__icon";
		glyph.setAttribute("aria-hidden", "true");
		setIcon(glyph, spec.icon);
		main.appendChild(glyph);
	}
	const label = document.createElement("span");
	label.className = "db-pill__label";
	label.textContent = spec.text;
	main.appendChild(label);
	main.addEventListener("click", () => spec.onClick(main));
	pill.appendChild(main);

	const remove = document.createElement("button");
	remove.type = "button";
	remove.className = "db-pill__remove";
	remove.setAttribute("aria-label", spec.removeLabel);
	remove.dataset.bsTooltip = spec.removeLabel;
	setSharedIcon(remove, IconName.Close);
	remove.addEventListener("click", (event) => {
		event.stopPropagation();
		spec.onRemove();
	});
	pill.appendChild(remove);

	return pill;
}

function mutateEntityProperty(
	state: AppState,
	entityId: string,
	propertyId: string,
	value: unknown,
): void {
	const entities = state.db.entities.map((e) =>
		e.id === entityId
			? { ...e, properties: { ...e.properties, [propertyId]: value }, updatedAt: Date.now() }
			: e,
	);
	state.db = { ...state.db, entities };
}

/** The object's OWN icon (`properties.icon`), validated to the universal
 *  `Icon` shape — never the type glyph. Per-object-icons-everywhere: the
 *  type glyph is fallback-only (foundations/39-universal-icons.md). */
export function readEntityIcon(entity: EntityRow): Icon | null {
	const raw = entity.properties.icon;
	if (!raw || typeof raw !== "object") return null;
	const c = raw as { kind?: unknown; value?: unknown };
	if (typeof c.value !== "string" || c.value.length === 0) return null;
	if (c.kind === IconKind.Pack || c.kind === IconKind.Emoji || c.kind === IconKind.Image) {
		return c as Icon;
	}
	return null;
}

/** Write `patch` into an entity's `properties`: optimistic in-memory
 *  merge + the shared `entities.update` service (the same path the
 *  create flow uses), then re-paint the stage + inspector so the new
 *  icon/cover shows immediately. Mirrors Notes' optimistic-then-persist
 *  model; a missing service or a write failure keeps the optimistic
 *  value and surfaces a status, never a silent drop. */
async function persistEntityPatch(
	state: AppState,
	entity: EntityRow,
	patch: Record<string, unknown>,
): Promise<void> {
	for (const [k, v] of Object.entries(patch)) mutateEntityProperty(state, entity.id, k, v);
	renderActiveView(state);
	renderInspector(state);
	const update = getRuntime()?.services?.entities?.update;
	if (!update) {
		flashStatus("Saved locally — entities write not exposed by this shell", "warn");
		return;
	}
	try {
		await update(entity.id, patch);
	} catch (error) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		flashStatus(`Save failed — ${message}`, "warn");
	}
}

/* ── Chrome wiring ─────────────────────────────────────────────────────── */

function renderHeaderIcons(): void {
	const search = document.getElementById("header-btn-search");
	const newList = document.getElementById("sidebar-new-list");
	const inspectorClose = document.getElementById("inspector-close");
	if (search) setSharedIcon(search, IconName.Search);
	if (newList) setSharedIcon(newList, IconName.Plus);
	if (inspectorClose) setSharedIcon(inspectorClose, IconName.Close);
	// Sidebar + inspector toggles use the shared `panelToggleIcon` SVG so
	// they read identically with every other first-party app's header
	// toggle. `applyChrome` repaints the glyph on every state flip so the
	// active fill tracks open/closed.
}

function renderToolbarIcons(): void {
	const filter = document.getElementById("toolbar-filter-icon");
	const sort = document.getElementById("toolbar-sort-icon");
	const settings = document.getElementById("toolbar-settings-icon");
	const create = document.getElementById("toolbar-new-icon");
	if (filter) setIcon(filter, DatabaseIcon.Filter);
	if (sort) setIcon(sort, DatabaseIcon.Sort);
	if (settings) setSharedIcon(settings, IconName.Settings);
	if (create) setSharedIcon(create, IconName.Plus);
}

function bindResizableChrome(): void {
	const sidebarHandle = document.getElementById("db-sidebar-resize");
	if (sidebarHandle) {
		attachResizable({
			handle: sidebarHandle,
			side: "left",
			defaultWidth: 248,
			min: 200,
			max: 420,
			storageKey: "database:sidebar-width",
			onWidth: (px) => {
				document.body.style.setProperty("--db-sidebar-width", `${px}px`);
			},
		});
	}
	const inspectorHandle = document.getElementById("db-inspector-resize");
	if (inspectorHandle) {
		attachResizable({
			handle: inspectorHandle,
			side: "right",
			defaultWidth: 320,
			min: 260,
			max: 560,
			storageKey: "database:inspector-width",
			onWidth: (px) => {
				document.body.style.setProperty("--db-inspector-width", `${px}px`);
			},
		});
	}
}

function bindHeaderButtons(state: AppState): void {
	document.getElementById("header-btn-sidebar")?.addEventListener("click", () => {
		state.chrome.sidebarOpen = !state.chrome.sidebarOpen;
		applyChrome(state);
		schedulePersist(state);
	});
	document.getElementById("header-btn-inspector")?.addEventListener("click", () => {
		const opening = !state.chrome.inspectorOpen;
		// Opening with nothing selected would render an empty panel that
		// renderInspector then immediately closes (no selection → closed). Seed
		// the first visible row so the toggle always shows something to inspect
		// (a no-op only on a genuinely empty grid).
		if (opening && state.selection.selectedIds.size === 0) {
			const first = orderedVisibleIds(state)[0];
			if (first) {
				state.selection = applyClick(
					state.selection,
					first,
					{ shiftKey: false, metaKey: false },
					orderedVisibleIds(state),
				);
			}
		}
		state.chrome.inspectorOpen = opening;
		applyChrome(state);
		renderInspector(state);
		repaintSelection(state);
		schedulePersist(state);
	});
	document.getElementById("inspector-close")?.addEventListener("click", () => {
		state.chrome.inspectorOpen = false;
		applyChrome(state);
		schedulePersist(state);
	});
	const searchBtn = document.getElementById("header-btn-search");
	searchBtn?.addEventListener("click", () => toggleSearch(state, searchBtn));
	document.getElementById("sidebar-new-list")?.addEventListener("click", (event) => {
		const anchor = event.currentTarget;
		if (anchor instanceof HTMLElement) beginNewList(state, anchor);
	});
}

/** Toggle an inline free-text search input beside the header button.
 *  No module state — the input's DOM presence IS the on/off state, so
 *  there's nothing to leave in a temporal dead zone. */
function toggleSearch(state: AppState, anchor: HTMLElement): void {
	const existing = document.getElementById("db-search-input");
	if (existing) {
		existing.remove();
		if (searchQuery) {
			searchQuery = "";
			renderActiveView(state);
		}
		return;
	}
	const input = document.createElement("input");
	input.id = "db-search-input";
	input.type = "search";
	input.className = "db-search-input";
	input.placeholder = "Search rows…";
	input.value = searchQuery;
	input.setAttribute("aria-label", "Search rows");
	input.addEventListener("input", () => {
		searchQuery = input.value;
		renderActiveView(state);
	});
	input.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			e.preventDefault();
			input.remove();
			searchQuery = "";
			renderActiveView(state);
			anchor.focus();
		}
	});
	anchor.parentElement?.insertBefore(input, anchor);
	input.focus();
}

/** Distinct non-deleted entity types in the vault, most-populous first —
 *  the option set for the source picker. */
function availableVaultTypes(state: AppState): SourceTypeOption[] {
	const counts = new Map<string, number>();
	for (const e of state.db.entities) {
		if (e.deletedAt !== null) continue;
		counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([type, count]) => ({ type, label: friendlyTypeName(type), count }));
}

/** "New list" — ask which objects to show before creating, so the list is
 *  populated on day one (the old flow made an empty `source: null` list with
 *  no way to pick its contents). An empty vault skips the picker and creates
 *  an honest empty list. */
/** "New collection" entry. Offers the two real shapes a user wants: a **blank
 *  collection** they fill with their own objects + columns (the CRM case —
 *  previously impossible to discover), or a view **from existing objects** (the
 *  old type-filter "list"). */
function beginNewList(state: AppState, anchor: HTMLElement): void {
	const rect = anchor.getBoundingClientRect();
	openAnchoredMenu(
		{ x: rect.left, y: rect.bottom },
		[
			{
				label: "Blank collection",
				onSelect: () => createListWithSource(state, "New collection", null, []),
			},
			{
				label: "From existing objects…",
				onSelect: () => openExistingTypesPicker(state, anchor),
			},
			{
				label: "Import from CSV…",
				onSelect: () => void importCsvAsCollection(state),
			},
		],
		{ menuLabel: "New collection", anchor },
	);
}

/** Generic CSV import (9.12.19): pick a `.csv`, infer its columns, mint a
 *  fresh collection of generic Objects (first column → title, the rest →
 *  inferred-type properties), and pin the imported rows as its manual members.
 *  Types render via `effective-def` inference — no catalog registration. */
async function importCsvAsCollection(state: AppState): Promise<void> {
	const runtime = getRuntime();
	const files = runtime?.services?.files;
	const create = runtime?.services?.entities?.create;
	if (!files?.requestOpen || !create) {
		flashStatus("Import needs the files + entities services (not exposed by this shell)", "warn");
		return;
	}
	const handles = await files.requestOpen({
		title: "Import CSV",
		filters: [{ name: "CSV", extensions: ["csv"] }],
		multi: false,
	});
	const handle = handles[0];
	if (!handle) return;
	let text: string;
	try {
		const bytes = await files.read(handle);
		text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	} catch {
		flashStatus("Couldn't read the CSV file", "warn");
		return;
	}
	const imported = csvToEntityImport(text);
	if (!imported || imported.rows.length === 0) {
		flashStatus("No rows found in that CSV", "warn");
		return;
	}
	let ids: string[];
	try {
		flashStatus("Importing…", "ready");
		ids = await commitCsvImport(imported, { create });
	} catch (error) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		flashStatus(`Import failed — ${message}`, "warn");
		return;
	}
	const baseName = handle.displayName.replace(/\.csv$/i, "").trim() || "Imported CSV";
	const columnIds = imported.propertyColumns.map((c) => c.name);
	const { list, view } = createList({
		name: baseName,
		existingLists: state.lists,
		source: null,
		columnIds,
	});
	// A manual collection: the imported rows are its members (no type source).
	const now = Date.now();
	let members = list.members;
	for (const entityId of ids) {
		members = addToList(members, entityId, { matchesSource: false, by: "user", now }).members;
	}
	state.lists.push({ ...list, members, updatedAt: now });
	state.views.push(view);
	state.active = { listId: list.id, viewId: view.id };
	state.selection = clearSelection();
	// Sync the new collection + its membership into the overlay BEFORE the
	// reload, else `applyVaultSnapshot` re-layers without it and the rows drop
	// out (same seam as F-010 / `createEntityInActiveList`).
	schedulePersist(state);
	await loadVaultEntities(state);
	renderListNav(state);
	renderViewTabs(state);
	renderStageHeader(state);
	renderActiveView(state);
	renderInspector(state);
	flashStatus(
		`Imported ${ids.length} ${ids.length === 1 ? "row" : "rows"} into "${list.name}"`,
		"ready",
	);
}

/** The legacy "choose what to show" type-filter picker — now reached via the
 *  "From existing objects…" branch of the New-collection menu. */
function openExistingTypesPicker(state: AppState, anchor: HTMLElement): void {
	const types = availableVaultTypes(state);
	if (types.length === 0) {
		createListWithSource(state, "New collection", null, []);
		return;
	}
	openSourcePicker({
		anchor,
		availableTypes: types,
		selectedTypes: [],
		title: "New list — choose what to show",
		confirmLabel: "Create list",
		onConfirm: (chosen) => {
			closeSourcePicker();
			const source: ListSource = { kind: ListSourceKind.ByType, types: chosen };
			const rows = state.db.entities.filter((e) => e.deletedAt === null && chosen.includes(e.type));
			const first = chosen[0];
			const name = chosen.length === 1 && first ? friendlyTypeName(first) : "New list";
			createListWithSource(state, name, source, deriveColumns(rows));
		},
		onCancel: () => closeSourcePicker(),
	});
}

function createListWithSource(
	state: AppState,
	name: string,
	source: ListSource | null,
	columnIds: ReadonlyArray<string>,
): void {
	const { list, view } = createList({ name, existingLists: state.lists, source, columnIds });
	state.lists.push(list);
	state.views.push(view);
	state.active = { listId: list.id, viewId: view.id };
	state.selection = clearSelection();
	closeViewSettings();
	renderListNav(state);
	renderViewTabs(state);
	renderStageHeader(state);
	renderActiveView(state);
	renderInspector(state);
	schedulePersist(state);
	flashStatus(t("brainstorm.database.list.created", { name: list.name }), "ready");
}

/** Replace a List's `ByType` source with a new type set (or `null` when the
 *  user clears every type). Live-applied from the view-settings "Shown
 *  objects" section. Columns are left to the user's column controls. */
function updateListSource(state: AppState, listId: string, types: ReadonlyArray<string>): void {
	const list = state.lists.find((l) => l.id === listId);
	if (!list) return;
	const source: ListSource | null =
		types.length > 0 ? { kind: ListSourceKind.ByType, types: [...types] } : null;
	state.lists = state.lists.map((l) =>
		l.id === listId ? { ...l, source, updatedAt: Date.now() } : l,
	);
	renderActiveView(state);
	renderStageHeader(state);
	schedulePersist(state);
	void refreshSourceIds(state);
}

function createNewViewAndSelect(state: AppState, listId: string): void {
	const view = createView({
		// A new view is a Grid until retyped — name it after its kind with a
		// collision counter ("Grid", "Grid 2", …), not the anonymous "New
		// view", and drop straight into inline rename below so the user names
		// it on the spot (the same flow as "Blank collection" / "New folder")
		// — F-038 / F-208.
		listId,
		name: defaultViewName(ListViewKind.Grid, viewsForList(state, listId)),
		existingViewsForList: viewsForList(state, listId),
	});
	state.views.push(view);
	const afterId = state.active.listId === listId ? state.active.viewId : null;
	state.lists = state.lists.map((l) => (l.id === listId ? insertViewAfter(l, view.id, afterId) : l));
	state.active = { listId, viewId: view.id };
	state.selection = clearSelection();
	closeViewSettings();
	renderListNav(state);
	renderViewTabs(state);
	renderStageHeader(state);
	renderActiveView(state);
	schedulePersist(state);
	// Inline-rename the freshly-rendered tab so the user types its real name
	// immediately (Enter commits, Escape keeps the type-default).
	beginViewTabRename(state, view.id);
}

/** Put a view tab's label into inline-rename mode. The create flow, the tab
 *  double-click, the F2 binding, and the context-menu Rename all funnel here.
 *  Queries the LIVE label by view id — a re-render between the trigger and
 *  this call (e.g. the select on a double-click's first click) replaces the
 *  tab element, so a closed-over element could be detached. */
function beginViewTabRename(state: AppState, viewId: string): void {
	const view = state.views.find((v) => v.id === viewId);
	if (!view) return;
	const label = document.querySelector<HTMLElement>(
		`#view-tabs [data-view-id="${viewId}"] .db-tab__label`,
	);
	if (!label) return;
	beginInlineRename(label, view.name, (next) => commitViewRename(state, viewId, next));
}

function openListContextMenu(
	state: AppState,
	list: List,
	labelEl: HTMLElement,
	point: { x: number; y: number },
): void {
	openContextMenu(point, [
		{
			label: t("brainstorm.database.list.menu.rename"),
			icon: IconName.Pencil,
			onClick: () =>
				beginInlineRename(labelEl, list.name, (next) => commitListRename(state, list.id, next)),
		},
		{
			label: t("brainstorm.database.list.menu.duplicate"),
			icon: IconName.Copy,
			onClick: () => duplicateListAndSelect(state, list),
		},
		{
			label: t("brainstorm.database.list.menu.delete"),
			icon: IconName.Trash,
			destructive: true,
			disabled: state.lists.length <= 1,
			...(state.lists.length <= 1 ? { hint: t("brainstorm.database.list.menu.delete.lastHint") } : {}),
			onClick: () => deleteListAndCleanup(state, list),
		},
	]);
}

function openViewContextMenu(
	state: AppState,
	view: ListView,
	point: { x: number; y: number },
): void {
	const siblings = viewsForList(state, view.listId);
	openContextMenu(point, [
		{
			label: t("brainstorm.database.view.menu.rename"),
			icon: IconName.Pencil,
			onClick: () => beginViewTabRename(state, view.id),
		},
		{
			label: t("brainstorm.database.view.menu.duplicate"),
			icon: IconName.Copy,
			onClick: () => duplicateViewAndSelect(state, view),
		},
		{
			label: t("brainstorm.database.view.menu.delete"),
			icon: IconName.Trash,
			destructive: true,
			disabled: siblings.length <= 1,
			...(siblings.length <= 1 ? { hint: t("brainstorm.database.view.menu.delete.lastHint") } : {}),
			onClick: () => deleteViewAndCleanup(state, view),
		},
	]);
}

function commitListRename(state: AppState, listId: string, name: string): void {
	const list = state.lists.find((l) => l.id === listId);
	if (!list) return;
	const next = renameListLogic(list, name);
	if (next === list) return;
	state.lists = state.lists.map((l) => (l.id === listId ? next : l));
	renderListNav(state);
	renderStageHeader(state);
	schedulePersist(state);
}

function commitListIcon(state: AppState, listId: string, icon: Icon | null): void {
	const list = state.lists.find((l) => l.id === listId);
	if (!list) return;
	const next = setListIconLogic(list, icon);
	if (next === list) return;
	state.lists = state.lists.map((l) => (l.id === listId ? next : l));
	renderListNav(state);
	renderStageHeader(state);
	schedulePersist(state);
}

function commitViewRename(state: AppState, viewId: string, name: string): void {
	const view = state.views.find((v) => v.id === viewId);
	if (!view) return;
	const next = applyViewConfig(view, { action: ViewConfigAction.SetName, name });
	if (next === view) return;
	state.views = state.views.map((v) => (v.id === viewId ? next : v));
	renderViewTabs(state);
	renderStageHeader(state);
	schedulePersist(state);
}

function duplicateListAndSelect(state: AppState, source: List): void {
	const { list, views } = duplicateList(source, state.views, state.lists);
	state.lists.push(list);
	for (const v of views) state.views.push(v);
	state.active = {
		listId: list.id,
		viewId: list.defaultViewId ?? views[0]?.id ?? state.active.viewId,
	};
	state.selection = clearSelection();
	closeViewSettings();
	renderListNav(state);
	renderViewTabs(state);
	renderStageHeader(state);
	renderActiveView(state);
	renderInspector(state);
	schedulePersist(state);
	flashStatus(t("brainstorm.database.list.duplicated", { name: list.name }), "ready");
}

function duplicateViewAndSelect(state: AppState, source: ListView): void {
	const siblings = viewsForList(state, source.listId);
	const dup = duplicateView(source, siblings);
	state.views.push(dup);
	state.lists = state.lists.map((l) =>
		l.id === source.listId ? insertViewAfter(l, dup.id, source.id) : l,
	);
	state.active = { listId: source.listId, viewId: dup.id };
	closeViewSettings();
	renderListNav(state);
	renderViewTabs(state);
	renderStageHeader(state);
	renderActiveView(state);
	schedulePersist(state);
	flashStatus(t("brainstorm.database.view.duplicated", { name: dup.name }), "ready");
}

function deleteListAndCleanup(state: AppState, list: List): void {
	if (state.lists.length <= 1) return;
	const result = deleteListLogic(state.lists, state.views, list.id);
	state.lists = result.lists;
	state.views = result.views;
	if (state.active.listId === list.id) {
		const next = state.lists[0];
		const nextView = next ? state.views.find((v) => v.listId === next.id) : undefined;
		if (next && nextView) {
			state.active = { listId: next.id, viewId: nextView.id };
		}
	}
	state.selection = clearSelection();
	closeViewSettings();
	renderListNav(state);
	renderViewTabs(state);
	renderStageHeader(state);
	renderActiveView(state);
	renderInspector(state);
	schedulePersist(state);
	flashStatus(t("brainstorm.database.list.deleted", { name: list.name }), "warn");
}

function deleteViewAndCleanup(state: AppState, view: ListView): void {
	const siblings = viewsForList(state, view.listId);
	if (siblings.length <= 1) return;
	state.views = deleteViewLogic(state.views, view.id);
	state.lists = state.lists.map((l) =>
		l.id === view.listId
			? {
					...l,
					views: l.views.filter((id) => id !== view.id),
					defaultViewId:
						l.defaultViewId === view.id
							? (siblings.find((s) => s.id !== view.id)?.id ?? null)
							: l.defaultViewId,
					updatedAt: Date.now(),
				}
			: l,
	);
	if (state.active.viewId === view.id) {
		const nextView = siblings.find((s) => s.id !== view.id);
		if (nextView) state.active = { listId: view.listId, viewId: nextView.id };
	}
	closeViewSettings();
	renderListNav(state);
	renderViewTabs(state);
	renderStageHeader(state);
	renderActiveView(state);
	schedulePersist(state);
	flashStatus(t("brainstorm.database.view.deleted", { name: view.name }), "warn");
}

function beginInlineRename(
	labelEl: HTMLElement,
	currentValue: string,
	onCommit: (next: string) => void,
): void {
	labelEl.contentEditable = "plaintext-only";
	labelEl.spellcheck = false;
	labelEl.textContent = currentValue;
	labelEl.focus();
	const range = document.createRange();
	range.selectNodeContents(labelEl);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);

	let committed = false;
	const commit = (): void => {
		if (committed) return;
		committed = true;
		labelEl.removeEventListener("keydown", onKey);
		labelEl.removeEventListener("blur", commit);
		labelEl.contentEditable = "false";
		const next = (labelEl.textContent ?? "").trim();
		if (next && next !== currentValue) onCommit(next);
		else labelEl.textContent = currentValue;
	};
	const cancel = (): void => {
		if (committed) return;
		committed = true;
		labelEl.removeEventListener("keydown", onKey);
		labelEl.removeEventListener("blur", commit);
		labelEl.contentEditable = "false";
		labelEl.textContent = currentValue;
	};
	const onKey = (event: KeyboardEvent): void => {
		if (event.key === "Enter") {
			event.preventDefault();
			commit();
			labelEl.blur();
		} else if (event.key === "Escape") {
			event.preventDefault();
			cancel();
			labelEl.blur();
		}
	};
	labelEl.addEventListener("keydown", onKey);
	labelEl.addEventListener("blur", commit);
}

function bindToolbarButtons(state: AppState): void {
	const filterBtn = document.getElementById("toolbar-filter");
	filterBtn?.addEventListener("click", () => {
		if (filterBtn instanceof HTMLElement) openFilterMenu(state, filterBtn);
	});
	const sortBtn = document.getElementById("toolbar-sort");
	sortBtn?.addEventListener("click", () => {
		if (sortBtn instanceof HTMLElement) openSortMenu(state, sortBtn);
	});
	document.getElementById("toolbar-new")?.addEventListener("click", () => {
		void createEntityInActiveList(state);
	});
	const settingsBtn = document.getElementById("toolbar-settings");
	settingsBtn?.addEventListener("click", () => {
		const view = activeView(state);
		if (!view || !(settingsBtn instanceof HTMLElement)) return;
		// A click on the toolbar gear is a fresh open — always land on the root
		// page (the re-open-on-change path keeps the user's sub-page instead).
		resetViewSettingsPage();
		openViewSettingsForActive(state, settingsBtn);
	});
}

function openViewSettingsForActive(state: AppState, anchor: HTMLElement): void {
	const view = activeView(state);
	if (!view) return;
	const list = activeList(state);
	const compiled = compileActive(state);
	const propKeys = new Set<string>();
	for (const e of compiled?.entities ?? []) {
		for (const k of Object.keys(e.properties)) propKeys.add(k);
	}
	// "Shown objects" is editable only for the ByType / empty source — the
	// link / vocabulary / composite shapes have no inline editor yet.
	const source = list?.source ?? null;
	const sourceEditable = source === null || source.kind === ListSourceKind.ByType;
	const listSourceTypes = source && source.kind === ListSourceKind.ByType ? source.types : [];
	// Rollup creation (9.12.17): discover relations on the list's rows over the
	// full vault (the relation walks to entities of other types). Offered only
	// when the list actually has a relation to roll up across.
	const rollupRows = compiled?.entities ?? [];
	const rollupByIdMap = entitiesById(state.db.entities);
	const rollupRelations = rollupRelationCandidates(rollupRows, rollupByIdMap, propertyDisplayName);
	openViewSettings(anchor, {
		view,
		availableProperties: [...propKeys],
		vaultProperties: cachedVaultProperties,
		availableTypes: availableVaultTypes(state),
		listSourceTypes,
		sourceEditable,
		...(rollupRelations.length > 0
			? {
					rollup: {
						relations: rollupRelations,
						targetsFor: (relationKey: string) =>
							rollupTargetCandidates(relationKey, rollupRows, rollupByIdMap, propertyDisplayName),
						onAdd: (column: ColumnSpec) => {
							updateViewColumns(state, view.id, [...view.columns, column]);
							renderActiveView(state);
							renderViewTabs(state);
							schedulePersist(state);
							openViewSettingsForActive(state, anchor);
						},
					},
				}
			: {}),
		// Formula creation (9.12.17): a computed column whose value is an
		// arithmetic expression over the row's other properties. Always offered.
		formula: {
			onAdd: (column: ColumnSpec) => {
				updateViewColumns(state, view.id, [...view.columns, column]);
				renderActiveView(state);
				renderViewTabs(state);
				schedulePersist(state);
				openViewSettingsForActive(state, anchor);
			},
		},
		...(list ? { onChangeSource: (types) => updateListSource(state, list.id, types) } : {}),
		onCreateProperty: (seedName) => openColumnPropertyConstructor(state, view, seedName),
		onChange: (patch) => {
			if (patch.name) commitViewRename(state, view.id, patch.name);
			if (patch.kind) {
				// The Board/Calendar auto-axis (a bare kind switch leaves
				// groupBy null → those views render blank) lives in the reducer.
				mutateView(
					state,
					view.id,
					{ action: ViewConfigAction.SetKind, kind: patch.kind },
					compileActive(state)?.entities ?? [],
				);
			}
			if (patch.layoutOptions) updateViewLayout(state, view.id, patch.layoutOptions);
			if (patch.columns) updateViewColumns(state, view.id, patch.columns);
			// `null` is a meaningful value (clear grouping) — test presence,
			// not truthiness.
			if ("groupBy" in patch) updateViewGroupBy(state, view.id, patch.groupBy ?? null);
			if ("coverProperty" in patch)
				updateViewCardFields(state, view.id, { coverProperty: patch.coverProperty ?? null });
			if ("cardSubtitleProperty" in patch)
				updateViewCardFields(state, view.id, {
					cardSubtitleProperty: patch.cardSubtitleProperty ?? null,
				});
			renderActiveView(state);
			renderViewTabs(state);
			schedulePersist(state);
			openViewSettingsForActive(state, anchor);
		},
		onClose: () => closeViewSettings(),
	});
}

/** True when focus is in a text-entry surface — the inline filter prompt,
 *  search box, or any contenteditable — so Space stays a literal space
 *  there and only triggers Quick Look on the grid itself. */
function isTextInputFocused(): boolean {
	const el = document.activeElement;
	if (!(el instanceof HTMLElement)) return false;
	const tag = el.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

function bindStageKeyboard(state: AppState): void {
	const body = document.getElementById("stage-body");
	if (!body) return;
	body.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			state.selection = clearSelection();
			state.chrome.inspectorOpen = false;
			applyChrome(state);
			repaintSelection(state);
			updateSelectionBar(state);
			renderInspector(state);
		}
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
			event.preventDefault();
			selectAllVisible(state);
		}
		if (event.key === " " && !isTextInputFocused()) {
			const entity = singleSelectedEntity(state);
			if (entity) {
				event.preventDefault();
				void dispatchQuickLook(entity);
			}
		}
	});
}

/** F2 on a focused view tab starts the inline rename — the keyboard twin of
 *  the tab double-click (F-208). Bound through the SDK shortcut layer so the
 *  single-key chord auto-suppresses while a rename (contenteditable) or a
 *  menu owns the keyboard. */
function bindViewTabKeyboard(state: AppState): void {
	const root = document.getElementById("view-tabs");
	if (!root) return;
	attachShortcut(root, "F2", (event) => {
		const tab =
			event.target instanceof Element ? event.target.closest<HTMLElement>("[data-view-id]") : null;
		const viewId = tab?.dataset.viewId;
		if (viewId) beginViewTabRename(state, viewId);
	});
	// Keyboard reorder — the accessible twin of the tab drag (KBN). Mod+Shift
	// steps the focused tab toward the arrow; focus follows the moved tab so a
	// run of steps keeps working without re-grabbing.
	attachShortcut(root, "Mod+Shift+ArrowLeft", (event) => moveFocusedViewTab(state, event, -1));
	attachShortcut(root, "Mod+Shift+ArrowRight", (event) => moveFocusedViewTab(state, event, 1));
}

/** Step the keyboard-focused view tab one slot toward `delta` and refocus it.
 *  Shared by the two reorder chords. */
function moveFocusedViewTab(state: AppState, event: KeyboardEvent, delta: -1 | 1): void {
	const tab =
		event.target instanceof Element ? event.target.closest<HTMLElement>("[data-view-id]") : null;
	const viewId = tab?.dataset.viewId;
	const list = activeList(state);
	if (!viewId || !list) return;
	const next = moveViewByStep(list.views, viewId, delta);
	if (next === list.views) return;
	state.lists = state.lists.map((l) =>
		l.id === list.id ? { ...l, views: next, updatedAt: Date.now() } : l,
	);
	renderViewTabs(state);
	schedulePersist(state);
	document.querySelector<HTMLElement>(`#view-tabs [data-view-id="${viewId}"]`)?.focus();
}

function selectAllVisible(state: AppState): void {
	const ids = orderedVisibleIds(state);
	const set = new Set(ids);
	state.selection = { selectedIds: set, anchorId: ids[0] ?? null };
	state.chrome.inspectorOpen = true;
	applyChrome(state);
	renderInspector(state);
	repaintSelection(state);
	updateSelectionBar(state);
}

/* ── Status pill ───────────────────────────────────────────────────────── */

function flashStatus(text: string, kind: "ready" | "warn"): void {
	const pill = document.getElementById("status-pill");
	if (!pill) return;
	pill.hidden = false;
	pill.textContent = text;
	pill.classList.toggle("status-pill--ready", kind === "ready");
	if (statusTimer) clearTimeout(statusTimer);
	statusTimer = setTimeout(() => {
		pill.hidden = true;
	}, 2500);
}

function setStatus(text: string, kind: "ready" | "warn"): void {
	const pill = document.getElementById("status-pill");
	if (!pill) return;
	if (statusTimer) {
		clearTimeout(statusTimer);
		statusTimer = null;
	}
	if (!text) {
		pill.hidden = true;
		return;
	}
	pill.hidden = false;
	pill.textContent = text;
	pill.classList.toggle("status-pill--ready", kind === "ready");
}

/* ── Runtime hookup ───────────────────────────────────────────────────── */

type VaultEntityShape = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	deletedAt: number | null;
	ownerAppId: string;
};

type VaultLinkShape = {
	id: string;
	sourceEntityId: string;
	destEntityId: string;
	linkType: string;
	createdAt: number;
	deletedAt: null;
};

type VaultSnapshot = {
	entities: VaultEntityShape[];
	links: VaultLinkShape[];
};

type IntentDispatcher = {
	dispatch(intent: { verb: string; payload: Record<string, unknown> }): Promise<unknown>;
};

type StorageBag = {
	put(key: string, value: unknown): Promise<unknown>;
	get<T>(key: string): Promise<T | null>;
};

type BrainstormSubscription = { unsubscribe(): void };

type BrainstormRuntime = {
	on(event: "ready", h: () => void): void;
	on(
		event: "intent",
		h: (e: {
			type: string;
			intent: { verb: string; payload: Record<string, unknown> };
		}) => void,
	): void;
	app?: { id: string };
	/** Granted capabilities — the shared object menu reads this to gate
	 *  the Pin toggle on `dashboard.pin` (default-minimum, so normally
	 *  present). */
	capabilities?: readonly string[];
	/** Per-launch context; carries a target `entityId` when this app
	 *  window was opened via a cross-app `intent.open`. The renderer
	 *  reads it once after the persisted state has loaded so the
	 *  intent-named List / ListView / row wins over the user's prior
	 *  selection — but only for *this* launch, never overwriting the
	 *  persisted prefs on disk. */
	launch?: { reason: string; entityId?: string };
	services?: {
		vaultEntities?: {
			list(): Promise<VaultSnapshot>;
			/** 9.12.3 — shell-side `ListSource` resolution. Optional so the
			 *  app keeps working against an older bridge (preview /
			 *  standalone-dev); absent → membership evaluates in-memory. */
			querySource?(source: ListSource | null): Promise<SourceQueryResult>;
			onChange?(listener: () => void): BrainstormSubscription;
		};
		properties?: {
			list(): Promise<PropertiesSnapshot>;
			onChange?(listener: () => void): BrainstormSubscription;
			/** 9.3.5.U.b — Database mints new `PropertyDef`s through the
			 *  column-adder's "+ Create new property" flow. Manifest grants
			 *  `properties.write`. Optional on the type so the existing
			 *  read-only path keeps working when the host doesn't expose
			 *  the write half (preview, non-Electron). */
			setProperty?(def: PropertyDef): Promise<void>;
			setDictionary?(dict: Dictionary): Promise<void>;
		};
		intents?: IntentDispatcher;
		storage?: StorageBag;
		/** Per-device, non-synced settings — where `database:state` (view
		 *  config) lives. Same get/put shape as `storage`. */
		settings?: StorageBag;
		/** Real shared entities service — present once the shell exposes
		 *  it. Database uses it for the create flow (+ New); reads still
		 *  go through `vaultEntities` (the aggregator). Manifest grants
		 *  `entities.write:*`. Mirrors the Notes→entities slice. */
		entities?: {
			create(type: string, properties: Record<string, unknown>, id?: string): Promise<Entity>;
			/** Patch-merge into an entity's `properties` (B7.3: writing
			 *  `properties.icon` / `properties.cover` from the inspector). */
			update(id: string, patch: Record<string, unknown>): Promise<Entity>;
			/** 9.3.5.V 7b-wire — user Lists round-trip as `brainstorm/List/v1`
			 *  entities through `get`/`query`/`delete` (see `list-persistence`). */
			get(id: string): Promise<Entity | null>;
			query(query: EntityQuery): Promise<Entity[]>;
			delete(id: string): Promise<void>;
		};
		/** Vault-shared cover content store (B7.2c). Injected into the
		 *  `<CoverPicker>` so its Image tab can upload + list. */
		covers?: {
			uploadBytes(filename: string, bytes: Uint8Array): Promise<{ url: string; thumbUrl: string }>;
			list(): Promise<ReadonlyArray<{ url: string; thumbUrl: string }>>;
		};
		/** Pin-any-object-to-dashboard (7.13). Drives the shared object
		 *  menu's Pin / Unpin toggle. Manifest grants `dashboard.pin`
		 *  (default-minimum). */
		dashboard?: {
			pin(t: { entityId: string }): Promise<boolean>;
			unpin(t: { entityId: string }): Promise<boolean>;
			isPinned(t: { entityId: string }): Promise<boolean>;
		};
		/** Files host service slice the 9.12.16-UI import flow needs.
		 *  Narrowed to `requestOpen` + `read`; the full surface lives in
		 *  `@brainstorm/sdk-types::FilesService`. Present only when
		 *  `files.read` is granted; the "Import…" affordance hides
		 *  entirely otherwise (preview / standalone-dev / future
		 *  non-Electron host). */
		files?: {
			requestOpen(opts?: {
				readonly title?: string;
				readonly filters?: readonly { readonly name: string; readonly extensions: readonly string[] }[];
				readonly multi?: boolean;
			}): Promise<readonly { readonly handleId: string; readonly displayName: string }[]>;
			read(handle: { readonly handleId: string; readonly displayName: string }): Promise<Uint8Array>;
			/** Save half (granted by `files.write`) — drives the 9.12.19
			 *  list-export flow. Absent on older shells → Export… no-shows. */
			requestSave(opts?: {
				readonly title?: string;
				readonly filters?: readonly { readonly name: string; readonly extensions: readonly string[] }[];
				readonly suggestedName?: string;
			}): Promise<{ readonly handleId: string; readonly displayName: string } | null>;
			write(
				handle: { readonly handleId: string; readonly displayName: string },
				data: Uint8Array | ArrayBuffer,
			): Promise<void>;
		};
	};
};

function getRuntime(): BrainstormRuntime | null {
	return (window as unknown as { brainstorm?: BrainstormRuntime }).brainstorm ?? null;
}

function announceRuntime(state: AppState): void {
	const runtime = getRuntime();
	if (!runtime) {
		setStatus("No vault — open in Brainstorm", "warn");
		return;
	}
	setStatus("Loading vault…", "warn");
	runtime.on("ready", () => {
		void (async () => {
			// Persisted deltas must be in `persistedUserDeltas` before the
			// first `applyVaultSnapshot`, else vault-derived views rebuild
			// without the user's saved per-view config (board column order,
			// sort, filter) and revert to the seed default on every restart.
			await persistedReady;
			// Properties first so the very first vault paint already colours
			// chips from the real dictionaries (not the demo fallback).
			await loadVaultProperties(state);
			await loadVaultEntities(state);
			// Subscribe to vault-entities staleness signals so the list
			// reflects new notes / mentions without a manual refresh.
			// Mirrors the Graph app's wiring; both apps share the same
			// `app:vault-entities-changed` channel through the preload.
			subscribeVaultEntitiesUpdates(state);
			subscribeVaultPropertiesUpdates(state);
		})();
	});
	// 9.12.14 — running-window `intent.open`: a cross-app open against a
	// List / ListView / row while Database is already open focuses the
	// existing window (the handshake doesn't re-fire), and the preload's
	// `app:intent` push re-emits the lifecycle event here. Mirrors Tasks.
	runtime.on("intent", (event) => {
		if (!event || event.type !== "intent") return;
		const { verb, payload } = event.intent;
		if (verb !== IntentVerb.Open) return;
		const entityId = typeof payload?.entityId === "string" ? payload.entityId : null;
		if (entityId) applyOpenEntitySelection(state, entityId);
	});
}

function subscribeVaultEntitiesUpdates(state: AppState): void {
	const runtime = getRuntime();
	const onChange = runtime?.services?.vaultEntities?.onChange;
	if (!onChange) return;
	// B6.3 fans a stale signal on *every* note/task write in *any* app.
	// Debounce (trailing, mirrors `schedulePersist`'s 400 ms) so a burst
	// of cross-app writes coalesces into one rebuild instead of tearing
	// down the stage per keystroke; `loadVaultEntities` additionally
	// short-circuits when the snapshot signature is unchanged.
	onChange.call(runtime?.services?.vaultEntities, () => {
		scheduleVaultReload(state);
	});
}

/** Pull the vault PropertiesSnapshot and install a resolver backed by it
 *  (demo map as the fallback for free-form / unknown values). Best-effort:
 *  a missing service or a thrown call just leaves the demo resolver in
 *  place — chips still render, just from the demo colours. */
async function loadVaultProperties(state: AppState): Promise<void> {
	const svc = getRuntime()?.services?.properties;
	if (!svc) return;
	try {
		const snapshot = await svc.list();
		installVocabularyResolver(buildVocabularyResolver(snapshot, NULL_VOCAB));
		installVocabularyLabelResolver(buildVocabularyLabelResolver(snapshot));
		installPropertyDefResolver(buildPropertyDefResolver(snapshot));
		// Cache the catalog for the column-adder picker (9.3.5.U.b). Sorted
		// alpha by display name so the picker order is stable across
		// in-place updates from Settings → Data.
		cachedVaultProperties = Object.values(snapshot.properties ?? {})
			.slice()
			.sort((a, b) =>
				(a.name || a.key).localeCompare(b.name || b.key, undefined, { sensitivity: "base" }),
			);
		cachedDictionaries = snapshot.dictionaries ?? {};
		renderActiveView(state);
	} catch {
		// Keep the demo resolver installed at boot.
	}
}

/* ── 9.3.5.U.b: collection schema editor ────────────────────────────────
 *
 * The "+ Create new property" option in the column-adder routes here.
 * Mounts the shared `<InlinePropertyForm>` via `openInlinePropertyForm`,
 * persists the validated def + optional dictionary through
 * `services.properties.{set}`, refreshes the local catalog cache, and
 * attaches the new property as a visible column on the supplied view.
 *
 * Fail-soft posture: a missing service (early boot, non-Electron host)
 * just flashes a status and returns; the user can still pick existing
 * properties from the same picker.
 */

const INLINE_PROPERTY_FORM_LABELS = {
	region: "New property",
	back: "Back",
	nameLabel: "Name",
	namePlaceholder: "Property name",
	kindLabel: "Kind",
	formatLabel: "Format",
	multiLabel: "Allow multiple",
	cancel: "Cancel",
	submit: "Create",
	kindText: "Text",
	kindNumber: "Number",
	kindBoolean: "Boolean",
	kindDate: "Date",
	kindSelect: "Select",
	kindRelation: "Relation",
	kindFile: "File",
	kindFormula: "Formula",
	formulaLabel: "Expression",
	formulaPlaceholder: "{price} * {quantity}",
	formulaHint: "Reference other properties with {braces}. Read-only, computed per row.",
	formatPlain: "Plain",
	formatUrl: "URL",
	formatEmail: "Email",
	formatPhone: "Phone",
	formatCurrency: "Currency",
	formatPercent: "Percent",
	formatDuration: "Duration",
	currencyLabel: "Currency",
	optionsLabel: "Options",
	optionsPlaceholder: "Lead, Qualified, Proposal, Won, Lost",
	optionsHint: "One per line, or comma-separated. Add more later in Settings → Data.",
	relationTargetLabel: "Links to",
	relationTargetAny: "Anything",
};

function openColumnPropertyConstructor(state: AppState, view: ListView, _seedName: string): void {
	openInlinePropertyForm({
		labels: INLINE_PROPERTY_FORM_LABELS,
		relationTargetTypes: relationTargetTypesFromEntities(state.db.entities),
		onCommit: async ({ def, dictionary }) => {
			// Reuse an existing catalog def with the same name + type instead of
			// minting a duplicate (F-034): re-adding "Deal size · Number" should
			// land the column on the property that already exists, not a fourth
			// identical def. Same name + type IS the same property (Notion/
			// Anytype rule); attach its column and skip the persist entirely.
			const reusable = findReusablePropertyDef(cachedVaultProperties, def.name ?? "", def.valueType);
			if (reusable) {
				updateViewColumns(state, view.id, appendColumnForProperty(view.columns, reusable.key));
				renderActiveView(state);
				schedulePersist(state);
				flashStatus(`Added existing property "${reusable.name || reusable.key}"`, "ready");
				return;
			}
			// Bail before touching the view if the def never reached the vault
			// catalog — otherwise the column references a propertyId nothing
			// resolves (blank cells) and we'd flash a contradictory success
			// on top of the persist warning.
			if (!(await persistNewPropertyDef(def, dictionary))) return;
			// Cache + resolvers refresh against the new catalog; the next
			// view-settings render uses them.
			await loadVaultProperties(state);
			updateViewColumns(state, view.id, [...view.columns, { propertyId: def.key, visible: true }]);
			renderActiveView(state);
			schedulePersist(state);
			flashStatus(`Added property "${def.name || def.key}"`, "ready");
		},
	});
}

/** Returns `true` only when the def actually reached the vault catalog,
 *  so the caller can skip attaching a column that would resolve to
 *  nothing. */
async function persistNewPropertyDef(
	def: PropertyDef,
	dictionary: Dictionary | null,
): Promise<boolean> {
	const svc = getRuntime()?.services?.properties;
	if (!svc?.setProperty) {
		flashStatus("Couldn't save — properties service not exposed by this shell", "warn");
		return false;
	}
	try {
		// Dictionary lands first so the def's `vocabulary.dictionaryId`
		// resolves once the def is broadcast. Mirrors Notes'
		// `AddPropertyMenu` commit order.
		if (dictionary && svc.setDictionary) await svc.setDictionary(dictionary);
		await svc.setProperty(def);
		return true;
	} catch (error) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		flashStatus(`Property save failed — ${message}`, "warn");
		return false;
	}
}

function subscribeVaultPropertiesUpdates(state: AppState): void {
	const runtime = getRuntime();
	const onChange = runtime?.services?.properties?.onChange;
	if (!onChange) return;
	// Settings → Data edits (or a re-seed) fan `app:properties-changed`;
	// re-pull the snapshot so chip colours track the dictionaries live.
	onChange.call(runtime?.services?.properties, () => {
		void loadVaultProperties(state);
	});
}

function scheduleVaultReload(state: AppState): void {
	if (vaultReloadTimer) clearTimeout(vaultReloadTimer);
	vaultReloadTimer = setTimeout(() => {
		vaultReloadTimer = null;
		void loadVaultEntities(state);
	}, 250);
}

/** Cheap O(E+L) fingerprint of a vault snapshot — counts + freshest
 *  timestamps + distinct-type count. Equal signature ⇒ nothing the
 *  Database renders changed, so the rebuild (full nav + stage
 *  `replaceChildren`) is skipped. Catches the common "a sibling app
 *  wrote, but not a type/row/timestamp we surface" fan-out. */
function snapshotSignature(snapshot: VaultSnapshot): string {
	let maxUpdated = 0;
	let maxCreated = 0;
	const types = new Set<string>();
	for (const e of snapshot.entities) {
		if (e.updatedAt > maxUpdated) maxUpdated = e.updatedAt;
		if (e.createdAt > maxCreated) maxCreated = e.createdAt;
		types.add(e.type);
	}
	return `${snapshot.entities.length}:${snapshot.links.length}:${maxUpdated}:${maxCreated}:${types.size}`;
}

/** A vault-derived id is owned by `buildVaultLists` — it's regenerated on
 *  every snapshot, so it must never be persisted as a "user" List/View
 *  nor treated as one when re-layering. */
function isVaultDerivedListId(id: string): boolean {
	return id.startsWith("list_vault_");
}
function isVaultDerivedViewId(id: string): boolean {
	return id.startsWith("view_vault_");
}

async function loadVaultEntities(state: AppState): Promise<void> {
	const runtime = getRuntime();
	const service = runtime?.services?.vaultEntities;
	if (!service) {
		setStatus("No vault connected", "warn");
		return;
	}
	try {
		const snapshot = await service.list();
		const sig = snapshotSignature(snapshot);
		if (sig === lastVaultSignature) return; // nothing we render changed
		lastVaultSignature = sig;
		applyVaultSnapshot(state, snapshot);
		void refreshSourceIds(state);
	} catch (error) {
		const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		console.warn("[database] vaultEntities.list failed:", error);
		setStatus(`Vault load failed — ${message}`, "warn");
	}
}

/** Swap the app onto real vault data: derive `byType` Lists from the
 *  snapshot (no demo entities mixed in — per the established "empty vault =
 *  empty app" pattern), re-layer the user's own Lists/Views, repair the
 *  active selection, and re-render. Idempotent + stable-id so the live
 *  `onChange` rebuild doesn't churn the sidebar or lose the selection. */
function applyVaultSnapshot(state: AppState, snapshot: VaultSnapshot): void {
	const built = buildVaultLists(snapshot);
	state.db = built.db;
	state.lists = [
		...built.lists,
		...persistedUserDeltas.lists.filter((l) => !isVaultDerivedListId(l.id)),
	];
	state.views = [
		// Re-attach the user's saved per-view config onto the freshly
		// regenerated vault views (stable ids), so sort/filter/columns/
		// kind/manualOrder survive a vault `onChange` rebuild.
		...built.views.map((v) => mergeOverlay(v, persistedUserDeltas.viewOverrides[v.id])),
		...persistedUserDeltas.views.filter((v) => !isVaultDerivedViewId(v.id)),
	];

	repairActiveSelection(state, built);

	renderListNav(state);
	renderViewTabs(state);
	renderStageHeader(state);
	renderActiveView(state);

	const count = state.db.entities.length;
	setStatus(count === 0 ? "Vault (empty)" : `Vault · ${count}`, count === 0 ? "warn" : "ready");

	// A cross-app `intent.open` still wins over the restored selection,
	// even though the rebuild lands after persisted-state load.
	applyLaunchContextSelection(state);
}

/** Selection survival across a rebuild, in priority order: keep the live
 *  selection if it still resolves → the user's last persisted selection if
 *  it resolves against the new Lists → the most-populous vault List →
 *  clear (empty vault). */
function selectionResolves(state: AppState, sel: ViewSelection | null): boolean {
	if (!sel) return false;
	const view = state.views.find((v) => v.id === sel.viewId);
	const list = state.lists.find((l) => l.id === sel.listId);
	return !!view && !!list && view.listId === list.id;
}

function repairActiveSelection(state: AppState, built: ReturnType<typeof buildVaultLists>): void {
	if (selectionResolves(state, state.active)) return;
	if (selectionResolves(state, persistedUserDeltas.active)) {
		if (persistedUserDeltas.active) state.active = persistedUserDeltas.active;
		return;
	}
	// Prefer landing on the user's OWN collection over a system type-list
	// (F-005: a fresh open dropped the founder on the auto-derived "Folders"
	// list instead of the CRM they came to build). Only the fallback path —
	// a resolvable persisted selection above still wins for returning users.
	const own = firstOwnCollectionSelection(state);
	if (own) {
		state.active = own;
		return;
	}
	const fallback = firstVaultSelection(built);
	if (fallback) state.active = fallback;
}

/** The first user-created collection (a Blank/Manual collection — `source ===
 *  null`, never an auto-derived type-list) with a resolvable view, or null
 *  when the vault has none. The F-005 landing preference. */
function firstOwnCollectionSelection(state: AppState): ViewSelection | null {
	for (const list of state.lists) {
		if (deriveListMode(list) !== ListMode.Manual) continue;
		const views = viewsForList(state, list.id);
		const viewId = resolveListView(
			views,
			persistedUserDeltas.lastViewByList[list.id],
			list.defaultViewId,
		);
		if (viewId) return { listId: list.id, viewId };
	}
	return null;
}

async function dispatchOpenIntent(entity: EntityRow): Promise<void> {
	await openEntity(getRuntime(), { entityId: entity.id, entityType: entity.type });
}

async function dispatchQuickLook(entity: EntityRow): Promise<void> {
	await quickLookEntity(getRuntime(), { entityId: entity.id, entityType: entity.type });
}

/** The single selected row, if exactly one is selected (Quick Look /
 *  Space target — Quick Look is a one-entity preview, never multi). */
function singleSelectedEntity(state: AppState): EntityRow | undefined {
	if (state.selection.selectedIds.size !== 1) return undefined;
	const id = [...state.selection.selectedIds][0];
	return id ? state.db.entities.find((e) => e.id === id) : undefined;
}

/* ── Theme tracking ────────────────────────────────────────────────────── */

function watchTokenChanges(state: AppState): void {
	if (typeof MutationObserver === "undefined") return;
	const observer = new MutationObserver(() => {
		renderActiveView(state);
	});
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["style"],
	});
}

/* ── Persistence ──────────────────────────────────────────────────────── */

/** Per-view deltas for the vault-derived views, keyed by stable id —
 *  the shape `applyVaultSnapshot` re-layers on an `onChange` rebuild and
 *  `persistState` writes to disk. */
function collectViewOverrides(state: AppState): Record<string, ViewOverride> {
	const overrides: Record<string, ViewOverride> = {};
	for (const v of state.views) {
		if (isVaultDerivedViewId(v.id)) overrides[v.id] = viewOverrideOf(v);
	}
	return overrides;
}

function schedulePersist(state: AppState): void {
	// Refresh the in-memory overlay SYNCHRONOUSLY. Disk write + entity reconcile
	// are debounced, but a vault `onChange` rebuild can land before them —
	// without this, `applyVaultSnapshot` re-layers the stale overlay and drops a
	// just-created collection (its selection then can't resolve and resets to a
	// default — F-010) or reverts a just-made column reorder / sort / filter.
	persistedUserDeltas.viewOverrides = collectViewOverrides(state);
	persistedUserDeltas.lists = state.lists.filter((l) => !isVaultDerivedListId(l.id));
	persistedUserDeltas.views = state.views.filter((v) => !isVaultDerivedViewId(v.id));
	persistedUserDeltas.active = state.active;
	if (state.active.listId && state.active.viewId) {
		persistedUserDeltas.lastViewByList[state.active.listId] = state.active.viewId;
	}
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		persistTimer = null;
		void persistState(state);
		void reconcileUserLists(state);
		void reconcileUserViews(state);
	}, 400);
}

/** Reconcile the user-created Lists into `entities.db` (9.3.5.V 7b-wire):
 *  create-or-update each changed List and delete any the user removed since
 *  the last reconcile. Vault-derived Lists are never persisted (they
 *  regenerate from the snapshot). Only Lists whose serialized form changed
 *  are written, so an unchanged debounced persist issues no entity writes
 *  and triggers no broadcast. */
async function reconcileUserLists(state: AppState): Promise<void> {
	const entities = getRuntime()?.services?.entities;
	if (!entities) return;
	const current = state.lists.filter((l) => !isVaultDerivedListId(l.id));
	const plan = planListReconcile(current, reconciledListSnapshot);
	try {
		for (const id of plan.toDelete) {
			await deleteUserList(entities, id);
			reconciledListSnapshot.delete(id);
		}
		for (const list of plan.toSave) {
			await saveUserList(entities, list);
			reconciledListSnapshot.set(list.id, serializeListForReconcile(list));
		}
	} catch (error) {
		console.warn("[database] reconcile user lists failed:", error);
	}
}

/** Reconcile the user-created views into `entities.db` (9.12.8): the
 *  ListView analogue of {@link reconcileUserLists}, same diff-only write
 *  discipline. Vault-derived views never persist (their user tweaks ride
 *  in `viewOverrides`). */
async function reconcileUserViews(state: AppState): Promise<void> {
	const entities = getRuntime()?.services?.entities;
	if (!entities) return;
	const current = state.views.filter((v) => !isVaultDerivedViewId(v.id));
	const plan = planViewReconcile(current, reconciledViewSnapshot);
	try {
		for (const id of plan.toDelete) {
			await deleteUserView(entities, id);
			reconciledViewSnapshot.delete(id);
		}
		for (const view of plan.toSave) {
			await saveUserView(entities, view);
			reconciledViewSnapshot.set(view.id, serializeViewForReconcile(view));
		}
	} catch (error) {
		console.warn("[database] reconcile user views failed:", error);
	}
}

async function persistState(state: AppState): Promise<void> {
	const storage = getRuntime()?.services?.settings ?? getRuntime()?.services?.storage;
	if (!storage) return;
	// Per-device prefs only: user-created Lists persist to `entities.db`
	// via `reconcileUserLists` (9.3.5.V 7b-wire) and user-created views via
	// `reconcileUserViews` (9.12.8); vault-derived views regenerate from
	// the snapshot every load (their per-view deltas ride in
	// `viewOverrides`, keyed by stable id).
	const viewOverrides = collectViewOverrides(state);
	const payload: PersistedState = {
		version: 6,
		active: state.active,
		chrome: state.chrome,
		viewOverrides,
		lastViewByList: persistedUserDeltas.lastViewByList,
	};
	try {
		await storage.put(STORAGE_KEY, payload);
	} catch (error) {
		console.warn("[database] persist failed:", error);
	}
}

async function loadPersistedState(state: AppState): Promise<void> {
	const storage = getRuntime()?.services?.settings ?? getRuntime()?.services?.storage;
	const entities = getRuntime()?.services?.entities;

	// User-created Lists live in `entities.db` since 7b-wire, and
	// user-created views since 9.12.8 — load both up front, independent of
	// the kv payload (a fresh entity-backed vault may have no kv payload at
	// all). Seed the reconcile snapshots so the first debounced persist
	// doesn't re-write what we just read back.
	let userLists: List[] = [];
	let userViews: ListView[] = [];
	if (entities) {
		try {
			userLists = (await loadUserLists(entities)).filter((l) => !isVaultDerivedListId(l.id));
			for (const l of userLists) reconciledListSnapshot.set(l.id, serializeListForReconcile(l));
		} catch (error) {
			console.warn("[database] load user lists failed:", error);
		}
		try {
			userViews = (await loadUserViews(entities)).filter((v) => !isVaultDerivedViewId(v.id));
			for (const v of userViews) reconciledViewSnapshot.set(v.id, serializeViewForReconcile(v));
		} catch (error) {
			console.warn("[database] load user views failed:", error);
		}
	}

	let restoredActive: ViewSelection | null = null;
	let viewOverrides: Record<string, ViewOverride> = {};
	let lastViewByList: Record<string, string> = {};

	if (storage) {
		try {
			const raw = await storage.get<
				| PersistedState
				| PersistedStateV5
				| PersistedStateV4
				| PersistedStateV3
				| PersistedStateV2
				| PersistedStateV1
			>(STORAGE_KEY);
			if (raw) {
				restoredActive = raw.active;
				if (raw.version !== 1 && raw.version !== 2) {
					viewOverrides = raw.viewOverrides;
				}
				if (raw.version === 4 || raw.version === 5 || raw.version === 6) {
					lastViewByList = raw.lastViewByList;
				}
				// One-time migration: a pre-v5 payload still carries `userLists`
				// in kv. Promote any not already in `entities.db` into it, then
				// the next persist writes the current version and the field is
				// gone for good.
				if (raw.version === 2 || raw.version === 3 || raw.version === 4) {
					const kvLists = raw.userLists.filter((l) => !isVaultDerivedListId(l.id));
					if (entities) {
						for (const l of kvLists) {
							if (reconciledListSnapshot.has(l.id)) continue;
							try {
								await saveUserList(entities, l);
								userLists.push(l);
								reconciledListSnapshot.set(l.id, serializeListForReconcile(l));
							} catch (error) {
								console.warn("[database] migrate kv list failed:", error);
							}
						}
					} else {
						// Older shell with no entities service — keep kv Lists.
						userLists = kvLists;
					}
				}
				// One-time migration (9.12.8): a pre-v6 payload still carries
				// `userViews` in kv. Promote any not already in `entities.db`,
				// mirroring the list promotion above.
				if (raw.version !== 1 && raw.version !== 6) {
					const kvViews = raw.userViews.filter((v) => !isVaultDerivedViewId(v.id));
					if (entities) {
						for (const v of kvViews) {
							if (reconciledViewSnapshot.has(v.id)) continue;
							try {
								await saveUserView(entities, v);
								userViews.push(v);
								reconciledViewSnapshot.set(v.id, serializeViewForReconcile(v));
							} catch (error) {
								console.warn("[database] migrate kv view failed:", error);
							}
						}
					} else {
						// Older shell with no entities service — keep kv views.
						userViews = kvViews;
					}
				}
			}
		} catch (error) {
			console.warn("[database] load persisted state failed:", error);
		}
	}

	// Stash for the vault rebuild to re-layer; also apply now so the
	// pre-`ready` demo view shows the user's Lists immediately.
	persistedUserDeltas = {
		lists: userLists,
		views: userViews,
		active: restoredActive,
		viewOverrides,
		lastViewByList,
	};
	for (const list of userLists) state.lists.push(list);
	for (const view of userViews) state.views.push(view);

	if (restoredActive) {
		const view = state.views.find((v) => v.id === restoredActive.viewId);
		const list = state.lists.find((l) => l.id === restoredActive.listId);
		if (view && list && view.listId === list.id) {
			state.active = restoredActive;
		}
	}
	// `raw.chrome` is intentionally ignored: chrome (sidebar/inspector open)
	// lives in `localStorage` so it's applied to `#db-main` synchronously
	// before first paint (see top-of-module). Reading it here would flip the
	// data attributes post-paint and animate the layout — exactly the "open
	// animation" the toggle-only rule forbids ([[panel-transition-toggle-only]]).
	renderListNav(state);
	renderViewTabs(state);
	renderStageHeader(state);
	renderActiveView(state);

	applyLaunchContextSelection(state);
	// Vault + persisted + launch-override are all resolved now — make the
	// restored {list,view} the clean history origin so the first Back
	// doesn't return to a pre-load empty state.
	dbNav?.reset({ listId: state.active.listId, viewId: state.active.viewId });
}

/** Honour `runtime.launch.entityId` AFTER persisted state has loaded so a
 *  cross-app `intent.open` can override the user's prior session. */
function applyLaunchContextSelection(state: AppState): void {
	const launch = getRuntime()?.launch;
	if (!launch || launch.reason !== "open-entity" || !launch.entityId) return;
	applyOpenEntitySelection(state, launch.entityId);
}

/** The `intent.open` navigation cascade — List → ListView → entity row
 *  (9.12.14). Shared by the launch-context path (cold open) and the
 *  running-window `app:intent` push (the launcher focuses an existing
 *  window without re-firing the handshake). Misses fall through silently
 *  because the dispatcher's "no-delivery-channel" fallback shouldn't
 *  escalate into a renderer error. */
function applyOpenEntitySelection(state: AppState, entityId: string): void {
	const list = state.lists.find((l) => l.id === entityId);
	if (list) {
		const view = state.views.find((v) => v.listId === list.id) ?? null;
		if (view) {
			state.active = { listId: list.id, viewId: view.id };
			renderListNav(state);
			renderViewTabs(state);
			renderStageHeader(state);
			renderActiveView(state);
		}
		return;
	}

	const view = state.views.find((v) => v.id === entityId);
	if (view) {
		const owner = state.lists.find((l) => l.id === view.listId);
		if (owner) {
			state.active = { listId: owner.id, viewId: view.id };
			renderListNav(state);
			renderViewTabs(state);
			renderStageHeader(state);
			renderActiveView(state);
		}
		return;
	}

	const entity = state.db.entities.find((e) => e.id === entityId);
	if (entity) {
		const owningList = state.lists.find((l) => effectiveMembershipOf(state, l).has(entity.id));
		if (owningList) {
			const owningView = state.views.find((v) => v.listId === owningList.id) ?? null;
			if (owningView) {
				state.active = { listId: owningList.id, viewId: owningView.id };
				renderListNav(state);
				renderViewTabs(state);
				renderStageHeader(state);
				renderActiveView(state);
			}
		}
		state.selection = { selectedIds: new Set([entity.id]), anchorId: entity.id };
		renderActiveView(state);
	}
}
