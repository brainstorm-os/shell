import { describe, expect, it } from "vitest";
import type { List } from "../types/list";
import {
	BULK_UNDO_TTL_MS,
	BulkUndoKind,
	isBulkUndoLive,
	planBulkAddToList,
	planBulkSet,
	planBulkSetRevert,
	revertBulkAdd,
} from "./bulk-edit";
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
		const plan = planBulkSet(ROWS, new Set(["a", "b", "c", "d"]), "status", "done", NOW);
		expect(plan.apply).toEqual([
			{ id: "a", patch: { status: "done" } },
			{ id: "d", patch: { status: "done" } },
		]);
		expect(plan.lockedSkipped).toBe(1);
		expect(plan.undo).toEqual({
			kind: BulkUndoKind.SetProperty,
			at: NOW,
			propertyId: "status",
			applied: "done",
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
		expect(plan.undo).toEqual({
			kind: BulkUndoKind.AddToCollection,
			at: NOW,
			listId: "l1",
			included: ["a", "d"],
			unexcluded: [],
		});
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

describe("bulk undo stays targeted and expires (9.12.32)", () => {
	it("expires after the TTL", () => {
		const { undo } = planBulkSet(ROWS, new Set(["a"]), "status", "done", NOW);
		expect(isBulkUndoLive(undo, NOW + 1_000)).toBe(true);
		expect(isBulkUndoLive(undo, NOW + BULK_UNDO_TTL_MS + 1)).toBe(false);
		expect(isBulkUndoLive(null, NOW)).toBe(false);
	});

	it("never reverts a row locked or edited since the batch", () => {
		const { undo } = planBulkSet(ROWS, new Set(["a", "d"]), "status", "done", NOW);
		if (undo.kind !== BulkUndoKind.SetProperty) throw new Error("kind");
		const later = [
			entity("a", { status: "done", locked: true }),
			entity("d", { status: "edited later" }),
		];
		const revert = planBulkSetRevert(undo, later);
		expect(revert.apply).toEqual([]);
		expect(revert.lockedSkipped).toBe(1);
		expect(revert.changedSkipped).toBe(1);
		const untouched = planBulkSetRevert(undo, [entity("a", { status: "done" })]);
		expect(untouched.apply).toEqual([{ id: "a", patch: { status: "todo" } }]);
	});

	it("takes back only the batch's members, keeping later list edits", () => {
		const lifted = { entityId: "d", removedAt: 1, by: "user" as const };
		const list = makeList({ members: { include: [], exclude: [lifted] } });
		const plan = planBulkAddToList(list, ROWS, new Set(["a", "d"]), DB, NOW);
		if (plan.undo.kind !== BulkUndoKind.AddToCollection) throw new Error("kind");
		const renamedLater = {
			...plan.next,
			name: "Renamed",
			members: {
				...plan.next.members,
				include: [...plan.next.members.include, { entityId: "z", addedAt: 2, by: "user" as const }],
			},
		};
		const reverted = revertBulkAdd(renamedLater, plan.undo, NOW + 5);
		expect(reverted.name).toBe("Renamed");
		expect(reverted.members.include.map((m) => m.entityId)).toEqual(["z"]);
		expect(reverted.members.exclude).toEqual([lifted]);
	});
});
