// @vitest-environment jsdom
/**
 * Node resize (9.17.23) — the interaction pipeline over the real engine:
 *
 *   1. resize grips materialise only for a SINGLE selected, unlocked node
 *      (multi-select / locked / read-only board show none);
 *   2. dragging a grip resizes the node live (style-only frames) and commits
 *      ONCE on pointerup — a single undo restores the pre-resize box;
 *   3. a locked node refuses the gesture end-to-end (grip gate + commit gate);
 *   4. the resize magnet snaps the moving edge to a neighbour and paints a
 *      guide (via the dev hook, same primitives as the pointer loop);
 *   5. Shift (and the image default) locks the aspect ratio;
 *   6. Alt+Arrow keyboard resize grows/shrinks the selection within the
 *      per-kind minimum.
 */

import { afterEach, describe, expect, it } from "vitest";
import { type WhiteboardEngine, createWhiteboardEngine } from "./engine";
import { ResizeHandle } from "./logic/resize";
import type { EntitiesService, EntityRecord } from "./storage/runtime";

let engine: WhiteboardEngine | null = null;

afterEach(() => {
	engine?.dispose();
	engine = null;
	document.body.replaceChildren();
	window.brainstorm = undefined;
	Reflect.deleteProperty(window, "__brainstormWhiteboardDev");
});

function fakeEntities(): EntitiesService {
	const record = (id: string, type: string, properties: Record<string, unknown>): EntityRecord => ({
		id,
		type,
		properties,
		createdAt: 0,
		updatedAt: 0,
	});
	return {
		get: () => Promise.resolve(null),
		query: () => Promise.resolve([]),
		create: (type, properties, id) => Promise.resolve(record(id ?? "e1", type, properties)),
		update: (id, patch) => Promise.resolve(record(id, "t", patch)),
		delete: () => Promise.resolve(),
	};
}

/** Boot with a repository so `persistBoard` records undo history (standalone
 *  mode skips history entirely — the undo assertions need the shell path). */
function installRuntime(): void {
	window.brainstorm = {
		services: { entities: fakeEntities() },
		on: (event: string, handler: () => void) => {
			if (event === "ready") handler();
		},
	} as unknown as typeof window.brainstorm;
}

function mount(withRuntime = true): WhiteboardEngine {
	if (withRuntime) installRuntime();
	const root = document.createElement("div");
	const canvas = document.createElement("div");
	const layers = document.createElement("div");
	const navList = document.createElement("div");
	root.append(canvas, layers, navList);
	document.body.append(root);
	const next = createWhiteboardEngine({ root, canvas, layers, navList });
	next.start();
	engine = next;
	return next;
}

function dev() {
	const hook = window.__brainstormWhiteboardDev;
	if (!hook) throw new Error("dev hook missing — engine did not boot");
	return hook;
}

function nodeEl(id: string): HTMLElement {
	const el = dev().nodeEl(id);
	if (!el) throw new Error(`no DOM node for "${id}"`);
	return el;
}

function key(target: EventTarget, k: string, init: KeyboardEventInit = {}): void {
	target.dispatchEvent(
		new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
	);
}

function clickNode(id: string): void {
	const el = nodeEl(id);
	el.dispatchEvent(
		new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1 }),
	);
	el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1 }));
}

/** One selected sticky (spawned via the engine command, edit committed). */
function oneSelectedSticky(e: WhiteboardEngine): string {
	e.createSticky();
	key(document, "Escape");
	const id = dev().nodeIds()[0];
	if (!id) throw new Error("no sticky spawned");
	clickNode(id);
	return id;
}

function grip(id: string, handle: string): HTMLElement {
	const el = nodeEl(id).querySelector<HTMLElement>(`.whiteboard__resize-handle--${handle}`);
	if (!el) throw new Error(`no ${handle} grip`);
	return el;
}

function pointer(
	el: HTMLElement,
	type: string,
	x: number,
	y: number,
	init: PointerEventInit = {},
): void {
	el.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			button: type === "pointerdown" ? 0 : -1,
			pointerId: 7,
			clientX: x,
			clientY: y,
			...init,
		}),
	);
}

function sizeOf(id: string): { width: number; height: number } {
	const el = nodeEl(id);
	return {
		width: Number.parseFloat(el.style.width),
		height: Number.parseFloat(el.style.height),
	};
}

describe("resize grips — visibility", () => {
	it("appear on a single selected node (8 grips), not before", () => {
		const e = mount();
		const id = oneSelectedSticky(e);
		const el = nodeEl(id);
		expect(el.classList.contains("whiteboard__node--resizable")).toBe(true);
		expect(el.querySelectorAll(".whiteboard__resize-handle")).toHaveLength(8);
		// Every grip carries a translated label for the SR path.
		for (const g of el.querySelectorAll(".whiteboard__resize-handle")) {
			expect(g.getAttribute("aria-label")).toBeTruthy();
		}
	});

	it("do not show for a multi-selection (v1: single selection only)", () => {
		const e = mount();
		e.createSticky();
		key(document, "Escape");
		e.createSticky();
		key(document, "Escape");
		key(window, "a", { ctrlKey: true });
		for (const id of dev().nodeIds()) {
			expect(nodeEl(id).classList.contains("whiteboard__node--resizable")).toBe(false);
		}
	});

	it("do not show for a locked node nor on a read-only board", () => {
		const e = mount();
		const id = oneSelectedSticky(e);
		e.setSelectionLocked(true);
		expect(nodeEl(id).classList.contains("whiteboard__node--resizable")).toBe(false);
		e.setSelectionLocked(false);
		clickNode(id);
		expect(nodeEl(id).classList.contains("whiteboard__node--resizable")).toBe(true);
		e.setReadonly(true);
		expect(nodeEl(id).classList.contains("whiteboard__node--resizable")).toBe(false);
	});
});

describe("resize gesture — pointer pipeline", () => {
	it("dragging the SE grip resizes live and keeps element identity", () => {
		const e = mount();
		const id = oneSelectedSticky(e);
		const el = nodeEl(id);
		const g = grip(id, "se");
		pointer(g, "pointerdown", 300, 300);
		pointer(g, "pointermove", 340, 324);
		expect(sizeOf(id)).toEqual({ width: 220, height: 204 });
		pointer(g, "pointermove", 360, 330);
		expect(sizeOf(id)).toEqual({ width: 240, height: 210 });
		pointer(g, "pointerup", 360, 330);
		expect(sizeOf(id)).toEqual({ width: 240, height: 210 });
		// Style-only frames — the element survives the gesture + settle.
		expect(nodeEl(id)).toBe(el);
	});

	it("a NW drag anchors the bottom-right corner (x/y shift too)", () => {
		const e = mount();
		const id = oneSelectedSticky(e);
		const el = nodeEl(id);
		const startLeft = Number.parseFloat(el.style.left);
		const startTop = Number.parseFloat(el.style.top);
		const g = grip(id, "nw");
		pointer(g, "pointerdown", 100, 100);
		pointer(g, "pointermove", 60, 76);
		pointer(g, "pointerup", 60, 76);
		expect(sizeOf(id)).toEqual({ width: 220, height: 204 });
		expect(Number.parseFloat(el.style.left)).toBe(startLeft - 40);
		expect(Number.parseFloat(el.style.top)).toBe(startTop - 24);
	});

	it("clamps at the sticky minimum (80×80) instead of inverting", () => {
		const e = mount();
		const id = oneSelectedSticky(e);
		const g = grip(id, "se");
		pointer(g, "pointerdown", 300, 300);
		pointer(g, "pointermove", -700, -700);
		pointer(g, "pointerup", -700, -700);
		expect(sizeOf(id)).toEqual({ width: 80, height: 80 });
	});

	it("commits ONCE — a single undo restores the pre-resize box", () => {
		const e = mount();
		const id = oneSelectedSticky(e);
		const g = grip(id, "se");
		pointer(g, "pointerdown", 300, 300);
		// Many frames, one gesture.
		for (let i = 1; i <= 5; i++) pointer(g, "pointermove", 300 + i * 10, 300 + i * 6);
		pointer(g, "pointerup", 350, 330);
		expect(sizeOf(id)).toEqual({ width: 230, height: 210 });
		e.undo();
		expect(sizeOf(id)).toEqual({ width: 180, height: 180 });
	});

	it("Shift locks the aspect ratio mid-gesture", () => {
		const e = mount();
		const id = oneSelectedSticky(e);
		const g = grip(id, "se");
		pointer(g, "pointerdown", 300, 300);
		pointer(g, "pointermove", 360, 300, { shiftKey: true });
		const s = sizeOf(id);
		// Sticky starts square (180×180) — the dominant axis drives both.
		expect(s.width).toBe(240);
		expect(s.height).toBe(240);
		pointer(g, "pointerup", 360, 300, { shiftKey: true });
	});

	it("a locked node refuses the gesture at the grip AND at the commit", () => {
		const e = mount();
		const id = oneSelectedSticky(e);
		e.setSelectionLocked(true);
		const g = grip(id, "se");
		pointer(g, "pointerdown", 300, 300);
		pointer(g, "pointermove", 400, 400);
		pointer(g, "pointerup", 400, 400);
		expect(sizeOf(id)).toEqual({ width: 180, height: 180 });
		// Commit gate: lock lands MID-gesture — the whole resize is voided.
		e.setSelectionLocked(false);
		clickNode(id);
		const g2 = grip(id, "se");
		pointer(g2, "pointerdown", 300, 300);
		pointer(g2, "pointermove", 340, 340);
		e.setSelectionLocked(true);
		pointer(g2, "pointerup", 340, 340);
		expect(sizeOf(id)).toEqual({ width: 180, height: 180 });
	});
});

describe("resize magnet — dev hook (same primitives as the pointer loop)", () => {
	it("snaps the moving right edge to a neighbour and paints a guide", () => {
		mount();
		const ids = dev().seedGrid(2, { cols: 2, cell: 240 });
		const [a] = ids;
		if (!a) throw new Error("seed failed");
		// Raw right edge 236 — 4px shy of the neighbour's left edge at 240.
		const result = dev().resizeNodeBy(a, ResizeHandle.East, 56, 0);
		expect(result.width).toBe(240);
		expect(result.guides).toBeGreaterThanOrEqual(1);
		expect(document.querySelectorAll(".whiteboard__guide").length).toBeGreaterThanOrEqual(1);
		dev().endResize();
		expect(document.querySelectorAll(".whiteboard__guide")).toHaveLength(0);
	});

	it("refuses a locked node (box comes back unchanged)", () => {
		const e = mount();
		const id = oneSelectedSticky(e);
		e.setSelectionLocked(true);
		const result = dev().resizeNodeBy(id, ResizeHandle.East, 60, 0);
		expect(result.width).toBe(180);
		expect(result.guides).toBe(0);
	});
});

describe("keyboard resize — Alt+Arrows", () => {
	it("widens / shrinks the single selected node from its bottom-right", () => {
		const e = mount();
		const id = oneSelectedSticky(e);
		const el = nodeEl(id);
		const startLeft = el.style.left;
		key(window, "ArrowRight", { altKey: true });
		expect(sizeOf(id).width).toBe(188);
		key(window, "ArrowDown", { altKey: true });
		expect(sizeOf(id).height).toBe(188);
		key(window, "ArrowLeft", { altKey: true });
		expect(sizeOf(id).width).toBe(180);
		// Top-left anchored — the node did not move.
		expect(el.style.left).toBe(startLeft);
	});

	it("floors at the per-kind minimum", () => {
		const e = mount();
		const id = oneSelectedSticky(e);
		for (let i = 0; i < 30; i++) key(window, "ArrowLeft", { altKey: true });
		expect(sizeOf(id).width).toBe(80);
	});

	it("is inert on a read-only board and on a locked node", () => {
		const e = mount();
		const id = oneSelectedSticky(e);
		e.setReadonly(true);
		key(window, "ArrowRight", { altKey: true });
		expect(sizeOf(id).width).toBe(180);
		e.setReadonly(false);
		clickNode(id);
		e.setSelectionLocked(true);
		key(window, "ArrowRight", { altKey: true });
		expect(sizeOf(id).width).toBe(180);
	});
});
