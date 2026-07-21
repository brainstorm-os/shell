/**
 * The imperative pointer→`dnd` state machine behind `useDragSource` (DND-2b/3
 * source tail, §Part IV.2). Separated from the React hook so
 * the gesture logic — threshold gating, rAF-coalesced move forwarding, the
 * begin/move/drop/cancel lifecycle, and the begin-still-in-flight edge cases —
 * is unit-testable without a renderer.
 *
 * Handlers are bound instance fields (stable identity) so the `window`
 * add/removeEventListener pairs match.
 *
 * KNOWN LIMITATION (resolve during real-shell verification): every handler gates
 * on `event.pointerId`, and the end events ride OS pointer capture. If capture is
 * lost mid-drag (the cross-window case this targets — the matching `pointerup`
 * could route to another window), no end fires and the gesture sticks until the
 * source unmounts. The right fix is shell-side, not a renderer `blur` net (which
 * would wrongly abort a legitimate drag the moment the cursor crosses into
 * another Brainstorm window): the shell already owns the session, so a
 * `screen.getCursorScreenPoint()`/button-state poll there can both track the
 * cursor globally AND time out an abandoned session.
 */

import {
	type DndService,
	type DragGhostSpec,
	DragPayloadKind,
	type DragPoint,
	type DropResult,
	type ObjectDragItem,
} from "@brainstorm-os/sdk-types";

/** The `dnd` surface a source drives — the begin/move/drop/cancel quartet. */
export type DragSourceController = Pick<DndService, "begin" | "move" | "drop" | "cancel">;

/** A pointerdown event — the structural subset the machine reads. */
export type SourcePointerEvent = {
	button: number;
	pointerId: number;
	screenX: number;
	screenY: number;
	currentTarget: {
		setPointerCapture?: (pointerId: number) => void;
		releasePointerCapture?: (pointerId: number) => void;
	} | null;
};

export type DragSourceSpec = {
	/** The objects to drag (e.g. the current selection). Read at drag start; an
	 *  empty result cancels the gesture. */
	getItems: () => ObjectDragItem[];
	/** Ghost spec for the dragged set. Default: first item's label/icon + count. */
	ghostFor?: (items: readonly ObjectDragItem[]) => DragGhostSpec;
	/** Default `DragPayloadKind.Object`. */
	payloadKind?: DragPayloadKind;
	/** Pixels of movement before a drag begins (a click stays below it). Default 4. */
	thresholdPx?: number;
	/** Notified with the drop outcome (delivered/effect/targetApp). */
	onDropped?: (result: DropResult) => void;
	/** Injected for tests; defaults to `window.brainstorm.services.dnd`. */
	controller?: DragSourceController;
	/** Injected for tests; default `requestAnimationFrame`/`cancelAnimationFrame`. */
	raf?: (cb: () => void) => number;
	caf?: (handle: number) => void;
};

export function defaultController(): DragSourceController | null {
	const runtime = (globalThis as { brainstorm?: { services?: { dnd?: DragSourceController } } })
		.brainstorm;
	return runtime?.services?.dnd ?? null;
}

export function defaultGhost(items: readonly ObjectDragItem[]): DragGhostSpec {
	const first = items[0];
	const spec: DragGhostSpec = { label: first?.label ?? "", count: items.length };
	if (first?.iconRef) spec.iconRef = first.iconRef;
	return spec;
}

type Gesture = {
	pointerId: number;
	startX: number;
	startY: number;
	releaseCapture: (() => void) | null;
	started: boolean;
	sessionId: string | null;
	/** A pointerup/Escape that arrived while `begin` was still in-flight. */
	endAfterBegin: "drop" | "cancel" | null;
	pending: DragPoint | null;
	rafHandle: number | null;
	lastPoint: DragPoint;
};

export class DragMachine {
	private gesture: Gesture | null = null;

	constructor(
		private readonly specRef: { current: DragSourceSpec },
		private readonly setDragging: (v: boolean) => void,
	) {}

	private controller(): DragSourceController | null {
		return this.specRef.current.controller ?? defaultController();
	}
	private schedule(cb: () => void): number {
		return (this.specRef.current.raf ?? requestAnimationFrame)(cb);
	}
	private unschedule(handle: number): void {
		(this.specRef.current.caf ?? cancelAnimationFrame)(handle);
	}

	private teardown(): void {
		const g = this.gesture;
		if (!g) return;
		if (g.rafHandle !== null) this.unschedule(g.rafHandle);
		g.releaseCapture?.();
		window.removeEventListener("pointermove", this.onPointerMove);
		window.removeEventListener("pointerup", this.onPointerUp);
		window.removeEventListener("pointercancel", this.onPointerCancel);
		window.removeEventListener("keydown", this.onKeyDown);
		this.gesture = null;
		this.setDragging(false);
	}

	cancelIfActive(): void {
		const g = this.gesture;
		if (!g) return;
		const sessionId = g.sessionId;
		this.teardown();
		if (sessionId) void this.controller()?.cancel({ sessionId });
	}

	private readonly flushMove = (): void => {
		const g = this.gesture;
		if (!g) return;
		g.rafHandle = null;
		if (!g.started || !g.sessionId || !g.pending) return;
		const point = g.pending;
		g.pending = null;
		void this.controller()?.move({ sessionId: g.sessionId, screenPoint: point });
	};

	private scheduleMove(point: DragPoint): void {
		const g = this.gesture;
		if (!g) return;
		g.pending = point;
		if (g.rafHandle === null) g.rafHandle = this.schedule(this.flushMove);
	}

	private async begin(g: Gesture, point: DragPoint): Promise<void> {
		const items = this.specRef.current.getItems();
		if (items.length === 0) {
			this.teardown();
			return;
		}
		g.started = true;
		this.setDragging(true);
		const ghost = (this.specRef.current.ghostFor ?? defaultGhost)(items);
		try {
			const info = await this.controller()?.begin({
				payloadKind: this.specRef.current.payloadKind ?? DragPayloadKind.Object,
				items,
				ghost,
				screenPoint: point,
			});
			if (this.gesture !== g) {
				// Torn down (unmount / pointercancel) while begin was in-flight: the
				// shell session is now LIVE but unowned. Cancel it so the ghost +
				// `sourceApp` session don't orphan.
				if (info?.sessionId) void this.controller()?.cancel({ sessionId: info.sessionId });
				return;
			}
			g.sessionId = info?.sessionId ?? null;
			if (!g.sessionId) {
				this.teardown();
				return;
			}
			// Resolve an end that arrived mid-begin, else flush the latest move.
			if (g.endAfterBegin === "drop") this.finishDrop(g.lastPoint);
			else if (g.endAfterBegin === "cancel") this.cancelIfActive();
			else this.scheduleMove(g.lastPoint);
		} catch {
			this.teardown();
		}
	}

	private finishDrop(point: DragPoint): void {
		const g = this.gesture;
		if (!g || !g.sessionId) {
			this.teardown();
			return;
		}
		const sessionId = g.sessionId;
		const onDropped = this.specRef.current.onDropped;
		this.teardown();
		void this.controller()
			?.drop({ sessionId, screenPoint: point })
			.then((result) => onDropped?.(result));
	}

	private readonly onPointerMove = (event: PointerEvent): void => {
		const g = this.gesture;
		if (!g || event.pointerId !== g.pointerId) return;
		if (g.endAfterBegin !== null) return; // an end is queued; ignore trailing moves
		const point: DragPoint = { x: event.screenX, y: event.screenY };
		g.lastPoint = point;
		if (!g.started) {
			const threshold = this.specRef.current.thresholdPx ?? 4;
			if (Math.abs(point.x - g.startX) < threshold && Math.abs(point.y - g.startY) < threshold) {
				return; // still a click, not a drag
			}
			void this.begin(g, point);
			return;
		}
		this.scheduleMove(point);
	};

	private readonly onPointerUp = (event: PointerEvent): void => {
		const g = this.gesture;
		if (!g || event.pointerId !== g.pointerId) return;
		const point: DragPoint = { x: event.screenX, y: event.screenY };
		if (!g.started) {
			this.teardown(); // released below threshold → a click, never began
			return;
		}
		if (!g.sessionId) {
			// begin still in-flight; queue the drop (first-end-wins — a later stray
			// Escape/cancel mustn't downgrade a committed release).
			if (g.endAfterBegin === null) {
				g.endAfterBegin = "drop";
				g.lastPoint = point;
			}
			return;
		}
		this.finishDrop(point);
	};

	private readonly onPointerCancel = (event: PointerEvent): void => {
		const g = this.gesture;
		if (!g || event.pointerId !== g.pointerId) return;
		if (g.started && !g.sessionId) {
			if (g.endAfterBegin === null) g.endAfterBegin = "cancel"; // first-end-wins
			return;
		}
		if (g.started) this.cancelIfActive();
		else this.teardown();
	};

	private readonly onKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== "Escape") return;
		const g = this.gesture;
		if (!g || !g.started) return;
		event.preventDefault();
		if (!g.sessionId) {
			if (g.endAfterBegin === null) g.endAfterBegin = "cancel"; // first-end-wins
			return;
		}
		this.cancelIfActive();
	};

	readonly onPointerDown = (event: SourcePointerEvent): void => {
		if (event.button !== 0 || this.gesture) return; // primary only; one at a time
		const start: DragPoint = { x: event.screenX, y: event.screenY };
		let releaseCapture: (() => void) | null = null;
		const target = event.currentTarget;
		if (target?.setPointerCapture) {
			try {
				target.setPointerCapture(event.pointerId);
				releaseCapture = () => target.releasePointerCapture?.(event.pointerId);
			} catch {
				releaseCapture = null;
			}
		}
		this.gesture = {
			pointerId: event.pointerId,
			startX: start.x,
			startY: start.y,
			releaseCapture,
			started: false,
			sessionId: null,
			endAfterBegin: null,
			pending: null,
			rafHandle: null,
			lastPoint: start,
		};
		window.addEventListener("pointermove", this.onPointerMove);
		window.addEventListener("pointerup", this.onPointerUp);
		window.addEventListener("pointercancel", this.onPointerCancel);
		window.addEventListener("keydown", this.onKeyDown);
	};
}
