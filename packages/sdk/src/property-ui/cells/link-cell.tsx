/**
 * LinkInlineCell / LinkCardCell — entityRef views. Targets render with
 * the entity's own title (resolved through the shared
 * `entity-title-index`, one vault scan per `onChange` shared across all
 * rows); the picker is a searchable list in the shared `<CellPopover>`,
 * scoped to `note:*` ids so cross-note links work within v1 storage.
 *
 * `style` only changes the resting chrome (a pill-shaped inline anchor
 * vs a bordered card) — one component, two registry keys.
 */

import {
	type CellProps,
	type LabeledValue,
	type VaultEntity,
	isMultiValued,
} from "@brainstorm-os/sdk-types";
import type { JSX } from "react";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { coerceValue } from "../../properties-validate";
import { CheckIcon } from "../icons";
import { usePropertyUiSeams } from "../use-properties";
import { CellPopover } from "./cell-popover";
import { useCellOptionsKeyboard } from "./use-cell-options-keyboard";

export enum LinkStyle {
	Inline = "inline",
	Card = "card",
}

const NOTE_PREFIX = "n_";

function makeLinkCell(style: LinkStyle) {
	return function LinkCell(props: CellProps): JSX.Element {
		const { property, value, onChange, readOnly, autoEdit, onAutoEditHandled } = props;
		const { labels, entityTitleSource } = usePropertyUiSeams();
		const multi = isMultiValued(property.count);

		useSyncExternalStore(entityTitleSource.subscribe, entityTitleSource.snapshotTick);

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
					onChange(
						coerceValue(
							property,
							ids.map((id) => ({ value: id })),
						) as never,
					);
				} else {
					onChange(coerceValue(property, ids[0] ?? null) as never);
				}
			},
			[multi, onChange, property],
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

		const untitled = labels.linkUntitled ?? "Untitled";
		const chips = selectedIds.map((id) => {
			const title = entityTitleSource.titleOf(id) ?? untitled;
			return (
				<span key={id} className={`bs-cell-link bs-cell-link--${style}`} title={title}>
					<span className="bs-cell-link-title">{title}</span>
				</span>
			);
		});

		return (
			<CellPopover
				trigger={
					selectedIds.length === 0 ? (
						<span className="bs-cell-link-empty">{labels.cellEmpty}</span>
					) : (
						<span className="bs-cell-link-set">{chips}</span>
					)
				}
				triggerClassName="bs-cell-link-trigger"
				triggerAriaLabel={labels.cellEditValueFor(property.name)}
				disabled={readOnly}
				panelAriaLabel={labels.linkPickerRegion(property.name)}
				autoOpen={autoEdit}
				onAutoOpenHandled={onAutoEditHandled}
			>
				{(close) => (
					<LinkPicker
						selectedIds={selectedIds}
						multi={multi}
						allowedTypes={property.allowedTypes ?? null}
						onToggle={toggle}
						onClose={close}
					/>
				)}
			</CellPopover>
		);
	};
}

function LinkPicker({
	selectedIds,
	multi,
	allowedTypes,
	onToggle,
	onClose,
}: {
	selectedIds: readonly string[];
	multi: boolean;
	/** Target-type scope from the property's `allowedTypes`. When set, the
	 *  picker lists entities of those types (link to Tasks / People / a
	 *  collection). When null/empty it falls back to the v1 note scope. */
	allowedTypes: readonly string[] | null;
	onToggle: (id: string) => void;
	onClose: () => void;
}): JSX.Element {
	const { labels, entityTitleSource } = usePropertyUiSeams();
	const snapshotTick = useSyncExternalStore(
		entityTitleSource.subscribe,
		entityTitleSource.snapshotTick,
	);
	const [query, setQuery] = useState("");

	// `displayTitle` falls back to the bare entity id for a title/name-less
	// entity; surface a humane "Untitled" instead of a raw `ent_…` id.
	const untitled = labels.linkUntitled ?? "Untitled";
	const labelOf = useCallback(
		(e: VaultEntity) => {
			const title = entityTitleSource.displayTitle(e);
			return title === e.id ? untitled : title;
		},
		[entityTitleSource, untitled],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `snapshotTick` is the staleness signal — `entityTitleSource.list()` reads host state the linter can't see, so the tick must re-trigger the memo when the shared snapshot refreshes.
	const results = useMemo(() => {
		const q = query.trim().toLowerCase();
		const typeScope = allowedTypes && allowedTypes.length > 0 ? new Set(allowedTypes) : null;
		// A typed relation scopes by entity type; an untyped one keeps the v1
		// storage scope (cross-note links only).
		const inScope = typeScope
			? (e: VaultEntity) => typeScope.has(e.type)
			: (e: VaultEntity) => e.id.startsWith(NOTE_PREFIX);
		return entityTitleSource
			.list()
			.filter((e) => inScope(e) && e.deletedAt === null)
			.filter((e) => q.length === 0 || entityTitleSource.displayTitle(e).toLowerCase().includes(q));
	}, [query, snapshotTick, entityTitleSource, allowedTypes]);

	const selectedIndices = useMemo(
		() => new Set(results.flatMap((e, i) => (selectedIds.includes(e.id) ? [i] : []))),
		[results, selectedIds],
	);
	const kb = useCellOptionsKeyboard({
		count: results.length,
		multi,
		selectedIndices,
		onActivate: (index) => {
			const e = results[index];
			if (!e) return;
			onToggle(e.id);
			if (!multi) onClose();
		},
	});

	return (
		<>
			<div className="bs-cell-pop-search">
				<input
					type="text"
					className="bs-cell-pop-input"
					placeholder={labels.linkSearchPlaceholder}
					aria-label={labels.linkSearch}
					value={query}
					// biome-ignore lint/a11y/noAutofocus: focus the link search on open, mirroring the tag picker.
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
				aria-label={labels.linkOptions}
			>
				{results.length === 0 ? (
					<div className="bs-cell-pop-status">{labels.linkNoResults}</div>
				) : (
					results.map((e, index) => {
						const selected = selectedIds.includes(e.id);
						return (
							<button
								key={e.id}
								type="button"
								{...kb.getOptionProps(index)}
								className={selected ? "bs-cell-pop-row bs-cell-pop-row--selected" : "bs-cell-pop-row"}
								onClick={() => {
									onToggle(e.id);
									if (!multi) onClose();
								}}
							>
								<span className="bs-cell-pop-swatch" aria-hidden="true" />
								<span className="bs-cell-pop-row-label" title={labelOf(e)}>
									{labelOf(e)}
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
			</div>
		</>
	);
}

export const LinkInlineCell = makeLinkCell(LinkStyle.Inline);
export const LinkCardCell = makeLinkCell(LinkStyle.Card);
