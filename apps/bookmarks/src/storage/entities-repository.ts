/**
 * Bookmarks repository over the **shared entities service** — the real
 * `entities.db`. Implements the `BookmarksRepository` contract the app's
 * call sites depend on.
 *
 * `save` is get-then-create-or-update keyed on `bookmark.id` (stable,
 * app-owned). The app's domain `createdAt`/`updatedAt` stay in the
 * property bag — the store owns entity-level timestamps and would clobber
 * them on every write. Plumbing lives in
 * `@brainstorm-os/sdk/storage-repository`.
 */

import { createEntityRepository } from "@brainstorm-os/sdk/storage-repository";
import { BOOKMARK_ENTITY_TYPE, type Bookmark } from "../types/bookmark";
import { parseStoredBookmark, serializeBookmark } from "./codec";
import type { BookmarksRepository } from "./repository";
import type { EntitiesService } from "./runtime";

function logError(op: string, err: unknown): void {
	console.warn(`[bookmarks/entities-repo] ${op} failed:`, err);
}

export function createEntitiesRepository(entities: EntitiesService): BookmarksRepository {
	return createEntityRepository<Bookmark>(entities, {
		type: BOOKMARK_ENTITY_TYPE,
		getId: (b) => b.id,
		toProps: (b) => {
			const { id: _id, ...props } = serializeBookmark(b);
			return props;
		},
		fromEntity: (e) => {
			const parsed = parseStoredBookmark({ ...e.properties, id: e.id });
			// Stamp the store-level revision (bumped on EVERY write, even a
			// foreign editor's) so `bookmarkListEquals` sees all changes.
			if (parsed && typeof e.updatedAt === "number") parsed.rev = e.updatedAt;
			return parsed;
		},
		log: logError,
	});
}
