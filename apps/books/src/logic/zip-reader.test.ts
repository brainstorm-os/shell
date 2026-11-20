import { describe, expect, it } from "vitest";
import { buildZip } from "./zip-fixture";
import { ZipMethod, firstStoredEntry, isZip, listZipEntries, readZipEntry } from "./zip-reader";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("zip-reader", () => {
	const archive = buildZip([
		{ name: "mimetype", data: "application/epub+zip" },
		{ name: "dir/Книга.fb2", data: "<FictionBook/>".repeat(200), deflate: true },
	]);

	it("recognises a ZIP by its leading signature", () => {
		expect(isZip(archive)).toBe(true);
		expect(isZip(new TextEncoder().encode("<?xml version='1.0'?>"))).toBe(false);
		expect(isZip(new Uint8Array(0))).toBe(false);
	});

	it("lists the central directory with UTF-8 names", () => {
		const entries = listZipEntries(archive);
		expect(entries.map((e) => e.name)).toEqual(["mimetype", "dir/Книга.fb2"]);
		expect(entries[0]?.method).toBe(ZipMethod.Stored);
		expect(entries[1]?.method).toBe(ZipMethod.Deflate);
	});

	it("reads the first stored entry from its local header alone", () => {
		const first = firstStoredEntry(archive);
		expect(first?.name).toBe("mimetype");
		expect(text(first?.data ?? new Uint8Array())).toBe("application/epub+zip");
	});

	it("reads a stored and a deflated entry", async () => {
		const [stored, deflated] = listZipEntries(archive);
		if (!stored || !deflated) throw new Error("fixture entries missing");
		expect(text(await readZipEntry(archive, stored))).toBe("application/epub+zip");
		expect(text(await readZipEntry(archive, deflated))).toBe("<FictionBook/>".repeat(200));
	});

	it("refuses an entry that inflates past the limit", async () => {
		const deflated = listZipEntries(archive)[1];
		if (!deflated) throw new Error("fixture entry missing");
		await expect(readZipEntry(archive, deflated, 100)).rejects.toThrow(/size limit/);
		// A header that under-reports its size is still stopped while inflating.
		await expect(readZipEntry(archive, { ...deflated, size: 1 }, 100)).rejects.toThrow(/size limit/);
	});

	it("returns nothing for truncated or non-zip input instead of throwing", () => {
		expect(listZipEntries(archive.subarray(0, 40))).toEqual([]);
		expect(listZipEntries(new Uint8Array([1, 2, 3]))).toEqual([]);
		expect(firstStoredEntry(archive.subarray(0, 20))).toBeNull();
	});

	it("rejects an entry whose data runs past the archive", async () => {
		const entry = listZipEntries(archive)[1];
		if (!entry) throw new Error("fixture entry missing");
		await expect(readZipEntry(archive, { ...entry, compressedSize: 1e9 })).rejects.toThrow(
			/out of bounds/,
		);
	});
});
