/**
 * Notes' productionised wiring for the four `@brainstorm-os/sdk/property-ui`
 * host seams. The SDK ships self-sufficient English/keyboard defaults so
 * it never imports back into this app; Notes overrides them here with
 * its own `t()` manifest, its chord registry, and the vault
 * entity-title index — zero string / manifest change (every label below
 * resolves an existing `notes.*` key the cells used pre-VP-7).
 */

import type { VaultEntity } from "@brainstorm-os/sdk-types";
import type {
	DictionaryEditorMatchers,
	EntityTitleSource,
	KeyLike,
	PropertyUiLabels,
} from "@brainstorm-os/sdk/property-ui";
import { t } from "../i18n/t";
import { ActionId } from "../keyboard/action-ids";
import { matchesActionChord } from "../keyboard/use-shortcut";
import {
	entitiesSnapshotList,
	entityTitleOf,
	entityTitlesSnapshot,
	getEntityTitle,
	subscribeEntityTitles,
} from "../store/entity-title-index";

/** Notes' `t()` mapped onto the SDK's label shape. Param-bearing
 *  entries forward through `t(key, params)`; everything else is a flat
 *  lookup. The keys are exactly the ones the moved cells rendered
 *  pre-VP-7, so this is a pure re-route — no manifest edit. */
export const notesPropertyUiLabels: PropertyUiLabels = {
	cellEmpty: t("notes.cell.empty"),
	cellEditValueFor: (name) => t("notes.cell.editValueFor", { name }),
	cellToggleValueFor: (name) => t("notes.cell.toggleValueFor", { name }),

	tagPickerRegion: (name) => t("notes.tag.pickerRegion", { name }),
	tagSearch: t("notes.tag.search"),
	tagSearchPlaceholder: t("notes.tag.searchPlaceholder"),
	tagOptions: t("notes.tag.options"),
	tagNoValues: t("notes.tag.noValues"),
	tagRemove: (label) => t("notes.tag.remove", { label }),
	tagManageValues: t("notes.tag.manageValues"),

	datePickerRegion: (name) => t("notes.date.pickerRegion", { name }),
	dateInput: t("notes.date.input"),
	datePlaceholder: t("notes.date.placeholder"),
	dateHint: t("notes.date.hint"),
	dateUnrecognised: t("notes.date.unrecognised"),
	dateSet: t("notes.date.set"),
	dateClear: t("notes.date.clear"),

	formatInvalidUrl: t("notes.format.invalidUrl"),
	formatInvalidEmail: t("notes.format.invalidEmail"),
	formatInvalidPhone: t("notes.format.invalidPhone"),

	fileRegion: (name) => t("notes.file.region", { name }),
	fileEmpty: t("notes.file.empty"),
	fileUploadsPending: t("notes.file.uploadsPending"),

	linkPickerRegion: (name) => t("notes.link.pickerRegion", { name }),
	linkSearch: t("notes.link.search"),
	linkSearchPlaceholder: t("notes.link.searchPlaceholder"),
	linkOptions: t("notes.link.options"),
	linkNoResults: t("notes.link.noResults"),

	dictRegion: t("notes.dict.region"),
	dictNameLabel: t("notes.dict.nameLabel"),
	dictCount: (n) => t("notes.dict.count", { n }),
	dictClose: t("notes.dict.close"),
	dictSearch: t("notes.dict.search"),
	dictSearchPlaceholder: t("notes.dict.searchPlaceholder"),
	dictSortLabel: t("notes.dict.sortLabel"),
	dictSortManual: t("notes.dict.sort.manual"),
	dictSortAlpha: t("notes.dict.sort.alpha"),
	dictSortAlphaDesc: t("notes.dict.sort.alphaDesc"),
	dictSortMostUsed: t("notes.dict.sort.mostUsed"),
	dictAddItem: t("notes.dict.addItem"),
	dictImportExport: t("notes.dict.importExport"),
	dictImportLabel: t("notes.dict.importLabel"),
	dictImportPlaceholder: t("notes.dict.importPlaceholder"),
	dictImportCommit: t("notes.dict.importCommit"),
	dictExportJson: t("notes.dict.exportJson"),
	dictImportFailed: (reason) => t("notes.dict.importFailed", { reason }),
	dictImportTruncated: (n) => t("notes.dict.importTruncated", { n }),
	dictItemsRegion: t("notes.dict.itemsRegion"),
	dictNoItems: t("notes.dict.noItems"),
	dictItemLabel: t("notes.dict.itemLabel"),
	dictUsage: (n) => t("notes.dict.usage", { n }),
	dictReorder: (label) => t("notes.dict.reorder", { label }),
	dictRowMenu: (label) => t("notes.dict.rowMenu", { label }),
	dictStartMerge: t("notes.dict.startMerge"),
	dictMergeInto: t("notes.dict.mergeInto"),
	dictArchive: t("notes.dict.archive"),
	dictDelete: t("notes.dict.delete"),
	dictShowArchived: (n) => t("notes.dict.showArchived", { n }),
	dictArchivedRegion: t("notes.dict.archivedRegion"),
	dictUnarchive: t("notes.dict.unarchive"),
};

/** `matchesActionChord` takes a native or React KeyboardEvent; the
 *  seam's `KeyLike` is structurally compatible (it carries `key` +
 *  optional `nativeEvent`), so the chord registry stays the single
 *  source of truth — no raw `e.key` leaks into the cells. */
function chord(id: ActionId): (event: KeyLike) => boolean {
	return (event) => matchesActionChord(id, event as Parameters<typeof matchesActionChord>[1]);
}

export const notesEscapeMatcher = chord(ActionId.CancelInlineEdit);
export const notesCommitMatcher = chord(ActionId.CommitInlineEdit);

export const notesDictionaryEditorMatchers: DictionaryEditorMatchers = {
	closeEditor: chord(ActionId.CloseDictionaryEditor),
	focusSearch: chord(ActionId.DictionaryFocusSearch),
	reorderToggle: chord(ActionId.DictionaryReorderToggle),
	reorderUp: chord(ActionId.DictionaryReorderUp),
	reorderDown: chord(ActionId.DictionaryReorderDown),
};

/** The Link cell's vault title lookup, backed by the shared
 *  module-singleton index (one full-vault scan for N entityRef rows). */
export const notesEntityTitleSource: EntityTitleSource = {
	subscribe: (listener: () => void) => subscribeEntityTitles(listener),
	snapshotTick: () => entityTitlesSnapshot(),
	list: () => entitiesSnapshotList(),
	titleOf: (entityId: string) => getEntityTitle(entityId),
	displayTitle: (entity: VaultEntity) => entityTitleOf(entity),
};
