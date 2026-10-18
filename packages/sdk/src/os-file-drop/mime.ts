/**
 * Extension → MIME for files entering the vault. The `mime` a File/v1 row
 * carries is the extension-truthful type (what the file IS); the shell's
 * `files.import` answers a separate preview-safe `assetMime` (active content
 * collapses to octet-stream). Extracted from Files (9.8.17) so every app that
 * turns OS files into File/v1 rows labels them identically.
 */

const EXTENSION_MIME: Readonly<Record<string, string>> = {
	txt: "text/plain",
	md: "text/markdown",
	markdown: "text/markdown",
	html: "text/html",
	htm: "text/html",
	css: "text/css",
	js: "text/javascript",
	mjs: "text/javascript",
	ts: "text/typescript",
	tsx: "text/typescript",
	json: "application/json",
	csv: "text/csv",
	xml: "application/xml",
	yaml: "text/yaml",
	yml: "text/yaml",
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
	heic: "image/heic",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	flac: "audio/flac",
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	zip: "application/zip",
	tar: "application/x-tar",
	gz: "application/gzip",
};

export const DEFAULT_MIME = "application/octet-stream";

/** Lower-cases the trailing extension and maps it to a MIME type. Returns
 *  `application/octet-stream` when the extension is missing or unknown —
 *  the safe default that preserves bytes verbatim. */
export function mimeFromName(name: string): string {
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return DEFAULT_MIME;
	const ext = name.slice(dot + 1).toLowerCase();
	return EXTENSION_MIME[ext] ?? DEFAULT_MIME;
}
