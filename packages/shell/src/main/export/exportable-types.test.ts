import { ChildEntityType, SystemEntityType } from "@brainstorm-os/sdk/system-entities";
import { describe, expect, it } from "vitest";
import { isExportable } from "./vault-markdown-export";

describe("isExportable", () => {
	it("keeps mail in the export although it is child content for browsing", () => {
		expect(isExportable({ type: ChildEntityType.Email })).toBe(true);
	});

	it("still leaves out chat messages, comments and plumbing", () => {
		expect(isExportable({ type: ChildEntityType.Message })).toBe(false);
		expect(isExportable({ type: ChildEntityType.Comment })).toBe(false);
		expect(isExportable({ type: SystemEntityType.ListView })).toBe(false);
	});

	it("exports ordinary content", () => {
		expect(isExportable({ type: "io.brainstorm.notes/Note/v1" })).toBe(true);
	});
});
