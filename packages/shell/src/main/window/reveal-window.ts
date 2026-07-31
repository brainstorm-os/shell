/**
 * Window reveal that honors the two harness flags.
 *
 * **`BRAINSTORM_NO_FOCUS=1`** (also auto-set by `BRAINSTORM_SOAK_DEBUG=1`) —
 * reveal windows with `showInactive` so repeated Playwright launches don't rip
 * the developer's OS focus away every few seconds. Playwright drives the
 * renderer over CDP, which never needs OS-level activation. The two paths are
 * byte-identical at the rendered-frame level; only OS-level activation differs.
 *
 * **`BRAINSTORM_HIDDEN_WINDOWS=1`** — never map the window onto a display at
 * all. Every window is constructed `show: false` already, so suppressing the
 * reveal leaves it unmapped for its whole life: nothing appears over whatever
 * the developer is doing, and nothing can be raised into their screen share.
 * Chromium keeps the renderer in the *visible* state for a window that was
 * never shown (`BrowserWindowConstructorOptions.paintWhenInitiallyHidden`,
 * default true, pinned on the dashboard window; app renderers are
 * `WebContentsView`s whose painting follows their never-shown `BaseWindow` the
 * same way). The page therefore keeps painting and CDP
 * `Page.captureScreenshot` / `Page.startScreencast` keep returning real frames
 * — measured for both window shapes, sustained over a minute, and across a
 * `hide()` (the launcher's park path). This is the default for every
 * agent-driven harness run; see the harness repo's
 * `tests/dogfood/lib/shell-launch-env.ts`.
 *
 * Two alternatives were measured and rejected. Positioning windows off the
 * display (`setPosition(-10000, 0)`) does not survive macOS: AppKit constrains
 * the frame straight back onto the primary display (measured: the window came
 * back at `[55, 34]`). `app.dock.hide()` switches the activation policy to
 * Accessory, which breaks Playwright's WebContents handle mid-run — see the
 * standing comment on the dock-icon block in `main/index.ts`.
 */

/** The reveal-relevant slice of a window — satisfied by both Electron
 *  `BrowserWindow` and `BaseWindow`, and by the container's duck-typed handle.
 *  `showInactive` is optional so the window-index's `WindowController` (which
 *  only models `show`) satisfies it. */
export interface RevealableWindow {
	isDestroyed(): boolean;
	show(): void;
	showInactive?(): void;
}

/** Restoring + raising an existing window — the shape `surfaceWindow` drives. */
export interface SurfaceableWindow extends RevealableWindow {
	isMinimized(): boolean;
	restore(): void;
	focus(): void;
}

export function focusStealingDisabled(): boolean {
	return process.env.BRAINSTORM_NO_FOCUS === "1" || process.env.BRAINSTORM_SOAK_DEBUG === "1";
}

/** True when this process must never map a window onto a display. Test-only:
 *  production never sets the env var, so `revealWindow` / `surfaceWindow` keep
 *  their exact pre-existing behavior. */
export function hiddenWindowsRequested(): boolean {
	return process.env.BRAINSTORM_HIDDEN_WINDOWS === "1";
}

export function revealWindow(window: RevealableWindow): void {
	if (window.isDestroyed()) return;
	if (hiddenWindowsRequested()) return;
	if (focusStealingDisabled() && window.showInactive) window.showInactive();
	else window.show();
}

/**
 * Bring an already-created window to the user: restore it if minimized, reveal
 * it, then take OS focus. The one place that triad lives — the dashboard's
 * shortcut/search surfacing, dock activation, and the window index's `focus`
 * all route through here so a single flag check covers them.
 */
export function surfaceWindow(window: SurfaceableWindow): void {
	if (window.isDestroyed()) return;
	if (hiddenWindowsRequested()) return;
	if (window.isMinimized()) window.restore();
	revealWindow(window);
	if (!focusStealingDisabled()) window.focus();
}
