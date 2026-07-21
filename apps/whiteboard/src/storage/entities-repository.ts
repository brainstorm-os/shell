/**
 * Whiteboard repository over the **shared entities service** — the real
 * `entities.db`. Implements the `WhiteboardsRepository` contract the app's
 * call sites depend on.
 *
 * Two types read in one combined query; writes are get-then-create-or-update
 * keyed on the stable app-owned id. Domain `createdAt`/`updatedAt` + the
 * inline `nodes[]` + the `whiteboardId` FK all live in the property bag.
 * Plumbing lives in `@brainstorm-os/sdk/storage-repository`.
 */

import { deleteEntity, queryEntityRows, upsertEntity } from "@brainstorm-os/sdk/storage-repository";
import type { WhiteboardEdge } from "../types/edge";
import type { Whiteboard } from "../types/whiteboard";
import {
	parseStoredEdge,
	parseStoredWhiteboard,
	serializeEdge,
	serializeWhiteboard,
} from "./codec";
import type { WhiteboardsRepository } from "./repository";
import type { EntitiesService, EntityRecord } from "./runtime";

export const WHITEBOARD_TYPE = "brainstorm/Whiteboard/v1";
export const EDGE_TYPE = "brainstorm/WhiteboardEdge/v1";

function logError(op: string, err: unknown): void {
	console.warn(`[whiteboard/entities-repo] ${op} failed:`, err);
}

function whiteboardToProps(wb: Whiteboard): Record<string, unknown> {
	const { id: _id, ...props } = serializeWhiteboard(wb);
	return props;
}
function edgeToProps(e: WhiteboardEdge): Record<string, unknown> {
	const { id: _id, ...props } = serializeEdge(e);
	return props;
}
function entityToWhiteboard(e: EntityRecord): Whiteboard | null {
	return parseStoredWhiteboard({ ...e.properties, id: e.id });
}
function entityToEdge(e: EntityRecord): WhiteboardEdge | null {
	return parseStoredEdge({ ...e.properties, id: e.id });
}

export function createEntitiesRepository(entities: EntitiesService): WhiteboardsRepository {
	return {
		async listAll() {
			const rows = await queryEntityRows(entities, [WHITEBOARD_TYPE, EDGE_TYPE], "listAll", logError);
			const whiteboards: Whiteboard[] = [];
			const edges: WhiteboardEdge[] = [];
			for (const row of rows) {
				if (row.type === WHITEBOARD_TYPE) {
					const w = entityToWhiteboard(row as EntityRecord);
					if (w) whiteboards.push(w);
				} else if (row.type === EDGE_TYPE) {
					const e = entityToEdge(row as EntityRecord);
					if (e) edges.push(e);
				}
			}
			return { whiteboards, edges };
		},
		saveWhiteboard: (wb) =>
			upsertEntity(
				entities,
				WHITEBOARD_TYPE,
				wb.id,
				whiteboardToProps(wb),
				"saveWhiteboard",
				logError,
			),
		removeWhiteboard: (id) => deleteEntity(entities, id, "removeWhiteboard", logError),
		saveEdge: (edge) =>
			upsertEntity(entities, EDGE_TYPE, edge.id, edgeToProps(edge), "saveEdge", logError),
		removeEdge: (id) => deleteEntity(entities, id, "removeEdge", logError),
	};
}
