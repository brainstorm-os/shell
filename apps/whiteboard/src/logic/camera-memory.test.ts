import type { SettingsService } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import {
	CAMERA_KEY_PREFIX,
	DEFAULT_CAMERA,
	FIT_MAX_ZOOM,
	MAX_REMEMBERED_CAMERAS,
	MIN_ZOOM,
	createCameraMemory,
	fitCamera,
	parseCamera,
} from "./camera-memory";

function fakeSettings(seed: Record<string, unknown> = {}) {
	const store = new Map<string, unknown>(Object.entries(seed));
	const settings: SettingsService = {
		get: async <T>(key: string) => (store.get(key) as T) ?? null,
		put: vi.fn(async (key: string, value: unknown) => {
			store.set(key, value);
		}),
		delete: vi.fn(async (key: string) => store.delete(key)),
		list: async (prefix = "") =>
			[...store].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
	};
	return { settings, store };
}

function manualTimers() {
	let next = 1;
	const queued = new Map<number, () => void>();
	return {
		timers: {
			setTimeout: (fn: () => void) => {
				const id = next++;
				queued.set(id, fn);
				return id;
			},
			clearTimeout: (id: unknown) => {
				queued.delete(id as number);
			},
		},
		runAll: () => {
			const fns = [...queued.values()];
			queued.clear();
			for (const fn of fns) fn();
		},
		pending: () => queued.size,
	};
}

describe("parseCamera", () => {
	it("accepts finite cameras and clamps zoom", () => {
		expect(parseCamera({ panX: 10, panY: -4, zoom: 9 })).toEqual({ panX: 10, panY: -4, zoom: 3 });
		expect(parseCamera({ panX: 0, panY: 0, zoom: 0.01 })?.zoom).toBe(MIN_ZOOM);
	});

	it("rejects anything unusable", () => {
		expect(parseCamera(null)).toBeNull();
		expect(parseCamera({ panX: "1", panY: 0, zoom: 1 })).toBeNull();
		expect(parseCamera({ panX: 0, panY: Number.NaN, zoom: 1 })).toBeNull();
		expect(parseCamera({ panX: 0, panY: 0, zoom: 0 })).toBeNull();
	});
});

describe("fitCamera", () => {
	it("returns the default camera for an empty board or an unmeasured viewport", () => {
		expect(fitCamera([], { width: 800, height: 600 })).toEqual(DEFAULT_CAMERA);
		expect(fitCamera([{ x: 0, y: 0, width: 10, height: 10 }], { width: 0, height: 0 })).toEqual(
			DEFAULT_CAMERA,
		);
	});

	it("centres small content at 1:1 rather than zooming in", () => {
		const cam = fitCamera([{ x: 100, y: 100, width: 200, height: 100 }], { width: 800, height: 600 });
		expect(cam.zoom).toBe(FIT_MAX_ZOOM);
		expect(cam.panX + 200 * cam.zoom).toBe(400);
		expect(cam.panY + 150 * cam.zoom).toBe(300);
	});

	it("zooms out so wide content fits with padding", () => {
		const cam = fitCamera(
			[
				{ x: 0, y: 0, width: 100, height: 100 },
				{ x: 1900, y: 0, width: 100, height: 100 },
			],
			{ width: 1000, height: 600 },
			50,
		);
		expect(cam.zoom).toBeCloseTo(900 / 2000);
		const left = 0 * cam.zoom + cam.panX;
		const right = 2000 * cam.zoom + cam.panX;
		expect(left).toBeCloseTo(50);
		expect(right).toBeCloseTo(950);
	});
});

describe("createCameraMemory", () => {
	it("loads stored cameras and recalls them synchronously", async () => {
		const { settings } = fakeSettings({
			[`${CAMERA_KEY_PREFIX}board-a`]: { panX: 5, panY: 6, zoom: 2 },
			[`${CAMERA_KEY_PREFIX}board-bad`]: { panX: "x" },
			other: { panX: 1, panY: 1, zoom: 1 },
		});
		const memory = createCameraMemory(settings);
		expect(memory.recall("board-a")).toBeNull();
		await memory.load();
		expect(memory.recall("board-a")).toEqual({ panX: 5, panY: 6, zoom: 2 });
		expect(memory.recall("board-bad")).toBeNull();
	});

	it("debounces writes per board into one put of the last camera", () => {
		const { settings } = fakeSettings();
		const clock = manualTimers();
		const memory = createCameraMemory(settings, { timers: clock.timers });
		memory.remember("a", { panX: 1, panY: 0, zoom: 1 });
		memory.remember("a", { panX: 2, panY: 0, zoom: 1 });
		memory.remember("a", { panX: 3, panY: 0, zoom: 1 });
		expect(settings.put).not.toHaveBeenCalled();
		expect(memory.recall("a")).toEqual({ panX: 3, panY: 0, zoom: 1 });
		clock.runAll();
		expect(settings.put).toHaveBeenCalledOnce();
		expect(settings.put).toHaveBeenCalledWith("camera:a", { panX: 3, panY: 0, zoom: 1 });
	});

	it("skips an unchanged camera and flushes pending writes on demand", () => {
		const { settings } = fakeSettings();
		const clock = manualTimers();
		const memory = createCameraMemory(settings, { timers: clock.timers });
		memory.remember("a", { panX: 1, panY: 1, zoom: 1 });
		memory.flush();
		expect(settings.put).toHaveBeenCalledOnce();
		expect(clock.pending()).toBe(0);
		memory.remember("a", { panX: 1, panY: 1, zoom: 1 });
		expect(clock.pending()).toBe(0);
	});

	it("forgets the least-recently-moved board past the cap", () => {
		const { settings } = fakeSettings();
		const memory = createCameraMemory(settings, { timers: manualTimers().timers });
		for (let i = 0; i <= MAX_REMEMBERED_CAMERAS; i += 1) {
			memory.remember(`b${i}`, { panX: i, panY: 0, zoom: 1 });
		}
		expect(memory.recall("b0")).toBeNull();
		expect(memory.recall(`b${MAX_REMEMBERED_CAMERAS}`)).not.toBeNull();
		expect(settings.delete).toHaveBeenCalledWith("camera:b0");
	});

	it("degrades to no memory without a settings service", async () => {
		const memory = createCameraMemory(undefined);
		await memory.load();
		memory.remember("a", { panX: 1, panY: 1, zoom: 1 });
		memory.flush();
		expect(memory.recall("a")).toEqual({ panX: 1, panY: 1, zoom: 1 });
	});
});
