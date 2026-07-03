/**
 * AssetStore — encrypted binary-asset persistence for the asset subsystem.
 *
 * Each asset blob is sealed with a fresh per-asset DEK (XChaCha20-Poly1305,
 * AAD-bound to the asset id) and written off-DB at
 * `<assetsDir>/<prefix>/<assetId>.enc`; the DEK is wrapped under the vault
 * master key in `asset_deks`, and the metadata row lives in `assets`. The
 * blob is NEVER written plaintext — the subsystem is on the encryption path
 * from byte one. The legacy content-addressed media stores (covers / icons /
 * wallpapers) that were the remaining plaintext gap (OQ-240) are now encrypted
 * under a derived media key — see `vault-media-crypto.ts` / `serve-media.ts`.
 *
 * Per-asset RANDOM keys (not convergent): identical plaintext → distinct
 * ciphertext, so the structurally-blind sync relay can't learn equality
 * (OQ-236). `content_hash` is a local-only plaintext sha256 (dedupe hint /
 * integrity), never the on-disk filename and never sent over the wire.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	mkdir as fsMkdir,
	readFile as fsReadFile,
	unlink as fsUnlink,
	writeFile as fsWriteFile,
} from "node:fs/promises";
import { join } from "node:path";
import { generateSymmetricKey, openBytes, sealBytes } from "../credentials/crypto";
import type { AssetRecord, AssetsRepository } from "../storage/entities-repo";
import type { AssetDekStore } from "./asset-dek-store";
import type { AssetKind } from "./asset-types";

/** AAD prefix binding a blob's ciphertext to its asset id — defends against
 *  swapping `.enc` files between two assets the attacker can both decrypt. */
const ASSET_BLOB_AAD_PREFIX = "brainstorm/asset-blob/v1:";

/** Asset-B5 — `content_hash` sentinel for a row reconstructed from a synced
 *  manifest: the plaintext has never been on this device, so its local-only
 *  hash is unknowable until the first materialise backfills it. */
export const RECONSTRUCTED_CONTENT_HASH = "";

export type WriteAssetInput = {
	bytes: Uint8Array;
	mime: string;
	kind: AssetKind;
	originUrl?: string | null;
	/** Caller-supplied asset id, used by the IE-1 bundle restore path to
	 *  preserve the original id so entity property references still resolve in
	 *  the new vault. Omitted on the normal mint path (a fresh id is
	 *  generated). The bytes are always re-sealed under the target vault's
	 *  key, so the DEK is freshly minted regardless. */
	assetId?: string;
};

export type ReadAssetResult = {
	bytes: Uint8Array;
	mime: string;
	/** The row's `kind` — carried into the upload manifest so a cold device
	 *  reconstructs a faithful row (Asset-B5). */
	kind: AssetKind;
};

type AssetStoreFs = {
	writeFile: (path: string, data: Uint8Array) => Promise<void>;
	readFile: (path: string) => Promise<Uint8Array>;
	unlink: (path: string) => Promise<void>;
	mkdir: (path: string, opts: { recursive: boolean }) => Promise<unknown>;
};

export type AssetStoreDeps = {
	clock?: () => number;
	newAssetId?: () => string;
	newDekId?: () => string;
	fs?: Partial<AssetStoreFs>;
};

export class AssetStore {
	readonly #assets: AssetsRepository;
	readonly #dekStore: AssetDekStore;
	readonly #assetsDir: string;
	readonly #transaction: (fn: () => void) => void;
	readonly #clock: () => number;
	readonly #newAssetId: () => string;
	readonly #newDekId: () => string;
	readonly #fs: AssetStoreFs;

	constructor(
		assets: AssetsRepository,
		dekStore: AssetDekStore,
		assetsDir: string,
		transaction: (fn: () => void) => void,
		deps: AssetStoreDeps = {},
	) {
		this.#assets = assets;
		this.#dekStore = dekStore;
		this.#assetsDir = assetsDir;
		this.#transaction = transaction;
		this.#clock = deps.clock ?? (() => Date.now());
		this.#newAssetId = deps.newAssetId ?? randomUUID;
		this.#newDekId = deps.newDekId ?? randomUUID;
		this.#fs = {
			writeFile: deps.fs?.writeFile ?? ((p, d) => fsWriteFile(p, d)),
			readFile: deps.fs?.readFile ?? ((p) => fsReadFile(p)),
			unlink: deps.fs?.unlink ?? ((p) => fsUnlink(p)),
			mkdir: deps.fs?.mkdir ?? ((p, o) => fsMkdir(p, o)),
		};
	}

	/**
	 * Encrypt + store a blob as an unbound asset (orphan until an entity
	 * binds it). Writes the `.enc` file first, then inserts the `assets` +
	 * `asset_deks` rows in one transaction; if the rows fail, the file is
	 * unlinked so no orphan blob survives. The DEK is zeroed in `finally`.
	 */
	async writeAsset(input: WriteAssetInput): Promise<{ assetId: string; contentHash: string }> {
		const assetId = input.assetId ?? this.#newAssetId();
		const dekId = this.#newDekId();
		const now = this.#clock();
		const contentHash = sha256Hex(input.bytes);
		const dek = generateSymmetricKey();
		const path = this.#blobPath(assetId);
		try {
			const blob = sealBytes(dek, input.bytes, blobAad(assetId));
			await this.#fs.mkdir(this.#prefixDir(assetId), { recursive: true });
			await this.#fs.writeFile(path, blob);
			try {
				this.#transaction(() => {
					this.#assets.create({
						assetId,
						dekId,
						contentHash,
						mime: input.mime,
						byteLen: input.bytes.length,
						kind: input.kind,
						originUrl: input.originUrl ?? null,
						now,
					});
					this.#dekStore.seal(assetId, dekId, dek);
				});
			} catch (error) {
				await this.#fs.unlink(path).catch(() => {});
				throw error;
			}
			return { assetId, contentHash };
		} finally {
			dek.fill(0);
		}
	}

	/**
	 * Decrypt + return a stored asset's bytes, or null when the asset row or
	 * its blob file is gone. Throws on a tampered blob / wrong key (the AEAD
	 * tag fails) or an asset row whose DEK row is missing (inconsistent
	 * state). The DEK is zeroed in `finally`.
	 */
	async readAsset(assetId: string): Promise<ReadAssetResult | null> {
		const row = this.#assets.getById(assetId);
		if (!row) return null;
		const handle = this.#dekStore.open(assetId);
		if (!handle) {
			throw new Error(`AssetStore.readAsset: asset ${assetId} has no DEK row`);
		}
		try {
			let blob: Uint8Array;
			try {
				blob = await this.#fs.readFile(this.#blobPath(assetId));
			} catch (error) {
				if (isEnoent(error)) return null;
				throw error;
			}
			const bytes = openBytes(handle.dek, blob, blobAad(assetId));
			return { bytes, mime: row.mime, kind: row.kind };
		} finally {
			this.#dekStore.close(handle.dek);
		}
	}

	/**
	 * Asset-B5 — register a SYNCED asset's metadata on a cold device: the
	 * `assets` + `asset_deks` rows for an asset whose chunk manifest + re-homed
	 * DEK arrived on the metadata plane (the entity Y.Doc) but whose bytes have
	 * never been on this device. No blob file is written — serve-on-miss
	 * materialises bytes on first access. `content_hash` is a LOCAL-ONLY
	 * plaintext hash this device can't know yet, so the row carries the empty
	 * sentinel and `restoreBlob` backfills it on first materialise; transport
	 * integrity is the chunk AEAD under the entity-recovered DEK, exactly as on
	 * every other synced device. Reads `dek` (caller zeroes it) and seals it
	 * under THIS vault's master key so the local cache mirrors the synced
	 * source of truth. Idempotent: an existing row is a no-op (returns false).
	 */
	registerSynced(input: {
		assetId: string;
		mime: string;
		byteLen: number;
		kind: AssetKind;
		dek: Uint8Array;
	}): boolean {
		if (this.#assets.getById(input.assetId)) return false;
		const dekId = this.#newDekId();
		const now = this.#clock();
		this.#transaction(() => {
			this.#assets.create({
				assetId: input.assetId,
				dekId,
				contentHash: RECONSTRUCTED_CONTENT_HASH,
				mime: input.mime,
				byteLen: input.byteLen,
				kind: input.kind,
				now,
			});
			// Referenced-by-construction (it came off an entity's manifest), so
			// it's bound — never a reap-eligible orphan.
			this.#assets.markBound(input.assetId, now);
			this.#dekStore.seal(input.assetId, dekId, input.dek);
		});
		return true;
	}

	/**
	 * Asset-B4 serve-on-miss — re-seal an already-registered asset's plaintext
	 * back into its blob file, under its EXISTING DEK. For the metadata-present,
	 * blob-absent case (a restored DB or an evicted blob): the `assets` +
	 * `asset_deks` rows are intact, only `<id>.enc` is gone. Unlike `writeAsset`
	 * this mints no id/DEK and touches no rows — it just rematerialises the file
	 * so the next `readAsset` (which verifies the AEAD under the same DEK) round-
	 * trips. The plaintext must match the asset's `content_hash`, or the write is
	 * refused (a lying node can't substitute different bytes for the id). The one
	 * exception: a B5-reconstructed row carries the empty sentinel (this device
	 * has never seen the plaintext, so there is no hash to check against — the
	 * chunk AEAD under the entity-recovered DEK already authenticated the bytes);
	 * the first materialise verifies the LENGTH against the row and backfills the
	 * hash, pinning every later restore.
	 */
	async restoreBlob(assetId: string, plaintext: Uint8Array): Promise<void> {
		const row = this.#assets.getById(assetId);
		if (!row) throw new Error(`AssetStore.restoreBlob: asset ${assetId} has no row`);
		if (row.contentHash === RECONSTRUCTED_CONTENT_HASH) {
			if (plaintext.length !== row.byteLen) {
				throw new Error(`AssetStore.restoreBlob: asset ${assetId} length mismatch`);
			}
			this.#assets.setContentHashIfUnset(assetId, sha256Hex(plaintext));
		} else if (sha256Hex(plaintext) !== row.contentHash) {
			throw new Error(`AssetStore.restoreBlob: asset ${assetId} content hash mismatch`);
		}
		const handle = this.#dekStore.open(assetId);
		if (!handle) throw new Error(`AssetStore.restoreBlob: asset ${assetId} has no DEK row`);
		try {
			const blob = sealBytes(handle.dek, plaintext, blobAad(assetId));
			await this.#fs.mkdir(this.#prefixDir(assetId), { recursive: true });
			await this.#fs.writeFile(this.#blobPath(assetId), blob);
		} finally {
			this.#dekStore.close(handle.dek);
		}
	}

	/** Stamp an asset bound (no longer reap-eligible). */
	markBound(assetId: string): boolean {
		return this.#assets.markBound(assetId, this.#clock());
	}

	/** Every bound (saved) asset, newest first — the user-facing storage
	 *  inventory. Orphans are excluded (they're transient preview-mints). */
	listBound(): AssetRecord[] {
		return this.#assets.listBound();
	}

	/**
	 * Delete an asset's rows (the `asset_deks` + `asset_refs` rows cascade off
	 * the `assets` FK) and unlink its blob (best-effort; a missing file is
	 * fine).
	 */
	async deleteAsset(assetId: string): Promise<void> {
		this.#transaction(() => {
			this.#assets.delete(assetId);
		});
		await this.#fs.unlink(this.#blobPath(assetId)).catch(() => {});
	}

	/** Reap unbound orphans created before `cutoff` (preview-minted assets the
	 *  user never saved). Returns the count reclaimed. */
	async reapOrphans(cutoff: number): Promise<number> {
		const orphans = this.#assets.listUnboundCreatedBefore(cutoff);
		for (const orphan of orphans) {
			await this.deleteAsset(orphan.assetId);
		}
		return orphans.length;
	}

	#prefixDir(assetId: string): string {
		return join(this.#assetsDir, assetId.slice(0, 2));
	}

	#blobPath(assetId: string): string {
		return join(this.#prefixDir(assetId), `${assetId}.enc`);
	}
}

function blobAad(assetId: string): Uint8Array {
	return new TextEncoder().encode(ASSET_BLOB_AAD_PREFIX + assetId);
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
	);
}
