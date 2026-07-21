import {
	type WindowBounds,
	type WindowEntry,
	WindowState,
} from "@brainstorm-os/protocol/window-types";
import { DragPayloadKind, DropEffect, type ObjectDragItem } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../ipc/envelope";
import type { CapabilityLedger } from "../capabilities/ledger";
import {
	APP_DRAG_LEAVE_CHANNEL,
	APP_DRAG_OVER_CHANNEL,
	APP_DROP_CHANNEL,
	DND_DRAG_CAPABILITY,
	DND_DROP_CAPABILITY,
	DndMethod,
	type DndServiceOptions,
	type GhostOverlay,
	makeDndServiceHandler,
} from "./dnd-service";
import { DragSessionStore } from "./drag-session";

function envelope(method: string, arg: unknown, app = "io.source.app"): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: "m1",
		app,
		service: "dnd",
		method,
		args: [arg],
		caps: [],
	};
}

function win(appId: string, bounds: WindowBounds): WindowEntry {
	return {
		id: `${appId}::w-${appId}`,
		appId,
		appName: appId,
		windowId: `w-${appId}`,
		title: appId,
		route: null,
		monitorId: "m1",
		bounds,
		state: WindowState.Normal,
		focused: false,
		lastFocusedAt: 0,
	};
}

function items(...ids: string[]): ObjectDragItem[] {
	return ids.map((id) => ({ entityId: id, entityType: "brainstorm/Note/v1", label: id }));
}

const grantAll: CapabilityLedger = { has: () => true } as unknown as CapabilityLedger;
const denyAll: CapabilityLedger = { has: () => false } as unknown as CapabilityLedger;

function fakeGhost(): GhostOverlay & {
	calls: { show: number; move: number; hide: number; effect: DropEffect[] };
} {
	const calls = { show: 0, move: 0, hide: 0, effect: [] as DropEffect[] };
	return {
		calls,
		show: () => {
			calls.show += 1;
		},
		move: () => {
			calls.move += 1;
		},
		setEffect: (e) => {
			calls.effect.push(e);
		},
		hide: () => {
			calls.hide += 1;
		},
	};
}

function setup(opts: { ledger?: CapabilityLedger | null; entries?: WindowEntry[] } = {}) {
	const store = new DragSessionStore();
	const ghost = fakeGhost();
	const notify = vi.fn();
	const entries = opts.entries ?? [win("io.target.app", { x: 0, y: 0, width: 500, height: 500 })];
	const options: DndServiceOptions = {
		store,
		ghost,
		notify,
		windowEntries: () => entries,
		...(opts.ledger !== undefined ? { getLedger: async () => opts.ledger ?? null } : {}),
	};
	return { store, ghost, notify, handler: makeDndServiceHandler(options) };
}

async function beginDrag(handler: (e: Envelope) => unknown, at = { x: 50, y: 50 }) {
	return (await handler(
		envelope(DndMethod.Begin, {
			payloadKind: DragPayloadKind.Object,
			items: items("e1", "e2"),
			ghost: { label: "2 notes", count: 2 },
			screenPoint: at,
		}),
	)) as { sessionId: string; payloadKind: string; itemCount: number };
}

describe("dnd-service handler", () => {
	it("begin opens a session, shows the ghost, and drag-overs the target with kinds-only", async () => {
		const { handler, ghost, notify } = setup();
		const info = await beginDrag(handler);
		expect(info).toMatchObject({ sessionId: "drag-1", itemCount: 2 });
		expect(ghost.calls.show).toBe(1);
		// over the target window → app:drag-over with NO items / NO sourceApp
		expect(notify).toHaveBeenCalledWith(
			{ appId: "io.target.app", windowId: "w-io.target.app" },
			APP_DRAG_OVER_CHANNEL,
			expect.objectContaining({
				sessionId: "drag-1",
				payloadKind: DragPayloadKind.Object,
				itemTypes: ["brainstorm/Note/v1"],
				pointInWindow: { x: 50, y: 50 },
			}),
		);
		const overArg = notify.mock.calls.find((c) => c[1] === APP_DRAG_OVER_CHANNEL)?.[2] as Record<
			string,
			unknown
		>;
		expect(overArg).not.toHaveProperty("items");
		expect(overArg).not.toHaveProperty("sourceApp");
		expect(overArg).not.toHaveProperty("payload");
	});

	it("move emits leave on the old target and over on the new one", async () => {
		const entries = [
			win("io.a.app", { x: 0, y: 0, width: 100, height: 100 }),
			win("io.b.app", { x: 200, y: 0, width: 100, height: 100 }),
		];
		const { handler, notify } = setup({ entries });
		const info = await beginDrag(handler, { x: 50, y: 50 }); // over a
		notify.mockClear();
		await handler(
			envelope(DndMethod.Move, { sessionId: info.sessionId, screenPoint: { x: 250, y: 50 } }),
		);
		expect(notify).toHaveBeenCalledWith(
			{ appId: "io.a.app", windowId: "w-io.a.app" },
			APP_DRAG_LEAVE_CHANNEL,
			{ sessionId: info.sessionId },
		);
		expect(notify).toHaveBeenCalledWith(
			{ appId: "io.b.app", windowId: "w-io.b.app" },
			APP_DRAG_OVER_CHANNEL,
			expect.objectContaining({ pointInWindow: { x: 50, y: 50 } }),
		);
	});

	it("move from a non-owner app is ignored", async () => {
		const { handler, ghost } = setup();
		const info = await beginDrag(handler);
		ghost.calls.move = 0;
		await handler(
			envelope(
				DndMethod.Move,
				{ sessionId: info.sessionId, screenPoint: { x: 1, y: 1 } },
				"io.evil.app",
			),
		);
		expect(ghost.calls.move).toBe(0); // not the source → no-op
	});

	it("setEffect from the current target updates the ghost", async () => {
		const { handler, ghost } = setup();
		const info = await beginDrag(handler);
		await handler(
			envelope(
				DndMethod.SetEffect,
				{ sessionId: info.sessionId, effect: DropEffect.Link },
				"io.target.app",
			),
		);
		expect(ghost.calls.effect).toContain(DropEffect.Link);
	});

	it("setEffect from a non-target app is ignored", async () => {
		const { handler, ghost } = setup();
		const info = await beginDrag(handler);
		await handler(
			envelope(
				DndMethod.SetEffect,
				{ sessionId: info.sessionId, effect: DropEffect.Move },
				"io.other.app",
			),
		);
		expect(ghost.calls.effect).not.toContain(DropEffect.Move);
	});

	it("drop delivers the FULL payload to the target and closes the session", async () => {
		const { handler, store, ghost, notify } = setup({ ledger: grantAll });
		const info = await beginDrag(handler);
		await handler(
			envelope(
				DndMethod.SetEffect,
				{ sessionId: info.sessionId, effect: DropEffect.Link },
				"io.target.app",
			),
		);
		notify.mockClear();
		const result = await handler(
			envelope(DndMethod.Drop, { sessionId: info.sessionId, screenPoint: { x: 60, y: 60 } }),
		);
		expect(result).toEqual({ delivered: true, effect: DropEffect.Link, targetApp: "io.target.app" });
		expect(notify).toHaveBeenCalledWith(
			{ appId: "io.target.app", windowId: "w-io.target.app" },
			APP_DROP_CHANNEL,
			expect.objectContaining({
				sessionId: info.sessionId,
				payload: { v: 1, sourceApp: "io.source.app", items: items("e1", "e2") },
				pointInWindow: { x: 60, y: 60 },
				effect: DropEffect.Link,
			}),
		);
		expect(ghost.calls.hide).toBe(1);
		expect(store.getActive()).toBeNull();
	});

	it("drop on empty space delivers nothing", async () => {
		const { handler, notify } = setup({ ledger: grantAll });
		const info = await beginDrag(handler, { x: 50, y: 50 });
		notify.mockClear();
		const result = await handler(
			envelope(DndMethod.Drop, { sessionId: info.sessionId, screenPoint: { x: 9999, y: 9999 } }),
		);
		expect(result).toEqual({ delivered: false, effect: DropEffect.None, targetApp: null });
		expect(notify).not.toHaveBeenCalledWith(expect.anything(), APP_DROP_CHANNEL, expect.anything());
	});

	it("drop is refused (no delivery) when the TARGET lacks dnd.drop", async () => {
		// source holds dnd.drag (grantAll would grant both); make a ledger that
		// grants drag to anyone but drop to no one.
		const dragOnly: CapabilityLedger = {
			has: (_app: string, cap: string) => cap === DND_DRAG_CAPABILITY,
		} as unknown as CapabilityLedger;
		const { handler, notify } = setup({ ledger: dragOnly });
		const info = await beginDrag(handler);
		notify.mockClear();
		const result = (await handler(
			envelope(DndMethod.Drop, { sessionId: info.sessionId, screenPoint: { x: 60, y: 60 } }),
		)) as { delivered: boolean };
		expect(result.delivered).toBe(false);
		expect(notify).not.toHaveBeenCalledWith(expect.anything(), APP_DROP_CHANNEL, expect.anything());
	});

	it("cancel hides the ghost, leaves the target, and closes the session", async () => {
		const { handler, store, ghost, notify } = setup();
		const info = await beginDrag(handler);
		notify.mockClear();
		await handler(envelope(DndMethod.Cancel, { sessionId: info.sessionId }));
		expect(notify).toHaveBeenCalledWith(
			{ appId: "io.target.app", windowId: "w-io.target.app" },
			APP_DRAG_LEAVE_CHANNEL,
			{ sessionId: info.sessionId },
		);
		expect(ghost.calls.hide).toBe(1);
		expect(store.getActive()).toBeNull();
	});

	it("denies begin without dnd.drag", async () => {
		const { handler } = setup({ ledger: denyAll });
		await expect(beginDrag(handler)).rejects.toMatchObject({ name: "Denied" });
	});

	it("Unavailable when the ledger resolves to null", async () => {
		const { handler } = setup({ ledger: null });
		await expect(beginDrag(handler)).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("rejects an unknown method", async () => {
		const { handler } = setup({ ledger: grantAll });
		await expect(handler(envelope("bogus", {}))).rejects.toMatchObject({ name: "Invalid" });
	});
});

describe("dnd-service exportFile (DND-5)", () => {
	function exporterSetup(ledger: CapabilityLedger | null = grantAll) {
		const exportFile = vi.fn(async () => true);
		const options: DndServiceOptions = {
			store: new DragSessionStore(),
			ghost: fakeGhost(),
			notify: vi.fn(),
			windowEntries: () => [],
			exportFile,
			...(ledger !== undefined ? { getLedger: async () => ledger } : {}),
		};
		return { exportFile, handler: makeDndServiceHandler(options) };
	}

	it("hands the bytes to the exporter and reports the OS-drag result", async () => {
		const { exportFile, handler } = exporterSetup();
		const bytes = new Uint8Array([1, 2, 3]);
		const result = await handler(envelope(DndMethod.ExportFile, { name: "a.pdf", bytes }));
		expect(result).toEqual({ started: true });
		expect(exportFile).toHaveBeenCalledWith("io.source.app", { name: "a.pdf", bytes });
	});

	it("refuses empty bytes and an oversized payload without calling the exporter", async () => {
		const { exportFile, handler } = exporterSetup();
		expect(
			await handler(envelope(DndMethod.ExportFile, { name: "a", bytes: new Uint8Array(0) })),
		).toEqual({
			started: false,
		});
		const huge = { length: 256 * 1024 * 1024 + 1 } as unknown as Uint8Array;
		Object.setPrototypeOf(huge, Uint8Array.prototype);
		expect(await handler(envelope(DndMethod.ExportFile, { name: "a", bytes: huge }))).toEqual({
			started: false,
		});
		expect(exportFile).not.toHaveBeenCalled();
	});

	it("is Denied fail-closed when the app lacks dnd.export-file", async () => {
		const { exportFile, handler } = exporterSetup(denyAll);
		await expect(
			handler(envelope(DndMethod.ExportFile, { name: "a", bytes: new Uint8Array([1]) })),
		).rejects.toMatchObject({ name: "Denied" });
		expect(exportFile).not.toHaveBeenCalled();
	});
});
