/**
 * Vault-level property + dictionary contract — composable model.
 *
 * A property is **a base value type plus modifiers** per the canonical
 * design in. The six base value
 * types are `text` / `number` / `boolean` / `date` / `entityRef` /
 * `richText`. URL / Email / Phone collapse into `text + format`;
 * Select / Multi-select into `text + vocabulary + count`; File / Link
 * into `entityRef + allowedTypes`. The legacy 11-kind enum is no longer
 * the type contract — it survives only as `PropertyKindPreset` (a UX
 * label for the Settings constructor) derived from def shape via
 * `presetOf(def)`.
 *
 * Storage shape (per §Storage shape):
 *   - `count.max === 1` → bare scalar in the entity's property field.
 *   - `count.max  >  1` → `Array<{ value, label? }>` envelope, regardless
 *     of how many values are present at any moment.
 *
 * The runtime helpers (validators, key generators, preset derivation)
 * live in `@brainstorm/sdk` so the type boundary stays clean.
 */

import type { Icon } from "./index";

// ─── Base value types + modifier value enums ──────────────────────────────────

/** The six base value types. Anything else collapses into these via
 *  modifiers. Immutable post-creation — changing valueType would
 *  invalidate every bound value across the vault. */
export enum ValueType {
	Text = "text",
	Number = "number",
	Boolean = "boolean",
	Date = "date",
	EntityRef = "entityRef",
	RichText = "richText",
}

/** Built-in semantic format. Affects validation + display.
 *  `text` accepts `Email / Url / Phone / Markdown / Code`; `number`
 *  accepts `Currency / Percent / Duration`. Other combinations are
 *  rejected by the validator. */
export enum PropertyFormat {
	Email = "email",
	Url = "url",
	Phone = "phone",
	Markdown = "markdown",
	Code = "code",
	Currency = "currency",
	Percent = "percent",
	/** A `number` of **hours** rendered as `3h 30m` (an engagement's Hours,
	 *  a task's time estimate). The stored value stays a bare number; the
	 *  formatter splits it into h/m. */
	Duration = "duration",
	/** A read-only computed `number` whose value is the result of evaluating
	 *  `PropertyDef.formula` (an arithmetic expression over the entity's other
	 *  properties — `{qty} * {rate}`) via `@brainstorm/sdk/formula`. The cell is
	 *  never editable; nothing is stored on the entity for this property. */
	Formula = "formula",
}

/** Date granularity — whether time-of-day is part of the value. */
export enum DateGranularity {
	Date = "date",
	DateTime = "datetime",
	Time = "time",
}

// ─── Modifier sub-shapes ─────────────────────────────────────────────────────

/** Cardinality range. `min >= 0`, `max >= 1`, hard upper bound `max <= 50`. */
export type Cardinality = {
	min: number;
	max: number;
};

/** Hard upper bound on `Cardinality.max`. Properties with conceptually
 *  larger cardinality should be modeled as a relation traversed via
 *  inverse property, not as a multi-value property. */
export const CARDINALITY_HARD_MAX = 50;

/** Default `{ min: 0, max: 1 }` — optional single value, the common case. */
export const DEFAULT_CARDINALITY: Cardinality = Object.freeze({ min: 0, max: 1 });

/** A property is "multi" when it can hold more than one value at a time. */
export function isMultiValued(count?: Cardinality): boolean {
	return (count ?? DEFAULT_CARDINALITY).max > 1;
}

/** A property is "required" when it must hold at least one value. */
export function isRequired(count?: Cardinality): boolean {
	return (count ?? DEFAULT_CARDINALITY).min >= 1;
}

/** Reference to a Dictionary entity (vocabulary). On v1 this is the
 *  dictionary id from `Dictionary.id`; post-Stage-9 (entities service)
 *  it'll be an entity ref. The shape stays the same. */
export type VocabularyRef = {
	dictionaryId: string;
};

/** Inclusive numeric / date range. Distinct from `Cardinality`, which
 *  bounds *count* of values, not the *value* itself. */
export type Range = {
	min?: number;
	max?: number;
};

/** Optional structured filter narrowing which entities of `allowedTypes`
 *  qualify (e.g. `mimeType` + `maxSizeBytes` for File refs). Opaque
 *  record at the contract layer; entities service interprets. */
export type EntityFilter = Record<string, unknown>;

/** Display options describe **how** a property's value is rendered,
 *  separate from **what** the value is. The picked `view` must be in
 *  `ALLOWED_VIEWS[valueType]` for the value type the def carries (or
 *  pass the additional `vocabulary` / `range` predicate where the
 *  matrix calls them out). */
export type DisplayOptions = {
	view?: PropertyView;
	options?: Record<string, unknown>;
};

// ─── PropertyView ────────────────────────────────────────────────────────────

/** How a property value is rendered. Per-property (via `display.view`),
 *  with `defaultViewFor(def)` as the per-shape default. The allowed
 *  matrix `ALLOWED_VIEWS` gates the constructor + gutter "View as…"
 *  menu. */
export enum PropertyView {
	// Text-family.
	Pill = "pill",
	Plain = "plain",
	Multiline = "multiline",
	Tag = "tag",
	TagList = "tag-list",
	// Number-specific.
	ProgressBar = "progress-bar",
	Rating = "rating",
	/** Read-only computed value (number + format=formula). */
	Formula = "formula",
	// Boolean.
	Checkbox = "checkbox",
	Toggle = "toggle",
	// Date.
	Relative = "relative",
	Calendar = "calendar",
	// Entity-ref.
	Chip = "chip",
	Card = "card",
	LinkInline = "link-inline",
	LinkCard = "link-card",
	// File-aware (entityRef with `allowedTypes` including File).
	FileList = "file-list",
	Gallery = "gallery",
	ImageRow = "image-row",
	Viewer = "viewer",
	Thumbnail = "thumbnail",
	// RichText.
	Block = "block",
	Inline = "inline",
}

// ─── PropertyDef — the composable type ───────────────────────────────────────

/** Property definition. Pick a `valueType`, layer modifiers, get a
 *  property. Identity is `key`; renames + icon / description edits are
 *  free; `valueType` is immutable post-creation. */
export type PropertyDef = {
	/** Stable id, e.g. `prop_<base36-now>_<rand6>`. Never changes. */
	key: string;
	name: string;
	icon: Icon | null;
	description?: string;
	valueType: ValueType;
	/** Cardinality range. Omitted means `DEFAULT_CARDINALITY`. */
	count?: Cardinality;
	/** Vocabulary constraint. Applies to `text` and `number`. */
	vocabulary?: VocabularyRef;
	/** Semantic format. Applies to `text` (email/url/phone/markdown/code)
	 *  and `number` (currency/percent/duration). */
	format?: PropertyFormat;
	/** User-supplied regex for validation. Applies to `text`. */
	pattern?: string;
	/** Value range (distinct from `count`). Applies to `number` / `date`. */
	range?: Range;
	/** Decimal places for numeric display. Applies to `number`. */
	precision?: number;
	/** Whether time-of-day is part of the value. Applies to `date`. */
	granularity?: DateGranularity;
	/** Which entity types are valid targets. Applies to `entityRef`.
	 *  File-typed properties carry `["brainstorm/File/v1"]` here. */
	allowedTypes?: readonly string[];
	/** Optional structured filter narrowing which `allowedTypes` entities
	 *  qualify. */
	entityFilter?: EntityFilter;
	/** Each value must be unique within the scope. Applies to
	 *  `text` / `number` / `entityRef`. */
	unique?: boolean;
	/** Display options — `view` + view-specific options. */
	display?: DisplayOptions;
	/** ISO-4217 currency code (e.g. "USD") for `number + format=currency`.
	 *  Defaulted to "USD" by the formatter when unset. */
	currency?: string;
	/** Arithmetic expression over the entity's other properties (keys in
	 *  `{braces}`, e.g. `{qty} * {rate}`). Applies to `number + format=formula`;
	 *  evaluated read-only per entity via `@brainstorm/sdk/formula`. */
	formula?: string;
	/** Effective domain of this def. Omitted (the default) means an unscoped
	 *  vault-global property — today's behavior. `{ kind: "list", target }`
	 *  makes it a **collection overlay**: every entity that is a member of the
	 *  target List inherits this property (the book → Horror/Fantasy
	 *  inheritance). Resolved per-render against List membership; precedence is
	 *  entity > list > type > user > org (see `Scope`). */
	scope?: Scope;
};

// ─── Stored-value shapes ─────────────────────────────────────────────────────

/** Stored shape of a Date value. `at` is epoch millis (UTC); the
 *  `granularity` is duplicated on the value so the renderer can format
 *  without a def lookup. */
export type DateValue = {
	at: number;
	granularity: DateGranularity;
};

/** One element of a multi-valued storage envelope. `count.max > 1`
 *  properties store an array of these regardless of how many values
 *  are present. `label` is optional and drawn from the def's local
 *  `labels` set (when configured). */
export type LabeledValue<T> = {
	value: T;
	label?: string;
};

/** Scalar value shape per ValueType, when `count.max === 1`. `null` is
 *  the canonical empty for nullable kinds — never `undefined`. */
export type ScalarValueByValueType = {
	[ValueType.Text]: string | null;
	[ValueType.Number]: number | null;
	[ValueType.Boolean]: boolean;
	[ValueType.Date]: DateValue | null;
	[ValueType.EntityRef]: string | null;
	[ValueType.RichText]: unknown;
};

/** Multi-valued storage element shape per ValueType. */
export type MultiValueElementByValueType = {
	[ValueType.Text]: LabeledValue<string>;
	[ValueType.Number]: LabeledValue<number>;
	[ValueType.Boolean]: LabeledValue<boolean>;
	[ValueType.Date]: LabeledValue<DateValue>;
	[ValueType.EntityRef]: LabeledValue<string>;
	[ValueType.RichText]: never;
};

/** Stored value shape per ValueType — the union of scalar + array
 *  forms. Cells narrow on `def.count` to pick the right branch. */
export type PropertyValueByValueType = {
	[V in ValueType]: ScalarValueByValueType[V] | readonly MultiValueElementByValueType[V][];
};

/** Union of every stored value. For storage maps that don't need
 *  per-valueType narrowing. */
export type PropertyValue = PropertyValueByValueType[ValueType];

// ─── Allowed views / defaults matrix ─────────────────────────────────────────

/** Per-valueType allowed view list. The constructor + gutter "View
 *  as…" menu both read this. Frozen so callers can't mutate. Some
 *  view kinds carry secondary requirements (e.g. `Tag` requires
 *  `vocabulary`); the validator checks those on save. */
export const ALLOWED_VIEWS: Readonly<Record<ValueType, readonly PropertyView[]>> = Object.freeze({
	[ValueType.Text]: Object.freeze([
		PropertyView.Pill,
		PropertyView.Plain,
		PropertyView.Multiline,
		PropertyView.Tag,
		PropertyView.TagList,
	]),
	[ValueType.Number]: Object.freeze([
		PropertyView.Pill,
		PropertyView.Plain,
		PropertyView.ProgressBar,
		PropertyView.Rating,
		PropertyView.Formula,
	]),
	[ValueType.Boolean]: Object.freeze([PropertyView.Checkbox, PropertyView.Toggle]),
	[ValueType.Date]: Object.freeze([
		PropertyView.Pill,
		PropertyView.Plain,
		PropertyView.Relative,
		PropertyView.Calendar,
	]),
	[ValueType.EntityRef]: Object.freeze([
		PropertyView.Chip,
		PropertyView.Card,
		PropertyView.LinkInline,
		PropertyView.LinkCard,
		PropertyView.FileList,
		PropertyView.Gallery,
		PropertyView.ImageRow,
		PropertyView.Viewer,
		PropertyView.Thumbnail,
	]),
	[ValueType.RichText]: Object.freeze([PropertyView.Block, PropertyView.Inline]),
});

/** Default view for a def. Honors `display.view` if set; otherwise
 *  derives a sensible default from `valueType` + `count` + the
 *  presence of `vocabulary` / `allowedTypes`. */
export function defaultViewFor(def: PropertyDef): PropertyView {
	if (def.display?.view) return def.display.view;
	switch (def.valueType) {
		case ValueType.Text: {
			if (def.vocabulary) {
				return isMultiValued(def.count) ? PropertyView.TagList : PropertyView.Tag;
			}
			return PropertyView.Pill;
		}
		case ValueType.Number:
			return def.format === PropertyFormat.Formula ? PropertyView.Formula : PropertyView.Pill;
		case ValueType.Boolean:
			return PropertyView.Checkbox;
		case ValueType.Date:
			return PropertyView.Pill;
		case ValueType.EntityRef: {
			if (def.allowedTypes?.includes(FILE_ENTITY_TYPE)) {
				return PropertyView.FileList;
			}
			return PropertyView.LinkCard;
		}
		case ValueType.RichText:
			return PropertyView.Block;
	}
}

/** Whether `view` is in the allowed list for `valueType`. */
export function isAllowedView(valueType: ValueType, view: PropertyView): boolean {
	return ALLOWED_VIEWS[valueType].includes(view);
}

/** Canonical File entity type. Used by `allowedTypes` on entityRef
 *  properties that point at file attachments. */
export const FILE_ENTITY_TYPE = "brainstorm/File/v1";

// ─── Kind preset (UX-only) ───────────────────────────────────────────────────

/** Eleven user-facing "kinds" the Settings constructor + property
 *  picker present. Each preset maps to a `(valueType + modifiers)`
 *  tuple via `defaultsForPreset`. After a def is saved, the original
 *  preset is recovered via `presetOf(def)` for badge / display chrome.
 *
 *  This is **UX-layer labelling only** — never a type discriminator.
 *  Code that needs to switch on shape switches on `def.valueType`
 *  (and modifier presence), not on the preset. */
export enum PropertyKindPreset {
	Text = "text",
	Number = "number",
	Boolean = "boolean",
	Date = "date",
	Select = "select",
	MultiSelect = "multi-select",
	Url = "url",
	Email = "email",
	Phone = "phone",
	File = "file",
	Link = "link",
	Formula = "formula",
}

/** Order the constructor lists presets in. Source of truth for the
 *  segmented control + slash menu picker. */
export const KIND_PRESET_ORDER: readonly PropertyKindPreset[] = Object.freeze([
	PropertyKindPreset.Text,
	PropertyKindPreset.Number,
	PropertyKindPreset.Boolean,
	PropertyKindPreset.Date,
	PropertyKindPreset.Select,
	PropertyKindPreset.MultiSelect,
	PropertyKindPreset.Url,
	PropertyKindPreset.Email,
	PropertyKindPreset.Phone,
	PropertyKindPreset.File,
	PropertyKindPreset.Link,
	PropertyKindPreset.Formula,
]);

/** Default (valueType, modifier) tuple a preset should construct.
 *  Used by `defForPreset(preset, opts)` in `@brainstorm/sdk` to
 *  build a fresh PropertyDef in the Settings constructor. */
export type PresetDefaults = {
	valueType: ValueType;
	count?: Cardinality;
	format?: PropertyFormat;
	allowedTypes?: readonly string[];
	requiresVocabulary?: boolean;
};

export const PRESET_DEFAULTS: Readonly<Record<PropertyKindPreset, PresetDefaults>> = Object.freeze({
	[PropertyKindPreset.Text]: { valueType: ValueType.Text },
	[PropertyKindPreset.Number]: { valueType: ValueType.Number },
	[PropertyKindPreset.Boolean]: { valueType: ValueType.Boolean },
	[PropertyKindPreset.Date]: { valueType: ValueType.Date },
	[PropertyKindPreset.Select]: {
		valueType: ValueType.Text,
		count: { min: 0, max: 1 },
		requiresVocabulary: true,
	},
	[PropertyKindPreset.MultiSelect]: {
		valueType: ValueType.Text,
		count: { min: 0, max: CARDINALITY_HARD_MAX },
		requiresVocabulary: true,
	},
	[PropertyKindPreset.Url]: { valueType: ValueType.Text, format: PropertyFormat.Url },
	[PropertyKindPreset.Email]: { valueType: ValueType.Text, format: PropertyFormat.Email },
	[PropertyKindPreset.Phone]: { valueType: ValueType.Text, format: PropertyFormat.Phone },
	[PropertyKindPreset.File]: {
		valueType: ValueType.EntityRef,
		count: { min: 0, max: CARDINALITY_HARD_MAX },
		allowedTypes: [FILE_ENTITY_TYPE],
	},
	[PropertyKindPreset.Link]: {
		valueType: ValueType.EntityRef,
		count: { min: 0, max: CARDINALITY_HARD_MAX },
	},
	[PropertyKindPreset.Formula]: {
		valueType: ValueType.Number,
		format: PropertyFormat.Formula,
	},
});

/** Derive the preset a def looks like, for chrome (badges,
 *  Settings list rows, etc.). Never load-bearing for behaviour. */
export function presetOf(def: PropertyDef): PropertyKindPreset {
	switch (def.valueType) {
		case ValueType.Boolean:
			return PropertyKindPreset.Boolean;
		case ValueType.Number:
			return def.format === PropertyFormat.Formula
				? PropertyKindPreset.Formula
				: PropertyKindPreset.Number;
		case ValueType.Date:
			return PropertyKindPreset.Date;
		case ValueType.RichText:
			return PropertyKindPreset.Text;
		case ValueType.EntityRef:
			if (def.allowedTypes?.includes(FILE_ENTITY_TYPE)) return PropertyKindPreset.File;
			return PropertyKindPreset.Link;
		case ValueType.Text: {
			if (def.vocabulary) {
				return isMultiValued(def.count) ? PropertyKindPreset.MultiSelect : PropertyKindPreset.Select;
			}
			switch (def.format) {
				case PropertyFormat.Url:
					return PropertyKindPreset.Url;
				case PropertyFormat.Email:
					return PropertyKindPreset.Email;
				case PropertyFormat.Phone:
					return PropertyKindPreset.Phone;
				default:
					return PropertyKindPreset.Text;
			}
		}
	}
}

// ─── Dictionary (vocabulary storage) ─────────────────────────────────────────

/** Vocabulary backing a `text + vocabulary` property — what
 *  page-database tools call a "Select" / "Multi-select". Vault-scoped;
 *  one Dictionary can back many properties. The storage name stays
 *  "Dictionary" for continuity; the spec also refers to it as
 *  "Vocabulary". */
export type DictionaryItem = {
	id: string;
	label: string;
	icon: Icon | null;
	description?: string;
	/** Optional hex accent ("#rrggbb" lowercase). Drives Tag colour. */
	colour?: string;
	/** Manual order index. Larger = later. */
	sortIndex: number;
	/** Soft-delete timestamp (epoch millis). Archived items stay
	 *  readable for existing values but disappear from pickers. */
	archivedAt?: number;
};

export type Dictionary = {
	id: string;
	name: string;
	items: readonly DictionaryItem[];
};

// ─── PropertySchema scope ────────────────────────────────────────────────────

/**
 * The effective domain of a `PropertySchema` overlay (
 * §Layered scopes). `{ kind: "list", target }` **is** the
 * "adding an object to a collection makes it inherit that collection's
 * properties" mechanism : an
 * object's effective schema is its Block-Protocol type's canonical
 * schema ∪ every member collection's `list`-scoped overlay. Precedence
 * (most→least specific, per 19 §Conflict resolution): entity > list >
 * type > user > org. `target` is the entity / type-url / collection /
 * user / org id; no other type dependency, so this contract is shared
 * here rather than coupled to the app-side List shape.
 */
export type Scope =
	| { kind: "entity"; target: string }
	| { kind: "type"; target: string }
	| { kind: "list"; target: string }
	| { kind: "user"; target: string }
	| { kind: "org"; target: string };

// ─── Cell contract ───────────────────────────────────────────────────────────

/** Props every cell receives. Same shape across every cell — both for
 *  inline-block use today and for the future Database app + entity
 *  inspector reuse. Cells switch on `def.valueType` (and `def.count`
 *  for cardinality-aware behavior) at runtime. */
export type CellProps<V extends ValueType = ValueType> = {
	property: PropertyDef & { valueType: V };
	value: PropertyValueByValueType[V];
	onChange: (next: PropertyValueByValueType[V]) => void;
	readOnly?: boolean;
	noteId: string;
	/** Keyboard "begin editing" signal from the host (the Database grid's
	 *  Enter-to-edit, 12.4). When it flips true an editable cell opens its
	 *  inline editor / popover on a rising edge; read-only cells ignore it.
	 *  Independent of pointer click — a cell with no keyboard host never sets
	 *  it, so existing consumers are unchanged. */
	autoEdit?: boolean;
	/** Acked once the cell has consumed an `autoEdit` rising edge, so the host
	 *  can clear the intent (a re-press re-opens the same cell). */
	onAutoEditHandled?: () => void;
	/** The entity's OTHER property values, keyed by property key — supplied by
	 *  hosts that render a whole entity (the Database grid, an object inspector)
	 *  so a read-only computed cell (formula) can resolve its references. Absent
	 *  for hosts that render a single value in isolation; the formula cell then
	 *  shows a "no context" state. Optional → existing cells are unaffected. */
	siblings?: Readonly<Record<string, unknown>>;
};
