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

	it("names an Email by its subject — after every title-shaped key, before the path leaf", () => {
		// `brainstorm/Email/v1` stores its label in `subject` and nothing else,
		// so every synced message read "(untitled)" in Files / Database / Graph.
		expect(resolveEntityTitle({ subject: "Quarterly numbers", messageId: "<1@x>" })).toBe(
			"Quarterly numbers",
		);
		expect(resolveEntityTitle({ label: "Pinned", subject: "s" })).toBe("Pinned");
		expect(resolveEntityTitle({ subject: "s", path: "INBOX/1" })).toBe("s");
		expect(resolveEntityTitle({ subject: "  Re: lunch  " })).toBe("Re: lunch");
		// A message with no subject stays nameless — the caller's untitled
		// fallback applies, same as every other nameless object.
		expect(resolveEntityTitle({ subject: "   ", messageId: "<1@x>" })).toBeNull();
		expect(hasEntityTitle({ subject: "" })).toBe(false);
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
