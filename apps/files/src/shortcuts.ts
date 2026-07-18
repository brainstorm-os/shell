/**
 * App-side keyboard **chord registry** per
 * conventions.md §Keyboard handling and
 * §Keyboard map.
 *
 * The actual key matching + binding now lives in `@brainstorm/sdk/shortcut`
 * (the B-2 shared shortcut layer — `useShortcut` / `attachShortcut` /
 * `matchesChord`). This module is reduced to the canonical map of Files
 * action ids → default chords; the React renderer feeds each chord into
 * the SDK `useShortcut` hook. Keeping the registry app-local is the seam
 * for a future user-rebind layer (Settings cheatsheet) without scattering
 * chord strings through the renderer.
 *
 * This is the **only** place in the Files app that names a chord. Raw
 * `e.key === "..."` anywhere else is a PR-blocker.
 */

/**
 * Action ids the Files app declares. Per §Keyboard map plus a few
 * component-scoped ids used inside the app.
 */
export const ActionId = {
	NewFolder: "brainstorm.files/new-folder",
	NewMenu: "brainstorm.files/new-menu",
	Search: "brainstorm.files/search",
	ToggleSidebar: "brainstorm.files/toggle-sidebar",
	ToggleInspector: "brainstorm.files/toggle-inspector",
	Rename: "brainstorm.files/rename",
	RenameAlt: "brainstorm.files/rename.alt",
	Open: "brainstorm.files/open",
	QuickLook: "brainstorm.files/quick-look",
	Delete: "brainstorm.files/delete",
	DeleteAlt: "brainstorm.files/delete.alt",
	Copy: "brainstorm.files/copy",
	Cut: "brainstorm.files/cut",
	Paste: "brainstorm.files/paste",
	Duplicate: "brainstorm.files/duplicate",
	/** DND-6 — keyboard twin of the move drag: opens the destination picker
	 *  for the current selection (same commit path as a drop). */
	MoveTo: "brainstorm.files/move-to",
	Pin: "brainstorm.files/pin",
	SelectAll: "brainstorm.files/select-all",
	Back: "brainstorm.files/back",
	Forward: "brainstorm.files/forward",
	Up: "brainstorm.files/up",
	FocusSidebar: "brainstorm.files/focus-sidebar",
	FocusContent: "brainstorm.files/focus-content",
	FocusInspector: "brainstorm.files/focus-inspector",
	CycleViewList: "brainstorm.files/cycle-view.list",
	CycleViewGrid: "brainstorm.files/cycle-view.grid",
	SortMenu: "brainstorm.files/sort-menu",
	PopoverClose: "brainstorm.files/popover.close",
} as const;

export type ActionId = (typeof ActionId)[keyof typeof ActionId];

const DEFAULT_CHORDS: Record<ActionId, string | null> = {
	[ActionId.NewFolder]: "CmdOrCtrl+Shift+N",
	[ActionId.NewMenu]: "CmdOrCtrl+N",
	[ActionId.Search]: "CmdOrCtrl+F",
	[ActionId.ToggleSidebar]: "CmdOrCtrl+\\",
	[ActionId.ToggleInspector]: "CmdOrCtrl+I",
	[ActionId.Rename]: "Enter",
	[ActionId.RenameAlt]: "F2",
	[ActionId.Open]: "CmdOrCtrl+O",
	[ActionId.QuickLook]: "Space",
	[ActionId.Delete]: "Delete",
	[ActionId.DeleteAlt]: "Backspace",
	[ActionId.Copy]: "CmdOrCtrl+C",
	[ActionId.Cut]: "CmdOrCtrl+X",
	[ActionId.Paste]: "CmdOrCtrl+V",
	[ActionId.Duplicate]: "CmdOrCtrl+D",
	[ActionId.MoveTo]: "CmdOrCtrl+Shift+M",
	[ActionId.Pin]: "CmdOrCtrl+Shift+D",
	[ActionId.SelectAll]: "CmdOrCtrl+A",
	[ActionId.Back]: "CmdOrCtrl+[",
	[ActionId.Forward]: "CmdOrCtrl+]",
	[ActionId.Up]: "CmdOrCtrl+ArrowUp",
	[ActionId.FocusSidebar]: "CmdOrCtrl+1",
	[ActionId.FocusContent]: "CmdOrCtrl+2",
	[ActionId.FocusInspector]: "CmdOrCtrl+3",
	[ActionId.CycleViewList]: "CmdOrCtrl+Alt+1",
	[ActionId.CycleViewGrid]: "CmdOrCtrl+Alt+2",
	[ActionId.SortMenu]: "CmdOrCtrl+Shift+S",
	[ActionId.PopoverClose]: "Escape",
};

/** The default chord for an action id, or `null` when intentionally
 *  unbound. The SDK `useShortcut` hook is the consumer. */
export function chordFor(id: ActionId): string | null {
	return DEFAULT_CHORDS[id];
}

/** Every declared action id (for the registry-completeness test + a
 *  future Settings cheatsheet). */
export function allActionIds(): readonly ActionId[] {
	return Object.values(ActionId);
}
