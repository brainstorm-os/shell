/**
 * Universal icon model — every entity / property / dictionary item / app
 * / vault can carry an icon, drawn from one of three sources. See
 * .
 *
 * Pack glyphs are addressed as `"<packId>/<glyphName>"` — today the only
 * registered pack is `"phosphor"`. Emoji is the raw codepoint(s). Image
 * is a `brainstorm://icon/<sha256>.<ext>` URL serving the bytes from
 * `<vault>/icons/<sha256>.<ext>`.
 *
 * Leaf module (no imports) so `type-icon.ts` and other helpers can
 * depend on the icon model without a cycle through the `index` barrel.
 * `index.ts` re-exports everything here, so the public
 * `@brainstorm-os/sdk-types` surface is unchanged.
 */

export enum IconKind {
	Pack = "pack",
	Emoji = "emoji",
	Image = "image",
}

export type Icon =
	/** Pack glyph addressed as `"<packId>/<glyphName>"`; an optional `color`
	 *  (CSS colour string or theme accent token like `"accent"`) tints the
	 *  glyph. Emoji and Image don't support tint. */
	| { kind: IconKind.Pack; value: string; color?: string }
	/** Raw emoji codepoint(s). Skin-tone modifiers (U+1F3FB..U+1F3FF) are
	 *  encoded into `value` directly so the same shape carries any variant. */
	| { kind: IconKind.Emoji; value: string }
	/** `brainstorm://icon/<sha256>.<ext>` URL — bytes live in
	 *  `<vault>/icons/`. Uploaded via `icons:upload` IPC. */
	| { kind: IconKind.Image; value: string };

/** Fitzpatrick skin-tone modifier — appended to person/hand emoji. */
export enum SkinTone {
	None = "none",
	Light = "1f3fb", // 🏻
	MediumLight = "1f3fc", // 🏼
	Medium = "1f3fd", // 🏽
	MediumDark = "1f3fe", // 🏾
	Dark = "1f3ff", // 🏿
}
