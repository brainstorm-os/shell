import {
	AGENT_PROVENANCE_PROPERTY_KEY,
	AgentUndoRefusal,
	AgentWriteKind,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { AgentWriteRecord } from "../../storage/entities-repo";
import { UndoOpKind, type UndoTargetState, buildRunChanges, planRunUndo } from "./agent-run-undo";

let seq = 0;
function rec(
	partial: Partial<AgentWriteRecord> & Pick<AgentWriteRecord, "entityId" | "kind">,
): AgentWriteRecord {
	return {
		id: ++seq,
		runId: "run",
		agent: "agent",
		entityType: "t",
		before: null,
		after: {},
		oversize: false,
		ts: 100,
		revertedAt: null,
		...partial,
	};
}

const live = (properties: Record<string, unknown>, updatedAt = 100): UndoTargetState => ({
	properties,
	updatedAt,
	deletedAt: null,
});
const all = () => true;

describe("planRunUndo", () => {
	it("folds create + later update of the same object into one trash", () => {
		const entries = [
			rec({ entityId: "a", kind: AgentWriteKind.Created, after: { title: "x" } }),
			rec({
				entityId: "a",
				kind: AgentWriteKind.Updated,
				before: { present: { title: "x" }, absent: [] },
				after: { title: "y" },
				ts: 110,
			}),
		];
		const plan = planRunUndo(entries, () => live({ title: "y" }, 110), all);
		expect(plan).toEqual({
			ok: true,
			ops: [{ kind: UndoOpKind.Trash, entityId: "a", entityType: "t" }],
		});
	});

	it("restores the value before the FIRST touch across two updates", () => {
		const entries = [
			rec({
				entityId: "a",
				kind: AgentWriteKind.Updated,
				before: { present: { s: "todo" }, absent: [] },
				after: { s: "doing" },
			}),
			rec({
				entityId: "a",
				kind: AgentWriteKind.Updated,
				before: { present: { s: "doing" }, absent: ["n"] },
				after: { s: "done", n: 1 },
			}),
		];
		const plan = planRunUndo(entries, () => live({ s: "done", n: 1, other: true }, 999), all);
		expect(plan).toEqual({
			ok: true,
			ops: [{ kind: UndoOpKind.Patch, entityId: "a", entityType: "t", patch: { s: "todo", n: null } }],
		});
	});

	it("refuses a created object that gained a field or a later write", () => {
		const entries = [rec({ entityId: "a", kind: AgentWriteKind.Created, after: { title: "x" } })];
		expect(planRunUndo(entries, () => live({ title: "x", tag: "mine" }), all)).toMatchObject({
			ok: false,
			reason: AgentUndoRefusal.EditedSince,
			field: "tag",
		});
		expect(planRunUndo(entries, () => live({ title: "x" }, 500), all)).toMatchObject({
			ok: false,
			reason: AgentUndoRefusal.EditedSince,
			field: null,
		});
	});

	it("compares values canonically (key order does not count as an edit)", () => {
		const entries = [
			rec({ entityId: "a", kind: AgentWriteKind.Created, after: { m: { a: 1, b: 2 } } }),
		];
		expect(planRunUndo(entries, () => live({ m: { b: 2, a: 1 } }), all).ok).toBe(true);
	});

	it("skips a created object that is already gone, and reports nothing left", () => {
		const entries = [rec({ entityId: "a", kind: AgentWriteKind.Created, after: { t: 1 } })];
		expect(planRunUndo(entries, () => null, all)).toMatchObject({
			ok: false,
			reason: AgentUndoRefusal.NothingToUndo,
		});
	});

	it("refuses an edited object now in the Bin, and a trashed one restored since", () => {
		const edit = [
			rec({
				entityId: "a",
				kind: AgentWriteKind.Updated,
				before: { present: { s: 1 }, absent: [] },
				after: { s: 2 },
			}),
		];
		expect(
			planRunUndo(edit, () => ({ properties: { s: 2 }, updatedAt: 1, deletedAt: 5 }), all),
		).toMatchObject({ ok: false, reason: AgentUndoRefusal.InBin });
		const trash = [rec({ entityId: "a", kind: AgentWriteKind.Trashed })];
		expect(planRunUndo(trash, () => live({}), all)).toMatchObject({
			ok: false,
			reason: AgentUndoRefusal.EditedSince,
		});
		expect(planRunUndo(trash, () => ({ properties: {}, updatedAt: 1, deletedAt: 5 }), all)).toEqual({
			ok: true,
			ops: [{ kind: UndoOpKind.Restore, entityId: "a", entityType: "t" }],
		});
	});

	it("refuses oversize, denied, and already-undone runs", () => {
		const base = rec({ entityId: "a", kind: AgentWriteKind.Created, after: { t: 1 } });
		expect(planRunUndo([{ ...base, oversize: true }], () => live({ t: 1 }), all)).toMatchObject({
			reason: AgentUndoRefusal.NotRecorded,
		});
		expect(
			planRunUndo(
				[base],
				() => live({ t: 1 }),
				() => false,
			),
		).toMatchObject({
			reason: AgentUndoRefusal.Denied,
		});
		expect(planRunUndo([{ ...base, revertedAt: 1 }], () => live({ t: 1 }), all)).toMatchObject({
			reason: AgentUndoRefusal.AlreadyUndone,
		});
		expect(planRunUndo([], () => null, all)).toMatchObject({
			reason: AgentUndoRefusal.NothingToUndo,
		});
	});
});

describe("buildRunChanges", () => {
	it("projects bounded previews and a line summary for multi-line text", () => {
		const diff = buildRunChanges("run", [
			rec({
				entityId: "a",
				kind: AgentWriteKind.Updated,
				before: { present: { body: "one\ntwo" }, absent: ["tags"] },
				after: { body: "one\nthree\nfour", tags: ["x", "y"] },
			}),
		]);
		expect(diff.changes[0]?.fields).toEqual([
			{ key: "body", before: "one two", after: "one three four", lines: { added: 2, removed: 1 } },
			{ key: "tags", before: null, after: "x, y" },
		]);
		expect(diff.revertedAt).toBeNull();
	});

	it("lists only the fields the agent chose: no host bookkeeping, no empty bags", () => {
		const diff = buildRunChanges("run", [
			rec({
				entityId: "a",
				kind: AgentWriteKind.Created,
				before: null,
				after: {
					title: "Signage checklist",
					values: {},
					createdAt: 1792445200119,
					updatedAt: 1792445200119,
					[AGENT_PROVENANCE_PROPERTY_KEY]: { runId: "run" },
				},
			}),
		]);
		expect(diff.changes[0]?.fields).toEqual([
			{ key: "title", before: null, after: "Signage checklist" },
		]);
		expect(diff.changes[0]?.moreFields).toBe(0);
	});
});
