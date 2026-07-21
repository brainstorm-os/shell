/**
 * `activity:*` IPC handlers — channel id, snapshot accessor, and the
 * push-on-change lifecycle (broadcast to the dashboard, skip when the window
 * is gone). Store behaviour is covered in `background-activity-store.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, IpcHandler>();
vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: IpcHandler) => {
			handlers.set(channel, fn);
		},
	},
}));

import { ActivityKind, ActivityPhase } from "@brainstorm-os/protocol/activity-types";
import { BackgroundActivityStore } from "../activity/background-activity-store";
import {
	ACTIVITY_SNAPSHOT_CHANNEL,
	disposeActivityHandlers,
	registerActivityHandlers,
} from "./activity-handlers";

function fakeWindow() {
	const sent: Array<{ channel: string; payload: unknown }> = [];
	return {
		sent,
		destroyed: false,
		isDestroyed() {
			return this.destroyed;
		},
		webContents: {
			send: (channel: string, payload: unknown) => {
				sent.push({ channel, payload });
			},
		},
	};
}

const runningOp = {
	id: "x",
	kind: ActivityKind.Indexing,
	phase: ActivityPhase.Running,
	percent: null,
	detail: null,
};

describe("activity-handlers", () => {
	it("the snapshot channel returns the store's current snapshot", async () => {
		const store = new BackgroundActivityStore();
		store.set(runningOp);
		const win = fakeWindow();
		registerActivityHandlers({ getDashboard: () => win as never, store });
		const handler = handlers.get(ACTIVITY_SNAPSHOT_CHANNEL);
		const snap = (await handler?.(null)) as { operations: unknown[] };
		expect(snap.operations).toHaveLength(1);
		disposeActivityHandlers();
	});

	it("pushes a snapshot to the dashboard on every store change", () => {
		const store = new BackgroundActivityStore();
		const win = fakeWindow();
		registerActivityHandlers({ getDashboard: () => win as never, store });
		store.set(runningOp);
		expect(win.sent).toHaveLength(1);
		expect(win.sent[0]?.channel).toBe(ACTIVITY_SNAPSHOT_CHANNEL);
		store.clear("x");
		expect(win.sent).toHaveLength(2);
		disposeActivityHandlers();
	});

	it("skips the push when the dashboard is destroyed", () => {
		const store = new BackgroundActivityStore();
		const win = fakeWindow();
		win.destroyed = true;
		registerActivityHandlers({ getDashboard: () => win as never, store });
		store.set(runningOp);
		expect(win.sent).toHaveLength(0);
		disposeActivityHandlers();
	});

	it("stops pushing after dispose", () => {
		const store = new BackgroundActivityStore();
		const win = fakeWindow();
		registerActivityHandlers({ getDashboard: () => win as never, store });
		disposeActivityHandlers();
		store.set(runningOp);
		expect(win.sent).toHaveLength(0);
	});
});
