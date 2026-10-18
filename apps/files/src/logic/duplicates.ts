/**
 * Duplicate detection (9.8.16). Every stored upload carries the content
 * hash `files.import` computed over its bytes (persisted as `hash`), so two
 * File rows with the same hash ARE the same bytes, whatever they are named
 * or wherever they live. Grouping is exact — no fuzzy name/size heuristics.
 */

import { type Entity, FILE_TYPE, readContentHash, readSize } from "../types/entity";

export type DuplicateGroup = {
	hash: string;
	/** Oldest first — the earliest import reads as "the original". */
	entities: Entity[];
	/** Size of one copy. */
	size: number;
	/** Bytes the extra copies occupy (`size × (copies − 1)`). */
	reclaimableBytes: number;
};

/** Group live File rows by content hash, keeping only groups with ≥2 rows.
 *  Groups order by reclaimable bytes (biggest win first), then hash so the
 *  order is stable across renders. */
export function findDuplicateGroups(entities: readonly Entity[]): DuplicateGroup[] {
	const byHash = new Map<string, Entity[]>();
	for (const entity of entities) {
		if (entity.type !== FILE_TYPE || entity.deletedAt !== null) continue;
		const hash = readContentHash(entity);
		if (hash === null) continue;
		const bucket = byHash.get(hash);
		if (bucket) bucket.push(entity);
		else byHash.set(hash, [entity]);
	}
	const groups: DuplicateGroup[] = [];
	for (const [hash, members] of byHash) {
		if (members.length < 2) continue;
		members.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
		const size = Math.max(...members.map(readSize));
		groups.push({
			hash,
			entities: members,
			size,
			reclaimableBytes: size * (members.length - 1),
		});
	}
	groups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes || a.hash.localeCompare(b.hash));
	return groups;
}
