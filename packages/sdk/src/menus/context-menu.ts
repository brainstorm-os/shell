/**
 * The one reusable context-menu config + its imperative opener. Cursor- or
 * button-anchored flat list of actions — the fancy-menus replacement for
 * the hand-rolled `openAnchoredMenu` that every app's object menu, the
 * graph export menu, and the database column-adder shared.
 *
 * Imperative by design: the callers run outside React, so they open the
 * menu on the renderer's published `MenuStore` (see `active-store.ts`)
 * rather than through the `useMenu` context hook.
 */

import {
	BodyKind,
	DimmerMode,
	Horizontal,
	type IconParam,
	type MenuConfig,
	MenuKind,
	RowKind,
	type RowSpec,
	SourceKind,
	SubMenuTrigger,
	Vertical,
	defineMenu,
} from "@react-fancy-menus/core";
import { getActiveMenuStore } from "./active-store";

/** How the menu aligns to its trigger on the cross axis. `Start` = the
 *  menu's left edge tracks the trigger's left (cursor / left-side rows);
 *  `End` = the menu's right edge sticks to the trigger's right edge
 *  (the standard for a right-positioned ⋯ / header button). */
export enum MenuAlign {
	Start = "start",
	End = "end",
}

export type ContextMenuItem = {
	id: string;
	label: string;
	/** Optional leading icon (a Phosphor-compatible component, optionally styled). */
	icon?: IconParam;
	destructive?: boolean;
	disabled?: boolean;
	/** Mark as the currently-chosen option (the select-menu case): the row
	 *  gets `fm-row--selected` so its glyph paints accent. Pair with a check
	 *  `icon` so the state survives without colour vision. */
	selected?: boolean;
	/** Render as a non-interactive section header (the `label` is the heading)
	 *  instead of an action row — for grouped menus like the editor block
	 *  menu's Turn into / Align / Actions. Skipped in keyboard nav. */
	section?: boolean;
	/** Render as a horizontal divider line (no label). Skipped in keyboard nav. */
	divider?: boolean;
	/** Trailing accelerator caption (e.g. "⌘⌫") painted right-aligned and
	 *  muted in the row's caption slot — the keyboard hint for the action.
	 *  Set it ONLY when the action has a real registered shortcut; it's a
	 *  display label, not a binding. Empty/absent collapses the slot. */
	shortcut?: string;
	/** Nested submenu. When set (non-empty) the row paints a trailing chevron
	 *  and opens this child list to its right on hover (200 ms latch) /
	 *  ArrowRight — the cascade pattern for grouped option sets (Diff layout,
	 *  Syntax theme, …). The parent row is a pure container: its own `onSelect`
	 *  never fires and clicking it neither acts nor closes the menu. Nests to
	 *  any depth (a child may itself carry a `submenu`). */
	submenu?: ContextMenuItem[];
	onSelect?: () => void;
};

type ContextMenuData = {
	items: ContextMenuItem[];
};

function isHeader(it: ContextMenuItem): boolean {
	return it.section === true || it.divider === true;
}

function hasSubmenu(it: ContextMenuItem): boolean {
	return Array.isArray(it.submenu) && it.submenu.length > 0;
}

export const CONTEXT_MENU_ID = "bs/context-menu";
/** The one shared child every `submenu` spawns. A single registered config,
 *  re-entered at each nesting level (its own rows can spawn it again), so a
 *  cascade of any depth reuses the same chrome + keyboard model. */
export const CONTEXT_SUBMENU_ID = "bs/context-menu/sub";
/** Slot name the parent rows hand to `ctx.open`; the config's `subMenus` map
 *  resolves it to `CONTEXT_SUBMENU_ID`. */
const SUBMENU_SLOT = "submenu";
/** Small gap between a parent row's right edge and its cascade child. */
const SUBMENU_GAP = 2;

const BASE_CHROME = { role: "menu", dimmer: DimmerMode.Default } as const;

// One row template, shared by the top-level menu and the cascade child, so a
// nested row is pixel-identical to a top-level one (same icon slot, caption,
// destructive / selected styling) and can itself open a deeper child.
function contextMenuRows(): RowSpec<ContextMenuItem>[] {
	return [
		{
			kind: RowKind.Divider,
			match: (it: ContextMenuItem) => it.divider === true,
			skipOver: true,
		},
		{
			kind: RowKind.Section,
			match: (it: ContextMenuItem) => it.section === true,
			name: (it: ContextMenuItem) => it.label,
			skipOver: true,
		},
		{
			kind: RowKind.Item,
			match: (it: ContextMenuItem) => !isHeader(it),
			name: (it: ContextMenuItem) => it.label,
			icon: (it: ContextMenuItem) => it.icon,
			// The caption slot is `flex: 0 0 auto` + muted in the runtime CSS,
			// so a shortcut paints right-aligned after the label and collapses
			// when absent — the standard menu accelerator hint.
			caption: (it: ContextMenuItem) => it.shortcut,
			disabled: (it: ContextMenuItem) => it.disabled === true,
			// A row with children paints the cascade chevron and opens the shared
			// child on hover; `subMenuData` hands that child its own `items`.
			arrow: (it: ContextMenuItem) => hasSubmenu(it),
			subMenuId: (it: ContextMenuItem) => (hasSubmenu(it) ? SUBMENU_SLOT : undefined),
			subMenuData: (it: ContextMenuItem) => ({ items: it.submenu ?? [] }),
			className: (it: ContextMenuItem) => {
				const classes = [
					...(it.destructive ? ["fm-row--destructive"] : []),
					...(it.selected ? ["fm-row--selected"] : []),
				];
				return classes.length > 0 ? classes.join(" ") : undefined;
			},
			onClick: (it, _e, ctx) => {
				// A submenu parent is a pure container — hover / ArrowRight reveals
				// the children, so a click neither runs an action nor closes.
				if (it.disabled === true || isHeader(it) || hasSubmenu(it)) return;
				it.onSelect?.();
				// Selecting an item dismisses the whole stack, not just the menu the
				// row lives in — a cascade child's `ctx.close()` would leave the
				// parent hanging open after the pick (the leaf chose, the menu stays).
				ctx.closeAll();
			},
		},
	];
}

// Every row spawns the same child slot; the child re-declares it pointing at
// itself so a deeper `submenu` cascades further.
const CONTEXT_SUBMENUS = {
	[SUBMENU_SLOT]: { menuId: CONTEXT_SUBMENU_ID, trigger: SubMenuTrigger.ArrowHover },
} as const;

export const contextMenuConfig = defineMenu<ContextMenuData>({
	id: CONTEXT_MENU_ID,
	kind: MenuKind.Context,
	chrome: { ...BASE_CHROME },
	body: {
		kind: BodyKind.List,
		source: { kind: SourceKind.Prop, getItems: (data: ContextMenuData) => data.items },
		rows: contextMenuRows(),
	},
	subMenus: CONTEXT_SUBMENUS,
	keyboard: { defaults: { closeOnEscape: true, selectOnEnter: true } },
});

// The cascade child: same body + rows, anchored to the spawning ROW's right
// edge so it opens beside the row, top-aligned. It carries NO dimmer of its
// own — the runtime already drops the dimmer for any parented menu, and forcing
// one here would re-darken the screen once per nesting level.
export const contextSubMenuConfig = defineMenu<ContextMenuData>({
	id: CONTEXT_SUBMENU_ID,
	kind: MenuKind.Context,
	chrome: { role: "menu", dimmer: DimmerMode.None },
	body: {
		kind: BodyKind.List,
		source: { kind: SourceKind.Prop, getItems: (data: ContextMenuData) => data.items },
		rows: contextMenuRows(),
	},
	subMenus: CONTEXT_SUBMENUS,
	// Place the cascade child BESIDE the spawning row (Floating-UI `right`,
	// flipping to `left` near the viewport edge), vertically centred on it.
	// `Vertical.Center` + `Horizontal.Right` is the runtime's only beside-the-
	// trigger placement (`placementFromConfig`); the declared `stickToElementEdge`
	// field is inert here, so anchoring with `Vertical.Top` left the child opening
	// ABOVE the row, overlapping the parent menu — reaching it then crossed
	// sibling rows whose mouse-enter retires the child, so it could never be
	// clicked. The gap rides the main axis (horizontal for a side placement) via
	// `offsetY`.
	position: {
		vertical: Vertical.Center,
		horizontal: Horizontal.Right,
		offsetY: SUBMENU_GAP,
		followAnchor: false,
	},
	keyboard: { defaults: { closeOnEscape: true, selectOnEnter: true } },
});

export type OpenContextMenuOptions = {
	/** Accessible name for the menu (role="menu"). */
	menuLabel?: string;
	/** The trigger element the menu drops from. When given, the menu anchors
	 *  to the element's live rect (Floating UI follows it + flips/shifts to
	 *  stay on screen) instead of the click point, and the element gets
	 *  `aria-expanded="true"` for as long as the menu is open (the open/active
	 *  state). Omit for cursor-anchored menus (right-click). */
	anchor?: HTMLElement;
	/** Cross-axis alignment to the trigger. Defaults to `Start`; pass `End`
	 *  for a right-positioned trigger so the menu's right edge sticks to the
	 *  trigger's right edge. */
	align?: MenuAlign;
	/** Floor the menu's width (px). A select popup passes its trigger's width
	 *  so the dropdown is never narrower than the control it fell from (which
	 *  reads as detached). Omit for content-width menus. */
	minWidth?: number;
};

// fancy-menus positions from the STATIC config (`open.config.position`), not
// from a per-open override, and takes a STATIC `chrome.ariaLabel`. So each
// distinct (label, alignment) combination — a small, bounded set — gets its
// own registered config variant: the variant carries the menu's `ariaLabel`
// (named `role="menu"` for screen readers) AND its cross-axis placement
// (`bottom-start` vs `bottom-end`). Opening picks the matching variant.
// (Follow-up: upstream per-open `ariaLabel` + position so these collapse.)
const MENU_GAP = 4;
const menuVariants = new Map<string, MenuConfig<ContextMenuData>>();

function configFor(menuLabel: string | undefined, align: MenuAlign): MenuConfig<ContextMenuData> {
	const key = `${align} ${menuLabel ?? ""}`;
	let config = menuVariants.get(key);
	if (!config) {
		const id =
			align === MenuAlign.End
				? `${CONTEXT_MENU_ID}:end${menuLabel ? `:${menuLabel}` : ""}`
				: menuLabel
					? `${CONTEXT_MENU_ID}:${menuLabel}`
					: CONTEXT_MENU_ID;
		config = {
			...contextMenuConfig,
			id,
			chrome: menuLabel ? { ...BASE_CHROME, ariaLabel: menuLabel } : { ...BASE_CHROME },
			position: {
				vertical: Vertical.Bottom,
				horizontal: align === MenuAlign.End ? Horizontal.Right : Horizontal.Left,
				offsetY: MENU_GAP,
				// Compute once at open, then freeze. These menus sit behind a dimmer
				// (no background scroll), so they never need to track the trigger —
				// and following it is actively harmful: an action that removes its own
				// trigger (Delete a row → the ⋯ button unmounts) leaves autoUpdate
				// repositioning against a disconnected element whose rect is all-zeros,
				// snapping the menu to the top-left corner for a frame before the
				// trigger-removal observer closes it.
				followAnchor: false,
			},
		};
		menuVariants.set(key, config);
	}
	return config;
}

let activeContextMenuId = CONTEXT_MENU_ID;

// The trigger element currently marked open, and the store subscription that
// clears it once the menu closes (select / escape / outside-click). One menu
// is open at a time, so one tracked trigger suffices.
let activeTrigger: HTMLElement | null = null;
let triggerUnsub: (() => void) | null = null;
let triggerRemovalWatch: MutationObserver | null = null;

function clearActiveTrigger(): void {
	triggerRemovalWatch?.disconnect();
	triggerRemovalWatch = null;
	triggerUnsub?.();
	triggerUnsub = null;
	if (activeTrigger) {
		activeTrigger.removeAttribute("aria-expanded");
		activeTrigger = null;
	}
}

function markTriggerOpen(el: HTMLElement, menuId: string): void {
	clearActiveTrigger();
	activeTrigger = el;
	el.setAttribute("aria-expanded", "true");
	// A route change / list re-render can unmount the trigger while its menu
	// is open; the runtime keeps positioning from the now-disconnected element,
	// which collapses to the viewport origin (the "menu hangs in the top-left"
	// bug). An anchored menu's lifetime is its trigger's lifetime: close the
	// menu the moment the trigger leaves the document. Observer is live only
	// while an anchored menu is open.
	triggerRemovalWatch = new MutationObserver(() => {
		if (!el.isConnected) closeContextMenu();
	});
	triggerRemovalWatch.observe(document.documentElement, { childList: true, subtree: true });
	const store = getActiveMenuStore();
	if (!store) return;
	triggerUnsub = store.subscribe(() => {
		if (!store.isOpen(menuId)) clearActiveTrigger();
	});
}

/** A zero-area virtual anchor rect at a viewport point. The fancy-menus
 *  runtime positions a menu from `param.element` / `param.rect` only — the
 *  `position.fixedX/fixedY` fields exist in the type surface but the runtime
 *  ignores them, so passing a point that way left every menu centred on the
 *  viewport. A collapsed rect at the click point makes the menu open from
 *  there (the cursor / right-click case). */
function anchorRectAt(point: { x: number; y: number }): DOMRect {
	return {
		x: point.x,
		y: point.y,
		top: point.y,
		bottom: point.y,
		left: point.x,
		right: point.x,
		width: 0,
		height: 0,
		toJSON: () => ({ x: point.x, y: point.y, width: 0, height: 0 }),
	};
}

/**
 * Open the shared context menu. `point` is the cursor / fallback anchor;
 * pass `options.anchor` to drop the menu from a trigger element instead (it
 * tracks the element's live rect and toggles its open state). Returns false
 * (a no-op) when no `<BrainstormMenuProvider>` is mounted, so imperative
 * callers can fall back without throwing into non-React code.
 */
export function openContextMenu(
	point: { x: number; y: number },
	items: ContextMenuItem[],
	options?: OpenContextMenuOptions,
): boolean {
	const store = getActiveMenuStore();
	if (!store) return false;
	const anchor = options?.anchor;
	// Left-edge by default (the natural dropdown / cursor menu); a
	// right-positioned trigger passes `MenuAlign.End` to stick to its right
	// edge (the object-menu ⋯ does this via `openObjectMenu`).
	const align = options?.align ?? MenuAlign.Start;
	const config = configFor(options?.menuLabel, align);
	if (!store.getConfig(config.id)) store.register(config);
	// The cascade child is shared across every variant; register it once so any
	// item carrying a `submenu` can spawn it.
	if (!store.getConfig(contextSubMenuConfig.id)) store.register(contextSubMenuConfig);
	// One context menu at a time: close any previously-opened variant first so
	// a label / alignment switch doesn't leave the old menu stacked underneath.
	if (activeContextMenuId !== config.id) store.close(activeContextMenuId);
	activeContextMenuId = config.id;
	store.open(config.id, {
		data: { items },
		...(anchor ? { element: anchor } : { rect: anchorRectAt(point) }),
		...(options?.minWidth ? { position: { minWidth: options.minWidth } } : {}),
	});
	if (anchor) markTriggerOpen(anchor, config.id);
	else clearActiveTrigger();
	return true;
}

/** Close the shared context menu if it's open. */
export function closeContextMenu(): void {
	clearActiveTrigger();
	getActiveMenuStore()?.close(activeContextMenuId);
}
