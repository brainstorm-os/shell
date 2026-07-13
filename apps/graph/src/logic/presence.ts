/**
 * Graph canvas presence (PRES-3d) — remote cursors + selection over the Pixi
 * canvas. Mirrors whiteboard's transport-agnostic awareness codec; the field
 * is `graph` (header stacks use the separate `presence` field via usePresence).
 */

import { PEER_NAME_MAX_LEN, peerColor } from "@brainstorm/sdk/peer-presence";
import { sanitizeInlineText } from "@brainstorm/sdk/sanitize-text";

export const PRESENCE_FIELD = "graph";

export const PRESENCE_SELECTION_CAP = 128;

export type PresenceCursor = { x: number; y: number };

export type GraphPresence = {
	name: string;
	color: string;
	graphId: string;
	cursor: PresenceCursor | null;
	selection: readonly string[];
};

export type RemotePeer = GraphPresence & { clientId: number };

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

export function buildLocalPresence(opts: {
	clientId: number;
	name: string;
	graphId: string;
	cursor: PresenceCursor | null;
	selection: ReadonlySet<string> | readonly string[];
}): GraphPresence {
	const selection = [...opts.selection].slice(0, PRESENCE_SELECTION_CAP);
	return {
		name: opts.name,
		color: peerColor(opts.clientId),
		graphId: opts.graphId,
		cursor: opts.cursor ? { x: opts.cursor.x, y: opts.cursor.y } : null,
		selection,
	};
}

function coerceCursor(v: unknown): PresenceCursor | null {
	if (!v || typeof v !== "object") return null;
	const c = v as Record<string, unknown>;
	if (typeof c.x !== "number" || !Number.isFinite(c.x)) return null;
	if (typeof c.y !== "number" || !Number.isFinite(c.y)) return null;
	return { x: c.x, y: c.y };
}

export function coercePresence(v: unknown, clientId: number): GraphPresence | null {
	if (!v || typeof v !== "object") return null;
	const r = v as Record<string, unknown>;
	if (typeof r.graphId !== "string" || r.graphId === "") return null;
	const name = sanitizeInlineText(r.name, PEER_NAME_MAX_LEN);
	const color =
		typeof r.color === "string" && HEX_COLOR.test(r.color) ? r.color : peerColor(clientId);
	const selection = Array.isArray(r.selection)
		? r.selection
				.filter((id): id is string => typeof id === "string" && id !== "")
				.slice(0, PRESENCE_SELECTION_CAP)
		: [];
	return {
		name,
		color,
		graphId: r.graphId,
		cursor: coerceCursor(r.cursor),
		selection,
	};
}

export function presencePeers(
	states: ReadonlyMap<number, Record<string, unknown> | null>,
	localClientId: number,
	graphId: string,
): RemotePeer[] {
	const peers: RemotePeer[] = [];
	for (const [clientId, state] of states) {
		if (clientId === localClientId || !state) continue;
		const presence = coercePresence(state[PRESENCE_FIELD], clientId);
		if (!presence || presence.graphId !== graphId) continue;
		peers.push({ ...presence, clientId });
	}
	peers.sort((a, b) => a.clientId - b.clientId);
	return peers;
}

export function remoteSelectionByNode(peers: readonly RemotePeer[]): Map<string, RemotePeer> {
	const byNode = new Map<string, RemotePeer>();
	for (const peer of peers) {
		for (const nodeId of peer.selection) {
			if (!byNode.has(nodeId)) byNode.set(nodeId, peer);
		}
	}
	return byNode;
}
