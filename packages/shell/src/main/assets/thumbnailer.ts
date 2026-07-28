/**
 * Asset-B4b — thumbnail derivation policy over the `@brainstorm-os/native-image`
 * binding (Rust `image` crate behind napi-rs; decode + resize run on the libuv
 * threadpool, never the main thread).
 *
 * Split on purpose: the native call is a pure transform (decode → bounded
 * resize → re-encode); every *decision* — which assets are eligible, when a
 * derivative is worth keeping, what happens when the addon is missing — lives
 * here in TS where it is unit-testable without the binding.
 *
 * Fail-soft is the contract: a missing addon (dev build without the crate, an
 * unmapped platform), an undecodable source, or an unprofitable result all
 * yield `null` — the caller proceeds exactly as if thumbnails didn't exist.
 * Nothing on the bind/upload path may fail because of this module.
 */

/** Long-edge bound for the derived preview. 512px covers a ~256pt gallery
 *  tile at 2× DPI; at JPEG q80 a photographic source lands ~20–60 KiB — small
 *  enough that the whole tier can materialise eagerly on connect. */
export const THUMBNAIL_MAX_EDGE = 512;

/** JPEG quality for opaque sources (alpha sources re-encode as PNG). */
export const THUMBNAIL_JPEG_QUALITY = 80;

/** Sources at or below this size get no derivative: they are already
 *  thumbnail-cheap to fetch, so a derived copy would only add rows + chunks. */
export const THUMBNAIL_MIN_SOURCE_BYTES = 32 * 1024;

/** Mimes the native decoder handles. Deliberately excludes `image/svg+xml`
 *  (script-capable, never decoded) and `image/avif` (dav1d not linked) — an
 *  excluded source simply gets no thumbnail. */
const THUMBNAILABLE_MIME = new Set<string>([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/bmp",
]);

export type DerivedThumbnail = {
	bytes: Uint8Array;
	/** `image/jpeg` or `image/png` — both on the serve-safe raster list. */
	mime: string;
};

/** Derive a preview for (bytes, mime), or null when ineligible / unavailable /
 *  not worth keeping. Never throws. */
export type Thumbnailer = (bytes: Uint8Array, mime: string) => Promise<DerivedThumbnail | null>;

export function isThumbnailableMime(mime: string): boolean {
	return THUMBNAILABLE_MIME.has(mime.toLowerCase());
}

type NativeImageModule = {
	imageThumbnail: (
		bytes: Buffer,
		maxEdge: number,
		jpegQuality: number,
	) => Promise<{ bytes: Buffer; mime: string }>;
};

/**
 * The production thumbnailer. The native module loads lazily on first use and
 * an unloadable addon disables the feature for the process lifetime (logged
 * once) — mirroring how the embed addon degrades semantic search.
 */
export function createNativeThumbnailer(
	loadModule: () => Promise<NativeImageModule> = () => import("@brainstorm-os/native-image"),
): Thumbnailer {
	let modulePromise: Promise<NativeImageModule | null> | null = null;
	const loadOnce = (): Promise<NativeImageModule | null> => {
		modulePromise ??= loadModule().catch((error: unknown) => {
			console.warn(
				`[thumbnailer] native-image addon unavailable — thumbnails disabled: ${(error as Error).message}`,
			);
			return null;
		});
		return modulePromise;
	};
	return async (bytes, mime) => {
		if (!isThumbnailableMime(mime)) return null;
		if (bytes.length <= THUMBNAIL_MIN_SOURCE_BYTES) return null;
		const native = await loadOnce();
		if (!native) return null;
		try {
			const result = await native.imageThumbnail(
				Buffer.from(bytes),
				THUMBNAIL_MAX_EDGE,
				THUMBNAIL_JPEG_QUALITY,
			);
			const out = new Uint8Array(result.bytes);
			// A derivative that isn't meaningfully smaller than its source buys
			// nothing on the eager tier — serve the original instead.
			if (out.length >= bytes.length) return null;
			return { bytes: out, mime: result.mime };
		} catch (error) {
			// Undecodable / oversized / corrupt source — fail-soft, no thumbnail.
			console.warn(`[thumbnailer] derivation failed (${mime}): ${(error as Error).message}`);
			return null;
		}
	};
}
