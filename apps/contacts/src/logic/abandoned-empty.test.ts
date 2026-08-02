import { describe, expect, it } from "vitest";
import type { Person } from "../types/person";
import { isAbandonedEmpty, patchAuthorsContent, shouldDiscardAbandoned } from "./abandoned-empty";

function person(overrides: Partial<Person> = {}): Person {
	return {
		id: "p_1",
		name: "",
		emails: [],
		phones: [],
		companyId: null,
		role: "",
		birthday: null,
		anniversary: null,
		linkIds: [],
		bio: "",
		icon: null,
		cover: null,
		...overrides,
	};
}

describe("isAbandonedEmpty (F-158)", () => {
	it("is true for a freshly minted contact", () => {
		expect(isAbandonedEmpty(person())).toBe(true);
	});

	it("ignores whitespace-only bio", () => {
		expect(isAbandonedEmpty(person({ bio: "  \n " }))).toBe(true);
	});

	it.each<[string, Partial<Person>]>([
		["name", { name: "Alice" }],
		["email", { emails: ["a@b.co"] }],
		["phone", { phones: ["+1 555"] }],
		["company", { companyId: "co_1" }],
		["role", { role: "CTO" }],
		["birthday", { birthday: 642643200000 }],
		["anniversary", { anniversary: 642643200000 }],
		["related link", { linkIds: ["p_2"] }],
		["bio", { bio: "met at the conf" }],
	])("is false once %s is authored", (_field, overrides) => {
		expect(isAbandonedEmpty(person(overrides))).toBe(false);
	});
});

describe("shouldDiscardAbandoned (F-158 ghost prevention)", () => {
	const session = new Set(["p_1"]);

	it("discards a session-created, still-empty contact", () => {
		expect(shouldDiscardAbandoned("p_1", session, [person()])).toBe(true);
	});

	it("never discards a contact not created this session", () => {
		expect(shouldDiscardAbandoned("p_1", new Set(), [person()])).toBe(false);
	});

	it("never discards authored content", () => {
		expect(shouldDiscardAbandoned("p_1", session, [person({ name: "Alice" })])).toBe(false);
	});

	it("no-ops on the list route and on a missing person", () => {
		expect(shouldDiscardAbandoned(null, session, [person()])).toBe(false);
		expect(shouldDiscardAbandoned("p_missing", session, [person()])).toBe(false);
	});
});

describe("patchAuthorsContent", () => {
	it("treats clearing patches as non-authoring", () => {
		expect(patchAuthorsContent({ name: "" })).toBe(false);
		expect(patchAuthorsContent({ role: "  " })).toBe(false);
		expect(patchAuthorsContent({ email: [] })).toBe(false);
		expect(patchAuthorsContent({ birthday: null })).toBe(false);
		expect(patchAuthorsContent({ company: null })).toBe(false);
		expect(patchAuthorsContent({ email: [""], links: [] })).toBe(false);
	});

	it("detects real content of every value shape", () => {
		expect(patchAuthorsContent({ name: "Alice" })).toBe(true);
		expect(patchAuthorsContent({ email: ["a@b.co"] })).toBe(true);
		expect(patchAuthorsContent({ birthday: 642643200000 })).toBe(true);
		expect(patchAuthorsContent({ company: "co_1" })).toBe(true);
		expect(patchAuthorsContent({ name: "", role: "CTO" })).toBe(true);
		expect(patchAuthorsContent({ custom: { anything: true } })).toBe(true);
	});
});
