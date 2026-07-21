/**
 * Pure catalog logic — validate the signed envelope, verify its signature,
 * decode + validate the index, resolve a listing's version for a channel.
 *
 * No IO, no native imports: every side-effecting dependency (the Ed25519 verify
 * primitive, the trusted-key lookup) is passed in, so the whole module is
 * unit-testable with no network and no Electron. Per §The catalog
 * client. Total — every function returns null/false on bad input, never throws.
 */

import type { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import type {
	CatalogIndex,
	CatalogListing,
	CatalogVersion,
	SignedCatalog,
} from "./catalog-wire-types";

/** Ed25519 verify primitive (injected — production binds `@brainstorm-os/native`'s
 *  `ed25519Verify`; tests bind the same or a stub). Returns false on any bad
 *  input rather than throwing. */
export type Ed25519Verify = (
	publicKey: Uint8Array,
	payload: Uint8Array,
	signature: Uint8Array,
) => boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** base64url → bytes. Returns null on malformed input (never throws). */
function b64urlToBytes(value: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	try {
		return new Uint8Array(Buffer.from(value, "base64url"));
	} catch {
		return null;
	}
}

/** Validate the `{ payload, kid, signature }` envelope shape. */
export function validateSignedCatalog(value: unknown): SignedCatalog | null {
	if (!isRecord(value)) return null;
	if (!isNonEmptyString(value.payload)) return null;
	if (!isNonEmptyString(value.kid)) return null;
	if (!isNonEmptyString(value.signature)) return null;
	return { payload: value.payload, kid: value.kid, signature: value.signature };
}

/** Verify the envelope's Ed25519 signature over the exact `payload` ASCII bytes
 *  against a trusted public key. The signing input is the transmitted base64url
 *  string — identical-bytes agreement with the signer, no canonicalization. */
export function verifyEnvelopeSignature(
	signed: SignedCatalog,
	publicKey: Uint8Array,
	verify: Ed25519Verify,
): boolean {
	const signature = b64urlToBytes(signed.signature);
	if (!signature) return false;
	const payloadBytes = new TextEncoder().encode(signed.payload);
	return verify(publicKey, payloadBytes, signature);
}

function validateVersion(value: unknown): CatalogVersion | null {
	if (!isRecord(value)) return null;
	if (
		!isNonEmptyString(value.manifestUrl) ||
		!isNonEmptyString(value.bundleUrl) ||
		!isNonEmptyString(value.sha256) ||
		typeof value.signature !== "string" ||
		!isNonEmptyString(value.sdk) ||
		!isNonEmptyString(value.minShell)
	) {
		return null;
	}
	return {
		manifestUrl: value.manifestUrl,
		bundleUrl: value.bundleUrl,
		sha256: value.sha256,
		signature: value.signature,
		sdk: value.sdk,
		minShell: value.minShell,
	};
}

function validateStringMap(value: unknown): Record<string, string> | null {
	if (!isRecord(value)) return null;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v !== "string") return null;
		out[k] = v;
	}
	return out;
}

function validateListing(value: unknown): CatalogListing | null {
	if (!isRecord(value)) return null;
	if (!isNonEmptyString(value.id) || !isNonEmptyString(value.kind)) return null;
	if (!isNonEmptyString(value.publisherKey) || !isNonEmptyString(value.name)) return null;
	const channels = validateStringMap(value.channels);
	if (!channels) return null;
	if (!isRecord(value.versions)) return null;
	const versions: Record<string, CatalogVersion> = {};
	for (const [v, detail] of Object.entries(value.versions)) {
		const parsed = validateVersion(detail);
		if (!parsed) return null;
		versions[v] = parsed;
	}
	const listing: CatalogListing = {
		id: value.id,
		kind: value.kind,
		publisherKey: value.publisherKey,
		name: value.name,
		channels,
		versions,
		firstParty: value.firstParty === true,
	};
	if (isNonEmptyString(value.summary)) listing.summary = value.summary;
	if (isNonEmptyString(value.iconUrl)) listing.iconUrl = value.iconUrl;
	return listing;
}

/** Validate a decoded index. A single malformed listing rejects the whole index
 *  (we never trust a partially-parsed catalog). */
export function validateCatalogIndex(value: unknown): CatalogIndex | null {
	if (!isRecord(value)) return null;
	if (!isNonEmptyString(value.catalogId)) return null;
	if (typeof value.generatedAt !== "number" || typeof value.ttlSeconds !== "number") return null;
	if (!Array.isArray(value.listings)) return null;
	const listings: CatalogListing[] = [];
	for (const entry of value.listings) {
		const parsed = validateListing(entry);
		if (!parsed) return null;
		listings.push(parsed);
	}
	return {
		catalogId: value.catalogId,
		generatedAt: value.generatedAt,
		ttlSeconds: value.ttlSeconds,
		listings,
	};
}

/** base64url-decode the envelope `payload` → JSON → validated `CatalogIndex`. */
export function decodeIndexPayload(payload: string): CatalogIndex | null {
	const bytes = b64urlToBytes(payload);
	if (!bytes) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
	return validateCatalogIndex(parsed);
}

export function findListing(index: CatalogIndex, id: string): CatalogListing | null {
	return index.listings.find((l) => l.id === id) ?? null;
}

export type ResolvedVersion = { version: string; entry: CatalogVersion };

/** Resolve a listing's current version for a channel: the channel pointer →
 *  the matching version-table entry. Returns null if the listing is absent, the
 *  channel isn't published, or the pointer dangles. */
export function resolveCatalogVersion(
	index: CatalogIndex,
	id: string,
	channel: UpdateChannel,
): ResolvedVersion | null {
	const listing = findListing(index, id);
	if (!listing) return null;
	const version = listing.channels[channel];
	if (!version) return null;
	const entry = listing.versions[version];
	if (!entry) return null;
	return { version, entry };
}
