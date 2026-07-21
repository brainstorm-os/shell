/**
 * entity-doc-codec — the pure Y.Doc ⇄ `entities.db`-row projection.
 *
 * The entity's Y.Doc is the source of truth;
 * `entities.db` is a derived index. This module is the single transform
 * between the two:
 *
 *  - `writeEntityProps` / `writeEntityLinks` mutate the canonical doc's
 *    well-known property/link roots (used by the entities service's
 *    Y.Doc-first writes and by the seeder).
 *  - `readEntityDocProjection` reads those roots back into the plain
 *    `{ properties, links }` shape the repo materialises into a row. Run
 *    by the ydoc worker after every applied update — local or synced-in —
 *    so the SQLite projection tracks the CRDT.
 *
 * It is **pure** (yjs + sdk-types only, no SQLite / electron / fs), so it
 * is safe to import from the ydoc `utilityProcess` worker bundle as well
 * as the main process.
 *
 * A root that was never materialised on the doc is reported as *absent*
 * (the field is omitted), not as empty — so projecting a legacy
 * body-only doc never clobbers a row whose properties live only in
 * `entities.db`. Once an app writes the property map, the projection
 * becomes authoritative for the keys it carries.
 */

import {
	ENTITY_LINKS_ARRAY_NAME,
	ENTITY_PROPS_MAP_NAME,
	type EntityDocLink,
} from "@brainstorm-os/sdk-types";
import type * as Y from "yjs";

export type EntityDocProjection = {
	/** Present only when the doc carries a non-empty property map. */
	properties?: Record<string, unknown>;
	/** Present only when the doc carries a non-empty links array. */
	links?: EntityDocLink[];
};

/** True when a root of this name has been materialised on the doc (an
 *  update touched it, or it was explicitly `get`-d). Reading `doc.share`
 *  directly avoids `doc.getMap(name)` — which would *create* the root and
 *  defeat the absent-vs-empty distinction the projection relies on. */
function hasRoot(doc: Y.Doc, name: string): boolean {
	return doc.share.has(name);
}

/**
 * Set property entries on the entity doc's property map. Plain JSON values
 * only (atomic-replace merge per doc 06 §Decision); character-merged
 * fields graduate to `Y.Text` in a later iteration. Wrapped in one
 * transaction so a multi-key write emits a single update.
 */
export function writeEntityProps(doc: Y.Doc, properties: Record<string, unknown>): void {
	const map = doc.getMap<unknown>(ENTITY_PROPS_MAP_NAME);
	doc.transact(() => {
		for (const [key, value] of Object.entries(properties)) {
			map.set(key, value);
		}
	});
}

/**
 * Replace the entity doc's outgoing links with `links` (full set). Wrapped
 * in one transaction. Links are shell-derived with stable ids, so a
 * wholesale replace is the natural CRDT write for the owning device.
 */
export function writeEntityLinks(doc: Y.Doc, links: readonly EntityDocLink[]): void {
	const arr = doc.getArray<EntityDocLink>(ENTITY_LINKS_ARRAY_NAME);
	doc.transact(() => {
		if (arr.length > 0) arr.delete(0, arr.length);
		if (links.length > 0) arr.push([...links]);
	});
}

/**
 * Project the canonical doc into the plain shape the repo materialises.
 * Absent roots are omitted (not emptied) so a body-only doc projects to
 * `{}` and the caller skips the row write entirely.
 */
export function readEntityDocProjection(doc: Y.Doc): EntityDocProjection {
	const projection: EntityDocProjection = {};

	if (hasRoot(doc, ENTITY_PROPS_MAP_NAME)) {
		const props = doc.getMap<unknown>(ENTITY_PROPS_MAP_NAME).toJSON() as Record<string, unknown>;
		if (Object.keys(props).length > 0) projection.properties = props;
	}

	if (hasRoot(doc, ENTITY_LINKS_ARRAY_NAME)) {
		const links = doc.getArray<EntityDocLink>(ENTITY_LINKS_ARRAY_NAME).toJSON() as EntityDocLink[];
		const valid = links.filter(isEntityDocLink);
		if (valid.length > 0) projection.links = valid;
	}

	return projection;
}

function isEntityDocLink(value: unknown): value is EntityDocLink {
	if (!value || typeof value !== "object") return false;
	const link = value as Partial<EntityDocLink>;
	return (
		typeof link.id === "string" &&
		typeof link.destEntityId === "string" &&
		typeof link.linkType === "string" &&
		typeof link.createdAt === "number"
	);
}
