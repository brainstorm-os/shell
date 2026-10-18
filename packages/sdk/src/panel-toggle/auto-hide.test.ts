import { describe, expect, it } from "vitest";
import {
	AUTO_HIDE_SIDEBARS_ATTRIBUTE,
	type AutoHideTimers,
	createAutoHideController,
	readAutoHideSidebarsPreference,
} from "./auto-hide";

function fakeTimers() {
	let now = 0;
	const queue = new Map<number, { at: number; fn: () => void }>();
	let seq = 0;
	const timers: AutoHideTimers = {
		set: (fn, ms) => {
			seq += 1;
			queue.set(seq, { at: now + ms, fn });
			return seq;
		},
		clear: (handle) => {
			queue.delete(handle as number);
		},
	};
	const advance = (ms: number) => {
		now += ms;
		for (const [id, entry] of [...queue]) {
			if (entry.at <= now) {
				queue.delete(id);
				entry.fn();
			}
		}
	};
	return { timers, advance };
}

function setup() {
	const { timers, advance } = fakeTimers();
	const changes: boolean[] = [];
	const controller = createAutoHideController({
		onChange: (revealed) => changes.push(revealed),
		revealDelayMs: 100,
		hideDelayMs: 200,
		timers,
	});
	return { controller, changes, advance };
}

describe("auto-hide controller (7.15)", () => {
	it("reveals only after the pointer rests on the edge for the delay", () => {
		const { controller, changes, advance } = setup();
		controller.edgeEnter();
		advance(99);
		expect(controller.revealed).toBe(false);
		advance(1);
		expect(controller.revealed).toBe(true);
		expect(changes).toEqual([true]);
	});

	it("a pointer that just crosses the edge never reveals", () => {
		const { controller, advance } = setup();
		controller.edgeEnter();
		advance(50);
		controller.edgeLeave();
		advance(500);
		expect(controller.revealed).toBe(false);
	});

	it("hides after the pointer leaves the revealed panel, unless it comes back", () => {
		const { controller, advance } = setup();
		controller.edgeEnter();
		advance(100);
		controller.panelEnter();
		controller.panelLeave();
		advance(150);
		controller.panelEnter();
		advance(500);
		expect(controller.revealed).toBe(true);
		controller.panelLeave();
		advance(200);
		expect(controller.revealed).toBe(false);
	});

	it("keyboard: toggle reveals immediately; focus inside holds it open past pointer-leave", () => {
		const { controller, advance } = setup();
		controller.toggle();
		expect(controller.revealed).toBe(true);
		controller.focusIn();
		controller.panelEnter();
		controller.panelLeave();
		advance(1000);
		expect(controller.revealed).toBe(true);
		controller.focusOut();
		advance(200);
		expect(controller.revealed).toBe(false);
	});

	it("toggle hides a revealed panel; hide() cancels a pending reveal", () => {
		const { controller, advance } = setup();
		controller.toggle();
		controller.toggle();
		expect(controller.revealed).toBe(false);
		controller.edgeEnter();
		controller.hide();
		advance(500);
		expect(controller.revealed).toBe(false);
	});

	it("reads the shell preference from the root attribute", () => {
		const root = { hasAttribute: (name: string) => name === AUTO_HIDE_SIDEBARS_ATTRIBUTE };
		expect(readAutoHideSidebarsPreference(root as unknown as Element)).toBe(true);
		expect(readAutoHideSidebarsPreference(null)).toBe(false);
	});
});
