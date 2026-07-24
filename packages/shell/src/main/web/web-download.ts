/**
 * Browser-6 — the pure core behind materialising a browser download into the
 * vault as a `brainstorm/File/v1` entity whose bytes are sealed into the
 * encrypted asset store (the `files` host write pattern, 9.10). The Electron
 * capture — session `will-download`, byte streaming, and size enforcement —
 * lives in `web-view-factory.ts`; the seal + entity write is wired in
 * `main/index.ts`. This module owns every UNTRUSTED-input decision so each
 * branch is unit-tested:
 *
 *   - {@link sanitizeDownloadFilename} hardens the server-supplied filename
 *     (from Content-Disposition): basename-only (no path traversal — a
 *     `../../etc/passwd` or `C:\…` collapses to its last segment), control /
 *     zero-width / bidi-override strip via the shared `sanitizeInlineText`,
 *     residual path-separator + NUL removal, a length clamp that preserves the
 *     extension, and a non-empty fallback.
 *   - {@link downloadSourceUrl} validates the originating URL (http(s), re-
 *     serialized, length-bounded) before it is stamped as provenance.
 *   - {@link downloadFileProperties} builds the `File/v1` property bag,
 *     mirroring the shell import + Books `File/v1` shape so the Files "Storage"
 *     view + Preview read it verbatim.
 *   - {@link MAX_DOWNLOAD_BYTES} bounds the buffered-into-memory seal.
 *
 * The STORED (served) mime is the shell's conservative `servedMimeForName`
 * allow-list (see `files/upload-mime.ts`), applied by the caller — active
 * content can never gain a renderable Content-Type off the asset protocol.
 */

import { sanitizeInlineText } from "@brainstorm-os/sdk/sanitize-text";

/** The vault entity type a download becomes. Wire id owned by the Files app
 *  manifest; restated as a string constant (apps/shell don't import each other). */
export const DOWNLOAD_FILE_ENTITY_TYPE = "brainstorm/File/v1";

/** Upper bound on a sealed download. Bytes are read fully into memory to seal
 *  into the asset store, so this is a memory ceiling as much as a policy one —
 *  matched to the `files.write` envelope ceiling (`MAX_WRITE_BYTES`). */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

/** Max stored filename length. Server-supplied + untrusted; clamped so a
 *  pathological Content-Disposition can't bloat the row / any later FS export. */
export const DOWNLOAD_FILENAME_MAX_LEN = 200;

/** Fallback name when the server filename sanitizes to nothing. */
export const DOWNLOAD_FALLBACK_NAME = "download";

/** Upper bound on a persisted source URL (matches the clip-path bound). */
export const DOWNLOAD_SOURCE_URL_MAX_LEN = 2048;

/** Longest extension kept when clamping — anything longer is treated as not a
 *  real extension (a hostile "extension" can't consume the whole budget). */
const MAX_KEPT_EXTENSION_LEN = 16;

/** Char budget for the control/bidi strip pass — generous so the extension is
 *  never pre-clamped away before the extension-preserving length clamp runs
 *  (a real filename is far shorter; a pathological one is bounded here too). */
const SANITIZE_SCAN_CAP = 100_000;

function stripFilenameSeparators(name: string): string {
	// After basename extraction there should be no separators, but a filename
	// smuggling one in an odd form must never survive into a stored name a later
	// export could treat as a path.
	let out = "";
	for (const ch of name) {
		if (ch === "/" || ch === "\\" || ch === "\u0000") continue;
		out += ch;
	}
	return out;
}

/** Split off a trailing extension (".pdf") from the stem. A leading dot is a
 *  hidden-file prefix, not an extension. */
function splitExtension(name: string): { stem: string; ext: string } {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return { stem: name, ext: "" };
	return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Harden a server-supplied download filename. Basename-only (path-traversal
 * defence), control / zero-width / bidi stripped, residual separators removed,
 * clamped to {@link DOWNLOAD_FILENAME_MAX_LEN} keeping the extension, and
 * falling back to `download` when nothing usable survives.
 */
export function sanitizeDownloadFilename(raw: unknown): string {
	const asString = typeof raw === "string" ? raw : "";
	// Basename: drop everything up to the last / or \ (posix + windows).
	const base = asString.replace(/^.*[\\/]/, "");
	const cleaned = stripFilenameSeparators(sanitizeInlineText(base, SANITIZE_SCAN_CAP));
	if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return DOWNLOAD_FALLBACK_NAME;
	if (cleaned.length <= DOWNLOAD_FILENAME_MAX_LEN) return cleaned;
	// Clamp while preserving a (bounded) extension so the file's kind survives.
	const { stem, ext } = splitExtension(cleaned);
	const keepExt = ext.length <= MAX_KEPT_EXTENSION_LEN ? ext : "";
	const room = Math.max(1, DOWNLOAD_FILENAME_MAX_LEN - keepExt.length);
	return `${stem.slice(0, room)}${keepExt}`.slice(0, DOWNLOAD_FILENAME_MAX_LEN);
}

/** Validate a candidate download source URL: http(s), re-serialized (control
 *  chars percent-encoded, never the raw string), length-bounded. Returns
 *  `null` when it isn't a safe web URL to record. */
export function downloadSourceUrl(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	return parsed.href.length <= DOWNLOAD_SOURCE_URL_MAX_LEN ? parsed.href : null;
}

export type DownloadFileInput = {
	name: string;
	/** The served (allow-listed) mime the asset protocol will emit for the blob. */
	mime: string;
	size: number;
	/** The content hash from the asset-store seal. */
	hash: string;
	assetId: string;
	/** The download's originating URL (already validated http(s)) or null. */
	sourceUrl: string | null;
};

/** The `File/v1` property bag for a sealed download. Mirrors the shell import
 *  + Books `File/v1` shape (name/mime/size/hash/assetId/attachment) so the
 *  Files "Storage" view + Preview read it verbatim, plus a `sourceUrl`
 *  provenance stamp. `attachment` is the fetchable `brainstorm://asset/<id>`
 *  URL the implicit asset-ref binder keys on. */
export function downloadFileProperties(input: DownloadFileInput): Record<string, unknown> {
	const props: Record<string, unknown> = {
		name: input.name,
		mime: input.mime,
		size: input.size,
		hash: input.hash,
		assetId: input.assetId,
		attachment: `brainstorm://asset/${input.assetId}`,
	};
	if (input.sourceUrl) props.sourceUrl = input.sourceUrl;
	return props;
}
