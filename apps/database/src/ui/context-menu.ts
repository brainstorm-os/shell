/**
 * Database's point-anchored menus (sidebar list / view-tab / filter-builder
 * right-clicks) render through the SHARED SDK anchored menu — the same
 * glass popup the cross-app object menu uses. This file is now a 1:1
 * adapter (Database's historical `{label,onClick}` item shape → the SDK's
 * `{label,onSelect}` row), not a forked renderer: one menu implementation,
 * many call sites. The object menu itself goes straight through
 * `openObjectMenu`; these are Database's app-specific menus.
 */

import type { IconName } from "@brainstorm-os/sdk/icon";
import {
	type AnchoredMenuItem,
	closeAnchoredMenu,
	openAnchoredMenu,
} from "@brainstorm-os/sdk/object-menu";

export type MenuItem = {
	label: string;
	onClick: () => void;
	/** Optional leading glyph — paints the same row icon the shared object /
	 *  export menus use, so Database's action menus read consistently. */
	icon?: IconName;
	destructive?: boolean;
	disabled?: boolean;
	/** Tooltip explaining a `disabled` row. */
	hint?: string;
};

const DATABASE_MENU_LABEL = "Database menu";

export function closeContextMenu(): void {
	closeAnchoredMenu();
}

/** @param anchor When the menu drops from a button (not a right-click), pass
 *  the trigger element: the menu then right-aligns to its edge and the button
 *  shows its open/active state. Omit for cursor-anchored (right-click) menus. */
export function openContextMenu(
	point: { x: number; y: number },
	items: MenuItem[],
	anchor?: HTMLElement,
): void {
	const rows: AnchoredMenuItem[] = items.map((it) => ({
		label: it.label,
		onSelect: it.onClick,
		destructive: it.destructive ?? false,
		disabled: it.disabled ?? false,
		...(it.icon ? { icon: it.icon } : {}),
		...(it.hint ? { hint: it.hint } : {}),
	}));
	openAnchoredMenu(point, rows, {
		menuLabel: DATABASE_MENU_LABEL,
		...(anchor ? { anchor } : {}),
	});
}
