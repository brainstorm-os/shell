import type { MemberOverrides } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	AddOutcome,
	RemoveOutcome,
	addToList,
	effectiveMembers,
	removeFromList,
} from "./collections";

const inc = (entityId: string): MemberOverrides["include"][number] => ({
	entityId,
	addedAt: 0,
	by: "user",
});
const exc = (entityId: string): MemberOverrides["exclude"][number] => ({
	entityId,
	removedAt: 0,
	by: "user",
});

const sorted = (s: Set<string>) => [...s].sort();

describe("effectiveMembers", () => {
	it("returns the source set unchanged when there are no overrides", () => {
		expect(sorted(effectiveMembers(["a", "b"], { include: [], exclude: [] }))).toEqual(["a", "b"]);
	});

	it("unions include into the source set (Manual / null-source case)", () => {
		expect(sorted(effectiveMembers([], { include: [inc("x")], exclude: [] }))).toEqual(["x"]);
		expect(sorted(effectiveMembers(["a"], { include: [inc("b")], exclude: [] }))).toEqual(["a", "b"]);
	});

	it("removes excluded ids from the source set", () => {
		expect(sorted(effectiveMembers(["a", "b"], { include: [], exclude: [exc("b")] }))).toEqual(["a"]);
	});

	it("exclude wins over both source and include of the same id", () => {
		expect(sorted(effectiveMembers(["a"], { include: [inc("a")], exclude: [exc("a")] }))).toEqual([]);
	});

	it("de-duplicates (an included id already in source isn't doubled)", () => {
		const out = effectiveMembers(["a"], { include: [inc("a")], exclude: [] });
		expect(out.size).toBe(1);
		expect(out.has("a")).toBe(true);
	});

	it("accepts any iterable as the resolved source and never mutates it", () => {
		const source = new Set(["a", "b"]);
		const out = effectiveMembers(source, { include: [inc("c")], exclude: [exc("a")] });
		expect(sorted(out)).toEqual(["b", "c"]);
		expect(sorted(source)).toEqual(["a", "b"]); // input untouched
	});
});

describe("addToList / removeFromList (promoted from Database 9.3.5.V 7c)", () => {
	const empty = (): MemberOverrides => ({ include: [], exclude: [] });
	const ctx = (matchesSource: boolean) => ({ matchesSource, by: "user" as const, now: 42 });

	it("appends to include when source doesn't match (manual add)", () => {
		const r = addToList(empty(), "x", ctx(false));
		expect(r.outcome).toBe(AddOutcome.Included);
		expect(r.members.include.map((m) => m.entityId)).toEqual(["x"]);
		expect(r.members.include[0]?.addedAt).toBe(42);
	});

	it("add is a no-op when the source already matches and nothing is excluded", () => {
		const r = addToList(empty(), "x", ctx(true));
		expect(r.outcome).toBe(AddOutcome.NoOp);
		expect(r.members.include).toEqual([]);
	});

	it("add drops a prior exclude (un-exclude) without re-including a source member", () => {
		const r = addToList({ include: [], exclude: [exc("x")] }, "x", ctx(true));
		expect(r.outcome).toBe(AddOutcome.UnExcluded);
		expect(r.members.exclude).toEqual([]);
		expect(r.members.include).toEqual([]);
	});

	it("remove drops a manual include (un-include)", () => {
		const r = removeFromList({ include: [inc("x")], exclude: [] }, "x", ctx(false));
		expect(r.outcome).toBe(RemoveOutcome.UnIncluded);
		expect(r.members.include).toEqual([]);
	});

	it("remove excludes a source member (matchesSource → append exclude)", () => {
		const r = removeFromList(empty(), "x", ctx(true));
		expect(r.outcome).toBe(RemoveOutcome.Excluded);
		expect(r.members.exclude.map((m) => m.entityId)).toEqual(["x"]);
	});

	it("remove is a no-op for an entity that's neither included nor source-matched", () => {
		const r = removeFromList(empty(), "x", ctx(false));
		expect(r.outcome).toBe(RemoveOutcome.NoOp);
	});
});
