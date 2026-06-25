/**
 * Bin overlay — privileged shell view (Stage 9.19). Soft-deleted objects
 * from every app collect here; the user restores them or deletes them
 * for good. Shell-internal by design (OQ-BIN-1) — restore/purge write
 * back across app data spaces, which a sandboxed app can't do.
 *
 * Chrome mirrors the Marketplace / Settings overlays (backdrop + spring
 * panel + 44px header) so cross-overlay muscle memory and the panel-
 * header baseline carry over. Destructive actions (delete-forever,
 * empty-bin) route through the shared `confirm()` primitive.
 */

import { Orientation, useCompositeKeyboard, useFocusTrap } from "@brainstorm/sdk/a11y";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShellSurfaceId, shellSurfacePinIconId } from "../dashboard/shell-surfaces";
import { t } from "../i18n/t";
import { Button, ButtonVariant } from "../ui/button";
import { Checkbox, CheckboxGlyph } from "../ui/checkbox";
import { ConfirmVariant, confirm } from "../ui/confirm";
import { EntityIcon } from "../ui/entity-icon";
import { Icon, IconName } from "../ui/icon";
import { IconButton, IconButtonSize } from "../ui/icon-button";
import { ToastKind, pushToast } from "../ui/toasts";
import { useBin } from "./use-bin";
import "./bin.css";

export type BinProps = {
	onClose: () => void;
};

/** Local one-shot relative-time label ("2 hours ago"). Not a shared
 *  helper — single use, per the no-abstraction-without-three-uses rule;
 *  promote if a second surface needs it. */
function deletedWhen(at: number): string {
	const diffMs = Date.now() - at;
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
		["year", 31_536_000_000],
		["month", 2_592_000_000],
		["day", 86_400_000],
		["hour", 3_600_000],
		["minute", 60_000],
	];
	for (const [unit, ms] of units) {
		if (Math.abs(diffMs) >= ms) return rtf.format(-Math.round(diffMs / ms), unit);
	}
	return rtf.format(-Math.round(diffMs / 1000), "second");
}

/** Fixed row pitch — sized a few px above the rendered row's content height
 *  (a 20px EntityIcon next to a `--text-size-md` name + `--text-size-sm` meta
 *  line, `--space-0_5` apart, inside `--space-2` vertical padding ≈ 52px) so a
 *  small gap separates rows. Pinned by visual inspection on the live shell; if
 *  the row layout changes, re-measure. */
const BIN_ROW_HEIGHT = 56;

export function Bin({ onClose }: BinProps) {
	const { items, loading, restore, purge, restoreMany, purgeMany, empty } = useBin();
	const [busyId, setBusyId] = useState<string | null>(null);
	const [selected, setSelected] = useState(0);
	// Multi-select set, keyed by entity id so it survives re-indexing as rows
	// restore / purge out from under it (the cursor is the separate `selected`).
	const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(() => new Set());
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const listRef = useRef<HTMLUListElement | null>(null);

	// 9.19.2 — the Bin can be pinned to the dashboard as a shell-surface
	// tile (a preset over the 7.13 pin mechanism). Reuses the existing
	// privileged `dashboard:*` icon API; no new IPC/capability.
	const pinId = shellSurfacePinIconId(ShellSurfaceId.Bin);
	const [pinned, setPinned] = useState(false);
	useEffect(() => {
		let live = true;
		void window.brainstorm.dashboard.snapshot().then((snap) => {
			if (live) setPinned(snap?.icons[pinId]?.kind === "shell-surface");
		});
		return () => {
			live = false;
		};
	}, [pinId]);
	const togglePin = useCallback(async () => {
		if (pinned) {
			await window.brainstorm.dashboard.removeIcon(pinId);
			setPinned(false);
			return;
		}
		// {0,0} is a deterministic seed; the dashboard's collision layer
		// repositions onto the first free cell on display (the same
		// guarantee 7.13 entity pins rely on).
		await window.brainstorm.dashboard.upsertIcon(pinId, {
			x: 0,
			y: 0,
			kind: "shell-surface",
			target: ShellSurfaceId.Bin,
			label: t("shell.bin.title"),
		});
		setPinned(true);
	}, [pinned, pinId]);

	const count = items?.length ?? 0;

	const virtualizer = useVirtualizer({
		count,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => BIN_ROW_HEIGHT,
		getItemKey: (index) => items?.[index]?.id ?? index,
		overscan: 8,
	});

	// Keep the keyboard cursor in range as items restore/purge out from under it.
	useEffect(() => {
		setSelected((prev) => (count === 0 ? -1 : Math.min(Math.max(prev, 0), count - 1)));
	}, [count]);

	// Drop checked ids that have left the Bin (restored / purged elsewhere) so a
	// stale id can't linger in the selection or skew the count.
	useEffect(() => {
		if (!items) return;
		setCheckedIds((prev) => {
			if (prev.size === 0) return prev;
			const live = new Set<string>();
			for (const item of items) if (prev.has(item.id)) live.add(item.id);
			return live.size === prev.size ? prev : live;
		});
	}, [items]);

	// Indices feed the listbox's `aria-selected`; the id-keyed set is the source
	// of truth. `checkedItems` is the present, ordered selection for batch verbs.
	const selectedIndices = useMemo(() => {
		const set = new Set<number>();
		if (items) items.forEach((item, index) => checkedIds.has(item.id) && set.add(index));
		return set;
	}, [items, checkedIds]);
	const checkedItems = useMemo(
		() => (items ?? []).filter((item) => checkedIds.has(item.id)),
		[items, checkedIds],
	);
	const checkedCount = checkedItems.length;
	const allChecked = count > 0 && checkedCount === count;
	const someChecked = checkedCount > 0 && checkedCount < count;

	const toggleChecked = useCallback((id: string) => {
		setCheckedIds((prev) => {
			const next = new Set(prev);
			next.has(id) ? next.delete(id) : next.add(id);
			return next;
		});
	}, []);
	const toggleCheckedIndex = useCallback(
		(index: number) => {
			const item = items?.[index];
			if (item) toggleChecked(item.id);
		},
		[items, toggleChecked],
	);
	const clearChecked = useCallback(() => setCheckedIds(new Set()), []);
	const toggleAll = useCallback(() => {
		setCheckedIds((prev) =>
			items && prev.size < items.length ? new Set(items.map((item) => item.id)) : new Set(),
		);
	}, [items]);

	const onRestore = useCallback(
		async (id: string, title: string) => {
			setBusyId(id);
			try {
				if (await restore(id)) {
					pushToast({
						kind: ToastKind.Success,
						title: t("shell.bin.restoredToast.title"),
						body: t("shell.bin.restoredToast.body", { title }),
					});
				}
			} finally {
				setBusyId(null);
			}
		},
		[restore],
	);

	const onPurge = useCallback(
		async (id: string, title: string) => {
			const accepted = await confirm({
				title: t("shell.bin.purgeConfirm.title", { title }),
				body: t("shell.bin.purgeConfirm.body", { title }),
				confirmLabel: t("shell.bin.purge"),
				confirmVariant: ConfirmVariant.Destructive,
			});
			if (!accepted) return;
			setBusyId(id);
			try {
				if (await purge(id)) {
					pushToast({
						kind: ToastKind.Success,
						title: t("shell.bin.purgedToast.title"),
						body: title,
					});
				}
			} finally {
				setBusyId(null);
			}
		},
		[purge],
	);

	const onEmpty = async () => {
		const accepted = await confirm({
			title: t("shell.bin.emptyConfirm.title"),
			body: t("shell.bin.emptyConfirm.body", { count }),
			confirmLabel: t("shell.bin.emptyBin"),
			confirmVariant: ConfirmVariant.Destructive,
		});
		if (!accepted) return;
		const purged = await empty();
		if (purged > 0) {
			pushToast({
				kind: ToastKind.Success,
				title: t("shell.bin.emptiedToast.title"),
				body: t("shell.bin.emptiedToast.body", { count: purged }),
			});
		}
	};

	const onRestoreChecked = useCallback(async () => {
		const ids = checkedItems.map((item) => item.id);
		if (ids.length === 0) return;
		const restored = await restoreMany(ids);
		clearChecked();
		if (restored > 0) {
			pushToast({
				kind: ToastKind.Success,
				title: t("shell.bin.restoredManyToast.title"),
				body: t("shell.bin.restoredManyToast.body", { count: restored }),
			});
		}
	}, [checkedItems, restoreMany, clearChecked]);

	const onPurgeChecked = useCallback(async () => {
		const ids = checkedItems.map((item) => item.id);
		if (ids.length === 0) return;
		const accepted = await confirm({
			title: t("shell.bin.purgeManyConfirm.title", { count: ids.length }),
			body: t("shell.bin.purgeManyConfirm.body", { count: ids.length }),
			confirmLabel: t("shell.bin.purge"),
			confirmVariant: ConfirmVariant.Destructive,
		});
		if (!accepted) return;
		const purged = await purgeMany(ids);
		clearChecked();
		if (purged > 0) {
			pushToast({
				kind: ToastKind.Success,
				title: t("shell.bin.purgedManyToast.title"),
				body: t("shell.bin.purgedManyToast.body", { count: purged }),
			});
		}
	}, [checkedItems, purgeMany, clearChecked]);

	// KBN-S-bin: trap focus inside the overlay (hand-rolled aria-modal, like
	// Settings / Marketplace) and restore to the opener on close. Escape rides the
	// trap's shared stack (replaces the old useEscapeStackEntry).
	const [opener] = useState<HTMLElement | null>(() => {
		if (typeof document === "undefined") return null;
		return (document.activeElement as HTMLElement | null) ?? null;
	});
	const { containerProps: trapProps } = useFocusTrap({
		enabled: true,
		onEscape: onClose,
		restoreFocusTo: opener,
		openerLabel: "bin",
	});

	// KBN-S-bin: the deleted-objects list is a virtualized composite listbox.
	// Focus stays on the list container and `aria-activedescendant` points at the
	// active row (rows scroll in/out of the DOM, so roving tabindex can't hold
	// focus). ↑/↓/Home/End move the cursor; Enter restores the active row; Delete /
	// Backspace purges it. The per-row Restore/Purge buttons sit behind the row's
	// cursor (`tabindex -1`) rather than as separate Tab stops, per the rung.
	const restoreSelected = useCallback(
		(index: number) => {
			const item = items?.[index];
			if (item && busyId !== item.id) void onRestore(item.id, item.title);
		},
		[items, busyId, onRestore],
	);
	const purgeSelected = useCallback(
		(index: number) => {
			const item = items?.[index];
			if (item && busyId !== item.id) void onPurge(item.id, item.title);
		},
		[items, busyId, onPurge],
	);
	const { containerProps: listProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Vertical,
		count,
		activeIndex: selected,
		onActiveIndexChange: (index) => {
			setSelected(index);
			// Keep the active row rendered so its `aria-activedescendant` target
			// exists and it's visible on keyboard nav. (Scroll-into-view itself is
			// layout-dependent — verified on the perf CI, not jsdom.)
			virtualizer.scrollToIndex(index);
		},
		onActivate: restoreSelected,
		// Delete / Backspace purges the active row — the hook owns the raw key so
		// this surface stays `e.key`-free.
		onDelete: purgeSelected,
		useAriaActiveDescendant: true,
		// Multi-select: Space toggles the active row's checkbox; the listbox is
		// `aria-multiselectable` and each row's `aria-selected` tracks the set.
		multiselectable: true,
		selectedIndices,
		onToggleSelect: toggleCheckedIndex,
	});

	// Merge the hook's container ref with a local one so we can focus the list on
	// open (the trap lands on the header pin button first; this parent effect runs
	// after the trap's, so focusing the list here wins — arrows work immediately).
	const setListRef = useCallback(
		(el: HTMLUListElement | null) => {
			listProps.ref(el);
			listRef.current = el;
		},
		[listProps.ref],
	);
	// Focus the list the first time it renders (items arrive async, so a
	// mount-only effect would fire while the list is still absent). `loading`
	// flips false once `useBin` has the items; guard so we focus exactly once
	// and don't steal focus back on every later count change (restore/purge).
	const focusedListRef = useRef(false);
	useEffect(() => {
		if (focusedListRef.current) return;
		if (!loading && count > 0) {
			listRef.current?.focus();
			focusedListRef.current = true;
		}
	}, [loading, count]);

	return (
		<div
			className="bin"
			role="dialog"
			aria-modal="true"
			aria-labelledby="bin-title"
			data-testid="bin"
		>
			<motion.button
				type="button"
				className="bin__backdrop"
				onClick={onClose}
				aria-label={t("shell.actions.close")}
				tabIndex={-1}
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				exit={{ opacity: 0 }}
				transition={{ duration: 0.18, ease: "easeOut" }}
			/>
			<motion.div
				{...trapProps}
				className="bin__panel glass--strong"
				initial={{ opacity: 0, y: 12 }}
				animate={{ opacity: 1, y: 0 }}
				exit={{ opacity: 0, y: 12 }}
				transition={{ type: "spring", stiffness: 340, damping: 32 }}
			>
				<header className="bin__header">
					<div className="bin__header-titles">
						{count > 0 ? (
							<Checkbox
								checked={allChecked}
								indeterminate={someChecked}
								onChange={toggleAll}
								ariaLabel={t("shell.bin.selectAll")}
							/>
						) : null}
						<h2 id="bin-title" className="bin__title">
							{t("shell.bin.title")}
						</h2>
						{count > 0 ? (
							<span className="bin__count" aria-label={t("shell.bin.count", { count })}>
								{count}
							</span>
						) : null}
					</div>
					<div className="bin__header-actions">
						<IconButton
							icon={pinned ? IconName.Unpin : IconName.Pin}
							label={pinned ? t("shell.bin.unpinFromDashboard") : t("shell.bin.pinToDashboard")}
							onClick={togglePin}
							pressed={pinned}
							size={IconButtonSize.Md}
						/>
						<IconButton
							icon={IconName.Close}
							label={t("shell.actions.close")}
							onClick={onClose}
							size={IconButtonSize.Md}
						/>
					</div>
				</header>
				<div className="bin__body" ref={scrollRef}>
					{loading ? (
						<p className="bin__state">{t("shell.common.loading")}</p>
					) : count === 0 ? (
						<div className="bin__empty">
							<span className="bin__empty-glyph" aria-hidden="true">
								<Icon name={IconName.Trash} size={36} />
							</span>
							<p className="bin__empty-title">{t("shell.bin.empty")}</p>
							<p className="bin__empty-hint">{t("shell.bin.emptyHint")}</p>
						</div>
					) : (
						<ul
							{...listProps}
							ref={setListRef}
							className="bin__list"
							aria-label={t("shell.bin.title")}
							style={{ height: virtualizer.getTotalSize() }}
						>
							{virtualizer.getVirtualItems().map((row) => {
								const item = items?.[row.index];
								if (!item) return null;
								const place = {
									height: row.size,
									transform: `translateY(${row.start}px)`,
								} as const;
								const isChecked = checkedIds.has(item.id);
								return (
									<li
										key={row.key}
										{...getItemProps(row.index)}
										className={isChecked ? "bin__row bin__row--checked" : "bin__row"}
										style={place}
									>
										{/* Decorative selection mirror — the row owns the accessible name + selection; this button is aria-hidden + tabIndex=-1 (mouse convenience only), so the a11y audit exempts it automatically. */}
										<button
											type="button"
											className="bin__row-check"
											aria-hidden="true"
											tabIndex={-1}
											onClick={(event) => {
												event.stopPropagation();
												toggleChecked(item.id);
											}}
										>
											<CheckboxGlyph checked={isChecked} />
										</button>
										<EntityIcon icon={item.icon} size={20} className="bin__row-icon" />
										<div className="bin__row-text">
											<span className="bin__row-title" title={item.title}>
												{item.title}
											</span>
											<span className="bin__row-meta">
												{t("shell.bin.deletedAt", { when: deletedWhen(item.deletedAt) })}
											</span>
										</div>
										<div className="bin__row-actions">
											<IconButton
												icon={IconName.Restore}
												label={t("shell.bin.restoreAria", { title: item.title })}
												onClick={() => onRestore(item.id, item.title)}
												disabled={busyId === item.id}
												tabIndex={-1}
											/>
											<IconButton
												icon={IconName.Trash}
												label={t("shell.bin.purgeAria", { title: item.title })}
												onClick={() => onPurge(item.id, item.title)}
												disabled={busyId === item.id}
												tabIndex={-1}
											/>
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</div>
				{count > 0 ? (
					<footer className="bin__footer">
						{checkedCount > 0 ? (
							<div className="bin__selection">
								<div className="bin__selection-info">
									<span>{t("shell.bin.selectedCount", { count: checkedCount })}</span>
									<Button variant={ButtonVariant.Ghost} onClick={clearChecked}>
										{t("shell.bin.clearSelection")}
									</Button>
								</div>
								<div className="bin__selection-actions">
									<Button
										variant={ButtonVariant.Ghost}
										iconLeft={IconName.Restore}
										onClick={onRestoreChecked}
									>
										{t("shell.bin.restore")}
									</Button>
									<Button variant={ButtonVariant.Ghost} iconLeft={IconName.Trash} onClick={onPurgeChecked}>
										{t("shell.bin.purge")}
									</Button>
								</div>
							</div>
						) : (
							<Button variant={ButtonVariant.Ghost} iconLeft={IconName.Trash} onClick={onEmpty}>
								{t("shell.bin.emptyBin")}
							</Button>
						)}
					</footer>
				) : null}
			</motion.div>
		</div>
	);
}
