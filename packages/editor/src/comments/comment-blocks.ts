/**
 * Which blocks carry an open comment thread (B11.9) — drives the in-editor
 * highlight that shows a reader where the comments are. Pure over the comment
 * list so it's unit-tested without an editor; the host plugin maps the returned
 * (session) block ids to live block DOM nodes.
 */

import { type CommentDef, CommentStatus, buildThreads } from "@brainstorm-os/sdk-types";
import { DOCUMENT_BLOCK_ID } from "./comments-panel";

/**
 * Distinct block ids that have at least one OPEN (unresolved) comment thread.
 * Document-level threads (the panel composer's `__document` anchor) are
 * excluded — they aren't tied to a block. Resolved-only blocks drop out so the
 * highlight tracks live discussion.
 */
export function openCommentBlockIds(comments: readonly CommentDef[]): string[] {
	const ids = new Set<string>();
	for (const thread of buildThreads(comments)) {
		if (thread.status !== CommentStatus.Open) continue;
		const { blockId } = thread.root.anchor;
		if (blockId && blockId !== DOCUMENT_BLOCK_ID) ids.add(blockId);
	}
	return [...ids];
}
