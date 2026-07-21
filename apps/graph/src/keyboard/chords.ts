/**
 * Graph app keyboard chords. Declared as a typed enum + a single chord map
 * (the same chord syntax the shell shortcut registry uses) so every binding
 * routes through `@brainstorm-os/sdk/shortcut` `attachShortcut` instead of raw
 * `e.key` checks (shared-fundamentals contract §C + the
 * [[keyboard-and-i18n]] rule).
 *
 * One map, one place to grep: a new graph keyboard action adds a
 * `GraphAction` member + a `GRAPH_CHORDS` entry; `app.ts` binds it.
 */

export enum GraphAction {
	/** Enter local view rooted on the hovered node (or exit if already
	 *  local). The pointer-free twin of right-click-sets-local-root. */
	ToggleLocalView = "toggle-local-view",
	/** Exit local view from anywhere. */
	ExitLocalView = "exit-local-view",
	ZoomIn = "zoom-in",
	ZoomOut = "zoom-out",
	ZoomReset = "zoom-reset",
	/** Play / pause the history scrubber animation. */
	TogglePlayback = "toggle-playback",
	/** Canvas keyboard focus (KBN-A-graph). These fire only while the canvas
	 *  container holds focus (scoped to the element, not `window`). Tab cycles
	 *  the focus node sequentially; arrows move it to the nearest node in that
	 *  direction; Enter opens the focused entity; Ctrl/Cmd+arrows pan the
	 *  camera; Escape releases canvas focus. */
	FocusNext = "focus-next",
	FocusPrev = "focus-prev",
	FocusUp = "focus-up",
	FocusDown = "focus-down",
	FocusLeft = "focus-left",
	FocusRight = "focus-right",
	OpenFocused = "open-focused",
	ReleaseFocus = "release-focus",
	PanUp = "pan-up",
	PanDown = "pan-down",
	PanLeft = "pan-left",
	PanRight = "pan-right",
}

/** Action → chord. Chords use the shared `matchesChord` grammar:
 *  `CmdOrCtrl` is ⌘ on macOS / Ctrl elsewhere (resolved inside the
 *  shortcut layer); the final token is the canonical key. `matchesChord`
 *  compares against `event.key`, so the zoom keys use the *unshifted*
 *  characters the keyboard actually emits (`=` for the `+`-labelled key,
 *  `-`), which also means no Shift is required to zoom. Single-char keys
 *  are case-insensitive (`normalizeKey` upper-cases them). */
export const GRAPH_CHORDS: Record<GraphAction, string> = {
	[GraphAction.ToggleLocalView]: "L",
	[GraphAction.ExitLocalView]: "Escape",
	[GraphAction.ZoomIn]: "CmdOrCtrl+=",
	[GraphAction.ZoomOut]: "CmdOrCtrl+-",
	[GraphAction.ZoomReset]: "CmdOrCtrl+0",
	[GraphAction.TogglePlayback]: "Space",
	[GraphAction.FocusNext]: "Tab",
	[GraphAction.FocusPrev]: "Shift+Tab",
	[GraphAction.FocusUp]: "ArrowUp",
	[GraphAction.FocusDown]: "ArrowDown",
	[GraphAction.FocusLeft]: "ArrowLeft",
	[GraphAction.FocusRight]: "ArrowRight",
	[GraphAction.OpenFocused]: "Enter",
	[GraphAction.ReleaseFocus]: "Escape",
	[GraphAction.PanUp]: "CmdOrCtrl+ArrowUp",
	[GraphAction.PanDown]: "CmdOrCtrl+ArrowDown",
	[GraphAction.PanLeft]: "CmdOrCtrl+ArrowLeft",
	[GraphAction.PanRight]: "CmdOrCtrl+ArrowRight",
};

/** Zoom step factor a single keyboard zoom-in applies (zoom-out is the
 *  reciprocal). Mirrors the on-screen ± buttons' 1.4× so keyboard and
 *  pointer zoom feel identical. */
export const KEYBOARD_ZOOM_STEP = 1.4;
