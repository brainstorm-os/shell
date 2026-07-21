/**
 * `IconName` enum + Phosphor registry — MIRRORS
 * `packages/shell/src/renderer/ui/icon.tsx` exactly (same enum values, same
 * glyph mapping). The SDK can't import the shell, so the contract is
 * duplicated here and kept sync-able: the asset name each entry maps to is
 * the Phosphor kebab-case file name, which is also what the shell's
 * Phosphor-React component resolves to.
 *
 * Two consumers sit on top of this:
 *   - `<Icon>` (icon.tsx)        — React, via `@phosphor-icons/react`.
 *   - `createIconElement`        — pure DOM, via the inlined glyph markup in
 *                                  `./icon-glyphs.ts` (no React, no SVG
 *                                  loader) so plain-DOM apps paint the SAME
 *                                  glyph (mirrors `entity-icon.ts`).
 *
 * Adding a glyph: add the enum entry + the asset name here, regenerate
 * `icon-glyphs.ts`, and (if it's also new shell-side) mirror it in the
 * shell registry.
 */

/** Stable interface-glyph names. Values are the wire-stable kebab strings
 *  the shell uses; keep this 1:1 with the shell `IconName`. */
export enum IconName {
	Settings = "settings",
	Plus = "plus",
	Close = "close",
	CaretLeft = "caret-left",
	CaretRight = "caret-right",
	// Select-menu glyphs — trigger caret + selected-option check (the shared
	// `@brainstorm-os/sdk/select-menu` control).
	CaretDown = "caret-down",
	// Stepper / sort-direction / reorder glyphs — minus (zoom-out, numeric
	// steppers), the up caret (sort-ascending, move-up), and the six-dot drag
	// handle (reorderable list rows). Counterparts to Plus / CaretDown.
	CaretUp = "caret-up",
	Minus = "minus",
	DragHandle = "drag-handle",
	More = "more",
	ArrowRight = "arrow-right",
	Check = "check",
	OpenExternal = "open-external",
	Info = "info",
	Search = "search",
	Folder = "folder",
	Lock = "lock",
	Sun = "sun",
	Moon = "moon",
	Palette = "palette",
	CheckCircle = "check-circle",
	Warning = "warning",
	App = "app",
	Entity = "entity",
	View = "view",
	// People/contacts surfaces — the address-book glyph (Contacts empty state).
	AddressBook = "address-book",
	SignOut = "sign-out",
	Sparkle = "sparkle",
	Chat = "chat",
	Storefront = "storefront",
	Trash = "trash",
	Update = "update",
	FolderPlus = "folder-plus",
	// Browser chrome glyphs — page reload + bookmark star (Fill when saved) +
	// browsing-history dropdown (clock-with-arrow, distinct from the reload arc).
	Reload = "reload",
	History = "history",
	Star = "star",
	// Object-menu action glyphs — Pin to / remove from dashboard (8.8 menus).
	Pin = "pin",
	PinSlash = "pin-slash",
	// Action-menu glyphs — copy-to-clipboard / save-to-file / rename rows
	// (Graph export menu, Database list/view/filter menus, any action list).
	Copy = "copy",
	Download = "download",
	Pencil = "pencil",
	// Saved-link surface glyphs — Bookmarks' Inbox / Read / Archive / Tag
	// nav rail (was app-local hand-rolled SVG before B-2 adoption).
	Inbox = "inbox",
	Read = "read",
	Archive = "archive",
	Tag = "tag",
	// Property-kind glyphs — one per `PropertyKind` value plus the
	// dictionary glyph. Keep alphabetical by kind for predictability.
	KindBoolean = "kind-boolean",
	KindDate = "kind-date",
	KindDictionary = "kind-dictionary",
	KindEmail = "kind-email",
	KindFile = "kind-file",
	KindLink = "kind-link",
	KindMultiSelect = "kind-multi-select",
	KindNumber = "kind-number",
	KindPhone = "kind-phone",
	KindSelect = "kind-select",
	KindText = "kind-text",
	KindUrl = "kind-url",
}

/** Phosphor weight — same set the shell exposes. Defaults to `regular`. */
export enum IconWeight {
	Thin = "thin",
	Light = "light",
	Regular = "regular",
	Bold = "bold",
	Fill = "fill",
	Duotone = "duotone",
}

/**
 * Whether a glyph carries inline-axis meaning (a "back" caret, a "next" arrow)
 * and should therefore mirror under `dir="rtl"`. Default `Auto` (no mirroring
 * — most glyphs are bidirectional and look wrong if you flip them, e.g.
 * Settings / Trash / Sun). Pass `Inline` at the call site when the glyph
 * encodes the inline-start ↔ inline-end direction. Stage 12.5.
 */
export enum IconDirection {
	/** Bidirectional glyph — same in LTR and RTL. */
	Auto = "auto",
	/** Inline-axis glyph (Caret / Arrow / Chevron Left/Right) — mirrors in RTL
	 *  via the global `[dir="rtl"] [data-icon-direction="inline"]` rule
	 *  installed by `styles.css` (shell) and `app-theme.css` (apps). */
	Inline = "inline",
}

/**
 * `IconName` → Phosphor asset (kebab) name. The React `<Icon>` uses this to
 * look up the matching `@phosphor-icons/react` component; the DOM twin uses
 * it to index `ICON_GLYPHS`. One table, both renderers stay in lock-step.
 */
export const ICON_ASSET: Record<IconName, string> = {
	[IconName.Settings]: "gear",
	[IconName.Plus]: "plus",
	[IconName.Close]: "x",
	[IconName.CaretLeft]: "caret-left",
	[IconName.CaretRight]: "caret-right",
	[IconName.CaretDown]: "caret-down",
	[IconName.CaretUp]: "caret-up",
	[IconName.Minus]: "minus",
	[IconName.DragHandle]: "dots-six-vertical",
	[IconName.More]: "dots-three",
	[IconName.ArrowRight]: "arrow-right",
	[IconName.Check]: "check",
	[IconName.OpenExternal]: "arrow-square-out",
	[IconName.Info]: "info",
	[IconName.Search]: "magnifying-glass",
	[IconName.Folder]: "folder-simple",
	[IconName.Lock]: "lock",
	[IconName.Sun]: "sun",
	[IconName.Moon]: "moon",
	[IconName.Palette]: "palette",
	[IconName.CheckCircle]: "check-circle",
	[IconName.Warning]: "warning-circle",
	[IconName.App]: "squares-four",
	[IconName.Entity]: "cube",
	[IconName.View]: "file-text",
	[IconName.AddressBook]: "address-book",
	[IconName.SignOut]: "sign-out",
	[IconName.Sparkle]: "sparkle",
	[IconName.Chat]: "chat-circle",
	[IconName.Storefront]: "storefront",
	[IconName.Trash]: "trash",
	[IconName.Update]: "arrow-counter-clockwise",
	[IconName.FolderPlus]: "folder-plus",
	[IconName.Reload]: "arrow-clockwise",
	[IconName.History]: "clock-counter-clockwise",
	[IconName.Star]: "star",
	[IconName.Pin]: "push-pin",
	[IconName.PinSlash]: "push-pin-slash",
	[IconName.Copy]: "copy",
	[IconName.Download]: "download-simple",
	[IconName.Pencil]: "pencil-simple",
	[IconName.Inbox]: "tray",
	[IconName.Read]: "check-circle",
	[IconName.Archive]: "archive",
	[IconName.Tag]: "tag",
	[IconName.KindBoolean]: "check-square",
	[IconName.KindDate]: "calendar",
	[IconName.KindDictionary]: "book-open",
	[IconName.KindEmail]: "envelope",
	[IconName.KindFile]: "paperclip",
	[IconName.KindLink]: "link",
	[IconName.KindMultiSelect]: "list-checks",
	[IconName.KindNumber]: "hash",
	[IconName.KindPhone]: "phone",
	[IconName.KindSelect]: "tag",
	[IconName.KindText]: "text-t",
	[IconName.KindUrl]: "globe",
};

/** Every enum value, for completeness assertions / iteration. */
export const ALL_ICON_NAMES: readonly IconName[] = Object.values(IconName);
