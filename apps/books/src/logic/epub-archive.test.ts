// @vitest-environment jsdom
/** parseEpub over REAL archive bytes (real epub.js, no mock) — the glue that
 *  was previously only ever exercised by hand in the shell. */
import { describe, expect, it } from "vitest";
import { parseEpub } from "./epub-parser";
import { EPUB_CONTAINER_XML, buildConverterEpub, buildZip, epubPackage } from "./zip-fixture";

function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<"settled" | "pending"> {
	return Promise.race([
		promise.then(
			() => "settled" as const,
			() => "settled" as const,
		),
		new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
	]);
}

describe("parseEpub over a real archive", () => {
	it("reads an FB2→EPUB conversion: metadata, NCX titles, class-marked headings", async () => {
		const content = await parseEpub(buildConverterEpub());
		expect(content.title).toBe("Библиотечная полиция");
		expect(content.author).toBe("Стивен Кинг");
		expect(content.spine.map((s) => s.title)).toEqual(["Глава 1", "ГЛАВА ВТОРАЯ"]);
		expect(content.spine[1]?.blocks.map((b) => b.text)).toEqual(["ГЛАВА ВТОРАЯ", "Второй текст."]);
	});

	it("opens a book whose OPF names an NCX the archive does not contain", async () => {
		const bytes = buildZip([
			{ name: "mimetype", data: "application/epub+zip" },
			{ name: "META-INF/container.xml", data: EPUB_CONTAINER_XML },
			{ name: "OEBPS/content.opf", data: epubPackage() },
			{ name: "OEBPS/ch1.xhtml", data: "<html><body><h1>One</h1><p>Text.</p></body></html>" },
		]);
		const attempt = parseEpub(bytes);
		expect(await settlesWithin(attempt, 5000)).toBe("settled");
		expect((await attempt).spine[0]?.blocks.map((b) => b.text)).toEqual(["One", "Text."]);
	});

	it("keeps the whole chapter when its XHTML is not well-formed XML", async () => {
		const chapter = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title/></head><body><h1>One</h1><p>Before&nbsp;the entity.</p><p>After it & onwards.</p></body></html>`;
		const bytes = buildZip([
			{ name: "mimetype", data: "application/epub+zip" },
			{ name: "META-INF/container.xml", data: EPUB_CONTAINER_XML },
			{ name: "OEBPS/content.opf", data: epubPackage() },
			{
				name: "OEBPS/toc.ncx",
				data: "<ncx xmlns='http://www.daisy.org/z3986/2005/ncx/'><navMap/></ncx>",
			},
			{ name: "OEBPS/ch1.xhtml", data: chapter },
		]);
		const content = await parseEpub(bytes);
		expect(content.spine[0]?.blocks.map((b) => b.text)).toEqual([
			"One",
			"Before the entity.",
			"After it & onwards.",
		]);
	});

	it("REJECTS a zip that is not an EPUB instead of never settling", async () => {
		const notEpub = buildZip([{ name: "readme.txt", data: "hello" }]);
		const attempt = parseEpub(notEpub);
		expect(await settlesWithin(attempt, 3000)).toBe("settled");
		await expect(attempt).rejects.toThrow();
	});
});
