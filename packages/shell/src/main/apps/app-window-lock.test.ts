import { describe, expect, it, vi } from "vitest";

// The helper pulls `APP_LOCK_CHANGED_CHANNEL` from vault-lock-handlers, which
// imports electron at module load — stub it (same pattern as that file's test).
vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
	BrowserWindow: { getAllWindows: () => [] },
}));

import { maskAppWindowsForLock } from "./app-window-lock";
import type { AppLauncher } from "./launcher";

const APP_LOCK_CHANGED_CHANNEL = "app:lock-changed";

function fakeContainer(opts: { destroyed?: boolean; tabCount?: number; split?: boolean } = {}) {
	const hide = vi.fn();
	const pane = () => ({ view: { webContents: { send: vi.fn() } } });
	const strip = Array.from({ length: opts.tabCount ?? 1 }, pane);
	const tabs = opts.split ? [...strip, pane()] : strip;
	return {
		container: {
			baseWindow: { isDestroyed: () => opts.destroyed ?? false, hide },
			tabs: () => strip,
			panes: () => tabs,
		},
		_hide: hide,
		_tabs: tabs,
	};
}

function launcherOf(...records: ReturnType<typeof fakeContainer>[]): AppLauncher {
	return {
		allContainers: () => records.map((r) => ({ container: r.container })),
	} as unknown as AppLauncher;
}

describe("maskAppWindowsForLock", () => {
	it("on lock: signals every tab and hides every window, never reveals", () => {
		const a = fakeContainer({ tabCount: 2 });
		const b = fakeContainer({ tabCount: 1 });
		const reveal = vi.fn();
		maskAppWindowsForLock(launcherOf(a, b), true, reveal);

		for (const r of [a, b]) {
			expect(r._hide).toHaveBeenCalledOnce();
			for (const tab of r._tabs) {
				expect(tab.view.webContents.send).toHaveBeenCalledWith(APP_LOCK_CHANGED_CHANNEL, {
					locked: true,
				});
			}
		}
		expect(reveal).not.toHaveBeenCalled();
	});

	it("on unlock: signals every tab and reveals every window, never hides", () => {
		const a = fakeContainer();
		const reveal = vi.fn();
		maskAppWindowsForLock(launcherOf(a), false, reveal);

		expect(a._tabs[0]?.view.webContents.send).toHaveBeenCalledWith(APP_LOCK_CHANGED_CHANNEL, {
			locked: false,
		});
		expect(reveal).toHaveBeenCalledOnce();
		expect(a._hide).not.toHaveBeenCalled();
	});

	it("signals a split window's side pane too — not just its strip tabs", () => {
		const split = fakeContainer({ split: true });
		maskAppWindowsForLock(launcherOf(split), true, vi.fn());
		expect(split._tabs).toHaveLength(2);
		for (const tab of split._tabs) {
			expect(tab.view.webContents.send).toHaveBeenCalledWith(APP_LOCK_CHANGED_CHANNEL, {
				locked: true,
			});
		}
	});

	it("skips a destroyed base window entirely (no signal, no hide)", () => {
		const dead = fakeContainer({ destroyed: true });
		const reveal = vi.fn();
		maskAppWindowsForLock(launcherOf(dead), true, reveal);

		expect(dead._hide).not.toHaveBeenCalled();
		expect(dead._tabs[0]?.view.webContents.send).not.toHaveBeenCalled();
	});

	it("no-ops on a null launcher", () => {
		expect(() => maskAppWindowsForLock(null, true, vi.fn())).not.toThrow();
	});
});
