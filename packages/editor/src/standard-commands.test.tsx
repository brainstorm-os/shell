import { describe, expect, it } from "vitest";
import { CommandCategory } from "./block-command";
import { createEditorT } from "./i18n";
import { SLASH_SECTION_ORDER } from "./slash-sections";
import {
	createEntityEmbedCommand,
	createStandardBlockActions,
	createStandardBlockCommands,
	createTransclusionCommand,
	orderCommandsByPalette,
} from "./standard-commands";

const t = createEditorT();

describe("standard block commands", () => {
	it("exposes the generic slash-menu set with localized labels", () => {
		const cmds = createStandardBlockCommands(t);
		const ids = cmds.map((c) => c.id);
		expect(ids).toContain("block.heading1");
		expect(ids).toContain("block.bulletList");
		expect(ids).toContain("block.code");
		expect(ids).toContain("block.divider");
		expect(ids).toContain("block.table");
		expect(ids).toContain("block.columns2");
		expect(ids).toContain("block.toggleHeading1");
		expect(ids).toContain("block.toggleHeading2");
		expect(ids).toContain("block.toggleHeading3");
		// Labels resolve through the editor i18n seam (no raw key leaks).
		const h1 = cmds.find((c) => c.id === "block.heading1");
		expect(h1?.label).toBe("Heading 1");
		// Every command carries an icon, a runnable handler, AND a one-line
		// description — the slash row renders the caption only when present, so a
		// missing description is what made Journal/Tasks read barer than Notes
		// (F-070). The shared catalogue is the single source for these strings.
		for (const c of cmds) {
			expect(c.icon).toBeTruthy();
			expect(typeof c.run).toBe("function");
			expect(c.description, `${c.id} should carry a description`).toBeTruthy();
			expect(c.description, `${c.id} description must resolve (no raw key)`).not.toMatch(
				/^editor\.block\./,
			);
		}
		expect(h1?.description).toBe("Largest section title");
		expect(cmds.find((c) => c.id === "block.todoList")?.description).toBe(
			"Checklist with checkboxes",
		);
	});

	it("every shared slash command carries a section-mapped category (B11.19 drift-fence)", () => {
		// The slash menu's browse view groups by category — a command tagged with
		// an action-menu-only category (TurnInto / Align / …) would land in the
		// trailing header-less group and read as a taxonomy bug. Pin the deliberate
		// assignments; a new shared command must pick a section on purpose.
		const sectionOf = new Map<string, CommandCategory>([
			["block.bulletList", CommandCategory.Lists],
			["block.numberedList", CommandCategory.Lists],
			["block.todoList", CommandCategory.Lists],
			["block.divider", CommandCategory.Basic],
			["block.table", CommandCategory.Layout],
			["block.columns2", CommandCategory.Layout],
			["block.columns3", CommandCategory.Layout],
		]);
		const cmds = createStandardBlockCommands(t);
		for (const c of cmds) {
			expect(
				SLASH_SECTION_ORDER,
				`${c.id} must carry a slash-section category, got "${c.category}"`,
			).toContain(c.category);
			const pinned = sectionOf.get(c.id);
			if (pinned) expect(c.category, `${c.id} section`).toBe(pinned);
		}
	});

	it("exposes block actions including a destructive delete", () => {
		const actions = createStandardBlockActions(t);
		const del = actions.find((a) => a.id === "block.action.delete");
		expect(del?.destructive).toBe(true);
		expect(del?.label).toBe("Delete");
		expect(actions.some((a) => a.category === CommandCategory.TurnInto)).toBe(true);
		expect(actions.some((a) => a.category === CommandCategory.Align)).toBe(true);
		expect(actions.some((a) => a.id === "block.action.moveUp")).toBe(true);
	});

	it("exposes a transclusion command (host-gated, not in the base set)", () => {
		// The base set is generic — the transclusion "Reference" command is added
		// by FullEditorPlugins only when the host enables transclusion, so it must
		// NOT leak into the always-on base catalogue.
		const base = createStandardBlockCommands(t);
		expect(base.some((c) => c.id === "block.transclusion")).toBe(false);
		const ref = createTransclusionCommand(t);
		expect(ref.id).toBe("block.transclusion");
		expect(ref.label).toBe("Reference");
		expect(ref.description).toBe("Embed a live view of another page");
		expect(ref.category).toBe(CommandCategory.Embed);
		expect(ref.keywords).toContain("embed");
		expect(ref.keywords).toContain("transclude");
		expect(typeof ref.run).toBe("function");
	});

	it("exposes an entity-embed command (host-gated, not in the base set)", () => {
		// Like "Reference", the "/embed" preview-card command is added by
		// FullEditorPlugins only when the host provides an entity context —
		// it must NOT leak into the always-on base catalogue (F-070 embed
		// parity: one shared command, same id Notes has always persisted).
		const base = createStandardBlockCommands(t);
		expect(base.some((c) => c.id === "block.embed.entity")).toBe(false);
		const embed = createEntityEmbedCommand(t);
		expect(embed.id).toBe("block.embed.entity");
		expect(embed.label).toBe("Embed");
		expect(embed.description).toBe("Insert a preview card pointing at another vault object");
		expect(embed.category).toBe(CommandCategory.Embed);
		expect(embed.keywords).toContain("embed");
		expect(embed.keywords).toContain("card");
		expect(typeof embed.run).toBe("function");
	});

	it("orderCommandsByPalette filters + reorders to the declared palette (F-070 rung b)", () => {
		const base = createStandardBlockCommands(t);
		// A journal-style palette that drops the column layouts and reorders.
		const palette = ["block.todoList", "block.paragraph", "block.heading1"];
		const out = orderCommandsByPalette(base, palette);
		expect(out.map((c) => c.id)).toEqual(palette);
		// columns dropped; order honours the palette, not the catalogue order.
		expect(out.some((c) => c.id === "block.columns3")).toBe(false);
	});

	it("orderCommandsByPalette returns the full set unchanged when palette is empty/omitted", () => {
		const base = createStandardBlockCommands(t);
		expect(orderCommandsByPalette(base, undefined)).toBe(base);
		expect(orderCommandsByPalette(base, [])).toBe(base);
	});

	it("orderCommandsByPalette skips palette ids with no matching command", () => {
		const base = createStandardBlockCommands(t);
		const out = orderCommandsByPalette(base, ["block.paragraph", "block.nonexistent"]);
		expect(out.map((c) => c.id)).toEqual(["block.paragraph"]);
	});

	it("appends extra commands after the standard set", () => {
		// (sanity: extraCommands merge order is exercised in StandardEditingPlugins)
		const base = createStandardBlockCommands(t);
		expect(base.length).toBeGreaterThan(10);
	});
});
