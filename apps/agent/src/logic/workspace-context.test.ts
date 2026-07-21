import type { PlatformCatalog } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { buildWorkspaceContextBlock, joinContextBlocks } from "./workspace-context";

const catalog: PlatformCatalog = {
	apps: [
		{ id: "io.brainstorm.notes", name: "Notes", description: "Write rich documents.", hasIcon: true },
		{ id: "io.brainstorm.agent", name: "Agent", hasIcon: true },
	],
	entityTypes: [
		{
			id: "brainstorm/Note/v1",
			ownerApp: "io.brainstorm.notes",
			properties: [
				{ name: "title", valueType: "string", required: true },
				{ name: "pinned", valueType: "boolean", required: false },
			],
		},
	],
	intents: [
		{ ownerApp: "io.brainstorm.notes", verb: "open", entityType: "brainstorm/Note/v1" },
		{ ownerApp: "io.brainstorm.agent", verb: "process", kind: "summarize" },
		{ ownerApp: "io.brainstorm.agent", verb: "process", kind: "ask" },
	],
};

describe("buildWorkspaceContextBlock (doc 63 — Agent context layer)", () => {
	it("names the workspace and lists apps, their object types + properties, and actions", () => {
		const block = buildWorkspaceContextBlock(catalog);
		expect(block).toContain("Your workspace (Brainstorm)");
		expect(block).toContain("**Notes** (`io.brainstorm.notes`) — Write rich documents.");
		expect(block).toContain("Object type `brainstorm/Note/v1` (title, pinned)");
		expect(block).toContain("Actions: open");
	});

	it("groups an app's verbs and collects their kinds", () => {
		const block = buildWorkspaceContextBlock(catalog);
		expect(block).toContain("Actions: process (summarize, ask)");
	});

	it("omits the description dash when an app has none", () => {
		const block = buildWorkspaceContextBlock(catalog);
		expect(block).toContain("**Agent** (`io.brainstorm.agent`)");
		expect(block).not.toContain("**Agent** (`io.brainstorm.agent`) —");
	});

	it("returns an empty string for an empty catalog (fail-soft)", () => {
		expect(buildWorkspaceContextBlock({ apps: [], entityTypes: [], intents: [] })).toBe("");
	});

	it("caps the rendered property list and marks the elision", () => {
		const many = Array.from({ length: 20 }, (_, i) => ({
			name: `p${i}`,
			valueType: "string",
			required: false,
		}));
		const block = buildWorkspaceContextBlock({
			apps: [{ id: "a", name: "A", hasIcon: false }],
			entityTypes: [{ id: "t/v1", ownerApp: "a", properties: many }],
			intents: [],
		});
		expect(block).toContain("p0, p1");
		expect(block).toContain("…)");
		expect(block).not.toContain("p15");
	});
});

describe("joinContextBlocks", () => {
	it("joins non-empty blocks in order with a blank line", () => {
		expect(joinContextBlocks(["WS", "VAULT", "RETR"])).toBe("WS\n\nVAULT\n\nRETR");
	});
	it("drops empty blocks", () => {
		expect(joinContextBlocks(["WS", "", "MEM"])).toBe("WS\n\nMEM");
		expect(joinContextBlocks(["", ""])).toBe("");
	});
});
