/**
 * Local presence channel — whiteboard's binding to the shared awareness
 * primitives. The implementation moved to `@brainstorm/react-yjs`
 * (`createLocalAwareness` / `createSyncedAwareness`, PRES-1, design
 * [74](../../../../docs/data/74-presence-transport.md)); this re-exports it so
 * the engine + dev hook keep their `./logic/presence-channel` import path.
 *
 * The dev hook (`__brainstormWhiteboardDev.presence`) still feeds remote states
 * through `applyRemoteState`. When the presence IPC transport (PRES-2) lands,
 * swap `createLocalAwareness` → `createSyncedAwareness(presenceTransport)` here
 * — nothing downstream (publisher, peers derivation, overlay) changes.
 */

export {
	type LocalAwareness,
	createLocalAwareness,
	randomClientId,
} from "@brainstorm/react-yjs";
