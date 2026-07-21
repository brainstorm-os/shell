import { validateDictionary, validatePropertyDef } from "@brainstorm-os/sdk";
import { ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import {
	PLAN_DICT_PRIORITY_ID,
	PLAN_DICT_STATUS_ID,
	buildPlanProperties,
	seedPlanProperties,
} from "./plan-properties";

describe("buildPlanProperties", () => {
	const { properties, dictionaries } = buildPlanProperties();

	it("emits the eight task/plan properties under stable semantic keys", () => {
		expect(properties.map((p) => p.key)).toEqual([
			"name",
			"statusKey",
			"priority",
			"projectId",
			"assigneeId",
			"completedAt",
			"scheduledAt",
			"dueAt",
		]);
	});

	it("every PropertyDef validates", () => {
		for (const def of properties) {
			expect(validatePropertyDef(def), `${def.key}`).toMatchObject({ ok: true });
		}
	});

	it("every Dictionary validates", () => {
		for (const dict of dictionaries) {
			expect(validateDictionary(dict), dict.id).toMatchObject({ ok: true });
		}
	});

	it("statusKey/priority are vocabulary-backed Selects pointing at the seeded dictionaries", () => {
		const status = properties.find((p) => p.key === "statusKey");
		const priority = properties.find((p) => p.key === "priority");
		expect(status?.valueType).toBe(ValueType.Text);
		expect(status?.vocabulary?.dictionaryId).toBe(PLAN_DICT_STATUS_ID);
		expect(priority?.vocabulary?.dictionaryId).toBe(PLAN_DICT_PRIORITY_ID);
		expect(dictionaries.map((d) => d.id).sort()).toEqual(
			[PLAN_DICT_PRIORITY_ID, PLAN_DICT_STATUS_ID].sort(),
		);
	});

	it("date fields are Date-typed; projectId/assigneeId are entityRefs to Project/Person", () => {
		const dateKeys = ["completedAt", "scheduledAt", "dueAt"];
		for (const k of dateKeys) {
			expect(properties.find((p) => p.key === k)?.valueType).toBe(ValueType.Date);
		}
		const proj = properties.find((p) => p.key === "projectId");
		expect(proj?.valueType).toBe(ValueType.EntityRef);
		expect(proj?.allowedTypes).toEqual(["brainstorm/Project/v1"]);
		const assignee = properties.find((p) => p.key === "assigneeId");
		expect(assignee?.valueType).toBe(ValueType.EntityRef);
		expect(assignee?.allowedTypes).toEqual(["brainstorm/Person/v1"]);
		expect(assignee?.count).toEqual({ min: 0, max: 1 });
	});

	it("dictionary items carry lowercase #rrggbb colours + unique ids matching the stored values", () => {
		const status = dictionaries.find((d) => d.id === PLAN_DICT_STATUS_ID);
		expect(status?.items.map((i) => i.label)).toContain("done");
		expect(status?.items.map((i) => i.label)).toContain("reverted");
		for (const d of dictionaries) {
			const ids = d.items.map((i) => i.id);
			expect(new Set(ids).size).toBe(ids.length);
			for (const item of d.items) {
				expect(item.colour).toMatch(/^#[0-9a-f]{6}$/);
			}
		}
	});
});

describe("seedPlanProperties", () => {
	it("writes dictionaries before properties through the session store", async () => {
		const order: string[] = [];
		const store = {
			setProperty: vi.fn((d) => order.push(`prop:${d.key}`)),
			setDictionary: vi.fn((d) => order.push(`dict:${d.id}`)),
		};
		const result = await seedPlanProperties({ propertiesStore: async () => store });
		expect(result).toEqual({ ok: true, properties: 8, dictionaries: 2 });
		expect(order.slice(0, 2)).toEqual([
			`dict:${PLAN_DICT_STATUS_ID}`,
			`dict:${PLAN_DICT_PRIORITY_ID}`,
		]);
		expect(order.filter((o) => o.startsWith("prop:"))).toHaveLength(8);
	});

	it("reports a reason instead of throwing when the store rejects", async () => {
		const result = await seedPlanProperties({
			propertiesStore: async () => {
				throw new Error("no active vault session");
			},
		});
		expect(result).toEqual({ ok: false, reason: "no active vault session" });
	});
});
