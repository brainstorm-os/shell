/**
 * Settings → Data section.
 *
 * Vault-level properties catalog. Reads the live snapshot from the
 * shell's `PropertiesStore`; writes dispatch through the dedicated
 * `properties:*` IPC handlers. Dictionaries are not exposed as a
 * separate section — they're managed inline inside the property
 * constructor for Select / Multi-select properties (their only purpose
 * here).
 *
 * Surface:
 *   - Search box + virtualized property list
 *   - "+ New property" button opens the constructor popover
 *   - Clicking a row opens the same constructor pre-filled (edit mode)
 *   - The constructor handles every concern (name, kind, format, multi,
 *     vocabulary items) — no inline forms in the list
 */

import {
	defForPreset,
	newDictionaryId,
	newDictionaryItemId,
	newPropertyKey,
} from "@brainstorm-os/sdk";
import {
	type Dictionary,
	type DictionaryItem,
	type PropertyDef,
	PropertyKindPreset,
	isMultiValued,
	presetOf,
} from "@brainstorm-os/sdk-types";
import {
	type CompositeItemProps,
	Orientation,
	SelectionAttribute,
	useCompositeKeyboard,
} from "@brainstorm-os/sdk/a11y";
import type { IconComponent, IconParam } from "@brainstorm-os/sdk/menus";
import { openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { Searchbar } from "@brainstorm-os/sdk/searchbar";
import { MultiSelectMenu } from "@brainstorm-os/sdk/select-menu";
import { friendlyTypeName } from "@brainstorm-os/sdk/system-entities";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/t";
import { matchesChord } from "../shortcuts/use-shortcut";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { ConfirmVariant, confirm } from "../ui/confirm";
import { EntityIcon } from "../ui/entity-icon";
import { Icon, IconName } from "../ui/icon";
import { IconButton, IconButtonSize } from "../ui/icon-button";
import { pickIcon } from "../ui/pick-icon";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";
import { usePropertiesSnapshot } from "./use-properties-snapshot";

/** Curated dictionary-item colour palette. Same hues as the IconPicker's
 *  tint palette so chips read coherently across the app. `value: null` = no
 *  colour (the tag falls back to the surface tone). `nameKey` localises the
 *  swatch's accessible name in the colour menu. */
const VOCAB_COLORS: readonly { value: string | null; nameKey: string }[] = [
	{ value: null, nameKey: "shell.settings.data.properties.colorNone" },
	{ value: "#dc2626", nameKey: "shell.settings.data.properties.color.red" },
	{ value: "#ea580c", nameKey: "shell.settings.data.properties.color.orange" },
	{ value: "#ca8a04", nameKey: "shell.settings.data.properties.color.amber" },
	{ value: "#16a34a", nameKey: "shell.settings.data.properties.color.green" },
	{ value: "#0891b2", nameKey: "shell.settings.data.properties.color.cyan" },
	{ value: "#2563eb", nameKey: "shell.settings.data.properties.color.blue" },
	{ value: "#9333ea", nameKey: "shell.settings.data.properties.color.purple" },
	{ value: "#db2777", nameKey: "shell.settings.data.properties.color.pink" },
];

/** A menu-row leading glyph that paints a colour swatch. `null` renders the
 *  "no colour" chip (a slashed outline) so it reads as a distinct choice. */
function swatchIcon(colour: string | null): IconParam {
	const Swatch: IconComponent = () => (
		<span
			className={
				colour === null
					? "data__vocab-color-swatch data__vocab-color-swatch--none"
					: "data__vocab-color-swatch"
			}
			style={colour === null ? undefined : { background: colour }}
		/>
	);
	return { icon: Swatch };
}

// ─── Preset chrome (label / icon / tint) ───────────────────────────────────

const PRESET_LABEL_KEY: Record<PropertyKindPreset, string> = {
	[PropertyKindPreset.Text]: "shell.settings.data.properties.kindBadge.text",
	[PropertyKindPreset.Number]: "shell.settings.data.properties.kindBadge.number",
	[PropertyKindPreset.Date]: "shell.settings.data.properties.kindBadge.date",
	[PropertyKindPreset.Boolean]: "shell.settings.data.properties.kindBadge.boolean",
	[PropertyKindPreset.Select]: "shell.settings.data.properties.kindBadge.select",
	[PropertyKindPreset.MultiSelect]: "shell.settings.data.properties.kindBadge.multi-select",
	[PropertyKindPreset.File]: "shell.settings.data.properties.kindBadge.file",
	[PropertyKindPreset.Link]: "shell.settings.data.properties.kindBadge.link",
	[PropertyKindPreset.Url]: "shell.settings.data.properties.kindBadge.url",
	[PropertyKindPreset.Email]: "shell.settings.data.properties.kindBadge.email",
	[PropertyKindPreset.Phone]: "shell.settings.data.properties.kindBadge.phone",
	[PropertyKindPreset.Formula]: "shell.settings.data.properties.kindBadge.formula",
};

const PRESET_ICON: Record<PropertyKindPreset, IconName> = {
	[PropertyKindPreset.Text]: IconName.KindText,
	[PropertyKindPreset.Number]: IconName.KindNumber,
	[PropertyKindPreset.Date]: IconName.KindDate,
	[PropertyKindPreset.Boolean]: IconName.KindBoolean,
	[PropertyKindPreset.Select]: IconName.KindSelect,
	[PropertyKindPreset.MultiSelect]: IconName.KindMultiSelect,
	[PropertyKindPreset.File]: IconName.KindFile,
	[PropertyKindPreset.Link]: IconName.KindLink,
	[PropertyKindPreset.Url]: IconName.KindUrl,
	[PropertyKindPreset.Email]: IconName.KindEmail,
	[PropertyKindPreset.Phone]: IconName.KindPhone,
	// TODO: a dedicated KindFormula glyph (phosphor `function`); reuse KindNumber for now.
	[PropertyKindPreset.Formula]: IconName.KindNumber,
};

const PRESET_TINT: Record<PropertyKindPreset, string> = {
	[PropertyKindPreset.Text]: "#6b73f0",
	[PropertyKindPreset.Number]: "#0891b2",
	[PropertyKindPreset.Date]: "#ea580c",
	[PropertyKindPreset.Boolean]: "#16a34a",
	[PropertyKindPreset.Select]: "#9333ea",
	[PropertyKindPreset.MultiSelect]: "#db2777",
	[PropertyKindPreset.File]: "#0284c7",
	[PropertyKindPreset.Link]: "#2563eb",
	[PropertyKindPreset.Url]: "#0d9488",
	[PropertyKindPreset.Email]: "#ca8a04",
	[PropertyKindPreset.Phone]: "#65a30d",
	[PropertyKindPreset.Formula]: "#7c3aed",
};

// ─── Primary kind (UX-layer): 7 tiles instead of 11 presets ─────────────────

/**
 * Picker collapses the eleven internal presets into seven primary kinds.
 * Text covers URL / Email / Phone via a "Format" sub-option; Select
 * covers single + multi via the "Allow multiple values" toggle. Matches
 * the composable model in.
 */
enum PrimaryKind {
	Text = "text",
	Number = "number",
	Boolean = "boolean",
	Date = "date",
	Select = "select",
	File = "file",
	Link = "link",
}

/** Stable empty disabled-set so the kind radiogroup's hook deps don't churn
 *  while creating a property (every kind enabled). */
const EMPTY_DISABLED: ReadonlySet<number> = new Set();

const PRIMARY_ORDER: readonly PrimaryKind[] = [
	PrimaryKind.Text,
	PrimaryKind.Number,
	PrimaryKind.Boolean,
	PrimaryKind.Date,
	PrimaryKind.Select,
	PrimaryKind.File,
	PrimaryKind.Link,
];

const PRIMARY_BASE_PRESET: Record<PrimaryKind, PropertyKindPreset> = {
	[PrimaryKind.Text]: PropertyKindPreset.Text,
	[PrimaryKind.Number]: PropertyKindPreset.Number,
	[PrimaryKind.Boolean]: PropertyKindPreset.Boolean,
	[PrimaryKind.Date]: PropertyKindPreset.Date,
	[PrimaryKind.Select]: PropertyKindPreset.Select,
	[PrimaryKind.File]: PropertyKindPreset.File,
	[PrimaryKind.Link]: PropertyKindPreset.Link,
};

enum TextFormat {
	Plain = "plain",
	Url = "url",
	Email = "email",
	Phone = "phone",
}

const TEXT_FORMAT_ORDER: readonly TextFormat[] = [
	TextFormat.Plain,
	TextFormat.Url,
	TextFormat.Email,
	TextFormat.Phone,
];

const TEXT_FORMAT_LABEL_KEY: Record<TextFormat, string> = {
	[TextFormat.Plain]: "shell.settings.data.properties.format.plain",
	[TextFormat.Url]: "shell.settings.data.properties.format.url",
	[TextFormat.Email]: "shell.settings.data.properties.format.email",
	[TextFormat.Phone]: "shell.settings.data.properties.format.phone",
};

function resolvePreset(
	primary: PrimaryKind,
	textFormat: TextFormat,
	multi: boolean,
): PropertyKindPreset {
	if (primary === PrimaryKind.Text) {
		switch (textFormat) {
			case TextFormat.Url:
				return PropertyKindPreset.Url;
			case TextFormat.Email:
				return PropertyKindPreset.Email;
			case TextFormat.Phone:
				return PropertyKindPreset.Phone;
			default:
				return PropertyKindPreset.Text;
		}
	}
	if (primary === PrimaryKind.Select && multi) {
		return PropertyKindPreset.MultiSelect;
	}
	return PRIMARY_BASE_PRESET[primary];
}

/** Derive a (primary, textFormat, multi) tuple from an existing def — used
 *  when opening the constructor in edit mode. */
function decomposePreset(def: PropertyDef): {
	primary: PrimaryKind;
	textFormat: TextFormat;
	multi: boolean;
} {
	const preset = presetOf(def);
	switch (preset) {
		case PropertyKindPreset.Number:
			return { primary: PrimaryKind.Number, textFormat: TextFormat.Plain, multi: false };
		case PropertyKindPreset.Boolean:
			return { primary: PrimaryKind.Boolean, textFormat: TextFormat.Plain, multi: false };
		case PropertyKindPreset.Date:
			return { primary: PrimaryKind.Date, textFormat: TextFormat.Plain, multi: false };
		case PropertyKindPreset.File:
			return { primary: PrimaryKind.File, textFormat: TextFormat.Plain, multi: false };
		case PropertyKindPreset.Link:
			return { primary: PrimaryKind.Link, textFormat: TextFormat.Plain, multi: false };
		case PropertyKindPreset.Select:
			return { primary: PrimaryKind.Select, textFormat: TextFormat.Plain, multi: false };
		case PropertyKindPreset.MultiSelect:
			return { primary: PrimaryKind.Select, textFormat: TextFormat.Plain, multi: true };
		case PropertyKindPreset.Url:
			return { primary: PrimaryKind.Text, textFormat: TextFormat.Url, multi: false };
		case PropertyKindPreset.Email:
			return { primary: PrimaryKind.Text, textFormat: TextFormat.Email, multi: false };
		case PropertyKindPreset.Phone:
			return { primary: PrimaryKind.Text, textFormat: TextFormat.Phone, multi: false };
		default:
			return {
				primary: PrimaryKind.Text,
				textFormat: TextFormat.Plain,
				multi: isMultiValued(def.count),
			};
	}
}

// ─── Section root ──────────────────────────────────────────────────────────

enum ConstructorMode {
	Create = "create",
	Edit = "edit",
}

type ConstructorState =
	| { mode: ConstructorMode.Create }
	| { mode: ConstructorMode.Edit; def: PropertyDef; dictionary: Dictionary | null };

export function DataSection() {
	const snapshot = usePropertiesSnapshot();
	const [constructorState, setConstructorState] = useState<ConstructorState | null>(null);
	const [query, setQuery] = useState("");

	const properties = useMemo(
		() =>
			snapshot
				? [...Object.values(snapshot.properties)].sort((a, b) =>
						a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
					)
				: [],
		[snapshot],
	);

	const dictionariesById = useMemo(() => {
		const m = new Map<string, Dictionary>();
		if (snapshot) {
			for (const d of Object.values(snapshot.dictionaries)) m.set(d.id, d);
		}
		return m;
	}, [snapshot]);

	const propertyUsage = snapshot?.usage.propertyUsage ?? EMPTY_USAGE_MAP;
	const dictionaryUsage = snapshot?.usage.dictionaryUsage ?? EMPTY_USAGE_MAP;

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (needle.length === 0) return properties;
		return properties.filter((p) => p.name.toLowerCase().includes(needle));
	}, [query, properties]);

	const onAdd = useCallback(() => setConstructorState({ mode: ConstructorMode.Create }), []);
	const onEdit = useCallback(
		(def: PropertyDef) => {
			const dictionary = def.vocabulary
				? (dictionariesById.get(def.vocabulary.dictionaryId) ?? null)
				: null;
			setConstructorState({ mode: ConstructorMode.Edit, def, dictionary });
		},
		[dictionariesById],
	);
	const onClose = useCallback(() => setConstructorState(null), []);

	return (
		<section className="settings__section settings__section--data">
			<p className="settings__section-summary">{t("shell.settings.data.summary")}</p>

			<PropertiesPanel
				properties={filtered}
				totalCount={properties.length}
				query={query}
				onQueryChange={setQuery}
				onAdd={onAdd}
				onEdit={onEdit}
				propertyUsage={propertyUsage}
			/>

			{constructorState && (
				<PropertyConstructor
					state={constructorState}
					onClose={onClose}
					dictionaryUsage={dictionaryUsage}
				/>
			)}
		</section>
	);
}

/** Module-stable empty map so `useMemo` deps don't churn while the
 *  usage snapshot is loading (the broadcast arrives one tick after
 *  mount). Frozen so any accidental mutation throws in dev. */
const EMPTY_USAGE_MAP: Readonly<Record<string, number>> = Object.freeze({});

// ─── Properties list (search + virtualized rows) ──────────────────────────

function PropertiesPanel({
	properties,
	totalCount,
	query,
	onQueryChange,
	onAdd,
	onEdit,
	propertyUsage,
}: {
	properties: readonly PropertyDef[];
	totalCount: number;
	query: string;
	onQueryChange: (v: string) => void;
	onAdd: () => void;
	onEdit: (def: PropertyDef) => void;
	propertyUsage: Readonly<Record<string, number>>;
}) {
	const isEmpty = totalCount === 0;

	if (isEmpty) {
		return (
			<div className="data__empty">
				<div className="data__empty-glyph" aria-hidden="true">
					<Icon name={IconName.KindText} size={32} weight="duotone" />
				</div>
				<h4 className="data__empty-title">{t("shell.settings.data.properties.empty")}</h4>
				<p className="data__empty-hint">{t("shell.settings.data.properties.emptyHint")}</p>
				<div className="data__empty-action">
					<Button iconLeft={IconName.Plus} variant={ButtonVariant.Primary} onClick={onAdd}>
						{t("shell.settings.data.properties.add")}
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="data__panel">
			<div className="data__toolbar">
				<Searchbar
					className="data__search"
					value={query}
					onChange={onQueryChange}
					placeholder={t("shell.settings.data.properties.searchPlaceholder")}
					clearLabel={t("shell.settings.data.properties.searchClear")}
				/>
				<Button
					iconLeft={IconName.Plus}
					variant={ButtonVariant.Glass}
					size={ButtonSize.Md}
					onClick={onAdd}
				>
					{t("shell.settings.data.properties.add")}
				</Button>
			</div>

			{properties.length === 0 ? (
				<p className="data__no-results">{t("shell.settings.data.properties.noResults", { query })}</p>
			) : (
				<VirtualizedPropertyList
					properties={properties}
					onEdit={onEdit}
					propertyUsage={propertyUsage}
				/>
			)}
		</div>
	);
}

const ROW_HEIGHT = 52;
const ROW_BUFFER = 4;
// First-paint estimate only; the ResizeObserver replaces it with the
// scroller's real flex-filled height before the user can scroll.
const INITIAL_VIEWPORT_HEIGHT = 560;

function VirtualizedPropertyList({
	properties,
	onEdit,
	propertyUsage,
}: {
	properties: readonly PropertyDef[];
	onEdit: (def: PropertyDef) => void;
	propertyUsage: Readonly<Record<string, number>>;
}) {
	const scrollerRef = useRef<HTMLDivElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [viewportHeight, setViewportHeight] = useState(INITIAL_VIEWPORT_HEIGHT);
	const rafRef = useRef<number | null>(null);

	useEffect(() => {
		const el = scrollerRef.current;
		if (!el) return;
		const measure = () => setViewportHeight(el.clientHeight);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const onScroll = useCallback(() => {
		const el = scrollerRef.current;
		if (!el) return;
		if (rafRef.current !== null) return;
		rafRef.current = requestAnimationFrame(() => {
			rafRef.current = null;
			setScrollTop(el.scrollTop);
		});
	}, []);

	useEffect(
		() => () => {
			if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
		},
		[],
	);

	const totalHeight = properties.length * ROW_HEIGHT;
	const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - ROW_BUFFER);
	const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + ROW_BUFFER * 2;
	const endIdx = Math.min(properties.length, startIdx + visibleCount);
	const offsetY = startIdx * ROW_HEIGHT;

	return (
		<div
			ref={scrollerRef}
			className="data__list-scroller"
			onScroll={onScroll}
			aria-label={t("shell.settings.data.properties.heading")}
		>
			<div className="data__list-sizer" style={{ height: totalHeight }}>
				<ul className="data__list-window" style={{ transform: `translateY(${offsetY}px)` }}>
					{properties.slice(startIdx, endIdx).map((def) => (
						<PropertyRow
							key={def.key}
							def={def}
							onEdit={onEdit}
							usageCount={propertyUsage[def.key] ?? 0}
						/>
					))}
				</ul>
			</div>
		</div>
	);
}

function PropertyRow({
	def,
	onEdit,
	usageCount,
}: {
	def: PropertyDef;
	onEdit: (def: PropertyDef) => void;
	usageCount: number;
}) {
	const preset = presetOf(def);
	const tint = PRESET_TINT[preset];

	const onDelete = useCallback(
		async (e: React.MouseEvent) => {
			e.stopPropagation();
			const usageNote =
				usageCount > 0
					? ` ${t("shell.settings.data.properties.deleteConfirm.usageNote", { count: usageCount })}`
					: "";
			const ok = await confirm({
				title: t("shell.settings.data.properties.deleteConfirm.title"),
				body: t("shell.settings.data.properties.deleteConfirm.body", { name: def.name }) + usageNote,
				confirmLabel: t("shell.settings.data.properties.delete"),
				confirmVariant: ConfirmVariant.Destructive,
			});
			if (!ok) return;
			await window.brainstorm.properties.removeProperty(def.key);
		},
		[def.key, def.name, usageCount],
	);

	return (
		<li className="data__row" data-kind={preset} style={{ height: ROW_HEIGHT }}>
			<button
				type="button"
				className="data__row-trigger"
				onClick={() => onEdit(def)}
				aria-label={t("shell.settings.data.properties.editAria", { name: def.name })}
			>
				<KindGlyph preset={preset} tint={tint} size="sm" title={t(PRESET_LABEL_KEY[preset])} />
				<span className="data__row-name">{def.name}</span>
				<UsagePill count={usageCount} kind="property" />
			</button>
			<span className="data__row-actions">
				<IconButton
					icon={IconName.Trash}
					label={t("shell.settings.data.properties.delete")}
					size={IconButtonSize.Sm}
					onClick={onDelete}
				/>
			</span>
		</li>
	);
}

/** Compact "used by N" affordance — empty span when count is zero so the
 *  row chrome stays still. Same chrome for property + dictionary-item
 *  usage so the visual language is consistent across the data section. */
function UsagePill({ count, kind }: { count: number; kind: "property" | "dictionary-item" }) {
	if (count <= 0) return null;
	const labelKey =
		kind === "property"
			? "shell.settings.data.properties.usagePill"
			: "shell.settings.data.properties.itemUsagePill";
	return (
		<span
			className="data__usage-pill"
			title={t(labelKey, { count })}
			aria-label={t(labelKey, { count })}
		>
			{count}
		</span>
	);
}

function KindGlyph({
	preset,
	tint,
	size = "md",
	title,
}: {
	preset: PropertyKindPreset;
	tint: string;
	size?: "sm" | "md";
	/** When set, the glyph carries the kind name as its accessible label +
	 *  hover tooltip — used where the worded kind label is dropped because the
	 *  coloured icon already conveys it (the property list rows). */
	title?: string;
}) {
	const px = size === "sm" ? 28 : 40;
	const iconPx = size === "sm" ? 15 : 20;
	return (
		<span
			className="data__kind-glyph"
			style={{
				width: px,
				height: px,
				background: `color-mix(in srgb, ${tint} 16%, transparent)`,
				color: tint,
			}}
			{...(title ? { role: "img", "aria-label": title, title } : { "aria-hidden": true })}
		>
			<Icon name={PRESET_ICON[preset]} size={iconPx} weight="bold" />
		</span>
	);
}

// ─── Property constructor (popover) ──────────────────────────────────────

function PropertyConstructor({
	state,
	onClose,
	dictionaryUsage,
}: {
	state: ConstructorState;
	onClose: () => void;
	dictionaryUsage: Readonly<Record<string, number>>;
}) {
	const isEdit = state.mode === ConstructorMode.Edit;

	const initial = useMemo(() => {
		if (state.mode === ConstructorMode.Edit) {
			const { primary, textFormat, multi } = decomposePreset(state.def);
			return {
				key: state.def.key,
				name: state.def.name,
				primary,
				textFormat,
				multi,
				dictId: state.dictionary?.id ?? null,
				dictName: state.dictionary?.name ?? state.def.name,
				items: state.dictionary?.items.map((it) => ({ ...it })) ?? ([] as DictionaryItem[]),
				allowedTypes: state.def.allowedTypes ?? ([] as readonly string[]),
			};
		}
		return {
			key: newPropertyKey(),
			name: "",
			primary: PrimaryKind.Text,
			textFormat: TextFormat.Plain,
			multi: false,
			dictId: null as string | null,
			dictName: "",
			items: [] as DictionaryItem[],
			allowedTypes: [] as readonly string[],
		};
	}, [state]);

	const [name, setName] = useState(initial.name);
	const [primary, setPrimary] = useState<PrimaryKind>(initial.primary);
	const [textFormat, setTextFormat] = useState<TextFormat>(initial.textFormat);
	const [multi, setMulti] = useState(initial.multi);
	const [items, setItems] = useState<DictionaryItem[]>(initial.items);
	// A Relation (`Link`) scopes its picker to these entity types — empty links
	// to anything. Preserved on edit, set through the relation-type picker.
	const [allowedTypes, setAllowedTypes] = useState<readonly string[]>(initial.allowedTypes);

	// The kind grid and the text-format row are radiogroups; the SDK hook owns
	// roving tabindex + arrow nav + the radio role/checked state. The kind grid
	// is laid out with responsive `auto-fill` columns, so it navigates as a 1D
	// radio set (Vertical) rather than a fixed 2D grid. In edit mode the kind is
	// locked — every tile but the current one is disabled, so arrow-nav stays put.
	const kindActiveIndex = Math.max(0, PRIMARY_ORDER.indexOf(primary));
	const kindDisabled = useMemo(
		() =>
			isEdit
				? new Set(PRIMARY_ORDER.map((_, i) => i).filter((i) => i !== kindActiveIndex))
				: EMPTY_DISABLED,
		[isEdit, kindActiveIndex],
	);
	const selectKind = (i: number) => {
		const k = PRIMARY_ORDER[i];
		if (k !== undefined) setPrimary(k);
	};
	const { containerProps: kindGroupProps, getItemProps: getKindProps } = useCompositeKeyboard({
		orientation: Orientation.Vertical,
		count: PRIMARY_ORDER.length,
		activeIndex: kindActiveIndex,
		onActiveIndexChange: selectKind,
		onActivate: selectKind,
		disabled: kindDisabled,
		role: "radiogroup",
		itemRole: "radio",
		selectionAttribute: SelectionAttribute.AriaChecked,
	});

	const formatActiveIndex = Math.max(0, TEXT_FORMAT_ORDER.indexOf(textFormat));
	const selectFormat = (i: number) => {
		const f = TEXT_FORMAT_ORDER[i];
		if (f !== undefined) setTextFormat(f);
	};
	const { containerProps: formatGroupProps, getItemProps: getFormatProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		count: TEXT_FORMAT_ORDER.length,
		activeIndex: formatActiveIndex,
		onActiveIndexChange: selectFormat,
		onActivate: selectFormat,
		role: "radiogroup",
		itemRole: "radio",
		selectionAttribute: SelectionAttribute.AriaChecked,
	});

	const resolvedPreset = resolvePreset(primary, textFormat, multi);
	const canSubmit = name.trim().length > 0;

	const onSave = useCallback(async () => {
		if (!canSubmit) return;
		const trimmedName = name.trim();
		const preset = resolvePreset(primary, textFormat, multi);
		const requiresVocabulary =
			preset === PropertyKindPreset.Select || preset === PropertyKindPreset.MultiSelect;

		let vocabularyRef: { dictionaryId: string } | undefined;
		if (requiresVocabulary) {
			const dictId = initial.dictId ?? newDictionaryId();
			const renumbered = items.map((it, i) => ({ ...it, sortIndex: i }));
			const dict: Dictionary = { id: dictId, name: trimmedName, items: renumbered };
			await window.brainstorm.properties.setDictionary(dict);
			vocabularyRef = { dictionaryId: dictId };
		}

		// A typed Relation pins `allowedTypes`; an untyped one leaves the field
		// off so the link picker keeps its default (link-to-anything) scope.
		const scopedTypes =
			primary === PrimaryKind.Link
				? allowedTypes.filter((id) => id.trim().length > 0)
				: ([] as readonly string[]);

		const def = defForPreset(preset, {
			key: initial.key,
			name: trimmedName,
			...(vocabularyRef ? { vocabulary: vocabularyRef } : {}),
			...(scopedTypes.length > 0 ? { allowedTypes: scopedTypes } : {}),
		});
		await window.brainstorm.properties.setProperty(def);
		onClose();
	}, [
		canSubmit,
		name,
		primary,
		textFormat,
		multi,
		items,
		allowedTypes,
		initial.dictId,
		initial.key,
		onClose,
	]);

	const onDelete = useCallback(async () => {
		if (state.mode !== ConstructorMode.Edit) return;
		const ok = await confirm({
			title: t("shell.settings.data.properties.deleteConfirm.title"),
			body: t("shell.settings.data.properties.deleteConfirm.body", { name: state.def.name }),
			confirmLabel: t("shell.settings.data.properties.delete"),
			confirmVariant: ConfirmVariant.Destructive,
		});
		if (!ok) return;
		await window.brainstorm.properties.removeProperty(state.def.key);
		onClose();
	}, [state, onClose]);

	const titleKey = isEdit
		? "shell.settings.data.properties.editTitle"
		: "shell.settings.data.properties.createTitle";

	return (
		<Popover
			title={t(titleKey)}
			onClose={onClose}
			size={PopoverSize.Large}
			bodyPadding={PopoverBodyPadding.Comfortable}
			footer={
				<div className="data__form-actions">
					{isEdit && (
						<Button
							variant={ButtonVariant.Ghost}
							danger
							size={ButtonSize.Md}
							iconLeft={IconName.Trash}
							onClick={onDelete}
						>
							{t("shell.settings.data.properties.delete")}
						</Button>
					)}
					<span className="data__form-actions-spacer" />
					<Button variant={ButtonVariant.Neutral} size={ButtonSize.Md} onClick={onClose}>
						{t("shell.settings.data.properties.cancel")}
					</Button>
					<Button
						variant={ButtonVariant.Primary}
						size={ButtonSize.Md}
						disabled={!canSubmit}
						onClick={() => {
							void onSave();
						}}
					>
						{isEdit
							? t("shell.settings.data.properties.save")
							: t("shell.settings.data.properties.create")}
					</Button>
				</div>
			}
		>
			<form
				className="data__form"
				onSubmit={(e) => {
					e.preventDefault();
					void onSave();
				}}
			>
				<header className="data__form-header">
					<KindGlyph preset={resolvedPreset} tint={PRESET_TINT[resolvedPreset]} />
					<input
						className="data__form-name"
						type="text"
						value={name}
						placeholder={t("shell.settings.data.properties.namePlaceholder")}
						// biome-ignore lint/a11y/noAutofocus: focused on user-initiated trigger
						autoFocus
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (matchesChord(e.nativeEvent, "Enter")) {
								e.preventDefault();
								void onSave();
							}
						}}
						aria-label={t("shell.settings.data.properties.namePlaceholder")}
					/>
				</header>

				<fieldset className="data__form-field">
					<legend className="data__form-label">{t("shell.settings.data.properties.kindLabel")}</legend>
					<div
						className="data__kind-grid"
						{...kindGroupProps}
						aria-label={t("shell.settings.data.properties.kindLabel")}
					>
						{PRIMARY_ORDER.map((k, i) => (
							<KindTile
								key={k}
								preset={PRIMARY_BASE_PRESET[k]}
								selected={primary === k}
								disabled={isEdit && primary !== k}
								itemProps={getKindProps(i)}
								onSelect={() => setPrimary(k)}
							/>
						))}
					</div>
					{isEdit && <p className="data__form-note">{t("shell.settings.data.properties.kindLocked")}</p>}
				</fieldset>

				{primary === PrimaryKind.Text && (
					<div className="data__form-subrow">
						<span className="data__form-sublabel">{t("shell.settings.data.properties.formatLabel")}</span>
						<div
							className="data__segmented"
							{...formatGroupProps}
							aria-label={t("shell.settings.data.properties.formatLabel")}
						>
							{TEXT_FORMAT_ORDER.map((f, i) => (
								<button
									key={f}
									type="button"
									{...getFormatProps(i)}
									className={
										textFormat === f
											? "data__segmented-tile data__segmented-tile--selected"
											: "data__segmented-tile"
									}
									onClick={() => setTextFormat(f)}
								>
									{t(TEXT_FORMAT_LABEL_KEY[f])}
								</button>
							))}
						</div>
					</div>
				)}

				{primary === PrimaryKind.Select && (
					<div className="data__form-subrow">
						<div
							className={isEdit ? "data__form-toggle data__form-toggle--disabled" : "data__form-toggle"}
						>
							<Checkbox
								checked={multi}
								disabled={isEdit}
								onChange={setMulti}
								label={t("shell.settings.data.properties.allowMultiple")}
							/>
							{isEdit && (
								<span className="data__form-toggle-note">
									{t("shell.settings.data.properties.cardinalityLocked")}
								</span>
							)}
						</div>
						<VocabularyEditor items={items} onChange={setItems} dictionaryUsage={dictionaryUsage} />
					</div>
				)}

				{primary === PrimaryKind.Link && (
					<div className="data__form-subrow">
						<span className="data__form-sublabel">
							{t("shell.settings.data.properties.allowedTypesLabel")}
						</span>
						<RelationTypePicker selected={allowedTypes} onChange={setAllowedTypes} />
					</div>
				)}
			</form>
		</Popover>
	);
}

function KindTile({
	preset,
	selected,
	disabled = false,
	itemProps,
	onSelect,
}: {
	preset: PropertyKindPreset;
	selected: boolean;
	disabled?: boolean;
	itemProps: CompositeItemProps;
	onSelect: () => void;
}) {
	const tint = PRESET_TINT[preset];
	const classes = [
		"data__kind-tile",
		selected ? "data__kind-tile--selected" : "",
		disabled ? "data__kind-tile--disabled" : "",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<button
			type="button"
			{...itemProps}
			disabled={disabled}
			className={classes}
			onClick={onSelect}
			style={
				selected
					? {
							borderColor: tint,
							boxShadow: `0 0 0 1px ${tint}, 0 4px 10px color-mix(in srgb, ${tint} 16%, transparent)`,
						}
					: undefined
			}
		>
			<span
				className="data__kind-tile-glyph"
				style={{
					background: `color-mix(in srgb, ${tint} ${selected ? 22 : 12}%, transparent)`,
					color: tint,
				}}
				aria-hidden="true"
			>
				<Icon name={PRESET_ICON[preset]} size={18} weight="bold" />
			</span>
			<span className="data__kind-tile-label">{t(PRESET_LABEL_KEY[preset])}</span>
		</button>
	);
}

// ─── Relation type picker (inside constructor for Link) ──────────────────

/** Multi-select of the vault's registered entity types → a Relation's
 *  `allowedTypes`. Empty selection links to anything (the default scope).
 *  An already-selected type that's no longer registered (its app was
 *  uninstalled) stays offered, so editing never silently drops a scope. */
function RelationTypePicker({
	selected,
	onChange,
}: {
	selected: readonly string[];
	onChange: (next: readonly string[]) => void;
}) {
	const [types, setTypes] = useState<readonly string[]>([]);

	useEffect(() => {
		let cancelled = false;
		void window.brainstorm.properties.entityTypes().then((list) => {
			if (!cancelled) setTypes(list);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const options = useMemo(() => {
		const all = new Set<string>([...types, ...selected]);
		return [...all]
			.sort((a, b) =>
				friendlyTypeName(a).localeCompare(friendlyTypeName(b), undefined, { sensitivity: "base" }),
			)
			.map((id) => ({ id, label: friendlyTypeName(id) }));
	}, [types, selected]);

	if (options.length === 0) {
		return <p className="data__form-note">{t("shell.settings.data.properties.allowedTypesEmpty")}</p>;
	}

	return (
		<>
			<MultiSelectMenu
				className="data__type-select"
				selected={selected}
				options={options}
				onChange={onChange}
				ariaLabel={t("shell.settings.data.properties.allowedTypesLabel")}
				placeholder={t("shell.settings.data.properties.allowedTypesAny")}
			/>
			<p className="data__form-note">{t("shell.settings.data.properties.allowedTypesHint")}</p>
		</>
	);
}

// ─── Vocabulary editor (inside constructor for Select/MultiSelect) ────────

function VocabularyEditor({
	items,
	onChange,
	dictionaryUsage,
}: {
	items: readonly DictionaryItem[];
	onChange: (next: DictionaryItem[]) => void;
	dictionaryUsage: Readonly<Record<string, number>>;
}) {
	const [draft, setDraft] = useState("");

	const addItem = useCallback(() => {
		const label = draft.trim();
		if (label.length === 0) return;
		const next: DictionaryItem = {
			id: newDictionaryItemId(),
			label,
			icon: null,
			sortIndex: items.length,
		};
		onChange([...items, next]);
		setDraft("");
	}, [draft, items, onChange]);

	const renameItem = useCallback(
		(id: string, label: string) => {
			onChange(items.map((it) => (it.id === id ? { ...it, label } : it)));
		},
		[items, onChange],
	);

	const removeItem = useCallback(
		(id: string) => {
			onChange(items.filter((it) => it.id !== id));
		},
		[items, onChange],
	);

	const moveItem = useCallback(
		(id: string, delta: -1 | 1) => {
			const idx = items.findIndex((it) => it.id === id);
			if (idx < 0) return;
			const next = idx + delta;
			if (next < 0 || next >= items.length) return;
			const arr = [...items];
			const [moved] = arr.splice(idx, 1);
			if (!moved) return;
			arr.splice(next, 0, moved);
			onChange(arr);
		},
		[items, onChange],
	);

	const setIconOn = useCallback(
		async (id: string) => {
			const current = items.find((it) => it.id === id);
			if (!current) return;
			const picked = await pickIcon(current.icon);
			if (picked === undefined) return;
			onChange(items.map((it) => (it.id === id ? { ...it, icon: picked } : it)));
		},
		[items, onChange],
	);

	const setColorOn = useCallback(
		(id: string, colour: string | null) => {
			onChange(
				items.map((it) => {
					if (it.id !== id) return it;
					const { colour: _omit, ...rest } = it;
					return colour === null ? rest : { ...rest, colour };
				}),
			);
		},
		[items, onChange],
	);

	const openColorMenu = useCallback(
		(it: DictionaryItem, anchor: HTMLElement) => {
			openAnchoredMenu(
				anchor.getBoundingClientRect(),
				VOCAB_COLORS.map((c) => ({
					label: t(c.nameKey),
					icon: swatchIcon(c.value),
					onSelect: () => setColorOn(it.id, c.value),
				})),
				{
					menuLabel: t("shell.settings.data.properties.itemColorAria", { name: it.label }),
					anchor,
				},
			);
		},
		[setColorOn],
	);

	return (
		<div className="data__vocab">
			<span className="data__form-sublabel">{t("shell.settings.data.properties.vocabulary")}</span>
			{items.length > 0 && (
				<ul className="data__vocab-list">
					{items.map((it, idx) => (
						<li key={it.id} className="data__vocab-item">
							<button
								type="button"
								className="data__vocab-icon-btn"
								onClick={() => {
									void setIconOn(it.id);
								}}
								aria-label={t("shell.settings.data.properties.itemIconAria", {
									name: it.label,
								})}
								title={t("shell.settings.data.properties.itemIconAria", { name: it.label })}
							>
								<EntityIcon icon={it.icon} size={16} />
							</button>
							<button
								type="button"
								className="data__vocab-color-btn"
								onClick={(e) => openColorMenu(it, e.currentTarget)}
								aria-haspopup="menu"
								aria-label={t("shell.settings.data.properties.itemColorAria", {
									name: it.label,
								})}
								title={t("shell.settings.data.properties.itemColorAria", { name: it.label })}
							>
								<span
									className="data__vocab-color-dot"
									style={{
										background: it.colour ?? "var(--color-border-subtle)",
									}}
								/>
							</button>
							<input
								className="data__vocab-input"
								value={it.label}
								onChange={(e) => renameItem(it.id, e.target.value)}
								aria-label={it.label}
							/>
							<UsagePill count={dictionaryUsage[it.id] ?? 0} kind="dictionary-item" />
							<div className="data__vocab-actions">
								<IconButton
									icon={IconName.CaretUp}
									size={IconButtonSize.Sm}
									onClick={() => moveItem(it.id, -1)}
									disabled={idx === 0}
									label={t("shell.settings.data.dictionaries.moveItemUp")}
								/>
								<IconButton
									icon={IconName.CaretDown}
									size={IconButtonSize.Sm}
									onClick={() => moveItem(it.id, 1)}
									disabled={idx === items.length - 1}
									label={t("shell.settings.data.dictionaries.moveItemDown")}
								/>
								<IconButton
									icon={IconName.Trash}
									size={IconButtonSize.Sm}
									onClick={() => removeItem(it.id)}
									label={t("shell.settings.data.dictionaries.removeItem")}
								/>
							</div>
						</li>
					))}
				</ul>
			)}
			<div className="data__vocab-add">
				<input
					className="data__vocab-input data__vocab-input--draft"
					value={draft}
					placeholder={t("shell.settings.data.dictionaries.itemPlaceholder")}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (matchesChord(e.nativeEvent, "Enter")) {
							e.preventDefault();
							addItem();
						}
					}}
				/>
				<Button
					variant={ButtonVariant.Ghost}
					size={ButtonSize.Md}
					iconLeft={IconName.Plus}
					onClick={addItem}
					disabled={draft.trim().length === 0}
				>
					{t("shell.settings.data.dictionaries.addItem")}
				</Button>
			</div>
		</div>
	);
}
