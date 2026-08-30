/** EPUB navigation matching — nav labels are the book's own chapter titles,
 *  and producers disagree about how they spell an href. */
import { describe, expect, it } from "vitest";
import { navigationTitles, normalizeHref, titleForHref } from "./epub-nav";

describe("normalizeHref", () => {
	it("strips fragments, leading ./ or /, and percent-encoding", () => {
		expect(normalizeHref("./content_1.html#ch1")).toBe("content_1.html");
		expect(normalizeHref("/OEBPS/content_1.html")).toBe("OEBPS/content_1.html");
		expect(normalizeHref("text/%D0%B3%D0%BB%D0%B0%D0%B2%D0%B0.html")).toBe("text/глава.html");
	});

	it("survives a malformed percent-escape rather than throwing", () => {
		expect(normalizeHref("a%zz.html")).toBe("a%zz.html");
	});
});

describe("navigationTitles", () => {
	it("indexes an entry under both its path and its bare filename", () => {
		const titles = navigationTitles([{ href: "text/ch1.html", label: "One" }]);
		expect(titleForHref(titles, "text/ch1.html")).toBe("One");
		expect(titleForHref(titles, "ch1.html")).toBe("One");
	});

	it("collapses whitespace in the label", () => {
		const titles = navigationTitles([{ href: "a.html", label: "  ГЛАВА    ПЕРВАЯ  " }]);
		expect(titleForHref(titles, "a.html")).toBe("ГЛАВА ПЕРВАЯ");
	});

	it("matches a spine href against a nav entry that carries a fragment", () => {
		const titles = navigationTitles([{ href: "ch1.html#start", label: "One" }]);
		expect(titleForHref(titles, "ch1.html")).toBe("One");
	});

	it("walks nested subitems", () => {
		const titles = navigationTitles([
			{ href: "part1.html", label: "Part One", subitems: [{ href: "ch2.html", label: "Two" }] },
		]);
		expect(titleForHref(titles, "ch2.html")).toBe("Two");
	});

	// Several nav entries commonly point into one file with different
	// fragments; the chapter's own top-level label must win over a sub-heading.
	it("lets the first entry for a file win", () => {
		const titles = navigationTitles([
			{ href: "ch1.html", label: "Chapter" },
			{ href: "ch1.html#s2", label: "A subsection" },
		]);
		expect(titleForHref(titles, "ch1.html")).toBe("Chapter");
	});

	it("ignores entries with no label or no href", () => {
		const titles = navigationTitles([{ href: "a.html" }, { label: "orphan" }]);
		expect(titleForHref(titles, "a.html")).toBe("");
	});

	it("returns empty for an uncovered section (a cover page, or no nav doc)", () => {
		expect(titleForHref(navigationTitles([]), "cover.html")).toBe("");
		expect(titleForHref(navigationTitles([]), undefined)).toBe("");
	});
});
