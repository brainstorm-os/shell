/**
 * FileBlockNode — extracted to `@brainstorm-os/editor` (the shared media
 * stack). Re-exported here for Notes' node set + commands; `formatBytes`
 * is consumed by the media-files test.
 */

export {
	$createFileBlockNode,
	$isFileBlockNode,
	FILE_BLOCK_TYPE,
	FileBlockNode,
	formatBytes,
	type SerializedFileBlockNode,
} from "@brainstorm-os/editor";
