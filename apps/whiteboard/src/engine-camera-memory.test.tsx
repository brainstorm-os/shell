// @vitest-environment jsdom
/**
 * 9.17.24 — a board reopens on the camera the user left it at (per board,
 * per device, through the settings service), while a never-moved board keeps
 * the open-time camera and is not written back.
 */

import type { SettingsService } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WhiteboardEngine, createWhiteboardEngine } from "./engine";
import { BoardTemplate } from "./logic/templates";

let engine: WhiteboardEngine | null = null;
let hosts: HTMLDivElement[] = [];
let put: ReturnType<typeof vi.fn<(key: string, value: unknown) => Promise<void>>>;

function mountHosts() {
	const make = (cls: string): HTMLDivElement => {
		const el = document.createElement("div");
		el.className = cls;
		document.body.appendChild(el);
		hosts.push(el);
		return el;
	};
	return {
		root: make("whiteboard-root"),
		canvas: make("canvas"),
		layers: make("layers"),
		navList: make("nav-list"),
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	put = vi.fn(async (_key: string, _value: unknown) => undefined);
	const settings: SettingsService = {
		get: async () => null,
		put,
		delete: async () => true,
		list: async () => [],
	};
	window.brainstorm = { services: { settings } } as unknown as typeof window.brainstorm;
	engine = createWhiteboardEngine(mountHosts());
});

afterEach(() => {
	engine?.dispose();
	engine = null;
	for (const el of hosts) el.remove();
	hosts = [];
	window.brainstorm = undefined;
	vi.useRealTimers();
});

function zoomPercent(): number {
	return engine?.getSnapshot().zoomPercent ?? 0;
}

describe("whiteboard camera memory", () => {
	it("restores a board's last camera on reopen and persists it once, debounced", () => {
		const e = engine;
		if (!e) throw new Error("no engine");
		e.createNewBoard(BoardTemplate.Blank);
		const a = e.getSnapshot().boardId;
		e.zoomTo(2);
		e.zoomTo(1.5);
		expect(zoomPercent()).toBe(150);

		e.createNewBoard(BoardTemplate.Blank);
		expect(zoomPercent()).toBe(100);

		e.goBoardBack();
		expect(e.getSnapshot().boardId).toBe(a);
		expect(zoomPercent()).toBe(150);

		vi.runAllTimers();
		const writes = put.mock.calls.filter(([key]) => key === `camera:${a}`);
		expect(writes).toHaveLength(1);
		expect(writes[0]?.[1]).toMatchObject({ zoom: 1.5 });
	});

	it("never writes a camera for a board the user did not move", () => {
		const e = engine;
		if (!e) throw new Error("no engine");
		e.createNewBoard(BoardTemplate.Blank);
		e.createNewBoard(BoardTemplate.Blank);
		e.goBoardBack();
		vi.runAllTimers();
		expect(put).not.toHaveBeenCalled();
	});

	it("flushes a pending camera when the engine is disposed", () => {
		const e = engine;
		if (!e) throw new Error("no engine");
		e.createNewBoard(BoardTemplate.Blank);
		e.zoomTo(0.5);
		expect(put).not.toHaveBeenCalled();
		e.dispose();
		engine = null;
		expect(put).toHaveBeenCalledOnce();
	});
});
