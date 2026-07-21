/**
 * `@brainstorm-os/sdk/find-replace` — the shared in-document find & replace
 * primitive (doc 59), same shape as `@brainstorm-os/sdk/nav-history`.
 *
 * B9.1a (this): the pure `createFindController` + the `TextSearchProvider`
 * seam + shared chord ids + shared labels — model-level, no DOM (the
 * OQ-185 payback). B9.1b-ui adds `<FindBar>` / `attachFindBar` / shell
 * chrome / `attachFindShortcuts`; B9.1b-adapter shipped the Notes
 * Lexical `TextSearchProvider`. B9.1c wires the bar into the Notes
 * editor + registries; B9.3 adopts Code-editor + Journal.
 *
 * Adoption recipe (host side, B9.1b onward):
 *   1. Implement a `TextSearchProvider` over the app's text MODEL.
 *   2. `const find = createFindController(provider, { persist })`.
 *   3. Render `<FindBar controller={find} … />` (or `attachFindBar`).
 *   4. Bind `FindAction` ids via the shortcut registry.
 */

export {
	type CreateFindControllerOptions,
	createFindController,
	DEFAULT_FIND_OPTIONS,
	FIND_SEED_MAX_LEN,
	type FindController,
	type FindControllerState,
	type FindOptions,
	type FindPersist,
	type FindQuery,
	type FindStorage,
	FindStatus,
	type Match,
	type ModelRange,
	type TextSearchProvider,
} from "./find-controller";
export {
	attachFindShortcuts,
	FIND_ACTIONS,
	FIND_DEFAULT_CHORDS,
	FindAction,
	type FindShortcutTarget,
} from "./shortcuts";
export { FindBar, type FindBarProps } from "./find-bar";
export { attachFindBar, type AttachFindBarOptions } from "./attach-find-bar";
export {
	createDomTextSearchProvider,
	type DomMatch,
	type DomTextSearchProvider,
} from "./dom-text-search-provider";
export { DEFAULT_FIND_LABELS, type FindLabels } from "../i18n/common-labels";
