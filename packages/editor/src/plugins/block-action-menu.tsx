/**
 * `openBlockActionMenu` — the block action menu (TurnInto / Align / Indent /
 * Action commands for the targeted block(s)), shared between the gutter grip
 * and the right-click context menu. Both pass an anchor rect, the command
 * catalog, and an `onActivate` that dispatches the chosen command with the
 * right `blockKeys`.
 *
 * Renders through the shared fancy-menus runtime (`@brainstorm-os/sdk/menus`) so
 * it matches every other menu's chrome / escape-stack / glass — section
 * headers group the commands by `CommandCategory`. Each command keeps its
 * Phosphor icon: the editor's icons are React nodes, so we wrap each in an
 * `IconParam` whose component renders that node (fancy-menus paints icons from
 * a component, not a pre-rendered element).
 */

import {
	type ContextMenuItem,
	type IconComponent,
	type IconParam,
	openContextMenu,
} from "@brainstorm-os/sdk/menus";
import type { ReactNode } from "react";
import { type BlockCommand, CommandCategory } from "../block-command";
import type { EditorT } from "../i18n";

export type OpenBlockActionMenuOptions = {
	/** The grip button rect, or a 1×1 rect at the cursor for right-click. */
	anchor: DOMRect;
	commands: readonly BlockCommand[];
	onActivate: (command: BlockCommand) => void;
	t: EditorT;
};

/** Wrap a pre-rendered editor icon node as a fancy-menus `IconParam`. The
 *  menu paints icons from a component; this returns one that renders the
 *  already-built Phosphor element. */
function nodeIcon(node: ReactNode): IconParam {
	const Glyph: IconComponent = () => <>{node}</>;
	return { icon: Glyph };
}

type EditorI18nKey = Parameters<EditorT>[0];

const SECTION_LABEL: Partial<Record<CommandCategory, EditorI18nKey>> = {
	[CommandCategory.TurnInto]: "editor.action.menu.turnIntoSection",
	[CommandCategory.Color]: "editor.action.menu.colorSection",
	[CommandCategory.Highlight]: "editor.action.menu.highlightSection",
	[CommandCategory.Align]: "editor.action.menu.alignSection",
	[CommandCategory.Indent]: "editor.action.menu.indentSection",
	[CommandCategory.Action]: "editor.action.menu.actionsSection",
};

// Section order. The bulk colour sections sit last (after the common Turn into
// / Align / Indent / Actions) — they're a tall, less-frequent block, so burying
// the everyday actions under ~20 swatch rows would be the wrong trade.
const SECTION_ORDER: readonly CommandCategory[] = [
	CommandCategory.TurnInto,
	CommandCategory.Align,
	CommandCategory.Indent,
	CommandCategory.Action,
	CommandCategory.Color,
	CommandCategory.Highlight,
];

export function openBlockActionMenu(options: OpenBlockActionMenuOptions): void {
	const { anchor, commands, onActivate, t } = options;
	const items: ContextMenuItem[] = [];
	for (const category of SECTION_ORDER) {
		const labelKey = SECTION_LABEL[category];
		if (!labelKey) continue;
		const inCategory = commands.filter((c) => c.category === category);
		if (inCategory.length === 0) continue;
		items.push({ id: `section:${category}`, label: t(labelKey), section: true });
		for (const command of inCategory) {
			items.push({
				id: command.id,
				label: command.label,
				icon: nodeIcon(command.icon),
				destructive: command.destructive === true,
				onSelect: () => onActivate(command),
			});
		}
	}
	// The point is the anchor's bottom-left; the shared menu config already adds
	// the gap via `position.offsetY`, so don't add it here (would double it).
	openContextMenu({ x: anchor.left, y: anchor.bottom }, items, {
		menuLabel: t("editor.action.menu.region"),
	});
}
