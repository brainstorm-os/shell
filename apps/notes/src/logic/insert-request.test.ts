import { InsertPosition } from "@brainstorm/sdk-types";
import { describe, expect, it } from "vitest";
import { InsertRefusal, decideInsertIntent, refusalNoticeKey } from "./insert-request";

const NOTE_TYPE = "io.brainstorm.notes/Note/v1";

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		entityId: "note-1",
		entityType: NOTE_TYPE,
		position: InsertPosition.End,
		markdown: "## Reply\n\nBody.",
		...over,
	};
}

const store = (over: Partial<{ has: boolean; locked: boolean }> = {}) => ({
	hasNote: () => over.has ?? true,
	isLocked: () => over.locked ?? false,
});

describe("decideInsertIntent (fail-closed refusal matrix)", () => {
	it("ignores non-insert verbs (caller's other handlers run)", () => {
		expect(decideInsertIntent("open", payload(), store())).toBeNull();
		expect(decideInsertIntent("compose", payload(), store())).toBeNull();
	});

	it("accepts a valid payload for an existing, unlocked note", () => {
		const decision = decideInsertIntent("insert", payload(), store());
		expect(decision).toEqual({
			kind: "accept",
			noteId: "note-1",
			markdown: "## Reply\n\nBody.",
		});
	});

	it("refuses a malformed payload (missing markdown / wrong position / no payload)", () => {
		const cases: Array<Record<string, unknown> | undefined> = [
			undefined,
			payload({ markdown: "" }),
			payload({ position: "start" }),
			payload({ entityId: 42 }),
		];
		for (const p of cases) {
			expect(decideInsertIntent("insert", p, store())).toEqual({
				kind: "refuse",
				refusal: InsertRefusal.Malformed,
			});
		}
	});

	it("refuses a payload targeting a different entity type (mis-route)", () => {
		const decision = decideInsertIntent(
			"insert",
			payload({ entityType: "io.brainstorm.tasks/Task/v1" }),
			store(),
		);
		expect(decision).toEqual({ kind: "refuse", refusal: InsertRefusal.Malformed });
	});

	it("refuses an unknown target note (insert never creates)", () => {
		const decision = decideInsertIntent("insert", payload(), store({ has: false }));
		expect(decision).toEqual({ kind: "refuse", refusal: InsertRefusal.UnknownNote });
	});

	it("refuses a locked target note", () => {
		const decision = decideInsertIntent("insert", payload(), store({ locked: true }));
		expect(decision).toEqual({ kind: "refuse", refusal: InsertRefusal.Locked });
	});
});

describe("refusalNoticeKey", () => {
	it("maps every refusal to a distinct i18n key", () => {
		const keys = Object.values(InsertRefusal).map((r) => refusalNoticeKey(r));
		expect(new Set(keys).size).toBe(keys.length);
		for (const key of keys) expect(key).toMatch(/^notes\.insert\.refused\./);
	});
});
