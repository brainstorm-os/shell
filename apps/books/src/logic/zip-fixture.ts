/** Test-only: build a small ZIP archive in memory, so the sniffing, unzip and
 *  EPUB-open tests run against real archive bytes without a zip dependency. */

import { deflateRawSync } from "node:zlib";
import { ZipMethod } from "./zip-reader";

export type FixtureEntry = {
	name: string;
	data: string | Uint8Array;
	/** Deflate the entry (default: stored). */
	deflate?: boolean;
};

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

export function buildZip(entries: readonly FixtureEntry[]): Uint8Array {
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = encoder.encode(entry.name);
		const raw = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
		const payload = entry.deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
		const method = entry.deflate ? ZipMethod.Deflate : ZipMethod.Stored;
		const crc = crc32(raw);

		const local = new Uint8Array(30 + name.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(6, 0x0800, true);
		lv.setUint16(8, method, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, payload.length, true);
		lv.setUint32(22, raw.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);

		const header = new Uint8Array(46 + name.length);
		const cv = new DataView(header.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, method, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, payload.length, true);
		cv.setUint32(24, raw.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		header.set(name, 46);

		parts.push(local, payload);
		central.push(header);
		offset += local.length + payload.length;
	}
	const centralSize = central.reduce((sum, part) => sum + part.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, offset, true);

	const all = [...parts, ...central, end];
	const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
	let cursor = 0;
	for (const part of all) {
		out.set(part, cursor);
		cursor += part.length;
	}
	return out;
}

export const EPUB_CONTAINER_XML = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

/** A one-chapter OPF (`ch1.xhtml`) that declares an NCX at `toc.ncx`. */
export function epubPackage(): string {
	return `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title><dc:identifier id="id">x</dc:identifier></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="c1"/></spine></package>`;
}

function chapterXhtml(heading: string, text: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><div class="title2">${heading}</div><p>${text}</p></body></html>`;
}

/** A two-chapter EPUB in the shape an FB2→EPUB converter writes: an NCX, and
 *  chapter headings as `<div class="title2">` rather than `<h1>`. */
export function buildConverterEpub(): Uint8Array {
	return buildZip([
		{ name: "mimetype", data: "application/epub+zip" },
		{ name: "META-INF/container.xml", data: EPUB_CONTAINER_XML, deflate: true },
		{
			name: "OEBPS/content.opf",
			deflate: true,
			data: `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Библиотечная полиция</dc:title><dc:creator>Стивен Кинг</dc:creator><dc:language>ru</dc:language><dc:identifier id="id">x</dc:identifier></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
		},
		{
			name: "OEBPS/toc.ncx",
			deflate: true,
			data: `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>t</text></docTitle><navMap><navPoint id="n1" playOrder="1"><navLabel><text>Глава 1</text></navLabel><content src="ch1.xhtml"/></navPoint></navMap></ncx>`,
		},
		{ name: "OEBPS/ch1.xhtml", deflate: true, data: chapterXhtml("ГЛАВА ПЕРВАЯ", "Первый текст.") },
		{ name: "OEBPS/ch2.xhtml", deflate: true, data: chapterXhtml("ГЛАВА ВТОРАЯ", "Второй текст.") },
	]);
}
