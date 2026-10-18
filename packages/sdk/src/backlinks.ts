/**
 * Backlinks / outgoing links over a vault snapshot — the ONE projection of
 * the shell's `links` rows into "what links here" and "what this links to".
 *
 * The entities service already walks every rich body (and relation
 * property) into `links` rows, so a renderer never re-walks bodies: it
 * filters the snapshot by source / dest and joins the other end for a title.
 * Extracted from Journal (9.16.10) when Preview's context panel (9.20.15)
 * became consumer two.
 *
 * Both walks drop self-links, soft-deleted ends, and duplicate pairs (a
 * body that mentions AND links the same object is one row, keeping the
 * first link type), and sort freshest-first.
 */

import { entityTitleOr } from "./entity-title";

export type LinkGraphEntity = {
	readonly id: string;
	readonly type: string;
	readonly properties: Record<string, unknown>;
	readonly updatedAt: number;
	readonly deletedAt: number | null;
};

export type LinkGraphLink = {
	readonly sourceEntityId: string;
	readonly destEntityId: string;
	readonly linkType: string;
};

export type LinkGraphSnapshot = {
	readonly entities: readonly LinkGraphEntity[];
	readonly links: readonly LinkGraphLink[];
};

/** The object at the OTHER end of a link, resolved for display + routing
 *  (its real type lets an open land in the right app). */
export type LinkedEntity = {
	entityId: string;
	entityType: string;
	title: string;
	updatedAt: number;
	linkType: string;
};

export const UNTITLED_LINKED_ENTITY = "(untitled)";

export type LinkWalkOptions = {
	/** Only these types count at the other end (absent = every type). */
	types?: ReadonlySet<string>;
	/** What a nameless object reads as. */
	untitled?: string;
};

enum LinkDirection {
	In = "in",
	Out = "out",
}

function walk(
	snapshot: LinkGraphSnapshot,
	entityId: string,
	direction: LinkDirection,
	options: LinkWalkOptions,
): LinkedEntity[] {
	if (!entityId) return [];
	const byId = new Map(snapshot.entities.map((e) => [e.id, e] as const));
	const out: LinkedEntity[] = [];
	const seen = new Set<string>();
	for (const link of snapshot.links) {
		const self = direction === LinkDirection.In ? link.destEntityId : link.sourceEntityId;
		const other = direction === LinkDirection.In ? link.sourceEntityId : link.destEntityId;
		if (self !== entityId || other === entityId || seen.has(other)) continue;
		const entity = byId.get(other);
		if (!entity || entity.deletedAt !== null) continue;
		if (options.types && !options.types.has(entity.type)) continue;
		seen.add(other);
		out.push({
			entityId: entity.id,
			entityType: entity.type,
			title: entityTitleOr(entity.properties, options.untitled ?? UNTITLED_LINKED_ENTITY),
			updatedAt: entity.updatedAt,
			linkType: link.linkType,
		});
	}
	out.sort((a, b) => b.updatedAt - a.updatedAt);
	return out;
}

/** Every live object that links TO `entityId`. */
export function findBacklinks(
	snapshot: LinkGraphSnapshot,
	entityId: string,
	options: LinkWalkOptions = {},
): LinkedEntity[] {
	return walk(snapshot, entityId, LinkDirection.In, options);
}

/** Every live object `entityId` links to. */
export function findOutgoingLinks(
	snapshot: LinkGraphSnapshot,
	entityId: string,
	options: LinkWalkOptions = {},
): LinkedEntity[] {
	return walk(snapshot, entityId, LinkDirection.Out, options);
}
