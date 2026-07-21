/**
 * Marketplace service per §The Marketplace
 * surface — collects unified listings across content kinds.
 *
 * v1 sources:
 *   - **Apps** — the union of (a) every installed-and-alive row in
 *     `registry.db`'s apps repo and (b) the first-party catalog (the apps
 *     that ship with the product). Catalog apps that aren't currently
 *     installed surface as `NotInstalled` so uninstalling a built-in app
 *     leaves it reinstallable in the store rather than vanishing.
 *   - **Themes** — the 5 built-in themes from `@brainstorm-os/tokens`.
 *
 * Forward-compat:
 *   - Remote catalogs (per `47 §Distribution channels`) plug in by
 *     resolving manifest URLs into more `MarketplaceListing` rows.
 *   - Plugin / LayoutPack / WallpaperPack / LocalePack / WorkflowPack /
 *     ShortcutPack kinds add a new gathering pass each; everything else
 *     in the service is kind-agnostic.
 *
 * The service is pure orchestration on top of existing primitives — it
 * doesn't own state. The active theme comes from the dashboard snapshot
 * (single source of truth, per §Dashboard).
 */

import { type ThemeName, themeCatalog } from "@brainstorm-os/tokens";
import { ContentKind } from "./kinds";
import { InstallState, ListingSource, type MarketplaceListing } from "./listing";

/** Stable identifier prefix for the built-in source — surfaced in the
 *  Sources panel as the canonical "Brainstorm" entry. */
export const BUILTIN_SOURCE_ID = "brainstorm-builtin" as const;
export const BUILTIN_SOURCE_NAME = "Brainstorm" as const;

export type InstalledAppRecord = {
	id: string;
	name: string;
	version: string;
	/** Manifest description — surfaces as the listing summary on cards
	 *  and the detail page. Optional because legacy bundles may lack it. */
	description?: string;
};

/** A listing resolved from a remote catalog (the `CatalogClient`, 14.31) — the
 *  channel's current version + the catalog's display name. Surfaces as a
 *  `ListingSource.Catalog` row. */
export type RemoteCatalogListing = {
	id: string;
	name: string;
	version: string;
	summary?: string;
	/** Display name of the catalog this came from (e.g. "Brainstorm"). */
	sourceName: string;
};

export type MarketplaceServiceOptions = {
	/**
	 * Returns the currently-installed apps. Wires into the existing
	 * `apps:list-installed` data path so we don't duplicate registry
	 * reads — the handler-layer dependency injection keeps this service
	 * unit-testable without a real registry.
	 */
	listInstalledApps: () => Promise<InstalledAppRecord[]>;
	/**
	 * Returns the first-party catalog — the apps that ship with the
	 * product, independent of install state. Entries not present in
	 * `listInstalledApps()` surface as `NotInstalled` (reinstallable).
	 * Wires into `readFirstPartyCatalog` on the live path; tests pass a
	 * fixed list (default `[]` keeps the installed-only behaviour).
	 */
	listCatalogApps: () => Promise<InstalledAppRecord[]>;
	/**
	 * Returns listings from subscribed remote catalogs (the `CatalogClient`,
	 * 14.31) — apps installable on demand that aren't bundled in the binary.
	 * Surface as `ListingSource.Catalog`, `NotInstalled`. Deduped against
	 * installed + built-in (those sources win). Optional; defaults to none so
	 * the offline/no-catalog path is unchanged.
	 */
	listRemoteCatalogListings?: () => Promise<RemoteCatalogListing[]>;
	/**
	 * Returns the currently-active theme name. Wires into the dashboard
	 * store on the live path; tests pass a fixed name.
	 */
	getActiveTheme: () => Promise<ThemeName | null>;
};

export class MarketplaceService {
	constructor(private readonly options: MarketplaceServiceOptions) {}

	/** Every listing the user can browse, across kinds. */
	async listings(): Promise<MarketplaceListing[]> {
		const [apps, themes] = await Promise.all([this.appListings(), this.themeListings()]);
		return [...apps, ...themes];
	}

	/** Only listings whose install state ≥ Installed. */
	async installed(): Promise<MarketplaceListing[]> {
		const all = await this.listings();
		return all.filter((l) => l.installState !== InstallState.NotInstalled);
	}

	private async appListings(): Promise<MarketplaceListing[]> {
		const [installed, catalog, remote] = await Promise.all([
			this.options.listInstalledApps(),
			this.options.listCatalogApps(),
			this.options.listRemoteCatalogListings?.() ?? Promise.resolve([]),
		]);
		const installedIds = new Set(installed.map((app) => app.id));

		const installedListings = installed.map((app) =>
			toAppListing(app, ListingSource.Sideload, InstallState.Installed),
		);
		// Built-in catalog apps not currently installed — keep them visible as
		// reinstallable. They ship in the binary, so the source is BuiltIn.
		const catalogOnly = catalog
			.filter((app) => !installedIds.has(app.id))
			.map((app) => toAppListing(app, ListingSource.BuiltIn, InstallState.NotInstalled));

		// Remote-catalog apps not already covered by an installed row or a
		// built-in entry (those sources win — never list the same id twice).
		const seen = new Set([...installedIds, ...catalog.map((app) => app.id)]);
		const remoteOnly = remote
			.filter((app) => !seen.has(app.id))
			.map((app) =>
				toAppListing(
					{
						id: app.id,
						name: app.name,
						version: app.version,
						...(app.summary ? { description: app.summary } : {}),
					},
					ListingSource.Catalog,
					InstallState.NotInstalled,
					app.sourceName,
				),
			);

		return [...installedListings, ...catalogOnly, ...remoteOnly];
	}

	private async themeListings(): Promise<MarketplaceListing[]> {
		const active = await this.options.getActiveTheme();
		return themeCatalog.map((entry) => ({
			kind: ContentKind.Theme,
			id: entry.id,
			// Built-in themes ship with the shell binary; pin to the shell's
			// SDK version once we expose it. Until then "builtin" is honest.
			version: "builtin",
			// Catalog labelKey is an i18n key — the renderer translates it.
			// We surface the key so the marketplace can call `t()` later.
			name: entry.labelKey,
			summary: entry.descriptionKey,
			source: ListingSource.BuiltIn,
			sourceName: BUILTIN_SOURCE_NAME,
			installState: active === entry.id ? InstallState.Active : InstallState.Installed,
			preview: entry.preview,
		}));
	}
}

function toAppListing(
	app: InstalledAppRecord,
	source: ListingSource,
	installState: InstallState,
	sourceName: string = BUILTIN_SOURCE_NAME,
): MarketplaceListing {
	return {
		kind: ContentKind.App,
		id: app.id,
		version: app.version,
		name: app.name,
		...(app.description ? { summary: app.description } : {}),
		source,
		sourceName,
		installState,
	};
}

/** Sources known to the marketplace. Each remote catalog adds one entry
 *  in a future iteration; today only the built-in source ships. */
export type MarketplaceSource = {
	id: string;
	name: string;
	/** `true` when the source ships in the shell binary (cannot be removed). */
	builtIn: boolean;
};

export const BUILTIN_SOURCE: MarketplaceSource = {
	id: BUILTIN_SOURCE_ID,
	name: BUILTIN_SOURCE_NAME,
	builtIn: true,
};
