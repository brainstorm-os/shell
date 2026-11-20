/**
 * `hasShareTrace` — has this entity's access record EVER involved anyone but
 * this vault's owner?
 *
 * The current membership (`resolveCurrentMembers`) cannot answer that: it is
 * read from a `Y.Array` inside the entity's own doc, and anyone who can write
 * the doc can delete entries from it, so a collaborator can make a shared
 * entity resolve to "nobody but the owner". What she cannot do is take
 * anything OUT of the owner's copy. A Yjs doc only grows: a sync update adds
 * structs and marks existing ones deleted, and a deleted or overwritten value
 * stays in the struct store as a tombstone. So instead of trusting what the
 * record says now, this reads what the record has been — any tombstone under
 * it, or any live entry that is not the owner's own self-grant, is a trace.
 *
 * Deliberately one-way and fail-closed: it can say "shared at some point"
 * about an entity that no longer is (a revoked collaborator, a record the
 * owner tidied by hand), never the reverse. It reads Yjs's internal item
 * lists (`_map`, `_start`), which is the only place tombstones are visible.
 */

import * as Y from "yjs";
import { getEntityMetaMap } from "../credentials/member-wraps";
import { ENTITY_ACCESS_KEY } from "./access-record";

type Shared = Y.AbstractType<unknown>;

function nestedType(item: Y.Item): Shared | null {
	return item.content instanceof Y.ContentType ? (item.content.type as Shared) : null;
}

/** True when anything under `root` was ever deleted or overwritten. */
function hasTombstone(root: Shared): boolean {
	const pending: Shared[] = [root];
	for (let type = pending.pop(); type; type = pending.pop()) {
		for (let item = type._start; item; item = item.right) {
			if (item.deleted) return true;
			const nested = nestedType(item);
			if (nested) pending.push(nested);
		}
		for (const latest of type._map.values()) {
			for (let item: Y.Item | null = latest; item; item = item.left) {
				if (item.deleted) return true;
				const nested = nestedType(item);
				if (nested) pending.push(nested);
			}
		}
	}
	return false;
}

export function hasShareTrace(doc: Y.Doc, selfPubB64: string): boolean {
	const latest = getEntityMetaMap(doc)._map.get(ENTITY_ACCESS_KEY);
	if (!latest) return false;
	for (let item: Y.Item | null = latest; item; item = item.left) {
		if (item.deleted) return true;
	}
	const record = nestedType(latest);
	if (!(record instanceof Y.Array)) return true;
	if (hasTombstone(record)) return true;
	for (const entry of record.toArray() as unknown[]) {
		if (!(entry instanceof Y.Map)) return true;
		if (entry.get("member") !== selfPubB64 || entry.get("addedBy") !== selfPubB64) return true;
	}
	return false;
}
