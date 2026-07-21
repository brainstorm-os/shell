/**
 * `brainstorm/Whiteboard/v1` — the board entity itself. Nodes are
 * inlined (per-board scenery); edges live as separate
 * `WhiteboardEdge/v1` entities (per OQ-WB-1).
 */

import type { Icon } from "@brainstorm-os/sdk-types";
import type { WhiteboardNode } from "./node";

export type Whiteboard = {
	id: string;
	name: string;
	description?: string;
	icon?: Icon | null;
	nodes: WhiteboardNode[];
	createdAt: number;
	updatedAt: number;
};
