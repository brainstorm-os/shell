import { MEMBERS_HARD_CAP } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { type List, ListSourceKind } from "../types";
import { acceptsFileDrop, membersWithDroppedFiles } from "./file-drop";

function list(source: List["source"]): List {
	return {
		id: "l",
		name: "L",
		icon: null,
		description: "",
		source,
		members: { include: [], exclude: [] },
		views: [],
		defaultViewId: null,
		defaultTemplate: null,
		createdAt: 0,
		updatedAt: 0,
	};
}

const FILES = list({ kind: ListSourceKind.ByType, types: ["brainstorm/File/v1"] });
const TASKS = list({ kind: ListSourceKind.ByType, types: ["io.test/Task/v1"] });
const MANUAL = list(null);

describe("file drop into a collection (9.8.17)", () => {
	it("accepts on user collections and on a vault list that already shows files", () => {
		expect(acceptsFileDrop(MANUAL, false)).toBe(true);
		expect(acceptsFileDrop(TASKS, false)).toBe(true);
		expect(acceptsFileDrop(FILES, true)).toBe(true);
		expect(acceptsFileDrop(TASKS, true)).toBe(false);
		expect(acceptsFileDrop(null, false)).toBe(false);
	});

	it("pins new files unless the source already shows them", () => {
		expect(
			membersWithDroppedFiles(MANUAL, false, ["f1", "f2"], 1).members?.include.map((m) => m.entityId),
		).toEqual(["f1", "f2"]);
		expect(membersWithDroppedFiles(FILES, false, ["f1"], 1).members).toBeNull();
		expect(membersWithDroppedFiles(FILES, true, ["f1"], 1).members).toBeNull();
		expect(membersWithDroppedFiles(MANUAL, false, [], 1).members).toBeNull();
	});

	it("counts files past the members cap instead of throwing", () => {
		const full = {
			...MANUAL,
			members: {
				include: Array.from({ length: MEMBERS_HARD_CAP }, (_, i) => ({
					entityId: `m${i}`,
					addedAt: 0,
					by: "user" as const,
				})),
				exclude: [],
			},
		};
		const result = membersWithDroppedFiles(full, false, ["f1", "f2"], 1);
		expect(result.overCapacity).toBe(2);
		expect(result.members).toBeNull();
	});
});
