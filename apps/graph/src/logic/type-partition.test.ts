import { ChildEntityType, SystemEntityType } from "@brainstorm/sdk/system-entities";
import { describe, expect, it } from "vitest";
import { partitionTypeOptions } from "./type-partition";

describe("partitionTypeOptions (F-212)", () => {
	it("splits system plumbing types away from user content types, preserving order", () => {
		const { user, system } = partitionTypeOptions([
			{ type: "brainstorm/Note/v1", count: 12 },
			{ type: SystemEntityType.BrowsingSession, count: 3 },
			{ type: "brainstorm/Task/v1", count: 9 },
			{ type: SystemEntityType.ListView, count: 5 },
			{ type: SystemEntityType.Workflow, count: 2 },
			{ type: "io.brainstorm.journal/Entry/v1", count: 4 },
		]);
		expect(user.map((o) => o.type)).toEqual([
			"brainstorm/Note/v1",
			"brainstorm/Task/v1",
			"io.brainstorm.journal/Entry/v1",
		]);
		expect(system.map((o) => o.type)).toEqual([
			SystemEntityType.BrowsingSession,
			SystemEntityType.ListView,
			SystemEntityType.Workflow,
		]);
	});

	it("returns an empty system group when only content types are present", () => {
		const options = [
			{ type: "brainstorm/Person/v1", count: 1 },
			{ type: "brainstorm/Project/v1", count: 2 },
		];
		const { user, system } = partitionTypeOptions(options);
		expect(user).toEqual(options);
		expect(system).toEqual([]);
	});

	it("groups parent-scoped child types (Message, Comment) with the plumbing — F-318", () => {
		// A vault of untitled Message rows must not flood the canvas legend as
		// first-class user content; child types land in the same dimmed
		// trailing "System" sub-group BrowsingSession/ListView chips use.
		const { user, system } = partitionTypeOptions([
			{ type: "brainstorm/Note/v1", count: 12 },
			{ type: ChildEntityType.Message, count: 36 },
			{ type: SystemEntityType.BrowsingSession, count: 3 },
			{ type: ChildEntityType.Comment, count: 4 },
			{ type: "io.brainstorm.chat/Channel/v1", count: 2 },
		]);
		expect(user.map((o) => o.type)).toEqual(["brainstorm/Note/v1", "io.brainstorm.chat/Channel/v1"]);
		expect(system.map((o) => o.type)).toEqual([
			ChildEntityType.Message,
			SystemEntityType.BrowsingSession,
			ChildEntityType.Comment,
		]);
	});

	it("keeps counts attached to their options", () => {
		const { system } = partitionTypeOptions([{ type: SystemEntityType.Trigger, count: 7 }]);
		expect(system).toEqual([{ type: SystemEntityType.Trigger, count: 7 }]);
	});
});
