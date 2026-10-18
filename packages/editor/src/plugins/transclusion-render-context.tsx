/**
 * TransclusionRenderContext — threads the live render-time **ancestor
 * chain** + the (heavy) nested-body renderer down to `TransclusionNode`
 * decorators (B6.4b render-half).
 *
 * Two non-obvious constraints shape this:
 *
 *  1. **Why a context that's an ANCESTOR of `<BrainstormEditor>`, not a
 *     composer child.** Lexical paints decorator nodes through
 *     `RichTextPlugin` (`useDecorators` → `createPortal`), so a decorator's
 *     React-context ancestors are the ancestors of `RichTextPlugin` — i.e.
 *     the providers ABOVE `<LexicalComposer>`, the same place
 *     `EditorI18nProvider` sits. A provider mounted as a composer *child*
 *     (a sibling of `RichTextPlugin`) is invisible to decorators. So the
 *     editor mounts `<TransclusionRenderProvider>` wrapping
 *     `<BrainstormEditor>`, never inside it.
 *
 *  2. **Why `renderBody` is injected rather than imported.** The body
 *     renderer mounts a nested read-only `<BrainstormEditor>` with the full
 *     node set, which imports `TransclusionNode` — so a direct import from
 *     the node file back to the renderer would cycle. Passing the renderer
 *     through context keeps `transclusion-node.tsx` free of the heavy
 *     editor wiring.
 *
 * The chain is host-first and does NOT include the node's own target — it is
 * exactly the shape `decideTransclusionRender(ancestorChain, targetId)`
 * expects. Each nested body re-provides the context with the chain extended
 * by its own entity id, so deeper transclusions see themselves as ancestors
 * and the cycle/depth guard converges.
 */

import { type ReactNode, createContext, useContext, useMemo } from "react";

/** Renders the read-only inline body of a transcluded entity. Supplied by the
 *  host (see Notes' `transclusion-body.tsx`); `null` when no renderer is wired
 *  (tests / preview-only mounts), in which case the node degrades to its
 *  header card alone. */
export type TransclusionBodyRenderer = (args: {
	entityId: string;
	entityType: string;
	/** The ancestor chain ABOVE this node (host-first, excluding the target).
	 *  The renderer re-provides the context with `entityId` appended. */
	chain: readonly string[];
}) => ReactNode;

export type TransclusionRenderContextValue = {
	/** Entity ids transcluded above the current render point, host first,
	 *  NOT including the node currently deciding whether to paint. */
	ancestorChain: readonly string[];
	renderBody: TransclusionBodyRenderer | null;
	/** Whether the document hosting this render point is editable (B11.22). A
	 *  transcluded body may only be edited in place under an editable host; a
	 *  read-only host (locked page, preview) keeps every nested body read-only.
	 *  Absent ⇒ read-only. */
	editable?: boolean;
};

const TransclusionRenderContext = createContext<TransclusionRenderContextValue>({
	ancestorChain: [],
	renderBody: null,
	editable: false,
});

export type TransclusionRenderProviderProps = TransclusionRenderContextValue & {
	children: ReactNode;
};

export function TransclusionRenderProvider({
	ancestorChain,
	renderBody,
	editable = false,
	children,
}: TransclusionRenderProviderProps) {
	const value = useMemo<TransclusionRenderContextValue>(
		() => ({ ancestorChain, renderBody, editable }),
		[ancestorChain, renderBody, editable],
	);
	return (
		<TransclusionRenderContext.Provider value={value}>{children}</TransclusionRenderContext.Provider>
	);
}

export function useTransclusionRender(): TransclusionRenderContextValue {
	return useContext(TransclusionRenderContext);
}
