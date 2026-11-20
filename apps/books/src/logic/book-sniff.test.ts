import { describe, expect, it } from "vitest";
import { SniffedKind, sniffBookBytes } from "./book-sniff";
import { EPUB_CONTAINER_XML, buildConverterEpub, buildZip } from "./zip-fixture";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("sniffBookBytes", () => {
	it("recognises an EPUB by its stored mimetype entry", () => {
		expect(sniffBookBytes(buildConverterEpub())).toBe(SniffedKind.Epub);
	});

	it("recognises an EPUB whose mimetype entry is compressed or missing", () => {
		const compressed = buildZip([
			{ name: "mimetype", data: "application/epub+zip", deflate: true },
			{ name: "META-INF/container.xml", data: EPUB_CONTAINER_XML },
		]);
		const missing = buildZip([{ name: "META-INF/container.xml", data: EPUB_CONTAINER_XML }]);
		expect(sniffBookBytes(compressed)).toBe(SniffedKind.Epub);
		expect(sniffBookBytes(missing)).toBe(SniffedKind.Epub);
	});

	it("recognises a zipped FictionBook", () => {
		const zipped = buildZip([{ name: "Book.FB2", data: "<FictionBook/>", deflate: true }]);
		expect(sniffBookBytes(zipped)).toBe(SniffedKind.Fb2Zip);
	});

	it("reports any other archive as a plain zip", () => {
		expect(sniffBookBytes(buildZip([{ name: "photo.jpg", data: "x" }]))).toBe(SniffedKind.Zip);
	});

	it("recognises FB2 markup, with or without a prolog, in any case", () => {
		expect(
			sniffBookBytes(utf8('<?xml version="1.0" encoding="windows-1251"?>\n<FictionBook xmlns="x">')),
		).toBe(SniffedKind.Fb2);
		expect(sniffBookBytes(utf8("﻿<fictionbook>"))).toBe(SniffedKind.Fb2);
	});

	it("recognises UTF-16 FB2 by its byte-order mark", () => {
		const text = '<?xml version="1.0" encoding="utf-16"?><FictionBook>';
		const bytes = new Uint8Array(2 + text.length * 2);
		bytes[0] = 0xff;
		bytes[1] = 0xfe;
		for (let i = 0; i < text.length; i += 1) bytes[2 + i * 2] = text.charCodeAt(i);
		expect(sniffBookBytes(bytes)).toBe(SniffedKind.Fb2);
	});

	it("recognises a PDF and gives up on anything else", () => {
		expect(sniffBookBytes(utf8("%PDF-1.7\n..."))).toBe(SniffedKind.Pdf);
		expect(sniffBookBytes(utf8("just some text"))).toBe(SniffedKind.Unknown);
		expect(sniffBookBytes(new Uint8Array(0))).toBe(SniffedKind.Unknown);
	});
});
