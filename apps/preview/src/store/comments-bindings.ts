/**
 * Preview comments bindings — the exact mirror of Journal's
 * `comments-bindings.ts`: hand the Preview runtime services to the shared
 * `@brainstorm-os/editor` comments hook so the inspector's Comments tab is live.
 * All bridge logic (codec / filter / cache / liveness via `useVaultEntities`)
 * lives in the shared `useEntityCommentsAdapter`.
 *
 * Mutations need the full create/update/delete triple on the entities
 * service — absent any of them (standalone preview / an older shell), the
 * adapter is null and the Comments tab stays hidden (properties-only).
 */

import {
	type CommentMutationsService,
	type CommentsAdapter,
	useEntityCommentsAdapter,
} from "@brainstorm-os/editor";
import { useMemo } from "react";
import { getPreviewRuntime } from "../host/runtime";

function previewCommentMutations(): CommentMutationsService | null {
	const entities = getPreviewRuntime()?.services?.entities;
	const create = entities?.create;
	const update = entities?.update;
	const del = entities?.delete;
	if (!entities || !create || !update || !del) return null;
	return {
		create: (type, properties) => create.call(entities, type, properties),
		update: (id, patch) => update.call(entities, id, patch),
		delete: (id) => del.call(entities, id),
	};
}

/** Live `CommentsAdapter` for the file entity being previewed, or null when
 *  there's no entity / the shell lacks the mutation surface. */
export function usePreviewCommentsAdapter(entityId: string | null): CommentsAdapter | null {
	const runtime = useMemo(() => getPreviewRuntime(), []);
	const mutations = useMemo(() => previewCommentMutations(), []);
	return useEntityCommentsAdapter(runtime?.services?.vaultEntities, mutations, entityId);
}
