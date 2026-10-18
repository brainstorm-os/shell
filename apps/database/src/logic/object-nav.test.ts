import { describe, expect, it } from "vitest";
import { ObjectNavDirection, ObjectOpenMode, objectNavPosition, stepObjectNav } from "./object-nav";

const ctx = { viewId: "v", entityId: "b", mode: ObjectOpenMode.QuickLook };

describe("object nav (9.12.34)", () => {
	it("reports position against the live order", () => {
		expect(objectNavPosition(ctx, ["a", "b", "c"])).toEqual({
			index: 1,
			total: 3,
			hasPrev: true,
			hasNext: true,
		});
		expect(objectNavPosition(ctx, ["b"])).toEqual({
			index: 0,
			total: 1,
			hasPrev: false,
			hasNext: false,
		});
		expect(objectNavPosition(ctx, ["a", "c"])).toBeNull();
	});

	it("steps to the neighbour, keeping the open mode, and stops at the ends", () => {
		expect(stepObjectNav(ctx, ["a", "b", "c"], ObjectNavDirection.Next)).toEqual({
			...ctx,
			entityId: "c",
		});
		expect(stepObjectNav(ctx, ["a", "b", "c"], ObjectNavDirection.Previous)?.entityId).toBe("a");
		expect(stepObjectNav(ctx, ["b", "c"], ObjectNavDirection.Previous)).toBeNull();
		expect(stepObjectNav(ctx, ["a", "b"], ObjectNavDirection.Next)).toBeNull();
	});

	it("follows a re-sorted order", () => {
		expect(stepObjectNav(ctx, ["c", "b", "a"], ObjectNavDirection.Next)?.entityId).toBe("a");
	});
});
