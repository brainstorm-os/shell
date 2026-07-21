/**
 * 14.31 — CatalogClient: fetches the signed catalog index, verifies it offline,
 * caches the last good copy, and answers listing/version queries for the
 * install + update engines (14.32 / 14.33) and the Marketplace surface.
 *
 * Per §The catalog client. Mirrors the
 * 13.6 `UpdateService` discipline: every IO dependency is injected, and the
 * service is **total** — a fetch/parse/verify failure resolves to a status +
 * keeps the last good cached index, never throws and never installs from an
 * unverified index.
 */

import { ed25519Verify } from "@brainstorm-os/native";
import type { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import {
	type Ed25519Verify,
	type ResolvedVersion,
	decodeIndexPayload,
	resolveCatalogVersion,
	validateSignedCatalog,
	verifyEnvelopeSignature,
} from "./catalog-core";
import type { CatalogIndex, CatalogListing } from "./catalog-wire-types";

/** Trusted catalog signing keys, keyed by envelope `kid` → raw 32-byte Ed25519
 *  public key. The official catalog's key is baked into the shell binary (with
 *  rotation); a third-party catalog's key is TOFU'd. Empty → every index reads
 *  unverified (fail-closed). */
export type CatalogTrustedKeys = ReadonlyMap<string, Uint8Array>;

/** Persists the last good verified index so the Marketplace renders + the update
 *  engine no-ops offline. Production: a JSON file under `userData` (mirrors
 *  `UpdatePrefsStore`); the in-memory impl is the default + test substrate. */
export interface CatalogCacheStore {
	load(): CatalogIndex | null;
	save(index: CatalogIndex): void;
}

export class InMemoryCatalogCache implements CatalogCacheStore {
	private index: CatalogIndex | null = null;
	load(): CatalogIndex | null {
		return this.index;
	}
	save(index: CatalogIndex): void {
		this.index = index;
	}
}

export enum CatalogRefreshStatus {
	/** Fetched, verified, cached. */
	Ok = "ok",
	/** Fetched but the signature/shape failed — last good index kept. */
	Unverified = "unverified",
	/** Fetch/parse failed (offline, non-200, garbage) — last good index kept. */
	Unavailable = "unavailable",
}

export type CatalogRefreshResult = {
	status: CatalogRefreshStatus;
	/** The freshly-verified index on `Ok`; otherwise the last good cached index
	 *  (or null if none was ever cached). */
	index: CatalogIndex | null;
};

export type CatalogClientOptions = {
	/** Fetch + JSON-parse `GET /v1/catalog/index`. Production binds the Net-1
	 *  brokered fetch (the shell's own egress, never an app's); returns the
	 *  parsed value, or rejects/returns garbage on failure (handled as
	 *  `Unavailable`). */
	readonly fetchIndexJson: () => Promise<unknown>;
	readonly trustedKeys: CatalogTrustedKeys;
	readonly cache: CatalogCacheStore;
	/** Ed25519 verify primitive; defaults to `@brainstorm-os/native`. */
	readonly verify?: Ed25519Verify;
};

export class CatalogClient {
	private readonly fetchIndexJson: () => Promise<unknown>;
	private readonly trustedKeys: CatalogTrustedKeys;
	private readonly cache: CatalogCacheStore;
	private readonly verify: Ed25519Verify;

	constructor(options: CatalogClientOptions) {
		this.fetchIndexJson = options.fetchIndexJson;
		this.trustedKeys = options.trustedKeys;
		this.cache = options.cache;
		this.verify = options.verify ?? ed25519Verify;
	}

	/**
	 * Fetch → validate envelope → verify signature against the kid's trusted key
	 * → decode + validate the index → cache it. Total: any failure resolves to a
	 * status and keeps the last good cached index.
	 */
	async refresh(): Promise<CatalogRefreshResult> {
		let raw: unknown;
		try {
			raw = await this.fetchIndexJson();
		} catch {
			return { status: CatalogRefreshStatus.Unavailable, index: this.cache.load() };
		}

		const signed = validateSignedCatalog(raw);
		if (!signed) {
			return { status: CatalogRefreshStatus.Unavailable, index: this.cache.load() };
		}

		const publicKey = this.trustedKeys.get(signed.kid);
		if (!publicKey || !verifyEnvelopeSignature(signed, publicKey, this.verify)) {
			return { status: CatalogRefreshStatus.Unverified, index: this.cache.load() };
		}

		const index = decodeIndexPayload(signed.payload);
		if (!index) {
			// Signature verified but the payload didn't parse — treat as unverified
			// (a trusted signer would never emit a malformed index; don't cache it).
			return { status: CatalogRefreshStatus.Unverified, index: this.cache.load() };
		}

		this.cache.save(index);
		return { status: CatalogRefreshStatus.Ok, index };
	}

	/** The last good verified index, or null if none cached yet. */
	cachedIndex(): CatalogIndex | null {
		return this.cache.load();
	}

	/** Every listing in the cached index (empty before the first successful refresh). */
	listings(): CatalogListing[] {
		return this.cache.load()?.listings ?? [];
	}

	listing(id: string): CatalogListing | null {
		return this.listings().find((l) => l.id === id) ?? null;
	}

	/** Resolve a listing's current version on a channel from the cached index. */
	resolveVersion(id: string, channel: UpdateChannel): ResolvedVersion | null {
		const index = this.cache.load();
		return index ? resolveCatalogVersion(index, id, channel) : null;
	}
}
