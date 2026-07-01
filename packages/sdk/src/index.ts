/**
 * @brainstorm/sdk — runtime that turns `brainstorm.services.*` calls into
 * broker envelopes. Used by app preload scripts (to expose
 * `window.brainstorm`) and by tests / mock-shell-dock.
 *
 * See for the contract and
 * Stage 5 for the current state. Full service surface (entities, files,
 * intents, ui.openWindow) arrives in subsequent stages; this package's
 * placeholder methods throw `Unavailable` with a pointer to the stage that
 * will fill them in.
 */

export { type Bridge, type BridgeEnvelope, type BridgeReply, newMessageId } from "./bridge";
export { encodeHandshake, decodeHandshake } from "./handshake";
export {
	CapabilityDenied,
	Conflict,
	Invalid,
	NotFound,
	Unavailable,
	makeSdkError,
} from "./errors";
export {
	type BuildRuntimeOptions,
	LifecycleEmitter,
	buildRuntime,
	buildRuntimeWithEmitter,
} from "./runtime";
export {
	DICTIONARY_KEY_PREFIX,
	dictionaryStorageKey,
	newDictionaryId,
	newDictionaryItemId,
	newPropertyKey,
	PROPERTY_KEY_PREFIX,
	propertyStorageKey,
} from "./properties-keys";
export {
	coerceValue,
	emptyValueFor,
	isEmptyValue,
	type ValidationResult,
	validateDictionary,
	validateDictionaryItem,
	validatePropertyDef,
	validateValue,
} from "./properties-validate";
export { defForPreset } from "./properties-preset";
export {
	PROPERTY_BLOCK_MIME,
	type PropertyBlockClip,
	PasteRebindKind,
	type PasteRebindDecision,
	decidePasteRebind,
	parsePropertyBlock,
	serializePropertyBlock,
} from "./property-block-clipboard";
export {
	attachResizable,
	type ResizableHandle,
	type ResizableOptions,
	type ResizableSide,
} from "./resizable";
export {
	INLINE_PRIMARY_KIND_ORDER,
	INLINE_TEXT_FORMAT_ORDER,
	InlinePrimaryKind,
	InlineTextFormat,
	type InlinePropertyDraft,
	type InlinePropertyDraftResult,
	type InlinePropertyFormInput,
	type RelationTargetType,
	dedupeSelectOptions,
	draftInlineProperty,
	parseSelectOptions,
	resolveInlinePreset,
	supportsMultiToggle,
	supportsTextFormat,
} from "./inline-property-form-logic";
export {
	InlinePropertyForm,
	type InlinePropertyFormCommit,
	type InlinePropertyFormLabels,
	type InlinePropertyFormProps,
} from "./inline-property-form";
export {
	AddOutcome,
	type AddResult,
	MembersCapacityError,
	type MutationContext,
	RemoveOutcome,
	type RemoveResult,
	addToList,
	effectiveMembers,
	removeFromList,
} from "./collections";
export {
	type ScopedList,
	inheritedPropertyDefs,
	listsContainingEntity,
} from "./list-scoped-properties";
export {
	LIST_ENTITY_TYPE,
	type ListEntityProperties,
	entityToList,
	listToEntityProperties,
} from "./list-entity-codec";
export {
	LIST_VIEW_ENTITY_TYPE,
	type ListViewEntityProperties,
	entityToListView,
	listViewToEntityProperties,
} from "./list-view-entity-codec";
export {
	TEMPLATE_ENTITY_TYPE,
	type TemplateEntityProperties,
	type TemplateDraft,
	type DefaultTemplateLadder,
	type SaveObjectAsTemplateOptions,
	entityToTemplate,
	templateToEntityProperties,
	objectToTemplateProperties,
	instantiateObjectTemplate,
	resolveDefaultTemplate,
	templateAppliesToType,
} from "./template-entity-codec";
export {
	CreateOptionKind,
	type CreateTemplateOption,
	type CreateTemplateMenu,
	buildCreateTemplateMenu,
	draftFromCreateOption,
} from "./template-create-flow";
export { NavigationMode, navModeFromEvent, openEntity, quickLookEntity } from "./open-entity";
export { orderByHitRank, type RankableHit } from "./search-filter";
export type {
	IntentDispatch,
	OpenCapableRuntime,
	OpenEntityTarget,
} from "./open-entity";
// App-fundamental UI primitives (B-2). The CSS-bearing React surfaces
// (`<Popover>` / `createPopoverElement`, the icon-/cover-pickers) stay
// subpath-only — matching the picker precedent — so the root barrel never
// pulls a stylesheet into a non-UI consumer. The icon module (no CSS), the
// host-agnostic shortcut layer, the popover contract enums/labels and the
// app-side `createT` are CSS-free and safe to re-export here.
export {
	ALL_ICON_NAMES,
	ICON_ASSET,
	Icon,
	type IconProps,
	IconName,
	IconWeight,
	createIconElement,
	type CreateIconOptions,
} from "./icon";
export {
	attachShortcut,
	matchesChord,
	normalizeKey,
	type ShortcutDisposer,
	type ShortcutOptions,
	useShortcut,
	type UseShortcutOptions,
	type UseShortcutTarget,
} from "./shortcut";
export {
	DEFAULT_POPOVER_ESCAPE_MATCHER,
	PopoverBodyPadding,
	type PopoverEscapeMatcher,
	PopoverSize,
} from "./popover/popover-shared";
export {
	DEFAULT_POPOVER_LABELS,
	type PopoverLabels,
	resolvePopoverLabels,
} from "./popover/popover-labels";
export {
	createT,
	type TFunction,
	type TParams,
} from "./i18n/common-labels";
export type * from "@brainstorm/sdk-types";
// Runtime value (the canonical type→default-icon resolver) — `export
// type *` above only carries types, so this needs an explicit value
// re-export for non-type consumers (Graph/Database/Files fallbacks).
export { defaultIconForType, GENERIC_TYPE_ICON } from "@brainstorm/sdk-types";
