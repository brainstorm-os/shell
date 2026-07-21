/**
 * Journal's delegated object-menu wiring. The implementation lives in
 * `@brainstorm-os/sdk/object-menu` (`bindDelegatedObjectMenu`, shared with
 * Bookmarks / Tasks); this re-exports it under the names the journal surface
 * already imports. ONE `contextmenu` + ONE `click` listener on the stable
 * root resolve the target lazily from `data-entity-id`.
 */

export {
	ENTITY_ID_ATTR,
	ENTITY_TYPE_ATTR,
	bindDelegatedObjectMenu,
	closeObjectMenu,
	createMoreButton,
	type DelegatedMenuResolver as JournalMenuResolver,
} from "@brainstorm-os/sdk/object-menu";
