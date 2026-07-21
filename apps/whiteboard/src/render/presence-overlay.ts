/**
 * Presence overlay (9.17.19) — paints remote peers' cursors and selection
 * outlines into a dedicated layer inside the camera-transformed canvas.
 *
 * Geometry: the layer shares the canvas transform, so cursors position in
 * raw canvas coordinates (no per-paint camera math). The cursor chrome
 * counter-scales via `--wb-inv-zoom` (set by the engine's camera paint)
 * so a cursor reads the same size at every zoom — the FigJam convention.
 *
 * Peer colour goes straight into inline styles (the `peerColor` hex
 * literals are deliberately not theme tokens — see
 * `@brainstorm-os/sdk/peer-presence`). Pure DOM: no engine state, no
 * listeners; the engine repaints on awareness change.
 */

import type { RemotePeer } from "../logic/presence";
import { remoteSelectionByNode } from "../logic/presence";

const SVG_NS = "http://www.w3.org/2000/svg";

export type PresenceNodeRect = { x: number; y: number; width: number; height: number };

function buildCursor(doc: Document, peer: RemotePeer): HTMLDivElement | null {
	if (!peer.cursor) return null;
	const el = doc.createElement("div");
	el.className = "whiteboard__presence-cursor";
	el.style.left = `${peer.cursor.x}px`;
	el.style.top = `${peer.cursor.y}px`;
	el.dataset.clientId = String(peer.clientId);

	const svg = doc.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", "whiteboard__presence-pointer");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("aria-hidden", "true");
	const path = doc.createElementNS(SVG_NS, "path");
	path.setAttribute("d", "M2 1.5l11 5.5-5 1.8L6 14z");
	path.setAttribute("fill", peer.color);
	svg.appendChild(path);
	el.appendChild(svg);

	if (peer.name) {
		const label = doc.createElement("span");
		label.className = "whiteboard__presence-name";
		label.style.background = peer.color;
		label.textContent = peer.name;
		el.appendChild(label);
	}
	return el;
}

function buildSelectionOutline(
	doc: Document,
	peer: RemotePeer,
	rect: PresenceNodeRect,
): HTMLDivElement {
	const el = doc.createElement("div");
	el.className = "whiteboard__presence-selection";
	el.style.left = `${rect.x}px`;
	el.style.top = `${rect.y}px`;
	el.style.width = `${rect.width}px`;
	el.style.height = `${rect.height}px`;
	el.style.borderColor = peer.color;
	el.dataset.clientId = String(peer.clientId);
	return el;
}

/** Rebuild the overlay from the current peers. Peer counts are tiny (a
 *  handful of collaborators), so a full `replaceChildren` per change is
 *  cheaper than diffing. */
export function renderPresenceOverlay(
	layer: HTMLElement,
	peers: readonly RemotePeer[],
	nodeRectById: ReadonlyMap<string, PresenceNodeRect>,
): void {
	const doc = layer.ownerDocument;
	const children: HTMLElement[] = [];
	for (const [nodeId, peer] of remoteSelectionByNode(peers)) {
		const rect = nodeRectById.get(nodeId);
		if (rect) children.push(buildSelectionOutline(doc, peer, rect));
	}
	for (const peer of peers) {
		const cursor = buildCursor(doc, peer);
		if (cursor) children.push(cursor);
	}
	layer.replaceChildren(...children);
}
