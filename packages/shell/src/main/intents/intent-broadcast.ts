/**
 * Push channel that delivers a curated-verb intent to a single
 * already-running app window. Used by the `IntentsBus` when the
 * destination app is open — the AppLauncher's per-(app, windowId)
 * cache just focuses the existing window, so a new launch context
 * would otherwise never reach the renderer.
 *
 * Wire format mirrors the SDK lifecycle `{ type: "intent"; intent }`
 * event so the preload can re-emit through the runtime's
 * `LifecycleEmitter` without re-shaping the payload.
 *
 * Payload includes `source` (the dispatching app id) for parity with
 * the SDK type and so receivers can render attribution like
 * "Opened from Notes".
 */

import type { Intent } from "@brainstorm-os/sdk-types";
import { type AppWindow, isAppWindowLive } from "../apps/launcher";

export const APP_INTENT_CHANNEL = "app:intent";

/** Push the intent envelope to a specific live app window. No-op when
 *  the window was destroyed between the bus's lookup and the send —
 *  the bus already returned `handled: true` to the caller; a dead
 *  window after dispatch is not the dispatcher's problem. */
export function deliverIntentToAppWindow(window: AppWindow, intent: Intent): void {
	if (!isAppWindowLive(window)) return;
	try {
		window.webContents.send(APP_INTENT_CHANNEL, intent);
	} catch (error) {
		console.warn(`[brainstorm] intent delivery to ${window.appId}/${window.windowId} failed:`, error);
	}
}
