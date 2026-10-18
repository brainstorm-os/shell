import { describe, expect, it } from "vitest";
import type { List } from "../types/list";
import { BulkUndoKind, planBulkAddToList, planBulkSet } from "./bulk-edit";
import type { EntityRow, InMemoryEntities } from "./in-memory-entities";

const NOW = 1_700_000_000_000;

function entity(id: string, properties: Record<string, unknown> = {}): EntityRow {
	return { id, type: "io.test/Task/v1", properties, createdAt: 0, updatedAt: 0, deletedAt: null };
}

const ROWS = [
	entity("a", { status: "todo" }),
	entity("b", { status: "done" }),
	entity("c", { status: "todo", locked: true }),
	entity("d"),
];
const DB: InMemoryEntities = { entities: ROWS, links: [] };

function makeList(partial: Partial<List> = {}): List {
	return {
		id: "l1",
		name: "Sprint",
		icon: null,
		description: "",
		source: null,
		members: { include: [], exclude: [] },
		views: [],
		defaultViewId: null,
		defaultTemplate: null,
		createdAt: 0,
		updatedAt: 0,
		...partial,
	};
}

describe("planBulkSet (9.12.32)", () => {
	it("patches only changed, unlocked, selected rows and captures one inverse", () => {
		const plan = planBulkSet(ROWS, new Set(["a", "b", "c", "d"]), "status", "done");
		expect(plan.apply).toEqual([
			{ id: "a", patch: { status: "done" } },
			{ id: "d", patch: { status: "done" } },
		]);
		expect(plan.lockedSkipped).toBe(1);
		expect(plan.undo).toEqual({
			kind: BulkUndoKind.SetProperty,
			revert: [
				{ id: "a", patch: { status: "todo" } },
				{ id: "d", patch: { status: null } },
			],
		});
	});

	it("ignores rows outside the selection", () => {
		expect(planBulkSet(ROWS, new Set(["b"]), "status", "todo").apply).toEqual([
			{ id: "b", patch: { status: "todo" } },
		]);
	});
});

describe("planBulkAddToList (9.12.32)", () => {
	it("adds every unlocked selected row in one members write", () => {
		const list = makeList();
		const plan = planBulkAddToList(list, ROWS, new Set(["a", "c", "d"]), DB, NOW);
		expect(plan.added).toBe(2);
		expect(plan.lockedSkipped).toBe(1);
		expect(plan.next.members.include.map((m) => m.entityId)).toEqual(["a", "d"]);
		expect(plan.next.updatedAt).toBe(NOW);
		expect(plan.undo).toEqual({ kind: BulkUndoKind.AddToCollection, listId: "l1", previous: list });
	});

	it("counts nothing for rows already in the list", () => {
		const list = makeList({
			members: { include: [{ entityId: "a", addedAt: 0, by: "user" }], exclude: [] },
		});
		const plan = planBulkAddToList(list, ROWS, new Set(["a"]), DB, NOW);
		expect(plan.added).toBe(0);
		expect(plan.next).toBe(list);
	});
});
