/**
 * `openMultiSelectMenu` — a keep-open, multi-toggle variant of the shared
 * select popup. Where `openSelectMenu` picks ONE option and dismisses, this
 * one lets the user toggle any number of options on/off in a single open
 * pass (the "links to these types" / tag-set case): each click flips the
 * row's check and stays open, the menu closes on Escape / outside-click /
 * re-clicking the trigger.
 *
 * Built on the same fancy-menus runtime as every other menu (no bespoke
 * chrome, per the CLAUDE.md rule): a list body whose rows carry a check
 * glyph when selected; a click toggles selection in place via the runtime's
 * `ctx.updateData`, then reports the new id set to the host.
 */

import { IconName } from "../icon/icon-registry";
import {
	BodyKind,
	DimmerMode,
	type MenuConfig,
	type MenuCtx,
	MenuKind,
	RowKind,
	SourceKind,
	Vertical,
	blankMenuIcon,
	defineMenu,
	getActiveMenuStore,
	sdkMenuIcon,
} from "../menus";

export type MultiSelectMenuOption = {
	id: string;
	label: string;
	disabled?: boolean;
};

export type OpenMultiSelectMenuParams = {
	/** The trigger control the menu drops from (left edges align). */
	anchor: HTMLElement;
	/** Accessible name for the `role="menu"` list — reuse the trigger's label. */
	menuLabel: string;
	options: readonly MultiSelectMenuOption[];
	/** Currently-selected option ids. */
	selected: readonly string[];
	/** Called with the full next selection whenever a row toggles. */
	onChange(next: readonly string[]): void;
};

type MultiRow = {
	id: string;
	label: string;
	selected: boolean;
	disabled: boolean;
};

type MultiSelectMenuData = { rows: MultiRow[] };

const MULTI_SELECT_MENU_ID = "bs/multi-select-menu";
const MENU_GAP = 4;

// The active open menu's host callback + live rows. The config is registered
// once and reused, so per-open state lives here (one multi-select menu is open
// at a time, like the shared context menu).
let activeOnChange: ((next: readonly string[]) => void) | null = null;
let activeRows: MultiRow[] = [];

function selectedIds(rows: readonly MultiRow[]): string[] {
	return rows.filter((r) => r.selected).map((r) => r.id);
}

function toggle(clickedId: string, ctx: MenuCtx): void {
	activeRows = activeRows.map((row) =>
		row.id === clickedId ? { ...row, selected: !row.selected } : row,
	);
	ctx.updateData({ rows: activeRows });
	activeOnChange?.(selectedIds(activeRows));
}

// One config per menu label so the popup's `role="menu"` carries the trigger's
// accessible name (fancy-menus takes a static `chrome.ariaLabel`). A small,
// bounded set, mirroring the shared context-menu's variant map.
const variants = new Map<string, MenuConfig<MultiSelectMenuData>>();

function configFor(menuLabel: string): MenuConfig<MultiSelectMenuData> {
	let config = variants.get(menuLabel);
	if (!config) {
		config = defineMenu<MultiSelectMenuData>({
			id: `${MULTI_SELECT_MENU_ID}:${menuLabel}`,
			kind: MenuKind.Context,
			chrome: { role: "menu", dimmer: DimmerMode.Default, ariaLabel: menuLabel },
			body: {
				kind: BodyKind.List,
				source: { kind: SourceKind.Prop, getItems: (data: MultiSelectMenuData) => data.rows },
				rows: [
					{
						kind: RowKind.Item,
						match: () => true,
						name: (it: MultiRow) => it.label,
						icon: (it: MultiRow) => (it.selected ? sdkMenuIcon(IconName.Check) : blankMenuIcon),
						disabled: (it: MultiRow) => it.disabled,
						className: (it: MultiRow) => (it.selected ? "fm-row--selected" : undefined),
						// A toggle never dismisses — flip the row in place and report the
						// new set, leaving the menu open for the next pick.
						onClick: (it, _e, ctx) => {
							if (it.disabled) return;
							toggle(it.id, ctx);
						},
					},
				],
			},
			position: {
				vertical: Vertical.Bottom,
				offsetY: MENU_GAP,
				followAnchor: false,
			},
			keyboard: { defaults: { closeOnEscape: true, selectOnEnter: true } },
		});
		variants.set(menuLabel, config);
	}
	return config;
}

/** Open the multi-toggle option list for a multi-select control. Returns false
 *  (a no-op) when no menu host is mounted, mirroring `openSelectMenu`. */
export function openMultiSelectMenu(params: OpenMultiSelectMenuParams): boolean {
	const store = getActiveMenuStore();
	if (!store) return false;
	const selectedSet = new Set(params.selected);
	activeRows = params.options.map((option) => ({
		id: option.id,
		label: option.label,
		selected: selectedSet.has(option.id),
		disabled: option.disabled === true,
	}));
	activeOnChange = params.onChange;
	const config = configFor(params.menuLabel);
	if (!store.getConfig(config.id)) store.register(config);
	store.open(config.id, { data: { rows: activeRows }, element: params.anchor });
	return true;
}
