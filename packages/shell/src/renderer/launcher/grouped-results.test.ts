import { describe, expect, it } from "vitest";
import type { InstalledApp, SearchHit } from "../../preload";
import {
	LauncherRowKind,
	buildRows,
	clampSelectionGrouped,
	filterApps,
	firstSelectableIndex,
	moveSelectionGrouped,
} from "./grouped-results";

const apps: readonly InstalledApp[] = [
	{
		id: "io.brainstorm.notes",
		name: "Notes",
		version: "0.1",
		sdk: "1",
		hasIcon: true,
		description: "A nice notes app",
	},
	{
		id: "io.brainstorm.tasks",
		name: "Tasks",
		version: "0.1",
		sdk: "1",
		hasIcon: true,
		description: "Track tasks",
	},
	{ id: "io.brainstorm.calendar", name: "Calendar", version: "0.1", sdk: "1", hasIcon: true },
];

const hits: readonly SearchHit[] = [
	{
		entityId: "n_1",
		type: "io.brainstorm.notes/Note/v1",
		ownerAppId: "io.brainstorm.notes",
		title: "Hello",
		snippet: "<mark>hello</mark> world",
		score: -1,
		updatedAt: 1000,
	},
	{
		entityId: "n_2",
		type: "io.brainstorm.notes/Note/v1",
		ownerAppId: "io.brainstorm.notes",
		title: "Hello again",
		snippet: "another <mark>hello</mark>",
		score: -0.5,
		updatedAt: 2000,
	},
];

const labels = {
	sectionApps: "Apps",
	sectionEntities: "Entities",
	sectionRecent: "Recent",
	sectionSaved: "Saved searches",
};

describe("filterApps", () => {
	it("returns all apps alphabetically on empty query", () => {
		const result = filterApps("", apps);
		expect(result.map((a) => a.name)).toEqual(["Calendar", "Notes", "Tasks"]);
	});

	it("ranks prefix matches above substring matches", () => {
		const result = filterApps("n", apps);
		// Notes (name prefix, rank 0) before Calendar (name substring 'caleNdar', rank 1).
		expect(result.map((a) => a.id)).toEqual(["io.brainstorm.notes", "io.brainstorm.calendar"]);
	});

	it("ranks substring matches above description matches", () => {
		const result = filterApps("task", apps);
		// "Tasks" (name substring rank 1) before "Track" (description rank 2)
		expect(result.map((a) => a.name)).toEqual(["Tasks"]);
	});

	it("matches description when name misses", () => {
		const result = filterApps("nice", apps);
		expect(result.map((a) => a.id)).toEqual(["io.brainstorm.notes"]);
	});

	it("expects already-normalised input (callers lowercase + trim first)", () => {
		// Contract: `filterApps` consumes `buildRows`-normalised query (trim
		// + lowercase). Upper-case input doesn't match anything.
		expect(filterApps("CAL", apps).map((a) => a.id)).toEqual([]);
		expect(filterApps("cal", apps).map((a) => a.id)).toEqual(["io.brainstorm.calendar"]);
	});

	it("returns empty on no match", () => {
		expect(filterApps("zzz", apps)).toEqual([]);
	});

	it("ties break by name alphabetically", () => {
		const ambiguous: InstalledApp[] = [
			{ id: "b", name: "Bravo", version: "0.1", sdk: "1", hasIcon: false, description: "alpha" },
			{ id: "a", name: "Alpha", version: "0.1", sdk: "1", hasIcon: false, description: "alpha" },
		];
		const result = filterApps("alpha", ambiguous);
		expect(result.map((a) => a.name)).toEqual(["Alpha", "Bravo"]);
	});
});

describe("buildRows", () => {
	it("returns the bare apps list (with header) on empty query", () => {
		const rows = buildRows({ query: "", apps, entities: [], labels });
		expect(rows[0]).toMatchObject({ rowKind: LauncherRowKind.SectionHeader, label: "Apps" });
		expect(rows.slice(1).every((r) => r.rowKind === LauncherRowKind.App)).toBe(true);
		expect(rows).toHaveLength(1 + apps.length);
	});

	it("omits the entities section when the query is empty", () => {
		const rows = buildRows({ query: "", apps, entities: hits, labels });
		expect(
			rows.some((r) => r.rowKind === LauncherRowKind.SectionHeader && r.label === "Entities"),
		).toBe(false);
		expect(rows.some((r) => r.rowKind === LauncherRowKind.Entity)).toBe(false);
	});

	it("includes both sections when query matches an app and entities exist", () => {
		const rows = buildRows({ query: "no", apps, entities: hits, labels });
		const headers = rows.filter((r) => r.rowKind === LauncherRowKind.SectionHeader);
		expect(headers.map((h) => h.label)).toEqual(["Apps", "Entities"]);
		expect(rows.filter((r) => r.rowKind === LauncherRowKind.Entity)).toHaveLength(2);
	});

	it("omits the apps section when no apps match the query", () => {
		const rows = buildRows({ query: "hello", apps, entities: hits, labels });
		// "hello" doesn't match any app — no Apps section, but Entities still shows.
		expect(rows.some((r) => r.rowKind === LauncherRowKind.App)).toBe(false);
		expect(rows[0]).toMatchObject({ rowKind: LauncherRowKind.SectionHeader, label: "Entities" });
	});

	it("returns an empty array when nothing matches", () => {
		const rows = buildRows({ query: "zzz", apps, entities: [], labels });
		expect(rows).toEqual([]);
	});

	it("resolves the entity owner app name when installed", () => {
		const rows = buildRows({ query: "hello", apps, entities: hits, labels });
		const entityRows = rows.filter(
			(r): r is Extract<(typeof rows)[number], { rowKind: LauncherRowKind.Entity }> =>
				r.rowKind === LauncherRowKind.Entity,
		);
		expect(entityRows[0]?.ownerAppName).toBe("Notes");
	});

	it("falls back to the raw appId for orphaned entity hits", () => {
		const first = hits[0];
		if (!first) throw new Error("fixture broken");
		const orphan: SearchHit = { ...first, ownerAppId: "io.example.unknown", entityId: "x" };
		const rows = buildRows({ query: "hello", apps, entities: [orphan], labels });
		const entity = rows.find((r) => r.rowKind === LauncherRowKind.Entity);
		expect(entity && "ownerAppName" in entity && entity.ownerAppName).toBe("io.example.unknown");
	});
});

describe("moveSelectionGrouped", () => {
	const rows = buildRows({ query: "hello", apps, entities: hits, labels });
	// rows: [Header(Apps?) — actually no apps match "hello", so:
	//   0: Header(Entities), 1: Entity n_1, 2: Entity n_2]
	// Confirm assumption inside the test rather than hard-coding the layout.

	it("skips the section header when moving down", () => {
		const rowsWithApps = buildRows({ query: "no", apps, entities: hits, labels });
		// "no" matches "Notes" + "nice notes app" + hits → both sections present.
		// Layout: [H(Apps), App(Notes), H(Entities), Entity, Entity]
		expect(rowsWithApps[0]?.rowKind).toBe(LauncherRowKind.SectionHeader);
		// From the App at index 1, Down should skip the header at index 2.
		expect(moveSelectionGrouped("down", 1, rowsWithApps)).toBe(3);
	});

	it("skips the section header when moving up", () => {
		const rowsWithApps = buildRows({ query: "no", apps, entities: hits, labels });
		// From the first Entity (index 3), Up should skip header (2) and land on the App (1).
		expect(moveSelectionGrouped("up", 3, rowsWithApps)).toBe(1);
	});

	it("does not wrap at the bottom", () => {
		const last = rows.length - 1;
		expect(moveSelectionGrouped("down", last, rows)).toBe(last);
	});

	it("does not wrap at the top", () => {
		const first = firstSelectableIndex(rows);
		expect(moveSelectionGrouped("up", first, rows)).toBe(first);
	});

	it("returns -1 when there are no selectable rows", () => {
		expect(moveSelectionGrouped("down", 0, [])).toBe(-1);
	});

	it("recovers when the current index is a header (initial frame)", () => {
		// Shouldn't happen in practice because firstSelectableIndex skips
		// headers, but defensive: if current is not in the selectables list,
		// jump to the first selectable.
		const rowsWithApps = buildRows({ query: "no", apps, entities: hits, labels });
		expect(moveSelectionGrouped("down", 0, rowsWithApps)).toBe(1);
		expect(moveSelectionGrouped("up", 0, rowsWithApps)).toBe(1);
	});
});

describe("firstSelectableIndex", () => {
	it("returns the index of the first non-header row", () => {
		const rowsWithApps = buildRows({ query: "no", apps, entities: hits, labels });
		expect(firstSelectableIndex(rowsWithApps)).toBe(1);
	});

	it("returns -1 when there are no selectable rows", () => {
		expect(firstSelectableIndex([])).toBe(-1);
	});

	it("returns -1 when only headers remain", () => {
		const headers = buildRows({ query: "no", apps, entities: hits, labels }).filter(
			(r) => r.rowKind === LauncherRowKind.SectionHeader,
		);
		expect(firstSelectableIndex(headers)).toBe(-1);
	});
});

describe("clampSelectionGrouped", () => {
	it("walks back to the previous selectable when the row shrinks", () => {
		const rowsWithApps = buildRows({ query: "no", apps, entities: hits, labels });
		// Suppose current is past the end after a shrink.
		expect(clampSelectionGrouped(99, rowsWithApps)).toBe(rowsWithApps.length - 1);
	});

	it("walks forward when the previous row is a header", () => {
		const rowsWithApps = buildRows({ query: "no", apps, entities: hits, labels });
		// Index 0 is a header — clamp should jump forward to index 1.
		expect(clampSelectionGrouped(0, rowsWithApps)).toBe(1);
	});

	it("returns -1 when there are no rows", () => {
		expect(clampSelectionGrouped(0, [])).toBe(-1);
	});
});

describe("buildRows — empty-query memory (9.22.7)", () => {
	const saved = [{ id: "s1", text: "q3 plan", createdAt: 1 }];

	it("leads an empty query with saved searches, then recents, then apps", () => {
		const rows = buildRows({
			query: "  ",
			apps,
			entities: hits,
			recents: [hits[1] as SearchHit],
			savedSearches: saved,
			offerSaveSearch: true,
			labels,
		});
		expect(rows.map((r) => r.id)).toEqual([
			"section:saved",
			"saved:s1",
			"section:recent",
			"recent:n_2",
			"section:apps",
			"app:io.brainstorm.calendar",
			"app:io.brainstorm.notes",
			"app:io.brainstorm.tasks",
		]);
		const recent = rows[3];
		expect(recent?.rowKind === LauncherRowKind.Entity && recent.ownerAppName).toBe("Notes");
	});

	it("hides saved searches and recents once the user types", () => {
		const rows = buildRows({
			query: "hello",
			apps,
			entities: hits,
			recents: [hits[1] as SearchHit],
			savedSearches: saved,
			labels,
		});
		expect(rows.some((r) => r.rowKind === LauncherRowKind.SavedSearch)).toBe(false);
		expect(rows.some((r) => r.id.startsWith("recent:"))).toBe(false);
	});

	it("ends a typed query with a save row carrying the collapsed text", () => {
		const rows = buildRows({
			query: "  hello   world ",
			apps,
			entities: hits,
			offerSaveSearch: true,
			labels,
		});
		const last = rows[rows.length - 1];
		expect(last?.rowKind).toBe(LauncherRowKind.SaveSearch);
		expect(last?.rowKind === LauncherRowKind.SaveSearch && last.text).toBe("hello world");
	});

	it("offers no save row for text that is already saved (case-insensitive)", () => {
		const rows = buildRows({
			query: "Q3 Plan",
			apps,
			entities: [],
			savedSearches: saved,
			offerSaveSearch: true,
			labels,
		});
		expect(rows.some((r) => r.rowKind === LauncherRowKind.SaveSearch)).toBe(false);
	});

	it("keeps the save row selectable and saved-search rows navigable", () => {
		const rows = buildRows({
			query: "",
			apps: [],
			entities: [],
			savedSearches: saved,
			labels,
		});
		expect(firstSelectableIndex(rows)).toBe(1);
	});
});
