/**
 * Cross-app drag transport (DND-3, §Part IV.4) — the renderer
 * half of the shell-mediated drag session. The shell `webContents.send`s
 * `app:drag-over` / `app:drag-leave` / `app:drop` to the window under the
 * cursor; the app-preload re-dispatches them as DOM CustomEvents on `window`
 * (the names below). This module is the SDK side: the event contract + a
 * process-wide drop registry that routes a hovered/dropped drag to the app's
 * registered `useDropTarget`s and answers the shell's hover negotiation via
 * `dnd.setEffect`.
 *
 * PRIVACY (OQ-DND-2): a hover (`drag-over`) carries kinds + within-window point
 * ONLY — never the items, never `sourceApp`; the full `ObjectDragPayload`
 * arrives ONLY on `drop`. This module never tries to read items at hover time.
 */

import {
	CROSS_APP_DRAG_LEAVE_EVENT,
	CROSS_APP_DRAG_OVER_EVENT,
	CROSS_APP_DROP_EVENT,
	type DragOverNotice,
	DragPayloadKind,
	type DragPoint,
	type DropDelivery,
	DropEffect,
	type ObjectDragPayload,
} from "@brainstorm-os/sdk-types";
import { objectDragItemTypes } from "../entity-drag";

export { CROSS_APP_DRAG_LEAVE_EVENT, CROSS_APP_DRAG_OVER_EVENT, CROSS_APP_DROP_EVENT };

/** What a drop target learns at hover/drop time (transport-agnostic). */
export type DropTargetInfo = {
	payloadKind: DragPayloadKind;
	/** Deduped entity-type URLs in the drag (the only item info a hover leaks). */
	itemTypes: string[];
	/** Within-window (cross-app) or client (native) point. */
	point: DragPoint;
};

/** Within-window bounds of a positioned drop target (left/top/right/bottom in
 *  the same client coordinates as the drop point). */
export type DragRect = { left: number; top: number; right: number; bottom: number };

/** A registered cross-app drop target. The registry routes a session to the
 *  most-recently-registered target that `accepts` the drag and, if it is
 *  POSITIONED (has a `getRect`), contains the within-window drop point — so
 *  MULTIPLE positioned targets can coexist in one window (Calendar day cells,
 *  Files folders, board columns), the one under the cursor winning. A target
 *  with no `getRect` (or whose `getRect` returns `null` — e.g. a whole-window
 *  editor drop zone) is WINDOW-LEVEL: it matches anywhere, but only as a
 *  fallback when no positioned target claims the point. */
export type CrossAppDropTarget = {
	accepts: (info: DropTargetInfo) => boolean;
	dropEffectFor: (info: DropTargetInfo) => DropEffect;
	onDrop: (payload: ObjectDragPayload, info: DropTargetInfo, effect: DropEffect) => void;
	/** This target's on-screen rect, or `null` when it has no element (whole-window
	 *  / window-level). Omitted → window-level too. */
	getRect?: () => DragRect | null;
	/** Notified when this target becomes / stops being the current hover target
	 *  (drives the drop-zone highlight). */
	onActiveChange?: (active: boolean) => void;
};

/** Is `point` inside `rect` (inclusive)? */
function rectContains(rect: DragRect, point: DragPoint): boolean {
	return (
		point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
	);
}

/** The minimal `dnd` surface the registry needs — only the hover reply. Injected
 *  so the registry is testable without a live runtime. */
export type DndEffectReporter = {
	setEffect: (args: { sessionId: string; effect: DropEffect }) => unknown;
};

/** Read `window.brainstorm.services.dnd` (the effect reporter) at call time, or
 *  `null` outside an app runtime. Lazy so importing this module is inert. */
function defaultEffectReporter(): DndEffectReporter | null {
	const runtime = (globalThis as { brainstorm?: { services?: { dnd?: DndEffectReporter } } })
		.brainstorm;
	return runtime?.services?.dnd ?? null;
}

function noticeInfo(notice: DragOverNotice): DropTargetInfo {
	return {
		payloadKind: notice.payloadKind,
		itemTypes: Array.isArray(notice.itemTypes) ? notice.itemTypes : [],
		point: notice.pointInWindow,
	};
}

/**
 * Process-wide router between the preload's cross-app DOM events and the app's
 * registered drop targets. One per app renderer (a module singleton); lazily
 * binds its `window` listeners on the first registration and unbinds when the
 * last target leaves.
 */
export class CrossAppDropRegistry {
	private readonly targets: CrossAppDropTarget[] = [];
	private bound = false;
	private active: { sessionId: string; target: CrossAppDropTarget } | null = null;
	/** Last effect reported to the shell, per session — hover fires at ~60 Hz, so
	 *  only emit a `dnd.setEffect` IPC when it actually changes (and always once
	 *  for a new session, whose ghost starts at None). */
	private reported: { sessionId: string; effect: DropEffect } | null = null;

	constructor(
		private readonly win: Pick<Window, "addEventListener" | "removeEventListener">,
		private readonly reporter: () => DndEffectReporter | null = defaultEffectReporter,
	) {}

	register(target: CrossAppDropTarget): () => void {
		this.targets.push(target);
		this.bind();
		return () => {
			const i = this.targets.indexOf(target);
			if (i >= 0) this.targets.splice(i, 1);
			if (this.active?.target === target) this.clearActive();
			if (this.targets.length === 0) this.unbind();
		};
	}

	private bind(): void {
		if (this.bound) return;
		this.bound = true;
		this.win.addEventListener(CROSS_APP_DRAG_OVER_EVENT, this.onOver);
		this.win.addEventListener(CROSS_APP_DRAG_LEAVE_EVENT, this.onLeave);
		this.win.addEventListener(CROSS_APP_DROP_EVENT, this.onDrop);
	}

	private unbind(): void {
		if (!this.bound) return;
		this.bound = false;
		this.win.removeEventListener(CROSS_APP_DRAG_OVER_EVENT, this.onOver);
		this.win.removeEventListener(CROSS_APP_DRAG_LEAVE_EVENT, this.onLeave);
		this.win.removeEventListener(CROSS_APP_DROP_EVENT, this.onDrop);
	}

	/** Most-recently-registered target that accepts the drag AND, if positioned,
	 *  contains the drop point — positioned hits win outright; a window-level
	 *  target (no rect, or `getRect()` → null) wins only as a fallback when no
	 *  positioned target claims the point. LIFO within each tier (active view
	 *  wins). A positioned target whose point is OUTSIDE its rect is skipped (it
	 *  does NOT fall through to window-level, so it can't steal a sibling's drop). */
	private match(info: DropTargetInfo): CrossAppDropTarget | null {
		let windowLevel: CrossAppDropTarget | null = null;
		for (let i = this.targets.length - 1; i >= 0; i--) {
			const t = this.targets[i];
			if (!t || !t.accepts(info)) continue;
			const rect = t.getRect?.() ?? null;
			if (!rect) {
				windowLevel ??= t; // remember the first whole-window fallback
				continue;
			}
			if (rectContains(rect, info.point)) return t; // positioned hit wins outright
		}
		return windowLevel;
	}

	private setActive(sessionId: string, target: CrossAppDropTarget | null): void {
		if (this.active && this.active.target !== target) {
			this.active.target.onActiveChange?.(false);
			this.active = null;
		}
		if (target) {
			if (this.active?.target !== target) target.onActiveChange?.(true);
			this.active = { sessionId, target };
		}
	}

	private clearActive(): void {
		if (this.active) {
			this.active.target.onActiveChange?.(false);
			this.active = null;
		}
	}

	private readonly onOver = (event: Event): void => {
		const notice = (event as CustomEvent<DragOverNotice>).detail;
		if (!notice) return;
		const info = noticeInfo(notice);
		const target = this.match(info);
		this.setActive(notice.sessionId, target);
		// Report the effect: the matched target's offer, or None (no-drop) so the
		// shell ghost shows the cursor can't drop here. Only emit on change — the
		// hover stream is ~60 Hz and the effect is usually steady.
		const effect = target ? target.dropEffectFor(info) : DropEffect.None;
		if (this.reported?.sessionId !== notice.sessionId || this.reported.effect !== effect) {
			this.reported = { sessionId: notice.sessionId, effect };
			this.reporter()?.setEffect({ sessionId: notice.sessionId, effect });
		}
	};

	private readonly onLeave = (_event: Event): void => {
		this.reported = null;
		this.clearActive();
	};

	private readonly onDrop = (event: Event): void => {
		const delivery = (event as CustomEvent<DropDelivery>).detail;
		if (!delivery) return;
		const info: DropTargetInfo = {
			payloadKind: delivery.payloadKind ?? DragPayloadKind.Object,
			itemTypes: objectDragItemTypes(delivery.payload.items),
			point: delivery.pointInWindow,
		};
		// The matched (still-accepting) target, or the one that was active at the
		// last hover — the drop point may not re-match if the target's accept
		// state changed mid-drag, but the active target already showed it'd accept.
		const target = this.match(info) ?? this.active?.target ?? null;
		this.reported = null;
		this.clearActive();
		if (target) target.onDrop(delivery.payload, info, delivery.effect);
	};
}

let singleton: CrossAppDropRegistry | null = null;

/** The app's process-wide cross-app drop registry (lazy; one per renderer). */
export function crossAppDropRegistry(): CrossAppDropRegistry {
	if (!singleton) singleton = new CrossAppDropRegistry(window);
	return singleton;
}
