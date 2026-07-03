/**
 * Widget list-query narrowing (F-384) — the pure halves of the
 * `widget-bridge:list-entities` handler, electron-free so they unit-test
 * in-process (the same split as the workers' `handle*Envelope` functions).
 *
 * Without a query every widget receives its app's ENTIRE readable entity
 * list to render a handful of rows — seven widgets × every vault-entities
 * staleness tick re-ships the whole vault into each sandboxed iframe.
 */

import type { VaultEntitiesSnapshot } from "../entities/vault-entities-service";

/** Optional query a widget passes to `vaultEntities.list()`. `types` filters
 *  server-side; `limit` additionally implies live-only (deletedAt null) +
 *  newest-`updatedAt`-first, so "top N" is deterministic and a widget needn't
 *  re-implement the recency cut. */
export type WidgetListQuery = { types?: readonly string[]; limit?: number };

const WIDGET_LIST_LIMIT_MAX = 500;

/** Parse the untrusted wire value into a validated query (null = no query). */
export function parseWidgetListQuery(raw: unknown): WidgetListQuery | null {
	if (!raw || typeof raw !== "object") return null;
	const { types, limit } = raw as { types?: unknown; limit?: unknown };
	const query: WidgetListQuery = {};
	if (Array.isArray(types) && types.every((t) => typeof t === "string")) {
		query.types = types as string[];
	}
	if (typeof limit === "number" && Number.isFinite(limit) && limit >= 1) {
		query.limit = Math.min(Math.floor(limit), WIDGET_LIST_LIMIT_MAX);
	}
	return query.types || query.limit ? query : null;
}

/** Capability gate for a widget list call. An app holding the wildcard read
 *  may list everything (query optional, a pure narrowing). An app holding only
 *  scoped reads (e.g. Books: `entities.read:brainstorm/Book/v1`) may list too —
 *  but ONLY through a typed query whose every type it has been granted; the
 *  filter is then enforcement, not optimisation. Anything else is denied. */
export function resolveWidgetListAccess(
	hasCap: (capability: string) => boolean,
	query: WidgetListQuery | null,
): { allowed: boolean; enforced: WidgetListQuery | null } {
	if (hasCap("entities.read:*")) return { allowed: true, enforced: query };
	const types = query?.types;
	if (types && types.length > 0 && types.every((t) => hasCap(`entities.read:${t}`))) {
		return { allowed: true, enforced: query };
	}
	return { allowed: false, enforced: null };
}

/** Apply a validated query to a full snapshot. Links are re-filtered to
 *  surviving destinations, mirroring the service's dangling-link rule. */
export function filterWidgetSnapshot(
	snapshot: VaultEntitiesSnapshot,
	query: WidgetListQuery,
): VaultEntitiesSnapshot {
	let entities = snapshot.entities;
	if (query.types) {
		const wanted = new Set(query.types);
		entities = entities.filter((e) => wanted.has(e.type));
	}
	if (query.limit !== undefined) {
		entities = entities
			.filter((e) => e.deletedAt === null)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, query.limit);
	}
	if (entities === snapshot.entities) return snapshot;
	const kept = new Set(entities.map((e) => e.id));
	return { entities, links: snapshot.links.filter((l) => kept.has(l.destEntityId)) };
}
