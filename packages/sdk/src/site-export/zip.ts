/**
 * `zipStore` — a store-only (no compression) ZIP writer, so a sandboxed app
 * can hand the single-file save dialog a whole folder tree without a runtime
 * dependency or `node:zlib`.
 *
 * Entry names are checked here as well as where they are planned: an archive
 * is the one place a `..` or an absolute name turns into a write outside the
 * folder the reader unpacks into.
 */

export type ZipEntry = {
	readonly path: string;
	readonly bytes: Uint8Array;
};

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const VERSION_NEEDED = 20;
const UTF8_NAME_FLAG = 0x0800;
const METHOD_STORE = 0;
const MAX_ENTRIES = 0xffff;
const MAX_ARCHIVE_BYTES = 0xffffffff;
const MAX_NAME_BYTES = 0xffff;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

/** True for a relative, forward-slash path whose every segment is a plain
 *  name — nothing that can climb out of, or be rooted outside, the folder an
 *  archive is unpacked into. */
export function isSafeArchivePath(path: string): boolean {
	if (path.length === 0 || path.startsWith("/")) return false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting controls is the point
	if (/[\\:\u0000-\u001f\u007f]/.test(path)) return false;
	return path
		.split("/")
		.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function dosDateTime(at: Date): { time: number; date: number } {
	const year = Math.min(2107, Math.max(1980, at.getFullYear()));
	return {
		time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
		date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
	};
}

export function zipStore(
	entries: readonly ZipEntry[],
	options: { readonly modifiedAt?: Date } = {},
): Uint8Array {
	if (entries.length > MAX_ENTRIES) throw new Error("site-export/zip: too many entries");
	const encoder = new TextEncoder();
	const seen = new Set<string>();
	const named = entries.map((entry) => {
		if (!isSafeArchivePath(entry.path)) throw new Error("site-export/zip: unsafe entry path");
		const key = entry.path.normalize("NFC").toLowerCase();
		if (seen.has(key)) throw new Error("site-export/zip: duplicate entry path");
		seen.add(key);
		const name = encoder.encode(entry.path);
		if (name.length > MAX_NAME_BYTES) throw new Error("site-export/zip: entry path too long");
		return { name, bytes: entry.bytes, crc: crc32(entry.bytes) };
	});

	const localBytes = named.reduce(
		(n, e) => n + LOCAL_HEADER_BYTES + e.name.length + e.bytes.length,
		0,
	);
	const centralBytes = named.reduce((n, e) => n + CENTRAL_HEADER_BYTES + e.name.length, 0);
	const total = localBytes + centralBytes + END_OF_CENTRAL_DIRECTORY_BYTES;
	if (total > MAX_ARCHIVE_BYTES) throw new Error("site-export/zip: archive too large");

	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	const { time, date } = dosDateTime(options.modifiedAt ?? new Date());
	const offsets: number[] = [];
	let at = 0;

	for (const entry of named) {
		offsets.push(at);
		view.setUint32(at, LOCAL_HEADER_SIGNATURE, true);
		view.setUint16(at + 4, VERSION_NEEDED, true);
		view.setUint16(at + 6, UTF8_NAME_FLAG, true);
		view.setUint16(at + 8, METHOD_STORE, true);
		view.setUint16(at + 10, time, true);
		view.setUint16(at + 12, date, true);
		view.setUint32(at + 14, entry.crc, true);
		view.setUint32(at + 18, entry.bytes.length, true);
		view.setUint32(at + 22, entry.bytes.length, true);
		view.setUint16(at + 26, entry.name.length, true);
		out.set(entry.name, at + LOCAL_HEADER_BYTES);
		out.set(entry.bytes, at + LOCAL_HEADER_BYTES + entry.name.length);
		at += LOCAL_HEADER_BYTES + entry.name.length + entry.bytes.length;
	}

	const centralStart = at;
	named.forEach((entry, index) => {
		view.setUint32(at, CENTRAL_HEADER_SIGNATURE, true);
		view.setUint16(at + 4, VERSION_NEEDED, true);
		view.setUint16(at + 6, VERSION_NEEDED, true);
		view.setUint16(at + 8, UTF8_NAME_FLAG, true);
		view.setUint16(at + 10, METHOD_STORE, true);
		view.setUint16(at + 12, time, true);
		view.setUint16(at + 14, date, true);
		view.setUint32(at + 16, entry.crc, true);
		view.setUint32(at + 20, entry.bytes.length, true);
		view.setUint32(at + 24, entry.bytes.length, true);
		view.setUint16(at + 28, entry.name.length, true);
		view.setUint32(at + 42, offsets[index] ?? 0, true);
		out.set(entry.name, at + CENTRAL_HEADER_BYTES);
		at += CENTRAL_HEADER_BYTES + entry.name.length;
	});

	view.setUint32(at, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
	view.setUint16(at + 8, named.length, true);
	view.setUint16(at + 10, named.length, true);
	view.setUint32(at + 12, at - centralStart, true);
	view.setUint32(at + 16, centralStart, true);
	return out;
}
