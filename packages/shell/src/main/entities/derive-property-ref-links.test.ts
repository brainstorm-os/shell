import type { PropertyDef } from "@brainstorm-os/sdk-types";
import { ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_PROPERTY_REF_RULES,
	type PropertyRefRule,
	derivePropertyRefLinks,
} from "./derive-property-ref-links";
import type { VaultEntity } from "./vault-entities-service";

function refDef(key: string, name: string, allowedTypes?: readonly string[]): PropertyDef {
	return {
		key,
		name,
		icon: null,
		valueType: ValueType.EntityRef,
		...(allowedTypes ? { allowedTypes } : {}),
	};
}

function entity(
	id: string,
	type: string,
	properties: Record<string, unknown>,
	updatedAt = 7,
): VaultEntity {
	return {
		id,
		type,
		properties,
		createdAt: 1,
		updatedAt,
		deletedAt: null,
		ownerAppId: "io.test",
	};
}

const FOLDER = "brainstorm/Folder/v1";

describe("derivePropertyRefLinks — pure projection", () => {
	it("emits no edges on an empty entity set", () => {
		expect(derivePropertyRefLinks([])).toEqual([]);
	});

	it("emits one Folder/contains edge per listed member id", () => {
		const links = derivePropertyRefLinks([entity("f1", FOLDER, { members: ["d1", "d2", "d3"] }, 42)]);
		expect(links).toHaveLength(3);
		expect(links.map((l) => l.destEntityId).sort()).toEqual(["d1", "d2", "d3"]);
		expect(links.every((l) => l.sourceEntityId === "f1")).toBe(true);
		expect(links.every((l) => l.linkType === "brainstorm/Folder/contains")).toBe(true);
		expect(links.every((l) => l.createdAt === 42)).toBe(true);
	});

	it("dedupes repeated ids within the same array (idempotent edge per member)", () => {
		const links = derivePropertyRefLinks([entity("f1", FOLDER, { members: ["d1", "d1", "d2"] })]);
		expect(links).toHaveLength(2);
	});

	it("drops self-loops (folder listing itself)", () => {
		const links = derivePropertyRefLinks([entity("f1", FOLDER, { members: ["d1", "f1"] })]);
		expect(links).toHaveLength(1);
		expect(links[0]?.destEntityId).toBe("d1");
	});

	it("ignores entities of non-matching types", () => {
		const links = derivePropertyRefLinks([
			entity("n1", "brainstorm/Note/v1", { members: ["x"] }),
			entity("f1", FOLDER, { members: ["d1"] }),
		]);
		expect(links).toHaveLength(1);
		expect(links[0]?.sourceEntityId).toBe("f1");
	});

	it("tolerates missing / wrong-shape members property", () => {
		const links = derivePropertyRefLinks([
			entity("f1", FOLDER, {}),
			entity("f2", FOLDER, { members: null }),
			entity("f3", FOLDER, { members: "not-an-array" }),
			entity("f4", FOLDER, { members: ["", null, 0, "real"] as unknown[] }),
		]);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({ sourceEntityId: "f4", destEntityId: "real" });
	});

	it("edge id is stable + deterministic across runs", () => {
		const ents = [entity("f1", FOLDER, { members: ["d2", "d1"] })];
		const run1 = derivePropertyRefLinks(ents);
		const run2 = derivePropertyRefLinks(ents);
		expect(run1).toEqual(run2);
		expect(run1[0]?.id).toBe("lnk_ref_brainstorm/Folder/contains_f1_d2");
	});

	it("multiple folders compose — no cross-talk between them", () => {
		const links = derivePropertyRefLinks([
			entity("f1", FOLDER, { members: ["d1", "d2"] }),
			entity("f2", FOLDER, { members: ["d3", "d4"] }),
		]);
		expect(links).toHaveLength(4);
		const bySource = new Map<string, string[]>();
		for (const l of links) {
			const list = bySource.get(l.sourceEntityId) ?? [];
			list.push(l.destEntityId);
			bySource.set(l.sourceEntityId, list);
		}
		expect(bySource.get("f1")?.sort()).toEqual(["d1", "d2"]);
		expect(bySource.get("f2")?.sort()).toEqual(["d3", "d4"]);
	});

	it("nested-folder edges: parent → child folder is a valid contains edge", () => {
		// Real-world shape: a docs-root folder whose members include the
		// per-category sub-folders, each with their own DesignDoc members.
		const links = derivePropertyRefLinks([
			entity("folder-docs", FOLDER, { members: ["folder-docs-foundations", "folder-docs-shell"] }),
			entity("folder-docs-foundations", FOLDER, { members: ["doc-foundations-02"] }),
			entity("folder-docs-shell", FOLDER, { members: ["doc-shell-12"] }),
		]);
		expect(links).toHaveLength(4);
		// Root → two sub-folders.
		expect(
			links
				.filter((l) => l.sourceEntityId === "folder-docs")
				.map((l) => l.destEntityId)
				.sort(),
		).toEqual(["folder-docs-foundations", "folder-docs-shell"]);
	});

	it("default rule set covers Folder/contains, Event/from-milestone, Task/from-iteration, Note/about", () => {
		expect(DEFAULT_PROPERTY_REF_RULES).toEqual([
			{
				linkType: "brainstorm/Folder/contains",
				entityType: FOLDER,
				propertyPath: "members",
				arrayValued: true,
			},
			{
				linkType: "brainstorm/Event/from-milestone",
				entityType: "brainstorm/Event/v1",
				propertyPath: "milestoneId",
				arrayValued: false,
			},
			{
				linkType: "brainstorm/Task/from-iteration",
				entityType: "brainstorm/Task/v1",
				propertyPath: "iterationId",
				arrayValued: false,
			},
			{
				linkType: "brainstorm/Note/about",
				entityType: "io.brainstorm.notes/Note/v1",
				propertyPath: "aboutEntityId",
				arrayValued: false,
			},
		]);
	});

	it("scalar rule reads a single id from a string property", () => {
		const links = derivePropertyRefLinks([
			entity("event-milestone-9", "brainstorm/Event/v1", { milestoneId: "milestone-9" }),
			entity("event-milestone-ga", "brainstorm/Event/v1", { milestoneId: "milestone-ga" }),
		]);
		const ms = links.filter((l) => l.linkType === "brainstorm/Event/from-milestone");
		expect(ms).toHaveLength(2);
		expect(ms.map((l) => `${l.sourceEntityId}->${l.destEntityId}`).sort()).toEqual([
			"event-milestone-9->milestone-9",
			"event-milestone-ga->milestone-ga",
		]);
	});

	it("scalar rule emits zero edges for null / empty / non-string values", () => {
		const rule: PropertyRefRule = {
			linkType: "brainstorm/Event/from-milestone",
			entityType: "brainstorm/Event/v1",
			propertyPath: "milestoneId",
			arrayValued: false,
		};
		const links = derivePropertyRefLinks(
			[
				entity("e1", "brainstorm/Event/v1", { milestoneId: null }),
				entity("e2", "brainstorm/Event/v1", { milestoneId: "" }),
				entity("e3", "brainstorm/Event/v1", { milestoneId: 42 }),
				entity("e4", "brainstorm/Event/v1", {}),
			],
			[rule],
		);
		expect(links).toEqual([]);
	});

	it("a custom rule pairing different types still works", () => {
		const rule: PropertyRefRule = {
			linkType: "test/Whatever/contains",
			entityType: "test/Container/v1",
			propertyPath: "kids",
		};
		const links = derivePropertyRefLinks(
			[entity("c1", "test/Container/v1", { kids: ["k1", "k2"] })],
			[rule],
		);
		expect(links).toHaveLength(2);
		expect(links[0]?.linkType).toBe("test/Whatever/contains");
	});

	describe("catalog-driven entityRef edges", () => {
		const PERSON = "brainstorm/Person/v1";

		it("emits a reference edge for a scalar entityRef property", () => {
			const links = derivePropertyRefLinks(
				[entity("p1", PERSON, { company: "co1" })],
				DEFAULT_PROPERTY_REF_RULES,
				[refDef("company", "Company")],
			);
			expect(links).toHaveLength(1);
			expect(links[0]).toMatchObject({
				sourceEntityId: "p1",
				destEntityId: "co1",
				linkType: "brainstorm/ref/brainstorm/Person/v1/company",
				detail: "Company",
			});
		});

		it("reads ids from a multi-valued {value} envelope array", () => {
			const links = derivePropertyRefLinks(
				[entity("p1", PERSON, { links: [{ value: "p2" }, { value: "p3" }, "p4"] })],
				DEFAULT_PROPERTY_REF_RULES,
				[refDef("links", "Links", [PERSON])],
			);
			expect(links.map((l) => l.destEntityId).sort()).toEqual(["p2", "p3", "p4"]);
			expect(links.every((l) => l.detail === "Links")).toBe(true);
		});

		it("ignores non-entityRef defs", () => {
			const links = derivePropertyRefLinks(
				[entity("p1", PERSON, { role: "r1" })],
				DEFAULT_PROPERTY_REF_RULES,
				[{ key: "role", name: "Role", icon: null, valueType: ValueType.Text }],
			);
			expect(links).toEqual([]);
		});

		it("does not double-emit when a structural rule owns the property key", () => {
			// `members` is both a Folder structural rule and (hypothetically) a
			// catalog entityRef def — the structural verb wins, no duplicate.
			const links = derivePropertyRefLinks(
				[entity("f1", FOLDER, { members: ["d1"] })],
				DEFAULT_PROPERTY_REF_RULES,
				[refDef("members", "Members", [FOLDER])],
			);
			expect(links).toHaveLength(1);
			expect(links[0]?.linkType).toBe("brainstorm/Folder/contains");
		});

		it("drops self-refs and dedupes within one property", () => {
			const links = derivePropertyRefLinks(
				[entity("p1", PERSON, { links: ["p1", "p2", "p2"] })],
				DEFAULT_PROPERTY_REF_RULES,
				[refDef("links", "Links", [PERSON])],
			);
			expect(links).toHaveLength(1);
			expect(links[0]?.destEntityId).toBe("p2");
		});

		it("is a no-op when no defs are supplied (back-compat)", () => {
			const links = derivePropertyRefLinks([entity("p1", PERSON, { company: "co1" })]);
			expect(links).toEqual([]);
		});
	});
});
