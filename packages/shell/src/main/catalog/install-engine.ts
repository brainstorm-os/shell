/**
 * 14.32 — InstallEngine: install a catalog listing on demand. Resolves the
 * listing's version for a channel via the {@link CatalogClient}, downloads the
 * bundle, **gates on integrity (sha256) then authenticity (Ed25519 / TOFU)**,
 * unpacks it, and hands the unpacked bundle to `AppInstaller.install` stamped
 * with `InstallOrigin.Catalog` provenance.
 *
 * Per §The catalog client + install
 * engine. Every side-effecting dependency (download / hash / verify / unpack /
 * install) is injected, so the orchestration + the two security gates are
 * unit-testable with no network, no crypto, and no filesystem. The engine adds
 * the *fetch + verify + consent* layer above the existing installer chokepoint
 * — it never writes the registry or the capability ledger itself.
 *
 * The concrete `download` (brokered shell egress), `sha256Hex` (node crypto),
 * `verifyBundle` (native Ed25519 over the bundle hash), and `unpack` (the
 * `.brainstorm` tar codec) are bound where the engine is instantiated; the
 * package-format-specific `unpack` is locked together with the first-party
 * publish pipeline (14.34) that produces the bundles.
 */

import type { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import { InstallOrigin, OFFICIAL_CATALOG_ID } from "../apps/install-provenance";
import type { AppInstaller } from "../apps/installer";
import { type BundleAcquireDeps, BundleAcquireFailure, acquireBundle } from "./bundle-acquire";
import type { CatalogClient } from "./catalog-client";

export enum InstallOutcome {
	Installed = "installed",
	/** No listing/version for this id+channel in the cached catalog. */
	NotInCatalog = "not-in-catalog",
	/** The bundle download failed (offline, non-200). */
	DownloadFailed = "download-failed",
	/** The downloaded bytes' sha256 didn't match the catalog entry. */
	IntegrityFailed = "integrity-failed",
	/** The bundle's Ed25519 signature didn't verify against the publisher key. */
	SignatureFailed = "signature-failed",
	/** The `.brainstorm` archive failed to unpack. */
	UnpackFailed = "unpack-failed",
	/** `AppInstaller.install` rejected (e.g. already installed, bad manifest). */
	InstallFailed = "install-failed",
}

export type InstallEngineResult =
	| { outcome: InstallOutcome.Installed; appId: string; version: string }
	| { outcome: Exclude<InstallOutcome, InstallOutcome.Installed>; reason: string };

export type InstallEngineDeps = BundleAcquireDeps & {
	readonly catalog: CatalogClient;
	readonly installer: AppInstaller;
	/** Catalog this engine installs from; defaults to the official catalog. */
	readonly catalogId?: string;
};

/** Map a bundle-acquire failure to the matching install outcome (same gates). */
function acquireFailureToOutcome(
	failure: BundleAcquireFailure,
): Exclude<
	InstallOutcome,
	InstallOutcome.Installed | InstallOutcome.NotInCatalog | InstallOutcome.InstallFailed
> {
	switch (failure) {
		case BundleAcquireFailure.DownloadFailed:
			return InstallOutcome.DownloadFailed;
		case BundleAcquireFailure.IntegrityFailed:
			return InstallOutcome.IntegrityFailed;
		case BundleAcquireFailure.SignatureFailed:
			return InstallOutcome.SignatureFailed;
		case BundleAcquireFailure.UnpackFailed:
			return InstallOutcome.UnpackFailed;
	}
}

export class InstallEngine {
	private readonly deps: InstallEngineDeps;

	constructor(deps: InstallEngineDeps) {
		this.deps = deps;
	}

	/**
	 * Install `id` from the cached catalog on the given channel. Total — every
	 * failure resolves to a typed outcome, never throws.
	 */
	async install(id: string, channel: UpdateChannel): Promise<InstallEngineResult> {
		const resolved = this.deps.catalog.resolveVersion(id, channel);
		const listing = this.deps.catalog.listing(id);
		if (!resolved || !listing) {
			return { outcome: InstallOutcome.NotInCatalog, reason: `${id} not in catalog on ${channel}` };
		}
		const { entry, version } = resolved;

		const acquired = await acquireBundle(entry, listing.publisherKey, this.deps);
		if (!acquired.ok) {
			return { outcome: acquireFailureToOutcome(acquired.failure), reason: acquired.reason };
		}

		const result = await this.deps.installer.install({
			bundleDir: acquired.bundleDir,
			provenance: {
				origin: InstallOrigin.Catalog,
				catalogId: this.deps.catalogId ?? OFFICIAL_CATALOG_ID,
				channel,
				publisherKey: listing.publisherKey,
				catalogVersion: version,
			},
		});
		if (!result.ok) {
			return { outcome: InstallOutcome.InstallFailed, reason: result.reason };
		}
		return { outcome: InstallOutcome.Installed, appId: result.app.id, version: result.app.version };
	}
}
