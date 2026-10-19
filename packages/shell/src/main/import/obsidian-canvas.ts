/**
 * IE-5 tail — Obsidian `.canvas` → Whiteboard importer.
 *
 * Obsidian's JSON Canvas (`.canvas`) is a `{ nodes, edges }` document. This maps
 * it onto the vault's Whiteboard model: one `brainstorm/Whiteboard/v1` per canvas
 * (nodes inlined per OQ-WB-1) plus one `brainstorm/WhiteboardEdge/v1` per
 * connector. Pure + transport-injected like the rest of the IE importers.
 *
 * Wire shapes (enum *values* are the persisted strings the Whiteboard app reads —
 * referenced as literals here because the shell must not import an app's TS):
 *   node.kind  "text" | "group"        (canvas text/file/link → text, group → group)
 *   handle     "top"|"right"|"bottom"|"left"
 *   pathKind   "bezier"  · arrowHead "arrow"
 * Canvas `file`/`link`/`group` nodes import as labelled text nodes with their
 * geometry preserved (lossless for content + layout); richer node-kind fidelity
 * (embedding the linked file, true group containers) is a later refinement.
 */

import { ulid } from "ulid";
import type { VaultSession } from "../vault/session";
import { ImportEntitiesRepository } from "./import-repo";
import { IMPORT_EXTERNAL_ID_PROP } from "./import-types";

export const WHITEBOARD_TYPE = "brainstorm/Whiteboard/v1";
export const WHITEBOARD_EDGE_TYPE = "brainstorm/WhiteboardEdge/v1";

const DEFAULT_NODE_WIDTH = 250;
const DEFAULT_NODE_HEIGHT = 60;
const CANVAS_SIDES = new Set(["top", "right", "bottom", "left"]);

/** A normalized whiteboard node draft (the persisted `Whiteboard.nodes[]` shape). */
export type CanvasNodeDraft = {
	readonly id: string;
	readonly kind: "text" | "group";
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly text: string;
};

export type CanvasEdgeDraft = {
	readonly id: string;
	readonly sourceNodeId: string;
	readonly sourceHandle: string;
	readonly destNodeId: string;
	readonly destHandle: string;
	readonly label: string | null;
};

export type CanvasPlan = {
	readonly nodes: readonly CanvasNodeDraft[];
	readonly edges: readonly CanvasEdgeDraft[];
};

function num(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function handle(value: unknown, fallback: string): string {
	return typeof value === "string" && CANVAS_SIDES.has(value) ? value : fallback;
}

/** Map one canvas node object onto a text/group node draft. `file`/`link` nodes
 *  surface their path/url as text; `text` nodes carry their markdown; `group`
 *  nodes carry their label. Unknown kinds fall back to an empty text node. */
function nodeDraft(raw: Record<string, unknown>): CanvasNodeDraft | null {
	const id = str(raw.id);
	if (id.length === 0) return null;
	const type = str(raw.type);
	const base = {
		id,
		x: num(raw.x, 0),
		y: num(raw.y, 0),
		width: num(raw.width, DEFAULT_NODE_WIDTH),
		height: num(raw.height, DEFAULT_NODE_HEIGHT),
	};
	if (type === "group") {
		return { ...base, kind: "group", text: str(raw.label) };
	}
	const text = type === "file" ? str(raw.file) : type === "link" ? str(raw.url) : str(raw.text);
	return { ...base, kind: "text", text };
}

/** Parse a JSON Canvas document into normalized node + edge drafts. Defensive
 *  over untrusted JSON: a malformed node/edge is skipped, never thrown on. */
export function parseObsidianCanvas(json: unknown): CanvasPlan {
	if (!json || typeof json !== "object") return { nodes: [], edges: [] };
	const doc = json as { nodes?: unknown; edges?: unknown };
	const nodes: CanvasNodeDraft[] = [];
	const nodeIds = new Set<string>();
	if (Array.isArray(doc.nodes)) {
		for (const raw of doc.nodes) {
			if (!raw || typeof raw !== "object") continue;
			const draft = nodeDraft(raw as Record<string, unknown>);
			if (draft && !nodeIds.has(draft.id)) {
				nodes.push(draft);
				nodeIds.add(draft.id);
			}
		}
	}
	const edges: CanvasEdgeDraft[] = [];
	if (Array.isArray(doc.edges)) {
		for (const raw of doc.edges) {
			if (!raw || typeof raw !== "object") continue;
			const e = raw as Record<string, unknown>;
			const id = str(e.id);
			const sourceNodeId = str(e.fromNode);
			const destNodeId = str(e.toNode);
			// Only connect edges whose endpoints are real nodes in this canvas.
			if (id.length === 0 || !nodeIds.has(sourceNodeId) || !nodeIds.has(destNodeId)) continue;
			const label = str(e.label);
			edges.push({
				id,
				sourceNodeId,
				sourceHandle: handle(e.fromSide, "right"),
				destNodeId,
				destHandle: handle(e.toSide, "left"),
				label: label.length > 0 ? label : null,
			});
		}
	}
	return { nodes, edges };
}

/** One source `.canvas` file. `name` is the board title (filename without ext). */
export type CanvasFile = {
	readonly path: string;
	readonly name: string;
	readonly json: unknown;
};

export type CanvasImportOptions = {
	readonly source: string;
	readonly now: number;
	readonly importedBy: string;
};

export type CanvasImportReport = {
	readonly boardsCreated: number;
	readonly boardsUpdated: number;
	readonly edgesCreated: number;
};

/** Commit parsed canvases into the vault: one `Whiteboard/v1` per file (idempotent
 *  on the source path), each board's edges as `WhiteboardEdge/v1` entities keyed
 *  on the canvas edge id so re-import updates rather than duplicates. */
export async function importObsidianCanvas(
	session: VaultSession,
	files: readonly CanvasFile[],
	options: CanvasImportOptions,
): Promise<CanvasImportReport> {
	const repo = new ImportEntitiesRepository(await session.dataStores.open("entities"));
	let boardsCreated = 0;
	let boardsUpdated = 0;
	let edgesCreated = 0;

	for (const file of files) {
		const plan = parseObsidianCanvas(file.json);
		const boardKey = `${options.source}:${file.path}`;
		const existingBoard = repo.listIdsWithProperty(IMPORT_EXTERNAL_ID_PROP, boardKey)[0] ?? null;
		const boardProps: Record<string, unknown> = {
			name: file.name,
			nodes: plan.nodes,
			updatedAt: options.now,
			[IMPORT_EXTERNAL_ID_PROP]: boardKey,
		};
		let boardId: string;
		if (existingBoard !== null) {
			repo.update(existingBoard, boardProps, options.now);
			boardId = existingBoard;
			boardsUpdated++;
		} else {
			boardId = `ent_${ulid()}`;
			repo.create({
				id: boardId,
				type: WHITEBOARD_TYPE,
				properties: { ...boardProps, createdAt: options.now },
				createdBy: options.importedBy,
				now: options.now,
				dekId: null,
			});
			boardsCreated++;
		}

		for (const edge of plan.edges) {
			const edgeKey = `${options.source}:edge:${file.path}:${edge.id}`;
			const existingEdge = repo.listIdsWithProperty(IMPORT_EXTERNAL_ID_PROP, edgeKey)[0] ?? null;
			const edgeProps: Record<string, unknown> = {
				whiteboardId: boardId,
				sourceNodeId: edge.sourceNodeId,
				sourceHandle: edge.sourceHandle,
				destNodeId: edge.destNodeId,
				destHandle: edge.destHandle,
				pathKind: "bezier",
				arrowHead: "arrow",
				label: edge.label,
				colorHint: null,
				updatedAt: options.now,
				[IMPORT_EXTERNAL_ID_PROP]: edgeKey,
			};
			if (existingEdge !== null) {
				repo.update(existingEdge, edgeProps, options.now);
			} else {
				repo.create({
					id: `ent_${ulid()}`,
					type: WHITEBOARD_EDGE_TYPE,
					properties: { ...edgeProps, createdAt: options.now },
					createdBy: options.importedBy,
					now: options.now,
					dekId: null,
				});
				edgesCreated++;
			}
		}
	}

	return { boardsCreated, boardsUpdated, edgesCreated };
}
