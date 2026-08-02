import { describe, expect, it } from "vitest";
import { type BlockCommand, CommandCategory } from "./block-command";
import {
	SLASH_SECTION_LABEL,
	SLASH_SECTION_ORDER,
	SlashMenuRowKind,
	buildSlashMenuView,
	filterCommands,
	groupCommandsIntoSections,
} from "./slash-sections";

const cmd = (id: string, category: CommandCategory, label = id): BlockCommand => ({
	id,
	category,
	label,
	icon: null,
	keywords: [id],
	run: () => undefined,
});

const PALETTE: readonly BlockCommand[] = [
	cmd("block.paragraph", CommandCategory.Basic, "Text"),
	cmd("block.bulletList", CommandCategory.Lists, "Bulleted list"),
	cmd("block.image", CommandCategory.Media, "Image"),
	cmd("block.embed.entity", CommandCategory.Embed, "Embed"),
	cmd("block.columns2", CommandCategory.Layout, "2 columns"),
	cmd("block.property.add", CommandCategory.Property, "Add property"),
	cmd("block.embed.equation", CommandCategory.Advanced, "Equation"),
	cmd("block.heading1", CommandCategory.Basic, "Heading 1"),
];

describe("groupCommandsIntoSections", () => {
	it("orders sections by SLASH_SECTION_ORDER and keeps palette order within a section", () => {
		const sections = groupCommandsIntoSections(PALETTE);
		expect(sections.map((s) => s.category)).toEqual([
			CommandCategory.Basic,
			CommandCategory.Lists,
			CommandCategory.Media,
			CommandCategory.Embed,
			CommandCategory.Layout,
			CommandCategory.Property,
			CommandCategory.Advanced,
		]);
		expect(sections[0]?.commands.map((c) => c.id)).toEqual(["block.paragraph", "block.heading1"]);
	});

	it("drops empty sections", () => {
		const sections = groupCommandsIntoSections([cmd("a", CommandCategory.Basic)]);
		expect(sections).toHaveLength(1);
		expect(sections[0]?.category).toBe(CommandCategory.Basic);
	});

	it("keeps commands with non-section categories in a trailing group (nothing disappears)", () => {
		const stray = cmd("x.custom", CommandCategory.Action);
		const sections = groupCommandsIntoSections([...PALETTE, stray]);
		const last = sections[sections.length - 1];
		expect(last?.commands.map((c) => c.id)).toEqual(["x.custom"]);
		// The trailing group renders without a header — its category has no label.
		expect(SLASH_SECTION_LABEL[last?.category as CommandCategory]).toBeUndefined();
	});

	it("covers every ordered section with a label key", () => {
		for (const category of SLASH_SECTION_ORDER) {
			expect(SLASH_SECTION_LABEL[category]).toBeTruthy();
		}
	});
});

describe("buildSlashMenuView — browse mode (empty query)", () => {
	it("interleaves headers and commands; navigation order follows visual order", () => {
		const view = buildSlashMenuView(PALETTE, "");
		// One header per non-empty section + every command.
		expect(view.rows).toHaveLength(7 + PALETTE.length);
		expect(view.rows[0]?.kind).toBe(SlashMenuRowKind.Section);
		// The navigation list is the flattened section order — Basic first
		// (both Basic commands together), then Lists.
		expect(view.commands.map((c) => c.id).slice(0, 3)).toEqual([
			"block.paragraph",
			"block.heading1",
			"block.bulletList",
		]);
	});

	it("maps each command index to its row index across headers", () => {
		const view = buildSlashMenuView(PALETTE, "");
		expect(view.commandRowIndex).toHaveLength(view.commands.length);
		view.commands.forEach((command, i) => {
			const row = view.rows[view.commandRowIndex[i] as number];
			expect(row?.kind).toBe(SlashMenuRowKind.Command);
			if (row?.kind === SlashMenuRowKind.Command) {
				expect(row.command.id).toBe(command.id);
				expect(row.commandIndex).toBe(i);
			}
		});
	});

	it("whitespace-only query is browse mode", () => {
		const view = buildSlashMenuView(PALETTE, "  ");
		expect(view.rows.some((r) => r.kind === SlashMenuRowKind.Section)).toBe(true);
	});
});

describe("buildSlashMenuView — filter mode (non-empty query)", () => {
	it("renders the flat ranked list with no headers", () => {
		const view = buildSlashMenuView(PALETTE, "heading");
		expect(view.rows.every((r) => r.kind === SlashMenuRowKind.Command)).toBe(true);
		expect(view.commands).toEqual(filterCommands(PALETTE, "heading"));
		expect(view.commandRowIndex).toEqual(view.commands.map((_c, i) => i));
	});

	it("ranking is untouched — a label-prefix match beats a keyword match", () => {
		const commands = [
			cmd("block.heading2", CommandCategory.Basic, "Heading 2"),
			cmd("block.subpage", CommandCategory.Embed, "Sub-page"),
		];
		const view = buildSlashMenuView(commands, "sub");
		expect(view.commands[0]?.id).toBe("block.subpage");
	});
});
