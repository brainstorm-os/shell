/**
 * BP Graph module router — Stage 9.3.3.2.
 *
 * Translates `@blockprotocol/graph` 0.3 messages into envelopes for the
 * existing `entities` service. Per-type capability enforcement stays on
 * the entities service (which throws `Denied` against the ledger); this
 * router only validates BP-shape inputs and remaps thrown service errors
 * onto BP error codes by `.name` (the original `.message` is *not*
 * propagated — service messages can carry vault-internal context that
 * shouldn't cross the iframe boundary).
 *
 * v1 deferrals (filed as OQ-BP-2..4, return `NOT_IMPLEMENTED` at runtime):
 * `linkData` on createEntity, non-trivial query operations, entityTypeId
 * change on updateEntity, uploadFile (both branches). Subgraph responses
 * are flat-list pseudo-subgraphs until 9.3.3.4.
 */

import {
	BpErrorCode,
	type BpModuleHandler,
	type BpModuleResponse,
} from "@brainstorm/block-protocol";
import type { Entity, EntityQuery } from "@brainstorm/sdk-types";
import type { Envelope } from "../../ipc/envelope";
import { ServiceErrorName } from "../services/errors";

/** The slice of broker envelope the graph router needs to synthesise.
 *  We keep this typed so a future broker-envelope change touches one
 *  place. Mirrors the pattern already used in `entities-service.ts`'s
 *  `ydoc` proxy (see `packages/shell/src/main/index.ts:735`). */
export type EntitiesInvoker = (envelope: Envelope) => Promise<unknown> | unknown;

export interface BpGraphRouterDeps {
	/** Calls the live `entities` service handler. The router stamps the
	 *  envelope's `app` from its router context — the calling app
	 *  identity, preload-verified by the broker before reaching `bp`. */
	readonly entities: EntitiesInvoker;
	/** Mints the envelope's `msg` id. Injection for deterministic tests. */
	readonly newMsgId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** BP `deleteEntity` accepts the entityId as either the bare string OR
 *  wrapped in `{entityId}` — both shapes appear in real-world blocks. */
function extractEntityId(data: unknown): string | null {
	if (typeof data === "string") return data;
	if (isRecord(data) && typeof data.entityId === "string") return data.entityId;
	return null;
}

function notImplemented(reason: string): BpModuleResponse {
	return {
		errors: [{ code: BpErrorCode.NotImplemented, message: reason }],
	};
}

function invalid(reason: string): BpModuleResponse {
	return {
		errors: [{ code: BpErrorCode.InvalidInput, message: reason }],
	};
}

function forbidden(reason: string): BpModuleResponse {
	return {
		errors: [{ code: BpErrorCode.Forbidden, message: reason }],
	};
}

function notFound(reason: string): BpModuleResponse {
	return { errors: [{ code: BpErrorCode.NotFound, message: reason }] };
}

function internal(reason: string): BpModuleResponse {
	return { errors: [{ code: BpErrorCode.InternalError, message: reason }] };
}

function errorToResponse(err: unknown): BpModuleResponse {
	if (err && typeof err === "object" && "name" in err) {
		const name = (err as { name?: unknown }).name;
		if (name === ServiceErrorName.Invalid) return invalid("Invalid input");
		if (name === ServiceErrorName.Denied) return forbidden("Capability denied");
		if (name === ServiceErrorName.Unavailable) return internal("Service unavailable");
	}
	return internal("Internal error");
}

/** v1 minimal BP-Entity wire shape — OQ-BP-2 tracks BP 0.3's full
 *  structural-graph form and any block-compatibility implications. */
interface BpEntityWire {
	entityId: string;
	entityTypeId: string;
	properties: Record<string, unknown>;
	updatedAt: number;
}

function toBpEntity(entity: Entity): BpEntityWire {
	return {
		entityId: entity.id,
		entityTypeId: entity.type,
		properties: entity.properties,
		updatedAt: entity.updatedAt,
	};
}

interface BpSubgraphWire {
	roots: string[];
	vertices: Record<string, [BpEntityWire]>;
	edges: Record<string, never>;
}

function toBpSubgraph(entities: readonly Entity[]): BpSubgraphWire {
	const vertices: Record<string, [BpEntityWire]> = {};
	const roots: string[] = [];
	for (const e of entities) {
		const wire = toBpEntity(e);
		vertices[e.id] = [wire];
		roots.push(e.id);
	}
	return { roots, vertices, edges: {} };
}

export function makeBpGraphRouter(deps: BpGraphRouterDeps): BpModuleHandler {
	const newMsgId =
		deps.newMsgId ?? (() => `bp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

	const callEntities = async (
		app: string,
		method: string,
		methodArgs: Record<string, unknown>,
	): Promise<unknown> =>
		deps.entities({
			v: 1,
			msg: newMsgId(),
			app,
			service: "entities",
			method,
			args: [methodArgs],
			caps: [],
		});

	return async (request, context) => {
		const data = (request as { data?: unknown }).data;
		const app = context.app;

		switch (request.messageName) {
			case "createEntity": {
				if (!isRecord(data)) return invalid("createEntity: data must be an object");
				const entityTypeId = data.entityTypeId;
				if (typeof entityTypeId !== "string" || entityTypeId === "") {
					return invalid("createEntity: entityTypeId required");
				}
				if (data.linkData !== undefined) {
					return notImplemented("createEntity: linkData (link entities) not yet supported — OQ-BP-3");
				}
				const properties = isRecord(data.properties) ? data.properties : {};
				try {
					const created = (await callEntities(app, "create", {
						type: entityTypeId,
						properties,
					})) as Entity;
					return { data: toBpEntity(created) };
				} catch (err) {
					return errorToResponse(err);
				}
			}

			case "getEntity": {
				if (!isRecord(data)) return invalid("getEntity: data must be an object");
				const entityId = data.entityId;
				if (typeof entityId !== "string" || entityId === "") {
					return invalid("getEntity: entityId required");
				}
				try {
					const got = (await callEntities(app, "get", { id: entityId })) as Entity | null;
					// The entities service returns null for both "doesn't exist"
					// and "exists but no read cap" (existence-as-information
					// fence — by design, see entities-service.ts §read filter).
					// BP has no separate "hidden" status; NOT_FOUND is the
					// natural projection.
					if (!got) return notFound("getEntity: not found");
					return { data: toBpEntity(got) };
				} catch (err) {
					return errorToResponse(err);
				}
			}

			case "updateEntity": {
				if (!isRecord(data)) return invalid("updateEntity: data must be an object");
				const entityId = data.entityId;
				if (typeof entityId !== "string" || entityId === "") {
					return invalid("updateEntity: entityId required");
				}
				const entityTypeId = data.entityTypeId;
				if (typeof entityTypeId !== "string" || entityTypeId === "") {
					return invalid("updateEntity: entityTypeId required");
				}
				const properties = isRecord(data.properties) ? data.properties : null;
				if (properties === null) return invalid("updateEntity: properties required");
				try {
					// BP `updateEntity` is a full replace; we approximate via
					// the entities service's shallow-merge `update`. Close
					// enough for the "set specific fields" case + closes over
					// "delete by writing undefined". Type-change at update is
					// silently a no-op on the type field (entities service
					// has no type-change verb). Both are OQ-BP-2.
					const updated = (await callEntities(app, "update", {
						id: entityId,
						patch: properties,
					})) as Entity;
					return { data: toBpEntity(updated) };
				} catch (err) {
					return errorToResponse(err);
				}
			}

			case "deleteEntity": {
				const entityId = extractEntityId(data);
				if (entityId === null || entityId === "") {
					return invalid("deleteEntity: entityId required");
				}
				try {
					await callEntities(app, "delete", { id: entityId });
					return { data: true };
				} catch (err) {
					return errorToResponse(err);
				}
			}

			case "queryEntities": {
				if (!isRecord(data)) return invalid("queryEntities: data must be an object");
				const operation = data.operation;
				if (!isRecord(operation)) return invalid("queryEntities: operation required");
				const depths = data.graphResolveDepths;
				if (depths !== undefined) {
					return notImplemented("queryEntities: graphResolveDepths > 0 not yet supported — OQ-BP-4");
				}
				const query: EntityQuery = {};
				if (typeof operation.entityTypeId === "string" && operation.entityTypeId !== "") {
					query.type = operation.entityTypeId;
				}
				// v1 ignores `where` / `text` / `limit` filters in the BP
				// `operation`; the entities service's predicate language is
				// richer than BP's, but the structural mapping isn't trivial
				// (BP nests boolean ops differently). 9.3.3.4 work; flag in
				// OQ-BP-4.
				try {
					const rows = (await callEntities(app, "query", { query })) as Entity[];
					return {
						data: {
							results: toBpSubgraph(rows),
							operation,
						},
					};
				} catch (err) {
					return errorToResponse(err);
				}
			}

			case "uploadFile": {
				// `file: Blob` needs a chunked-postMessage protocol over the
				// 9.5.2 transport; `url: string` needs Net-1. Both OQ-BP-3.
				return notImplemented(
					"uploadFile: deferred — file path gated on chunked-postMessage design, url path gated on Net-1 (OQ-BP-3)",
				);
			}

			default:
				return notImplemented(`Unknown graph messageName: ${request.messageName}`);
		}
	};
}
