/**
 * 14.32 — the official Brainstorm catalog's trusted signing keys, baked into the
 * shell binary (with rotation, mirroring the entitlement-token issuer key in
 * ). The `CatalogClient` verifies the
 * signed index against these before trusting any listing — a hijacked origin
 * can't inject apps.
 *
 * Keyed by the envelope `kid`. Today the dev `catalog-edge` signs with a fixed
 * dev seed; we derive its public key here so a dev shell (pointed at a local
 * `catalog-edge` via `BRAINSTORM_CATALOG_URL`) verifies end-to-end. Production
 * replaces `DEV_CATALOG_PUBLIC_KEY` with the real listing key's public half
 * (the private half lives only in the catalog service's secret manager).
 */

import { ed25519GetPublicKey } from "@brainstorm-os/native";
import type { CatalogTrustedKeys } from "./catalog-client";

/** The dev `catalog-edge` signing seed (`SigningKey::from_bytes(&[9u8; 32])`).
 *  DEV ONLY — production never ships a seed, only the derived public key. */
const DEV_CATALOG_SEED = new Uint8Array(32).fill(9);

export const DEV_CATALOG_KID = "catalog-k1" as const;

/** The trusted-keys map the official `CatalogClient` is constructed with. */
export function officialCatalogTrustedKeys(): CatalogTrustedKeys {
	return new Map([[DEV_CATALOG_KID, ed25519GetPublicKey(DEV_CATALOG_SEED)]]);
}
