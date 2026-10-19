/**
 * 9.16.14 — a locked List refuses every membership write. The lock is the
 * shared `properties.locked` reading; these pin each pure writer.
 */

import { describe, expect, it } from "vitest";
import type { List } from "../types/list";
import { BulkUndoKind, planBulkAddToList, revertBulkAdd } from "./bulk-edit";
import { acceptsFileDrop, membersWithDroppedFiles } from "./file-drop";
import type { EntityRow, InMemoryEntities } from "./in-memory-entities";
import { isListLocked, withLiveListLocks } from "./list-lock";
import { serializeListForReconcile } from "./list-persistence";
import { decideToggleMembership } from "./toggle-membership";

function entity(id: string, type: string, properties: Record<string, unknown> = {}): EntityRow {
	return { id, type, properties, createdAt: 0, updatedAt: 0, deletedAt: null };
}

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

const ROWS = [entity("a", "io.test/Task/v1"), entity("b", "io.test/Task/v1")];
const DB: InMemoryEntities = { entities: ROWS, links: [] };
const LOCKED = makeList({ locked: true });

describe("locked List refuses membership writes (9.16.14)", () => {
	it("reads only a literal true as locked", () => {
		expect(isListLocked(LOCKED)).toBe(true);
		expect(isListLocked(makeList())).toBe(false);
		expect(isListLocked(null)).toBe(false);
	});

	it("refreshes the lock from the live List entity row", () => {
		const live = [entity("l1", "brainstorm/List/v1", { locked: true })];
		const [locked] = withLiveListLocks([makeList()], live);
		expect(locked?.locked).toBe(true);
		const [unlocked] = withLiveListLocks([LOCKED], [entity("l1", "brainstorm/List/v1", {})]);
		expect(isListLocked(unlocked)).toBe(false);
	});

	it("toggle add / remove skips a locked List", () => {
		for (const add of [true, false]) {
			const decision = decideToggleMembership({
				listId: "l1",
				entityId: "a",
				add,
				lists: [
					makeList({
						locked: true,
						members: { include: add ? [] : [{ entityId: "a", addedAt: 0, by: "user" }], exclude: [] },
					}),
				],
				db: DB,
				isVaultDerived: () => false,
			});
			expect(decision).toEqual({ kind: "skip", reason: "locked" });
		}
	});

	it("bulk add writes nothing to a locked List", () => {
		const plan = planBulkAddToList(LOCKED, ROWS, new Set(["a", "b"]), DB, 1);
		expect(plan.added).toBe(0);
		expect(plan.listLocked).toBe(true);
		expect(plan.next).toBe(LOCKED);
	});

	it("a bulk-add undo leaves a List locked since the batch alone", () => {
		const plan = planBulkAddToList(makeList(), ROWS, new Set(["a"]), DB, 1);
		if (plan.undo.kind !== BulkUndoKind.AddToCollection) throw new Error("kind");
		const lockedLater = { ...plan.next, locked: true as const };
		expect(revertBulkAdd(lockedLater, plan.undo, 2)).toBe(lockedLater);
	});

	it("a locked List takes no file drop", () => {
		expect(acceptsFileDrop(LOCKED, false)).toBe(false);
		expect(membersWithDroppedFiles(LOCKED, false, ["f1"], 1).members).toBeNull();
	});

	it("a lock flip alone never reads as a dirty List to re-save", () => {
		expect(serializeListForReconcile(LOCKED)).toBe(serializeListForReconcile(makeList()));
	});
});
