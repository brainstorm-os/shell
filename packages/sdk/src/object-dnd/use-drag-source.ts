/**
 * `useDragSource` (DND-2b/DND-3 source tail, §Part IV.2) — the
 * renderer that STARTS a cross-app drag. Native HTML5 `dragstart` can't drive a
 * cross-renderer drag (its `DataTransfer` doesn't cross the process boundary),
 * so the source drives the shell session with POINTER events: on a press-drag
 * past a small threshold it calls `dnd.begin` (the shell stamps `sourceApp`,
 * paints the ghost, hit-tests), forwards each move as `dnd.move` (coalesced to
 * one per animation frame — the raw stream is 60–120 Hz), completes with
 * `dnd.drop`, and aborts on Escape / pointer-cancel with `dnd.cancel`.
 *
 * Cross-window tracking relies on the OS delivering button-down drag events to
 * the originating window until release (implicit capture; the machine also
 * `setPointerCapture`s the handle). The shell owns the cursor-following ghost,
 * so the source paints nothing. Reference-only by construction — the source
 * passes `ObjectDragItem`s (ids + label), never object content.
 *
 * Threshold-gated so a plain click never starts a drag; if the press ends before
 * the threshold it's a no-op and the consumer's click handler runs normally. The
 * gesture logic lives in `DragMachine` (unit-tested without a renderer); this is
 * the thin React binding.
 */

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { DragMachine, type DragSourceSpec, type SourcePointerEvent } from "./drag-machine";

export type {
	DragSourceController,
	DragSourceSpec,
	SourcePointerEvent,
} from "./drag-machine";

export type UseDragSourceSpec = DragSourceSpec & {
	/** A native-`draggable` ancestor (e.g. a grid row that also reorders via HTML5
	 *  DnD) to neutralise for the lifetime of THIS pointer gesture. Native drag and
	 *  the pointer-driven cross-app gesture are mutually exclusive on one element —
	 *  starting a native drag fires `pointercancel` and kills the gesture — so a
	 *  shared element (grip on a draggable row) flips the ancestor's `draggable`
	 *  off on pointerdown and restores it on pointerup/cancel. Both Database rows
	 *  (reorder) and Files entries (move/copy) need this. */
	suppressNativeDragRef?: RefObject<HTMLElement | null>;
};

export type DragSourceHandle = {
	/** Spread on the drag-handle element. Carries `aria-grabbed` (DND-6 a11y
	 *  twin) — `false` at rest marks the element as draggable to AT, `true`
	 *  while the shell drag session is live. */
	dragHandleProps: {
		onPointerDown: (event: SourcePointerEvent) => void;
		"aria-grabbed": boolean;
	};
	/** True between drag begin and end — drive a "being dragged" affordance off it. */
	dragging: boolean;
};

export function useDragSource(spec: UseDragSourceSpec): DragSourceHandle {
	const specRef = useRef(spec);
	specRef.current = spec;
	const [dragging, setDragging] = useState(false);

	// One machine for the component's life: stable handler identities (so the
	// window add/removeEventListener pairs match) reading the latest spec via ref.
	const machineRef = useRef<DragMachine | null>(null);
	if (machineRef.current === null) {
		machineRef.current = new DragMachine(specRef, setDragging);
	}
	const machine = machineRef.current;

	// Cancel an in-flight drag if the source unmounts mid-gesture.
	useEffect(() => () => machine.cancelIfActive(), [machine]);

	// True while a suppression is armed, so a second pointerdown (a non-primary
	// button, or another pointer) doesn't re-capture the already-flipped
	// `draggable=false` as the value to restore and leave it stuck off.
	const suppressingRef = useRef(false);

	const onPointerDown = useCallback(
		(event: SourcePointerEvent) => {
			const ancestor = specRef.current.suppressNativeDragRef?.current;
			// Only the primary button starts a drag (mirrors the machine's gate), and
			// only arm once per gesture.
			if (ancestor && event.button === 0 && !suppressingRef.current) {
				const wasDraggable = ancestor.draggable;
				suppressingRef.current = true;
				const restore = (): void => {
					ancestor.draggable = wasDraggable;
					suppressingRef.current = false;
					window.removeEventListener("pointerup", restore);
					window.removeEventListener("pointercancel", restore);
				};
				ancestor.draggable = false;
				window.addEventListener("pointerup", restore);
				window.addEventListener("pointercancel", restore);
			}
			machine.onPointerDown(event);
		},
		[machine],
	);

	return { dragHandleProps: { onPointerDown, "aria-grabbed": dragging }, dragging };
}
