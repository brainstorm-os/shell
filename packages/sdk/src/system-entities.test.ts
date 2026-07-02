import { describe, expect, it } from "vitest";
import {
	CHILD_ENTITY_TYPES,
	ChildEntityType,
	SYSTEM_ENTITY_TYPES,
	SystemEntityType,
	friendlyTypeName,
	isChildEntityType,
	isPlumbingEntityType,
	isSystemEntityType,
	typeDisplayName,
} from "./system-entities";

describe("system entity types", () => {
	it("classifies infrastructure records as system", () => {
		expect(isSystemEntityType(SystemEntityType.BrowsingHistory)).toBe(true);
		expect(isSystemEntityType(SystemEntityType.BrowsingSession)).toBe(true);
		expect(isSystemEntityType(SystemEntityType.ListView)).toBe(true);
		expect(isSystemEntityType(SystemEntityType.Trigger)).toBe(true);
		expect(isSystemEntityType(SystemEntityType.Workflow)).toBe(true);
		expect(isSystemEntityType(SystemEntityType.WorkflowRun)).toBe(true);
		expect(isSystemEntityType(SystemEntityType.ShortcutBindings)).toBe(true);
		expect(isSystemEntityType(SystemEntityType.SyncRun)).toBe(true);
		expect(isSystemEntityType(SystemEntityType.GraphExport)).toBe(true);
	});

	it("keeps user content out — deliberate creations are never system", () => {
		for (const type of [
			"brainstorm/Note/v1",
			"brainstorm/Task/v1",
			"brainstorm/Reminder/v1",
			"brainstorm/StylePack/v1",
			"brainstorm/Bookmark/v1",
			"brainstorm/List/v1",
			"brainstorm/Object/v1",
			"brainstorm/Person/v1",
			"io.brainstorm.journal/Entry/v1",
			"",
		]) {
			expect(isSystemEntityType(type), type).toBe(false);
		}
	});

	it("exposes the full catalogue as a set matching the const object", () => {
		expect(SYSTEM_ENTITY_TYPES.size).toBe(Object.values(SystemEntityType).length);
		for (const type of Object.values(SystemEntityType)) {
			expect(SYSTEM_ENTITY_TYPES.has(type)).toBe(true);
		}
	});
});

describe("child entity types (F-318)", () => {
	it("classifies parent-scoped conversation children", () => {
		expect(isChildEntityType(ChildEntityType.Message)).toBe(true);
		expect(isChildEntityType(ChildEntityType.Comment)).toBe(true);
		expect(isChildEntityType("brainstorm/Message/v1")).toBe(true);
	});

	it("keeps standalone content and containers out", () => {
		for (const type of [
			"io.brainstorm.chat/Channel/v1",
			"brainstorm/Conversation/v1",
			"brainstorm/Note/v1",
			"brainstorm/Email/v1",
			"brainstorm/Task/v1",
			"",
		]) {
			expect(isChildEntityType(type), type).toBe(false);
		}
	});

	it("is disjoint from the system set — child rows are deliberate content", () => {
		for (const type of CHILD_ENTITY_TYPES) {
			expect(isSystemEntityType(type), type).toBe(false);
		}
		expect(CHILD_ENTITY_TYPES.size).toBe(Object.values(ChildEntityType).length);
	});
});

describe("isPlumbingEntityType (system ∨ child union)", () => {
	it("answers true for every system type", () => {
		for (const type of SYSTEM_ENTITY_TYPES) {
			expect(isPlumbingEntityType(type), type).toBe(true);
		}
	});

	it("answers true for every child type", () => {
		for (const type of CHILD_ENTITY_TYPES) {
			expect(isPlumbingEntityType(type), type).toBe(true);
		}
	});

	it("keeps user content out", () => {
		for (const type of [
			"brainstorm/Note/v1",
			"brainstorm/Task/v1",
			"brainstorm/Reminder/v1",
			"io.brainstorm.chat/Channel/v1",
			"io.brainstorm.journal/Entry/v1",
			"",
		]) {
			expect(isPlumbingEntityType(type), type).toBe(false);
		}
	});

	it("is exactly the union of the two finer-grained predicates", () => {
		for (const type of [...SYSTEM_ENTITY_TYPES, ...CHILD_ENTITY_TYPES, "brainstorm/Note/v1"]) {
			expect(isPlumbingEntityType(type), type).toBe(
				isSystemEntityType(type) || isChildEntityType(type),
			);
		}
	});
});

describe("typeDisplayName (F-320 singular type caption)", () => {
	it("extracts the singular name segment from a versioned type id", () => {
		expect(typeDisplayName("brainstorm/Task/v1")).toBe("Task");
		expect(typeDisplayName("io.brainstorm.notes/Note/v1")).toBe("Note");
		expect(typeDisplayName("brainstorm/Message/v1")).toBe("Message");
	});

	it("keeps the name of a version-less id and normalises separators", () => {
		expect(typeDisplayName("brainstorm/Task")).toBe("Task");
		expect(typeDisplayName("brainstorm/content_calendar/v1")).toBe("Content calendar");
		expect(typeDisplayName("brainstorm/graph-export/v1")).toBe("Graph export");
	});

	it("falls back to the raw id when nothing parses", () => {
		expect(typeDisplayName("")).toBe("");
		expect(typeDisplayName("///")).toBe("///");
	});

	it("stays the singular of friendlyTypeName's plural", () => {
		expect(friendlyTypeName("brainstorm/Task/v1")).toBe("Tasks");
		expect(friendlyTypeName("brainstorm/BrowsingHistory/v1")).toBe("BrowsingHistories");
		expect(friendlyTypeName("brainstorm/Task")).toBe("Tasks");
		expect(friendlyTypeName("")).toBe("");
	});
});
