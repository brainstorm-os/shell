import { DEFAULT_THEME, themes } from "@brainstorm-os/tokens";
import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { AppWindow } from "../apps/launcher";
import {
	APP_FORMAT_CHANGED_CHANNEL,
	APP_LOCALE_CHANGED_CHANNEL,
	APP_THEME_CHANGED_CHANNEL,
	broadcastFormatToWindows,
	broadcastLocaleToWindows,
	broadcastThemeToWindows,
	createSnapshotSequencer,
} from "./dashboard-handlers";

let fakeIdSeq = 0;

/** Mint a fake AppWindow whose tab-renderer + container methods we can spy on.
 *  The real one wraps `electron.BaseWindow` + `WebContentsView`, which don't
 *  run in Vitest. */
function makeFakeAppWindow(
	appId: string,
	destroyed = false,
): {
	appWindow: AppWindow;
	setBackgroundColor: ReturnType<typeof vi.fn>;
	send: ReturnType<typeof vi.fn>;
	pushChromeTheme: ReturnType<typeof vi.fn>;
} {
	const setBackgroundColor = vi.fn();
	const send = vi.fn();
	const pushChromeTheme = vi.fn();
	const webContentsId = ++fakeIdSeq;
	const baseWindowId = ++fakeIdSeq;
	const webContents = {
		id: webContentsId,
		send,
		isDestroyed: () => destroyed,
	} as unknown as AppWindow["webContents"];
	const container = {
		baseWindow: { id: baseWindowId, isDestroyed: () => destroyed, setBackgroundColor },
		pushChromeTheme,
	} as unknown as AppWindow["container"];
	return {
		appWindow: {
			appId,
			windowId: "main",
			tabId: "tab-1",
			webContentsId,
			webContents,
			container,
			parked: false,
		},
		setBackgroundColor,
		send,
		pushChromeTheme,
	};
}

function makeFakeDashboard(destroyed = false): {
	dashboard: BrowserWindow;
	setBackgroundColor: ReturnType<typeof vi.fn>;
	send: ReturnType<typeof vi.fn>;
} {
	const setBackgroundColor = vi.fn();
	const send = vi.fn();
	const dashboard = {
		isDestroyed: () => destroyed,
		setBackgroundColor,
		webContents: { send, isDestroyed: () => destroyed },
	} as unknown as BrowserWindow;
	return { dashboard, setBackgroundColor, send };
}

describe("broadcastThemeToWindows", () => {
	it("sends the theme name to every live app window on the theme-changed channel", () => {
		const notes = makeFakeAppWindow("io.brainstorm.notes");
		const graph = makeFakeAppWindow("io.brainstorm.graph");

		broadcastThemeToWindows(DEFAULT_THEME, null, [notes.appWindow, graph.appWindow]);

		expect(notes.send).toHaveBeenCalledWith(APP_THEME_CHANGED_CHANNEL, DEFAULT_THEME);
		expect(graph.send).toHaveBeenCalledWith(APP_THEME_CHANGED_CHANNEL, DEFAULT_THEME);
	});

	it("pushes the theme name to each container's tab strip (it misses the per-tab broadcast)", () => {
		const notes = makeFakeAppWindow("io.brainstorm.notes");
		broadcastThemeToWindows(DEFAULT_THEME, null, [notes.appWindow]);
		expect(notes.pushChromeTheme).toHaveBeenCalledWith(DEFAULT_THEME);
		expect(notes.pushChromeTheme).toHaveBeenCalledTimes(1);
	});

	it("updates the BrowserWindow's background color so resizes don't flash the previous theme", () => {
		const notes = makeFakeAppWindow("io.brainstorm.notes");
		broadcastThemeToWindows(DEFAULT_THEME, null, [notes.appWindow]);
		const expectedBg = themes[DEFAULT_THEME].color.background.primary;
		expect(notes.setBackgroundColor).toHaveBeenCalledWith(expectedBg);
	});

	it("skips destroyed app windows without throwing", () => {
		const live = makeFakeAppWindow("io.brainstorm.notes", false);
		const dead = makeFakeAppWindow("io.brainstorm.graph", true);
		broadcastThemeToWindows(DEFAULT_THEME, null, [live.appWindow, dead.appWindow]);
		expect(live.send).toHaveBeenCalledTimes(1);
		expect(dead.send).not.toHaveBeenCalled();
	});

	it("paints the dashboard window's background when present", () => {
		const notes = makeFakeAppWindow("io.brainstorm.notes");
		const { dashboard, setBackgroundColor } = makeFakeDashboard();
		broadcastThemeToWindows(DEFAULT_THEME, dashboard, [notes.appWindow]);
		expect(setBackgroundColor).toHaveBeenCalledWith(themes[DEFAULT_THEME].color.background.primary);
	});

	it("pushes the theme name to the dashboard renderer too, so the shell flips in lockstep with the apps", () => {
		// Regression: the shell resolved its theme only from the async, entity-pin-
		// enriched `dashboard:snapshot`, so a light/dark toggle flipped the apps
		// (synchronous `app:theme-changed`) while the dashboard lagged until the DB
		// read resolved. The dashboard must get the same synchronous signal.
		const { dashboard, send } = makeFakeDashboard();
		broadcastThemeToWindows(DEFAULT_THEME, dashboard, []);
		expect(send).toHaveBeenCalledWith(APP_THEME_CHANGED_CHANNEL, DEFAULT_THEME);
	});

	it("doesn't push to a destroyed dashboard", () => {
		const { dashboard, send } = makeFakeDashboard(true);
		broadcastThemeToWindows(DEFAULT_THEME, dashboard, []);
		expect(send).not.toHaveBeenCalled();
	});

	it("is a no-op for the dashboard when it's null", () => {
		const notes = makeFakeAppWindow("io.brainstorm.notes");
		// Just shouldn't throw — and apps should still receive the theme name.
		broadcastThemeToWindows(DEFAULT_THEME, null, [notes.appWindow]);
		expect(notes.send).toHaveBeenCalled();
	});

	it("survives a broken renderer (send throws) and keeps broadcasting to siblings", () => {
		const broken = makeFakeAppWindow("io.brainstorm.broken");
		const healthy = makeFakeAppWindow("io.brainstorm.healthy");
		broken.send.mockImplementation(() => {
			throw new Error("send blew up");
		});
		broadcastThemeToWindows(DEFAULT_THEME, null, [broken.appWindow, healthy.appWindow]);
		expect(healthy.send).toHaveBeenCalledTimes(1);
	});

	it("ships the theme name as a plain string — preload resolves it through @brainstorm-os/tokens", () => {
		const notes = makeFakeAppWindow("io.brainstorm.notes");
		broadcastThemeToWindows(DEFAULT_THEME, null, [notes.appWindow]);
		const [, payload] = notes.send.mock.calls[0] ?? [];
		expect(typeof payload).toBe("string");
		expect(payload).toBe(DEFAULT_THEME);
	});
});

describe("broadcastLocaleToWindows (12.15)", () => {
	it("sends the locale tag to every live app window on the locale-changed channel", () => {
		const notes = makeFakeAppWindow("io.brainstorm.notes");
		const graph = makeFakeAppWindow("io.brainstorm.graph");

		broadcastLocaleToWindows("es-ES", [notes.appWindow, graph.appWindow]);

		expect(notes.send).toHaveBeenCalledWith(APP_LOCALE_CHANGED_CHANNEL, "es-ES");
		expect(graph.send).toHaveBeenCalledWith(APP_LOCALE_CHANGED_CHANNEL, "es-ES");
	});

	it("skips destroyed app windows without throwing", () => {
		const live = makeFakeAppWindow("io.brainstorm.notes", false);
		const dead = makeFakeAppWindow("io.brainstorm.graph", true);
		broadcastLocaleToWindows("de", [live.appWindow, dead.appWindow]);
		expect(live.send).toHaveBeenCalledTimes(1);
		expect(dead.send).not.toHaveBeenCalled();
	});

	it("survives a broken renderer (send throws) and keeps broadcasting to siblings", () => {
		const broken = makeFakeAppWindow("io.brainstorm.broken");
		const healthy = makeFakeAppWindow("io.brainstorm.healthy");
		broken.send.mockImplementation(() => {
			throw new Error("send blew up");
		});
		broadcastLocaleToWindows("fr", [broken.appWindow, healthy.appWindow]);
		expect(healthy.send).toHaveBeenCalledTimes(1);
	});

	it("never paints a background color (locale carries no theme)", () => {
		const notes = makeFakeAppWindow("io.brainstorm.notes");
		broadcastLocaleToWindows("ja", [notes.appWindow]);
		expect(notes.setBackgroundColor).not.toHaveBeenCalled();
		expect(notes.pushChromeTheme).not.toHaveBeenCalled();
	});
});

describe("broadcastFormatToWindows (12.15 15f)", () => {
	it("sends the format context to every live app window on the format-changed channel", () => {
		const notes = makeFakeAppWindow("io.brainstorm.notes");
		const graph = makeFakeAppWindow("io.brainstorm.graph");
		const format = { locale: "de", hour12: false, timeZone: "Europe/Berlin" };

		broadcastFormatToWindows(format, [notes.appWindow, graph.appWindow]);

		expect(notes.send).toHaveBeenCalledWith(APP_FORMAT_CHANGED_CHANNEL, format);
		expect(graph.send).toHaveBeenCalledWith(APP_FORMAT_CHANGED_CHANNEL, format);
	});

	it("skips destroyed app windows without throwing", () => {
		const live = makeFakeAppWindow("io.brainstorm.notes", false);
		const dead = makeFakeAppWindow("io.brainstorm.graph", true);
		broadcastFormatToWindows({ locale: "es" }, [live.appWindow, dead.appWindow]);
		expect(live.send).toHaveBeenCalledTimes(1);
		expect(dead.send).not.toHaveBeenCalled();
	});

	it("survives a broken renderer (send throws) and keeps broadcasting to siblings", () => {
		const broken = makeFakeAppWindow("io.brainstorm.broken");
		const healthy = makeFakeAppWindow("io.brainstorm.healthy");
		broken.send.mockImplementation(() => {
			throw new Error("send blew up");
		});
		broadcastFormatToWindows({ locale: "fr" }, [broken.appWindow, healthy.appWindow]);
		expect(healthy.send).toHaveBeenCalledTimes(1);
	});
});

describe("createSnapshotSequencer", () => {
	it("delivers in order when enrichments resolve in order", () => {
		const seq = createSnapshotSequencer();
		const a = seq.claim();
		const b = seq.claim();
		expect(seq.shouldSend(a)).toBe(true);
		expect(seq.shouldSend(b)).toBe(true);
	});

	it("drops a stale snapshot that resolves AFTER a newer one (the toggle-revert bug)", () => {
		// Reproduces the Interface-settings symptom: two header-control toggles
		// each kick off an entity-pin enrichment. The first-claimed (now-stale)
		// one resolves LAST; without the guard it would repaint the old chrome and
		// snap the just-toggled control back. The guard must drop it.
		const seq = createSnapshotSequencer();
		const stale = seq.claim(); // toggle #1 (older chrome)
		const fresh = seq.claim(); // toggle #2 (newest chrome)

		// Fresh resolves first and is sent.
		expect(seq.shouldSend(fresh)).toBe(true);
		// Stale resolves second — must NOT overwrite the freshest painted state.
		expect(seq.shouldSend(stale)).toBe(false);
	});

	it("still sends the newest when several resolve out of order", () => {
		const seq = createSnapshotSequencer();
		const s0 = seq.claim();
		const s1 = seq.claim();
		const s2 = seq.claim();
		// Arrive 1, 2, 0.
		expect(seq.shouldSend(s1)).toBe(true);
		expect(seq.shouldSend(s2)).toBe(true);
		expect(seq.shouldSend(s0)).toBe(false);
	});
});
