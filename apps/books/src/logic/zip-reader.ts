/**
 * A read-only ZIP reader, just large enough to (a) tell an EPUB from any
 * other archive and (b) pull the one `.fb2` out of a `.fb2.zip`. EPUB
 * archives are still parsed by epub.js; this never replaces it.
 *
 * Inflation goes through the platform `DecompressionStream`, so there is no
 * zip dependency in the app's module graph. Every read is bounds-checked and
 * the inflated size is capped: the archive is untrusted input.
 */

export enum ZipMethod {
	Stored = 0,
	Deflate = 8,
}

export type ZipEntry = {
	name: string;
	method: number;
	compressedSize: number;
	size: number;
	/** Offset of the entry's LOCAL header from the start of the archive. */
	localOffset: number;
};

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const END_MIN_LENGTH = 22;
const END_MAX_COMMENT = 0xffff;
const LOCAL_HEADER_LENGTH = 30;
const CENTRAL_HEADER_LENGTH = 46;
const UTF8_NAME_FLAG = 0x0800;
const MAX_ENTRIES = 20_000;

/** A book's text never legitimately needs more than this once inflated; an
 *  archive that claims (or produces) more is refused rather than buffered. */
export const MAX_INFLATED_BYTES = 128 * 1024 * 1024;

function view(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** True when the bytes open with a ZIP local-file header. */
export function isZip(bytes: Uint8Array): boolean {
	return bytes.byteLength >= 4 && view(bytes).getUint32(0, true) === LOCAL_SIGNATURE;
}

function decodeName(raw: Uint8Array, utf8: boolean): string {
	if (utf8) return new TextDecoder("utf-8").decode(raw);
	let out = "";
	for (const byte of raw) out += String.fromCharCode(byte);
	return out;
}

function findEndRecord(bytes: Uint8Array): number {
	const dv = view(bytes);
	const floor = Math.max(0, bytes.byteLength - END_MIN_LENGTH - END_MAX_COMMENT);
	for (let at = bytes.byteLength - END_MIN_LENGTH; at >= floor; at -= 1) {
		if (dv.getUint32(at, true) === END_SIGNATURE) return at;
	}
	return -1;
}

/** The archive's central directory, in stored order. Returns `[]` for
 *  anything that is not a readable (non-ZIP64) archive. */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
	if (!isZip(bytes)) return [];
	const end = findEndRecord(bytes);
	if (end < 0) return [];
	const dv = view(bytes);
	const count = Math.min(dv.getUint16(end + 10, true), MAX_ENTRIES);
	let at = dv.getUint32(end + 16, true);
	const entries: ZipEntry[] = [];
	for (let i = 0; i < count; i += 1) {
		if (at + CENTRAL_HEADER_LENGTH > bytes.byteLength) break;
		if (dv.getUint32(at, true) !== CENTRAL_SIGNATURE) break;
		const flags = dv.getUint16(at + 8, true);
		const nameLength = dv.getUint16(at + 28, true);
		const extraLength = dv.getUint16(at + 30, true);
		const commentLength = dv.getUint16(at + 32, true);
		const nameStart = at + CENTRAL_HEADER_LENGTH;
		if (nameStart + nameLength > bytes.byteLength) break;
		entries.push({
			name: decodeName(
				bytes.subarray(nameStart, nameStart + nameLength),
				(flags & UTF8_NAME_FLAG) !== 0,
			),
			method: dv.getUint16(at + 10, true),
			compressedSize: dv.getUint32(at + 20, true),
			size: dv.getUint32(at + 24, true),
			localOffset: dv.getUint32(at + 42, true),
		});
		at = nameStart + nameLength + extraLength + commentLength;
	}
	return entries;
}

/** The first entry's name + raw payload, read from its LOCAL header alone —
 *  the EPUB `mimetype` check, which must work on the leading bytes without
 *  trusting the central directory. `null` when the archive does not start
 *  with a stored entry whose sizes are in the header. */
export function firstStoredEntry(bytes: Uint8Array): { name: string; data: Uint8Array } | null {
	if (!isZip(bytes) || bytes.byteLength < LOCAL_HEADER_LENGTH) return null;
	const dv = view(bytes);
	if (dv.getUint16(8, true) !== ZipMethod.Stored) return null;
	const flags = dv.getUint16(6, true);
	const size = dv.getUint32(18, true);
	const nameLength = dv.getUint16(26, true);
	const extraLength = dv.getUint16(28, true);
	const dataStart = LOCAL_HEADER_LENGTH + nameLength + extraLength;
	if (dataStart + size > bytes.byteLength) return null;
	return {
		name: decodeName(
			bytes.subarray(LOCAL_HEADER_LENGTH, LOCAL_HEADER_LENGTH + nameLength),
			(flags & UTF8_NAME_FLAG) !== 0,
		),
		data: bytes.subarray(dataStart, dataStart + size),
	};
}

async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
	if (typeof DecompressionStream === "undefined") {
		throw new Error("this runtime cannot inflate a zip entry");
	}
	const copy = new Uint8Array(data.byteLength);
	copy.set(data);
	const inflater = new DecompressionStream("deflate-raw");
	// Fed through the writable side directly (no `Blob#stream`, which not
	// every DOM has). A corrupt stream fails the read below; the write's own
	// rejection is the same error and must not surface as unhandled.
	const writer = inflater.writable.getWriter();
	void writer
		.write(copy)
		.then(() => writer.close())
		.catch(() => {});
	const reader = inflater.readable.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			throw new Error("zip entry inflates past the size limit");
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let cursor = 0;
	for (const chunk of chunks) {
		out.set(chunk, cursor);
		cursor += chunk.byteLength;
	}
	return out;
}

/** Read one entry's bytes (stored or deflated). Throws on an encrypted /
 *  exotic method, an out-of-bounds entry, or an inflated size past `limit`. */
export async function readZipEntry(
	bytes: Uint8Array,
	entry: ZipEntry,
	limit: number = MAX_INFLATED_BYTES,
): Promise<Uint8Array> {
	const dv = view(bytes);
	const at = entry.localOffset;
	if (at + LOCAL_HEADER_LENGTH > bytes.byteLength || dv.getUint32(at, true) !== LOCAL_SIGNATURE) {
		throw new Error("zip entry header is out of bounds");
	}
	const dataStart =
		at + LOCAL_HEADER_LENGTH + dv.getUint16(at + 26, true) + dv.getUint16(at + 28, true);
	const dataEnd = dataStart + entry.compressedSize;
	if (dataEnd > bytes.byteLength) throw new Error("zip entry data is out of bounds");
	if (entry.size > limit) throw new Error("zip entry is larger than the size limit");
	const data = bytes.subarray(dataStart, dataEnd);
	if (entry.method === ZipMethod.Stored) return data;
	if (entry.method === ZipMethod.Deflate) return inflateRaw(data, limit);
	throw new Error(`unsupported zip compression method ${entry.method}`);
}
