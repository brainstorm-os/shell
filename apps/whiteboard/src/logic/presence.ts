/**
 * Whiteboard presence (9.17.19) — the pure core of remote cursors over the
 * Stage-10 sync spine.
 *
 * Presence rides the Yjs **awareness** channel: each client publishes its
 * `{ name, color, boardId, cursor, selection }` under the
 * {@link PRESENCE_FIELD} field of its awareness state; peers render what
 * they receive. This module owns the payload codec (encode = what we
 * publish; apply = hardening + deriving renderable peers from a state
 * map), so it is transport-agnostic: it works over the structural
 * `AwarenessLike` from `@brainstorm-os/react-yjs`, which both the local
 * no-transport channel (`createLocalAwareness`) and a real
 * `y-protocols/awareness` instance satisfy. The shell's Stage-10
 * `AwarenessBroadcaster` ferries real `Awareness` updates between
 * devices; binding one into the app sandbox is the residual transport
 * swap — everything here is unchanged by it.
 *
 * Hardening invariant: every field of a REMOTE state is untrusted (it
 * came from another device). `coercePresence` drops anything malformed,
 * sanitizes the display name via the shared inline-text hardening, caps
 * the selection list, and falls back to the deterministic peer colour
 * when the published colour isn't a plain hex literal.
 */

import { PEER_NAME_MAX_LEN, peerColor } from "@brainstorm-os/sdk/peer-presence";
import { sanitizeInlineText } from "@brainstorm-os/sdk/sanitize-text";

/** The awareness-state field whiteboard presence publishes under. */
export const PRESENCE_FIELD = "whiteboard";

/** Cap on how many selected-node ids a peer may publish — selection beyond
 *  this renders nothing extra and a hostile peer must not balloon memory. */
export const PRESENCE_SELECTION_CAP = 128;

export type PresenceCursor = { x: number; y: number };

/** The published payload. Plain JSON — awareness states are session-scoped
 *  and never persisted. */
export type WhiteboardPresence = {
	name: string;
	/** Plain `#rrggbb` literal — rendered into inline styles. */
	color: string;
	/** The board the client is looking at; peers on other boards drop out. */
	boardId: string;
	/** Canvas-space pointer, or `null` when the pointer left the canvas. */
	cursor: PresenceCursor | null;
	/** Selected node ids (bounded by {@link PRESENCE_SELECTION_CAP}). */
	selection: readonly string[];
};

/** A renderable remote peer (already hardened + same-board filtered). */
export type RemotePeer = WhiteboardPresence & { clientId: number };

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

/** Build the local payload to publish. `name` is already the bounded
 *  `localPresenceName()`; the colour is the deterministic per-client hue. */
export function buildLocalPresence(opts: {
	clientId: number;
	name: string;
	boardId: string;
	cursor: PresenceCursor | null;
	selection: ReadonlySet<string> | readonly string[];
}): WhiteboardPresence {
	const selection = [...opts.selection].slice(0, PRESENCE_SELECTION_CAP);
	return {
		name: opts.name,
		color: peerColor(opts.clientId),
		boardId: opts.boardId,
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

/** Harden one remote presence payload; `null` when unusable. */
export function coercePresence(v: unknown, clientId: number): WhiteboardPresence | null {
	if (!v || typeof v !== "object") return null;
	const r = v as Record<string, unknown>;
	if (typeof r.boardId !== "string" || r.boardId === "") return null;
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
		boardId: r.boardId,
		cursor: coerceCursor(r.cursor),
		selection,
	};
}

/** The renderable remote peers for `boardId` out of a raw awareness state
 *  map: local client excluded, payloads hardened, other boards dropped,
 *  stable clientId order (so colours/labels don't jitter between paints). */
export function presencePeers(
	states: ReadonlyMap<number, Record<string, unknown> | null>,
	localClientId: number,
	boardId: string,
): RemotePeer[] {
	const peers: RemotePeer[] = [];
	for (const [clientId, state] of states) {
		if (clientId === localClientId || !state) continue;
		const presence = coercePresence(state[PRESENCE_FIELD], clientId);
		if (!presence || presence.boardId !== boardId) continue;
		peers.push({ ...presence, clientId });
	}
	peers.sort((a, b) => a.clientId - b.clientId);
	return peers;
}

/** Which nodes are selected by which peer — first (lowest-clientId) peer
 *  wins a contested node. Drives the remote-selection outlines. */
export function remoteSelectionByNode(peers: readonly RemotePeer[]): Map<string, RemotePeer> {
	const byNode = new Map<string, RemotePeer>();
	for (const peer of peers) {
		for (const nodeId of peer.selection) {
			if (!byNode.has(nodeId)) byNode.set(nodeId, peer);
		}
	}
	return byNode;
}
