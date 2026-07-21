import { type DragGhostSpec, DropEffect } from "@brainstorm-os/sdk-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `ghost-overlay` imports `electron` at module scope for `createElectronGhostWindow`;
// the overlay logic under test never touches it. A stub keeps the import resolvable.
vi.mock("electron", () => ({ BrowserWindow: class {} }));

import {
	GHOST_CURSOR_OFFSET,
	type GhostWindow,
	createGhostOverlay,
	ghostScreenPosition,
} from "./ghost-overlay";

const SPEC: DragGhostSpec = { label: "Roadmap", iconRef: "📄", count: 3 };

type FakeWindow = GhostWindow & {
	positions: Array<{ x: number; y: number }>;
	renders: Array<{ spec: DragGhostSpec; effect: DropEffect }>;
	shown: number;
	hidden: number;
	destroy(): void;
};

function makeFakeWindow(): FakeWindow {
	let destroyed = false;
	const win: FakeWindow = {
		positions: [],
		renders: [],
		shown: 0,
		hidden: 0,
		isDestroyed: () => destroyed,
		setPosition: (x, y) => win.positions.push({ x, y }),
		render: (spec, effect) => win.renders.push({ spec, effect }),
		showInactive: () => {
			win.shown += 1;
		},
		hide: () => {
			win.hidden += 1;
		},
		destroy: () => {
			destroyed = true;
		},
	};
	return win;
}

describe("ghostScreenPosition", () => {
	it("offsets the cursor hot-spot and rounds to integer screen px", () => {
		expect(ghostScreenPosition({ x: 100.4, y: 200.6 })).toEqual({
			x: 100 + GHOST_CURSOR_OFFSET.x,
			y: 201 + GHOST_CURSOR_OFFSET.y,
		});
	});
});

describe("createGhostOverlay", () => {
	let factory: ReturnType<typeof vi.fn>;
	let windows: FakeWindow[];

	beforeEach(() => {
		windows = [];
		factory = vi.fn(() => {
			const w = makeFakeWindow();
			windows.push(w);
			return w;
		});
	});

	it("lazily creates the window only on the first show", () => {
		const overlay = createGhostOverlay(factory as unknown as () => GhostWindow);
		expect(factory).not.toHaveBeenCalled();
		overlay.show(SPEC, { x: 10, y: 20 });
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("positions, renders with no-effect, and shows inactively on show", () => {
		const overlay = createGhostOverlay(factory as unknown as () => GhostWindow);
		overlay.show(SPEC, { x: 10, y: 20 });
		const w = windows[0];
		if (!w) throw new Error("no window");
		expect(w.positions).toEqual([ghostScreenPosition({ x: 10, y: 20 })]);
		expect(w.renders).toEqual([{ spec: SPEC, effect: DropEffect.None }]);
		expect(w.shown).toBe(1);
	});

	it("move before show is a no-op", () => {
		const overlay = createGhostOverlay(factory as unknown as () => GhostWindow);
		overlay.move({ x: 1, y: 2 });
		expect(factory).not.toHaveBeenCalled();
	});

	it("move after show only repositions (no re-render, no extra create)", () => {
		const overlay = createGhostOverlay(factory as unknown as () => GhostWindow);
		overlay.show(SPEC, { x: 10, y: 20 });
		overlay.move({ x: 50, y: 60 });
		const w = windows[0];
		if (!w) throw new Error("no window");
		expect(factory).toHaveBeenCalledTimes(1);
		expect(w.positions).toEqual([
			ghostScreenPosition({ x: 10, y: 20 }),
			ghostScreenPosition({ x: 50, y: 60 }),
		]);
		expect(w.renders).toHaveLength(1);
	});

	it("setEffect re-renders the last spec with the new effect", () => {
		const overlay = createGhostOverlay(factory as unknown as () => GhostWindow);
		overlay.show(SPEC, { x: 10, y: 20 });
		overlay.setEffect(DropEffect.Link);
		const w = windows[0];
		if (!w) throw new Error("no window");
		expect(w.renders[1]).toEqual({ spec: SPEC, effect: DropEffect.Link });
	});

	it("setEffect before show is a no-op", () => {
		const overlay = createGhostOverlay(factory as unknown as () => GhostWindow);
		overlay.setEffect(DropEffect.Move);
		expect(factory).not.toHaveBeenCalled();
	});

	it("show resets the effect back to None for a fresh drag", () => {
		const overlay = createGhostOverlay(factory as unknown as () => GhostWindow);
		overlay.show(SPEC, { x: 0, y: 0 });
		overlay.setEffect(DropEffect.Move);
		overlay.hide();
		overlay.show(SPEC, { x: 5, y: 5 });
		const w = windows[0];
		if (!w) throw new Error("no window");
		const lastRender = w.renders.at(-1);
		expect(lastRender).toEqual({ spec: SPEC, effect: DropEffect.None });
	});

	it("hide hides the live window", () => {
		const overlay = createGhostOverlay(factory as unknown as () => GhostWindow);
		overlay.show(SPEC, { x: 0, y: 0 });
		overlay.hide();
		const w = windows[0];
		if (!w) throw new Error("no window");
		expect(w.hidden).toBe(1);
	});

	it("re-creates the window if the previous one was destroyed", () => {
		const overlay = createGhostOverlay(factory as unknown as () => GhostWindow);
		overlay.show(SPEC, { x: 0, y: 0 });
		windows[0]?.destroy();
		overlay.show(SPEC, { x: 1, y: 1 });
		expect(factory).toHaveBeenCalledTimes(2);
	});

	it("move/setEffect/hide tolerate a destroyed window without throwing", () => {
		const overlay = createGhostOverlay(factory as unknown as () => GhostWindow);
		overlay.show(SPEC, { x: 0, y: 0 });
		windows[0]?.destroy();
		expect(() => {
			overlay.move({ x: 9, y: 9 });
			overlay.setEffect(DropEffect.Copy);
			overlay.hide();
		}).not.toThrow();
	});
});
