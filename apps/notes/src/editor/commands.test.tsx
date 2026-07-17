/**
 * 9.18.3c(d) drift-fence — Notes' slash/action catalogue is built ON the
 * shared `@brainstorm/editor` catalogue (the same set Journal / Tasks /
 * Bookmarks mount), with only the genuinely Notes-coupled commands authored
 * locally. If Notes re-grows a bespoke copy of a generic command, or the
 * shared catalogue renames an id Notes' palette lists, these fail.
 */

import { createEditorT, createStandardBlockCommands } from "@brainstorm/editor";
import { describe, expect, it } from "vitest";
import { BLOCK_ACTIONS, BLOCK_COMMANDS, NOTES_BLOCK_PALETTE } from "./commands";

const NOTES_ONLY_COMMAND_IDS = [
	"block.media.image",
	"block.media.video",
	"block.media.audio",
	"block.media.file",
	"block.property.add",
	"block.embed.toc",
	"block.embed.subpage",
	"block.embed.equation",
	"block.embed.checkbox",
	"block.embed.date",
	"block.embed.number",
	"block.embed.select",
	"block.embed.bookmark",
] as const;

describe("Notes block commands (shared-catalogue composition)", () => {
	it("every palette id resolves to a SHARED catalogue command (no bespoke copies)", () => {
		const shared = createStandardBlockCommands(createEditorT());
		const sharedById = new Map(shared.map((c) => [c.id, c]));
		for (const id of NOTES_BLOCK_PALETTE) {
			expect(sharedById.has(id), `palette id ${id} must exist in the shared catalogue`).toBe(true);
			const mounted = BLOCK_COMMANDS.find((c) => c.id === id);
			expect(mounted, `palette id ${id} must be mounted in BLOCK_COMMANDS`).toBeTruthy();
			// Same label + description as the shared catalogue — one wording in
			// every app (F-070), not a Notes re-authoring.
			expect(mounted?.label).toBe(sharedById.get(id)?.label);
			expect(mounted?.description).toBe(sharedById.get(id)?.description);
		}
	});

	it("keeps the palette order (shared ids appear as an ordered subsequence)", () => {
		const mountedSharedIds = BLOCK_COMMANDS.map((c) => c.id).filter((id) =>
			NOTES_BLOCK_PALETTE.includes(id),
		);
		expect(mountedSharedIds).toEqual([...NOTES_BLOCK_PALETTE]);
	});

	it("mounts every Notes-only command with a resolved description", () => {
		for (const id of NOTES_ONLY_COMMAND_IDS) {
			const cmd = BLOCK_COMMANDS.find((c) => c.id === id);
			expect(cmd, `${id} must be present`).toBeTruthy();
			expect(cmd?.description, `${id} must carry a description`).toBeTruthy();
			expect(cmd?.description).not.toMatch(/^notes\./);
		}
	});

	it("includes the shared host-gated Reference (transclusion) command", () => {
		const ref = BLOCK_COMMANDS.find((c) => c.id === "block.transclusion");
		expect(ref).toBeTruthy();
		expect(ref?.label).toBe("Reference");
	});

	it("includes the shared host-gated Embed (entity card) command — not a Notes fork", () => {
		// F-070 embed parity: `/embed` is `createEntityEmbedCommand` from the
		// shared catalogue — same id, label, and description Journal / Tasks
		// mount via `<FullEditorPlugins>`.
		const embed = BLOCK_COMMANDS.find((c) => c.id === "block.embed.entity");
		expect(embed).toBeTruthy();
		expect(embed?.label).toBe("Embed");
		expect(embed?.description).toBe("Insert a preview card pointing at another vault object");
	});

	it("includes the toggle-heading family from the shared catalogue", () => {
		for (const id of ["block.toggleHeading1", "block.toggleHeading2", "block.toggleHeading3"]) {
			expect(
				BLOCK_COMMANDS.some((c) => c.id === id),
				`${id} expected`,
			).toBe(true);
		}
	});
});

describe("Notes block actions (shared-catalogue composition)", () => {
	it("contains the shared multi-block action set", () => {
		const ids = BLOCK_ACTIONS.map((c) => c.id);
		for (const id of [
			"block.turn.paragraph",
			"block.turn.h1",
			"block.align.left",
			"block.indent.increase",
			"block.action.moveUp",
			"block.action.moveDown",
			"block.action.duplicate",
			"block.action.delete",
		]) {
			expect(ids, `${id} expected`).toContain(id);
		}
	});

	it("slots copy-link + add-property before Delete, swatches after", () => {
		const ids = BLOCK_ACTIONS.map((c) => c.id);
		const copyLink = ids.indexOf("block.action.copyLink");
		const addProperty = ids.indexOf("block.action.addProperty");
		const del = ids.indexOf("block.action.delete");
		expect(copyLink).toBeGreaterThan(-1);
		expect(addProperty).toBeGreaterThan(-1);
		expect(copyLink).toBeLessThan(del);
		expect(addProperty).toBeLessThan(del);
		const firstSwatch = ids.findIndex((id) => id.startsWith("block.color."));
		expect(firstSwatch).toBeGreaterThan(del);
		expect(ids.some((id) => id.startsWith("block.highlight."))).toBe(true);
	});

	it("keeps Delete destructive", () => {
		expect(BLOCK_ACTIONS.find((c) => c.id === "block.action.delete")?.destructive).toBe(true);
	});
});
