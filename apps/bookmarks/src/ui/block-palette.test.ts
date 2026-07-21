import { createEditorT, createStandardBlockCommands } from "@brainstorm-os/editor";
import { describe, expect, it } from "vitest";
import { BOOKMARK_BLOCK_PALETTE } from "./block-palette";

const catalogueIds = new Set(createStandardBlockCommands(createEditorT()).map((c) => c.id));

describe("BOOKMARK_BLOCK_PALETTE", () => {
	it("only names real shared-catalogue command ids (no phantom drops)", () => {
		const unknown = BOOKMARK_BLOCK_PALETTE.filter((id) => !catalogueIds.has(id));
		expect(unknown).toEqual([]);
	});

	it("deliberately omits the multi-column layouts (backwards for a link annotation)", () => {
		expect(BOOKMARK_BLOCK_PALETTE).not.toContain("block.columns2");
		expect(BOOKMARK_BLOCK_PALETTE).not.toContain("block.columns3");
	});

	it("carries the note-taking core in a deliberate order", () => {
		// Paragraph leads; headings descend; the list family stays grouped.
		expect(BOOKMARK_BLOCK_PALETTE[0]).toBe("block.paragraph");
		expect(BOOKMARK_BLOCK_PALETTE).toContain("block.callout");
		expect(BOOKMARK_BLOCK_PALETTE).toContain("block.code");
		const h1 = BOOKMARK_BLOCK_PALETTE.indexOf("block.heading1");
		const h3 = BOOKMARK_BLOCK_PALETTE.indexOf("block.heading3");
		expect(h1).toBeGreaterThanOrEqual(0);
		expect(h3).toBeGreaterThan(h1);
	});

	it("has no duplicate ids", () => {
		expect(new Set(BOOKMARK_BLOCK_PALETTE).size).toBe(BOOKMARK_BLOCK_PALETTE.length);
	});
});
