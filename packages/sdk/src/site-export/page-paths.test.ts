import { describe, expect, it } from "vitest";
import { planPagePaths, slugify } from "./page-paths";
import { isSafeArchivePath } from "./zip";

describe("slugify", () => {
	it("kebab-cases a title and folds accents", () => {
		expect(slugify("  Hello, World!  ")).toBe("hello-world");
		expect(slugify("Über Café")).toBe("uber-cafe");
	});

	it("falls back when nothing usable is left", () => {
		expect(slugify("")).toBe("page");
		expect(slugify("日本語")).toBe("page");
		expect(slugify("../..")).toBe("page");
	});

	it("keeps clear of the site's own files and Windows device names", () => {
		for (const reserved of ["index", "Styles", "assets", "CON", "nul", "com1", "LPT9"]) {
			expect(slugify(reserved)).toBe(`${reserved.toLowerCase()}-page`);
		}
	});

	it("caps the length without leaving a trailing dash", () => {
		const slug = slugify(`${"a".repeat(59)} b c d`);
		expect(slug).toBe("a".repeat(59));
	});

	it.each([
		"../../etc/passwd",
		"..\\..\\Windows\\System32",
		"/absolute/path",
		"C:\\Users\\me",
		"a/b/c",
		"name\u0000.html",
		"%2e%2e%2fsecret",
		"..%2F..%2F",
		"．．／fullwidth",
		"a\u202eb",
		'"><script>alert(1)</script>',
		".htaccess",
		"page.html.exe",
	])("reduces the hostile title %j to plain letters, digits and dashes", (title) => {
		expect(slugify(title)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
	});
});

describe("planPagePaths", () => {
	it("puts the home page at index.html and the rest at their slugs", () => {
		const paths = planPagePaths(
			[
				{ id: "h", title: "Welcome" },
				{ id: "a", title: "About us" },
			],
			"h",
		);
		expect([...paths]).toEqual([
			["h", "index.html"],
			["a", "about-us.html"],
		]);
	});

	it("numbers colliding titles apart, including a collision with a numbered one", () => {
		const paths = planPagePaths(
			[
				{ id: "h", title: "Home" },
				{ id: "1", title: "Notes" },
				{ id: "2", title: "notes" },
				{ id: "3", title: "Notes!" },
				{ id: "4", title: "Notes 2" },
				{ id: "5", title: "" },
				{ id: "6", title: "???" },
			],
			"h",
		);
		expect([...paths.values()]).toEqual([
			"index.html",
			"notes.html",
			"notes-2.html",
			"notes-3.html",
			"notes-2-2.html",
			"page.html",
			"page-2.html",
		]);
		expect(new Set(paths.values()).size).toBe(paths.size);
	});

	it("never lets a page titled like the home file take index.html", () => {
		const paths = planPagePaths(
			[
				{ id: "h", title: "Home" },
				{ id: "x", title: "index" },
				{ id: "y", title: "INDEX" },
			],
			"h",
		);
		expect(paths.get("x")).toBe("index-page.html");
		expect(paths.get("y")).toBe("index-page-2.html");
	});

	it("only ever plans a safe, flat file name", () => {
		const hostile = ["../x", "/x", "a/b", "..", "\\\\server\\share", "x\u0000y", "con", "."];
		const paths = planPagePaths(
			hostile.map((title, index) => ({ id: String(index), title })),
			"none",
		);
		for (const path of paths.values()) {
			expect(path).toMatch(/^[a-z0-9-]+\.html$/);
			expect(isSafeArchivePath(path)).toBe(true);
		}
		expect(new Set(paths.values()).size).toBe(hostile.length);
	});
});
