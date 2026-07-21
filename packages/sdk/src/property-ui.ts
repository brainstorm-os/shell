/**
 * `@brainstorm-os/sdk/property-ui` — the React face of the shared property
 * layer: the cell registry, the vault-scoped stores + their provider,
 * the host seams, and the DictionaryEditor.
 *
 * Importing this barrel pulls `react` (peer dep) and runs the cell
 * registry's `register(...)` side effect on load. DOM/React-free
 * consumers (the Database app) MUST import `@brainstorm-os/sdk/property-ui/
 * pure` instead — the pure barrel never statically reaches this file.
 *
 * Individual cells + `CellPopover` are intentionally NOT exported:
 * consumers render through `getCell(valueType, view)`, never by
 * importing a concrete cell.
 */

// Cell registry — `./property-ui/cells` is imported for its
// `register(...)` side effect; only the lookup surface is re-exported.
export {
	type CellComponent,
	type CellRegistryKey,
	cellRegistryKey,
	getCell,
	hasCell,
	registeredCellKeys,
} from "./property-ui/cells";

export {
	type PropertyBackend,
	type PropertyStoreOptions,
	PropertyStore,
} from "./property-ui/property-store";
export {
	type DictionaryBackend,
	type DictionaryStoreOptions,
	DictionaryStore,
} from "./property-ui/dictionary-store";

export {
	type PropertiesContextValue,
	type PropertiesProviderProps,
	type PropertiesRuntime,
	type PropertyUiSeams,
	PropertiesContext,
	PropertiesProvider,
	useDictionary,
	useDictionaryStore,
	useProperty,
	usePropertyStore,
	usePropertyUiSeams,
} from "./property-ui/use-properties";

export {
	type EntityPropertiesPanelProps,
	EntityPropertiesPanel,
} from "./property-ui/entity-properties-panel";

export {
	type AddPropertyPickerProps,
	AddPropertyPicker,
} from "./property-ui/add-property-picker";
export {
	type AddPropertyPickerLabels,
	type InlinePropertyFormLabels,
	DEFAULT_ADD_PROPERTY_PICKER_LABELS,
	DEFAULT_INLINE_PROPERTY_FORM_LABELS,
} from "./i18n/common-labels";
export {
	type FilterResult,
	PropertyTypeCategory,
	categorizeProperty,
	filterProperties,
	isMultiProperty,
} from "./property-ui/property-catalog";

export {
	type CommitMatcher,
	type DictionaryEditorMatchers,
	type EntityTitleSource,
	type EscapeMatcher,
	type KeyLike,
	type PropertyUiLabels,
	DEFAULT_DICTIONARY_EDITOR_MATCHERS,
	DEFAULT_PROPERTY_UI_LABELS,
	EMPTY_ENTITY_TITLE_SOURCE,
	defaultCommitMatcher,
	defaultEscapeMatcher,
} from "./property-ui/seams";

export {
	type AnchoredPanelOptions,
	type AnchoredPanelStyle,
	type PanelAnchor,
	computeAnchoredPanelStyle,
	useAnchoredPanel,
} from "./property-ui/use-anchored-panel";

export {
	type DictionaryEditorProps,
	DictionaryEditor,
} from "./property-ui/dictionary-editor";
export {
	dictionaryEditorStore,
	useActiveDictionaryEditor,
} from "./property-ui/dictionary-editor-store";
export {
	type DictionaryEditorHostProps,
	type DictionarySortStorage,
	DictionaryEditorHost,
} from "./property-ui/dictionary-editor-host";

// Pure helpers re-exported for convenience so a React consumer needs
// one import. The pure barrel stays the canonical React-free entry.
export {
	type FormatOptions,
	formatDate,
	formatNumber,
	formatScalar,
	isValidFormatted,
	parseDateInput,
	parseNaturalDate,
	parseNumberInput,
	parseScalar,
} from "./property-ui/cells/format";
export {
	type ValuesMap,
	bindValue,
	clearValue,
	migrateValuesField,
	readValue,
	writeValue,
} from "./property-ui/value-store";

export type {
	CellProps,
	Dictionary,
	DictionaryItem,
	PropertyDef,
	PropertyView,
	ValueType,
} from "@brainstorm-os/sdk-types";
