/**
 * All Files dialogs/popovers render through the shared SDK `<Popover>`
 * primitive (B-2) — no bespoke `.modal` chrome. Confirm (delete),
 * name-collision, move-cycle, the New menu, and the Folder appearance
 * editor (shared `<IconPicker>` / `<CoverPicker>`).
 */

import type { Cover, Icon as IconValue } from "@brainstorm/sdk-types";
import { CoverPicker, type CoverPickerService } from "@brainstorm/sdk/cover-picker";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { IconPicker } from "@brainstorm/sdk/icon-picker";
import { Popover, PopoverSize } from "@brainstorm/sdk/popover";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type { DestinationFolder } from "../logic/destination-folders";
import { GroupKey } from "../logic/group";
import { ALL_LIST_COLUMNS, ListColumn } from "../logic/list-columns";
import { SortDirection, SortKey } from "../logic/sort";
import { TILE_SIZES, TileSize } from "../view-mode";

/** Inert cover service: when the host runtime doesn't expose
 *  `services.covers` (read-only preview path), the picker still works —
 *  it degrades to the gradient/colour tabs (no library/upload). */
const NO_COVER_SERVICE: CoverPickerService = {
	uploadBytes: () => Promise.reject(new Error("covers service unavailable in this context")),
	list: () => Promise.resolve([]),
};

export type ConfirmDialogProps = {
	title: string;
	body: string;
	confirm: string;
	cancel: string;
	danger?: boolean;
	/** When set, the dialog is acknowledge-only: a single OK button that just
	 *  dismisses (no actionable confirm/cancel split). Used for the
	 *  move-cycle notice, which has nothing to confirm. */
	acknowledge?: boolean;
	onConfirm: () => void;
	onClose: () => void;
};

export function ConfirmDialog({
	title,
	body,
	confirm,
	cancel,
	danger,
	acknowledge,
	onConfirm,
	onClose,
}: ConfirmDialogProps) {
	return (
		<Popover
			title={title}
			onClose={onClose}
			size={PopoverSize.Small}
			testId="confirm-dialog"
			footer={
				<div className="modal__actions">
					{acknowledge ? null : (
						<button
							type="button"
							className="bs-btn bs-btn--neutral"
							data-testid="confirm-cancel"
							onClick={onClose}
						>
							{cancel}
						</button>
					)}
					<button
						type="button"
						className={danger ? "bs-btn bs-btn--danger" : "bs-btn"}
						data-bs-primary={danger ? undefined : ""}
						data-testid="confirm-ok"
						onClick={() => {
							onClose();
							if (!acknowledge) onConfirm();
						}}
					>
						{confirm}
					</button>
				</div>
			}
		>
			<p className="modal__body">{body}</p>
		</Popover>
	);
}

function sortMenuLabel(key: SortKey): string {
	if (key === SortKey.Name) return t("brainstorm.files.sort.name");
	if (key === SortKey.Modified) return t("brainstorm.files.sort.modified");
	if (key === SortKey.Created) return t("brainstorm.files.sort.created");
	if (key === SortKey.Size) return t("brainstorm.files.sort.size");
	return t("brainstorm.files.sort.manual");
}

const SORT_ENTRY_ORDER: ReadonlyArray<SortKey> = [
	SortKey.Manual,
	SortKey.Name,
	SortKey.Modified,
	SortKey.Created,
	SortKey.Size,
];

function groupMenuLabel(key: GroupKey): string {
	if (key === GroupKey.Type) return t("brainstorm.files.group.type");
	if (key === GroupKey.FirstLetter) return t("brainstorm.files.group.letter");
	if (key === GroupKey.Month) return t("brainstorm.files.group.month");
	return t("brainstorm.files.group.none");
}

const GROUP_ENTRY_ORDER: ReadonlyArray<GroupKey> = [
	GroupKey.None,
	GroupKey.Type,
	GroupKey.FirstLetter,
	GroupKey.Month,
];

function tileSizeLabel(size: TileSize): string {
	if (size === TileSize.Small) return t("brainstorm.files.tileSize.small");
	if (size === TileSize.Large) return t("brainstorm.files.tileSize.large");
	return t("brainstorm.files.tileSize.medium");
}

function columnLabel(column: ListColumn): string {
	if (column === ListColumn.Kind) return t("brainstorm.files.columns.kind");
	if (column === ListColumn.Size) return t("brainstorm.files.columns.size");
	return t("brainstorm.files.columns.modified");
}

export type SortMenuProps = {
	current: SortKey;
	direction: SortDirection;
	groupKey: GroupKey;
	tileSize: TileSize;
	listColumns: readonly ListColumn[];
	onSelect: (key: SortKey) => void;
	onToggleDirection: () => void;
	onSelectGroup: (key: GroupKey) => void;
	onSelectTileSize: (size: TileSize) => void;
	onToggleColumn: (column: ListColumn) => void;
	/** "Apply to all folders" (9.8.11) — current view options become the
	 *  vault-wide default. */
	onApplyToAll: () => void;
	onClose: () => void;
};

export function SortMenuPopover({
	current,
	direction,
	groupKey,
	tileSize,
	listColumns,
	onSelect,
	onToggleDirection,
	onSelectGroup,
	onSelectTileSize,
	onToggleColumn,
	onApplyToAll,
	onClose,
}: SortMenuProps) {
	return (
		<Popover
			title={t("brainstorm.files.sort.menu")}
			onClose={onClose}
			size={PopoverSize.Small}
			testId="sort-menu"
		>
			<div className="sort-menu__items" role="menu">
				{SORT_ENTRY_ORDER.map((key) => {
					const active = key === current;
					return (
						<button
							key={key}
							type="button"
							role="menuitemradio"
							aria-checked={active}
							data-active={active}
							className="popover__item sort-menu__item"
							data-testid={`sort-${key}`}
							onClick={() => onSelect(key)}
						>
							<span className="sort-menu__check" aria-hidden="true">
								{active ? <Icon name={IconName.CheckCircle} size={14} /> : null}
							</span>
							<span>{sortMenuLabel(key)}</span>
						</button>
					);
				})}
				<div className="sort-menu__divider" role="separator" tabIndex={0} />
				<button
					type="button"
					role="menuitem"
					className="popover__item sort-menu__item"
					data-testid="sort-toggle-direction"
					disabled={current === SortKey.Manual}
					onClick={() => {
						if (current === SortKey.Manual) return;
						onToggleDirection();
					}}
				>
					<span className="sort-menu__check" aria-hidden="true" />
					<span>
						{direction === SortDirection.Asc
							? t("brainstorm.files.sort.directionAsc")
							: t("brainstorm.files.sort.directionDesc")}
					</span>
				</button>
				<div className="sort-menu__divider" role="separator" tabIndex={0} />
				<div className="sort-menu__heading" role="presentation">
					{t("brainstorm.files.group.label")}
				</div>
				{GROUP_ENTRY_ORDER.map((key) => {
					const active = key === groupKey;
					return (
						<button
							key={key}
							type="button"
							role="menuitemradio"
							aria-checked={active}
							data-active={active}
							className="popover__item sort-menu__item"
							data-testid={`group-${key}`}
							onClick={() => onSelectGroup(key)}
						>
							<span className="sort-menu__check" aria-hidden="true">
								{active ? <Icon name={IconName.CheckCircle} size={14} /> : null}
							</span>
							<span>{groupMenuLabel(key)}</span>
						</button>
					);
				})}
				<div className="sort-menu__divider" role="separator" tabIndex={0} />
				<div className="sort-menu__heading" role="presentation">
					{t("brainstorm.files.tileSize.label")}
				</div>
				{TILE_SIZES.map((size) => {
					const active = size === tileSize;
					return (
						<button
							key={size}
							type="button"
							role="menuitemradio"
							aria-checked={active}
							data-active={active}
							className="popover__item sort-menu__item"
							data-testid={`tile-size-${size}`}
							onClick={() => onSelectTileSize(size)}
						>
							<span className="sort-menu__check" aria-hidden="true">
								{active ? <Icon name={IconName.CheckCircle} size={14} /> : null}
							</span>
							<span>{tileSizeLabel(size)}</span>
						</button>
					);
				})}
				<div className="sort-menu__divider" role="separator" tabIndex={0} />
				<div className="sort-menu__heading" role="presentation">
					{t("brainstorm.files.columns.label")}
				</div>
				{ALL_LIST_COLUMNS.map((column) => {
					const active = listColumns.includes(column);
					return (
						<button
							key={column}
							type="button"
							role="menuitemcheckbox"
							aria-checked={active}
							data-active={active}
							className="popover__item sort-menu__item"
							data-testid={`column-${column}`}
							onClick={() => onToggleColumn(column)}
						>
							<span className="sort-menu__check" aria-hidden="true">
								{active ? <Icon name={IconName.CheckCircle} size={14} /> : null}
							</span>
							<span>{columnLabel(column)}</span>
						</button>
					);
				})}
				<div className="sort-menu__divider" role="separator" tabIndex={0} />
				<button
					type="button"
					role="menuitem"
					className="popover__item sort-menu__item"
					data-testid="view-apply-all"
					onClick={onApplyToAll}
				>
					<span className="sort-menu__check" aria-hidden="true" />
					<span>{t("brainstorm.files.view.applyToAll")}</span>
				</button>
			</div>
		</Popover>
	);
}

export enum AppearanceTarget {
	Icon = "icon",
	Cover = "cover",
}

export type FolderAppearanceProps = {
	target: AppearanceTarget;
	icon: IconValue | null;
	cover: Cover | null;
	covers: CoverPickerService | undefined;
	onChangeIcon: (icon: IconValue | null) => void;
	onChangeCover: (cover: Cover | null) => void;
	onClose: () => void;
};

export function FolderAppearanceDialog({
	target,
	icon,
	cover,
	covers,
	onChangeIcon,
	onChangeCover,
	onClose,
}: FolderAppearanceProps) {
	return (
		<Popover
			title={
				target === AppearanceTarget.Icon
					? t("brainstorm.files.appearance.editIcon")
					: t("brainstorm.files.appearance.editCover")
			}
			onClose={onClose}
			size={PopoverSize.Medium}
			testId="folder-appearance"
		>
			{target === AppearanceTarget.Icon ? (
				<IconPicker value={icon} onChange={(next) => onChangeIcon(next)} onClose={onClose} />
			) : (
				<CoverPicker
					value={cover}
					onChange={(next) => onChangeCover(next)}
					onClose={onClose}
					covers={covers ?? NO_COVER_SERVICE}
				/>
			)}
		</Popover>
	);
}

/** Which bulk destination op the picker serves (9.8.12). */
/** Bulk Move/Copy destination mode. The picker itself is the shared searchable
 *  `openSearchPicker` (anchored to the toolbar button) — see `app.tsx`. */
export enum BulkDestinationMode {
	Move = "move",
	Copy = "copy",
}

export type BulkRenameProps = {
	count: number;
	onSubmit: (base: string) => void;
	onClose: () => void;
};

/** Multi-item rename (9.8.12): one base name, applied as "base 1", "base 2",
 *  … in visible order, extensions preserved (see `bulkRenamePlan`). */
export function BulkRenamePopover({ count, onSubmit, onClose }: BulkRenameProps) {
	const [base, setBase] = useState("");
	// Focus via ref-on-mount (the RenameInput pattern) — `autoFocus` is
	// rejected by the a11y lint and the popover manages restore-on-close.
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		inputRef.current?.focus();
	}, []);
	const trimmed = base.trim();
	return (
		<Popover
			title={t("brainstorm.files.bulk.renameTitle", { n: count })}
			onClose={onClose}
			size={PopoverSize.Small}
			testId="bulk-rename"
		>
			<form
				className="bulk-rename__form"
				onSubmit={(e) => {
					e.preventDefault();
					if (trimmed.length === 0) return;
					onSubmit(trimmed);
				}}
			>
				<input
					ref={inputRef}
					className="bs-input bulk-rename__input"
					value={base}
					onChange={(e) => setBase(e.target.value)}
					placeholder={t("brainstorm.files.bulk.renamePlaceholder")}
					aria-label={t("brainstorm.files.bulk.renamePlaceholder")}
				/>
				<p className="bulk-rename__preview">
					{trimmed.length > 0
						? t("brainstorm.files.bulk.renamePreview", { example: `${trimmed} 1` })
						: "\u00a0"}
				</p>
				<button
					type="submit"
					className="bs-btn bulk-rename__submit"
					data-bs-primary=""
					disabled={trimmed.length === 0}
					data-testid="bulk-rename-submit"
				>
					{t("brainstorm.files.bulk.renameApply")}
				</button>
			</form>
		</Popover>
	);
}

export type SmartFolderNameProps = {
	title: string;
	initialName: string;
	placeholder: string;
	submitLabel: string;
	onSubmit: (name: string) => void;
	onClose: () => void;
};

/** Name input for saving a search as a smart folder, and for renaming one
 *  (9.8.9). A blank submit is allowed for the save flow — the store falls
 *  back to the query string — so the action is never dead. */
export function SmartFolderNamePopover({
	title,
	initialName,
	placeholder,
	submitLabel,
	onSubmit,
	onClose,
}: SmartFolderNameProps) {
	const [name, setName] = useState(initialName);
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);
	return (
		<Popover title={title} onClose={onClose} size={PopoverSize.Small} testId="smart-folder-name">
			<form
				className="smart-folder-name__form"
				onSubmit={(e) => {
					e.preventDefault();
					onClose();
					onSubmit(name);
				}}
			>
				<input
					ref={inputRef}
					className="bs-input smart-folder-name__input"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder={placeholder}
					aria-label={placeholder}
					data-testid="smart-folder-name-input"
				/>
				<button
					type="submit"
					className="bs-btn smart-folder-name__submit"
					data-bs-primary=""
					data-testid="smart-folder-name-submit"
				>
					{submitLabel}
				</button>
			</form>
		</Popover>
	);
}
