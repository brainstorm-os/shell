import { describe, expect, it } from "vitest";
import { FILE_TYPE, FOLDER_TYPE } from "../types/entity";
import {
	type OpenerMeta,
	browsableTypeSet,
	isAppInternalType,
	openerFromHandlers,
	unresolvedTypes,
} from "./browsable-types";

const NOTE = "io.brainstorm.notes/Note/v1";
const TASK = "brainstorm/Task/v1";
const VIEW = "brainstorm/CalendarView/v1";

function row(id: string, type: string, deletedAt: number | null = null) {
	return { id, type, deletedAt };
}

describe("unresolvedTypes", () => {
	it("returns distinct non-File/Folder types missing from the cache", () => {
		const entities = [
			row("a", FOLDER_TYPE),
			row("b", FILE_TYPE),
			row("c", NOTE),
			row("d", NOTE),
			row("e", TASK),
		];
		expect(unresolvedTypes(entities, new Map()).sort()).toEqual([NOTE, TASK].sort());
	});

	it("never queries File/Folder (structural, always browsable)", () => {
		const entities = [row("a", FILE_TYPE), row("b", FOLDER_TYPE)];
		expect(unresolvedTypes(entities, new Map())).toEqual([]);
	});

	it("skips types already in the cache (resolved, even to null)", () => {
		const cache = new Map<string, OpenerMeta | null>([
			[NOTE, { appId: "notes", label: "Notes" }],
			[VIEW, null],
		]);
		const entities = [row("a", NOTE), row("b", VIEW), row("c", TASK)];
		expect(unresolvedTypes(entities, cache)).toEqual([TASK]);
	});

	it("ignores soft-deleted rows", () => {
		const entities = [row("a", TASK, 999)];
		expect(unresolvedTypes(entities, new Map())).toEqual([]);
	});

	it("never queries app-internal types (they're hidden regardless of opener)", () => {
		const entities = [
			row("a", "brainstorm/BrowsingSession/v1"),
			row("b", "brainstorm/ListView/v1"),
			row("c", "brainstorm/Theme/v1"),
			row("d", TASK),
		];
		expect(unresolvedTypes(entities, new Map())).toEqual([TASK]);
	});
});

describe("isAppInternalType", () => {
	it("hides view/state/session/history/run/edge/account/designation families", () => {
		for (const t of [
			"brainstorm/CalendarView/v1",
			"brainstorm/GraphView/v1",
			"brainstorm/ListView/v1",
			"brainstorm/FileManagerState/v1",
			"brainstorm/BrowsingSession/v1",
			"brainstorm/BrowsingHistory/v1",
			"brainstorm/WorkflowRun/v1",
			"brainstorm/WhiteboardEdge/v1",
			"brainstorm/MailAccount/v1",
			"brainstorm/ConnectorAccount/v1",
			"brainstorm/AutomationHostDesignation/v1",
		]) {
			expect(isAppInternalType(t), t).toBe(true);
		}
	});

	it("hides specific theme / automation / connector config types", () => {
		for (const t of [
			"brainstorm/Theme/v1",
			"brainstorm/TokenSet/v1",
			"brainstorm/StylePack/v1",
			"brainstorm/Typography/v1",
			"brainstorm/Memory/v1",
			"brainstorm/Trigger/v1",
			"brainstorm/MailFolder/v1",
		]) {
			expect(isAppInternalType(t), t).toBe(true);
		}
	});

	it("keeps genuine content types visible", () => {
		for (const t of [
			NOTE,
			TASK,
			"brainstorm/Project/v1",
			"brainstorm/Bookmark/v1",
			"io.brainstorm.journal/Entry/v1",
			"brainstorm/Event/v1",
			"brainstorm/Whiteboard/v1",
			"brainstorm/Invoice/v1",
			"brainstorm/CodeFile/v1",
			"brainstorm/Highlight/v1",
			"brainstorm/Person/v1",
		]) {
			expect(isAppInternalType(t), t).toBe(false);
		}
	});
});

describe("browsableTypeSet", () => {
	it("includes only types with a non-null opener", () => {
		const cache = new Map<string, OpenerMeta | null>([
			[NOTE, { appId: "notes", label: "Notes" }],
			[TASK, { appId: "tasks", label: "Tasks" }],
			[VIEW, null],
		]);
		expect([...browsableTypeSet(cache)].sort()).toEqual([NOTE, TASK].sort());
	});

	it("excludes app-internal types even when they resolve to an opener", () => {
		// A view-state type whose app DOES register an opener (resume-the-view).
		const cache = new Map<string, OpenerMeta | null>([
			[NOTE, { appId: "notes", label: "Notes" }],
			["brainstorm/ListView/v1", { appId: "database", label: "Database" }],
			["brainstorm/BrowsingSession/v1", { appId: "browser", label: "Browser" }],
		]);
		expect([...browsableTypeSet(cache)]).toEqual([NOTE]);
	});

	it("is empty for an empty / all-null cache", () => {
		expect(browsableTypeSet(new Map())).toEqual(new Set());
		expect(browsableTypeSet(new Map([[VIEW, null]]))).toEqual(new Set());
	});
});

describe("openerFromHandlers", () => {
	it("takes the first handler (primary-first) as the default opener", () => {
		expect(openerFromHandlers([{ appId: "tasks", label: "Tasks" }, { appId: "x" }])).toEqual({
			appId: "tasks",
			label: "Tasks",
		});
	});

	it("tolerates a missing label", () => {
		expect(openerFromHandlers([{ appId: "tasks" }])).toEqual({ appId: "tasks", label: null });
	});

	it("returns null for no handlers / empty appId", () => {
		expect(openerFromHandlers([])).toBeNull();
		expect(openerFromHandlers(null)).toBeNull();
		expect(openerFromHandlers(undefined)).toBeNull();
		expect(openerFromHandlers([{ appId: "" }])).toBeNull();
	});
});
