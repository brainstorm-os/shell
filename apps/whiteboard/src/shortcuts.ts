/**
 * App-side keyboard delivery per
 * §Keyboard handling. Every keyboard interaction routes through an action
 * id; no raw `e.key` outside this module.
 *
 * The chord syntax + semantics are deliberately identical to
 * `@brainstorm-os/sdk/shortcut`'s `matchesChord` (same `CmdOrCtrl` / `isMac`
 * resolution) so the contract's shared-parser intent holds. A full
 * migration to the SDK helper is *blocked*, not skipped: the root
 * `vitest.config.ts` has no `@brainstorm-os/sdk/shortcut` alias (it covers
 * `object-menu` / `i18n` / `entity-icon` but not `shortcut` / `popover` /
 * `icon`), and that file is outside this builder's edit scope — see the
 * handoff STOP-needs. This module also keeps the richer `bindShortcut`
 * surface the SDK's `attachShortcut` lacks: an action-id → default-chord
 * registry, multi-chord-per-action (Delete + Backspace, Enter + F2), and
 * the `allowInTyping` escape hatch the inline-text editors need.
 */

export const ActionId = {
	CreateSticky: "io.brainstorm.whiteboard/create-sticky",
	CreateText: "io.brainstorm.whiteboard/create-text",
	CreateFrame: "io.brainstorm.whiteboard/create-frame",
	CreateGroup: "io.brainstorm.whiteboard/create-group",
	Ungroup: "io.brainstorm.whiteboard/ungroup",
	DeleteNode: "io.brainstorm.whiteboard/delete-node",
	DuplicateNode: "io.brainstorm.whiteboard/duplicate-node",
	EditNode: "io.brainstorm.whiteboard/edit-node",
	CommitEdit: "io.brainstorm.whiteboard/commit-edit",
	CancelEdit: "io.brainstorm.whiteboard/cancel-edit",
	CommitRename: "io.brainstorm.whiteboard/commit-rename",
	NudgeUp: "io.brainstorm.whiteboard/nudge-up",
	NudgeDown: "io.brainstorm.whiteboard/nudge-down",
	NudgeLeft: "io.brainstorm.whiteboard/nudge-left",
	NudgeRight: "io.brainstorm.whiteboard/nudge-right",
	SelectAll: "io.brainstorm.whiteboard/select-all",
	ClearSelection: "io.brainstorm.whiteboard/clear-selection",
	Undo: "io.brainstorm.whiteboard/undo",
	Redo: "io.brainstorm.whiteboard/redo",
	ToggleBold: "io.brainstorm.whiteboard/toggle-bold",
	ToggleItalic: "io.brainstorm.whiteboard/toggle-italic",
	ToggleUnderline: "io.brainstorm.whiteboard/toggle-underline",
	ToggleStrike: "io.brainstorm.whiteboard/toggle-strike",
} as const;

export type ActionId = (typeof ActionId)[keyof typeof ActionId];

const DEFAULT_CHORDS: Record<ActionId, readonly string[]> = {
	[ActionId.CreateSticky]: ["S"],
	[ActionId.CreateText]: ["T"],
	[ActionId.CreateFrame]: ["F"],
	[ActionId.CreateGroup]: ["CmdOrCtrl+G"],
	[ActionId.Ungroup]: ["CmdOrCtrl+Shift+G"],
	[ActionId.DeleteNode]: ["Delete", "Backspace"],
	[ActionId.DuplicateNode]: ["CmdOrCtrl+D"],
	[ActionId.EditNode]: ["Enter", "F2"],
	[ActionId.CommitEdit]: ["CmdOrCtrl+Enter"],
	[ActionId.CancelEdit]: ["Escape"],
	// Single-line rename input only (input-scoped binding): plain Enter
	// commits — unlike the multi-line node editor where Enter is a newline.
	[ActionId.CommitRename]: ["Enter"],
	[ActionId.NudgeUp]: ["ArrowUp"],
	[ActionId.NudgeDown]: ["ArrowDown"],
	[ActionId.NudgeLeft]: ["ArrowLeft"],
	[ActionId.NudgeRight]: ["ArrowRight"],
	[ActionId.SelectAll]: ["CmdOrCtrl+A"],
	// Shares Escape with CancelEdit: while editing, the body-scoped
	// CancelEdit handler fires + preventDefault()s, so `bindShortcut`'s
	// defaultPrevented guard makes this window-level binding a no-op;
	// with no edit open it clears the current selection.
	[ActionId.ClearSelection]: ["Escape"],
	[ActionId.Undo]: ["CmdOrCtrl+Z"],
	[ActionId.Redo]: ["CmdOrCtrl+Shift+Z"],
	[ActionId.ToggleBold]: ["CmdOrCtrl+B"],
	[ActionId.ToggleItalic]: ["CmdOrCtrl+I"],
	// Editing-scoped only (bound on the contentEditable body by the inline
	// editor); there is no node-level underline/strike to bind at window scope.
	[ActionId.ToggleUnderline]: ["CmdOrCtrl+U"],
	[ActionId.ToggleStrike]: ["CmdOrCtrl+Shift+X"],
};

export type BindShortcutOptions = {
	/** Override the default chord(s) for tests. Omit to use the registry's;
	 *  `null` disables the binding (returns a no-op unbinder). */
	chord?: string | readonly string[] | null;
	/** Scope listener to a specific element. Default: window. */
	target?: HTMLElement | Window;
	/** Allow the shortcut to fire even when focus is in an editable text
	 * target. Use sparingly — only for chords that semantically apply to the
	 * whole window regardless of typing context (e.g. Escape to cancel an
	 * inline edit, CmdOrCtrl+Enter to commit it). Default: false. */
	allowInTyping?: boolean;
};

/**
 * Bind a handler to an action id. Returns an unbind function.
 *
 * Usage:
 *   const off = bindShortcut(ActionId.CreateSticky, addSticky);
 *   // …
 *   off();
 */
export function bindShortcut(
	id: ActionId,
	handler: (event: KeyboardEvent) => void,
	options: BindShortcutOptions = {},
): () => void {
	const raw = options.chord !== undefined ? options.chord : DEFAULT_CHORDS[id];
	if (raw === null) return () => {};
	const chords = typeof raw === "string" ? [raw] : raw;
	if (chords.length === 0) return () => {};
	const target = options.target ?? window;
	const allowInTyping = options.allowInTyping ?? false;
	const listener = (event: Event) => {
		const keyEvent = event as KeyboardEvent;
		if (keyEvent.defaultPrevented) return;
		if (!chords.some((chord) => matchesChord(keyEvent, chord))) return;
		const typing = isTypingTarget(keyEvent.target);
		if (typing && !allowInTyping) return;
		// In typing targets the handler decides whether to consume the event
		// (via `event.preventDefault()`) — that way Escape with no edit open
		// still blurs the input natively. Outside typing targets we eat the
		// event up front so apps don't trigger e.g. browser search shortcuts.
		if (!typing) {
			keyEvent.preventDefault();
			keyEvent.stopPropagation();
		}
		handler(keyEvent);
	};
	target.addEventListener("keydown", listener);
	return () => target.removeEventListener("keydown", listener);
}

/**
 * True when the event target is text-input-ish
 * (input/textarea/contenteditable). Lets typed characters and native
 * edit chords reach the field instead of being intercepted by app-wide
 * shortcuts.
 *
 * Duck-typed (no `instanceof HTMLElement`) so the test suite can run
 * under the `node` vitest environment without jsdom.
 */
export function isTypingTarget(target: EventTarget | null | undefined): boolean {
	if (!target) return false;
	const candidate = target as Partial<HTMLElement> & { tagName?: string; type?: string };
	if (typeof candidate.tagName !== "string") return false;
	if (candidate.isContentEditable === true) return true;
	// jsdom never implements `isContentEditable`, so the inline editors'
	// chord protection would silently vanish under test (F-213's stray-node
	// half is exactly a printable key treated as a chord mid-edit). The
	// attribute is the same contract, host-independent.
	if (typeof candidate.getAttribute === "function") {
		const attr = candidate.getAttribute("contenteditable");
		if (attr === "" || attr === "true" || attr === "plaintext-only") return true;
	}
	const tag = candidate.tagName;
	if (tag === "TEXTAREA") return true;
	if (tag !== "INPUT") return false;
	const type = typeof candidate.type === "string" ? candidate.type.toLowerCase() : "";
	return (
		type === "" ||
		type === "text" ||
		type === "search" ||
		type === "url" ||
		type === "email" ||
		type === "tel" ||
		type === "password" ||
		type === "number"
	);
}

/**
 * Test the chord syntax `[<Mod>+]<Key>` against a KeyboardEvent. Public
 * for unit tests; production code goes through `bindShortcut`. Kept byte-
 * identical in semantics to `@brainstorm-os/sdk/shortcut`'s `matchesChord`
 * (the parser this delegates to once the root vitest alias lands).
 */
export function matchesChord(event: KeyboardEvent, chord: string): boolean {
	const parts = chord.split("+").map((p) => p.trim());
	const key = parts[parts.length - 1];
	if (!key) return false;
	const mods = parts.slice(0, -1);

	const isMac =
		typeof navigator !== "undefined" &&
		/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || "");

	const wantCmd = mods.includes("Cmd") || (mods.includes("CmdOrCtrl") && isMac);
	const wantCtrl = mods.includes("Ctrl") || (mods.includes("CmdOrCtrl") && !isMac);
	const wantAlt = mods.includes("Alt");
	const wantShift = mods.includes("Shift");

	if (!!event.metaKey !== wantCmd) return false;
	if (!!event.ctrlKey !== wantCtrl) return false;
	if (!!event.altKey !== wantAlt) return false;
	if (!!event.shiftKey !== wantShift) return false;

	return normalizeKey(event.key) === normalizeKey(key);
}

function normalizeKey(key: string): string {
	if (key === " ") return "Space";
	if (key.length === 1) return key.toUpperCase();
	return key;
}

/** Test helper — exposes the chord map for assertion over default bindings. */
export function _defaultChordsForTesting(): Readonly<Record<ActionId, readonly string[]>> {
	return DEFAULT_CHORDS;
}
