import { type PropertyDef, PropertyFormat, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { Priority, type Task } from "../types/task";
import {
	PERSON_ENTITY_TYPE,
	PROJECT_ENTITY_TYPE,
	TASK_PROPERTY_DEFS,
	TASK_PROP_KEY,
	boundCustomDefs,
	parseAssigneeValue,
	parseDateValue,
	parseDurationValue,
	parsePriorityValue,
	parseProjectValue,
	parseStatusValue,
	parseTagsValue,
	taskToValues,
	unboundCustomDefs,
} from "./task-properties";
import { PRIORITY_DICT_ID, STATUS_DICT_ID, TAGS_DICT_ID } from "./task-vocab";

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "task-1",
		name: "Write the bridge",
		completedAt: null,
		priority: Priority.High,
		scheduledAt: null,
		dueAt: null,
		projectId: null,
		assigneeId: null,
		parentId: null,
		recurrence: null,
		statusKey: null,
		createdAt: 1,
		updatedAt: 2,
		...overrides,
	};
}

describe("task-properties bridge", () => {
	it("exposes every bridged def in render order", () => {
		expect(TASK_PROPERTY_DEFS.map((d) => d.key)).toEqual([
			TASK_PROP_KEY.status,
			TASK_PROP_KEY.priority,
			TASK_PROP_KEY.scheduled,
			TASK_PROP_KEY.due,
			TASK_PROP_KEY.project,
			TASK_PROP_KEY.assignee,
			TASK_PROP_KEY.estimate,
			TASK_PROP_KEY.logged,
			TASK_PROP_KEY.tags,
			TASK_PROP_KEY.created,
			TASK_PROP_KEY.updated,
		]);
	});

	it("models status / priority as vocabulary-backed text", () => {
		const status = TASK_PROPERTY_DEFS.find((d) => d.key === TASK_PROP_KEY.status);
		const priority = TASK_PROPERTY_DEFS.find((d) => d.key === TASK_PROP_KEY.priority);
		expect(status?.valueType).toBe(ValueType.Text);
		expect(status?.vocabulary?.dictionaryId).toBe(STATUS_DICT_ID);
		expect(priority?.vocabulary?.dictionaryId).toBe(PRIORITY_DICT_ID);
	});

	it("models tags as a multi-valued vocabulary text", () => {
		const tags = TASK_PROPERTY_DEFS.find((d) => d.key === TASK_PROP_KEY.tags);
		expect(tags?.vocabulary?.dictionaryId).toBe(TAGS_DICT_ID);
		expect((tags?.count?.max ?? 1) > 1).toBe(true);
	});

	it("models project as a scalar entity-ref scoped to Project/v1", () => {
		const def = TASK_PROPERTY_DEFS.find((d) => d.key === TASK_PROP_KEY.project);
		expect(def?.valueType).toBe(ValueType.EntityRef);
		expect(def?.allowedTypes).toEqual([PROJECT_ENTITY_TYPE]);
	});

	it("models assignee as a scalar entity-ref scoped to Person/v1 (F-152)", () => {
		const def = TASK_PROPERTY_DEFS.find((d) => d.key === TASK_PROP_KEY.assignee);
		expect(def?.valueType).toBe(ValueType.EntityRef);
		expect(def?.allowedTypes).toEqual([PERSON_ENTITY_TYPE]);
		expect(def?.count).toEqual({ min: 0, max: 1 });
	});

	it("models estimate / logged as Duration numbers", () => {
		for (const key of [TASK_PROP_KEY.estimate, TASK_PROP_KEY.logged]) {
			const def = TASK_PROPERTY_DEFS.find((d) => d.key === key);
			expect(def?.valueType).toBe(ValueType.Number);
			expect(def?.format).toBe(PropertyFormat.Duration);
		}
	});
});

describe("taskToValues", () => {
	it("emits priority / status as the dictionary item id (the enum / statusKey)", () => {
		const values = taskToValues(task({ priority: Priority.Critical, statusKey: "in-progress" }));
		expect(values[TASK_PROP_KEY.priority]).toBe(Priority.Critical);
		expect(values[TASK_PROP_KEY.status]).toBe("in-progress");
	});

	it("emits project / assignee as the raw entity id, empty when unset", () => {
		const set = taskToValues(task({ projectId: "proj_1", assigneeId: "person_mira" }));
		expect(set[TASK_PROP_KEY.project]).toBe("proj_1");
		expect(set[TASK_PROP_KEY.assignee]).toBe("person_mira");
		const unset = taskToValues(task());
		expect(unset[TASK_PROP_KEY.project]).toBe("");
		expect(unset[TASK_PROP_KEY.assignee]).toBe("");
	});

	it("converts estimate / logged minutes to hours, null when absent", () => {
		const values = taskToValues(task({ estimateMinutes: 90, loggedMinutes: 30 }));
		expect(values[TASK_PROP_KEY.estimate]).toBe(1.5);
		expect(values[TASK_PROP_KEY.logged]).toBe(0.5);
		const absent = taskToValues(task());
		expect(absent[TASK_PROP_KEY.estimate]).toBeNull();
		expect(absent[TASK_PROP_KEY.logged]).toBeNull();
	});

	it("emits tags as LabeledValue id envelopes", () => {
		const values = taskToValues(task({ tags: ["urgent", "home"] }));
		expect(values[TASK_PROP_KEY.tags]).toEqual([{ value: "urgent" }, { value: "home" }]);
	});

	it("wraps a set date and leaves an unset one null", () => {
		const values = taskToValues(task({ scheduledAt: 123, dueAt: null }));
		expect(values[TASK_PROP_KEY.scheduled]).toMatchObject({ at: 123 });
		expect(values[TASK_PROP_KEY.due]).toBeNull();
	});

	it("always carries the created / updated timestamps", () => {
		const values = taskToValues(task({ createdAt: 10, updatedAt: 20 }));
		expect(values[TASK_PROP_KEY.created]).toMatchObject({ at: 10 });
		expect(values[TASK_PROP_KEY.updated]).toMatchObject({ at: 20 });
	});
});

describe("write-back parsers", () => {
	it("parseEntityRef (assignee / project): id or null", () => {
		expect(parseAssigneeValue("person_priya")).toBe("person_priya");
		expect(parseProjectValue("proj_2")).toBe("proj_2");
		for (const bad of ["", null, undefined, 42, { value: "x" }]) {
			expect(parseAssigneeValue(bad)).toBeNull();
		}
	});

	it("parsePriorityValue: known id → enum, else None", () => {
		expect(parsePriorityValue(Priority.Critical)).toBe(Priority.Critical);
		expect(parsePriorityValue("nonsense")).toBe(Priority.None);
		expect(parsePriorityValue(null)).toBe(Priority.None);
	});

	it("parseStatusValue: non-empty string or null", () => {
		expect(parseStatusValue("done")).toBe("done");
		expect(parseStatusValue("")).toBeNull();
		expect(parseStatusValue(null)).toBeNull();
	});

	it("parseDateValue: reads epoch ms, null when cleared", () => {
		expect(parseDateValue({ at: 555, granularity: "date" })).toBe(555);
		expect(parseDateValue(null)).toBeNull();
		expect(parseDateValue("nope")).toBeNull();
	});

	it("parseTagsValue: flattens id envelopes, drops blanks", () => {
		expect(parseTagsValue([{ value: "a" }, { value: "" }, { value: "b" }])).toEqual(["a", "b"]);
		expect(parseTagsValue(null)).toEqual([]);
	});

	it("parseDurationValue: hours → whole minutes, null when cleared / non-positive", () => {
		expect(parseDurationValue(1.5)).toBe(90);
		expect(parseDurationValue(0)).toBeNull();
		expect(parseDurationValue(null)).toBeNull();
		expect(parseDurationValue(-2)).toBeNull();
	});
});

describe("custom-field defs (9.14.16)", () => {
	const def = (key: string, name: string): PropertyDef => ({
		key,
		name,
		icon: null,
		valueType: ValueType.Text,
	});
	const catalog = new Map<string, PropertyDef>([
		["p.b", def("p.b", "Beta")],
		["p.a", def("p.a", "Alpha")],
		["p.c", def("p.c", "Gamma")],
	]);

	it("bound defs are the catalog-resolvable keys of the bag, name-sorted", () => {
		const bound = boundCustomDefs({ "p.c": "x", "p.a": "y", "p.gone": "z" }, catalog);
		expect(bound.map((d) => d.key)).toEqual(["p.a", "p.c"]);
	});

	it("unbound defs are the rest of the catalog, name-sorted; empty bag = all", () => {
		expect(unboundCustomDefs({ "p.a": "y" }, catalog).map((d) => d.key)).toEqual(["p.b", "p.c"]);
		expect(unboundCustomDefs(undefined, catalog).map((d) => d.key)).toEqual(["p.a", "p.b", "p.c"]);
	});
});

describe("assignee catalog def (F-152)", () => {
	it("mirrors the dev seeder's def so the Graph edge derives in any vault", async () => {
		const { ASSIGNEE_CATALOG_DEF, PERSON_ENTITY_TYPE: person } = await import("./task-properties");
		expect(ASSIGNEE_CATALOG_DEF.key).toBe("assigneeId");
		expect(ASSIGNEE_CATALOG_DEF.valueType).toBe(ValueType.EntityRef);
		expect(ASSIGNEE_CATALOG_DEF).toMatchObject({
			allowedTypes: [person],
			count: { min: 0, max: 1 },
		});
	});
});
