/**
 * Notes wrapper over the shared `<CommentHighlightPlugin>` (`@brainstorm-os/editor`)
 * — feeds it the open-comment block ids from `NoteContext` (computed by the app
 * from the live comment list). Always mounted (even with no comments) so the
 * shared plugin can clear stale highlight attributes when the last comment on a
 * block resolves.
 */

import { CommentHighlightPlugin as SharedCommentHighlightPlugin } from "@brainstorm-os/editor";
import type { ReactNode } from "react";
import { useNoteContext } from "./note-context";

const NO_BLOCKS: readonly string[] = [];

export function CommentHighlightPlugin(): ReactNode {
	const { commentedBlockIds, onCommentBlockClick } = useNoteContext();
	return (
		<SharedCommentHighlightPlugin
			blockIds={commentedBlockIds ?? NO_BLOCKS}
			{...(onCommentBlockClick ? { onBlockClick: onCommentBlockClick } : {})}
		/>
	);
}
