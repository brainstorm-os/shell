import { describe, expect, it } from "vitest";
import type { Entity } from "../types/entity";
import {
	DEFAULT_SORT_DIRECTION,
	DEFAULT_SORT_KEY,
	SortDirection,
	SortKey,
	defaultDirectionFor,
	sortEntities,
} from "./sort";

function file(id: string, name: string, created: number, updated: number, size = 0): Entity {
	return {
		id,
		type: "brainstorm/File/v1",
		properties: { name, mime: "text/plain", size },
		createdAt: created,
		updatedAt: updated,
		deletedAt: null,
	};
}

describe("sort", () => {
	const a = file("a", "Beta", 100, 200);
	const b = file("b", "alpha", 50, 400);
	const c = file("c", "file2", 300, 100);
	const d = file("d", "file10", 200, 300);
	const all = [a, b, c, d];

	it("defaults to Manual / Asc", () => {
		expect(DEFAULT_SORT_KEY).toBe(SortKey.Manual);
		expect(DEFAULT_SORT_DIRECTION).toBe(SortDirection.Asc);
	});

	it("dates + size default to descending so newest / largest is first", () => {
		expect(defaultDirectionFor(SortKey.Created)).toBe(SortDirection.Desc);
		expect(defaultDirectionFor(SortKey.Modified)).toBe(SortDirection.Desc);
		expect(defaultDirectionFor(SortKey.Size)).toBe(SortDirection.Desc);
		expect(defaultDirectionFor(SortKey.Name)).toBe(SortDirection.Asc);
		expect(defaultDirectionFor(SortKey.Manual)).toBe(SortDirection.Asc);
	});

	it("Size desc puts the largest file first; sizeless rows sort as 0", () => {
		const big = file("big", "big.bin", 0, 0, 5000);
		const small = file("small", "small.txt", 0, 0, 10);
		const folder: Entity = {
			id: "folder",
			type: "brainstorm/Folder/v1",
			properties: { name: "Docs", members: [] },
			createdAt: 0,
			updatedAt: 0,
			deletedAt: null,
		};
		const out = sortEntities([small, folder, big], SortKey.Size, SortDirection.Desc);
		expect(out.map((e) => e.id)).toEqual(["big", "small", "folder"]);
	});

	it("Manual returns the input order as a defensive copy", () => {
		const out = sortEntities(all, SortKey.Manual, SortDirection.Asc);
		expect(out.map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
		expect(out).not.toBe(all);
	});

	it("Name sort is case-insensitive and numeric (file2 < file10)", () => {
		const out = sortEntities(all, SortKey.Name, SortDirection.Asc);
		// alpha, Beta, file2, file10
		expect(out.map((e) => e.id)).toEqual(["b", "a", "c", "d"]);
	});

	it("Name desc reverses the order", () => {
		const out = sortEntities(all, SortKey.Name, SortDirection.Desc);
		expect(out.map((e) => e.id)).toEqual(["d", "c", "a", "b"]);
	});

	it("Modified desc puts most-recently-updated first", () => {
		const out = sortEntities(all, SortKey.Modified, SortDirection.Desc);
		expect(out.map((e) => e.id)).toEqual(["b", "d", "a", "c"]);
	});

	it("Created asc puts oldest first", () => {
		const out = sortEntities(all, SortKey.Created, SortDirection.Asc);
		expect(out.map((e) => e.id)).toEqual(["b", "a", "d", "c"]);
	});
});

describe("untitled-last name sort (F-424)", () => {
	const named = (id: string, name: string): Entity =>
		({
			id,
			type: "brainstorm/File/v1",
			properties: { name },
			createdAt: 1,
			updatedAt: 1,
		}) as unknown as Entity;
	const untitled = (id: string): Entity =>
		({
			id,
			type: "brainstorm/Note/v1",
			properties: {},
			createdAt: 1,
			updatedAt: 1,
		}) as unknown as Entity;

	it("sinks untitled entities below named ones ascending", () => {
		const out = sortEntities(
			[untitled("u1"), named("a", "alpha"), untitled("u2"), named("z", "zulu")],
			SortKey.Name,
			SortDirection.Asc,
		);
		expect(out.map((e) => e.id)).toEqual(["a", "z", "u1", "u2"]);
	});

	it("keeps untitled entities last even descending", () => {
		const out = sortEntities(
			[untitled("u1"), named("a", "alpha"), named("z", "zulu")],
			SortKey.Name,
			SortDirection.Desc,
		);
		expect(out.map((e) => e.id)).toEqual(["z", "a", "u1"]);
	});
});
