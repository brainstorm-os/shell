import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppLauncher } from "../apps/launcher";
import type { MonitorInfo } from "./monitor";
import { TilePreset } from "./tile";
import { type WindowController, type WindowEvent, WindowIndex, WindowState } from "./window-index";

type Listeners = Partial<Record<WindowEvent, Set<() => void>>>;

function fakeController(initial: {
	title?: string;
	bounds?: { x: number; y: number; width: number; height: number };
	focused?: boolean;
	minimized?: boolean;
	maximized?: boolean;
	fullscreen?: boolean;
}): WindowController & {
	fire: (event: WindowEvent) => void;
	mutate: (m: Partial<typeof initial>) => void;
	destroy: () => void;
} {
	const listeners: Listeners = {};
	const state = {
		destroyed: false,
		title: initial.title ?? "Untitled",
		bounds: initial.bounds ?? { x: 0, y: 0, width: 800, height: 600 },
		focused: initial.focused ?? false,
		minimized: initial.minimized ?? false,
		maximized: initial.maximized ?? false,
		fullscreen: initial.fullscreen ?? false,
	};
	const controller: WindowController & {
		fire: (event: WindowEvent) => void;
		mutate: (m: Partial<typeof initial>) => void;
		destroy: () => void;
	} = {
		id: Math.floor(Math.random() * 1000),
		isDestroyed: () => state.destroyed,
		getTitle: () => state.title,
		getBounds: () => ({ ...state.bounds }),
		isFocused: () => state.focused,
		isMinimized: () => state.minimized,
		isMaximized: () => state.maximized,
		isFullScreen: () => state.fullscreen,
		focus: () => {
			state.focused = true;
		},
		show: () => undefined,
		restore: () => {
			state.minimized = false;
		},
		minimize: () => {
			state.minimized = true;
		},
		close: () => {
			state.destroyed = true;
		},
		maximize: () => {
			state.maximized = true;
		},
		unmaximize: () => {
			state.maximized = false;
		},
		setBounds: (b) => {
			state.bounds = { ...b };
		},
		on: (event, listener) => {
			let set = listeners[event];
			if (!set) {
				set = new Set();
				listeners[event] = set;
			}
			set.add(listener);
		},
		off: (event, listener) => {
			listeners[event]?.delete(listener);
		},
		fire: (event) => {
			for (const l of listeners[event] ?? []) l();
		},
		mutate: (m) => {
			Object.assign(state, m);
		},
		destroy: () => {
			state.destroyed = true;
		},
	};
	return controller;
}

type ContainerView = {
	container: { baseWindow: WindowController; activeRoute: () => string | null };
	appId: string;
	windowId: string;
	parked: boolean;
};

type FakeLauncher = AppLauncher & {
	add: (view: ContainerView) => void;
	remove: (key: string) => void;
	/** Simulate a container-driven change (title/route/active-tab) — the real
	 *  launcher relays the container's change stream through `onWindowsChanged`. */
	notify: () => void;
};

function fakeLauncher(): FakeLauncher {
	const map = new Map<string, ContainerView>();
	const listeners = new Set<() => void>();
	const fire = () => {
		for (const l of listeners) l();
	};
	const launcher = {
		allContainers: () => [...map.values()],
		onWindowsChanged: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		add: (view: ContainerView) => {
			map.set(`${view.appId}::${view.windowId}`, view);
			fire();
		},
		remove: (key: string) => {
			map.delete(key);
			fire();
		},
		notify: fire,
		// Unused methods on AppLauncher — left undefined for test purposes.
	} as unknown as FakeLauncher;
	return launcher;
}

const monitor: MonitorInfo = {
	id: 1,
	bounds: { x: 0, y: 0, width: 1920, height: 1080 },
	workArea: { x: 0, y: 30, width: 1920, height: 1050 },
	scaleFactor: 1,
	primary: true,
};
const second: MonitorInfo = {
	id: 2,
	bounds: { x: 1920, y: 0, width: 1440, height: 900 },
	workArea: { x: 1920, y: 0, width: 1440, height: 860 },
	scaleFactor: 1,
};

function buildEntry(
	appId: string,
	windowId: string,
	controller: WindowController,
	route: string | null = null,
): ContainerView {
	return {
		container: { baseWindow: controller, activeRoute: () => route },
		appId,
		windowId,
		parked: false,
	};
}

describe("WindowIndex", () => {
	let launcher: FakeLauncher;
	let index: WindowIndex;
	const monitors: MonitorInfo[] = [monitor, second];

	beforeEach(() => {
		launcher = fakeLauncher();
		index = new WindowIndex({
			launcher,
			getMonitors: () => monitors,
			resolveAppMeta: (appId) => ({ appId, appName: `${appId} app` }),
		});
	});

	it("starts empty and tracks a window when the launcher reports one", () => {
		expect(index.list()).toEqual([]);
		const controller = fakeController({ title: "Untitled — Notes" });
		launcher.add(buildEntry("notes", "main", controller));
		const list = index.list();
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			id: "notes::main",
			appId: "notes",
			appName: "notes app",
			windowId: "main",
			title: "Untitled — Notes",
			state: WindowState.Normal,
			focused: false,
		});
	});

	it("remembers the OS window's bounds, never a pane's: a split layout leaves them untouched", () => {
		const controller = fakeController({ bounds: { x: 0, y: 0, width: 1206, height: 700 } });
		launcher.add(buildEntry("notes", "main", controller));
		// A split lays the panes out as child views; the window itself does not
		// move, so the tracker hears nothing and keeps the window's size.
		launcher.notify();
		expect(index.list()[0]?.bounds).toEqual({ x: 0, y: 0, width: 1206, height: 700 });
		controller.mutate({ bounds: { x: 0, y: 0, width: 900, height: 700 } });
		controller.fire("resize");
		expect(index.list()[0]?.bounds.width).toBe(900);
	});

	it("untracks a window when it disappears from the launcher", () => {
		const controller = fakeController({});
		launcher.add(buildEntry("notes", "main", controller));
		expect(index.list()).toHaveLength(1);
		launcher.remove("notes::main");
		expect(index.list()).toEqual([]);
	});

	it("updates title when the container reports a change", () => {
		const controller = fakeController({ title: "Untitled" });
		launcher.add(buildEntry("notes", "main", controller));
		controller.mutate({ title: "My note — Notes" });
		launcher.notify();
		expect(index.list()[0]?.title).toBe("My note — Notes");
	});

	it("exposes the active route the container reports", () => {
		const controller = fakeController({});
		launcher.add(buildEntry("notes", "main", controller, "brainstorm://entity/ent_x"));
		expect(index.list()[0]?.route).toBe("brainstorm://entity/ent_x");
	});

	it("tracks focus: flips other entries off when a new one focuses", () => {
		const a = fakeController({});
		const b = fakeController({});
		launcher.add(buildEntry("notes", "main", a));
		launcher.add(buildEntry("files", "main", b));
		a.mutate({ focused: true });
		a.fire("focus");
		expect(index.get("notes::main")?.focused).toBe(true);
		expect(index.get("files::main")?.focused).toBe(false);

		a.mutate({ focused: false });
		b.mutate({ focused: true });
		b.fire("focus");
		expect(index.get("notes::main")?.focused).toBe(false);
		expect(index.get("files::main")?.focused).toBe(true);
	});

	it("orders list MRU-first", () => {
		const a = fakeController({});
		const b = fakeController({});
		const c = fakeController({});
		launcher.add(buildEntry("notes", "main", a));
		launcher.add(buildEntry("files", "main", b));
		launcher.add(buildEntry("graph", "main", c));

		a.mutate({ focused: true });
		a.fire("focus");
		a.mutate({ focused: false });
		c.mutate({ focused: true });
		c.fire("focus");

		const list = index.list();
		expect(list[0]?.id).toBe("graph::main");
		expect(list[1]?.id).toBe("notes::main");
	});

	it("reports state transitions (minimize / maximize / fullscreen)", () => {
		const controller = fakeController({});
		launcher.add(buildEntry("notes", "main", controller));

		controller.mutate({ minimized: true });
		controller.fire("minimize");
		expect(index.get("notes::main")?.state).toBe(WindowState.Minimized);

		controller.mutate({ minimized: false, maximized: true });
		controller.fire("maximize");
		expect(index.get("notes::main")?.state).toBe(WindowState.Maximized);

		controller.mutate({ maximized: false, fullscreen: true });
		controller.fire("enter-full-screen");
		expect(index.get("notes::main")?.state).toBe(WindowState.Fullscreen);
	});

	it("focus(id) restores a minimized window and calls focus", () => {
		const controller = fakeController({ minimized: true });
		launcher.add(buildEntry("notes", "main", controller));
		const restoreSpy = vi.spyOn(controller, "restore");
		const focusSpy = vi.spyOn(controller, "focus");
		expect(index.focus("notes::main")).toBe(true);
		expect(restoreSpy).toHaveBeenCalled();
		expect(focusSpy).toHaveBeenCalled();
	});

	it("focus(id) returns false for unknown id", () => {
		expect(index.focus("missing::main")).toBe(false);
	});

	it("tile() sets bounds based on the entry's current monitor", () => {
		const controller = fakeController({
			bounds: { x: 100, y: 100, width: 800, height: 600 },
		});
		launcher.add(buildEntry("notes", "main", controller));
		const setSpy = vi.spyOn(controller, "setBounds");
		expect(index.tile("notes::main", TilePreset.LeftHalf)).toBe(true);
		expect(setSpy).toHaveBeenCalledWith({ x: 0, y: 30, width: 960, height: 1050 });
	});

	it("tile() into a specific monitor uses that monitor's work area", () => {
		const controller = fakeController({});
		launcher.add(buildEntry("notes", "main", controller));
		const setSpy = vi.spyOn(controller, "setBounds");
		const secondId = index.monitors().find((m) => !m.primary)?.id;
		expect(secondId).toBeDefined();
		expect(index.tile("notes::main", TilePreset.Fill, secondId)).toBe(true);
		expect(setSpy).toHaveBeenCalledWith({ x: 1920, y: 0, width: 1440, height: 860 });
	});

	it("moveToMonitor() preserves relative position", () => {
		const controller = fakeController({
			bounds: { x: 0, y: 30, width: 800, height: 600 },
		});
		launcher.add(buildEntry("notes", "main", controller));
		const setSpy = vi.spyOn(controller, "setBounds");
		const secondId = index.monitors().find((m) => !m.primary)?.id;
		expect(secondId).toBeDefined();
		expect(index.moveToMonitor("notes::main", secondId ?? "")).toBe(true);
		expect(setSpy).toHaveBeenCalled();
		const arg = setSpy.mock.calls[0]?.[0];
		expect(arg?.x).toBeGreaterThanOrEqual(1920);
		expect(arg && arg.x + arg.width).toBeLessThanOrEqual(1920 + 1440);
	});

	it("monitors() reports id, label, primary flag, bounds", () => {
		const list = index.monitors();
		expect(list).toHaveLength(2);
		expect(list[0]?.primary).toBe(true);
		expect(list[0]?.label).toBe("Primary");
		expect(list[1]?.label).toBe("Display 2");
	});

	it("notifies subscribers on add / remove / focus / title-update", () => {
		const listener = vi.fn();
		index.onChanged(listener);
		const controller = fakeController({});
		launcher.add(buildEntry("notes", "main", controller));
		expect(listener).toHaveBeenCalled();
		listener.mockClear();
		controller.fire("focus");
		expect(listener).toHaveBeenCalled();
		listener.mockClear();
		launcher.notify();
		expect(listener).toHaveBeenCalled();
	});

	it("coalesces a burst of move/resize events into a single trailing notify", () => {
		vi.useFakeTimers();
		try {
			const listener = vi.fn();
			index.onChanged(listener);
			const controller = fakeController({});
			launcher.add(buildEntry("notes", "main", controller));
			listener.mockClear();

			controller.mutate({ bounds: { x: 10, y: 10, width: 800, height: 600 } });
			controller.fire("move");
			controller.fire("move");
			controller.fire("resize");
			controller.fire("move");
			// All four high-frequency events coalesce — none flush synchronously.
			expect(listener).not.toHaveBeenCalled();

			vi.runAllTimers();
			expect(listener).toHaveBeenCalledTimes(1);
			expect(index.get("notes::main")?.bounds).toMatchObject({ x: 10, y: 10 });
		} finally {
			vi.useRealTimers();
		}
	});

	it("an immediate (discrete) notify cancels a pending coalesced flush", () => {
		vi.useFakeTimers();
		try {
			const listener = vi.fn();
			index.onChanged(listener);
			const controller = fakeController({});
			launcher.add(buildEntry("notes", "main", controller));
			listener.mockClear();

			controller.fire("move"); // schedules a trailing flush
			controller.fire("focus"); // discrete → flushes now, cancels the trailing one
			expect(listener).toHaveBeenCalledTimes(1);

			vi.runAllTimers();
			expect(listener).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("dispose() stops emitting and detaches listeners", () => {
		const listener = vi.fn();
		index.onChanged(listener);
		const controller = fakeController({});
		launcher.add(buildEntry("notes", "main", controller));
		listener.mockClear();
		index.dispose();
		controller.fire("focus");
		expect(listener).not.toHaveBeenCalled();
	});
});
