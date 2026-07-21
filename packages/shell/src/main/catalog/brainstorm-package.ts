/**
 * 14.34 — the `.brainstorm` app package format (OQ-LC-7 → tar + gzip).
 *
 * Resolves the package compression to **tar + gzip**, reusing the deterministic
 * `.bsbundle` codec (`main/bundle/bundle-archive.ts`: tar via `bundle-tar.ts`
 * with a zip-slip guard, gzip via node:zlib) rather than the tar+zstd sketch in
 *  — zstd needs a runtime the shell can't guarantee, gzip is Node
 * core and already on the beta path. Gzip is **forced** here (not the codec's
 * zstd-preferred default) so any client runtime can always decompress a
 * published bundle.
 *
 * This is the single source the CI packer (sign side) and the shell
 * InstallEngine (verify + unpack side) both speak, so they agree by
 * construction. Per §The install/update engines + §14.34.
 *
 * Crypto: sha256 (node:crypto — hashing, not keystore) + Ed25519 over the
 * bundle content hash (`@brainstorm-os/native`, the same verify primitive the
 * manifest-signature + catalog-index paths use; never a keystore import).
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { ed25519Sign, ed25519Verify } from "@brainstorm-os/native";
import { packBundle, unpackBundle } from "../bundle/bundle-archive";
import { BundleCompression } from "../bundle/bundle-format";

/** The `ed25519:` prefix on a wire publisher key (`ed25519:<base64url 32-byte>`). */
const PUBLISHER_KEY_PREFIX = "ed25519:";

/** Pack an app's files (path → bytes; e.g. `manifest.json`, `dist/index.html`,
 *  `assets/icon.svg`) into a `.brainstorm` archive. Gzip-forced for portability;
 *  entries are sorted by path so the same content always yields the same bytes
 *  (a stable sha256 → stable content address). */
export function packBrainstormBundle(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
	return packBundle(files, BundleCompression.Gzip);
}

/** Unpack a `.brainstorm` archive to a path → bytes map. Throws on bad magic /
 *  version / compression (the codec) or an unsafe path (the tar zip-slip guard). */
export function unpackBrainstormBundle(bytes: Uint8Array): Map<string, Uint8Array> {
	return unpackBundle(bytes);
}

/**
 * Unpack a `.brainstorm` archive onto disk under `destDir` and return it — the
 * `bundleDir` the InstallEngine hands to `AppInstaller.install`. Each entry is
 * re-checked to stay within `destDir` (defense-in-depth on top of the tar
 * unpacker's own absolute/`..` rejection) before it's written.
 */
export async function unpackBrainstormBundleToDir(
	bytes: Uint8Array,
	destDir: string,
): Promise<string> {
	const root = resolve(destDir);
	const files = unpackBrainstormBundle(bytes);
	for (const [path, data] of files) {
		const target = resolve(root, path);
		if (target !== root && !target.startsWith(root + sep)) {
			throw new Error(`brainstorm-package: refusing entry outside bundle dir: ${path}`);
		}
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, data);
	}
	return root;
}

/** Hex sha256 of a `.brainstorm` archive — its content address + integrity
 *  check. This is the value the catalog records and the InstallEngine compares. */
export function bundleSha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** Parse a wire publisher key (`ed25519:<base64url 32-byte>`) → 32 raw bytes, or
 *  null on a malformed / wrong-length / dev-placeholder key. */
export function parseEd25519PublisherKey(publisherKey: string): Uint8Array | null {
	if (!publisherKey.startsWith(PUBLISHER_KEY_PREFIX)) return null;
	const b64 = publisherKey.slice(PUBLISHER_KEY_PREFIX.length);
	if (!/^[A-Za-z0-9_-]+$/.test(b64)) return null;
	try {
		const bytes = new Uint8Array(Buffer.from(b64, "base64url"));
		return bytes.length === 32 ? bytes : null;
	} catch {
		return null;
	}
}

/** Sign a bundle's content hash with an Ed25519 seed (the publisher's private
 *  key) → base64url signature. CI / `brainstorm-cli` side only; the shell never
 *  calls this. */
export function signBundleHash(bundleSha256HexValue: string, seed: Uint8Array): string {
	const digest = hexToBytes(bundleSha256HexValue);
	if (!digest) throw new Error("signBundleHash: invalid sha256 hex");
	return Buffer.from(ed25519Sign(seed, digest)).toString("base64url");
}

/**
 * Verify a bundle's Ed25519 signature over its content hash against the
 * publisher key — the InstallEngine/UpdateEngine `verifyBundle` binding. Total:
 * a malformed hash / signature / key returns false, never throws.
 */
export function verifyBundleSignature(
	bundleSha256HexValue: string,
	signatureB64: string,
	publisherKey: string,
): boolean {
	const digest = hexToBytes(bundleSha256HexValue);
	if (!digest) return false;
	const key = parseEd25519PublisherKey(publisherKey);
	if (!key) return false;
	if (!/^[A-Za-z0-9_-]+$/.test(signatureB64)) return false;
	let signature: Uint8Array;
	try {
		signature = new Uint8Array(Buffer.from(signatureB64, "base64url"));
	} catch {
		return false;
	}
	if (signature.length !== 64) return false;
	return ed25519Verify(key, digest, signature);
}

/** Build the install dir path the InstallEngine unpacks into for a download. */
export function bundleStagingDir(baseDir: string, id: string, version: string): string {
	return join(baseDir, `${id}-${version}`);
}
