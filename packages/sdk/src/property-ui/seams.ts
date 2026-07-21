/**
 * Host seams for the shared property-ui surface.
 *
 * The cells / DictionaryEditor are app-agnostic; everything that used
 * to reach back into the Notes app (its `t()` keys, its keyboard chord
 * registry, its vault entity-title index) is now an injected seam with
 * a self-sufficient default. Notes wires the productionised versions
 * through `<PropertiesProvider>`; tests + non-Notes consumers get a
 * working surface from the defaults alone (zero Notes deps).
 *
 *   1. labels          — every user-visible string. Param-bearing
 *                         strings are functions (`{name}`/`{label}`/…).
 *   2. escapeMatcher    — "is this KeyboardEvent the cancel chord?"
 *   3. commitMatcher    — "is this KeyboardEvent the commit chord?"
 *   4. entityTitleSource — the Link cell's vault title lookup.
 */

import type { VaultEntity } from "@brainstorm-os/sdk-types";

export type KeyLike = KeyboardEvent | { key: string; nativeEvent?: { key: string } };

/** Predicate over a (native or React) KeyboardEvent. Notes injects the
 *  `matchesActionChord(ActionId.CancelInlineEdit, …)` form; the default
 *  is a bare `Escape` test so the subpath works with no chord registry. */
export type EscapeMatcher = (event: KeyLike) => boolean;
export type CommitMatcher = (event: KeyLike) => boolean;

function readKey(event: KeyLike): string {
	if (typeof event === "object" && event && "nativeEvent" in event && event.nativeEvent) {
		return event.nativeEvent.key;
	}
	return (event as { key: string }).key;
}

export const defaultEscapeMatcher: EscapeMatcher = (event) => readKey(event) === "Escape";
export const defaultCommitMatcher: CommitMatcher = (event) => readKey(event) === "Enter";

/** The DictionaryEditor's own chord predicates. Notes wires its
 *  `matchesActionChord(ActionId.CloseDictionaryEditor | …)` registry;
 *  the defaults are the bare keys those ids bind to (Escape / Mod+F /
 *  Space / Arrow↑↓) so the editor is keyboard-operable with no
 *  registry — no raw `e.key` outside this module. */
export type DictionaryEditorMatchers = {
	closeEditor: (event: KeyLike) => boolean;
	focusSearch: (event: KeyLike) => boolean;
	reorderToggle: (event: KeyLike) => boolean;
	reorderUp: (event: KeyLike) => boolean;
	reorderDown: (event: KeyLike) => boolean;
};

function modKey(event: KeyLike): boolean {
	const e = event as Partial<KeyboardEvent> & { nativeEvent?: Partial<KeyboardEvent> };
	const src = e.nativeEvent ?? e;
	return Boolean(src.metaKey || src.ctrlKey);
}

export const DEFAULT_DICTIONARY_EDITOR_MATCHERS: DictionaryEditorMatchers = {
	closeEditor: (event) => readKey(event) === "Escape",
	focusSearch: (event) => modKey(event) && readKey(event).toLowerCase() === "f",
	reorderToggle: (event) => readKey(event) === " ",
	reorderUp: (event) => readKey(event) === "ArrowUp",
	reorderDown: (event) => readKey(event) === "ArrowDown",
};

/** Every user-visible string the moved cells + DictionaryEditor render.
 *  Param-bearing entries are functions; the host wraps its own `t()`. */
export type PropertyUiLabels = {
	cellEmpty: string;
	cellEditValueFor: (name: string) => string;
	cellToggleValueFor: (name: string) => string;
	/** Empty-state prompt for a Tag / Select cell ("Select…"). Optional so
	 *  existing label objects keep type-checking; falls back to `cellEmpty`. */
	selectEmpty?: string;
	/** Empty-state prompt for the Rating cell (the row of outline stars
	 *  carries the affordance; this is the accessible/visual fallback). */
	ratingEmpty?: string;
	/** Accessible name for a single rating star ("Rate 3 of 5"). */
	cellRateValueFor?: (name: string, star: number, max: number) => string;

	tagPickerRegion: (name: string) => string;
	tagSearch: string;
	tagSearchPlaceholder: string;
	tagOptions: string;
	tagNoValues: string;
	tagRemove: (label: string) => string;
	tagManageValues: string;
	/** "Create '<query>'" row in the tag picker (inline vocabulary add). */
	tagCreate?: (label: string) => string;

	datePickerRegion: (name: string) => string;
	dateInput: string;
	datePlaceholder: string;
	dateHint: string;
	dateUnrecognised: string;
	dateSet: string;
	dateClear: string;
	/** Calendar month-step button labels. Optional so existing hosts that
	 *  predate them keep compiling; the date cell falls back to English. */
	datePrevMonth?: string;
	dateNextMonth?: string;

	formatInvalidUrl: string;
	formatInvalidEmail: string;
	formatInvalidPhone: string;

	fileRegion: (name: string) => string;
	fileEmpty: string;
	fileUploadsPending: string;

	linkPickerRegion: (name: string) => string;
	linkSearch: string;
	linkSearchPlaceholder: string;
	linkOptions: string;
	linkNoResults: string;
	/** Fallback shown for a linkable entity with no title/name yet, so the
	 *  picker / chips never surface a raw `ent_…` id. Optional so existing
	 *  label objects keep type-checking; falls back to "Untitled". */
	linkUntitled?: string;

	dictRegion: string;
	dictNameLabel: string;
	dictCount: (n: number) => string;
	dictClose: string;
	dictSearch: string;
	dictSearchPlaceholder: string;
	dictSortLabel: string;
	dictSortManual: string;
	dictSortAlpha: string;
	dictSortAlphaDesc: string;
	dictSortMostUsed: string;
	dictAddItem: string;
	dictImportExport: string;
	dictImportLabel: string;
	dictImportPlaceholder: string;
	dictImportCommit: string;
	dictExportJson: string;
	dictImportFailed: (reason: string) => string;
	dictImportTruncated: (n: number) => string;
	dictItemsRegion: string;
	dictNoItems: string;
	dictItemLabel: string;
	dictUsage: (n: number) => string;
	dictReorder: (label: string) => string;
	dictRowMenu: (label: string) => string;
	dictStartMerge: string;
	dictMergeInto: string;
	dictArchive: string;
	dictDelete: string;
	dictShowArchived: (n: number) => string;
	dictArchivedRegion: string;
	dictUnarchive: string;
};

/** English defaults, matching the strings Notes shipped pre-VP-7. The
 *  subpath + its tests + any non-Notes consumer render correctly with
 *  just these (no `t()` manifest required). */
export const DEFAULT_PROPERTY_UI_LABELS: PropertyUiLabels = {
	// Empty cells render blank (no "Empty" placeholder word) — like Notion /
	// Airtable. The cell stays hover/click-editable; it just isn't labelled.
	cellEmpty: "",
	cellEditValueFor: (name) => `Edit value for ${name}`,
	cellToggleValueFor: (name) => `Toggle ${name}`,
	selectEmpty: "",
	ratingEmpty: "",
	cellRateValueFor: (name, star, max) => `Rate ${name} ${star} of ${max}`,

	tagPickerRegion: (name) => `Choose values for ${name}`,
	tagSearch: "Search values",
	tagSearchPlaceholder: "Search values…",
	tagOptions: "Available values",
	tagNoValues: "No values yet",
	tagRemove: (label) => `Remove ${label}`,
	tagManageValues: "Manage values…",
	tagCreate: (label) => `Create “${label}”`,

	datePickerRegion: (name) => `Set a date for ${name}`,
	dateInput: "Date",
	datePlaceholder: "e.g. tomorrow, next monday, 2026-06-01",
	dateHint: "Type a date or a phrase like “in 3 days”.",
	dateUnrecognised: "Couldn’t read that date",
	dateSet: "Set",
	dateClear: "Clear",
	datePrevMonth: "Previous month",
	dateNextMonth: "Next month",

	formatInvalidUrl: "Not a valid URL",
	formatInvalidEmail: "Not a valid email address",
	formatInvalidPhone: "Not a valid phone number",

	fileRegion: (name) => `Files for ${name}`,
	fileEmpty: "No files",
	fileUploadsPending: "File uploads land when the storage upload API is wired up.",

	linkPickerRegion: (name) => `Link ${name}`,
	linkSearch: "Search to link",
	linkSearchPlaceholder: "Search to link…",
	linkOptions: "Linkable entities",
	linkNoResults: "Nothing to link yet",
	linkUntitled: "Untitled",

	dictRegion: "Dictionary editor",
	dictNameLabel: "Dictionary name",
	dictCount: (n) => `${n} values`,
	dictClose: "Close",
	dictSearch: "Search values",
	dictSearchPlaceholder: "Search values…",
	dictSortLabel: "Sort",
	dictSortManual: "Manual",
	dictSortAlpha: "A → Z",
	dictSortAlphaDesc: "Z → A",
	dictSortMostUsed: "Most used",
	dictAddItem: "Add value",
	dictImportExport: "Import / export",
	dictImportLabel: "Paste CSV, TSV, or JSON",
	dictImportPlaceholder: "label,icon,description — or JSON",
	dictImportCommit: "Import",
	dictExportJson: "Export JSON",
	dictImportFailed: (reason) => `Couldn’t import: ${reason}`,
	dictImportTruncated: (n) =>
		`Imported the first ${n} values; the rest were skipped (too many rows).`,
	dictItemsRegion: "Dictionary values",
	dictNoItems: "No values yet",
	dictItemLabel: "Value label",
	dictUsage: (n) => `${n} notes`,
	dictReorder: (label) => `Reorder ${label}`,
	dictRowMenu: (label) => `Actions for ${label}`,
	dictStartMerge: "Merge into…",
	dictMergeInto: "Merge here",
	dictArchive: "Archive",
	dictDelete: "Delete",
	dictShowArchived: (n) => `Show archived (${n})`,
	dictArchivedRegion: "Archived values",
	dictUnarchive: "Unarchive",
};

/** The Link cell's vault title lookup. Notes wires its existing
 *  `store/entity-title-index` singleton; the default is empty so the
 *  picker simply lists nothing (no Notes runtime dependency). */
export type EntityTitleSource = {
	subscribe(listener: () => void): () => void;
	/** Monotonic staleness tick for `useSyncExternalStore`. */
	snapshotTick(): number;
	/** The full entity list from the last snapshot. */
	list(): readonly VaultEntity[];
	/** Display title for an entity id, or `undefined` when unknown. */
	titleOf(entityId: string): string | undefined;
	/** Display title for a concrete entity (title → name → id). */
	displayTitle(entity: VaultEntity): string;
};

function defaultDisplayTitle(entity: VaultEntity): string {
	const p = entity.properties as { title?: unknown; name?: unknown };
	if (typeof p.title === "string" && p.title.length > 0) return p.title;
	if (typeof p.name === "string" && p.name.length > 0) return p.name;
	return entity.id;
}

export const EMPTY_ENTITY_TITLE_SOURCE: EntityTitleSource = {
	subscribe: () => () => undefined,
	snapshotTick: () => 0,
	list: () => [],
	titleOf: () => undefined,
	displayTitle: defaultDisplayTitle,
};
