/**
 * Pure keyboard-focus navigation for the graph canvas (KBN-A-graph, 12.4).
 *
 * The canvas is a Pixi/SVG draw surface — its nodes are *not* DOM, so a
 * keyboard / screen-reader user has no focusable element per vertex. This
 * module is the model half of the keyboard-focus concept the canvas lacked:
 * given the visible nodes and their laid-out world positions, it computes
 * which node a Tab / arrow press moves focus to. `app.ts` owns the live
 * state (`kbFocusId`), the camera-centring, and the aria-live announcement;
 * everything here is framework-free arithmetic so it's unit-tested without a
 * canvas (the rAF render path that owns the graph perf/hang invariants stays
 * untouched — keyboard focus rides the existing hover-highlight channel).
 *
 * Sequential order (Tab / Shift+Tab) is render order — the same array the
 * renderer paints from — so the ring is stable and matches what's drawn.
 * Arrow keys use the shared spatial-grid geometry (nearest node in the
 * pressed direction), reusing `spatialGridStep` over the nodes' world
 * coordinates so the macOS-Desktop "beam" preference is identical to the
 * dashboard icon grid.
 */

import { type SpatialCell, SpatialDirection, spatialGridStep } from "@brainstorm-os/sdk/a11y";

export { SpatialDirection };

/** A canvas node that can hold keyboard focus: its id plus the world
 *  position the layout settled it at. */
export type FocusableNode = { id: string; x: number; y: number };

/**
 * The focus ring: visible render nodes that have a laid-out position, in
 * render order (the stable sequential order). A node without a layout entry
 * (mid-reconcile) is skipped — it can't be centred or drawn, so it can't hold
 * focus.
 */
export function focusableNodes(
	renderNodes: ReadonlyArray<{ id: string }>,
	positions: ReadonlyMap<string, { x: number; y: number }>,
): FocusableNode[] {
	const out: FocusableNode[] = [];
	for (const node of renderNodes) {
		const pos = positions.get(node.id);
		if (pos === undefined) continue;
		out.push({ id: node.id, x: pos.x, y: pos.y });
	}
	return out;
}

/** The node focus lands on when the canvas first gains keyboard focus with
 *  no prior focus (or the prior focus left the scene): the first node in
 *  render order, or null for an empty graph. */
export function initialFocus(nodes: ReadonlyArray<FocusableNode>): string | null {
	return nodes[0]?.id ?? null;
}

/**
 * Sequential step (Tab = `+1`, Shift+Tab = `-1`) with wrap-around, so the
 * ring cycles. Returns the next id, or null for an empty graph. When
 * `currentId` is absent from the ring (focus node vanished), Tab starts at
 * the first node and Shift+Tab at the last.
 */
export function sequentialFocusStep(
	nodes: ReadonlyArray<FocusableNode>,
	currentId: string | null,
	delta: 1 | -1,
): string | null {
	if (nodes.length === 0) return null;
	const index = currentId === null ? -1 : nodes.findIndex((n) => n.id === currentId);
	if (index === -1) return (delta === 1 ? nodes[0] : nodes[nodes.length - 1])?.id ?? null;
	const next = (index + delta + nodes.length) % nodes.length;
	return nodes[next]?.id ?? null;
}

/**
 * Spatial step: the nearest node in the pressed direction (no wrap — at an
 * edge focus stays put). Reuses the shared `spatialGridStep` over the nodes'
 * world coordinates. Returns `currentId` unchanged when there's no node that
 * way, or the first node when focus isn't currently on the ring.
 */
export function spatialFocusStep(
	nodes: ReadonlyArray<FocusableNode>,
	currentId: string | null,
	direction: SpatialDirection,
): string | null {
	if (nodes.length === 0) return null;
	const index = currentId === null ? -1 : nodes.findIndex((n) => n.id === currentId);
	if (index === -1) return nodes[0]?.id ?? null;
	const cells: SpatialCell[] = nodes.map((n) => ({ col: n.x, row: n.y }));
	const nextIndex = spatialGridStep(cells, index, direction);
	return nodes[nextIndex]?.id ?? currentId;
}
