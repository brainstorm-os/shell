/**
 * Unified `MarketplaceListing` type per
 * §The Marketplace surface.
 *
 * Every kind (app, theme, …) flattens into this shape so the renderer
 * grids + detail pages render uniformly — see §Cross-kind unified search.
 *
 * Identity rules:
 *   - `id` is the package id (matches an app manifest id, or the built-in
 *     theme enum value). `(kind, id)` is globally unique.
 *   - `version` is the currently-listed version. For themes packaged with
 *     the shell, this matches `@brainstorm-os/tokens` SDK version; for apps
 *     it's the installed manifest version.
 *   - `installed` reflects current vault state. Sourceless listings (the
 *     built-in themes) are always installed.
 */

import type { ContentKind } from "./kinds";

export enum InstallState {
	/** Available in a catalog (or built-in) but not in the vault. */
	NotInstalled = "not-installed",
	/** Active in the vault — for themes this is *also* the active theme. */
	Installed = "installed",
	/** Active in the vault AND currently in use (only meaningful for themes). */
	Active = "active",
}

export enum ListingSource {
	/** Ships in the shell binary — themes today; never out of date. */
	BuiltIn = "built-in",
	/** Locally installed via sideload / dev seeder. */
	Sideload = "sideload",
	/** Resolved from a remote catalog. */
	Catalog = "catalog",
}

export type MarketplaceListing = {
	kind: ContentKind;
	id: string;
	version: string;
	/** Display name (already localised when sourced from a manifest). */
	name: string;
	/** Optional one-line summary surfaced on the store card. */
	summary?: string;
	/** Where this listing came from. Catalog name is in `sourceName`. */
	source: ListingSource;
	sourceName: string;
	installState: InstallState;
	/**
	 * Optional preview swatch for themes (rendered as a small palette
	 * gradient on the card). Apps get null until we render their icon —
	 * the renderer already has `apps.iconUrl(id)` for that path.
	 */
	preview?: {
		background: string;
		surface: string;
		accent: string;
		text: string;
	};
};
