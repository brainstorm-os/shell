/**
 * PRES-2b — the per-session presence-router lifecycle. Proves install/get/dispose
 * and that the wired router fans peer pushes to the LIVE app windows (the getter
 * is read on every push). The router↔router relay convergence is covered by
 * `presence-router.test`; the engine awareness adapter (emit ↔ applyInbound) is
 * a thin null-safe indirection through `getLiveSyncEngine()` (null in this test).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppWindow } from "../apps/launcher";
import { APP_PRESENCE_PEERS_CHANNEL } from "./presence-router";
import { disposePresenceRouter, getPresenceRouter, installPresenceRouter } from "./presence-wiring";

function fakeAppWindow(appId: string): { win: AppWindow; send: ReturnType<typeof vi.fn> } {
	const send = vi.fn();
	const win = {
		appId,
		windowId: "main",
		webContentsId: 0,
		webContents: { send, isDestroyed: () => false },
	} as unknown as AppWindow;
	return { win, send };
}

describe("presence-wiring — per-session router lifecycle", () => {
	afterEach(() => disposePresenceRouter());

	it("install exposes the router; dispose clears it", () => {
		expect(getPresenceRouter()).toBeNull();
		const router = installPresenceRouter({ getAppWindows: () => [] });
		expect(getPresenceRouter()).toBe(router);
		disposePresenceRouter();
		expect(getPresenceRouter()).toBeNull();
	});

	it("re-install disposes the prior router and swaps in the new one", () => {
		const first = installPresenceRouter({ getAppWindows: () => [] });
		const second = installPresenceRouter({ getAppWindows: () => [] });
		expect(second).not.toBe(first);
		expect(getPresenceRouter()).toBe(second);
	});

	it("the wired router pushes peers to the live app windows", () => {
		const win = fakeAppWindow("io.brainstorm.whiteboard");
		installPresenceRouter({ getAppWindows: () => [win.win] });
		getPresenceRouter()?.publish("io.brainstorm.whiteboard", "ent_1", {
			presence: { id: "u", name: "U" },
		});
		// No remote peers yet (our own proxy is excluded), but the just-subscribed
		// window receives the (empty) peer snapshot — the fan-out is live.
		expect(win.send).toHaveBeenCalledWith(APP_PRESENCE_PEERS_CHANNEL, {
			entityId: "ent_1",
			peers: [],
		});
	});

	it("outbound emit is null-safe when no live-sync engine is installed", () => {
		installPresenceRouter({ getAppWindows: () => [] });
		// setLocal schedules the broadcaster emit → getLiveSyncEngine() is null →
		// no-op. Must not throw.
		expect(() =>
			getPresenceRouter()?.publish("io.brainstorm.whiteboard", "ent_1", { presence: { id: "u" } }),
		).not.toThrow();
	});
});
