/**
 * `@brainstorm/sdk/menus` — the one menu layer for the shell + every
 * first-party app. Wraps `@react-fancy-menus/core` (the declarative menu
 * constructor: a typed `MenuConfig` → the runtime renders, positions, and
 * handles input) behind the SDK so the version is pinned once (OQ-32) and
 * every consumer inherits the same theme bridge + suppression wiring.
 *
 * Usage:
 *   import "@react-fancy-menus/core/runtime.css";
 *   import "@brainstorm/sdk/menus.css";
 *   import { BrainstormMenuProvider, defineMenu, BodyKind, RowKind } from "@brainstorm/sdk/menus";
 *
 * Mount one `<BrainstormMenuProvider>` per renderer root; declare each menu
 * with `defineMenu({...})`; open it imperatively via `useMenu().open(id)`.
 */

// Schema: `defineMenu` + every config type and value enum (BodyKind,
// RowKind, PositionStrategy, Vertical, …).
export * from "@react-fancy-menus/core";

// Runtime: imperative API, lifecycle hooks, store, storage adapters. The
// bare `MenuProvider` is intentionally NOT re-exported — use
// `BrainstormMenuProvider`, which owns the store + suppression seam.
export {
	LocalStorageAdapter,
	MemoryStorageAdapter,
	MenuStore,
	useIsAnyMenuOpen,
	useIsAnyMenuTransitioning,
	useMenu,
	useMenuStack,
	useMenuState,
} from "@react-fancy-menus/core/runtime";

export { BrainstormMenuProvider, type BrainstormMenuProviderProps } from "./provider";
export { mountMenuHost, type MountMenuHostOptions } from "./mount-host";
export { DEFAULT_MENU_LOCALE, type MenuLocale, resolveMenuLocale } from "./locale";
export { getActiveMenuStore } from "./active-store";
export { sdkMenuIcon, blankMenuIcon } from "./sdk-icon";
export {
	CONTEXT_MENU_ID,
	CONTEXT_SUBMENU_ID,
	type ContextMenuItem,
	MenuAlign,
	type OpenContextMenuOptions,
	closeContextMenu,
	contextMenuConfig,
	contextSubMenuConfig,
	openContextMenu,
} from "./context-menu";
export {
	TYPEAHEAD_MENU_ID,
	type OpenTypeaheadMenuOptions,
	type TypeaheadMenuItem,
	closeTypeaheadMenu,
	openTypeaheadMenu,
	setTypeaheadActiveIndex,
	typeaheadMenuConfig,
} from "./typeahead-menu";
export {
	SEARCH_PICKER_ID,
	type OpenSearchPickerOptions,
	type SearchPickerItem,
	closeSearchPicker,
	openSearchPicker,
} from "./search-picker";
