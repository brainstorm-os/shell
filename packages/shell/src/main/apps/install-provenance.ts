/**
 * Install provenance — *where* an installed app came from and *how* it
 * stays current. Recorded per-row on `registry.db.apps` (schema v9) so the
 * update engine can reason about update sources and trust per install.
 *
 * Per §Registry schema changes.
 *
 * This is distinct from the existing `InstallSource` *input* type in
 * `installer.ts` (which is "the bundle dir to install from") and from the
 * marketplace's `ListingSource` (a UI-layer label on a browseable listing).
 * `InstallOrigin` is the durable registry-row fact: a `bootstrap-cache`
 * install (first run, offline) is later reconciled against the catalog
 * exactly because it's stamped `catalog_id = brainstorm-official`.
 */

import { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";

/** The canonical id of the official Brainstorm catalog. First-party apps —
 *  both bootstrap-cache and on-demand catalog installs — carry this. */
export const OFFICIAL_CATALOG_ID = "brainstorm-official" as const;

export enum InstallOrigin {
	/** Installed from the binary's offline bundle cache on first run. Still a
	 *  catalog-tracked install (it carries a `catalogId`) — the cache is a
	 *  snapshot of catalog entries, so the update engine reconciles it. */
	BootstrapCache = "bootstrap-cache",
	/** Fetched + installed from a catalog (official or third-party). */
	Catalog = "catalog",
	/** Direct manifest URL (sideload). Not auto-updated (no catalog to poll). */
	Sideload = "sideload",
	/** A `.brainstorm` archive on disk (dev / private). Not auto-updated. */
	LocalFile = "local-file",
	/** The dev demo-seeder (retired at migration step M5). */
	Dev = "dev",
}

export type InstallProvenance = {
	origin: InstallOrigin;
	/** Catalog this install is tracked against; null for sideload/local-file/dev. */
	catalogId: string | null;
	/** Update channel this install follows (per-app, per §Update channels). */
	channel: UpdateChannel;
	/** Ed25519 publisher key the install is TOFU-bound to for future updates; null when unsigned. */
	publisherKey: string | null;
	/** The catalog version this install corresponds to; null for sideload/local-file/dev. */
	catalogVersion: string | null;
};

/**
 * Back-compatible default for callers that don't supply provenance. Today
 * every programmatic install is the first-party seeder, so `bootstrap-cache`
 * against the official catalog is the honest default — and it matches the
 * v9 migration's backfill of pre-existing rows.
 */
export const DEFAULT_INSTALL_PROVENANCE: InstallProvenance = {
	origin: InstallOrigin.BootstrapCache,
	catalogId: OFFICIAL_CATALOG_ID,
	channel: UpdateChannel.Stable,
	publisherKey: null,
	catalogVersion: null,
};

/**
 * Provenance for the dev demo-seeder (`seedDemoApps` / `reinstallFirstPartyApp`).
 * Origin `Dev`, not catalog-tracked (the dev seeder rebuilds every boot, so
 * the update engine must never reconcile these against a catalog). Retired
 * with the seeder at migration step M5.
 */
export const DEV_INSTALL_PROVENANCE: InstallProvenance = {
	origin: InstallOrigin.Dev,
	catalogId: null,
	channel: UpdateChannel.Stable,
	publisherKey: null,
	catalogVersion: null,
};

/** Map a stored string to the enum, defaulting unknown values to
 *  `BootstrapCache` (forward-compatible: a future origin this build doesn't
 *  know reads as the benign default rather than throwing on a registry read,
 *  mirroring `parseSignatureStatus`). */
export function parseInstallOrigin(value: string): InstallOrigin {
	switch (value) {
		case InstallOrigin.Catalog:
			return InstallOrigin.Catalog;
		case InstallOrigin.Sideload:
			return InstallOrigin.Sideload;
		case InstallOrigin.LocalFile:
			return InstallOrigin.LocalFile;
		case InstallOrigin.Dev:
			return InstallOrigin.Dev;
		default:
			return InstallOrigin.BootstrapCache;
	}
}

/** Map a stored string to the channel enum, defaulting unknown to `Stable`. */
export function parseChannel(value: string): UpdateChannel {
	return value === UpdateChannel.Beta ? UpdateChannel.Beta : UpdateChannel.Stable;
}
