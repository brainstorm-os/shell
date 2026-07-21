/**
 * `@brainstorm-os/sdk/property-ui/pure` — the DOM/React-free half of the
 * shared property layer. Pure value formatting + dictionary algebra,
 * nothing that touches `react` or the cell registry (which `register`s
 * at module load — a side effect this barrel must never statically
 * pull, or the importer drags React in).
 *
 * Consumed by the Database app's vanilla-DOM painters (`"types": []`,
 * no `@types/react`). The React face lives at `@brainstorm-os/sdk/
 * property-ui`; do NOT add a `.tsx` / registry / `react` import here.
 */

export {
	type FormatOptions,
	dateFormatter,
	formatDate,
	formatDuration,
	formatNumber,
	formatScalar,
	isValidFormatted,
	numberFormatter,
	parseDateInput,
	parseNaturalDate,
	parseNumberInput,
	parseScalar,
} from "./property-ui/cells/format";
export {
	DICTIONARY_SORT_ORDER,
	DictionarySortMode,
	activeItems,
	archivedItems,
	chipColours,
	dictionarySortPrefKey,
	filterItems,
	findItem,
	isArchived,
	nextSortIndex,
	parseDictionarySortMode,
	sortItems,
} from "./property-ui/dictionary-helpers";
export {
	HEX,
	type ImportResult,
	ImportFormat,
	MAX_IMPORT_ROWS,
	type ParsedRow,
	detectFormat,
	exportJson,
	parseImport,
} from "./property-ui/dictionary-import";
export {
	type NoteValues,
	addItem,
	archiveItem,
	deleteItem,
	mergeItems,
	patchItem,
	propertiesForDictionary,
	renameDictionary,
	reorderItem,
	unarchiveItem,
	usageIndex,
} from "./property-ui/dictionary-ops";
export {
	type ValuesMap,
	bindValue,
	clearValue,
	migrateValuesField,
	readValue,
	writeValue,
} from "./property-ui/value-store";
export {
	type FilterResult,
	PropertyTypeCategory,
	categorizeProperty,
	filterProperties,
	isMultiProperty,
} from "./property-ui/property-catalog";

export type {
	Dictionary,
	DictionaryItem,
	PropertyDef,
	PropertyView,
	ValueType,
} from "@brainstorm-os/sdk-types";
