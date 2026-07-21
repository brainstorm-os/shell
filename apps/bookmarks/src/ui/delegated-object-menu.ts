/**
 * Bookmarks re-exports the shared entity-id / entity-type data attributes from
 * `@brainstorm-os/sdk/object-menu` under the names the card + header already use.
 * The card stamps these so a bookmark is resolvable from the DOM (right-click
 * resolution, patch keys) and so it mirrors the cross-app `[data-entity-id]`
 * convention (Database / Notes / Journal).
 */

export { ENTITY_ID_ATTR, ENTITY_TYPE_ATTR } from "@brainstorm-os/sdk/object-menu";
