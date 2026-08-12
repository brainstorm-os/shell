import { describe, expect, it } from "vitest";
import { entityTitleOr, hasEntityTitle, pathLeaf, resolveEntityTitle } from "./entity-title";

describe("resolveEntityTitle", () => {
	it("prefers title over every other key", () => {
		expect(
			resolveEntityTitle({ title: "Thesis", name: "n", displayName: "d", label: "l", path: "p" }),
		).toBe("Thesis");
	});

	it("falls through the chain title → name → displayName → label → path leaf", () => {
		expect(resolveEntityTitle({ name: "invoice.pdf", displayName: "d", label: "l" })).toBe(
			"invoice.pdf",
		);
		// `brainstorm/Profile/v1` carries ONLY displayName.
		expect(resolveEntityTitle({ displayName: "Mira", label: "l" })).toBe("Mira");
		expect(resolveEntityTitle({ label: "Weekly digest" })).toBe("Weekly digest");
		// `brainstorm/CodeFile/v1` carries ONLY path.
		expect(resolveEntityTitle({ path: "src/lib/main.ts" })).toBe("main.ts");
		expect(resolveEntityTitle({ path: "readme.md" })).toBe("readme.md");
	});

	it("skips blank and whitespace-only values instead of painting an empty label", () => {
		expect(resolveEntityTitle({ title: "", name: "Ada" })).toBe("Ada");
		expect(resolveEntityTitle({ title: "   ", name: "", displayName: "Ada" })).toBe("Ada");
		expect(resolveEntityTitle({ title: "  Thesis  " })).toBe("Thesis");
	});

	it("ignores non-string values", () => {
		expect(resolveEntityTitle({ title: 42, name: { rich: true }, label: null })).toBeNull();
	});

	it("returns null for a nameless bag, and for no bag at all", () => {
		expect(resolveEntityTitle({})).toBeNull();
		expect(resolveEntityTitle(null)).toBeNull();
		expect(resolveEntityTitle(undefined)).toBeNull();
	});
});

describe("entityTitleOr / hasEntityTitle", () => {
	it("leaves the nameless fallback to the caller", () => {
		expect(entityTitleOr({ title: "Thesis" }, "ent_1")).toBe("Thesis");
		expect(entityTitleOr({}, "ent_1")).toBe("ent_1");
	});

	it("reports whether a real title exists, independent of what is painted", () => {
		expect(hasEntityTitle({ path: "a/b.ts" })).toBe(true);
		expect(hasEntityTitle({ title: "   " })).toBe(false);
	});
});

describe("pathLeaf", () => {
	it("takes the last non-empty segment", () => {
		expect(pathLeaf("a/b/c.ts")).toBe("c.ts");
		expect(pathLeaf("/a/")).toBe("a");
		expect(pathLeaf("solo")).toBe("solo");
		expect(pathLeaf("/")).toBe("/");
	});
});
