/**
 * Media alignment/width contract — extracted to `@brainstorm-os/editor` so
 * every editor surface shares one implementation (Journal / Tasks /
 * Bookmarks get the same media blocks Notes has). Re-exported here so the
 * existing Notes import sites keep resolving.
 */

export {
	DEFAULT_MEDIA_ALIGNMENT,
	DEFAULT_MEDIA_WIDTH_PERCENT,
	MAX_MEDIA_WIDTH_PERCENT,
	MIN_MEDIA_WIDTH_PERCENT,
	MediaAlignment,
	clampMediaWidth,
	isMediaAlignment,
} from "@brainstorm-os/editor";
