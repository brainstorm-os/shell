/**
 * Re-export of the shared top-level-block helpers, lifted to
 * `@brainstorm-os/editor` at 13.4a.1 so the editor virtualization plugin
 * walks the same "what is a row?" definition the Notes gutter,
 * block-selection, marquee, and clipboard use. Existing relative
 * imports inside Notes (`./top-level-block`) keep working through this
 * shim; long-term they migrate to `@brainstorm-os/editor` directly.
 */

export {
	blockParentOf,
	getAllBlocks,
	isTopLevelBlock,
	topLevelKeyOf,
} from "@brainstorm-os/editor";
