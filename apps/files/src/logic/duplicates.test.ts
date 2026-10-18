import { describe, expect, it } from "vitest";
import { type Entity, FILE_TYPE, FOLDER_TYPE } from "../types/entity";
import { findDuplicateGroups } from "./duplicates";

function file(id: string, hash: string | undefined, size: number, createdAt: number): Entity {
	return {
		id,
		type: FILE_TYPE,
		properties: {
			name: `${id}.bin`,
			mime: "application/octet-stream",
			size,
			...(hash ? { hash } : {}),
		},
		createdAt,
		updatedAt: createdAt,
		deletedAt: null,
	};
}

describe("findDuplicateGroups", () => {
	it("groups by content hash and keeps only groups of two or more", () => {
		const groups = findDuplicateGroups([
			file("a2", "aaa", 100, 2),
			file("a1", "aaa", 100, 1),
			file("solo", "bbb", 999, 1),
			file("nohash", undefined, 100, 1),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.hash).toBe("aaa");
		expect(groups[0]?.entities.map((e) => e.id)).toEqual(["a1", "a2"]);
		expect(groups[0]?.reclaimableBytes).toBe(100);
	});

	it("orders groups by reclaimable bytes, biggest first", () => {
		const groups = findDuplicateGroups([
			file("s1", "small", 10, 1),
			file("s2", "small", 10, 2),
			file("s3", "small", 10, 3),
			file("b1", "big", 1000, 1),
			file("b2", "big", 1000, 2),
		]);
		expect(groups.map((g) => g.hash)).toEqual(["big", "small"]);
		expect(groups[1]?.reclaimableBytes).toBe(20);
	});

	it("ignores deleted rows and non-file entities", () => {
		const deleted = { ...file("d", "aaa", 5, 1), deletedAt: 9 };
		const folderWithHash: Entity = {
			...file("f", "aaa", 5, 1),
			type: FOLDER_TYPE,
		};
		expect(findDuplicateGroups([file("a", "aaa", 5, 1), deleted, folderWithHash])).toEqual([]);
	});
});
