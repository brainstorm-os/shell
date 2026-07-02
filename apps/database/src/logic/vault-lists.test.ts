import { describe, expect, it } from "vitest";
import { ListSourceKind } from "../types/list-source";
import { ListViewKind, SortDirection } from "../types/list-view";
import {
	ALL_VAULT_LIST_ID,
	type VaultSnapshotInput,
	buildVaultLists,
	deriveColumns,
	firstVaultSelection,
	friendlyTypeName,
	relationTargetTypesFromEntities,
	selectionNeedsSystemReveal,
	typeSlug,
} from "./vault-lists";

function entity(
	id: string,
	type: string,
	properties: Record<string, unknown>,
	overrides: Partial<{ createdAt: number; updatedAt: number; deletedAt: number | null }> = {},
) {
	return {
		id,
		type,
		properties,
		createdAt: overrides.createdAt ?? 1000,
		updatedAt: overrides.updatedAt ?? 2000,
		deletedAt: overrides.deletedAt ?? null,
	};
}

const NOW = 9999;

describe("friendlyTypeName", () => {
	it("extracts and pluralises the type segment before the version", () => {
		expect(friendlyTypeName("io.brainstorm.notes/Note/v1")).toBe("Notes");
		expect(friendlyTypeName("brainstorm/Iteration/v1")).toBe("Iterations");
		expect(friendlyTypeName("io.brainstorm.tasks/Task/v2")).toBe("Tasks");
	});

	it("pluralises -y and sibilant endings correctly", () => {
		expect(friendlyTypeName("x/Story/v1")).toBe("Stories");
		expect(friendlyTypeName("x/Box/v1")).toBe("Boxes");
		expect(friendlyTypeName("x/Dish/v1")).toBe("Dishes");
	});

	it("normalises separators in the segment", () => {
		expect(friendlyTypeName("x/design_doc/v1")).toBe("Design docs");
	});

	it("keeps the type segment when there is no trailing version", () => {
		// Regression: must not fall back to the namespace segment.
		expect(friendlyTypeName("brainstorm/Task")).toBe("Tasks");
		expect(friendlyTypeName("io.brainstorm.notes/Note")).toBe("Notes");
	});

	it("only treats a real vN segment as a version", () => {
		expect(friendlyTypeName("x/Note/v12")).toBe("Notes");
		expect(friendlyTypeName("x/Note/value")).toBe("Values");
	});

	it("falls back to the raw id for unexpected shapes", () => {
		expect(friendlyTypeName("")).toBe("");
		expect(friendlyTypeName("Solo")).toBe("Solos");
	});
});

describe("relationTargetTypesFromEntities", () => {
	it("returns distinct types most-populous first, friendly-labelled", () => {
		const targets = relationTargetTypesFromEntities([
			{ type: "brainstorm/Task/v1" },
			{ type: "brainstorm/Task/v1" },
			{ type: "io.brainstorm.notes/Note/v1" },
			{ type: "brainstorm/Person/v1" },
			{ type: "brainstorm/Person/v1" },
			{ type: "brainstorm/Person/v1" },
		]);
		expect(targets).toEqual([
			{ type: "brainstorm/Person/v1", label: "Persons" },
			{ type: "brainstorm/Task/v1", label: "Tasks" },
			{ type: "io.brainstorm.notes/Note/v1", label: "Notes" },
		]);
	});

	it("drops the List meta-type (links target records, not collection defs)", () => {
		const targets = relationTargetTypesFromEntities([
			{ type: "brainstorm/List/v1" },
			{ type: "brainstorm/Task/v1" },
		]);
		expect(targets.map((t) => t.type)).toEqual(["brainstorm/Task/v1"]);
	});

	it("returns [] for an empty vault", () => {
		expect(relationTargetTypesFromEntities([])).toEqual([]);
	});
});

describe("typeSlug", () => {
	it("produces an id-safe slug", () => {
		expect(typeSlug("io.brainstorm.notes/Note/v1")).toBe("io-brainstorm-notes-note-v1");
		expect(typeSlug("brainstorm/Iteration/v1")).toBe("brainstorm-iteration-v1");
	});

	it("never yields an empty slug", () => {
		expect(typeSlug("///")).toBe("type");
		expect(typeSlug("")).toBe("type");
	});
});

describe("deriveColumns", () => {
	it("orders by frequency desc, ties alphabetical, title first", () => {
		const rows = [
			entity("a", "T", { title: "A", status: "open", tags: ["x"] }),
			entity("b", "T", { title: "B", status: "done" }),
			entity("c", "T", { title: "C" }),
		];
		// title: 3, status: 2, tags: 1 → title pinned first then status, tags
		expect(deriveColumns(rows)).toEqual(["title", "status", "tags"]);
	});

	it("ignores null / empty-string values when counting", () => {
		const rows = [
			entity("a", "T", { title: "A", note: "" }),
			entity("b", "T", { title: "B", note: null }),
		];
		expect(deriveColumns(rows)).toEqual(["title"]);
	});

	it("caps at seven columns", () => {
		const props: Record<string, unknown> = {};
		for (let i = 0; i < 20; i++) props[`p${i}`] = i;
		expect(deriveColumns([entity("a", "T", props)]).length).toBe(7);
	});

	it("falls back to a lone title column for property-less rows", () => {
		expect(deriveColumns([entity("a", "T", {})])).toEqual(["title"]);
		expect(deriveColumns([])).toEqual(["title"]);
	});
});

describe("buildVaultLists", () => {
	const snapshot: VaultSnapshotInput = {
		entities: [
			entity("n1", "io.brainstorm.notes/Note/v1", { title: "First" }, { updatedAt: 50 }),
			entity("n2", "io.brainstorm.notes/Note/v1", { title: "Second" }, { updatedAt: 80 }),
			// A non-curated type — `brainstorm/Task/v1` is now curated
			// (9.14.4), so the generic single-grid path is exercised here
			// with a plain Doc instead.
			entity("t1", "brainstorm/Doc/v1", { title: "Do it", status: "open" }),
			entity("d1", "brainstorm/Doc/v1", { title: "Gone" }, { deletedAt: 123 }),
		],
		links: [
			{
				id: "l1",
				sourceEntityId: "n1",
				destEntityId: "t1",
				linkType: "mentions",
				createdAt: 1,
				deletedAt: null,
			},
			{
				id: "l2",
				sourceEntityId: "n2",
				destEntityId: "t1",
				linkType: "mentions",
				createdAt: 2,
				deletedAt: 99,
			},
		],
	};

	it("drops soft-deleted entities and links", () => {
		const { db } = buildVaultLists(snapshot, NOW);
		expect(db.entities.map((e) => e.id).sort()).toEqual(["n1", "n2", "t1"]);
		expect(db.links.map((l) => l.id)).toEqual(["l1"]);
	});

	it("emits one byType List per present type, most-populous first", () => {
		const { lists } = buildVaultLists(snapshot, NOW);
		// Notes (2) before Docs (1), then the combined All list.
		expect(lists.map((l) => l.name)).toEqual(["Notes", "Docs", "All vault items"]);
		const notes = lists[0];
		expect(notes?.source).toEqual({
			kind: ListSourceKind.ByType,
			types: ["io.brainstorm.notes/Note/v1"],
		});
		expect(notes?.id).toBe("list_vault_io-brainstorm-notes-note-v1");
	});

	it("ids are stable across rebuilds so selection survives onChange", () => {
		const a = buildVaultLists(snapshot, 1);
		const b = buildVaultLists(snapshot, 2);
		expect(a.lists.map((l) => l.id)).toEqual(b.lists.map((l) => l.id));
		expect(a.views.map((v) => v.id)).toEqual(b.views.map((v) => v.id));
	});

	it("each List has a Grid view sorted by updatedAt desc", () => {
		const { views } = buildVaultLists(snapshot, NOW);
		for (const v of views) {
			expect(v.kind).toBe(ListViewKind.Grid);
			expect(v.sorts[0]).toMatchObject({
				propertyId: "updatedAt",
				direction: SortDirection.Desc,
			});
			expect(v.columns[0]?.propertyId).toBe("title");
			expect(v.columns[0]?.width).toBe(280);
		}
	});

	it("appends an All vault items List spanning every type", () => {
		const { lists } = buildVaultLists(snapshot, NOW);
		const all = lists.find((l) => l.id === ALL_VAULT_LIST_ID);
		expect(all).toBeTruthy();
		expect(all?.source).toEqual({
			kind: ListSourceKind.ByType,
			types: ["io.brainstorm.notes/Note/v1", "brainstorm/Doc/v1"],
		});
		expect(all?.description).toContain("3 items across 2 types");
	});

	it("All vault items excludes conversation-child types — Messages stay in their channels (F-318)", () => {
		const polluted: VaultSnapshotInput = {
			entities: [
				entity("n1", "io.brainstorm.notes/Note/v1", { title: "Real doc" }),
				entity("n2", "io.brainstorm.notes/Note/v1", { title: "Another doc" }),
				entity("m1", "brainstorm/Message/v1", { conversation: "c", role: "user", body: "hi" }),
				entity("m2", "brainstorm/Message/v1", { conversation: "c", role: "user", body: "yo" }),
				entity("m3", "brainstorm/Message/v1", { conversation: "c", role: "user", body: "ok" }),
			],
			links: [],
		};
		const { lists } = buildVaultLists(polluted, NOW);
		const all = lists.find((l) => l.id === ALL_VAULT_LIST_ID);
		expect(all?.source).toEqual({
			kind: ListSourceKind.ByType,
			types: ["io.brainstorm.notes/Note/v1"],
		});
		expect(all?.description).toContain("2 items across 1 type");
		// The dedicated Messages type-list still exists (deliberate drill-in).
		expect(lists.some((l) => l.id === "list_vault_brainstorm-message-v1")).toBe(true);
	});

	it("skips the All vault items List when the vault holds only child-typed rows", () => {
		const onlyMessages: VaultSnapshotInput = {
			entities: [
				entity("m1", "brainstorm/Message/v1", { conversation: "c", role: "user", body: "hi" }),
			],
			links: [],
		};
		const { lists } = buildVaultLists(onlyMessages, NOW);
		expect(lists.find((l) => l.id === ALL_VAULT_LIST_ID)).toBeUndefined();
	});

	it("returns nothing for an empty vault", () => {
		const empty = buildVaultLists({ entities: [], links: [] }, NOW);
		expect(empty.lists).toEqual([]);
		expect(empty.views).toEqual([]);
		expect(firstVaultSelection(empty)).toBeNull();
	});

	it("firstVaultSelection points at the most-populous type's grid", () => {
		const sel = firstVaultSelection(buildVaultLists(snapshot, NOW));
		expect(sel).toEqual({
			listId: "list_vault_io-brainstorm-notes-note-v1",
			viewId: "view_vault_io-brainstorm-notes-note-v1_grid",
		});
	});

	it("singular description when a type has exactly one item", () => {
		const one: VaultSnapshotInput = {
			entities: [entity("t1", "brainstorm/Doc/v1", { title: "Only" })],
			links: [],
		};
		const { lists } = buildVaultLists(one, NOW);
		expect(lists[0]?.description).toBe("1 item · brainstorm/Doc/v1");
	});
});

describe("firstVaultSelection prefers a visible list (F-318 fallout)", () => {
	it("skips a child-typed system list even when it is the most populous", () => {
		// Chat-heavy vault: Messages outnumber the user's Notes, so the
		// old lists[0] default landed on the Messages list — hidden under
		// the sidebar's collapsed System disclosure.
		const chatty: VaultSnapshotInput = {
			entities: [
				entity("m1", "brainstorm/Message/v1", { conversation: "c", body: "hi" }),
				entity("m2", "brainstorm/Message/v1", { conversation: "c", body: "yo" }),
				entity("m3", "brainstorm/Message/v1", { conversation: "c", body: "ok" }),
				entity("n1", "io.brainstorm.notes/Note/v1", { title: "Real doc" }),
			],
			links: [],
		};
		const built = buildVaultLists(chatty, NOW);
		expect(built.lists[0]?.id).toBe("list_vault_brainstorm-message-v1"); // the trap
		expect(firstVaultSelection(built)).toEqual({
			listId: "list_vault_io-brainstorm-notes-note-v1",
			viewId: "view_vault_io-brainstorm-notes-note-v1_grid",
		});
	});

	it("falls back to the All-vault list when every type-list is system-classified", () => {
		const plumbingOnly: VaultSnapshotInput = {
			entities: [
				entity("h1", "brainstorm/BrowsingHistory/v1", { url: "a" }),
				entity("h2", "brainstorm/BrowsingHistory/v1", { url: "b" }),
			],
			links: [],
		};
		expect(firstVaultSelection(buildVaultLists(plumbingOnly, NOW))).toEqual({
			listId: ALL_VAULT_LIST_ID,
			viewId: "view_vault_all_grid",
		});
	});

	it("child-only vault still resolves — to the Messages list itself", () => {
		// No All-vault list exists (child types are excluded from it), so
		// the system list is genuinely the only thing selectable.
		const onlyMessages: VaultSnapshotInput = {
			entities: [entity("m1", "brainstorm/Message/v1", { conversation: "c", body: "hi" })],
			links: [],
		};
		expect(firstVaultSelection(buildVaultLists(onlyMessages, NOW))).toEqual({
			listId: "list_vault_brainstorm-message-v1",
			viewId: "view_vault_brainstorm-message-v1_grid",
		});
	});
});

describe("selectionNeedsSystemReveal", () => {
	const vaultDerived = (id: string) => id.startsWith("list_vault_");
	const mixed: VaultSnapshotInput = {
		entities: [
			entity("m1", "brainstorm/Message/v1", { conversation: "c", body: "hi" }),
			entity("n1", "io.brainstorm.notes/Note/v1", { title: "Doc" }),
		],
		links: [],
	};

	it("true when the active selection resolves to a system-classified list", () => {
		const { lists } = buildVaultLists(mixed, NOW);
		expect(selectionNeedsSystemReveal(lists, "list_vault_brainstorm-message-v1", vaultDerived)).toBe(
			true,
		);
	});

	it("false for a user-visible type-list and for an unknown id", () => {
		const { lists } = buildVaultLists(mixed, NOW);
		expect(
			selectionNeedsSystemReveal(lists, "list_vault_io-brainstorm-notes-note-v1", vaultDerived),
		).toBe(false);
		expect(selectionNeedsSystemReveal(lists, "list_missing", vaultDerived)).toBe(false);
	});

	it("false for a non-vault-derived (user-created) list, whatever its types", () => {
		const { lists } = buildVaultLists(mixed, NOW);
		expect(selectionNeedsSystemReveal(lists, "list_vault_brainstorm-message-v1", () => false)).toBe(
			false,
		);
	});
});

describe("curated People list (9.12.13(b))", () => {
	const snap: VaultSnapshotInput = {
		entities: [
			entity("p1", "brainstorm/Person/v1", { name: "Ada", email: ["a@x.com"] }),
			entity("p2", "brainstorm/Person/v1", { name: "Lin", birthday: 123 }),
		],
		links: [],
	};

	it("replaces the generic grid with a curated People List + 3 views", () => {
		const { lists, views } = buildVaultLists(snap, NOW);
		const people = lists.find(
			(l) => l.source?.kind === ListSourceKind.ByType && l.source.types[0] === "brainstorm/Person/v1",
		);
		expect(people?.name).toBe("People");
		expect(people?.description).toBe("2 contacts · brainstorm/Person/v1");
		expect(people?.views).toHaveLength(3);
		expect(people?.defaultViewId).toBe(people?.views[0]);

		const pv = views.filter((v) => people?.views.includes(v.id));
		expect(pv.map((v) => v.kind)).toEqual([
			ListViewKind.Grid,
			ListViewKind.List,
			ListViewKind.Calendar,
		]);
	});

	it("Directory sorts by name asc; Birthdays calendars on the birthday property", () => {
		const { views } = buildVaultLists(snap, NOW);
		const dir = views.find((v) => v.id === "view_vault_brainstorm-person-v1_directory");
		expect(dir?.sorts).toEqual([
			{ propertyId: "name", direction: SortDirection.Asc, emptyPlacement: "end" },
		]);
		const bday = views.find((v) => v.id === "view_vault_brainstorm-person-v1_birthdays");
		expect((bday?.layoutOptions as { primaryDateProperty: string }).primaryDateProperty).toBe(
			"birthday",
		);
		// Stable ids → selection + view-delta persistence survive a rebuild.
		expect(buildVaultLists(snap, NOW + 1).views.map((v) => v.id)).toEqual(views.map((v) => v.id));
	});

	it("leaves non-curated types on the generic single-grid path", () => {
		const mixed: VaultSnapshotInput = {
			entities: [entity("t1", "brainstorm/Doc/v1", { title: "T" })],
			links: [],
		};
		const { lists } = buildVaultLists(mixed, NOW);
		const doc = lists.find(
			(l) => l.source?.kind === ListSourceKind.ByType && l.source.types[0] === "brainstorm/Doc/v1",
		);
		expect(doc?.name).toBe("Docs");
		expect(doc?.views).toHaveLength(1);
	});
});

describe("curated Tasks list (9.14.4)", () => {
	const snap: VaultSnapshotInput = {
		entities: [
			entity("t1", "brainstorm/Task/v1", {
				name: "Draft launch announcement",
				statusKey: "doing",
				priority: "high",
				scheduledAt: 1000,
				dueAt: 2000,
			}),
			entity("t2", "brainstorm/Task/v1", {
				name: "Backlog grooming",
				statusKey: "todo",
				priority: "none",
			}),
		],
		links: [],
	};

	it("replaces the generic grid with a curated Tasks List + 3 views", () => {
		const { lists, views } = buildVaultLists(snap, NOW);
		const tasks = lists.find(
			(l) => l.source?.kind === ListSourceKind.ByType && l.source.types[0] === "brainstorm/Task/v1",
		);
		expect(tasks?.name).toBe("Tasks");
		expect(tasks?.description).toBe("2 tasks · brainstorm/Task/v1");
		expect(tasks?.views).toHaveLength(3);
		expect(tasks?.defaultViewId).toBe(tasks?.views[0]);

		const tv = views.filter((v) => tasks?.views.includes(v.id));
		expect(tv.map((v) => v.kind)).toEqual([
			ListViewKind.Board,
			ListViewKind.List,
			ListViewKind.Calendar,
		]);
		expect(tv.map((v) => v.name)).toEqual(["Board", "Upcoming", "Schedule"]);
		// Curated column set matches the `brainstorm/Task/v1` shape.
		expect(tv[0]?.columns.map((c) => c.propertyId)).toEqual([
			"name",
			"statusKey",
			"priority",
			"scheduledAt",
			"dueAt",
		]);
	});

	it("Board groups by statusKey with a priority subtitle; Upcoming sorts by scheduledAt", () => {
		const { views } = buildVaultLists(snap, NOW);
		const board = views.find((v) => v.id === "view_vault_brainstorm-task-v1_board");
		expect(board?.kind).toBe(ListViewKind.Board);
		expect(board?.groupBy).toEqual({ propertyId: "statusKey" });
		expect(board?.cardSubtitleProperty).toBe("priority");
		expect(board?.sorts).toEqual([
			{ propertyId: "dueAt", direction: SortDirection.Asc, emptyPlacement: "end" },
		]);

		const upcoming = views.find((v) => v.id === "view_vault_brainstorm-task-v1_upcoming");
		expect(upcoming?.sorts).toEqual([
			{ propertyId: "scheduledAt", direction: SortDirection.Asc, emptyPlacement: "end" },
		]);
		expect(upcoming?.groupBy).toBeNull();
	});

	it("Schedule calendars on scheduledAt", () => {
		const { views } = buildVaultLists(snap, NOW);
		const sched = views.find((v) => v.id === "view_vault_brainstorm-task-v1_schedule");
		expect(sched?.kind).toBe(ListViewKind.Calendar);
		expect((sched?.layoutOptions as { primaryDateProperty: string }).primaryDateProperty).toBe(
			"scheduledAt",
		);
	});

	it("ids are stable across rebuilds so selection + view-deltas survive onChange", () => {
		const a = buildVaultLists(snap, NOW);
		const b = buildVaultLists(snap, NOW + 1);
		expect(b.views.map((v) => v.id)).toEqual(a.views.map((v) => v.id));
		expect(b.lists.map((l) => l.id)).toEqual(a.lists.map((l) => l.id));
	});

	it("singular description when exactly one task", () => {
		const one: VaultSnapshotInput = {
			entities: [entity("t1", "brainstorm/Task/v1", { name: "Only" })],
			links: [],
		};
		const tasks = buildVaultLists(one, NOW).lists[0];
		expect(tasks?.description).toBe("1 task · brainstorm/Task/v1");
	});
});
