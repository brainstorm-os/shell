/**
 * Journal comments bindings (B11.9) — thin wrappers that hand the Journal
 * runtime services to the shared `@brainstorm-os/editor` comments hooks (the
 * exact mirror of `apps/notes/src/store/comments-adapter.ts`). All bridge
 * logic (codec / filter / cache / liveness via `useVaultEntities`) lives in
 * the shared `useEntityCommentsAdapter`.
 *
 * Mutations need the full create/update/delete triple on the entities
 * service — absent any of them (preview / standalone / an older shell), the
 * adapter is null and the Comments tab stays hidden.
 */

import {
	type CommentMutationsService,
	type CommentsAdapter,
	useEntityCommentsAdapter,
	useOpenCommentBlockIds as useSharedOpenCommentBlockIds,
} from "@brainstorm-os/editor";
import { useMemo } from "react";
import { getJournalRuntime } from "../runtime";

function journalCommentMutations(): CommentMutationsService | null {
	const entities = getJournalRuntime()?.services?.entities;
	const create = entities?.create;
	const update = entities?.update;
	const del = entities?.delete;
	if (!entities || !create || !update || !del) return null;
	// `.call(entities, …)` keeps the preload service's `this` (the same idiom
	// the properties panel uses for `updateEntity.call`).
	return {
		create: (type, properties) => create.call(entities, type, properties),
		update: (id, patch) => update.call(entities, id, patch),
		delete: (id) => del.call(entities, id),
	};
}

/** Live `CommentsAdapter` for the focused day's entry, or null when there's
 *  no entry / the shell lacks the mutation surface. */
export function useJournalCommentsAdapter(noteId: string | null): CommentsAdapter | null {
	const runtime = useMemo(() => getJournalRuntime(), []);
	const mutations = useMemo(() => journalCommentMutations(), []);
	return useEntityCommentsAdapter(runtime?.services?.vaultEntities, mutations, noteId);
}

/** Live block ids of the entry's open comment threads, for the highlight. */
export function useOpenCommentBlockIds(noteId: string | null): readonly string[] {
	const runtime = useMemo(() => getJournalRuntime(), []);
	return useSharedOpenCommentBlockIds(runtime?.services?.vaultEntities, noteId);
}
