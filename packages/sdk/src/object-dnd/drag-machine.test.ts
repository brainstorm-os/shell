// @vitest-environment jsdom
import { DragPayloadKind, type DragSessionInfo, DropEffect } from "@brainstorm-os/sdk-types";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DragMachine, type DragSourceSpec, type SourcePointerEvent } from "./drag-machine";

const ITEMS = [{ entityId: "a", entityType: "T", label: "Alpha" }];

function makeController(sessionId = "s1") {
	return {
		begin: vi.fn(
			async (): Promise<DragSessionInfo> => ({
				sessionId,
				payloadKind: DragPayloadKind.Object,
				itemCount: 1,
			}),
		),
		move: vi.fn(async () => {}),
		drop: vi.fn(async () => ({
			delivered: true,
			effect: DropEffect.Link,
			targetApp: "io.t",
		})),
		cancel: vi.fn(async () => {}),
	};
}

let rafQueue: Array<() => void>;
function flushRaf(): void {
	const q = rafQueue;
	rafQueue = [];
	for (const cb of q) cb();
}
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

function down(machine: DragMachine, at = { x: 100, y: 100 }, pointerId = 1): void {
	const ev: SourcePointerEvent = {
		button: 0,
		pointerId,
		screenX: at.x,
		screenY: at.y,
		currentTarget: { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() },
	};
	machine.onPointerDown(ev);
}
function fire(type: string, props: Record<string, unknown>): void {
	window.dispatchEvent(Object.assign(new Event(type), props));
}

describe("DragMachine", () => {
	let controller: ReturnType<typeof makeController>;
	let setDragging: Mock<(v: boolean) => void>;
	let spec: DragSourceSpec;
	let machine: DragMachine;

	beforeEach(() => {
		rafQueue = [];
		controller = makeController();
		setDragging = vi.fn<(v: boolean) => void>();
		spec = {
			getItems: () => ITEMS,
			controller,
			raf: (cb) => {
				rafQueue.push(cb);
				return rafQueue.length;
			},
			caf: () => {},
		};
		machine = new DragMachine({ current: spec }, setDragging);
	});

	afterEach(() => {
		machine.cancelIfActive();
	});

	it("a click (down+up, no movement past threshold) never begins a drag", () => {
		down(machine);
		fire("pointerup", { pointerId: 1, screenX: 100, screenY: 100 });
		expect(controller.begin).not.toHaveBeenCalled();
		expect(setDragging).not.toHaveBeenCalledWith(true);
	});

	it("movement below the threshold does not begin", () => {
		down(machine);
		fire("pointermove", { pointerId: 1, screenX: 102, screenY: 101 });
		expect(controller.begin).not.toHaveBeenCalled();
	});

	it("crossing the threshold begins the drag with items + ghost + screen point", async () => {
		down(machine);
		fire("pointermove", { pointerId: 1, screenX: 120, screenY: 100 });
		await flushMicrotasks();
		expect(controller.begin).toHaveBeenCalledWith(
			expect.objectContaining({
				payloadKind: DragPayloadKind.Object,
				items: ITEMS,
				ghost: { label: "Alpha", count: 1 },
				screenPoint: { x: 120, y: 100 },
			}),
		);
		expect(setDragging).toHaveBeenCalledWith(true);
	});

	it("coalesces multiple moves per frame into one dnd.move (latest point)", async () => {
		down(machine);
		fire("pointermove", { pointerId: 1, screenX: 120, screenY: 100 }); // begins
		await flushMicrotasks();
		controller.move.mockClear();
		flushRaf(); // flush the begin's initial scheduled move
		controller.move.mockClear();
		fire("pointermove", { pointerId: 1, screenX: 130, screenY: 110 });
		fire("pointermove", { pointerId: 1, screenX: 140, screenY: 120 });
		fire("pointermove", { pointerId: 1, screenX: 150, screenY: 130 });
		expect(controller.move).not.toHaveBeenCalled(); // queued, not yet flushed
		flushRaf();
		expect(controller.move).toHaveBeenCalledTimes(1);
		expect(controller.move).toHaveBeenCalledWith({
			sessionId: "s1",
			screenPoint: { x: 150, y: 130 },
		});
	});

	it("pointerup after begin drops at the final point and clears dragging", async () => {
		down(machine);
		fire("pointermove", { pointerId: 1, screenX: 120, screenY: 100 });
		await flushMicrotasks();
		setDragging.mockClear();
		fire("pointerup", { pointerId: 1, screenX: 200, screenY: 180 });
		expect(controller.drop).toHaveBeenCalledWith({
			sessionId: "s1",
			screenPoint: { x: 200, y: 180 },
		});
		expect(setDragging).toHaveBeenCalledWith(false);
	});

	it("Escape after begin cancels the session", async () => {
		down(machine);
		fire("pointermove", { pointerId: 1, screenX: 120, screenY: 100 });
		await flushMicrotasks();
		fire("keydown", { key: "Escape" });
		expect(controller.cancel).toHaveBeenCalledWith({ sessionId: "s1" });
		expect(controller.drop).not.toHaveBeenCalled();
	});

	it("a pointerup that arrives while begin is in-flight still drops once it resolves", async () => {
		let resolveBegin: (info: DragSessionInfo) => void = () => {};
		controller.begin.mockImplementationOnce(
			() =>
				new Promise<DragSessionInfo>((r) => {
					resolveBegin = r;
				}),
		);
		down(machine);
		fire("pointermove", { pointerId: 1, screenX: 120, screenY: 100 }); // begin (pending)
		fire("pointerup", { pointerId: 1, screenX: 121, screenY: 100 }); // up before begin resolves
		expect(controller.drop).not.toHaveBeenCalled();
		resolveBegin({ sessionId: "s9", payloadKind: DragPayloadKind.Object, itemCount: 1 });
		await flushMicrotasks();
		expect(controller.drop).toHaveBeenCalledWith({
			sessionId: "s9",
			screenPoint: { x: 121, y: 100 },
		});
	});

	it("cancels the resolved session when the source unmounts while begin is in-flight", async () => {
		let resolveBegin: (info: DragSessionInfo) => void = () => {};
		controller.begin.mockImplementationOnce(
			() =>
				new Promise<DragSessionInfo>((r) => {
					resolveBegin = r;
				}),
		);
		down(machine);
		fire("pointermove", { pointerId: 1, screenX: 120, screenY: 100 }); // begin (pending)
		machine.cancelIfActive(); // unmount-equivalent before begin resolves
		resolveBegin({ sessionId: "s9", payloadKind: DragPayloadKind.Object, itemCount: 1 });
		await flushMicrotasks();
		// The now-live shell session must be cancelled, not orphaned.
		expect(controller.cancel).toHaveBeenCalledWith({ sessionId: "s9" });
		expect(controller.move).not.toHaveBeenCalled();
		expect(controller.drop).not.toHaveBeenCalled();
	});

	it("a queued drop is not downgraded by a stray Escape during begin-in-flight (first-end-wins)", async () => {
		let resolveBegin: (info: DragSessionInfo) => void = () => {};
		controller.begin.mockImplementationOnce(
			() =>
				new Promise<DragSessionInfo>((r) => {
					resolveBegin = r;
				}),
		);
		down(machine);
		fire("pointermove", { pointerId: 1, screenX: 120, screenY: 100 }); // begin (pending)
		fire("pointerup", { pointerId: 1, screenX: 121, screenY: 100 }); // commit drop
		fire("keydown", { key: "Escape" }); // stray — must NOT downgrade to cancel
		resolveBegin({ sessionId: "s1", payloadKind: DragPayloadKind.Object, itemCount: 1 });
		await flushMicrotasks();
		expect(controller.drop).toHaveBeenCalledWith({
			sessionId: "s1",
			screenPoint: { x: 121, y: 100 },
		});
		expect(controller.cancel).not.toHaveBeenCalled();
	});

	it("an empty selection cancels the gesture without beginning", async () => {
		spec.getItems = () => [];
		down(machine);
		fire("pointermove", { pointerId: 1, screenX: 130, screenY: 100 });
		await flushMicrotasks();
		expect(controller.begin).not.toHaveBeenCalled();
		expect(setDragging).not.toHaveBeenCalledWith(true);
	});

	it("removes window listeners after the drag ends (no moves leak after drop)", async () => {
		down(machine);
		fire("pointermove", { pointerId: 1, screenX: 120, screenY: 100 });
		await flushMicrotasks();
		flushRaf();
		fire("pointerup", { pointerId: 1, screenX: 200, screenY: 180 });
		controller.move.mockClear();
		fire("pointermove", { pointerId: 1, screenX: 300, screenY: 300 });
		flushRaf();
		expect(controller.move).not.toHaveBeenCalled();
	});

	it("ignores a non-primary button press", () => {
		machine.onPointerDown({
			button: 2,
			pointerId: 1,
			screenX: 0,
			screenY: 0,
			currentTarget: null,
		});
		fire("pointermove", { pointerId: 1, screenX: 120, screenY: 100 });
		expect(controller.begin).not.toHaveBeenCalled();
	});
});
