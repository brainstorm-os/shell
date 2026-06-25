/**
 * Catalog wire types — the shape the catalog API serves, mirrored from
 * `../cloud/services/catalog-edge`. Renderer-safe (no Electron,
 * no native): pure data shapes shared by the pure core + the client.
 *
 * Per §The catalog API contract.
 * The index is delivered inside a detached-payload signed envelope
 * (`SignedCatalog`): `payload` is base64url of the JSON `CatalogIndex`, and the
 * signature is Ed25519 over the exact `payload` ASCII — the same JWS discipline
 * as the entitlement token, so verification is offline + canonicalization-free.
 */

/** One published version of a listing — the content-addressed bundle the shell
 *  downloads, plus the integrity + authenticity material it verifies before
 *  install. */
export type CatalogVersion = {
	manifestUrl: string;
	bundleUrl: string;
	/** Hex sha256 of the `.brainstorm` bundle (content address + integrity). */
	sha256: string;
	/** base64url Ed25519 signature over the bundle content hash (TOFU anchor). */
	signature: string;
	sdk: string;
	minShell: string;
};

/** A catalog listing — one installable item. `channels` maps a channel name
 *  (`stable` / `beta`) to its current version; `versions` is the detail table.
 *  `kind` is a `ContentKind` wire value (`app` today). */
export type CatalogListing = {
	id: string;
	kind: string;
	publisherKey: string;
	name: string;
	summary?: string;
	iconUrl?: string;
	channels: Record<string, string>;
	versions: Record<string, CatalogVersion>;
	firstParty: boolean;
};

/** The index document (the decoded `payload`). */
export type CatalogIndex = {
	catalogId: string;
	generatedAt: number;
	ttlSeconds: number;
	listings: CatalogListing[];
};

/** The signed envelope served at `GET /v1/catalog/index`. */
export type SignedCatalog = {
	/** base64url of the serialized `CatalogIndex`. */
	payload: string;
	/** Key id selecting the verifier-side public key (two-key rotation). */
	kid: string;
	/** base64url Ed25519 signature over the `payload` ASCII bytes. */
	signature: string;
};
