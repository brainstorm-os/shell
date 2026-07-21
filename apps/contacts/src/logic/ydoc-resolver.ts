/**
 * Renderer-side Y.Doc replica resolver. The singleton accessor lives in
 * `@brainstorm-os/react-yjs` (`createYDocResolverAccessor`, shared with Notes /
 * Journal / Tasks / Bookmarks / Code Editor); this wires it to the Contacts
 * runtime getter.
 *
 * Standalone fallback: the preview drop (`vite preview`, Playwright harness
 * without the preload) exposes no `services.entities` doc surface;
 * `getYDocResolverApi()` returns null. `getContactsResolver()` then hands
 * back an in-memory resolver (no transport persistence) so the detail's
 * `<BrainstormEditor>` still mounts on a real Y.Doc seeded from the legacy
 * `bio` string — the body just isn't persisted outside the session.
 */

import {
	type YDocResolver,
	createYDocResolver,
	createYDocResolverAccessor,
} from "@brainstorm-os/react-yjs";
import { getBrainstorm } from "../runtime";

export const getYDocResolverApi = createYDocResolverAccessor(getBrainstorm);

let inMemory: YDocResolver | null = null;

/** Resolve the entity→Y.Doc resolver the contact body editor binds through.
 *  The shell-installed resolver (persisted Y.Doc bodies) when available; an
 *  in-memory ephemeral resolver otherwise (preview / standalone), built once
 *  and cached so re-renders reuse the same per-id replica. */
export function getContactsResolver(): YDocResolver {
	const api = getYDocResolverApi();
	if (api) return api.resolve;
	if (!inMemory) {
		inMemory = createYDocResolver({
			load: async () => null,
			persist: () => {},
			release: () => {},
		}).resolve;
	}
	return inMemory;
}
