import type { LocalAwareness } from "@brainstorm/react-yjs";
import { createLocalAwareness } from "@brainstorm/react-yjs";
import { presenceAwarenessFor as presenceAwarenessForEntity } from "@brainstorm/sdk/presence-stack";
import { GRAPH_TYPE } from "../storage/graph-repository";

export function presenceAwarenessFor(graphEntityId: string): LocalAwareness {
	return presenceAwarenessForEntity(graphEntityId, GRAPH_TYPE);
}

export function createGraphLocalAwareness(): LocalAwareness {
	return createLocalAwareness();
}
