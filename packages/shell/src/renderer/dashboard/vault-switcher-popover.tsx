/**
 * Vault-switcher popover — `Cmd/Ctrl+Shift+V` overlay that lists every
 * known vault and activates one with a single click / `Enter`. Built on
 * the shared `<Popover>` primitive so chrome stays consistent with the
 * vault-info popover next door.
 *
 * Activating the already-current vault is a no-op (it just dismisses). The
 * footer carries `Open another vault…` so the picker is also the entry
 * point for vaults not yet in the registry.
 */

import { Orientation, useCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VaultEntry } from "../../preload";
import { t } from "../i18n/t";
import { Icon, IconName } from "../ui/icon";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";

export type VaultSwitcherPopoverProps = {
	current: VaultEntry | null;
	vaults: readonly VaultEntry[];
	/** Vaults found on disk that the registry has forgotten — doc 28's "Vault
	 *  registry corrupted" recovery (12.8). Offered as an "Add back" section
	 *  below the list; empty/omitted in the normal case. */
	recovered?: readonly VaultEntry[];
	onActivate: (id: string) => void;
	/** Re-register + open a recovered vault by its on-disk path. */
	onAddBack?: (path: string) => void;
	onOpenAnother: () => void;
	onClose: () => void;
};

/** Sort by most-recently-opened first. The current vault sits among the
 *  list (with a "Current" badge) rather than getting its own pinned row —
 *  the picker is for switching *away*, and surfacing it alongside the
 *  others keeps the keyboard cursor predictable. */
export function sortVaultsByLastOpened(vaults: readonly VaultEntry[]): VaultEntry[] {
	return [...vaults].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/** Pick the initial cursor position: first non-current vault in the
 *  sorted list, so pressing `Enter` immediately switches without an arrow
 *  press. Falls back to index 0 (no current, or every entry is current
 *  somehow). Returns `-1` when there are no vaults at all. */
export function initialSelectionIndex(
	sorted: readonly VaultEntry[],
	currentId: string | null,
): number {
	if (sorted.length === 0) return -1;
	if (!currentId) return 0;
	const idx = sorted.findIndex((v) => v.id !== currentId);
	return idx === -1 ? 0 : idx;
}

export function VaultSwitcherPopover({
	current,
	vaults,
	recovered,
	onActivate,
	onAddBack,
	onOpenAnother,
	onClose,
}: VaultSwitcherPopoverProps) {
	const sorted = useMemo(() => sortVaultsByLastOpened(vaults), [vaults]);
	const initialIndex = useMemo(
		() => initialSelectionIndex(sorted, current?.id ?? null),
		[sorted, current],
	);

	const [selected, setSelected] = useState(initialIndex);

	useEffect(() => {
		setSelected(initialIndex);
	}, [initialIndex]);

	const activateIndex = useCallback(
		(index: number) => {
			const target = sorted[index];
			if (!target) return;
			if (current && target.id === current.id) {
				onClose();
				return;
			}
			onActivate(target.id);
			onClose();
		},
		[sorted, current, onActivate, onClose],
	);

	// KBN-S-vault-switcher: the list is a vertical composite listbox — ↑/↓ move
	// the cursor (selection follows focus), Home/End jump to the ends, type-ahead
	// matches a vault by name, Enter/Space activate. The hook owns roving
	// `tabindex`, the `listbox`/`option` roles, `aria-selected`, and focusing the
	// active row; the shared `<Popover>` already supplies the focus trap (KBN-S-
	// popover). Every row is selectable (activating the current vault is a no-op
	// close), so there are no disabled indices.
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Vertical,
		count: sorted.length,
		activeIndex: selected,
		onActiveIndexChange: setSelected,
		onActivate: activateIndex,
		typeahead: (i) => sorted[i]?.name ?? "",
	});

	// Merge the hook's container ref with a local one so we can move focus onto
	// the list on open. The shared <Popover> focus-trap lands on its close button
	// first; this parent effect runs after the child Popover's trap effect, so
	// focusing the list here wins — ↑/↓ drive the list immediately on open
	// (parity with the old always-on `shell/list.*` chords).
	const listRef = useRef<HTMLDivElement | null>(null);
	const setListRef = useCallback(
		(el: HTMLDivElement | null) => {
			containerProps.ref(el);
			listRef.current = el;
		},
		[containerProps.ref],
	);
	useEffect(() => {
		listRef.current?.focus();
	}, []);

	const hasResults = sorted.length > 0;

	return (
		<Popover
			title={t("shell.dashboard.vaultSwitcher.title")}
			size={PopoverSize.Medium}
			bodyPadding={PopoverBodyPadding.Compact}
			onClose={onClose}
			testId="vault-switcher"
			footer={
				<div className="vault-switcher__footer">
					<button
						type="button"
						className="vault-switcher__footer-button"
						onClick={() => {
							onOpenAnother();
							onClose();
						}}
					>
						<Icon name={IconName.Folder} />
						<span>{t("shell.dashboard.vaultSwitcher.openOther")}</span>
					</button>
				</div>
			}
		>
			{hasResults ? (
				<div
					{...containerProps}
					ref={setListRef}
					className="vault-switcher__list"
					aria-label={t("shell.dashboard.vaultSwitcher.title")}
				>
					{sorted.map((vault, index) => {
						const isCurrent = current?.id === vault.id;
						const isSelected = index === selected;
						const className = [
							"vault-switcher__row",
							isSelected ? "vault-switcher__row--selected" : "",
							isCurrent ? "vault-switcher__row--current" : "",
						]
							.filter(Boolean)
							.join(" ");
						return (
							<button
								key={vault.id}
								type="button"
								{...getItemProps(index)}
								className={className}
								onMouseEnter={() => setSelected(index)}
								onClick={() => activateIndex(index)}
							>
								<span
									className="vault-switcher__swatch"
									style={{ background: vault.color }}
									aria-hidden="true"
								/>
								<span className="vault-switcher__row-text">
									<span className="vault-switcher__name" title={vault.name}>
										{vault.name}
									</span>
									<span className="vault-switcher__path" title={vault.path}>
										{vault.path}
									</span>
								</span>
								{isCurrent && (
									<span className="vault-switcher__badge">
										<Icon name={IconName.CheckCircle} />
										<span>{t("shell.dashboard.vaultSwitcher.activeBadge")}</span>
									</span>
								)}
							</button>
						);
					})}
				</div>
			) : (
				<p className="vault-switcher__empty">{t("shell.dashboard.vaultSwitcher.empty")}</p>
			)}
			{recovered && recovered.length > 0 && onAddBack ? (
				<div className="vault-switcher__recovered">
					<p className="vault-switcher__recovered-heading">
						{t("shell.dashboard.vaultSwitcher.recoveredHeading")}
					</p>
					{recovered.map((vault) => (
						<div key={vault.id} className="vault-switcher__recovered-row">
							<span
								className="vault-switcher__swatch"
								style={{ background: vault.color }}
								aria-hidden="true"
							/>
							<span className="vault-switcher__row-text">
								<span className="vault-switcher__name" title={vault.name}>
									{vault.name}
								</span>
								<span className="vault-switcher__path" title={vault.path}>
									{vault.path}
								</span>
							</span>
							<button
								type="button"
								className="vault-switcher__add-back"
								onClick={() => onAddBack(vault.path)}
							>
								<Icon name={IconName.Plus} />
								<span>{t("shell.dashboard.vaultSwitcher.recoveredAddBack")}</span>
							</button>
						</div>
					))}
				</div>
			) : null}
		</Popover>
	);
}
