/**
 * Notes comments bindings (B11.9) — thin wrappers that hand the Notes runtime
 * services to the shared `@brainstorm-os/editor` comments hooks. All the bridge
 * logic (codec / filter / cache / liveness via `useVaultEntities`) lives in the
 * shared `useEntityCommentsAdapter` so Journal / Tasks / Bookmarks reuse it
 * rather than copying this file.
 */

import {
	type CommentsAdapter,
	useEntityCommentsAdapter,
	useOpenCommentBlockIds as useSharedOpenCommentBlockIds,
} from "@brainstorm-os/editor";
import { useMemo } from "react";
import { getBrainstorm } from "./runtime";

/** Live `CommentsAdapter` for the open note, or null when there's no note / the
 *  shell lacks the real entities service. */
export function useNotesCommentsAdapter(noteId: string | null): CommentsAdapter | null {
	const runtime = useMemo(() => getBrainstorm(), []);
	return useEntityCommentsAdapter(
		runtime?.services.vaultEntities,
		runtime?.services.entities,
		noteId,
	);
}

/** Live block ids of the open note's open comment threads, for the highlight. */
export function useOpenCommentBlockIds(noteId: string | null): readonly string[] {
	const runtime = useMemo(() => getBrainstorm(), []);
	return useSharedOpenCommentBlockIds(runtime?.services.vaultEntities, noteId);
}
