import { describe, expect, it } from "vitest";
import type { HistoryVisit } from "./history";
import { START_PAGE_SITE_LIMIT, siteHost, siteMonogram, startPageSites } from "./start-page";

function visit(url: string, visitCount: number, lastVisitedAt: number): HistoryVisit {
	return { url, title: "", visitCount, lastVisitedAt };
}

describe("startPageSites", () => {
	it("ranks by visit count, recency breaking ties, capped", () => {
		const visits = [
			visit("https://a.example/", 1, 300),
			visit("https://b.example/", 5, 100),
			visit("https://c.example/", 5, 200),
			visit("https://d.example/", 2, 50),
		];
		const ranked = startPageSites(visits);
		expect(ranked.map((v) => v.url)).toEqual([
			"https://c.example/",
			"https://b.example/",
			"https://d.example/",
			"https://a.example/",
		]);
		// Input untouched (pure).
		expect(visits[0]?.url).toBe("https://a.example/");
	});

	it("caps at the limit", () => {
		const many = Array.from({ length: 20 }, (_, i) => visit(`https://s${i}.example/`, i, i));
		expect(startPageSites(many)).toHaveLength(START_PAGE_SITE_LIMIT);
		expect(startPageSites(many, 3)).toHaveLength(3);
	});
});

describe("siteHost / siteMonogram", () => {
	it("strips scheme and www., uppercases the monogram", () => {
		expect(siteHost("https://www.example.com/path")).toBe("example.com");
		expect(siteMonogram("https://www.example.com/path")).toBe("E");
	});

	it("falls back for unparsable URLs", () => {
		expect(siteHost("not a url")).toBe("");
		expect(siteMonogram("not a url")).toBe("N");
	});
});
