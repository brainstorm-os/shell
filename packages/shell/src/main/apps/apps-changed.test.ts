/**
 * `apps:changed` broadcast seam (F-380): the installer pushes this payload-free
 * signal to the dashboard so widget titles / iframe entries / the app-icon
 * cache refresh after an app (re)install instead of racing it once at mount.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	APPS_CHANGED_CHANNEL,
	broadcastAppsChanged,
	resetAppsChangedTarget,
	setAppsChangedTarget,
} from "./apps-changed";

type FakeWindow = {
	webContents: { send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean };
};

function fakeWindow(destroyed = false): FakeWindow {
	return { webContents: { send: vi.fn(), isDestroyed: () => destroyed } };
}

afterEach(() => {
	resetAppsChangedTarget();
});

describe("broadcastAppsChanged", () => {
	it("sends the channel to the registered target", () => {
		const win = fakeWindow();
		setAppsChangedTarget(() => win as never);
		broadcastAppsChanged();
		expect(win.webContents.send).toHaveBeenCalledWith(APPS_CHANGED_CHANNEL);
	});

	it("is a no-op without a target (unit-test / early-boot path)", () => {
		expect(() => broadcastAppsChanged()).not.toThrow();
	});

	it("skips a destroyed window", () => {
		const win = fakeWindow(true);
		setAppsChangedTarget(() => win as never);
		broadcastAppsChanged();
		expect(win.webContents.send).not.toHaveBeenCalled();
	});

	it("survives a throwing send (window torn down mid-call)", () => {
		const win = fakeWindow();
		win.webContents.send.mockImplementation(() => {
			throw new Error("gone");
		});
		setAppsChangedTarget(() => win as never);
		expect(() => broadcastAppsChanged()).not.toThrow();
	});
});
