/**
 * 14.33 — pure update planning. Given the catalog-tracked installs and the
 * cached catalog index, work out which apps have a strictly newer version on
 * their subscribed channel. No IO; the capability-diff classification + the
 * actual apply live in `update-engine.ts`. Per §The update engine.
 */

import type { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import { compareVersions } from "../update/update-core";
import { findListing } from "./catalog-core";
import type { CatalogIndex, CatalogVersion } from "./catalog-wire-types";

/** The installed-app facts the planner needs. `catalogTracked` is true for
 *  installs the update engine owns — `InstallOrigin.BootstrapCache` or
 *  `Catalog` (sideload / local-file / dev installs have no catalog to poll). */
export type InstalledForUpdate = {
	id: string;
	/** Installed version. */
	version: string;
	/** Subscribed update channel (per-app). */
	channel: UpdateChannel;
	catalogTracked: boolean;
	/** The Ed25519 publisher key this install is TOFU-bound to (from the registry
	 *  row's provenance). An update whose catalog listing carries a *different*
	 *  key is refused — without a signed rotation record (v2) a changed key means
	 *  a compromised/hijacked catalog re-signing under an attacker key, not a
	 *  legitimate author. Null when the install predates provenance (no anchor to
	 *  enforce). */
	publisherKey: string | null;
};

export type UpdateCandidate = {
	id: string;
	channel: UpdateChannel;
	fromVersion: string;
	toVersion: string;
	entry: CatalogVersion;
	publisherKey: string;
};

/**
 * Candidates whose catalog version (on the install's channel) is strictly newer
 * than what's installed. Skips non-catalog-tracked installs, apps absent from
 * the catalog, and same/older versions (a lower catalog version is never a
 * downgrade through this path).
 */
export function planCatalogUpdates(
	installed: readonly InstalledForUpdate[],
	index: CatalogIndex,
): UpdateCandidate[] {
	const candidates: UpdateCandidate[] = [];
	for (const app of installed) {
		if (!app.catalogTracked) continue;
		// Resolve the listing once (resolveCatalogVersion would scan for it again).
		const listing = findListing(index, app.id);
		if (!listing) continue;
		// TOFU continuity: a listing whose publisher key differs from the one this
		// app was installed under is refused (fail-closed). Key rotation needs a
		// signed rotation record (v2, per §Key rotation); until then a
		// key change is treated as impersonation, not a legitimate update.
		if (app.publisherKey !== null && app.publisherKey !== listing.publisherKey) continue;
		const toVersion = listing.channels[app.channel];
		if (!toVersion) continue;
		const entry = listing.versions[toVersion];
		if (!entry) continue;
		if (compareVersions(toVersion, app.version) <= 0) continue;
		candidates.push({
			id: app.id,
			channel: app.channel,
			fromVersion: app.version,
			toVersion,
			entry,
			publisherKey: listing.publisherKey,
		});
	}
	return candidates;
}
