/**
 * Row resolution for the embedded Database block (9.12.24 — contextual inline
 * views). The block runs in the opaque-origin jail with only the BP graph
 * (`getEntity` / `queryEntities` by type), so it resolves a List the same way
 * the Database app does — `(source ∪ include) \ exclude`, then the default
 * view's filter + sort — through the SHARED `predicate-eval` stack, with the
 * host document threaded in as the `$host` context. A view filter like
 * "author contains this page" therefore resolves against the page the block
 * is dropped into, and against nothing when there is no host.
 *
 * Jail limits, by design: links are not visible to the block, so a `byLink`
 * source contributes no members here; a source with no type scope (`byFilter`,
 * `byVocabulary`) scans every readable entity.
 */

import { LIST_VIEW_ENTITY_TYPE, entityToListView } from "@brainstorm-os/sdk";
import {
	type Entity,
	type ListSource,
	ListSourceKind,
	type ListView,
} from "@brainstorm-os/sdk-types";
import type { EntityRow } from "@brainstorm-os/sdk/in-memory-entities";
import {
	type PredicateContext,
	applyMemberOverrides,
	evaluatePredicate,
	evaluateSource,
} from "@brainstorm-os/sdk/predicate-eval";
import { applyManualOrder, applySorts, flattenFilter } from "../../logic/compile-view";
import { MAX_ROWS } from "./format";

export interface BpEntity {
	entityId: string;
	entityTypeId: string;
	properties: Record<string, unknown>;
	updatedAt: number;
}

interface QueryResult {
	results?: { vertices?: Record<string, [BpEntity]> };
}

export type BlockGraph = <T>(messageName: string, data: unknown) => Promise<T>;

const SOURCE_KINDS = new Set<string>(Object.values(ListSourceKind));

function asId(member: unknown): string | null {
	if (typeof member === "string") return member;
	if (member && typeof member === "object") {
		const id = (member as { entityId?: unknown }).entityId ?? (member as { id?: unknown }).id;
		if (typeof id === "string") return id;
	}
	return null;
}

function memberIds(list: BpEntity, key: "include" | "exclude"): string[] {
	const raw = (list.properties.members as Record<string, unknown> | undefined)?.[key];
	if (!Array.isArray(raw)) return [];
	return raw.map(asId).filter((x): x is string => x !== null);
}

/** The List's `source` as a real `ListSource`. Pre-9.3.5 rows stored a bare
 *  `{ type }` (or `{ query: { type } }`); those read as `byType`. Anything
 *  else unrecognised is `null` — no source members, never a throw. */
export function readSource(list: BpEntity): ListSource | null {
	const raw = list.properties.source as Record<string, unknown> | null | undefined;
	if (!raw || typeof raw !== "object") return null;
	if (typeof raw.kind === "string" && SOURCE_KINDS.has(raw.kind)) return raw as ListSource;
	const legacy =
		typeof raw.type === "string"
			? raw.type
			: typeof (raw.query as { type?: unknown } | undefined)?.type === "string"
				? (raw.query as { type: string }).type
				: null;
	return legacy ? { kind: ListSourceKind.ByType, types: [legacy] } : null;
}

/** The entity types a source can draw members from, or `null` when some
 *  branch is unscoped by type and needs a full scan. */
export function sourceTypes(source: ListSource | null): string[] | null {
	if (source === null) return [];
	switch (source.kind) {
		case ListSourceKind.ByType:
			return source.types;
		case ListSourceKind.ByLink:
			return [];
		case ListSourceKind.ByFilter:
		case ListSourceKind.ByVocabulary:
			return null;
		case ListSourceKind.Composite: {
			const out = new Set<string>();
			for (const child of source.sources) {
				const types = sourceTypes(child);
				if (types === null) return null;
				for (const t of types) out.add(t);
			}
			return [...out];
		}
	}
}

function toRow(e: BpEntity): EntityRow {
	return {
		id: e.entityId,
		type: e.entityTypeId,
		properties: e.properties,
		createdAt: 0,
		updatedAt: e.updatedAt,
		deletedAt: null,
	};
}

function toEntity(e: BpEntity): Entity {
	return {
		id: e.entityId,
		type: e.entityTypeId,
		properties: e.properties,
		createdAt: 0,
		updatedAt: e.updatedAt,
	} as Entity;
}

async function queryVertices(graph: BlockGraph, entityTypeId?: string): Promise<BpEntity[]> {
	const res = await graph<QueryResult>("queryEntities", {
		operation: entityTypeId ? { entityTypeId } : {},
	});
	return Object.values(res.results?.vertices ?? {})
		.map((v) => v[0])
		.filter((x): x is BpEntity => !!x && typeof x.entityId === "string");
}

/** The view the embed paints: the List's `defaultViewId`, else its first
 *  listed view, else any view bound to the List. `null` ⇒ unfiltered. */
async function resolveView(graph: BlockGraph, list: BpEntity): Promise<ListView | null> {
	const views = (await queryVertices(graph, LIST_VIEW_ENTITY_TYPE).catch(() => []))
		.map((e) => entityToListView(toEntity(e)))
		.filter((v): v is ListView => v !== null && v.listId === list.entityId);
	if (views.length === 0) return null;
	const byId = new Map(views.map((v) => [v.id, v]));
	const preferred = [
		list.properties.defaultViewId,
		...(Array.isArray(list.properties.views) ? list.properties.views : []),
	];
	for (const id of preferred) {
		if (typeof id === "string" && byId.has(id)) return byId.get(id) ?? null;
	}
	return views[0] ?? null;
}

export async function resolveEmbeddedRows(
	graph: BlockGraph,
	list: BpEntity,
	hostEntityId: string | null,
): Promise<BpEntity[]> {
	return (await resolveEmbedded(graph, list, hostEntityId)).rows;
}

/** The embed's rows plus the view they were filtered + sorted by (the "New"
 *  affordance drafts from the same view). */
export async function resolveEmbedded(
	graph: BlockGraph,
	list: BpEntity,
	hostEntityId: string | null,
): Promise<{ rows: BpEntity[]; view: ListView | null }> {
	const ctx: PredicateContext = hostEntityId === null ? {} : { hostEntityId };
	const source = readSource(list);
	const types = sourceTypes(source);
	const candidates = new Map<string, BpEntity>();
	const batches =
		types === null
			? [await queryVertices(graph)]
			: await Promise.all(types.map((t) => queryVertices(graph, t)));
	for (const batch of batches) for (const e of batch) candidates.set(e.entityId, e);

	const include = memberIds(list, "include");
	const missing = include.filter((id) => !candidates.has(id)).slice(0, MAX_ROWS);
	const fetched = await Promise.all(
		missing.map((entityId) => graph<BpEntity>("getEntity", { entityId }).catch(() => null)),
	);
	for (const e of fetched) if (e) candidates.set(e.entityId, e);

	const rows = [...candidates.values()].map(toRow);
	const resolved = evaluateSource(source, { entities: rows, links: [] }, ctx);
	const effective = applyMemberOverrides(
		resolved,
		include.map((entityId) => ({ entityId })),
		memberIds(list, "exclude").map((entityId) => ({ entityId })),
	);

	const view = await resolveView(graph, list);
	const filter = view ? flattenFilter(view.filters) : null;
	const now = Date.now();
	const members = rows.filter(
		(r) => effective.has(r.id) && (filter === null || evaluatePredicate(r, filter, now, ctx)),
	);
	const sorted = view ? applySorts(members, view.sorts) : members;
	const ordered =
		view?.manualOrder && view.manualOrder.length > 0
			? applyManualOrder(sorted, view.manualOrder)
			: sorted;
	return { rows: ordered.slice(0, MAX_ROWS).map((r) => candidates.get(r.id) as BpEntity), view };
}
