import { describe, expect, test } from "vitest";
import { IconKind } from "../types/icon";
import type { List } from "../types/list";
import { ListSourceKind } from "../types/list-source";
import { type ListView, ListViewKind } from "../types/list-view";
import {
	createList,
	createView,
	deleteList,
	deleteView,
	duplicateList,
	duplicateView,
	renameList,
	renameView,
	resolveListView,
	seedColumnsForNewView,
	setListDescription,
	setListIcon,
	uniqueName,
} from "./list-crud";

const emptyList = (id: string, name: string): List => ({
	id,
	name,
	icon: null,
	description: "",
	source: null,
	members: { include: [], exclude: [] },
	views: [],
	defaultViewId: null,
	defaultTemplate: null,
	createdAt: 0,
	updatedAt: 0,
});

const emptyView = (id: string, listId: string, name: string): ListView => ({
	id,
	listId,
	name,
	icon: null,
	kind: ListViewKind.Grid,
	filters: null,
	sorts: [],
	groupBy: null,
	coverProperty: null,
	cardSubtitleProperty: null,
	columns: [],
	defaultTypeUrl: null,
	defaultTemplate: null,
	pageSize: 50,
	layoutOptions: { rowHeight: "comfortable", showRowNumbers: false, pinFirstColumn: true },
});

describe("uniqueName", () => {
	test("returns base when no collision", () => {
		expect(uniqueName("New list", [{ name: "Tasks" }])).toBe("New list");
	});

	test("appends 2 on first collision", () => {
		expect(uniqueName("New list", [{ name: "New list" }])).toBe("New list 2");
	});

	test("walks the counter past existing copies", () => {
		expect(
			uniqueName("New list", [{ name: "New list" }, { name: "New list 2" }, { name: "New list 3" }]),
		).toBe("New list 4");
	});
});

describe("createList", () => {
	test("produces a list with a single default Grid view", () => {
		const { list, view } = createList({ name: "Tasks", existingLists: [] });
		expect(list.name).toBe("Tasks");
		expect(list.views).toEqual([view.id]);
		expect(list.defaultViewId).toBe(view.id);
		expect(view.kind).toBe(ListViewKind.Grid);
		expect(view.listId).toBe(list.id);
	});

	test("avoids name collisions via uniqueName", () => {
		const { list } = createList({
			name: "New list",
			existingLists: [emptyList("a", "New list")],
		});
		expect(list.name).toBe("New list 2");
	});

	test("defaults to a null source with no columns (legacy empty list)", () => {
		const { list, view } = createList({ name: "Blank", existingLists: [] });
		expect(list.source).toBeNull();
		expect(view.columns).toEqual([]);
	});

	test("threads a provided source + columns onto the list and its view", () => {
		const { list, view } = createList({
			name: "Tasks",
			existingLists: [],
			source: { kind: ListSourceKind.ByType, types: ["brainstorm/Task/v1"] },
			columnIds: ["name", "statusKey", "dueAt"],
		});
		expect(list.source).toEqual({
			kind: ListSourceKind.ByType,
			types: ["brainstorm/Task/v1"],
		});
		expect(view.columns.map((c) => c.propertyId)).toEqual(["name", "statusKey", "dueAt"]);
		// First column gets the wider title width; the rest the default.
		expect(view.columns[0]?.width).toBe(280);
		expect(view.columns[1]?.width).toBe(160);
		expect(view.columns.every((c) => c.visible)).toBe(true);
	});
});

describe("renameList", () => {
	test("trims and updates the name + updatedAt", () => {
		const list = emptyList("a", "Tasks");
		const renamed = renameList(list, "  Errands  ");
		expect(renamed.name).toBe("Errands");
		expect(renamed.updatedAt).toBeGreaterThan(list.updatedAt);
	});

	test("returns the same instance when name is unchanged or empty", () => {
		const list = emptyList("a", "Tasks");
		expect(renameList(list, "Tasks")).toBe(list);
		expect(renameList(list, "   ")).toBe(list);
	});
});

describe("setListDescription (9.12.27)", () => {
	test("trims and updates the description + updatedAt", () => {
		const list = emptyList("a", "Tasks");
		const next = setListDescription(list, "  Everything due this week  ");
		expect(next.description).toBe("Everything due this week");
		expect(next.updatedAt).toBeGreaterThan(list.updatedAt);
	});

	test("clears to empty, and returns the same instance when unchanged", () => {
		const described = { ...emptyList("a", "Tasks"), description: "Due soon" };
		expect(setListDescription(described, "   ").description).toBe("");
		expect(setListDescription(described, "Due soon ")).toBe(described);
	});
});

describe("setListIcon", () => {
	test("sets the list's own icon + bumps updatedAt", () => {
		const list = emptyList("a", "Tasks");
		const next = setListIcon(list, { kind: IconKind.Emoji, value: "🗂️" });
		expect(next.icon).toEqual({ kind: IconKind.Emoji, value: "🗂️" });
		expect(next.updatedAt).toBeGreaterThan(list.updatedAt);
	});

	test("clears the icon with null", () => {
		const list = { ...emptyList("a", "Tasks"), icon: { kind: IconKind.Emoji, value: "🗂️" } };
		expect(setListIcon(list, null).icon).toBeNull();
	});

	test("returns the same instance when the icon is unchanged", () => {
		const list = { ...emptyList("a", "Tasks"), icon: { kind: IconKind.Emoji, value: "🗂️" } };
		expect(setListIcon(list, { kind: IconKind.Emoji, value: "🗂️" })).toBe(list);
		const iconless = emptyList("b", "x");
		expect(setListIcon(iconless, null)).toBe(iconless);
	});

	test("distinguishes pack tint changes", () => {
		const list = {
			...emptyList("a", "Tasks"),
			icon: { kind: IconKind.Pack, value: "phosphor/folder", color: "accent" },
		};
		expect(setListIcon(list, { kind: IconKind.Pack, value: "phosphor/folder" })).not.toBe(list);
	});
});

describe("duplicateList", () => {
	test("clones the list + all its views with fresh ids", () => {
		const source = { ...emptyList("a", "Tasks"), views: ["v1", "v2"], defaultViewId: "v1" };
		const v1 = emptyView("v1", "a", "Grid");
		const v2 = emptyView("v2", "a", "Board");
		const { list, views } = duplicateList(source, [v1, v2], [source]);
		expect(list.id).not.toBe("a");
		expect(list.name).toBe("Tasks copy");
		expect(views).toHaveLength(2);
		expect(views[0]?.id).not.toBe("v1");
		expect(views[1]?.id).not.toBe("v2");
		expect(views.every((v) => v.listId === list.id)).toBe(true);
		expect(list.views).toEqual(views.map((v) => v.id));
		expect(list.defaultViewId).toBe(views[0]?.id);
	});

	test("doesn't clone views belonging to other lists", () => {
		const source = emptyList("a", "Tasks");
		const orphan = emptyView("orphan", "other-list", "Not mine");
		const { views } = duplicateList(source, [orphan], [source]);
		expect(views).toHaveLength(0);
	});
});

describe("deleteList", () => {
	test("removes the list + every view that referenced it", () => {
		const lists = [emptyList("a", "A"), emptyList("b", "B")];
		const views = [emptyView("v1", "a", "G"), emptyView("v2", "b", "G"), emptyView("v3", "a", "B")];
		const result = deleteList(lists, views, "a");
		expect(result.lists.map((l) => l.id)).toEqual(["b"]);
		expect(result.views.map((v) => v.id)).toEqual(["v2"]);
	});
});

describe("createView", () => {
	test("defaults to Grid and uses a unique name", () => {
		const v = createView({
			listId: "a",
			name: "View",
			existingViewsForList: [emptyView("v1", "a", "View")],
		});
		expect(v.kind).toBe(ListViewKind.Grid);
		expect(v.name).toBe("View 2");
		expect(v.listId).toBe("a");
	});

	test("seeds a kind-appropriate layoutOptions", () => {
		const board = createView({
			listId: "a",
			name: "Board",
			kind: ListViewKind.Board,
			existingViewsForList: [],
		});
		expect(board.layoutOptions).toMatchObject({ columnWidth: 280, cardPreview: "rich" });
	});
});

describe("renameView", () => {
	test("trims and updates the name", () => {
		const v = emptyView("v", "a", "Old");
		expect(renameView(v, "  New  ").name).toBe("New");
	});
});

describe("duplicateView", () => {
	test("produces a fresh-id copy with a deduped name", () => {
		const v1 = emptyView("v1", "a", "Grid");
		const v2 = duplicateView(v1, [v1]);
		expect(v2.id).not.toBe(v1.id);
		expect(v2.name).toBe("Grid copy");
		expect(v2.columns).not.toBe(v1.columns);
		expect(v2.sorts).not.toBe(v1.sorts);
	});
});

describe("deleteView", () => {
	test("filters by id", () => {
		const v1 = emptyView("v1", "a", "G");
		const v2 = emptyView("v2", "a", "B");
		expect(deleteView([v1, v2], "v1")).toEqual([v2]);
	});
});

describe("resolveListView", () => {
	const v1 = emptyView("v1", "L", "Grid");
	const v2 = emptyView("v2", "L", "Board");
	const views = [v1, v2];

	test("prefers the remembered view when it still exists", () => {
		expect(resolveListView(views, "v2", "v1")).toBe("v2");
	});

	test("falls back to defaultViewId when no remembered view", () => {
		expect(resolveListView(views, undefined, "v2")).toBe("v2");
	});

	test("ignores a stale remembered view id (now deleted)", () => {
		expect(resolveListView(views, "gone", "v1")).toBe("v1");
	});

	test("ignores a stale defaultViewId and falls to the first view", () => {
		expect(resolveListView(views, undefined, "gone")).toBe("v1");
	});

	test("falls to the first view when nothing is specified", () => {
		expect(resolveListView(views, undefined, null)).toBe("v1");
	});

	test("returns undefined for a List with no views", () => {
		expect(resolveListView([], "v1", "v1")).toBeUndefined();
	});
});

describe("seedColumnsForNewView (F-511c)", () => {
	const withColumns = (id: string, columns: ListView["columns"]): ListView => ({
		...emptyView(id, "a", id),
		columns,
	});
	const grid = withColumns("grid", [
		{ propertyId: "status", visible: true, width: 160 },
		{ propertyId: "secret", visible: false },
		{ propertyId: "url", visible: true },
	]);
	const other = withColumns("other", [{ propertyId: "owner", visible: true }]);

	test("copies the visible columns of the view the user is looking at", () => {
		expect(seedColumnsForNewView([other, grid], "grid")).toEqual([
			{ propertyId: "status", visible: true, width: 160 },
			{ propertyId: "url", visible: true },
		]);
	});

	test("falls back to the list's first view when no sibling is active", () => {
		expect(seedColumnsForNewView([other, grid], null).map((c) => c.propertyId)).toEqual(["owner"]);
	});

	test("yields no columns for a list without views", () => {
		expect(seedColumnsForNewView([], "grid")).toEqual([]);
	});

	test("copies, never shares, the column specs", () => {
		const seeded = seedColumnsForNewView([grid], "grid");
		expect(seeded[0]).not.toBe(grid.columns[0]);
	});

	test("createView carries the seeded columns onto the new view", () => {
		const v = createView({
			listId: "a",
			name: "Gallery",
			kind: ListViewKind.Gallery,
			existingViewsForList: [grid],
			columns: seedColumnsForNewView([grid], "grid"),
		});
		expect(v.columns.map((c) => c.propertyId)).toEqual(["status", "url"]);
	});
});
