/**
 * ImageBlockNode — extracted to `@brainstorm-os/editor` (the shared media
 * stack). Re-exported here so Notes' node set + commands resolve the SAME
 * class the shared plugins create (single Lexical node identity, single
 * `"image-block"` serialized type).
 */

export {
	$createImageBlockNode,
	$isImageBlockNode,
	IMAGE_BLOCK_TYPE,
	ImageBlockNode,
	type SerializedImageBlockNode,
} from "@brainstorm-os/editor";
