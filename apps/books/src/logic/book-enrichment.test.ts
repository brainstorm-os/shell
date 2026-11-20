import { describe, expect, it } from "vitest";
import { isFilenameTitle, reflowEnrichmentPatch } from "./book-enrichment";

const FILE = "King_Chetyre-posle-polunochi_3_Bibliotechnaya-policiya.159046.fb2.epub";
const META = { title: "Библиотечная полиция", author: "Стивен Кинг" };

const facts = (over: Partial<Parameters<typeof reflowEnrichmentPatch>[1]> = {}) => ({
	currentName: "King_Chetyre-posle-polunochi_3_Bibliotechnaya-policiya.159046",
	currentAuthor: "",
	fileName: FILE,
	hasCover: false,
	coverUrl: null,
	...over,
});

describe("isFilenameTitle", () => {
	it("recognises today's title and the one older builds derived", () => {
		expect(
			isFilenameTitle("King_Chetyre-posle-polunochi_3_Bibliotechnaya-policiya.159046", FILE),
		).toBe(true);
		// The name an existing vault row carries: only `.epub` was stripped.
		expect(
			isFilenameTitle("King_Chetyre-posle-polunochi_3_Bibliotechnaya-policiya.159046.fb2", FILE),
		).toBe(true);
		expect(isFilenameTitle(FILE, FILE)).toBe(true);
		expect(isFilenameTitle("", FILE)).toBe(true);
	});

	it("treats anything else as the user's own name", () => {
		expect(isFilenameTitle("The Library Policeman", FILE)).toBe(false);
	});
});

describe("reflowEnrichmentPatch", () => {
	it("backfills title and author over a filename-derived record", () => {
		expect(reflowEnrichmentPatch(META, facts())).toEqual({
			name: "Библиотечная полиция",
			author: "Стивен Кинг",
		});
	});

	it("heals the title of a book imported by an older build", () => {
		const legacy = "King_Chetyre-posle-polunochi_3_Bibliotechnaya-policiya.159046.fb2";
		expect(reflowEnrichmentPatch(META, facts({ currentName: legacy })).name).toBe(
			"Библиотечная полиция",
		);
	});

	it("never overwrites a name or an author the user set", () => {
		expect(
			reflowEnrichmentPatch(META, facts({ currentName: "My copy", currentAuthor: "S. King" })),
		).toEqual({});
	});

	it("never copies the untitled placeholder or an empty title", () => {
		expect(reflowEnrichmentPatch({ title: "Untitled", author: "" }, facts())).toEqual({});
		expect(reflowEnrichmentPatch({ title: "  ", author: "" }, facts())).toEqual({});
	});

	it("adds a cover only to a book without one", () => {
		const url = "brainstorm://cover/abc";
		expect(reflowEnrichmentPatch({ title: "", author: "" }, facts({ coverUrl: url })).cover).toEqual({
			kind: "image",
			value: url,
		});
		expect(
			reflowEnrichmentPatch({ title: "", author: "" }, facts({ coverUrl: url, hasCover: true })),
		).toEqual({});
	});
});
