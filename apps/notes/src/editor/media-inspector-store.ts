/**
 * Media inspector pub-sub store — extracted to `@brainstorm-os/editor` (the
 * shared media stack). Re-exported here so Notes' image/video views and
 * the existing import sites keep resolving the SAME singleton the shared
 * `MediaInspectorPlugin` subscribes to.
 */

export {
	type InspectorTarget,
	MediaKind,
	mediaInspectorStore,
	useMediaInspector,
} from "@brainstorm-os/editor";
