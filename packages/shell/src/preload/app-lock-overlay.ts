/**
 * App-window content concealment for a locked vault (Stage 13.8, defense-in-
 * depth).
 *
 * An app window is a separate sandboxed OS window with no lock screen of its
 * own — on lock the main process hides the whole window (`base.hide()`, the
 * primary mask). But that single main-process call is the *only* thing
 * obscuring the user's data, with no renderer-side backstop: if it ever races
 * or fails to obscure a window, the open app's content stays fully readable.
 *
 * So on `app:lock-changed{locked:true}` the app-preload paints this opaque,
 * interaction-blocking overlay over the whole viewport, removed on unlock. It is
 * anchored on `documentElement` (so an app re-rendering `<body>` can't drop it)
 * with inline styles (no app stylesheet required) and the maximum z-index, and
 * it carries no vault content itself — concealment, not chrome.
 */

/** Id of the singleton overlay element. */
export const APP_LOCK_OVERLAY_ID = "__bs-app-lock-overlay" as const;

/**
 * Show (locked) or remove (unlocked) the concealment overlay. Idempotent — a
 * repeated lock never stacks overlays; a repeated unlock is a no-op. Safe to
 * call before the document exists (no-op until it does).
 */
export function setAppLockOverlay(
	locked: boolean,
	doc: Document | undefined = globalThis.document,
): void {
	if (!doc) return;
	const root = doc.documentElement;
	if (!root) return;
	const existing = doc.getElementById(APP_LOCK_OVERLAY_ID);
	if (!locked) {
		existing?.remove();
		return;
	}
	if (existing) return;
	const overlay = doc.createElement("div");
	overlay.id = APP_LOCK_OVERLAY_ID;
	overlay.setAttribute("aria-hidden", "true");
	// Opaque near-black cover; fixed to the viewport; blocks pointer + selection;
	// max z-index so nothing the app renders sits on top.
	overlay.style.cssText =
		"position:fixed;inset:0;z-index:2147483647;background:#0b0d12;pointer-events:auto;user-select:none;";
	root.appendChild(overlay);
}
