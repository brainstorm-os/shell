import { describe, expect, it } from "vitest";
import { ListSourceKind } from "./list";
import { GENERIC_OBJECT_TYPE, decideRowCreate } from "./list-row";

describe("decideRowCreate", () => {
	it("creates the concrete type for a ByType list and lets the source own it", () => {
		const plan = decideRowCreate({
			source: { kind: ListSourceKind.ByType, types: ["io.brainstorm.tasks/Task/v1"] },
		});
		expect(plan).toEqual({ type: "io.brainstorm.tasks/Task/v1", addToMembers: false });
	});

	it("creates a generic Object + pins it into members for a manual collection", () => {
		const plan = decideRowCreate({ source: null });
		expect(plan).toEqual({ type: GENERIC_OBJECT_TYPE, addToMembers: true });
	});

	it("treats a null active list as a manual collection (generic Object)", () => {
		expect(decideRowCreate(null)).toEqual({ type: GENERIC_OBJECT_TYPE, addToMembers: true });
	});

	it("treats a non-ByType source (e.g. ByFilter) as a manual collection", () => {
		const plan = decideRowCreate({
			source: { kind: ListSourceKind.ByFilter, filter: { all: [] } },
		} as unknown as Parameters<typeof decideRowCreate>[0]);
		expect(plan).toEqual({ type: GENERIC_OBJECT_TYPE, addToMembers: true });
	});

	it("falls back to generic Object when a ByType source has no types", () => {
		const plan = decideRowCreate({
			source: { kind: ListSourceKind.ByType, types: [] },
		});
		expect(plan.type).toBe(GENERIC_OBJECT_TYPE);
		expect(plan.addToMembers).toBe(true);
	});
});
