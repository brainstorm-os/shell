import { describe, expect, it } from "vitest";
import { GroupOrderMode } from "../types/list-view";
import {
	type BoardGroup,
	CollapseAllAction,
	buildSwimlanes,
	cellMovePatch,
	collapseAllPatch,
	laneCells,
	manualGroupOrderActive,
	orderBoardGroups,
	toggleCollapsed,
} from "./board-groups";
import type { EntityRow } from "./in-memory-entities";

function row(id: string, properties: Record<string, unknown>): EntityRow {
	return { id, type: "t", properties, createdAt: 0, updatedAt: 0, deletedAt: null };
}

const group = (key: string | null, n: number): BoardGroup => ({
	key,
	label: key ?? "None",
	rows: Array.from({ length: n }, (_, i) => row(`${key}-${i}`, {})),
});

describe("orderBoardGroups", () => {
	const groups = [group("a", 1), group("b", 3), group(null, 2), group("c", 3)];

	it("keeps data order by default", () => {
		expect(orderBoardGroups(groups, {}).map((g) => g.key)).toEqual(["a", "b", null, "c"]);
	});

	it("honours a manual groupOrder, unlisted keys after", () => {
		const out = orderBoardGroups(groups, { groupOrder: ["c", ""] });
		expect(out.map((g) => g.key)).toEqual(["c", null, "a", "b"]);
	});

	it("sorts by item count, stable on ties, ignoring groupOrder", () => {
		const desc = orderBoardGroups(groups, {
			groupOrder: ["a"],
			groupOrderMode: GroupOrderMode.CountDesc,
		});
		expect(desc.map((g) => g.key)).toEqual(["b", "c", null, "a"]);
		const asc = orderBoardGroups(groups, { groupOrderMode: GroupOrderMode.CountAsc });
		expect(asc.map((g) => g.key)).toEqual(["a", null, "b", "c"]);
	});

	it("disables manual reorder in count modes", () => {
		expect(manualGroupOrderActive({})).toBe(true);
		expect(manualGroupOrderActive({ groupOrderMode: GroupOrderMode.CountAsc })).toBe(false);
	});
});

describe("swimlanes", () => {
	const rows = [
		row("1", { status: "todo", owner: "ann" }),
		row("2", { status: "done", owner: "bob" }),
		row("3", { status: "todo", owner: "bob" }),
		row("4", { status: "todo" }),
	];

	it("buckets rows into lanes with the null lane", () => {
		const lanes = buildSwimlanes(rows, "owner");
		expect(lanes.map((l) => [l.key, l.rows.length])).toEqual([
			["ann", 1],
			["bob", 2],
			[null, 1],
		]);
	});

	it("splits a lane across every column key", () => {
		const bob = buildSwimlanes(rows, "owner")[1] as BoardGroup;
		const cells = laneCells(bob.rows, "status", ["todo", "done", "doing"]);
		expect(cells.get("todo")?.map((r) => r.id)).toEqual(["3"]);
		expect(cells.get("done")?.map((r) => r.id)).toEqual(["2"]);
		expect(cells.get("doing")).toEqual([]);
	});
});

describe("cellMovePatch", () => {
	const card = row("1", { status: "todo", owner: "ann" });

	it("writes both axes in one patch", () => {
		expect(cellMovePatch(card, "status", "done", "owner", "bob")).toEqual({
			status: "done",
			owner: "bob",
		});
	});

	it("only writes what changed; null clears", () => {
		expect(cellMovePatch(card, "status", "todo", "owner", null)).toEqual({ owner: "" });
		expect(cellMovePatch(card, "status", "done", null, "bob")).toEqual({ status: "done" });
		expect(cellMovePatch(card, "status", "todo", "owner", "ann")).toEqual({});
	});
});

describe("collapse sets", () => {
	it("toggles a key", () => {
		expect(toggleCollapsed(undefined, "a")).toEqual(["a"]);
		expect(toggleCollapsed(["a", "b"], "a")).toEqual(["b"]);
	});

	it("collapse-all targets lanes on a laned board, columns otherwise", () => {
		expect(collapseAllPatch({ swimlaneBy: "owner" }, ["x"], CollapseAllAction.Collapse)).toEqual({
			collapsedLanes: ["x"],
		});
		expect(collapseAllPatch({}, ["x", ""], CollapseAllAction.Collapse)).toEqual({
			collapsedGroups: ["x", ""],
		});
		expect(collapseAllPatch({}, ["x"], CollapseAllAction.Expand)).toEqual({ collapsedGroups: [] });
	});
});
