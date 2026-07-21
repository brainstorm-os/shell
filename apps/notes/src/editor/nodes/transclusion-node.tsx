/**
 * Re-export shim — `TransclusionNode` now lives in `@brainstorm-os/editor`.
 * Notes-local imports (notes-nodes, dev-bench, entity-drop, render test)
 * keep working through here; new code should import from
 * `@brainstorm-os/editor` directly.
 */

export {
	TRANSCLUSION_NODE_TYPE,
	TRANSCLUSION_DOM_FLAG,
	TRANSCLUSION_DOM_FLAG_VALUE,
	type SerializedTransclusionNode,
	$createTransclusionNode,
	$isTransclusionNode,
	TransclusionNode,
	TransclusionView,
} from "@brainstorm-os/editor";
