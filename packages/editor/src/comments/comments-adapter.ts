/**
 * Comments data adapter — the seam between the shared editor comments UI and
 * a host app's storage. Every editor consumer (Notes / Journal / Tasks
 * inspector / Bookmarks) gets the identical comments panel + controller; they
 * differ only in this adapter, so the surface stays consistent (the shared
 * inline-toolbar / format-chord pattern, applied to annotations).
 *
 * `createEntityCommentsAdapter` is the production adapter: it round-trips
 * `brainstorm/Comment/v1` entities through an injected `EntitiesService`
 * (structurally typed so the editor never imports the concrete shell service)
 * and keeps a live cache via the service's subscription. The codec
 * (`commentToEntityProperties` / `entityToComment`) is the one mapping every
 * read/write goes through — the comments analog of the SDK list-entity codec.
 */

import {
	COMMENT_TYPE_URL,
	type CommentAnchor,
	type CommentDef,
	CommentKind,
	type CommentSuggestion,
	isCommentKind,
} from "@brainstorm-os/sdk-types";

/** A new comment to create. `kind` defaults to `CommentKind.Comment`, `parentId` to
 *  `null` (a top-level comment). A reply passes the root's anchor + its id. */
export type AddCommentInput = {
	anchor: CommentAnchor;
	body: string;
	/** Serialized Lexical state (JSON) when authored in the rich composer. */
	richBody?: string;
	kind?: CommentKind;
	parentId?: string | null;
	authorName?: string;
	suggestion?: CommentSuggestion;
	/** Sovereign pubkeys of people @-mentioned in the body (Collab-C6). */
	mentions?: string[];
	/** The author's sovereign pubkey (Collab-C6) — stamped so a mention can be
	 *  attributed + self-mentions suppressed by the notifier. */
	authorPubkey?: string;
};

/** The storage seam consumed by `CommentsProvider`. `list()` returns the
 *  current cache (synchronous — the adapter owns the subscription); mutations
 *  are async and trigger an `onChange` notification once they land. */
export type CommentsAdapter = {
	list(): CommentDef[];
	subscribe(onChange: () => void): () => void;
	add(input: AddCommentInput): Promise<void>;
	resolve(id: string): Promise<void>;
	reopen(id: string): Promise<void>;
	remove(id: string): Promise<void>;
	/** Release the underlying subscription. */
	dispose(): void;
};

/** Structural subset of the entities service the adapter needs — kept narrow
 *  so the editor package doesn't depend on the concrete shell service. */
export type CommentEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
};

export type CommentEntitiesService = {
	query(query: { type?: string | string[] }): Promise<CommentEntity[]>;
	subscribe(
		query: { type?: string | string[] },
		onUpdate: (entities: CommentEntity[]) => void,
	): { unsubscribe(): void };
	create(type: string, properties: Record<string, unknown>): Promise<CommentEntity>;
	update(id: string, patch: Record<string, unknown>): Promise<CommentEntity>;
	delete(id: string): Promise<void>;
};

/** `CommentDef` → the entity `properties` bag. Entity-owned fields (`id`,
 *  `createdAt`, `updatedAt`, `createdBy`=author identity) are NOT duplicated
 *  into properties — they live on the entity. `documentId` is the flat anchor
 *  key the list query filters on. */
export function commentToEntityProperties(comment: CommentDef): Record<string, unknown> {
	const props: Record<string, unknown> = {
		documentId: comment.anchor.entityId,
		blockId: comment.anchor.blockId,
		kind: comment.kind,
		body: comment.body,
		parentId: comment.parentId,
		resolvedAt: comment.resolvedAt,
	};
	if (comment.richBody !== undefined) props.richBody = comment.richBody;
	if (comment.anchor.quote !== undefined) props.quote = comment.anchor.quote;
	if (comment.anchor.range !== undefined) {
		props.rangeStart = comment.anchor.range.start;
		props.rangeEnd = comment.anchor.range.end;
	}
	if (comment.authorName !== undefined) props.authorName = comment.authorName;
	if (comment.suggestion !== undefined) props.suggestionReplacement = comment.suggestion.replacement;
	if (comment.mentions !== undefined && comment.mentions.length > 0)
		props.mentions = comment.mentions;
	return props;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** Entity → `CommentDef`. Defensive: wrong type or a missing required field
 *  → `null` (so one malformed row never crashes the panel). */
export function entityToComment(entity: CommentEntity): CommentDef | null {
	if (entity.type !== COMMENT_TYPE_URL) return null;
	const p = entity.properties;
	const documentId = str(p.documentId);
	const blockId = str(p.blockId);
	const body = str(p.body);
	if (documentId === undefined || blockId === undefined || body === undefined) return null;
	const rawKind = str(p.kind);
	const kind: CommentKind =
		rawKind !== undefined && isCommentKind(rawKind) ? rawKind : CommentKind.Comment;

	const anchor: CommentAnchor = { entityId: documentId, blockId };
	const quote = str(p.quote);
	if (quote !== undefined) anchor.quote = quote;
	const rangeStart = num(p.rangeStart);
	const rangeEnd = num(p.rangeEnd);
	if (rangeStart !== undefined && rangeEnd !== undefined) {
		anchor.range = { start: rangeStart, end: rangeEnd };
	}

	const comment: CommentDef = {
		id: entity.id,
		kind,
		anchor,
		body,
		parentId: str(p.parentId) ?? null,
		createdAt: entity.createdAt,
		updatedAt: entity.updatedAt,
		resolvedAt: num(p.resolvedAt) ?? null,
	};
	const richBody = str(p.richBody);
	if (richBody !== undefined) comment.richBody = richBody;
	const authorName = str(p.authorName);
	if (authorName !== undefined) comment.authorName = authorName;
	if (Array.isArray(p.mentions)) {
		const mentions = p.mentions.filter((m): m is string => typeof m === "string");
		if (mentions.length > 0) comment.mentions = mentions;
	}
	if (entity.createdBy.length > 0) comment.authorId = entity.createdBy;
	const replacement = str(p.suggestionReplacement);
	if (kind === CommentKind.Suggestion && replacement !== undefined)
		comment.suggestion = { replacement };
	return comment;
}

export type EntityCommentsAdapterOptions = {
	/** Wall-clock source for `resolvedAt` — injected so the adapter is testable
	 *  without a real clock. Defaults to `Date.now`. */
	now?: () => number;
};

/**
 * Production adapter: live `Comment/v1` cache for one document over the
 * entities service. Subscribes to all comment entities and filters to this
 * document's anchor client-side (comment volume per document is small, so a
 * type-scoped subscription + local filter is robust without depending on the
 * service's predicate dialect).
 */
export function createEntityCommentsAdapter(
	service: CommentEntitiesService,
	documentId: string,
	options: EntityCommentsAdapterOptions = {},
): CommentsAdapter {
	const now = options.now ?? Date.now;
	let cache: CommentDef[] = [];
	const listeners = new Set<() => void>();
	const notify = (): void => {
		for (const l of listeners) l();
	};
	const ingest = (entities: CommentEntity[]): void => {
		cache = entities
			.map(entityToComment)
			.filter((c): c is CommentDef => c !== null && c.anchor.entityId === documentId);
		notify();
	};

	const sub = service.subscribe({ type: COMMENT_TYPE_URL }, ingest);

	return {
		list: () => cache,
		subscribe(onChange) {
			listeners.add(onChange);
			return () => listeners.delete(onChange);
		},
		async add(input) {
			const comment: CommentDef = {
				id: "",
				kind: input.kind ?? CommentKind.Comment,
				anchor: input.anchor,
				body: input.body,
				parentId: input.parentId ?? null,
				createdAt: 0,
				updatedAt: 0,
				resolvedAt: null,
			};
			if (input.richBody !== undefined) comment.richBody = input.richBody;
			if (input.authorName !== undefined) comment.authorName = input.authorName;
			if (input.suggestion !== undefined) comment.suggestion = input.suggestion;
			if (input.mentions !== undefined && input.mentions.length > 0) comment.mentions = input.mentions;
			const props = commentToEntityProperties(comment);
			// Stamp the author pubkey on the entity (not modelled on CommentDef —
			// only the mention notifier reads it, from the raw properties).
			if (input.authorPubkey) props.authorPubkey = input.authorPubkey;
			await service.create(COMMENT_TYPE_URL, props);
		},
		async resolve(id) {
			await service.update(id, { resolvedAt: now() });
		},
		async reopen(id) {
			await service.update(id, { resolvedAt: null });
		},
		async remove(id) {
			await service.delete(id);
		},
		dispose() {
			sub.unsubscribe();
			listeners.clear();
		},
	};
}
