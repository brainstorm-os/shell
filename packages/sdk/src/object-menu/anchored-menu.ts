/**
 * The shared **anchored menu** — a point-anchored popup used by every app's
 * object menu, the graph export menu, and the database column-adder.
 *
 * As of Stage 8.8 this delegates to the fancy-menus runtime via the SDK's
 * imperative `openContextMenu` bridge: when the renderer has a menu host
 * mounted (`mountMenuHost`, or a `<BrainstormMenuProvider>`), the popup is a
 * themed `@react-fancy-menus` context menu — same chrome, keyboard nav,
 * escape-stack nesting, and glass styling as the rest of the shell.
 *
 * When no host is mounted yet (a renderer mid-rollout), it falls back to the
 * original self-contained DOM popup so menus never silently break. The
 * fallback is the no-host safety net, not a parallel design — once every
 * renderer mounts a host it becomes unreachable.
 *
 * The public signature is unchanged, so call sites need no edits.
 */

import { createIconElement } from "../icon/create-icon-element";
import { IconName } from "../icon/icon-registry";
import {
	type ContextMenuItem,
	type IconParam,
	MenuAlign,
	blankMenuIcon,
	closeContextMenu,
	getActiveMenuStore,
	openContextMenu,
	sdkMenuIcon,
} from "../menus";
import { matchesChord } from "../shortcut/chord";
import "./object-menu.css";

const ESCAPE_CHORD = "Escape";
const VIEWPORT_GUTTER = 8;

/** One row in an anchored menu. `icon` paints a leading glyph — pass an SDK
 *  `IconName` (rendered through the shared `<Icon>` / IconPack chrome) OR a
 *  fancy-menus `IconParam` to use a Phosphor component directly (the editor /
 *  whiteboard glyphs that aren't in the SDK registry). Omit for a label-only
 *  row. */
export type AnchoredMenuItem = {
	/** The row label. Optional only for a `divider` (which has no text). */
	label?: string;
	/** Required for action rows; ignored on `section` headings. */
	onSelect?: () => void;
	destructive?: boolean;
	disabled?: boolean;
	/** Tooltip (`title`) — used to explain a `disabled` row. */
	hint?: string;
	icon?: IconName | IconParam;
	/** Mark this row as the current choice in a "pick one of N" group. `true`
	 *  paints a leading check; `false` reserves a blank icon column so every
	 *  label in the group starts at the same x (no ragged edge when only the
	 *  selected row carries a glyph). When set, it owns the icon slot (over
	 *  `icon`); leave undefined for ordinary action rows. */
	selected?: boolean;
	/** Render as a non-interactive section heading (the `label` is the
	 *  heading) — maps straight onto the fancy-menus `RowKind.Section` row
	 *  the context menu already supports. Skipped in keyboard nav. */
	section?: boolean;
	/** Render as a horizontal divider fencing off a logical group (no label,
	 *  no action). Skipped in keyboard nav. */
	divider?: boolean;
	/** Trailing accelerator caption (e.g. "⌘⌫") shown muted on the right.
	 *  Provide only when the action has a real registered shortcut. */
	shortcut?: string;
	/** Nested submenu. When set, the row shows a chevron and opens these
	 *  children to its right on hover — the shared cascade (Diff layout,
	 *  Syntax theme, …). A submenu parent's own `onSelect` never fires. */
	submenu?: AnchoredMenuItem[];
};

export type OpenAnchoredMenuOptions = {
	/** `aria-label` for the `role="menu"` container. */
	menuLabel: string;
	/** The trigger element the menu drops from. When given, the menu anchors
	 *  to its live rect, right-aligns to its edge by default, and the element
	 *  shows its open state while the menu is up. Omit for cursor-anchored
	 *  menus (right-click). */
	anchor?: HTMLElement;
	/** Cross-axis alignment override (defaults to right-edge when an
	 *  `anchor` is given, left-edge for cursor menus). */
	align?: MenuAlign;
};

function toContextItem(item: AnchoredMenuItem, index: number): ContextMenuItem {
	return {
		id: `anchored:${index}`,
		label: item.label ?? "",
		...(item.onSelect ? { onSelect: item.onSelect } : {}),
		...(item.section ? { section: true } : {}),
		...(item.divider ? { divider: true } : {}),
		...(item.shortcut ? { shortcut: item.shortcut } : {}),
		// Children carry the same shape — map them through the same converter so
		// a nested row renders (and can itself nest) exactly like a top-level one.
		...(item.submenu ? { submenu: item.submenu.map(toContextItem) } : {}),
		destructive: item.destructive ?? false,
		disabled: item.disabled ?? false,
		// Icon slot: a `selected` flag (a "pick one of N" group) owns it — check
		// when chosen, blank column otherwise so labels align. Else a string
		// `icon` is an SDK `IconName` → rendered through the shared `<Icon>`
		// bridge (full glyph set + IconPack overrides); an object is a
		// fancy-menus `IconParam` (a Phosphor component) passed straight through.
		...(item.selected !== undefined
			? { icon: item.selected ? sdkMenuIcon(IconName.Check) : blankMenuIcon }
			: item.icon
				? { icon: typeof item.icon === "string" ? sdkMenuIcon(item.icon) : item.icon }
				: {}),
	};
}

/** Open a menu anchored at `point`. Replaces any open menu (one at a time).
 *  Selecting an enabled item closes the menu, then runs it. */
export function openAnchoredMenu(
	point: { x: number; y: number },
	items: AnchoredMenuItem[],
	options: OpenAnchoredMenuOptions,
): void {
	if (getActiveMenuStore()) {
		closeLegacyAnchoredMenu();
		openContextMenu(point, items.map(toContextItem), {
			menuLabel: options.menuLabel,
			...(options.anchor ? { anchor: options.anchor } : {}),
			...(options.align ? { align: options.align } : {}),
		});
		return;
	}
	openLegacyAnchoredMenu(point, items, options);
}

/** Close the single open anchored menu, if any. Idempotent. */
export function closeAnchoredMenu(): void {
	if (getActiveMenuStore()) closeContextMenu();
	closeLegacyAnchoredMenu();
}

// ─── No-host fallback: the original self-contained DOM popup ───────────────

let openEl: HTMLElement | null = null;
let openCleanup: (() => void) | null = null;

function closeLegacyAnchoredMenu(): void {
	openCleanup?.();
	openCleanup = null;
	openEl?.remove();
	openEl = null;
}

function openLegacyAnchoredMenu(
	point: { x: number; y: number },
	items: AnchoredMenuItem[],
	options: OpenAnchoredMenuOptions,
): void {
	closeLegacyAnchoredMenu();

	const menu = document.createElement("div");
	menu.className = "bs-object-menu glass--strong";
	menu.setAttribute("role", "menu");
	menu.setAttribute("aria-label", options.menuLabel);

	for (const item of items) {
		if (item.divider) {
			const rule = document.createElement("div");
			rule.className = "bs-object-menu__divider";
			rule.setAttribute("role", "separator");
			menu.appendChild(rule);
			continue;
		}
		if (item.section) {
			const heading = document.createElement("div");
			heading.className = "bs-object-menu__section";
			heading.setAttribute("role", "presentation");
			heading.textContent = item.label ?? "";
			menu.appendChild(heading);
			continue;
		}
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "bs-object-menu__item";
		btn.setAttribute("role", "menuitem");
		if (item.destructive) btn.dataset.destructive = "true";
		if (item.disabled) {
			if (item.hint) {
				// Stay focusable and fold the reason into the accessible name: a
				// native-`disabled` button is skipped by Tab and its `title` is
				// not reliably announced, so the hint would never reach
				// keyboard / screen-reader users. The click handler still
				// no-ops on `item.disabled`.
				btn.setAttribute("aria-disabled", "true");
				btn.setAttribute("aria-label", `${item.label}, ${item.hint}`);
			} else {
				btn.disabled = true;
			}
		}
		if (item.hint) btn.title = item.hint;

		// The no-host fallback is pure DOM, so it can only render an SDK
		// `IconName` (via `createIconElement`). A Phosphor `IconParam` is a React
		// component that needs the fancy-menus runtime — skip it here (label-only)
		// since this branch is unreachable once a menu host is mounted.
		if (item.icon && typeof item.icon === "string") {
			const glyph = createIconElement(item.icon, { size: 16 });
			glyph.classList.add("bs-object-menu__glyph");
			btn.appendChild(glyph);
		}
		const labelEl = document.createElement("span");
		labelEl.className = "bs-object-menu__label";
		labelEl.textContent = item.label ?? "";
		btn.appendChild(labelEl);

		if (item.shortcut) {
			const accel = document.createElement("span");
			accel.className = "bs-object-menu__shortcut";
			accel.textContent = item.shortcut;
			btn.appendChild(accel);
		}

		btn.addEventListener("click", () => {
			if (item.disabled) return;
			closeLegacyAnchoredMenu();
			item.onSelect?.();
		});
		menu.appendChild(btn);
	}

	document.body.appendChild(menu);
	positionLegacy(point, menu, options);

	// Mirror the fancy path's open/active state on the trigger.
	const anchor = options.anchor ?? null;
	anchor?.setAttribute("aria-expanded", "true");

	const onPointerDown = (event: MouseEvent): void => {
		if (!menu.contains(event.target as Node)) closeLegacyAnchoredMenu();
	};
	const onKey = (event: KeyboardEvent): void => {
		if (event.defaultPrevented) return;
		if (matchesChord(event, ESCAPE_CHORD)) {
			event.preventDefault();
			closeLegacyAnchoredMenu();
		}
	};
	document.addEventListener("mousedown", onPointerDown, true);
	document.addEventListener("keydown", onKey, true);
	window.addEventListener("resize", closeLegacyAnchoredMenu);
	window.addEventListener("scroll", closeLegacyAnchoredMenu, true);

	openEl = menu;
	openCleanup = () => {
		anchor?.removeAttribute("aria-expanded");
		document.removeEventListener("mousedown", onPointerDown, true);
		document.removeEventListener("keydown", onKey, true);
		window.removeEventListener("resize", closeLegacyAnchoredMenu);
		window.removeEventListener("scroll", closeLegacyAnchoredMenu, true);
	};
}

function positionLegacy(
	point: { x: number; y: number },
	menu: HTMLElement,
	options: OpenAnchoredMenuOptions,
): void {
	const rect = menu.getBoundingClientRect();
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	// Right-edge alignment: when the menu drops from a right-positioned
	// trigger, its right edge sticks to the trigger's right edge (the menu
	// grows leftward) so it never drifts away from the button it belongs to.
	const anchorRect = options.anchor?.getBoundingClientRect();
	const rightAlign = options.align === MenuAlign.End || (!!options.anchor && options.align == null);
	let left = rightAlign && anchorRect ? anchorRect.right - rect.width : point.x;
	let top = point.y;
	if (left + rect.width > vw - VIEWPORT_GUTTER) left = vw - rect.width - VIEWPORT_GUTTER;
	if (top + rect.height > vh - VIEWPORT_GUTTER) top = vh - rect.height - VIEWPORT_GUTTER;
	if (left < VIEWPORT_GUTTER) left = VIEWPORT_GUTTER;
	if (top < VIEWPORT_GUTTER) top = VIEWPORT_GUTTER;
	menu.style.left = `${left}px`;
	menu.style.top = `${top}px`;
}
