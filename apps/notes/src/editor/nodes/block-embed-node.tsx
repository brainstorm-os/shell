/** Re-export shim — BlockEmbedNode now lives in `@brainstorm/editor`
 *  (F-070 embed parity: Journal / Tasks render the same card). */
export {
	BLOCK_EMBED_DOM_FLAG,
	BLOCK_EMBED_DOM_FLAG_VALUE,
	BLOCK_EMBED_NODE_TYPE,
	SHELL_ENTITY_CARD_BLOCK_ID,
	type SerializedBlockEmbedNode,
	$createBlockEmbedNode,
	$isBlockEmbedNode,
	BlockEmbedNode,
	BlockEmbedView,
} from "@brainstorm/editor";
