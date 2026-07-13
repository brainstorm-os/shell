/**
 * Graph presence overlay — screen-space cursors + node selection rings over
 * the canvas container. World coordinates from peers are projected through the
 * live camera transform on each paint.
 */

import type { RemotePeer } from "../logic/presence";
import { remoteSelectionByNode } from "../logic/presence";

const SVG_NS = "http://www.w3.org/2000/svg";

export type PresenceNodeScreen = {
	x: number;
	y: number;
	radiusPx: number;
};

function buildCursor(
	doc: Document,
	peer: RemotePeer,
	screen: { x: number; y: number },
): HTMLDivElement {
	const el = doc.createElement("div");
	el.className = "graph__presence-cursor";
	el.style.left = `${screen.x}px`;
	el.style.top = `${screen.y}px`;
	el.dataset.clientId = String(peer.clientId);

	const svg = doc.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", "graph__presence-pointer");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("aria-hidden", "true");
	const path = doc.createElementNS(SVG_NS, "path");
	path.setAttribute("d", "M2 1.5l11 5.5-5 1.8L6 14z");
	path.setAttribute("fill", peer.color);
	svg.appendChild(path);
	el.appendChild(svg);

	if (peer.name) {
		const label = doc.createElement("span");
		label.className = "graph__presence-name";
		label.style.background = peer.color;
		label.textContent = peer.name;
		el.appendChild(label);
	}
	return el;
}

function buildSelectionRing(
	doc: Document,
	peer: RemotePeer,
	screen: PresenceNodeScreen,
): HTMLDivElement {
	const size = screen.radiusPx * 2;
	const el = doc.createElement("div");
	el.className = "graph__presence-selection";
	el.style.left = `${screen.x - screen.radiusPx}px`;
	el.style.top = `${screen.y - screen.radiusPx}px`;
	el.style.width = `${size}px`;
	el.style.height = `${size}px`;
	el.style.borderColor = peer.color;
	el.dataset.clientId = String(peer.clientId);
	return el;
}

export function renderPresenceOverlay(
	layer: HTMLElement,
	peers: readonly RemotePeer[],
	nodeScreenById: ReadonlyMap<string, PresenceNodeScreen>,
	projectCursor: (world: { x: number; y: number }) => { x: number; y: number },
): void {
	const doc = layer.ownerDocument;
	const children: HTMLElement[] = [];
	for (const [nodeId, peer] of remoteSelectionByNode(peers)) {
		const screen = nodeScreenById.get(nodeId);
		if (screen) children.push(buildSelectionRing(doc, peer, screen));
	}
	for (const peer of peers) {
		if (!peer.cursor) continue;
		children.push(buildCursor(doc, peer, projectCursor(peer.cursor)));
	}
	layer.replaceChildren(...children);
}
