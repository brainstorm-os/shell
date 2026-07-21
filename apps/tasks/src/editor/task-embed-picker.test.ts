// @vitest-environment jsdom
import type { VaultEntity } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { filterTaskEntities, taskEntityTitle } from "./task-embed-picker-plugin";

function task(id: string, name: unknown, type = "brainstorm/Task/v1"): VaultEntity {
	return {
		id,
		type,
		properties: { name },
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
		ownerAppId: "io.brainstorm.tasks",
	};
}

describe("filterTaskEntities", () => {
	const entities: readonly VaultEntity[] = [
		task("t1", "Ship the spec"),
		task("t2", "Draft the brief"),
		task("p1", "A project", "brainstorm/Project/v1"),
		task("t3", "Review spec PR"),
	];

	it("returns only Task entities, dropping other types", () => {
		const out = filterTaskEntities(entities, "", null);
		expect(out.map((e) => e.id)).toEqual(["t1", "t2", "t3"]);
	});

	it("filters by case-insensitive title substring", () => {
		const out = filterTaskEntities(entities, "SPEC", null);
		expect(out.map((e) => e.id)).toEqual(["t1", "t3"]);
	});

	it("excludes the current task so a task can't embed itself", () => {
		const out = filterTaskEntities(entities, "spec", "t1");
		expect(out.map((e) => e.id)).toEqual(["t3"]);
	});

	it("returns all tasks for an empty query", () => {
		expect(filterTaskEntities(entities, "   ", null)).toHaveLength(3);
	});
});

describe("taskEntityTitle", () => {
	it("uses the name property", () => {
		expect(taskEntityTitle(task("t", "Real name"))).toBe("Real name");
	});

	it("falls back to the untitled label when name is empty / non-string", () => {
		expect(taskEntityTitle(task("t", "   "))).toBe("Untitled task");
		expect(taskEntityTitle(task("t", 42))).toBe("Untitled task");
	});
});
