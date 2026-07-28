import { describe, expect, it } from "vitest";
import type { VaultEntityLike } from "../types/person";
import {
	CONTACTS_GROUPINGS,
	CONTACTS_SORTINGS,
	ContactsGrouping,
	ContactsSorting,
	type PersonViewResolvers,
	buildEntityNameIndex,
	comparePersons,
	comparePersonsBy,
	entityToPerson,
	filterPersons,
	groupByLetter,
	groupPersons,
	personInitials,
	personsFromEntities,
	refToId,
	refsToIds,
	resolveName,
	toStringArray,
} from "./person-view";

const OTHER = "#";
const BUCKETS = { otherLetter: OTHER, noCompany: "No company", noRole: "No role" };

function person(id: string, name: string, over: Record<string, unknown> = {}): VaultEntityLike {
	return { id, type: "brainstorm/Person/v1", properties: { name, ...over } };
}

describe("toStringArray", () => {
	it("normalises a bare string", () => {
		expect(toStringArray("a@b.com")).toEqual(["a@b.com"]);
	});
	it("keeps a string array, trimming + dropping blanks", () => {
		expect(toStringArray(["  a ", "", "b"])).toEqual(["a", "b"]);
	});
	it("reads { value } / { label } envelopes", () => {
		expect(toStringArray([{ value: "x" }, { label: "y" }])).toEqual(["x", "y"]);
	});
	it("is empty for null/undefined", () => {
		expect(toStringArray(null)).toEqual([]);
		expect(toStringArray(undefined)).toEqual([]);
	});
});

describe("refToId / refsToIds", () => {
	it("resolves a bare id string", () => {
		expect(refToId("ent_1")).toBe("ent_1");
	});
	it("resolves an envelope", () => {
		expect(refToId({ id: "ent_2" })).toBe("ent_2");
		expect(refToId({ entityId: "ent_3" })).toBe("ent_3");
		expect(refToId({ value: "ent_4" })).toBe("ent_4");
	});
	it("resolves a single-value array", () => {
		expect(refToId(["ent_5"])).toBe("ent_5");
	});
	it("is null for empty / non-ref", () => {
		expect(refToId(null)).toBeNull();
		expect(refToId(42)).toBeNull();
		expect(refToId([])).toBeNull();
	});
	it("dedups + keeps order for multi refs", () => {
		expect(refsToIds(["a", "b", "a", { id: "c" }])).toEqual(["a", "b", "c"]);
	});
});

describe("entityToPerson", () => {
	it("projects every field", () => {
		const p = entityToPerson(
			person("ent_1", "  Ada Okafor ", {
				email: ["ada@x.com", { value: "ada2@x.com" }],
				phone: "+1 555",
				company: "co_1",
				role: " Founder ",
				birthday: 123,
				anniversary: 456,
				links: ["ent_2", "ent_2", "ent_3"],
				bio: "hi",
			}),
		);
		expect(p).toEqual({
			id: "ent_1",
			name: "Ada Okafor",
			emails: ["ada@x.com", "ada2@x.com"],
			phones: ["+1 555"],
			companyId: "co_1",
			role: "Founder",
			birthday: 123,
			anniversary: 456,
			linkIds: ["ent_2", "ent_3"],
			bio: "hi",
		});
	});
	it("defaults missing fields", () => {
		const p = entityToPerson(person("ent_x", ""));
		expect(p.emails).toEqual([]);
		expect(p.companyId).toBeNull();
		expect(p.birthday).toBeNull();
		expect(p.linkIds).toEqual([]);
	});
	it("drops a non-finite birthday", () => {
		expect(entityToPerson(person("e", "n", { birthday: Number.NaN })).birthday).toBeNull();
	});
});

describe("personsFromEntities", () => {
	it("filters to Person/v1 and name-sorts", () => {
		const list = personsFromEntities([
			person("p2", "Bob"),
			{ id: "x", type: "brainstorm/Note/v1", properties: { name: "Not a person" } },
			person("p1", "Ana"),
		]);
		expect(list.map((p) => p.name)).toEqual(["Ana", "Bob"]);
	});
});

describe("personInitials", () => {
	it("uses first + last initial", () => {
		expect(personInitials("Ada Okafor")).toBe("AO");
	});
	it("uses one letter for a single word", () => {
		expect(personInitials("Cher")).toBe("C");
	});
	it("is empty for a blank name", () => {
		expect(personInitials("   ")).toBe("");
	});
	it("skips punctuation-led words — a parenthesised suffix never lands in the chip", () => {
		expect(personInitials("Ada Lovelace (work)")).toBe("AL");
		expect(personInitials('Ada "Countess" Lovelace')).toBe("AL");
		expect(personInitials("Ada — Lovelace")).toBe("AL");
	});
	it("falls back to the first letter/digit when every word is decorated", () => {
		expect(personInitials("(Ada)")).toBe("A");
		expect(personInitials("(...)")).toBe("");
	});
});

describe("comparePersons", () => {
	it("sorts case-insensitively and sinks the unnamed", () => {
		const a = entityToPerson(person("a", "zoe"));
		const b = entityToPerson(person("b", "Ada"));
		const c = entityToPerson(person("c", ""));
		const sorted = [a, b, c].sort(comparePersons);
		expect(sorted.map((p) => p.id)).toEqual(["b", "a", "c"]);
	});
});

describe("groupByLetter", () => {
	it("buckets by first letter with the other bucket last", () => {
		const persons = personsFromEntities([
			person("p1", "Ada"),
			person("p2", "Amir"),
			person("p3", "Bo"),
			person("p4", "9Lives"),
		]);
		const groups = groupByLetter(persons, OTHER);
		expect(groups.map((g) => g.letter)).toEqual(["A", "B", OTHER]);
		expect(groups[0]?.persons.map((p) => p.name)).toEqual(["Ada", "Amir"]);
	});
});

describe("comparePersonsBy", () => {
	const co = new Map<string, string>([
		["c_acme", "Acme"],
		["c_zen", "Zen"],
	]);
	const resolvers: PersonViewResolvers = { companyName: (id) => (id ? (co.get(id) ?? null) : null) };

	it("Name axis matches comparePersons", () => {
		const a = entityToPerson(person("a", "Bob"));
		const b = entityToPerson(person("b", "Ada"));
		expect(comparePersonsBy(a, b, ContactsSorting.Name, resolvers)).toBe(comparePersons(a, b));
	});
	it("Company axis orders by company name then sinks the companyless", () => {
		const a = entityToPerson(person("a", "Bob", { company: "c_zen" }));
		const b = entityToPerson(person("b", "Ada", { company: "c_acme" }));
		const c = entityToPerson(person("c", "Cy"));
		const sorted = [a, b, c].sort((x, y) =>
			comparePersonsBy(x, y, ContactsSorting.Company, resolvers),
		);
		expect(sorted.map((p) => p.id)).toEqual(["b", "a", "c"]);
	});
	it("Company axis breaks ties on name", () => {
		const a = entityToPerson(person("a", "Bo", { company: "c_acme" }));
		const b = entityToPerson(person("b", "Al", { company: "c_acme" }));
		const sorted = [a, b].sort((x, y) => comparePersonsBy(x, y, ContactsSorting.Company, resolvers));
		expect(sorted.map((p) => p.id)).toEqual(["b", "a"]);
	});
});

describe("groupPersons", () => {
	const co = new Map<string, string>([["c_acme", "Acme"]]);
	const resolvers: PersonViewResolvers = { companyName: (id) => (id ? (co.get(id) ?? null) : null) };
	const sample = [
		entityToPerson(person("p1", "Ada", { company: "c_acme", role: "Founder" })),
		entityToPerson(person("p2", "Amir", { role: "Founder" })),
		entityToPerson(person("p3", "Bo", { company: "c_acme" })),
		entityToPerson(person("p4", "9Lives")),
	];

	it("FirstLetter buckets with the other bucket last", () => {
		const groups = groupPersons(
			sample,
			ContactsGrouping.FirstLetter,
			ContactsSorting.Name,
			resolvers,
			BUCKETS,
		);
		expect(groups.map((g) => g.label)).toEqual(["A", "B", OTHER]);
		expect(groups.at(-1)?.trailing).toBe(true);
		expect(groups[0]?.persons.map((p) => p.id)).toEqual(["p1", "p2"]);
	});
	it("Company groups by resolved name with No company trailing", () => {
		const groups = groupPersons(
			sample,
			ContactsGrouping.Company,
			ContactsSorting.Name,
			resolvers,
			BUCKETS,
		);
		expect(groups.map((g) => g.label)).toEqual(["Acme", "No company"]);
		expect(groups.at(-1)?.trailing).toBe(true);
		expect(groups[0]?.persons.map((p) => p.id)).toEqual(["p1", "p3"]);
		// Companyless bucket is name-sorted: "9Lives" (p4) before "Amir" (p2).
		expect(groups.at(-1)?.persons.map((p) => p.id)).toEqual(["p4", "p2"]);
	});
	it("Role groups by role with No role trailing", () => {
		const groups = groupPersons(
			sample,
			ContactsGrouping.Role,
			ContactsSorting.Name,
			resolvers,
			BUCKETS,
		);
		expect(groups.map((g) => g.label)).toEqual(["Founder", "No role"]);
		expect(groups[0]?.persons.map((p) => p.id)).toEqual(["p1", "p2"]);
		// No-role bucket is name-sorted: "9Lives" (p4) before "Bo" (p3).
		expect(groups.at(-1)?.persons.map((p) => p.id)).toEqual(["p4", "p3"]);
	});
	it("None returns one headingless group, sorted", () => {
		const groups = groupPersons(
			sample,
			ContactsGrouping.None,
			ContactsSorting.Name,
			resolvers,
			BUCKETS,
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.label).toBe("");
		expect(groups[0]?.persons.map((p) => p.id)).toEqual(["p4", "p1", "p2", "p3"]);
	});
	it("None on an empty list yields no groups", () => {
		expect(groupPersons([], ContactsGrouping.None, ContactsSorting.Name, resolvers, BUCKETS)).toEqual(
			[],
		);
	});
	it("respects the chosen sort within groups (Company sort)", () => {
		const groups = groupPersons(
			sample,
			ContactsGrouping.None,
			ContactsSorting.Company,
			resolvers,
			BUCKETS,
		);
		// Acme members (Ada, Bo) first, companyless (9Lives, Amir) after, each name-sorted.
		expect(groups[0]?.persons.map((p) => p.id)).toEqual(["p1", "p3", "p4", "p2"]);
	});
	it("freezes the axis lists", () => {
		expect(CONTACTS_GROUPINGS).toContain(ContactsGrouping.None);
		expect(CONTACTS_SORTINGS).toContain(ContactsSorting.Company);
	});
});

describe("filterPersons", () => {
	const persons = personsFromEntities([
		person("p1", "Ada Okafor", { email: ["ada@acme.com"], role: "Founder" }),
		person("p2", "Bob Lin", { phone: ["+1 555 0199"] }),
	]);
	it("returns all for an empty query", () => {
		expect(filterPersons(persons, "  ").length).toBe(2);
	});
	it("matches name / email / phone / role", () => {
		expect(filterPersons(persons, "okafor").map((p) => p.id)).toEqual(["p1"]);
		expect(filterPersons(persons, "acme").map((p) => p.id)).toEqual(["p1"]);
		expect(filterPersons(persons, "founder").map((p) => p.id)).toEqual(["p1"]);
		expect(filterPersons(persons, "0199").map((p) => p.id)).toEqual(["p2"]);
	});
});

describe("buildEntityNameIndex / resolveName", () => {
	const index = buildEntityNameIndex([person("co_1", "  Acme Corp "), person("blank", "")]);
	it("indexes only named entities, trimmed", () => {
		expect(index.get("co_1")).toBe("Acme Corp");
		expect(index.has("blank")).toBe(false);
	});
	it("resolves a hit, or null for missing / null id", () => {
		expect(resolveName(index, "co_1")).toBe("Acme Corp");
		expect(resolveName(index, "nope")).toBeNull();
		expect(resolveName(index, null)).toBeNull();
	});
});
