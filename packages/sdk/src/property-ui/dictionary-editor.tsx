/**
 * DictionaryEditor — the full vocabulary editor (B5.8). Per
 * : header (name +
 * count), toolbar (search + sort + Add + import/export menu),
 * reorderable item list (drag handle + swatch + label + usage + row
 * menu), footer ("Show archived (N)").
 *
 * Reachable from the Tag cell's "Manage values" footer via
 * `dictionaryEditorStore`; rendered by `DictionaryEditorHost`, which
 * supplies the vault's notes so destructive ops (delete / merge) can
 * rewrite bound values and the usage badges resolve.
 *
 * Sort mode is per-user, persisted under
 * `app.settings:dictionary-sort:<id>`. Keyboard reorder is
 * Space→arrows→Space via the shortcut registry — no raw `e.key`.
 */

import type { Dictionary, DictionaryItem, PropertyDef } from "@brainstorm/sdk-types";
import { type JSX, type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { openAnchoredMenu } from "../object-menu";
import { SelectMenu } from "../select-menu";
import {
	DICTIONARY_SORT_ORDER,
	DictionarySortMode,
	activeItems,
	archivedItems,
	chipColours,
	filterItems,
	parseDictionarySortMode,
	sortItems,
} from "./dictionary-helpers";
import { exportJson, parseImport } from "./dictionary-import";
import { CloseXIcon, GripIcon, MoreIcon } from "./icons";
import type { PropertyUiLabels } from "./seams";
import { useDictionaryShortcut } from "./use-dictionary-shortcut";
import { usePropertyUiSeams } from "./use-properties";

enum ImportFeedbackKind {
	Ok = "ok",
	Error = "error",
	Truncated = "truncated",
}

type ImportFeedback =
	| { kind: ImportFeedbackKind.Ok }
	| { kind: ImportFeedbackKind.Error; message: string }
	| { kind: ImportFeedbackKind.Truncated; count: number };
import {
	type NoteValues,
	addItem,
	archiveItem,
	deleteItem,
	mergeItems,
	patchItem,
	renameDictionary,
	reorderItem,
	unarchiveItem,
	usageIndex,
} from "./dictionary-ops";

function sortModeLabel(mode: DictionarySortMode, labels: PropertyUiLabels): string {
	switch (mode) {
		case DictionarySortMode.Alpha:
			return labels.dictSortAlpha;
		case DictionarySortMode.AlphaDesc:
			return labels.dictSortAlphaDesc;
		case DictionarySortMode.MostUsed:
			return labels.dictSortMostUsed;
		default:
			return labels.dictSortManual;
	}
}

export type DictionaryEditorProps = {
	dictionary: Dictionary;
	properties: readonly PropertyDef[];
	notes: readonly NoteValues[];
	sortMode: DictionarySortMode;
	onSortModeChange: (mode: DictionarySortMode) => void;
	onCommit: (next: Dictionary) => void;
	/** Persist the notes whose bound values a delete/merge rewrote. */
	onRewriteNotes: (changed: readonly NoteValues[]) => void;
	onClose: () => void;
};

export function DictionaryEditor({
	dictionary,
	properties,
	notes,
	sortMode,
	onSortModeChange,
	onCommit,
	onRewriteNotes,
	onClose,
}: DictionaryEditorProps): JSX.Element {
	const { labels, dictionaryEditorMatchers } = usePropertyUiSeams();
	const searchRef = useRef<HTMLInputElement | null>(null);
	const [query, setQuery] = useState("");
	const [showArchived, setShowArchived] = useState(false);
	const [pickedUp, setPickedUp] = useState<string | null>(null);
	const [mergeFrom, setMergeFrom] = useState<string | null>(null);

	const usage = useMemo(() => usageIndex(properties, notes), [properties, notes]);

	const visible = useMemo(() => {
		const base = sortItems(activeItems(dictionary), sortMode, usage);
		return filterItems(base, query);
	}, [dictionary, sortMode, usage, query]);

	const archived = useMemo(() => archivedItems(dictionary), [dictionary]);

	useDictionaryShortcut(
		dictionaryEditorMatchers.closeEditor,
		useCallback(
			(event: KeyboardEvent) => {
				event.preventDefault();
				onClose();
			},
			[onClose],
		),
	);

	useDictionaryShortcut(
		dictionaryEditorMatchers.focusSearch,
		useCallback((event: KeyboardEvent) => {
			event.preventDefault();
			searchRef.current?.focus();
			searchRef.current?.select();
		}, []),
	);

	const reorder = useCallback(
		(id: string, delta: number) => {
			const ordered = sortItems(activeItems(dictionary), DictionarySortMode.Manual);
			const idx = ordered.findIndex((it) => it.id === id);
			if (idx < 0) return;
			onCommit(reorderItem(dictionary, id, idx + delta));
		},
		[dictionary, onCommit],
	);

	const onHandleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
			if (dictionaryEditorMatchers.reorderToggle(event)) {
				event.preventDefault();
				setPickedUp((cur) => (cur === id ? null : id));
				return;
			}
			if (pickedUp !== id) return;
			if (dictionaryEditorMatchers.reorderUp(event)) {
				event.preventDefault();
				reorder(id, -1);
			} else if (dictionaryEditorMatchers.reorderDown(event)) {
				event.preventDefault();
				reorder(id, 1);
			}
		},
		[pickedUp, reorder, dictionaryEditorMatchers],
	);

	const onAdd = useCallback(() => {
		const { dict } = addItem(dictionary);
		onCommit(dict);
	}, [dictionary, onCommit]);

	const onRename = useCallback(
		(name: string) => onCommit(renameDictionary(dictionary, name)),
		[dictionary, onCommit],
	);

	const onPatch = useCallback(
		(id: string, patch: Partial<Omit<DictionaryItem, "id">>) =>
			onCommit(patchItem(dictionary, id, patch)),
		[dictionary, onCommit],
	);

	const onArchive = useCallback(
		(id: string) => onCommit(archiveItem(dictionary, id)),
		[dictionary, onCommit],
	);

	const onUnarchive = useCallback(
		(id: string) => onCommit(unarchiveItem(dictionary, id)),
		[dictionary, onCommit],
	);

	const onDelete = useCallback(
		(id: string) => {
			const { dict, changed } = deleteItem(dictionary, id, properties, notes);
			onCommit(dict);
			if (changed.length > 0) onRewriteNotes(changed);
		},
		[dictionary, properties, notes, onCommit, onRewriteNotes],
	);

	const onMerge = useCallback(
		(fromId: string, toId: string) => {
			const { dict, changed } = mergeItems(dictionary, fromId, toId, properties, notes);
			onCommit(dict);
			if (changed.length > 0) onRewriteNotes(changed);
			setMergeFrom(null);
		},
		[dictionary, properties, notes, onCommit, onRewriteNotes],
	);

	const onImport = useCallback(
		(text: string): ImportFeedback => {
			const result = parseImport(text);
			if (!result.ok) {
				return { kind: ImportFeedbackKind.Error, message: result.error };
			}
			let next = dictionary;
			for (const row of result.rows) {
				const { dict, item } = addItem(next, row.label);
				next = patchItem(dict, item.id, {
					icon: null,
					...(row.description !== undefined ? { description: row.description } : {}),
					...(row.colour !== undefined ? { colour: row.colour } : {}),
				});
			}
			onCommit(next);
			return result.truncated
				? { kind: ImportFeedbackKind.Truncated, count: result.rows.length }
				: { kind: ImportFeedbackKind.Ok };
		},
		[dictionary, onCommit],
	);

	return (
		<div className="notes__dict" role="dialog" aria-modal="true" aria-label={labels.dictRegion}>
			<header className="notes__dict-head">
				<input
					className="notes__dict-name"
					value={dictionary.name}
					aria-label={labels.dictNameLabel}
					onChange={(e) => onRename(e.target.value)}
				/>
				<span className="notes__dict-count">{labels.dictCount(activeItems(dictionary).length)}</span>
				<button
					type="button"
					className="notes__dict-close"
					onClick={onClose}
					aria-label={labels.dictClose}
					data-bs-tooltip={labels.dictClose}
				>
					<CloseXIcon />
				</button>
			</header>

			<div className="notes__dict-toolbar">
				<input
					ref={searchRef}
					type="text"
					className="notes__dict-search"
					placeholder={labels.dictSearchPlaceholder}
					aria-label={labels.dictSearch}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<div className="notes__dict-sort">
					<span className="notes__dict-sort-label">{labels.dictSortLabel}</span>
					<SelectMenu
						value={sortMode}
						ariaLabel={labels.dictSortLabel}
						className="bs-select--sm"
						options={DICTIONARY_SORT_ORDER.map((m) => ({
							value: m,
							label: sortModeLabel(m, labels),
						}))}
						onChange={(next) => onSortModeChange(parseDictionarySortMode(next))}
					/>
				</div>
				<button type="button" className="notes__dict-add" onClick={onAdd}>
					{labels.dictAddItem}
				</button>
				<ImportExportMenu items={dictionary.items} onImport={onImport} />
			</div>

			<ul className="notes__dict-list" aria-label={labels.dictItemsRegion}>
				{visible.length === 0 ? (
					<li className="notes__dict-empty">{labels.dictNoItems}</li>
				) : (
					visible.map((item) => (
						<DictionaryRow
							key={item.id}
							item={item}
							usage={usage.get(item.id) ?? 0}
							manualSort={sortMode === DictionarySortMode.Manual}
							pickedUp={pickedUp === item.id}
							mergeArmed={mergeFrom !== null && mergeFrom !== item.id}
							onHandleKeyDown={(e) => onHandleKeyDown(e, item.id)}
							onPatch={(patch) => onPatch(item.id, patch)}
							onArchive={() => onArchive(item.id)}
							onDelete={() => onDelete(item.id)}
							onStartMerge={() => setMergeFrom(item.id)}
							onMergeInto={() => {
								if (mergeFrom) onMerge(mergeFrom, item.id);
							}}
						/>
					))
				)}
			</ul>

			<footer className="notes__dict-foot">
				<button
					type="button"
					className="notes__dict-archived-toggle"
					aria-expanded={showArchived}
					onClick={() => setShowArchived((v) => !v)}
				>
					{labels.dictShowArchived(archived.length)}
				</button>
				{showArchived ? (
					<ul className="notes__dict-archived-list" aria-label={labels.dictArchivedRegion}>
						{archived.map((item) => (
							<li key={item.id} className="notes__dict-archived-row">
								<span className="notes__dict-row-label" title={item.label}>
									{item.label.length > 0 ? item.label : item.id}
								</span>
								<button
									type="button"
									className="notes__dict-unarchive"
									onClick={() => onUnarchive(item.id)}
								>
									{labels.dictUnarchive}
								</button>
							</li>
						))}
					</ul>
				) : null}
			</footer>
		</div>
	);
}

function DictionaryRow({
	item,
	usage,
	manualSort,
	pickedUp,
	mergeArmed,
	onHandleKeyDown,
	onPatch,
	onArchive,
	onDelete,
	onStartMerge,
	onMergeInto,
}: {
	item: DictionaryItem;
	usage: number;
	manualSort: boolean;
	pickedUp: boolean;
	mergeArmed: boolean;
	onHandleKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
	onPatch: (patch: Partial<Omit<DictionaryItem, "id">>) => void;
	onArchive: () => void;
	onDelete: () => void;
	onStartMerge: () => void;
	onMergeInto: () => void;
}): JSX.Element {
	const { labels } = usePropertyUiSeams();
	const menuBtnRef = useRef<HTMLButtonElement>(null);
	const colours = chipColours(item);
	return (
		<li className="notes__dict-row" data-picked-up={pickedUp || undefined}>
			{manualSort ? (
				<button
					type="button"
					className="notes__dict-grip"
					aria-label={labels.dictReorder(item.label)}
					aria-pressed={pickedUp}
					onKeyDown={onHandleKeyDown}
				>
					<GripIcon />
				</button>
			) : (
				<span className="notes__dict-grip notes__dict-grip--disabled" aria-hidden="true" />
			)}
			<span
				className="notes__dict-swatch"
				aria-hidden="true"
				style={{ background: colours.foreground }}
			/>
			<input
				className="notes__dict-row-input"
				value={item.label}
				aria-label={labels.dictItemLabel}
				onChange={(e) => onPatch({ label: e.target.value })}
			/>
			<span className="notes__dict-usage">{labels.dictUsage(usage)}</span>
			{mergeArmed ? (
				<button type="button" className="notes__dict-merge-target" onClick={onMergeInto}>
					{labels.dictMergeInto}
				</button>
			) : (
				<div className="notes__dict-row-menu">
					<button
						ref={menuBtnRef}
						type="button"
						className="notes__dict-row-menu-btn"
						aria-haspopup="menu"
						aria-label={labels.dictRowMenu(item.label)}
						onClick={() => {
							const el = menuBtnRef.current;
							if (!el) return;
							const rect = el.getBoundingClientRect();
							openAnchoredMenu(
								{ x: rect.right, y: rect.bottom },
								[
									{ label: labels.dictStartMerge, onSelect: onStartMerge },
									{ label: labels.dictArchive, onSelect: onArchive },
									{ label: labels.dictDelete, destructive: true, onSelect: onDelete },
								],
								{ menuLabel: labels.dictRowMenu(item.label), anchor: el },
							);
						}}
					>
						<MoreIcon />
					</button>
				</div>
			)}
		</li>
	);
}

function ImportExportMenu({
	items,
	onImport,
}: {
	items: readonly DictionaryItem[];
	onImport: (text: string) => ImportFeedback;
}): JSX.Element {
	const { labels } = usePropertyUiSeams();
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const [feedback, setFeedback] = useState<ImportFeedback | null>(null);

	const caption =
		feedback?.kind === ImportFeedbackKind.Error
			? labels.dictImportFailed(feedback.message)
			: feedback?.kind === ImportFeedbackKind.Truncated
				? labels.dictImportTruncated(feedback.count)
				: null;

	return (
		<div className="notes__dict-io">
			<button
				type="button"
				className="notes__dict-io-btn"
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				{labels.dictImportExport}
			</button>
			{open ? (
				<div className="notes__dict-io-panel" role="dialog" aria-label={labels.dictImportExport}>
					<textarea
						className="notes__dict-io-input"
						placeholder={labels.dictImportPlaceholder}
						aria-label={labels.dictImportLabel}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
					/>
					<div className="notes__dict-io-actions">
						<button
							type="button"
							className="notes__dict-io-action"
							onClick={() => {
								const result = onImport(draft);
								setFeedback(result);
								if (result.kind !== ImportFeedbackKind.Error) {
									setDraft("");
								}
							}}
						>
							{labels.dictImportCommit}
						</button>
						<button
							type="button"
							className="notes__dict-io-action"
							onClick={() => {
								setDraft(exportJson(items));
								setFeedback(null);
							}}
						>
							{labels.dictExportJson}
						</button>
					</div>
					{caption ? (
						<p className="notes__dict-io-caption" role="status" data-kind={feedback?.kind}>
							{caption}
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}
