/**
 * Shared discriminators for the binary-asset subsystem. Per the
 * code-conventions "no raw string literals as discriminators" rule, the
 * `kind` of an asset and the `role` a referencing entity assigns it are
 * enums. The enum *values* are the wire/on-disk strings (so the DB columns
 * stay human-readable and an `assets.bind` call carries the value verbatim).
 */

/** What a stored asset is. Favicon/cover are scrape-sourced today; `upload`
 *  is the forward slot for user-attached files. `thumbnail` (Asset-B4b) is a
 *  derived preview-size image whose parent row points at it via
 *  `assets.thumb_asset_id` — it rides the same pipeline as any asset but
 *  belongs to the small always-synced (eager) tier. */
export enum AssetKind {
	Favicon = "favicon",
	Cover = "cover",
	Upload = "upload",
	Thumbnail = "thumbnail",
}

/** How an owning entity uses an asset. A `Bookmark/v1` binds one favicon +
 *  one cover; `inline` is the forward slot for body-embedded images;
 *  `thumbnail` (Asset-B4b) binds a derived preview to every entity that
 *  binds its parent (the ref keeps the derivative GC-reachable + in the
 *  upload/eager drains). */
export enum AssetRefRole {
	Favicon = "favicon",
	Cover = "cover",
	Inline = "inline",
	Thumbnail = "thumbnail",
}
