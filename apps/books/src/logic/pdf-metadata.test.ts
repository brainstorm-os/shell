import { CoverKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	coverPropertyValue,
	pdfAuthorEnrichment,
	pdfEnrichmentPatch,
	pdfTitleEnrichment,
} from "./pdf-metadata";

describe("pdfAuthorEnrichment", () => {
	it("fills an empty author from the document's Author field", () => {
		expect(pdfAuthorEnrichment({ Author: "J. R. R. Tolkien" }, "")).toBe("J. R. R. Tolkien");
	});

	it("trims surrounding whitespace", () => {
		expect(pdfAuthorEnrichment({ Author: "  Ursula K. Le Guin  " }, "")).toBe("Ursula K. Le Guin");
	});

	it("never clobbers an author the user already set", () => {
		expect(pdfAuthorEnrichment({ Author: "Embedded Name" }, "My Author")).toBeNull();
	});

	it("returns null when the document carries no usable author", () => {
		expect(pdfAuthorEnrichment({}, "")).toBeNull();
		expect(pdfAuthorEnrichment({ Author: "   " }, "")).toBeNull();
		expect(pdfAuthorEnrichment(null, "")).toBeNull();
		expect(pdfAuthorEnrichment({ Author: 42 }, "")).toBeNull();
	});
});

describe("pdfTitleEnrichment", () => {
	it("offers the embedded Title when the name is still the filename stem", () => {
		expect(pdfTitleEnrichment({ Title: "The Lord of the Rings" }, "lotr-02", "lotr-02")).toBe(
			"The Lord of the Rings",
		);
	});

	it("offers the embedded Title when the name is empty", () => {
		expect(pdfTitleEnrichment({ Title: "Dune" }, "", "")).toBe("Dune");
	});

	it("never overrides a user rename", () => {
		expect(pdfTitleEnrichment({ Title: "Embedded" }, "My Title", "filename")).toBeNull();
	});

	it("returns null when the embedded title matches the current name", () => {
		expect(pdfTitleEnrichment({ Title: "Same" }, "Same", "Same")).toBeNull();
	});

	it("returns null with no embedded title", () => {
		expect(pdfTitleEnrichment({}, "stem", "stem")).toBeNull();
		expect(pdfTitleEnrichment(null, "stem", "stem")).toBeNull();
	});
});

describe("coverPropertyValue", () => {
	it("wraps a URL as an image cover", () => {
		expect(coverPropertyValue("brainstorm://cover/abc")).toEqual({
			kind: CoverKind.Image,
			value: "brainstorm://cover/abc",
		});
	});
});

describe("pdfEnrichmentPatch", () => {
	const base = {
		currentAuthor: "",
		currentName: "lotr-02",
		fromFilename: "lotr-02",
		hasCover: false,
		coverUrl: null as string | null,
	};

	it("assembles author + title + cover when all are fresh", () => {
		const patch = pdfEnrichmentPatch(
			{ Author: "Tolkien", Title: "The Lord of the Rings" },
			{ ...base, coverUrl: "brainstorm://cover/x" },
		);
		expect(patch).toEqual({
			author: "Tolkien",
			name: "The Lord of the Rings",
			cover: { kind: CoverKind.Image, value: "brainstorm://cover/x" },
		});
	});

	it("omits the cover when one already exists", () => {
		const patch = pdfEnrichmentPatch(
			{ Author: "Tolkien" },
			{ ...base, hasCover: true, coverUrl: "brainstorm://cover/x" },
		);
		expect(patch).toEqual({ author: "Tolkien" });
		expect(patch.cover).toBeUndefined();
	});

	it("omits the cover when none was rendered", () => {
		const patch = pdfEnrichmentPatch({ Author: "Tolkien" }, base);
		expect(patch.cover).toBeUndefined();
	});

	it("is empty when nothing needs backfilling", () => {
		const patch = pdfEnrichmentPatch(
			{ Author: "Embedded", Title: "Embedded Title" },
			{ ...base, currentAuthor: "User", currentName: "User Title", hasCover: true },
		);
		expect(Object.keys(patch)).toHaveLength(0);
	});
});
