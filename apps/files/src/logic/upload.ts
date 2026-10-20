/**
 * Pure helpers for the upload flow (`uploadFiles` in `use-files-store`).
 *
 * The upload path is the real half of plan iteration `9.8.5`: the user
 * picks one or more OS files via `services.files.requestOpen` (the 9.10
 * broker method), the app reads each via `services.files.read`, then
 * creates a `File/v1` entity per picked file with `name`, `mime`, `size`,
 * and a SHA-256 `hash`.
 *
 * Everything here is pure / DOM-free so it can be unit-tested without a
 * jsdom environment. The hash helper uses Web Crypto (`crypto.subtle`),
 * which Node ≥18 + vitest's `jsdom` env both provide.
 */

/** Split a filename into `stem` + `ext` ("" or ".jpg"-with-dot). A leading
 *  dot is treated as a hidden-file prefix, not an extension — `.bashrc`
 *  has stem `.bashrc` + ext "". */
export function splitName(name: string): { stem: string; ext: string } {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return { stem: name, ext: "" };
	return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** Produce `report (2).pdf` from `report.pdf` + counter `2`. Inserts the
 *  ` (N)` suffix between the stem and the extension so the file's MIME
 *  hint survives the rename. */
export function collisionName(originalName: string, counter: number): string {
	const { stem, ext } = splitName(originalName);
	return `${stem} (${counter})${ext}`;
}

/** SHA-256 of `bytes` as lowercase hex. Web Crypto (`crypto.subtle.digest`)
 *  exists in the sandboxed renderer and Node ≥18. The input is copied into
 *  a fresh `ArrayBuffer` so a `SharedArrayBuffer`-backed view (TS narrows
 *  `Uint8Array.buffer` to `ArrayBufferLike`) still satisfies `BufferSource`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) throw new Error("crypto.subtle unavailable");
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	const digest = await subtle.digest("SHA-256", buffer);
	const view = new Uint8Array(digest);
	let out = "";
	for (let i = 0; i < view.length; i += 1) {
		const byte = view[i] ?? 0;
		out += byte.toString(16).padStart(2, "0");
	}
	return out;
}
