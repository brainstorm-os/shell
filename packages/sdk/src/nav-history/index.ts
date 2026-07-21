/**
 * `@brainstorm-os/sdk/nav-history` — one in-app back/forward model + one
 * back/forward control, adopted by every first-party app so navigation is
 * identical everywhere (per CLAUDE.md DRY / design-system rules).
 *
 * Adoption recipe (host side):
 *   1. Define a small serializable `Location` for "where the user is"
 *      ({ noteId } / { listId, viewId } / { rootId, depth } / …).
 *   2. `const nav = createNavHistory<Location>({ initial, … })`.
 *   3. On every USER navigation, `nav.push(captureLocation())`.
 *   4. Render `<NavButtons history={nav} onNavigate={applyLocation} />`
 *      (or `createNavButtons(...)` for plain-DOM apps) in the header,
 *      right after the app icon/title.
 *   5. `applyLocation` sets app state ONLY — it must not `push`.
 */

export {
	type CreateNavHistoryOptions,
	createNavHistory,
	defaultNavEquals,
	type NavEquals,
	type NavHistory,
	type NavHistoryState,
	type NavPersist,
	type NavStorage,
	navBack,
	navCanBack,
	navCanForward,
	navForward,
	navInit,
	navReplace,
	navTo,
} from "./nav-history";
export { NavButtons, type NavButtonsProps } from "./nav-buttons";
export {
	createNavButtons,
	type CreateNavButtonsOptions,
	type NavButtonsHandle,
} from "./create-nav-buttons";
export {
	attachNavShortcuts,
	NAV_BACK_CHORD,
	NAV_BACK_CHORD_ALT,
	NAV_FORWARD_CHORD,
	NAV_FORWARD_CHORD_ALT,
	type NavShortcutTarget,
} from "./shortcuts";
export { DEFAULT_NAV_LABELS, type NavLabels } from "../i18n/common-labels";
