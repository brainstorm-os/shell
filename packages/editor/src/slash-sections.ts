/**
 * Slash-menu filtering + section taxonomy (B11.19). Pure and DOM-free so
 * it unit-tests exhaustively; the plugin is a thin consumer.
 *
 * Two view modes, decided by the query:
 * - **Browse** (a bare `/`): the palette groups under block-type section
 *   headers in `SLASH_SECTION_ORDER`. Navigation order == visual order.
 * - **Filter** (any query text): the flat relevance-ranked list — the
 *   Enter-commits-the-best-match behaviour of `filterCommands` is
 *   untouched (headers would fight the cross-section ranking).
 *
 * The category → section mapping is deliberate design, not registry
 * residue: only the categories below ever render as slash sections
 * (action-menu-only categories — TurnInto / Align / Color / … — never
 * reach the slash palette).
 */

import { type BlockCommand, CommandCategory } from "./block-command";
import type { EditorI18nKey } from "./i18n";

/** Display order of the slash-menu sections. */
export const SLASH_SECTION_ORDER: readonly CommandCategory[] = [
	CommandCategory.Basic,
	CommandCategory.Lists,
	CommandCategory.Media,
	CommandCategory.Embed,
	CommandCategory.Layout,
	CommandCategory.Property,
	CommandCategory.Advanced,
];

export const SLASH_SECTION_LABEL: Partial<Record<CommandCategory, EditorI18nKey>> = {
	[CommandCategory.Basic]: "editor.slashMenu.section.basic",
	[CommandCategory.Lists]: "editor.slashMenu.section.lists",
	[CommandCategory.Media]: "editor.slashMenu.section.media",
	[CommandCategory.Embed]: "editor.slashMenu.section.embeds",
	[CommandCategory.Layout]: "editor.slashMenu.section.layout",
	[CommandCategory.Property]: "editor.slashMenu.section.properties",
	[CommandCategory.Advanced]: "editor.slashMenu.section.advanced",
};

export type SlashSection = {
	category: CommandCategory;
	commands: readonly BlockCommand[];
};

/** Group a palette into ordered sections. Palette order is preserved
 *  within each section; empty sections are dropped. Commands whose
 *  category is not a slash section (host-injected specials) trail in a
 *  final group that renders without a header, so nothing silently
 *  disappears. */
export function groupCommandsIntoSections(
	commands: readonly BlockCommand[],
): readonly SlashSection[] {
	const known = new Set<CommandCategory>(SLASH_SECTION_ORDER);
	const sections: SlashSection[] = [];
	for (const category of SLASH_SECTION_ORDER) {
		const inCategory = commands.filter((c) => c.category === category);
		if (inCategory.length > 0) sections.push({ category, commands: inCategory });
	}
	const rest = commands.filter((c) => !known.has(c.category));
	const restCategory = rest[0]?.category;
	if (rest.length > 0 && restCategory !== undefined) {
		sections.push({ category: restCategory, commands: rest });
	}
	return sections;
}

/** Filter + RANK by relevance so the best match is highlighted first.
 *  Plain registry-order filtering shadowed real targets: e.g. "/sub"
 *  matched `Heading 2` (keyword "subtitle") and `Heading 3` (keyword
 *  "subheading") — both earlier in the registry — so pressing Enter
 *  inserted a heading instead of the `Sub-page` the user wanted. A
 *  label-prefix match must beat a keyword-substring match. Ties keep
 *  registry order (stable). */
export function filterCommands(
	commands: readonly BlockCommand[],
	query: string,
): readonly BlockCommand[] {
	const q = query.trim().toLowerCase();
	if (!q) return commands;
	const scored: { command: BlockCommand; score: number; index: number }[] = [];
	commands.forEach((command, index) => {
		const label = command.label.toLowerCase();
		const kw = command.keywords;
		let score = -1;
		if (label === q) score = 0;
		else if (label.startsWith(q)) score = 1;
		else if (kw.some((k) => k.toLowerCase() === q)) score = 2;
		else if (label.includes(q)) score = 3;
		else if (kw.some((k) => k.toLowerCase().startsWith(q))) score = 4;
		else if (kw.some((k) => k.toLowerCase().includes(q))) score = 5;
		if (score >= 0) scored.push({ command, score, index });
	});
	scored.sort((a, b) => a.score - b.score || a.index - b.index);
	return scored.map((s) => s.command);
}

export enum SlashMenuRowKind {
	Section = "section",
	Command = "command",
}

export type SlashMenuRow =
	| {
			readonly kind: SlashMenuRowKind.Section;
			readonly category: CommandCategory;
			readonly labelKey: EditorI18nKey;
	  }
	| {
			readonly kind: SlashMenuRowKind.Command;
			readonly command: BlockCommand;
			/** Index into the view's `commands` (the host's navigation list). */
			readonly commandIndex: number;
	  };

export type SlashMenuView = {
	/** Navigation list, in VISUAL order — the host's arrow keys walk this. */
	readonly commands: readonly BlockCommand[];
	/** Render list: `commands` with section headers interleaved (browse
	 *  mode) or bare (filter mode). */
	readonly rows: readonly SlashMenuRow[];
	/** Row index of each command — `commandRowIndex[i]` is where
	 *  `commands[i]` sits in `rows` (headers occupy row indices too). */
	readonly commandRowIndex: readonly number[];
};

/** Build the slash menu's view model for a palette + query. */
export function buildSlashMenuView(
	commands: readonly BlockCommand[],
	query: string,
): SlashMenuView {
	if (query.trim() !== "") {
		const ranked = filterCommands(commands, query);
		return {
			commands: ranked,
			rows: ranked.map((command, commandIndex) => ({
				kind: SlashMenuRowKind.Command,
				command,
				commandIndex,
			})),
			commandRowIndex: ranked.map((_c, i) => i),
		};
	}
	const sections = groupCommandsIntoSections(commands);
	const flat: BlockCommand[] = [];
	const rows: SlashMenuRow[] = [];
	const commandRowIndex: number[] = [];
	for (const section of sections) {
		const labelKey = SLASH_SECTION_LABEL[section.category];
		if (labelKey) rows.push({ kind: SlashMenuRowKind.Section, category: section.category, labelKey });
		for (const command of section.commands) {
			commandRowIndex.push(rows.length);
			rows.push({ kind: SlashMenuRowKind.Command, command, commandIndex: flat.length });
			flat.push(command);
		}
	}
	return { commands: flat, rows, commandRowIndex };
}
