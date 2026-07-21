/**
 * `@brainstorm-os/sdk/object-dnd` — the renderer half of cross-app object
 * drag-and-drop (DND-3,). `useDropTarget` gives an app ONE
 * drop handler over BOTH transports: native intra-renderer HTML5 DnD and the
 * shell-mediated cross-app drag session. The wire helpers
 * (`serializeObjectDragPayload` / `readObjectDragData` / …) live in
 * `@brainstorm-os/sdk/entity-drag` (the single payload home).
 */

export {
	CROSS_APP_DRAG_LEAVE_EVENT,
	CROSS_APP_DRAG_OVER_EVENT,
	CROSS_APP_DROP_EVENT,
	CrossAppDropRegistry,
	crossAppDropRegistry,
} from "./cross-app";
export type { CrossAppDropTarget, DragRect, DndEffectReporter, DropTargetInfo } from "./cross-app";
export { dragItemsForSelection } from "./drag-items";
export { DropSemantic, effectForSemantic, leastDestructive } from "./drop-semantics";
export { useDragSource } from "./use-drag-source";
export type {
	DragSourceController,
	DragSourceHandle,
	DragSourceSpec,
	SourcePointerEvent,
} from "./use-drag-source";
export { useDropTarget } from "./use-drop-target";
export type { DropTargetHandle, DropTargetSpec } from "./use-drop-target";
