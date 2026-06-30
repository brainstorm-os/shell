/**
 * App-window concealment on vault lock/unlock (Stage 13.8).
 *
 * App windows are separate sandboxed OS windows (`BaseWindow` hosting
 * `WebContentsView` tabs) with no lock screen of their own — the dashboard's
 * lock route only covers the dashboard `BrowserWindow`, and the
 * `app:lock-changed` broadcast (over `BrowserWindow.getAllWindows()`) can't even
 * reach a `BaseWindow`. So on lock the main process masks each app window here.
 *
 * Two layers, so concealment never rests on a single call:
 *  1. **primary** — `baseWindow.hide()` removes the whole OS window.
 *  2. **defense-in-depth** — push `app:lock-changed` to each tab's sandboxed
 *     renderer so the app-preload paints an opaque overlay; if `hide()` ever
 *     races or fails to obscure a window, the user's data is still covered.
 *
 * Pure of `electron` (works against the launcher's handle interfaces) so it's
 * unit-testable with fakes.
 */

import { APP_LOCK_CHANGED_CHANNEL } from "../ipc/vault-lock-handlers";
import type { AppLauncher } from "./launcher";
import type { BaseWindowHandle } from "./window-container";

/**
 * Conceal (lock) / reveal (unlock) every open app window. Sends the lock signal
 * to every tab renderer in every live container, then hides (lock) or reveals
 * (unlock) the container's OS window. A destroyed base window is skipped.
 */
export function maskAppWindowsForLock(
	launcher: AppLauncher | null,
	locked: boolean,
	reveal: (base: BaseWindowHandle) => void,
): void {
	for (const { container } of launcher?.allContainers() ?? []) {
		const base = container.baseWindow;
		if (base.isDestroyed()) continue;
		for (const tab of container.tabs()) {
			tab.view.webContents.send(APP_LOCK_CHANGED_CHANNEL, { locked });
		}
		if (locked) base.hide();
		else reveal(base);
	}
}
