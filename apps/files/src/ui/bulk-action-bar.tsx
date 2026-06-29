/**
 * Multi-selection bulk-action bar (9.8.12).
 *
 * A footer overlay that appears whenever ≥1 item is selected: a count pill +
 * the immediate bulk ops (Duplicate, Delete) + a Clear affordance. Move/Copy
 * need a destination picker (a follow-on); the ops here act in place. The
 * destructive Delete routes through the app's shared confirm dialog (the
 * caller wires `onDelete`), per the fail-safe destructive-action rule.
 */

import { Orientation, SelectionAttribute, useCompositeKeyboard } from "@brainstorm/sdk/a11y";
import { plural } from "@brainstorm/sdk/i18n";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { useState } from "react";
import { t } from "../i18n";

export type BulkActionBarProps = {
	count: number;
	onDuplicate: () => void;
	/** `anchor` is the trigger button — the destination search-picker drops from it. */
	onMove: (anchor: HTMLElement) => void;
	onCopy: (anchor: HTMLElement) => void;
	onRename: () => void;
	onDelete: () => void;
	onClear: () => void;
};

/** The roving controls in the bar: Duplicate, Move, Copy, Rename, Delete, Clear. */
const BULK_CONTROL_COUNT = 6;

export function BulkActionBar({
	count,
	onDuplicate,
	onMove,
	onCopy,
	onRename,
	onDelete,
	onClear,
}: BulkActionBarProps): React.ReactElement | null {
	// KBN-A-files (bulk bar): the action controls form a horizontal toolbar via
	// the shared `useCompositeKeyboard` reducer — ArrowLeft/Right rove between the
	// native buttons (which keep their own click handlers), role + roving tabindex
	// come from the hook. `selectionAttribute: None` keeps the buttons free of
	// aria-selected/checked and the item role is auto-omitted for a toolbar.
	const [cursor, setCursor] = useState(0);
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		role: "toolbar",
		selectionAttribute: SelectionAttribute.None,
		count: BULK_CONTROL_COUNT,
		activeIndex: cursor,
		onActiveIndexChange: setCursor,
	});

	if (count === 0) return null;
	const label = plural(
		t,
		count,
		"brainstorm.files.bulk.count.one",
		"brainstorm.files.bulk.count.other",
	);
	return (
		<div
			{...containerProps}
			className="files-bulkbar"
			aria-label={t("brainstorm.files.bulk.region")}
			data-testid="bulk-bar"
		>
			<span className="files-bulkbar__count">{label}</span>
			<div className="files-bulkbar__actions">
				<button
					{...getItemProps(0)}
					type="button"
					className="files-bulkbar__action"
					data-testid="bulk-duplicate"
					onClick={onDuplicate}
				>
					<Icon name={IconName.Copy} size={16} />
					{t("brainstorm.files.bulk.duplicate")}
				</button>
				<button
					{...getItemProps(1)}
					type="button"
					className="files-bulkbar__action"
					data-testid="bulk-move"
					onClick={(e) => onMove(e.currentTarget)}
				>
					<Icon name={IconName.ArrowRight} size={16} />
					{t("brainstorm.files.bulk.move")}
				</button>
				<button
					{...getItemProps(2)}
					type="button"
					className="files-bulkbar__action"
					data-testid="bulk-copy"
					onClick={(e) => onCopy(e.currentTarget)}
				>
					<Icon name={IconName.FolderPlus} size={16} />
					{t("brainstorm.files.bulk.copy")}
				</button>
				<button
					{...getItemProps(3)}
					type="button"
					className="files-bulkbar__action"
					data-testid="bulk-rename"
					onClick={onRename}
				>
					<Icon name={IconName.Pencil} size={16} />
					{t("brainstorm.files.bulk.rename")}
				</button>
				<button
					{...getItemProps(4)}
					type="button"
					className="files-bulkbar__action files-bulkbar__action--danger"
					data-testid="bulk-delete"
					onClick={onDelete}
				>
					<Icon name={IconName.Trash} size={16} />
					{t("brainstorm.files.bulk.delete")}
				</button>
			</div>
			<button
				{...getItemProps(5)}
				type="button"
				className="files-bulkbar__clear"
				data-testid="bulk-clear"
				aria-label={t("brainstorm.files.bulk.clear")}
				title={t("brainstorm.files.bulk.clear")}
				onClick={onClear}
			>
				<Icon name={IconName.Close} size={14} />
			</button>
		</div>
	);
}
