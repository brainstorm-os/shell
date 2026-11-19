import { describe, expect, it } from "vitest";
import { crc32, isSafeArchivePath, zipStore } from "./zip";

const bytes = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array) => new TextDecoder().decode(data);

/** Read an archive back through its central directory, the way an unzip
 *  tool does, checking every signature, size and checksum on the way. */
function readArchive(archive: Uint8Array): Array<{ path: string; text: string }> {
	const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
	const end = archive.length - 22;
	expect(view.getUint32(end, true)).toBe(0x06054b50);
	const count = view.getUint16(end + 10, true);
	expect(view.getUint16(end + 8, true)).toBe(count);
	const centralSize = view.getUint32(end + 12, true);
	let at = view.getUint32(end + 16, true);
	expect(at + centralSize).toBe(end);
	const out: Array<{ path: string; text: string }> = [];
	for (let n = 0; n < count; n += 1) {
		expect(view.getUint32(at, true)).toBe(0x02014b50);
		expect(view.getUint16(at + 8, true) & 0x0800).toBe(0x0800);
		expect(view.getUint16(at + 10, true)).toBe(0);
		const crc = view.getUint32(at + 16, true);
		const size = view.getUint32(at + 20, true);
		expect(view.getUint32(at + 24, true)).toBe(size);
		const nameLength = view.getUint16(at + 28, true);
		const local = view.getUint32(at + 42, true);
		const path = decode(archive.subarray(at + 46, at + 46 + nameLength));
		expect(view.getUint32(local, true)).toBe(0x04034b50);
		expect(view.getUint32(local + 14, true)).toBe(crc);
		expect(view.getUint32(local + 18, true)).toBe(size);
		const localNameLength = view.getUint16(local + 26, true);
		expect(decode(archive.subarray(local + 30, local + 30 + localNameLength))).toBe(path);
		const dataStart = local + 30 + localNameLength + view.getUint16(local + 28, true);
		const data = archive.subarray(dataStart, dataStart + size);
		expect(crc32(data)).toBe(crc);
		out.push({ path, text: decode(data) });
		at += 46 + nameLength;
	}
	expect(at).toBe(end);
	return out;
}

describe("crc32", () => {
	it("matches the standard check value", () => {
		expect(crc32(bytes("123456789"))).toBe(0xcbf43926);
		expect(crc32(new Uint8Array())).toBe(0);
	});
});

describe("zipStore", () => {
	it("round-trips entries, including an empty file and a non-ASCII name", () => {
		const archive = zipStore(
			[
				{ path: "index.html", bytes: bytes("<p>home</p>") },
				{ path: "assets/1.png", bytes: new Uint8Array() },
				{ path: "über.html", bytes: bytes("ü") },
			],
			{ modifiedAt: new Date(2026, 10, 19, 12, 30, 10) },
		);
		expect(readArchive(archive)).toEqual([
			{ path: "index.html", text: "<p>home</p>" },
			{ path: "assets/1.png", text: "" },
			{ path: "über.html", text: "ü" },
		]);
	});

	it("is byte-for-byte reproducible for a fixed timestamp", () => {
		const entries = [{ path: "a.html", bytes: bytes("a") }];
		const at = { modifiedAt: new Date(2026, 0, 2, 3, 4, 6) };
		expect(zipStore(entries, at)).toEqual(zipStore(entries, at));
	});

	it("writes a valid empty archive", () => {
		expect(readArchive(zipStore([]))).toEqual([]);
	});

	it.each([
		"../evil.html",
		"a/../../evil.html",
		"/etc/passwd",
		"a//b.html",
		"./a.html",
		"a/./b.html",
		"..",
		"",
		"a\\..\\b.html",
		"C:/Windows/x.html",
		"a\u0000.html",
		"a\n.html",
		"dir/",
	])("refuses the unsafe entry path %j", (path) => {
		expect(isSafeArchivePath(path)).toBe(false);
		expect(() => zipStore([{ path, bytes: bytes("x") }])).toThrow(/unsafe entry path/);
	});

	it("refuses two entries that are the same file on a case-folding disk", () => {
		const twice = [
			{ path: "Page.html", bytes: bytes("1") },
			{ path: "page.html", bytes: bytes("2") },
		];
		expect(() => zipStore(twice)).toThrow(/duplicate entry path/);
	});
});
