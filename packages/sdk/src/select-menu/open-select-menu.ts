/**
 * `openSelectMenu` — the fancy-menus replacement for a native `<select>`
 * popup. Maps a flat option list (with optional `<optgroup>`-style groups)
 * onto the shared context-menu config: the chosen option carries a check
 * glyph + `fm-row--selected`, every other option a blank icon param so the
 * fixed icon column keeps labels aligned (the runtime only renders the
 * `.fm-row__icon` span when an icon is set).
 *
 * Imperative by design, like `openContextMenu`: the trigger controls
 * (`<SelectMenu>` and `createSelectMenu`) call it on click, and plain-DOM
 * apps can call it against any anchor element directly.
 */

import { IconName } from "../icon/icon-registry";
import { type ContextMenuItem, blankMenuIcon, openContextMenu, sdkMenuIcon } from "../menus";

export type SelectMenuOption<T extends string = string> = {
	value: T;
	label: string;
	disabled?: boolean;
	/** Section heading drawn above this option — the `<optgroup>` analogue.
	 *  Consecutive options sharing a `group` render under one heading. */
	group?: string;
};

export type OpenSelectMenuParams<T extends string> = {
	/** The trigger control the menu drops from (left edges align, like a
	 *  native select popup). */
	anchor: HTMLElement;
	/** Accessible name for the `role="menu"` list — reuse the trigger's
	 *  label so the popup announces as the same control. */
	menuLabel: string;
	options: readonly SelectMenuOption<T>[];
	value: T | null;
	onSelect(next: T): void;
};

/** Open the option list for a select control. Returns false (a no-op) when
 *  no menu host is mounted, mirroring `openContextMenu`. */
/** Readable floor for a select popup — fits "✓ label" for typical option
 *  sets even when the trigger is a short chip. */
const SELECT_MENU_MIN_WIDTH = 200;

export function openSelectMenu<T extends string>(params: OpenSelectMenuParams<T>): boolean {
	const items: ContextMenuItem[] = [];
	let group: string | undefined;
	params.options.forEach((option, index) => {
		if (option.group !== undefined && option.group !== group) {
			items.push({ id: `group:${option.group}`, label: option.group, section: true });
		}
		group = option.group;
		const selected = option.value === params.value;
		items.push({
			id: `option:${index}`,
			label: option.label,
			icon: selected ? sdkMenuIcon(IconName.Check) : blankMenuIcon,
			...(selected ? { selected: true } : {}),
			...(option.disabled === true ? { disabled: true } : {}),
			onSelect: () => params.onSelect(option.value),
		});
	});
	const rect = params.anchor.getBoundingClientRect();
	return openContextMenu({ x: rect.left, y: rect.bottom }, items, {
		menuLabel: params.menuLabel,
		anchor: params.anchor,
		// Never narrower than the trigger — and never narrower than a readable
		// floor either: the runtime's virtualized rows can't grow the surface,
		// so a short trigger ("Gallery ⌄", ~80px) rendered every option label
		// as "G…" (F-406). The surface width IS min-width in practice.
		minWidth: Math.max(rect.width, SELECT_MENU_MIN_WIDTH),
	});
}
