import {
	CHROME_SPLIT_DRAG,
	CHROME_SPLIT_STEP,
	SplitStep,
} from "@brainstorm-os/protocol/chrome-tabs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<
	string,
	(event: { sender: { id: number } }, ...args: unknown[]) => unknown
>();

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (event: { sender: { id: number } }, ...a: unknown[]) => unknown) =>
			handlers.set(channel, fn),
		removeHandler: (channel: string) => handlers.delete(channel),
	},
}));

import type { AppLauncher } from "../apps/launcher";
import { registerChromeTabsHandlers } from "./chrome-tabs-handlers";

const STRIP_ID = 7;

function setup() {
	const container = { dragSplitTo: vi.fn(), stepSplit: vi.fn() };
	const launcher = {
		containerForChromeSender: (id: number) => (id === STRIP_ID ? { container } : null),
	} as unknown as AppLauncher;
	const dispose = registerChromeTabsHandlers({
		getLauncher: () => launcher,
		getOrchestrator: async () => null,
	});
	const invoke = (channel: string, senderId: number, ...args: unknown[]) =>
		handlers.get(channel)?.({ sender: { id: senderId } }, ...args);
	return { container, invoke, dispose };
}

describe("chrome split IPC (6.14)", () => {
	beforeEach(() => handlers.clear());

	it("forwards a divider drag from the window's own strip", () => {
		const t = setup();
		t.invoke(CHROME_SPLIT_DRAG, STRIP_ID, 420);
		expect(t.container.dragSplitTo).toHaveBeenCalledWith(420);
	});

	it("forwards a keyboard step", () => {
		const t = setup();
		t.invoke(CHROME_SPLIT_STEP, STRIP_ID, SplitStep.Left);
		expect(t.container.stepSplit).toHaveBeenCalledWith(SplitStep.Left);
	});

	it("drops malformed payloads", () => {
		const t = setup();
		t.invoke(CHROME_SPLIT_DRAG, STRIP_ID, "420");
		t.invoke(CHROME_SPLIT_DRAG, STRIP_ID, Number.NaN);
		t.invoke(CHROME_SPLIT_STEP, STRIP_ID, "up");
		expect(t.container.dragSplitTo).not.toHaveBeenCalled();
		expect(t.container.stepSplit).not.toHaveBeenCalled();
	});

	it("ignores any sender that isn't a known strip (an app renderer can't move a divider)", () => {
		const t = setup();
		t.invoke(CHROME_SPLIT_DRAG, 1234, 420);
		t.invoke(CHROME_SPLIT_STEP, 1234, SplitStep.Right);
		expect(t.container.dragSplitTo).not.toHaveBeenCalled();
		expect(t.container.stepSplit).not.toHaveBeenCalled();
	});

	it("removes the split handlers on dispose", () => {
		const t = setup();
		t.dispose();
		expect(handlers.has(CHROME_SPLIT_DRAG)).toBe(false);
		expect(handlers.has(CHROME_SPLIT_STEP)).toBe(false);
	});
});
