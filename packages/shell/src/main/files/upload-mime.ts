/**
 * Served-mime derivation for vault file imports (`files.import`).
 *
 * The asset protocol (`brainstorm://asset/<id>`) serves a stored blob with
 * its stored mime as `Content-Type`, to every renderer. That makes the
 * stored mime a SECURITY input, not just metadata: a blob served as
 * `text/html` / `image/svg+xml` / `application/xml` is active content on a
 * privileged scheme. So imports store only preview-safe mimes — raster
 * images, audio, video, PDF, and inert text — and everything else
 * (including SVG, HTML, XML, scripts) collapses to
 * `application/octet-stream`, which no renderer executes. The truthful
 * extension-derived mime for *labeling* lives on the `File/v1` entity,
 * derived app-side (`apps/files/src/logic/upload.ts`); this map only
 * decides what the protocol handler will ever say in `Content-Type`.
 */

export const UPLOAD_FALLBACK_MIME = "application/octet-stream";

/** Extension (lowercase, no dot) → preview-safe served mime. Deliberately
 *  NO svg / html / xml / js entries — active content never gets a
 *  renderable Content-Type off the asset protocol. */
const SERVED_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	heic: "image/heic",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	flac: "audio/flac",
	m4a: "audio/mp4",
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	pdf: "application/pdf",
	txt: "text/plain",
	md: "text/plain",
	csv: "text/plain",
	log: "text/plain",
	json: "application/json",
};

/** Lower-cases the trailing extension of `name` and maps it to the
 *  preview-safe served mime, falling back to `application/octet-stream`.
 *  A leading dot is a hidden-file prefix, not an extension. */
export function servedMimeForName(name: string): string {
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return UPLOAD_FALLBACK_MIME;
	const ext = name.slice(dot + 1).toLowerCase();
	return SERVED_MIME_BY_EXTENSION[ext] ?? UPLOAD_FALLBACK_MIME;
}

/** Reverse lookup over the same preview-safe map: mime → canonical extension
 *  (first matching entry wins, e.g. image/jpeg → jpg). Null for mimes the
 *  asset protocol never serves — a name never gains an extension that the
 *  served-mime map would refuse anyway. */
export function extensionForMime(mime: string | null | undefined): string | null {
	if (!mime) return null;
	for (const [ext, served] of Object.entries(SERVED_MIME_BY_EXTENSION)) {
		if (served === mime) return ext;
	}
	return null;
}

/** True when the served mime is a raster image the gallery can `<img>`. */
export function isPreviewableImageMime(mime: string): boolean {
	return mime.startsWith("image/");
}
