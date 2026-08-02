/**
 * The shared host-driven typeahead menu (controlled-list mode). The fancy-menus
 * replacement for the hand-rolled `.fm-menu`/`.fm-list` popups the editor caret
 * typeaheads (slash `/`-menu, `@`-mention, emoji) each rolled their own — they
 * had to, because ≤0.1.0's list body grabbed DOM focus on mount and froze the
 * editor caret. `@react-fancy-menus/core` 0.2.0's controlled-list mode fixes
 * that: `ListBody.focusOnMount: false` + `KeyboardNavigation.None` so the list
 * renders + positions but NEVER takes focus or handles keys — the host (the
 * Lexical editor) keeps focus and owns the keyboard, and drives the highlight
 * through the per-open `activeIndex`.
 *
 * Imperative by design (mirrors `context-menu.ts`): the editor plugins open it
 * on the renderer's published `MenuStore` rather than through React context.
 * The caller owns: filtering, the active index (moved via its own arrow-key
 * handling), and committing a choice. This module owns: the menu chrome, the
 * anchor/position, the active-row paint, and click-to-select.
 */

import {
	BodyKind,
	DimmerMode,
	Horizontal,
	KeyboardNavigation,
	MenuKind,
	RowKind,
	SourceKind,
	Vertical,
	defineMenu,
} from "@react-fancy-menus/core";
import type { ReactNode } from "react";
import { getActiveMenuStore } from "./active-store";

/** One row in a typeahead menu. `icon` is a pre-rendered node (the editor
 *  commands carry `ReactNode` icons, not the runtime's `IconParam` component
 *  spec), so the row is a custom render that reuses the shared `.fm-row__*`
 *  slots for pixel-identity with every other menu. */
export type TypeaheadMenuItem = {
	id: string;
	label: string;
	icon?: ReactNode;
	description?: string;
	/** Non-interactive row — for an empty-state / "no results" line that should
	 *  show but never commit or take the active highlight (skipped in nav). */
	disabled?: boolean;
	/** Render as a non-interactive section heading (the `label` is the
	 *  heading) — the fancy-menus `RowKind.Section` row. Never clickable,
	 *  never highlighted; the host's `activeIndex` must count these rows
	 *  when mapping its own highlight to a row index. */
	section?: boolean;
};

type TypeaheadData = { items: readonly TypeaheadMenuItem[] };

export const TYPEAHEAD_MENU_ID = "bs/typeahead-menu";

/** Gap between the anchor row and the menu. */
const TYPEAHEAD_GAP = 4;

export const typeaheadMenuConfig = defineMenu<TypeaheadData>({
	id: TYPEAHEAD_MENU_ID,
	kind: MenuKind.Context,
	// No dimmer — the editor stays fully visible + interactive behind the menu
	// (the user is mid-typing). `role="listbox"` matches the editor typeaheads'
	// existing a11y; the per-open `ariaLabel` names it ("Slash commands", …).
	chrome: { role: "listbox", dimmer: DimmerMode.None },
	body: {
		kind: BodyKind.List,
		source: { kind: SourceKind.Prop, getItems: (data) => [...data.items] },
		rows: [
			{
				// Section headers group the browse view (e.g. the slash menu's
				// block-type sections). Non-interactive by construction.
				kind: RowKind.Section,
				match: (item: TypeaheadMenuItem) => item.section === true,
				name: (item: TypeaheadMenuItem): ReactNode => item.label,
				className: "bs-typeahead-section",
			},
			{
				// `Item` rows carry the runtime's active-row treatment (it paints the
				// row at `activeIndex`) + click wiring + scroll-into-view — the whole
				// point of using the runtime. The command icon is a pre-rendered
				// `ReactNode`, not the row `icon` slot's `IconParam`, so it rides in
				// the `name` renderable (alongside the label) instead.
				kind: RowKind.Item,
				match: () => true,
				// A disabled row (empty-state line) is non-interactive and skipped in
				// the host's keyboard nav (it never takes the active highlight).
				disabled: (item: TypeaheadMenuItem) => item.disabled === true,
				skipOver: (item: TypeaheadMenuItem) => item.disabled === true,
				// The runtime reliably stamps a row's className onto its `.fm-row`
				// element — drives the typeahead caption/name layout (menus.css).
				className: () => "bs-typeahead-row",
				// The runtime wraps this in its `.fm-row__name` slot; render the
				// command icon + label inline (the icon is a pre-rendered node, not
				// the row `icon` slot's `IconParam`). The description rides the
				// runtime's `caption` slot.
				name: (item: TypeaheadMenuItem): ReactNode => (
					<span>
						{item.icon ? (
							<span className="fm-row__icon" aria-hidden="true">
								{item.icon}
							</span>
						) : null}
						<span>{item.label}</span>
					</span>
				),
				caption: (item: TypeaheadMenuItem): ReactNode => item.description ?? null,
				onClick: (item: TypeaheadMenuItem, _e: unknown, ctx: { closeAll: () => void }) => {
					if (item.disabled === true) return;
					onSelectRef?.(item.id);
					ctx.closeAll();
				},
			},
		],
		focusOnMount: false,
	},
	position: {
		vertical: Vertical.Bottom,
		horizontal: Horizontal.Left,
		offsetY: TYPEAHEAD_GAP,
		// Roomy enough that a command label + its description sit on one line
		// (matches the former hand-rolled slash menu's 280px).
		minWidth: 280,
		// Track the anchor's live rect: as the user types, the anchored line can
		// reflow / scroll, and the menu should follow it.
		followAnchor: true,
	},
	// Host owns the keyboard: the list never navigates or commits on its own.
	keyboard: {
		navigation: KeyboardNavigation.None,
		defaults: { closeOnEscape: false, selectOnEnter: false },
	},
});

/** The active selection callback for the currently-open typeahead. One menu is
 *  open at a time (a single caret), so a module-level ref suffices — set on open,
 *  cleared on close. The row's `onClick` reads it. */
let onSelectRef: ((id: string) => void) | null = null;

export type OpenTypeaheadMenuOptions = {
	/** The rows to show (already filtered + ranked by the host). */
	items: readonly TypeaheadMenuItem[];
	/** The element the menu drops from (e.g. the caret's paragraph row). Pass
	 *  this OR `rect` — `rect` wins when both are given. */
	anchor?: Element;
	/** A viewport rect the menu drops from — for caret typeaheads (mention /
	 *  emoji / transclusion) that hug the live caret rect across line wraps,
	 *  where there is no single element to anchor to. */
	rect?: DOMRect;
	/** The host-controlled highlight (the row the editor's arrow keys moved to).
	 *  Painted with the active treatment; the runtime never moves it itself. */
	activeIndex: number;
	/** Accessible name for the listbox (e.g. "Slash commands"). */
	ariaLabel: string;
	/** Fired when a row is clicked — the host commits the choice by id. */
	onSelect: (id: string) => void;
};

/** Open (or, if already open, refresh) the shared typeahead menu. Returns false
 *  when no `<BrainstormMenuProvider>` is mounted, so non-React callers degrade. */
export function openTypeaheadMenu(options: OpenTypeaheadMenuOptions): boolean {
	const store = getActiveMenuStore();
	if (!store) return false;
	if (!store.getConfig(typeaheadMenuConfig.id)) store.register(typeaheadMenuConfig);
	onSelectRef = options.onSelect;
	const param = {
		data: { items: options.items },
		...(options.rect ? { rect: options.rect } : options.anchor ? { element: options.anchor } : {}),
		activeIndex: options.activeIndex,
		ariaLabel: options.ariaLabel,
	};
	if (store.isOpen(typeaheadMenuConfig.id)) store.update(typeaheadMenuConfig.id, param);
	else store.open(typeaheadMenuConfig.id, param);
	return true;
}

/** Update just the live highlight (cheap path for arrow-key moves). */
export function setTypeaheadActiveIndex(activeIndex: number): void {
	const store = getActiveMenuStore();
	if (store?.isOpen(typeaheadMenuConfig.id)) store.update(typeaheadMenuConfig.id, { activeIndex });
}

/** Close the shared typeahead menu if it's open. */
export function closeTypeaheadMenu(): void {
	onSelectRef = null;
	getActiveMenuStore()?.close(typeaheadMenuConfig.id);
}
