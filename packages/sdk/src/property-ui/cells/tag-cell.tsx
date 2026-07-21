/**
 * TagCell / TagListCell — the render for a `text + vocabulary`
 * property. `TagCell` is the scalar (Select) shape; `TagListCell` the
 * multi-valued (MultiSelect) shape. The registry keys both off
 * `(Text, Tag|TagList)`; the cell picks scalar vs multi at runtime via
 * `isMultiValued(def.count)` (per the registry comment).
 *
 * Selecting a value opens the dictionary's read-only viewer in a
 * shared `<CellPopover>`; a "Manage values" footer routes to the full
 * DictionaryEditor (B5.8) via `dictionaryEditorStore`. Chips paint
 * with the dictionary item's OWN colour — vocabulary colour is user
 * data, never a `--color-state-*` chrome token.
 */

import {
	type CellProps,
	type LabeledValue,
	ValueType,
	isMultiValued,
} from "@brainstorm-os/sdk-types";
import type { JSX } from "react";
import { useCallback, useMemo, useState } from "react";
import { dictionaryEditorStore } from "../dictionary-editor-store";
import {
	DictionarySortMode,
	activeItems,
	chipColours,
	filterItems,
	findItem,
	sortItems,
} from "../dictionary-helpers";
import { addItem } from "../dictionary-ops";
import { CheckIcon, CloseXIcon, PlusIcon } from "../icons";
import { useDictionary, useDictionaryStore, usePropertyUiSeams } from "../use-properties";
import { CellPopover } from "./cell-popover";
import { useCellOptionsKeyboard } from "./use-cell-options-keyboard";

function Chip({
	dictId,
	label,
	colour,
	onRemove,
}: {
	dictId: string | undefined;
	label: string;
	colour: string | undefined;
	onRemove?: (() => void) | undefined;
}): JSX.Element {
	const { labels } = usePropertyUiSeams();
	const c = chipColours(colour);
	return (
		<span
			className="bs-cell-tag"
			data-dict={dictId}
			style={{ background: c.background, color: c.foreground, borderColor: c.border }}
		>
			<span className="bs-cell-tag-label" title={label}>
				{label}
			</span>
			{onRemove ? (
				<button
					type="button"
					className="bs-cell-tag-remove"
					onClick={(e) => {
						e.stopPropagation();
						onRemove();
					}}
					aria-label={labels.tagRemove(label)}
					data-bs-tooltip={labels.tagRemove(label)}
				>
					<CloseXIcon />
				</button>
			) : null}
		</span>
	);
}

export function TagCell(props: CellProps): JSX.Element {
	const { property, value, onChange, readOnly, autoEdit, onAutoEditHandled } = props;
	const { labels } = usePropertyUiSeams();
	const dictId = property.vocabulary?.dictionaryId ?? null;
	const dictionary = useDictionary(dictId);
	const multi = isMultiValued(property.count);

	const selectedIds = useMemo<readonly string[]>(() => {
		if (multi) {
			const arr = Array.isArray(value) ? (value as readonly LabeledValue<string>[]) : [];
			return arr.map((el) => el.value);
		}
		return typeof value === "string" && value.length > 0 ? [value] : [];
	}, [value, multi]);

	const emit = useCallback(
		(ids: readonly string[]) => {
			if (multi) {
				onChange(ids.map((id) => ({ value: id })) as never);
			} else {
				onChange((ids[0] ?? null) as never);
			}
		},
		[multi, onChange],
	);

	const toggle = useCallback(
		(id: string) => {
			if (multi) {
				emit(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
			} else {
				emit(selectedIds.includes(id) ? [] : [id]);
			}
		},
		[multi, selectedIds, emit],
	);

	const chips = selectedIds.map((id) => {
		const item = findItem(dictionary, id);
		const label = item?.label ?? id;
		return (
			<Chip
				key={id}
				dictId={dictId ?? undefined}
				label={label}
				colour={item?.colour}
				onRemove={readOnly ? undefined : () => toggle(id)}
			/>
		);
	});

	const triggerBody =
		selectedIds.length === 0 ? (
			<span className="bs-cell-tag-empty">{labels.selectEmpty ?? labels.cellEmpty}</span>
		) : (
			<span className="bs-cell-tag-set">{chips}</span>
		);

	return (
		<CellPopover
			trigger={triggerBody}
			triggerClassName="bs-cell-tag-trigger"
			triggerAriaLabel={labels.cellEditValueFor(property.name)}
			disabled={readOnly}
			triggerHasInteractiveContent={!readOnly}
			panelAriaLabel={labels.tagPickerRegion(property.name)}
			autoOpen={autoEdit}
			onAutoOpenHandled={onAutoEditHandled}
		>
			{(close) => (
				<TagPicker
					dictionaryId={dictId}
					selectedIds={selectedIds}
					multi={multi}
					onToggle={toggle}
					onClose={close}
				/>
			)}
		</CellPopover>
	);
}

function TagPicker({
	dictionaryId,
	selectedIds,
	multi,
	onToggle,
	onClose,
}: {
	dictionaryId: string | null;
	selectedIds: readonly string[];
	multi: boolean;
	onToggle: (id: string) => void;
	onClose: () => void;
}): JSX.Element {
	const { labels } = usePropertyUiSeams();
	const { store } = useDictionaryStore();
	const dictionary = useDictionary(dictionaryId);
	const [query, setQuery] = useState("");

	const visible = useMemo(
		() => filterItems(sortItems(activeItems(dictionary), DictionarySortMode.Manual), query),
		[dictionary, query],
	);

	// Offer inline creation when the typed label isn't already an active
	// value (case-insensitive) — the Notion "Create '…'" affordance,
	// so a value picker doubles as a value author without a detour through
	// the dictionary editor.
	const trimmed = query.trim();
	const canCreate = useMemo(() => {
		if (!dictionaryId || trimmed.length === 0) return false;
		const lower = trimmed.toLowerCase();
		return !activeItems(dictionary).some((it) => it.label.toLowerCase() === lower);
	}, [dictionaryId, dictionary, trimmed]);

	const createIndex = canCreate ? visible.length : -1;

	const create = useCallback(() => {
		if (!dictionaryId) return;
		const dict = store.get(dictionaryId);
		if (!dict) return;
		const { dict: next, item } = addItem(dict, trimmed);
		store.put(next);
		onToggle(item.id);
		setQuery("");
		if (!multi) onClose();
	}, [dictionaryId, store, trimmed, onToggle, multi, onClose]);

	const selectedIndices = useMemo(
		() => new Set(visible.flatMap((item, i) => (selectedIds.includes(item.id) ? [i] : []))),
		[visible, selectedIds],
	);
	const kb = useCellOptionsKeyboard({
		count: visible.length + (canCreate ? 1 : 0),
		multi,
		selectedIndices,
		onActivate: (index) => {
			if (index === createIndex) {
				create();
				return;
			}
			const item = visible[index];
			if (!item) return;
			onToggle(item.id);
			if (!multi) onClose();
		},
	});

	const manage = useCallback(() => {
		if (dictionaryId) dictionaryEditorStore.open(dictionaryId);
		onClose();
	}, [dictionaryId, onClose]);

	return (
		<>
			<div className="bs-cell-pop-search">
				<input
					type="text"
					className="bs-cell-pop-input"
					placeholder={labels.tagSearchPlaceholder}
					aria-label={labels.tagSearch}
					value={query}
					// biome-ignore lint/a11y/noAutofocus: focus belongs on the picker's search on open, mirroring add-property-menu.
					autoFocus
					onChange={(e) => setQuery(e.target.value)}
					{...kb.inputProps}
				/>
			</div>
			<div
				className="bs-cell-pop-list"
				role={kb.listRole}
				aria-orientation={kb.listOrientation}
				aria-multiselectable={kb.listMultiselectable}
				tabIndex={-1}
				aria-label={labels.tagOptions}
			>
				{visible.length === 0 && !canCreate ? (
					<div className="bs-cell-pop-status">{labels.tagNoValues}</div>
				) : (
					visible.map((item, index) => {
						const selected = selectedIds.includes(item.id);
						const c = chipColours(item);
						return (
							<button
								key={item.id}
								type="button"
								{...kb.getOptionProps(index)}
								className={selected ? "bs-cell-pop-row bs-cell-pop-row--selected" : "bs-cell-pop-row"}
								onClick={() => {
									onToggle(item.id);
									if (!multi) onClose();
								}}
							>
								<span
									className="bs-cell-pop-swatch"
									aria-hidden="true"
									style={{ background: c.foreground }}
								/>
								<span className="bs-cell-pop-row-label" title={item.label}>
									{item.label.length > 0 ? item.label : item.id}
								</span>
								{selected ? (
									<span className="bs-cell-pop-check" aria-hidden="true">
										<CheckIcon />
									</span>
								) : null}
							</button>
						);
					})
				)}
				{canCreate ? (
					<button
						type="button"
						{...kb.getOptionProps(createIndex)}
						className="bs-cell-pop-row bs-cell-pop-row--create"
						onClick={create}
					>
						<span className="bs-cell-pop-swatch bs-cell-pop-swatch--add" aria-hidden="true">
							<PlusIcon />
						</span>
						<span className="bs-cell-pop-row-label">
							{(labels.tagCreate ?? ((l: string) => `Create “${l}”`))(trimmed)}
						</span>
					</button>
				) : null}
			</div>
			<button type="button" className="bs-cell-pop-foot" onClick={manage}>
				{labels.tagManageValues}
			</button>
		</>
	);
}

export function isTagShaped(valueType: ValueType): boolean {
	return valueType === ValueType.Text;
}
