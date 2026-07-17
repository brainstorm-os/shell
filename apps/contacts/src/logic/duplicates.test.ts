import { describe, expect, it } from "vitest";
import type { Person, VaultEntityLike } from "../types/person";
import {
	DuplicateMatchKind,
	applyMergeToEntities,
	completenessScore,
	findDuplicateGroups,
	normalizeEmail,
	normalizeFullName,
	planMergePatch,
	resolveGroups,
} from "./duplicates";

function person(id: string, over: Partial<Person> = {}): Person {
	return {
		id,
		name: "",
		emails: [],
		phones: [],
		companyId: null,
		role: "",
		birthday: null,
		anniversary: null,
		linkIds: [],
		bio: "",
		...over,
	};
}

describe("normalizers", () => {
	it("normalizeEmail trims + case-folds", () => {
		expect(normalizeEmail("  Dana@Example.COM ")).toBe("dana@example.com");
		expect(normalizeEmail("   ")).toBe("");
	});

	it("normalizeFullName folds case, whitespace, and diacritics", () => {
		expect(normalizeFullName("  Dana   Whitfield ")).toBe("dana whitfield");
		expect(normalizeFullName("DÁNA WHITFIELD")).toBe("dana whitfield");
		expect(normalizeFullName("")).toBe("");
	});
});

describe("findDuplicateGroups", () => {
	it("groups people sharing a normalized email as a STRONG match", () => {
		const groups = findDuplicateGroups([
			person("a", { name: "Dana", emails: ["dana@x.com"] }),
			person("b", { name: "D. Whitfield", emails: ["Dana@X.com "] }),
			person("c", { name: "Sam", emails: ["sam@x.com"] }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.kind).toBe(DuplicateMatchKind.Email);
		expect([...(groups[0]?.ids ?? [])].sort()).toEqual(["a", "b"]);
	});

	it("groups people sharing only a normalized name as a CANDIDATE match", () => {
		const groups = findDuplicateGroups([
			person("a", { name: "Dana Whitfield", emails: ["dana@x.com"] }),
			person("b", { name: "dana  whitfield", emails: ["other@y.com"] }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.kind).toBe(DuplicateMatchKind.Name);
	});

	it("unions name + email evidence into ONE group graded by the strongest evidence", () => {
		const groups = findDuplicateGroups([
			person("a", { name: "Dana Whitfield", emails: ["dana@x.com"] }),
			person("b", { name: "Dana Whitfield" }),
			person("c", { name: "D W", emails: ["dana@x.com"] }),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.kind).toBe(DuplicateMatchKind.Email);
		expect([...(groups[0]?.ids ?? [])].sort()).toEqual(["a", "b", "c"]);
	});

	it("never matches unnamed people or empty emails to each other", () => {
		const groups = findDuplicateGroups([
			person("a", { name: "", emails: [] }),
			person("b", { name: "  ", emails: [" "] }),
			person("c", { name: "Sam" }),
		]);
		expect(groups).toEqual([]);
	});

	it("orders members most-complete-first, breaking ties toward the oldest record", () => {
		const created = new Map([
			["thin", 100],
			["rich", 300],
			["twinOld", 100],
			["twinNew", 200],
		]);
		const groups = findDuplicateGroups(
			[
				person("thin", { name: "Dana Whitfield" }),
				person("rich", {
					name: "Dana Whitfield",
					emails: ["d@x.com"],
					role: "Advisor",
				}),
				person("twinNew", { name: "Sam Okonkwo", emails: ["s@x.com"] }),
				person("twinOld", { name: "Sam Okonkwo", emails: ["s@x.com"] }),
			],
			(id) => created.get(id) ?? 0,
		);
		const dana = groups.find((g) => g.ids.includes("rich"));
		expect(dana?.ids[0]).toBe("rich"); // more complete wins
		const sam = groups.find((g) => g.ids.includes("twinOld"));
		expect(sam?.ids[0]).toBe("twinOld"); // equal completeness → oldest wins
	});

	it("orders groups largest-first (the 7× offender leads)", () => {
		const many = ["a", "b", "c"].map((id) => person(id, { name: "Dana Whitfield" }));
		const pair = ["x", "y"].map((id) => person(id, { name: "Ann Lee" }));
		const groups = findDuplicateGroups([...pair, ...many]);
		expect(groups.map((g) => g.ids.length)).toEqual([3, 2]);
	});
});

describe("completenessScore", () => {
	it("counts filled fields + multi-value entries", () => {
		expect(completenessScore(person("a"))).toBe(0);
		expect(
			completenessScore(
				person("b", {
					name: "Dana",
					role: "Advisor",
					emails: ["a@x.com", "b@x.com"],
					companyId: "co",
					birthday: 1,
				}),
			),
		).toBe(6);
	});
});

describe("planMergePatch", () => {
	it("unions emails + phones with normalized de-dupe, survivor first", () => {
		const patch = planMergePatch(
			person("s", { name: "Dana", emails: ["dana@x.com"], phones: ["+1 555 0100"] }),
			[person("l1", { emails: ["DANA@x.com", "d.w@y.com"], phones: ["+15550100", "555 0199"] })],
		);
		expect(patch.email).toEqual(["dana@x.com", "d.w@y.com"]);
		expect(patch.phone).toEqual(["+1 555 0100", "555 0199"]);
	});

	it("fills empty scalar slots from losers but keeps the survivor's value on conflict", () => {
		const patch = planMergePatch(person("s", { name: "Dana", role: "Advisor" }), [
			person("l1", { role: "Consultant", bio: "Met at Beacon", companyId: "co1", birthday: 42 }),
		]);
		expect(patch.role).toBeUndefined(); // conflict → survivor keeps Advisor
		expect(patch.bio).toBe("Met at Beacon");
		expect(patch.company).toBe("co1");
		expect(patch.birthday).toBe(42);
	});

	it("unions related-people links, dropping refs to group members", () => {
		const patch = planMergePatch(person("s", { name: "Dana", linkIds: ["friend", "l1"] }), [
			person("l1", { linkIds: ["mentor", "s"] }),
		]);
		expect(patch.links).toEqual(["friend", "mentor"]);
	});

	it("returns an empty patch when the survivor already carries everything", () => {
		const survivor = person("s", { name: "Dana", emails: ["dana@x.com"] });
		const patch = planMergePatch(survivor, [person("l1", { name: "Dana", emails: ["dana@x.com"] })]);
		expect(patch).toEqual({});
	});
});

describe("applyMergeToEntities (demo mode)", () => {
	it("applies the patch, repoints refs, drops losers", () => {
		const entities: VaultEntityLike[] = [
			{ id: "s", type: "brainstorm/Person/v1", properties: { name: "Dana" } },
			{ id: "l", type: "brainstorm/Person/v1", properties: { name: "Dana W" } },
			{ id: "t", type: "x/Task/v1", properties: { assignee: "l", people: ["l", "s"] } },
		];
		const merged = applyMergeToEntities(entities, "s", ["l"], { email: ["d@x.com"] });
		expect(merged.map((e) => e.id)).toEqual(["s", "t"]);
		expect(merged[0]?.properties).toMatchObject({ name: "Dana", email: ["d@x.com"] });
		expect(merged[1]?.properties).toMatchObject({ assignee: "s", people: ["s"] });
	});

	it("drops a would-be self-ref on the survivor", () => {
		const entities: VaultEntityLike[] = [
			{ id: "s", type: "brainstorm/Person/v1", properties: { links: ["l", "o"] } },
			{ id: "l", type: "brainstorm/Person/v1", properties: {} },
		];
		const merged = applyMergeToEntities(entities, "s", ["l"], {});
		expect(merged[0]?.properties).toMatchObject({ links: ["o"] });
	});
});

describe("resolveGroups", () => {
	it("resolves ids to persons and drops groups that fell below two live members", () => {
		const persons = [person("a", { name: "Dana" }), person("b", { name: "Dana" })];
		const views = resolveGroups(
			[
				{ ids: ["a", "b"], kind: DuplicateMatchKind.Name },
				{ ids: ["a", "gone"], kind: DuplicateMatchKind.Name },
			],
			persons,
		);
		expect(views).toHaveLength(1);
		expect(views[0]?.defaultSurvivorId).toBe("a");
		expect(views[0]?.persons.map((p) => p.id)).toEqual(["a", "b"]);
	});
});
