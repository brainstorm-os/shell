/**
 * Wires live canvas presence (PRES-3d) onto the graph controller: awareness
 * channel, pointer publishing, and the screen-space overlay layer.
 */

import type { LocalAwareness } from "@brainstorm-os/react-yjs";
import { localPresenceName } from "@brainstorm-os/sdk/peer-presence";
import type { AppState } from "../graph-canvas-controller";
import { type PresenceNodeScreen, renderPresenceOverlay } from "../render/presence-overlay";
import { PRESENCE_FIELD, buildLocalPresence, presencePeers } from "./presence";
import { createGraphLocalAwareness, presenceAwarenessFor } from "./presence-channel";

export type GraphPresenceBind = {
	bindGraph(graphEntityId: string | null): void;
	republish(): void;
	paint(): void;
	dispose(): void;
};

export function setupGraphPresence(opts: {
	container: HTMLElement;
	getState: () => AppState;
	rendererElement: HTMLElement;
}): GraphPresenceBind {
	const presenceLayer = document.createElement("div");
	presenceLayer.className = "graph__presence";
	presenceLayer.setAttribute("aria-hidden", "true");
	opts.container.style.position = opts.container.style.position || "relative";
	opts.container.appendChild(presenceLayer);

	let awareness: LocalAwareness = createGraphLocalAwareness();
	const presenceName = localPresenceName();
	let presenceCursor: { x: number; y: number } | null = null;
	let presenceCursorTimer: ReturnType<typeof setTimeout> | null = null;

	const currentGraphId = (): string | null => opts.getState().graphRecord?.id ?? null;

	const publishPresence = (): void => {
		const graphId = currentGraphId();
		if (!graphId) {
			awareness.setLocalState(null);
			return;
		}
		const state = opts.getState();
		awareness.setLocalStateField(
			PRESENCE_FIELD,
			buildLocalPresence({
				clientId: awareness.clientID,
				name: presenceName,
				graphId,
				cursor: presenceCursor,
				selection: state.selectedIds,
			}),
		);
	};

	const schedulePresenceCursor = (next: { x: number; y: number } | null): void => {
		presenceCursor = next;
		if (presenceCursorTimer !== null) return;
		presenceCursorTimer = setTimeout(() => {
			presenceCursorTimer = null;
			publishPresence();
		}, 50);
	};

	const paint = (): void => {
		const state = opts.getState();
		const graphId = currentGraphId();
		if (!graphId || !state.renderer) {
			presenceLayer.replaceChildren();
			return;
		}
		const renderer = state.renderer;
		const nodeScreenById = new Map<string, PresenceNodeScreen>();
		for (const rn of state.scene.renderNodes) {
			const layout = state.layoutNodes.get(rn.id);
			if (!layout) continue;
			const client = renderer.nodeToClient(state.transform, layout.x, layout.y);
			nodeScreenById.set(rn.id, {
				x: client.x,
				y: client.y,
				radiusPx: rn.radius * state.transform.k,
			});
		}
		const peers = presencePeers(awareness.getStates(), awareness.clientID, graphId);
		renderPresenceOverlay(presenceLayer, peers, nodeScreenById, (world) =>
			renderer.nodeToClient(state.transform, world.x, world.y),
		);
	};

	const onAwarenessChange = (): void => paint();

	const bindGraph = (graphEntityId: string | null): void => {
		awareness.off("change", onAwarenessChange);
		awareness.destroy();
		if (!graphEntityId) {
			awareness = createGraphLocalAwareness();
			presenceCursor = null;
			presenceLayer.replaceChildren();
			return;
		}
		awareness = presenceAwarenessFor(graphEntityId);
		awareness.on("change", onAwarenessChange);
		publishPresence();
		paint();
	};

	awareness.on("change", onAwarenessChange);

	const onPointerMove = (event: PointerEvent): void => {
		if (!currentGraphId()) return;
		const state = opts.getState();
		const renderer = state.renderer;
		if (!renderer) return;
		const world = renderer.clientToWorldPoint(state.transform, event.clientX, event.clientY);
		schedulePresenceCursor(world);
	};

	const onPointerLeave = (): void => schedulePresenceCursor(null);

	opts.rendererElement.addEventListener("pointermove", onPointerMove);
	opts.rendererElement.addEventListener("pointerleave", onPointerLeave);

	return {
		bindGraph,
		republish: publishPresence,
		paint,
		dispose: () => {
			if (presenceCursorTimer !== null) clearTimeout(presenceCursorTimer);
			awareness.off("change", onAwarenessChange);
			awareness.destroy();
			opts.rendererElement.removeEventListener("pointermove", onPointerMove);
			opts.rendererElement.removeEventListener("pointerleave", onPointerLeave);
			presenceLayer.remove();
		},
	};
}
