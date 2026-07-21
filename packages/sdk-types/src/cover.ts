/**
 * Universal cover model — every object (note, bookmark, book, person,
 * task, List) can carry a wide banner backdrop, the visual companion to
 * the universal icon. See.
 *
 * Exactly one shape, drawn from one of three sources:
 *
 *   - Image    — an uploaded asset at `<vault>/covers/<sha256>.<ext>`,
 *                addressed via the privileged `brainstorm://cover/...`
 *                scheme (parallel to `brainstorm://icon/...`). `focal`
 *                is a normalised `0..1` point the renderer keeps visible
 *                when the display aspect is narrower than the source —
 *                drag-to-reposition, never a destructive crop.
 *   - Gradient — a key into the curated gradient set (the same pastel
 *                family the app-icon palette / the seeded fallback use).
 *                Deterministic, theme-neutral.
 *   - Color    — a single colour. Stored as a token reference where
 *                possible so a cover follows the active theme (OQ-COV-1).
 *
 * A `null` cover means "no explicit cover": the renderer falls back to a
 * deterministic gradient seeded by the object's id (never a broken-image
 * square) — see `@brainstorm-os/sdk/entity-cover`.
 *
 * Leaf module (no imports) so helpers can depend on the cover model
 * without a cycle through the `index` barrel — exactly like `icon.ts`.
 */

export enum CoverKind {
	Image = "image",
	Gradient = "gradient",
	Color = "color",
}

/** Normalised focal point — `0..1` in both axes, `{x:0.5,y:0.5}` is the
 *  centre. The renderer keeps this point visible when the display aspect
 *  is narrower than the source image. */
export type CoverFocal = { x: number; y: number };

export type Cover =
	/** `brainstorm://cover/<sha256>.<ext>` — bytes live in `<vault>/covers/`.
	 *  Uploaded via the B7.2 cover-upload path (shared with wallpaper/icon). */
	| { kind: CoverKind.Image; value: string; focal?: CoverFocal }
	/** A key into the curated gradient set (`COVER_GRADIENTS`). */
	| { kind: CoverKind.Gradient; value: string }
	/** A single colour — a theme token reference where possible, else a
	 *  raw CSS colour literal (OQ-COV-1 escape hatch). */
	| { kind: CoverKind.Color; value: string };
