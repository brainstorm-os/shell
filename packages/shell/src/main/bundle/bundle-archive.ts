/**
 * `.bsbundle` outer container (IE-1).
 *
 * Frames the deterministic tar (`bundle-tar.ts`) in a tiny self-describing
 * header so a reader knows how to decompress *before* it can read the inner
 * `manifest.json`:
 *
 *   ┌────────┬──────────┬────────────┬───────────────────────────┐
 *   │ "BSB1" │ ver (1B) │ algo (1B)  │ compressed tar (rest)     │
 *   └────────┴──────────┴────────────┴───────────────────────────┘
 *
 * Compression is a seam: doc 45 names zstd, but `node:zlib` only exposes it
 * on newer runtimes (and not under every test runtime). We use zstd when the
 * runtime offers it and fall back to gzip — recording the actual algorithm in
 * the header — rather than putting a native dependency on the beta critical
 * path. Both are deterministic at a fixed level within one runtime, which is
 * all the byte-level round-trip guarantee requires.
 */

import { Buffer } from "node:buffer";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { BUNDLE_CONTAINER_VERSION, BUNDLE_MAGIC, BundleCompression } from "./bundle-format";
import { type TarEntry, packTar, unpackTar } from "./bundle-tar";

const MAGIC_BYTES = Buffer.from(BUNDLE_MAGIC, "ascii");
const GZIP_LEVEL = 9;

const COMPRESSION_CODE: Record<BundleCompression, number> = {
	[BundleCompression.None]: 0,
	[BundleCompression.Gzip]: 1,
	[BundleCompression.Zstd]: 2,
};
const CODE_COMPRESSION: Record<number, BundleCompression> = {
	0: BundleCompression.None,
	1: BundleCompression.Gzip,
	2: BundleCompression.Zstd,
};

type ZstdCapableZlib = typeof zlib & {
	zstdCompressSync: (buf: Buffer) => Buffer;
	zstdCompress: (buf: Buffer, cb: (error: Error | null, out: Buffer) => void) => void;
	zstdDecompressSync: (buf: Buffer, options?: { maxOutputLength?: number }) => Buffer;
};

function zstdCapable(): ZstdCapableZlib | null {
	const candidate = zlib as Partial<ZstdCapableZlib>;
	return typeof candidate.zstdCompressSync === "function" &&
		typeof candidate.zstdCompress === "function" &&
		typeof candidate.zstdDecompressSync === "function"
		? (zlib as ZstdCapableZlib)
		: null;
}

/** The algorithm the running runtime will actually use for a new export
 *  (zstd when available, else gzip). */
export function preferredCompression(): BundleCompression {
	return zstdCapable() ? BundleCompression.Zstd : BundleCompression.Gzip;
}

function compress(algo: BundleCompression, bytes: Buffer): Buffer {
	switch (algo) {
		case BundleCompression.None:
			return bytes;
		case BundleCompression.Gzip:
			return zlib.gzipSync(bytes, { level: GZIP_LEVEL });
		case BundleCompression.Zstd: {
			const z = zstdCapable();
			if (!z) throw new Error("bundle: zstd requested but unavailable in this runtime");
			return z.zstdCompressSync(bytes);
		}
	}
}

function decompress(algo: BundleCompression, bytes: Buffer, maxOutputBytes?: number): Buffer {
	switch (algo) {
		case BundleCompression.None:
			if (maxOutputBytes !== undefined && bytes.length > maxOutputBytes) {
				throw new Error(`bundle: content exceeds the ${maxOutputBytes}-byte unpack limit`);
			}
			return bytes;
		case BundleCompression.Gzip:
			return zlib.gunzipSync(
				bytes,
				maxOutputBytes !== undefined ? { maxOutputLength: maxOutputBytes } : {},
			);
		case BundleCompression.Zstd: {
			const z = zstdCapable();
			if (!z) throw new Error("bundle: zstd bundle cannot be read in this runtime");
			return z.zstdDecompressSync(
				bytes,
				maxOutputBytes !== undefined ? { maxOutputLength: maxOutputBytes } : {},
			);
		}
	}
}

const gzipAsync = promisify(zlib.gzip);

/** The async twin of {@link compress}: zlib's callback APIs run on the libuv
 *  threadpool, so a whole-vault backup no longer stalls every IPC on the main
 *  thread. Same algorithm and level, so the bytes are identical. */
async function compressAsync(algo: BundleCompression, bytes: Buffer): Promise<Buffer> {
	switch (algo) {
		case BundleCompression.None:
			return bytes;
		case BundleCompression.Gzip:
			return await gzipAsync(bytes, { level: GZIP_LEVEL });
		case BundleCompression.Zstd: {
			const z = zstdCapable();
			if (!z) throw new Error("bundle: zstd requested but unavailable in this runtime");
			return await promisify(z.zstdCompress)(bytes);
		}
	}
}

function tarOf(files: ReadonlyMap<string, Uint8Array>): Buffer {
	const entries: TarEntry[] = [...files.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([path, data]) => ({ path, data }));
	return Buffer.from(packTar(entries));
}

function frame(algo: BundleCompression, payload: Buffer): Uint8Array {
	const head = Buffer.alloc(MAGIC_BYTES.length + 2);
	MAGIC_BYTES.copy(head, 0);
	head[MAGIC_BYTES.length] = BUNDLE_CONTAINER_VERSION;
	head[MAGIC_BYTES.length + 1] = COMPRESSION_CODE[algo];
	return Buffer.concat([head, payload]);
}

/** Pack a path→bytes map into a finished `.bsbundle` byte buffer. Entries are
 *  sorted by path so the same content always produces the same archive.
 *  Synchronous — for small archives only; whole-vault exports use
 *  {@link packBundleAsync}. */
export function packBundle(
	files: ReadonlyMap<string, Uint8Array>,
	algo: BundleCompression = preferredCompression(),
): Uint8Array {
	return frame(algo, compress(algo, tarOf(files)));
}

/** {@link packBundle} with compression off the main thread. */
export async function packBundleAsync(
	files: ReadonlyMap<string, Uint8Array>,
	algo: BundleCompression = preferredCompression(),
): Promise<Uint8Array> {
	return frame(algo, await compressAsync(algo, tarOf(files)));
}

export type UnpackBundleOptions = {
	/** Cap on the decompressed tar size. A hostile archive can compress a huge
	 *  payload into a tiny file (decompression bomb) — untrusted-input callers
	 *  (the sideload install path) MUST bound the expansion. Throws when the
	 *  content would exceed the cap. */
	maxOutputBytes?: number;
};

/** Unpack a `.bsbundle` byte buffer into a path→bytes map. Throws on a bad
 *  magic / unknown container version / unknown compression code, or when the
 *  decompressed content exceeds `maxOutputBytes`. */
export function unpackBundle(
	bundle: Uint8Array,
	options: UnpackBundleOptions = {},
): Map<string, Uint8Array> {
	const buf = Buffer.from(bundle);
	if (
		buf.length < MAGIC_BYTES.length + 2 ||
		!buf.subarray(0, MAGIC_BYTES.length).equals(MAGIC_BYTES)
	) {
		throw new Error("bundle: not a .bsbundle (bad magic)");
	}
	const version = buf[MAGIC_BYTES.length] ?? 0;
	if (version !== BUNDLE_CONTAINER_VERSION) {
		throw new Error(`bundle: unsupported container version ${version}`);
	}
	const code = buf[MAGIC_BYTES.length + 1] ?? -1;
	const algo = CODE_COMPRESSION[code];
	if (algo === undefined) {
		throw new Error(`bundle: unknown compression code ${code}`);
	}
	const tar = decompress(algo, buf.subarray(MAGIC_BYTES.length + 2), options.maxOutputBytes);
	const out = new Map<string, Uint8Array>();
	for (const entry of unpackTar(tar)) out.set(entry.path, entry.data);
	return out;
}
