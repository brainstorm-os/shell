/**
 * `<AddPropertyPicker>` — the ONE add-property flow every properties
 * panel shares. An anchored, header-less command-palette popover that
 * surfaces the vault's property catalog: search the existing defs, pick
 * one, or drop into the inline "create new property" constructor.
 *
 * Extracted from Notes' bespoke `AddPropertyMenuPlugin` (copy two — the
 * rich picker used to live in `apps/notes`, while every other app got a
 * plain bind-only `openSelectMenu` list). Now Notes, `EntityPropertiesPanel`
 * (Journal / Preview / …) and any future host render the same component.
 *
 * Two seams keep it host-agnostic:
 *   - `onPick(propertyKey)` fires for BOTH an existing pick and a freshly
 *     created def (the picker writes the new def + dictionary through the
 *     vault `propertyStore`/`dictionaryStore` first, then calls `onPick`
 *     with its key). The host decides what "pick" means — bind a value,
 *     insert an editor block, append to a list.
 *   - `labels` defaults to the English `@brainstorm/sdk/i18n` set; a
 *     localised host passes a `Partial` of just the keys it translates.
 *
 * Must render inside a `<PropertiesProvider>` (it reads the vault stores)
 * and a host that mounts the fancy-menus surface (`.fm-menu`/`.fm-row`
 * chrome via `mountMenuHost()`).
 */

import type { PropertyDef } from "@brainstorm/sdk-types";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type AddPropertyPickerLabels,
	DEFAULT_ADD_PROPERTY_PICKER_LABELS,
} from "../i18n/common-labels";
import { Icon, IconName } from "../icon";
import { InlinePropertyForm, type InlinePropertyFormCommit } from "../inline-property-form";
import type { RelationTargetType } from "../inline-property-form-logic";
import {
	PropertyTypeCategory,
	categorizeProperty,
	filterProperties,
	isMultiProperty,
} from "./property-catalog";
import type { PanelAnchor } from "./use-anchored-panel";
import { useAnchoredPanel } from "./use-anchored-panel";
import { useDictionaryStore, usePropertyStore } from "./use-properties";

const MENU_WIDTH = 300;
const MENU_GUTTER = 6;
const MENU_MAX_HEIGHT = 360;
const CREATE_MAX_HEIGHT = 540;

const CATEGORY_ICON: Readonly<Record<PropertyTypeCategory, IconName>> = {
	[PropertyTypeCategory.Text]: IconName.KindText,
	[PropertyTypeCategory.Number]: IconName.KindNumber,
	[PropertyTypeCategory.Boolean]: IconName.KindBoolean,
	[PropertyTypeCategory.Date]: IconName.KindDate,
	[PropertyTypeCategory.Select]: IconName.KindSelect,
	[PropertyTypeCategory.Url]: IconName.KindUrl,
	[PropertyTypeCategory.Email]: IconName.KindEmail,
	[PropertyTypeCategory.Phone]: IconName.KindPhone,
	[PropertyTypeCategory.File]: IconName.KindFile,
	[PropertyTypeCategory.Reference]: IconName.KindLink,
	[PropertyTypeCategory.RichText]: IconName.KindText,
};

enum MenuMode {
	Pick = "pick",
	Create = "create",
}

export type AddPropertyPickerProps = {
	/** Viewport-relative rect the popover anchors below (flips above when
	 *  it doesn't fit). A `DOMRect` satisfies `PanelAnchor`. */
	anchor: PanelAnchor;
	/** Fires with the chosen def's key — existing pick OR just-created. */
	onPick: (propertyKey: string) => void;
	/** Dismiss (outside-click, Escape from Pick mode, after a commit). */
	onClose: () => void;
	/** Partial override merged over the English SDK defaults. */
	labels?: Partial<AddPropertyPickerLabels>;
	/** Entity types a created Relation can target. Omit for link-to-anything. */
	relationTargetTypes?: readonly RelationTargetType[];
};

export function AddPropertyPicker({
	anchor,
	onPick,
	onClose,
	labels: labelOverride,
	relationTargetTypes,
}: AddPropertyPickerProps): ReactNode {
	useInjectedStyles();
	const ref = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const activeRef = useRef<HTMLButtonElement | null>(null);
	const [mode, setMode] = useState<MenuMode>(MenuMode.Pick);
	const [query, setQuery] = useState("");
	const [highlightIndex, setHighlightIndex] = useState(0);

	const labels = useMemo<AddPropertyPickerLabels>(() => mergeLabels(labelOverride), [labelOverride]);
	const maxHeight = mode === MenuMode.Create ? CREATE_MAX_HEIGHT : MENU_MAX_HEIGHT;

	const style = useAnchoredPanel({
		anchor,
		width: MENU_WIDTH,
		maxHeight,
		gutter: MENU_GUTTER,
		ref,
		onDismiss: onClose,
		escapeMatcher: null,
	});

	const { store: propertyStore, properties, ready } = usePropertyStore();
	const { store: dictionaryStore } = useDictionaryStore();

	const results = useMemo(() => filterProperties(properties.values(), query), [properties, query]);
	const createIndex = results.length;
	const totalRows = results.length + 1;

	useEffect(() => {
		if (highlightIndex >= totalRows) setHighlightIndex(0);
	}, [highlightIndex, totalRows]);

	useEffect(() => {
		if (mode === MenuMode.Pick) inputRef.current?.focus();
	}, [mode]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scrolls the active row into view on highlight change; the ref read uses `activeRef.current` which React reassigns each render.
	useEffect(() => {
		activeRef.current?.scrollIntoView({ block: "nearest" });
	}, [highlightIndex]);

	// keyboard-exempt: the shared a11y escape-stack is drained only by the
	// shell dashboard; this picker also mounts in sandboxed app renderers
	// where that handler is absent, so a self-contained capture-phase
	// listener is the only thing that fires here. Create mode steps back to
	// Pick; Pick mode dismisses.
	const escState = useRef({ mode, onClose });
	escState.current = { mode, onClose };
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			event.stopPropagation();
			if (escState.current.mode === MenuMode.Create) {
				setMode(MenuMode.Pick);
				return;
			}
			escState.current.onClose();
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, []);

	const backToPick = useCallback(() => setMode(MenuMode.Pick), []);

	const commitExisting = useCallback(
		(propertyKey: string) => {
			onPick(propertyKey);
			onClose();
		},
		[onPick, onClose],
	);

	const commitCreate = useCallback(
		(commit: InlinePropertyFormCommit) => {
			// Dictionary must land first so the def's `vocabulary.dictionaryId`
			// resolves once the def is broadcast.
			if (commit.dictionary) dictionaryStore.put(commit.dictionary);
			propertyStore.put(commit.def);
			onPick(commit.def.key);
			onClose();
		},
		[dictionaryStore, propertyStore, onPick, onClose],
	);

	const activate = useCallback(
		(index: number) => {
			if (index === createIndex) {
				setMode(MenuMode.Create);
				return;
			}
			const pick = results[index];
			if (pick) commitExisting(pick.def.key);
		},
		[results, createIndex, commitExisting],
	);

	// keyboard-exempt: input-local typeahead nav — Enter commits the highlighted
	// row, Arrow Up/Down move the highlight within this picker's own input; not an
	// app shortcut (same pattern as the editor typeaheads).
	const onInputKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLInputElement>) => {
			if (event.key === "Enter") {
				event.preventDefault();
				activate(highlightIndex);
				return;
			}
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setHighlightIndex((i) => (i + 1) % totalRows);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setHighlightIndex((i) => (i - 1 + totalRows) % totalRows);
			}
		},
		[activate, highlightIndex, totalRows],
	);

	const isCreate = mode === MenuMode.Create;

	return (
		<div
			ref={ref}
			className={
				isCreate ? "fm-menu bs-add-property bs-add-property--create" : "fm-menu bs-add-property"
			}
			role="dialog"
			aria-label={labels.region}
			style={{ top: `${style.top}px`, left: `${style.left}px`, maxHeight: `${maxHeight}px` }}
			onMouseDown={(event) => event.preventDefault()}
		>
			{isCreate ? (
				<div className="bs-add-property__create">
					<InlinePropertyForm
						labels={labels.form}
						onCommit={commitCreate}
						onCancel={backToPick}
						{...(relationTargetTypes ? { relationTargetTypes } : {})}
					/>
				</div>
			) : (
				<>
					<div className="bs-add-property__search">
						<span className="bs-add-property__search-glyph" aria-hidden="true">
							<Icon name={IconName.Search} />
						</span>
						<input
							ref={inputRef}
							type="text"
							className="bs-add-property__input"
							placeholder={labels.searchPlaceholder}
							aria-label={labels.search}
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								setHighlightIndex(0);
							}}
							onKeyDown={onInputKeyDown}
						/>
					</div>
					<div
						className="fm-list bs-add-property__list"
						role={/* kbn-roles-exempt: hand-rolled arrow-key nav */ "listbox"}
						tabIndex={-1}
						aria-label={labels.results}
					>
						{!ready ? (
							<div className="bs-add-property__empty">{labels.loading}</div>
						) : results.length === 0 ? (
							<div className="bs-add-property__empty">{query ? labels.empty : labels.emptyCatalog}</div>
						) : (
							results.map((result, index) => {
								const isActive = index === highlightIndex;
								const category = categorizeProperty(result.def);
								const typeLabel = labels.types[category];
								return (
									<button
										key={result.def.key}
										ref={isActive ? activeRef : null}
										type="button"
										role="option"
										aria-selected={isActive}
										data-active={isActive || undefined}
										className="fm-row"
										onMouseEnter={() => setHighlightIndex(index)}
										onClick={() => activate(index)}
									>
										<span className="fm-row__icon" aria-hidden="true">
											<Icon name={CATEGORY_ICON[category]} />
										</span>
										<span className="fm-row__name">{result.def.name}</span>
										<span className="fm-row__caption">
											{isMultiProperty(result.def) ? labels.typeMulti.replace("{type}", typeLabel) : typeLabel}
										</span>
									</button>
								);
							})
						)}
					</div>
					<button
						ref={highlightIndex === createIndex ? activeRef : null}
						type="button"
						className={
							highlightIndex === createIndex
								? "bs-add-property__create-action bs-add-property__create-action--active"
								: "bs-add-property__create-action"
						}
						onMouseEnter={() => setHighlightIndex(createIndex)}
						onClick={() => activate(createIndex)}
					>
						<span className="bs-add-property__create-glyph" aria-hidden="true">
							<Icon name={IconName.Plus} />
						</span>
						<span>{labels.createNew}</span>
					</button>
				</>
			)}
		</div>
	);
}

function mergeLabels(
	override: Partial<AddPropertyPickerLabels> | undefined,
): AddPropertyPickerLabels {
	if (!override) return DEFAULT_ADD_PROPERTY_PICKER_LABELS;
	return {
		...DEFAULT_ADD_PROPERTY_PICKER_LABELS,
		...override,
		types: { ...DEFAULT_ADD_PROPERTY_PICKER_LABELS.types, ...override.types },
		form: { ...DEFAULT_ADD_PROPERTY_PICKER_LABELS.form, ...override.form },
	};
}

const STYLE_ELEMENT_ID = "bs-add-property-picker-styles";

const STYLES = `
.bs-add-property {
	position: fixed;
	z-index: 200;
	width: 300px;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}
.bs-add-property__search {
	position: relative;
	display: flex;
	align-items: center;
	padding: var(--space-2, 8px);
	border-bottom: 1px solid var(--color-border-subtle, var(--border, rgba(127,127,127,0.18)));
}
.bs-add-property__search-glyph {
	position: absolute;
	inset-inline-start: 16px;
	display: inline-flex;
	color: var(--text-faint, #999);
	pointer-events: none;
}
/* Scoped under \`.bs-add-property\` (0,2,0) so these beat the menu runtime's
 * \`.fm-menu input\` reset (0,1,1) — the picker root carries \`fm-menu\` for its
 * glass chrome, and that reset zeroed the input's padding, dropping the
 * placeholder text under the absolutely-positioned search glyph. */
.bs-add-property .bs-add-property__input {
	width: 100%;
	height: 30px;
	padding: 0 var(--space-2, 8px) 0 var(--space-6, 28px);
	border: 1px solid transparent;
	border-radius: var(--radius-md, 8px);
	background: var(--bg-elev, rgba(127,127,127,0.08));
	color: var(--text, inherit);
	font: inherit;
	font-size: var(--text-size-md, 14px);
	outline: none;
	transition: border-color 100ms ease, background 100ms ease;
}
.bs-add-property .bs-add-property__input:focus {
	border-color: color-mix(in srgb, var(--accent, #6b73f0) 55%, transparent);
	background: var(--bg, transparent);
}
/* The search input carries its own focus treatment (accent border + lifted
 * background) and the dialog container takes programmatic focus on open — the
 * fleet-wide keyboard ring (F-270's \`:root :focus-visible\`) would otherwise
 * stack a heavy accent outline INSET into them (outline-offset: -2px), reading
 * as an ugly pink frame around the whole picker. Opt these surfaces out; the
 * input's border/bg shift and the row highlight are the real focus indicators.
 * Scoped under \`.bs-add-property\` (0,0,3,0) so it beats the global rule without
 * touching any other control's ring. */
.bs-add-property:focus-visible,
.bs-add-property .bs-add-property__input:focus-visible,
.bs-add-property .bs-add-property__list:focus-visible {
	outline: none;
}
.bs-add-property .bs-add-property__input::placeholder {
	color: var(--text-faint, #999);
}
.bs-add-property__list {
	flex: 1 1 auto;
	min-height: 0;
	overflow-y: auto;
	padding: var(--space-2, 8px);
	display: flex;
	flex-direction: column;
	gap: var(--space-0_5, 2px);
}
.bs-add-property__empty {
	padding: var(--space-4, 16px) var(--space-2, 8px);
	color: var(--text-faint, #999);
	font-size: var(--text-size-sm, 13px);
	text-align: center;
}
.bs-add-property__create-action {
	display: flex;
	align-items: center;
	gap: var(--space-2, 8px);
	flex: 0 0 auto;
	padding: var(--space-2, 8px);
	border: 0;
	border-top: 1px solid var(--color-border-subtle, var(--border, rgba(127,127,127,0.18)));
	background: transparent;
	cursor: pointer;
	text-align: start;
	font: inherit;
	font-size: var(--text-size-md, 14px);
	font-weight: var(--text-weight-medium, 500);
	color: var(--text-dim, #888);
	transition: background 120ms ease, color 120ms ease;
}
.bs-add-property__create-action:hover,
.bs-add-property__create-action--active {
	background: var(--hover, rgba(127,127,127,0.1));
	color: var(--text, inherit);
}
.bs-add-property__create-glyph {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 20px;
	height: 20px;
	border-radius: var(--radius-sm, 6px);
	color: var(--accent, #6b73f0);
}
.bs-add-property__create {
	overflow: auto;
	min-height: 0;
}
`;

function useInjectedStyles(): void {
	useEffect(() => {
		if (typeof document === "undefined") return;
		if (document.getElementById(STYLE_ELEMENT_ID)) return;
		const style = document.createElement("style");
		style.id = STYLE_ELEMENT_ID;
		style.textContent = STYLES;
		document.head.appendChild(style);
	}, []);
}
