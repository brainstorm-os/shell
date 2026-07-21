import {
	type DragOverNotice,
	DragPayloadKind,
	type DropDelivery,
	DropEffect,
	type ObjectDragPayload,
} from "@brainstorm-os/sdk-types";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CROSS_APP_DRAG_LEAVE_EVENT,
	CROSS_APP_DRAG_OVER_EVENT,
	CROSS_APP_DROP_EVENT,
	CrossAppDropRegistry,
	type CrossAppDropTarget,
	type DndEffectReporter,
} from "./cross-app";

/** Fake `window` that records listeners and lets the test fire events. */
class FakeWindow {
	readonly handlers = new Map<string, Set<(e: unknown) => void>>();
	addEventListener(type: string, fn: (e: unknown) => void): void {
		let set = this.handlers.get(type);
		if (!set) {
			set = new Set();
			this.handlers.set(type, set);
		}
		set.add(fn);
	}
	removeEventListener(type: string, fn: (e: unknown) => void): void {
		this.handlers.get(type)?.delete(fn);
	}
	fire(type: string, detail: unknown): void {
		for (const fn of this.handlers.get(type) ?? []) fn({ detail });
	}
	listenerCount(type: string): number {
		return this.handlers.get(type)?.size ?? 0;
	}
}

const PAYLOAD: ObjectDragPayload = {
	v: 1,
	sourceApp: "io.brainstorm.files",
	items: [{ entityId: "a", entityType: "T", label: "A" }],
};

function overNotice(over: Partial<DragOverNotice> = {}): DragOverNotice {
	return {
		sessionId: "s1",
		payloadKind: DragPayloadKind.Object,
		itemTypes: ["T"],
		pointInWindow: { x: 5, y: 6 },
		...over,
	};
}

function dropDelivery(over: Partial<DropDelivery> = {}): DropDelivery {
	return {
		sessionId: "s1",
		payloadKind: DragPayloadKind.Object,
		payload: PAYLOAD,
		pointInWindow: { x: 5, y: 6 },
		effect: DropEffect.Link,
		...over,
	};
}

describe("CrossAppDropRegistry", () => {
	let win: FakeWindow;
	let setEffect: Mock<DndEffectReporter["setEffect"]>;
	let registry: CrossAppDropRegistry;

	beforeEach(() => {
		win = new FakeWindow();
		setEffect = vi.fn<DndEffectReporter["setEffect"]>();
		registry = new CrossAppDropRegistry(win, () => ({ setEffect }));
	});

	function target(over: Partial<CrossAppDropTarget> = {}): CrossAppDropTarget {
		return {
			accepts: () => true,
			dropEffectFor: () => DropEffect.Link,
			onDrop: vi.fn(),
			...over,
		};
	}

	it("binds window listeners on first register and unbinds when the last leaves", () => {
		const off = registry.register(target());
		expect(win.listenerCount(CROSS_APP_DRAG_OVER_EVENT)).toBe(1);
		off();
		expect(win.listenerCount(CROSS_APP_DRAG_OVER_EVENT)).toBe(0);
		expect(win.listenerCount(CROSS_APP_DROP_EVENT)).toBe(0);
	});

	it("reports the matched target's effect on drag-over and marks it active", () => {
		const onActiveChange = vi.fn();
		registry.register(target({ dropEffectFor: () => DropEffect.Move, onActiveChange }));
		win.fire(CROSS_APP_DRAG_OVER_EVENT, overNotice());
		expect(setEffect).toHaveBeenCalledWith({ sessionId: "s1", effect: DropEffect.Move });
		expect(onActiveChange).toHaveBeenCalledWith(true);
	});

	it("only emits setEffect when the effect changes across a ~60Hz hover stream", () => {
		let effect = DropEffect.Link;
		registry.register(target({ dropEffectFor: () => effect }));
		win.fire(CROSS_APP_DRAG_OVER_EVENT, overNotice());
		win.fire(CROSS_APP_DRAG_OVER_EVENT, overNotice());
		win.fire(CROSS_APP_DRAG_OVER_EVENT, overNotice());
		expect(setEffect).toHaveBeenCalledTimes(1); // steady effect → one report
		effect = DropEffect.Move;
		win.fire(CROSS_APP_DRAG_OVER_EVENT, overNotice());
		expect(setEffect).toHaveBeenCalledTimes(2); // changed → re-report
	});

	it("re-reports for a new session even if the effect matches the previous one", () => {
		registry.register(target({ dropEffectFor: () => DropEffect.Link }));
		win.fire(CROSS_APP_DRAG_OVER_EVENT, overNotice({ sessionId: "s1" }));
		win.fire(CROSS_APP_DRAG_OVER_EVENT, overNotice({ sessionId: "s2" }));
		expect(setEffect).toHaveBeenCalledTimes(2);
	});

	it("reports None (no-drop) when no target accepts", () => {
		registry.register(target({ accepts: () => false }));
		win.fire(CROSS_APP_DRAG_OVER_EVENT, overNotice());
		expect(setEffect).toHaveBeenCalledWith({ sessionId: "s1", effect: DropEffect.None });
	});

	it("routes to the most-recently-registered accepting target (LIFO)", () => {
		const first = target({ onDrop: vi.fn() });
		const second = target({ onDrop: vi.fn() });
		registry.register(first);
		registry.register(second);
		win.fire(CROSS_APP_DROP_EVENT, dropDelivery());
		expect(second.onDrop).toHaveBeenCalledTimes(1);
		expect(first.onDrop).not.toHaveBeenCalled();
	});

	it("routes to the positioned target whose rect contains the drop point", () => {
		// Two sibling positioned targets (Calendar days / Files folders): the one
		// under the cursor wins regardless of registration order.
		const left = target({
			onDrop: vi.fn(),
			getRect: () => ({ left: 0, top: 0, right: 9, bottom: 100 }),
		});
		const right = target({
			onDrop: vi.fn(),
			getRect: () => ({ left: 10, top: 0, right: 100, bottom: 100 }),
		});
		registry.register(left);
		registry.register(right);
		win.fire(CROSS_APP_DROP_EVENT, dropDelivery({ pointInWindow: { x: 4, y: 4 } }));
		expect(left.onDrop).toHaveBeenCalledTimes(1);
		expect(right.onDrop).not.toHaveBeenCalled();
	});

	it("prefers a positioned hit but falls back to a window-level target when none contain the point", () => {
		const windowLevel = target({ onDrop: vi.fn() }); // no getRect → window-level
		const positioned = target({
			onDrop: vi.fn(),
			getRect: () => ({ left: 1000, top: 1000, right: 1001, bottom: 1001 }),
		});
		registry.register(windowLevel);
		registry.register(positioned);
		win.fire(CROSS_APP_DROP_EVENT, dropDelivery({ pointInWindow: { x: 5, y: 6 } }));
		expect(positioned.onDrop).not.toHaveBeenCalled();
		expect(windowLevel.onDrop).toHaveBeenCalledTimes(1);
	});

	it("a window-level target registered LAST does not steal a positioned sibling's drop", () => {
		// Regression: useDropTarget used to always supply a true containsPoint, so a
		// no-rect target on top stole drops. With getRect→null it stays a fallback.
		const positioned = target({
			onDrop: vi.fn(),
			getRect: () => ({ left: 0, top: 0, right: 100, bottom: 100 }),
		});
		const windowLevelOnTop = target({ onDrop: vi.fn() }); // registered after, no rect
		registry.register(positioned);
		registry.register(windowLevelOnTop);
		win.fire(CROSS_APP_DROP_EVENT, dropDelivery({ pointInWindow: { x: 5, y: 6 } }));
		expect(positioned.onDrop).toHaveBeenCalledTimes(1);
		expect(windowLevelOnTop.onDrop).not.toHaveBeenCalled();
	});

	it("delivers the full payload + effect to the target on drop", () => {
		const onDrop = vi.fn();
		registry.register(target({ onDrop }));
		win.fire(CROSS_APP_DROP_EVENT, dropDelivery());
		expect(onDrop).toHaveBeenCalledWith(
			PAYLOAD,
			expect.objectContaining({ payloadKind: DragPayloadKind.Object, itemTypes: ["T"] }),
			DropEffect.Link,
		);
	});

	it("clears the active highlight on leave", () => {
		const onActiveChange = vi.fn();
		registry.register(target({ onActiveChange }));
		win.fire(CROSS_APP_DRAG_OVER_EVENT, overNotice());
		win.fire(CROSS_APP_DRAG_LEAVE_EVENT, { sessionId: "s1" });
		expect(onActiveChange).toHaveBeenLastCalledWith(false);
	});

	it("clears active when the active target unregisters", () => {
		const onActiveChange = vi.fn();
		const off = registry.register(target({ onActiveChange }));
		win.fire(CROSS_APP_DRAG_OVER_EVENT, overNotice());
		onActiveChange.mockClear();
		off();
		expect(onActiveChange).toHaveBeenCalledWith(false);
	});

	it("ignores events with no detail / no target without throwing", () => {
		registry.register(target({ accepts: () => false }));
		expect(() => {
			win.fire(CROSS_APP_DRAG_OVER_EVENT, undefined);
			win.fire(CROSS_APP_DROP_EVENT, dropDelivery());
		}).not.toThrow();
	});
});
