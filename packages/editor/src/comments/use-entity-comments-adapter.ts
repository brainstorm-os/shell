/**
 * Shared comments React bindings (B11.9) — the one place every editor app
 * (Notes / Journal / Tasks / Bookmarks) turns its shell services into a live
 * `CommentsAdapter` + the open-comment block ids for the highlight. Apps pass
 * their `vaultEntities` + entities-mutation services; nothing here is app-
 * specific (no `getBrainstorm`), so the ~130 lines of bridge logic live once.
 *
 * Liveness comes from the sanctioned reactivity stack (`@brainstorm-os/react-yjs`
 * `useVaultEntities`, which wraps the vault signal in the shared
 * `createQueryStore` coalescer) — NOT a hand-rolled `vaultEntities.onChange`
 * loop. The shared `createEntityCommentsAdapter` still owns the codec /
 * per-document filter / cache; this only feeds it a `CommentEntitiesService`
 * whose `subscribe` is driven by the React snapshot.
 */

import { useVaultEntities } from "@brainstorm-os/react-yjs";
import {
	COMMENT_TYPE_URL,
	type CommentDef,
	type VaultEntitiesSnapshot,
} from "@brainstorm-os/sdk-types";
import type { VaultEntitiesService } from "@brainstorm-os/sdk-types";
import { useEffect, useMemo, useRef } from "react";
import { openCommentBlockIds } from "./comment-blocks";
import {
	type CommentEntitiesService,
	type CommentEntity,
	type CommentsAdapter,
	createEntityCommentsAdapter,
	entityToComment,
} from "./comments-adapter";

type EntityLike = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
};

/** The minimal entities-service surface the adapter mutates — every shell's
 *  entities service satisfies this structurally. */
export type CommentMutationsService = {
	create(type: string, properties: Record<string, unknown>): Promise<EntityLike>;
	update(id: string, patch: Record<string, unknown>): Promise<EntityLike>;
	delete(id: string): Promise<void>;
};

/** Map a vault/entities-service record to the shared adapter's `CommentEntity`.
 *  Neither source carries a `createdBy` author identity yet, so it's left empty
 *  (the denormalized `authorName` property is the display source for now). */
function toCommentEntity(entity: EntityLike): CommentEntity {
	return {
		id: entity.id,
		type: entity.type,
		properties: entity.properties,
		createdBy: "",
		createdAt: entity.createdAt,
		updatedAt: entity.updatedAt,
	};
}

/** The live comment entities (any document) from a vault snapshot — pure, so
 *  the filter+map is unit-tested without React. */
export function commentEntitiesFromSnapshot(snapshot: VaultEntitiesSnapshot): CommentEntity[] {
	return snapshot.entities
		.filter((e) => e.type === COMMENT_TYPE_URL && e.deletedAt === null)
		.map(toCommentEntity);
}

/**
 * Live `CommentsAdapter` for one document, or null when there's no document /
 * the shell lacks an entities service. Disposes on document change.
 */
export function useEntityCommentsAdapter(
	vaultEntities: VaultEntitiesService | null | undefined,
	entities: CommentMutationsService | null | undefined,
	documentId: string | null,
): CommentsAdapter | null {
	const snapshot = useVaultEntities(vaultEntities ?? null);
	const commentEntities = useMemo(() => commentEntitiesFromSnapshot(snapshot), [snapshot]);

	// The shared adapter subscribes exactly once; we hold that single onUpdate
	// callback in a ref (not an accumulating Set) so a discarded React render
	// can't orphan a subscriber, and the latest comment entities in a ref so the
	// service can answer `query()` synchronously.
	const entitiesRef = useRef(commentEntities);
	entitiesRef.current = commentEntities;
	const pushRef = useRef<((entities: CommentEntity[]) => void) | null>(null);

	const adapter = useMemo<CommentsAdapter | null>(() => {
		if (!documentId || !entities) return null;
		const service: CommentEntitiesService = {
			query: () => Promise.resolve(entitiesRef.current),
			subscribe(_query, onUpdate) {
				pushRef.current = onUpdate;
				return {
					unsubscribe() {
						// Only clear OUR OWN registration. On a document switch the
						// new adapter subscribes during render, and React runs the
						// OLD adapter's dispose cleanup afterwards — an unconditional
						// null here would clobber the new subscriber and leave the
						// comments feed permanently dead for the new document.
						if (pushRef.current === onUpdate) pushRef.current = null;
					},
				};
			},
			create: (type, properties) => entities.create(type, properties).then(toCommentEntity),
			update: (id, patch) => entities.update(id, patch).then(toCommentEntity),
			delete: (id) => entities.delete(id),
		};
		return createEntityCommentsAdapter(service, documentId);
	}, [documentId, entities]);

	useEffect(() => () => adapter?.dispose(), [adapter]);

	// Feed the live snapshot to the adapter's subscriber whenever EITHER the
	// snapshot OR the adapter changes — a document switch swaps the adapter
	// without changing the snapshot identity, and the fresh adapter still
	// needs its first feed. The body reads the latest values through refs;
	// `adapter`/`commentEntities` are listed only as re-run TRIGGERS (so the
	// fresh adapter gets fed on a doc switch), not because the body reads them.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional re-run triggers, body reads refs
	useEffect(() => {
		pushRef.current?.(entitiesRef.current);
	}, [adapter, commentEntities]);

	return adapter;
}

/** Live block ids (session keys) of one document's open comment threads, for
 *  the in-editor highlight. Same sanctioned `useVaultEntities` source. */
export function useOpenCommentBlockIds(
	vaultEntities: VaultEntitiesService | null | undefined,
	documentId: string | null,
): readonly string[] {
	const snapshot = useVaultEntities(vaultEntities ?? null);
	return useMemo(() => {
		if (!documentId) return [];
		const comments = commentEntitiesFromSnapshot(snapshot)
			.map(entityToComment)
			.filter((c): c is CommentDef => c !== null && c.anchor.entityId === documentId);
		return openCommentBlockIds(comments);
	}, [snapshot, documentId]);
}
