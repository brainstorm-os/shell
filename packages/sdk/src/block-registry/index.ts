/**
 * `@brainstorm-os/sdk/block-registry` — the bridge layer between a
 * `BlockEmbedNode { blockId }` and the runtime that paints it.
 *
 * See {@link registry.ts} for the design notes; this index just
 * re-exports the public surface so consumers can write
 * `import { createBlockRendererRegistry } from "@brainstorm-os/sdk/block-registry"`.
 */

export {
	BlockRendererFallbackReason,
	BlockRendererKind,
	createBlockRendererRegistry,
	isStructurallyValidBlockId,
	SDK_BLOCK_ID_PATTERN,
} from "./registry";
export type {
	BlockProtocolProvider,
	BlockRendererInfo,
	BlockRendererRegistry,
	BpResolver,
	CustomNodeRenderer,
	FallbackRenderer,
} from "./registry";
export {
	DEFAULT_BUILTIN_CUSTOM_NODES,
	SHELL_ENTITY_CARD_BLOCK_ID,
} from "./shell-fallback-block";
export {
	BlockRendererRegistryProvider,
	useBlockRenderer,
	useBlockRendererRegistry,
} from "./use-block-renderer";
