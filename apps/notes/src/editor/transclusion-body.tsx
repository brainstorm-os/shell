/**
 * Nested read-only transclusion body (B6.4b render-half).
 *
 * Mounts a real, non-editable `<BrainstormEditor>` bound to the target
 * entity's replica Y.Doc (resolved through `useYDoc(entityId)`), so the
 * transcluded content paints with full fidelity — mentions, embeds, images,
 * tables and *nested* transclusions all render through the same node set the
 * primary editor uses. The Lexical-free `EditorPreview` was the alternative;
 * a live mount is what lets a transcluded sub-tree's own decorator nodes work
 * (and the cycle/depth guard already bounds the recursion).
 *
 * `renderTransclusionBody` is injected into `TransclusionRenderContext` by the
 * primary editor and re-injected here, so a `TransclusionNode` inside the
 * mounted body resolves the SAME renderer — without `transclusion-node.tsx`
 * importing this heavy module (which would cycle through
 * `NOTES_ADDITIONAL_NODES`).
 *
 * The provider here wraps the nested editor (it must be an ANCESTOR of the
 * `<BrainstormEditor>` to reach its decorators — see
 * `transclusion-render-context.tsx`) and extends the ancestor chain by this
 * target's id, so a deeper transclusion of an ancestor collapses via
 * `decideTransclusionRender` instead of recursing forever.
 */

import { BrainstormEditor, EditablePlugin } from "@brainstorm-os/editor";
import {
	useUniversalBody,
	useYDoc,
	useYDocApplyPending,
	useYDocLoaded,
} from "@brainstorm-os/react-yjs";
import { NOTES_ADDITIONAL_NODES } from "./notes-nodes";
import { editorTheme } from "./theme";
import {
	type TransclusionBodyRenderer,
	TransclusionRenderProvider,
} from "./transclusion-render-context";

function TransclusionBodyMount({
	entityId,
	chain,
}: {
	entityId: string;
	chain: readonly string[];
}) {
	const doc = useYDoc(entityId);
	const whenLoaded = useYDocLoaded(entityId);
	const applyPending = useYDocApplyPending(entityId);
	useUniversalBody(doc);
	return (
		<TransclusionRenderProvider
			ancestorChain={[...chain, entityId]}
			renderBody={renderTransclusionBody}
		>
			<BrainstormEditor
				doc={doc}
				docId={entityId}
				namespace="notes"
				theme={editorTheme}
				contentClassName="notes__transclusion-body-content"
				additionalNodes={NOTES_ADDITIONAL_NODES}
				editable={false}
				{...(whenLoaded ? { whenLoaded } : {})}
				{...(applyPending ? { applyPending } : {})}
				onError={(error) => {
					console.error("[notes/transclusion-body]", error);
				}}
			>
				<EditablePlugin editable={false} />
			</BrainstormEditor>
		</TransclusionRenderProvider>
	);
}

/** Stable module-level renderer wired into `TransclusionRenderContext`. Keyed
 *  by `entityId` so switching the transcluded target rebinds `@lexical/yjs`
 *  cleanly (the `key={noteId}` discipline the primary editor uses on note
 *  switch). */
export const renderTransclusionBody: TransclusionBodyRenderer = ({ entityId, chain }) => (
	<TransclusionBodyMount key={entityId} entityId={entityId} chain={chain} />
);
