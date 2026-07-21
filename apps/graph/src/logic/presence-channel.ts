import type { LocalAwareness } from "@brainstorm-os/react-yjs";
import { createLocalAwareness } from "@brainstorm-os/react-yjs";
import { presenceAwarenessFor as presenceAwarenessForEntity } from "@brainstorm-os/sdk/presence-stack";
import { GRAPH_TYPE } from "../storage/graph-repository";

export function presenceAwarenessFor(graphEntityId: string): LocalAwareness {
	return presenceAwarenessForEntity(graphEntityId, GRAPH_TYPE);
}

export function createGraphLocalAwareness(): LocalAwareness {
	return createLocalAwareness();
}
