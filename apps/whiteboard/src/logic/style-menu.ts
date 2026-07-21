/**
 * Style-menu item builder (F-200) — the pure half of the header **Style ▾**
 * menu for node selections.
 *
 * The old menu was a flat wall of 20 rows mixing two label idioms
 * ("Fill: Yellow" / "Text colour: Red"); rebuilt here as labelled sections
 * (Text size / Fill / Text colour / Font / Emphasis) with one-word value
 * rows — the section heading carries the category. Section rows ride the
 * SDK `AnchoredMenuItem.section` flag (fancy-menus `RowKind.Section`).
 *
 * Pure: takes the live nodes + selection + `t` + the apply handlers, returns
 * the rows — unit-tested without any menu runtime. The connector-styling
 * menu (Route / end caps / Dashed / Colour) deliberately stays in `app.ts`
 * unchanged: it shipped well (per the friction log) and is left untouched.
 */

import { IconName } from "@brainstorm-os/sdk/icon";
import type { AnchoredMenuItem } from "@brainstorm-os/sdk/object-menu";
import type { TranslationParams, WhiteboardMessageKey } from "../i18n/t";
import {
	FONT_FAMILIES,
	type FontFamily,
	STICKY_COLORS,
	type StickyColor,
	TEXT_COLORS,
	TEXT_SIZES,
	type TextColor,
	type TextSize,
	type WhiteboardNode,
} from "../types/node";
import { hasSticky, hasStyleableText, selectionBold, selectionItalic } from "./node-style";

export type StyleMenuT = (key: WhiteboardMessageKey, params?: TranslationParams) => string;

export type NodeStyleHandlers = {
	setTextSize(size: TextSize): void;
	setStickyFill(color: StickyColor): void;
	setTextColor(color: TextColor): void;
	setFontFamily(font: FontFamily): void;
	toggleBold(): void;
	toggleItalic(): void;
};

/** The Style trigger only opens over something styleable — a node selection
 *  or a selected connector. Drives the trigger's disabled state. */
export function hasStyleTarget(
	selectedIds: ReadonlySet<string>,
	selectedEdgeId: string | null,
): boolean {
	return selectedIds.size > 0 || selectedEdgeId !== null;
}

const SIZE_LABEL: Readonly<Record<TextSize, WhiteboardMessageKey>> = {
	small: "whiteboard.style.size.small",
	medium: "whiteboard.style.size.medium",
	large: "whiteboard.style.size.large",
};

/** One style category → a cascade submenu row. When the selection can take
 *  the style, the category is a parent that reveals its value rows on hover;
 *  otherwise it's a single disabled row carrying the reason, so a mixed
 *  selection stays honest instead of dangling an empty cascade. */
function styleCategory(
	label: string,
	applicable: boolean,
	unavailable: { hint?: string },
	children: AnchoredMenuItem[],
): AnchoredMenuItem {
	return applicable ? { label, submenu: children } : { label, disabled: true, ...unavailable };
}

/** Node-style rows. Each category (Text size / Fill / Text colour / Font /
 *  Emphasis) is a cascade submenu — the heading is the parent, the values its
 *  children — so the menu reads as five short rows instead of a 20-row wall. */
export function buildNodeStyleItems(
	nodes: readonly WhiteboardNode[],
	selectedIds: ReadonlySet<string>,
	t: StyleMenuT,
	handlers: NodeStyleHandlers,
): AnchoredMenuItem[] {
	const textOk = hasStyleableText(nodes, selectedIds);
	const stickyOk = hasSticky(nodes, selectedIds);
	const needText = textOk ? {} : { hint: t("whiteboard.style.needText") };
	const needSticky = stickyOk ? {} : { hint: t("whiteboard.style.needSticky") };
	const isBold = selectionBold(nodes, selectedIds);
	const isItalic = selectionItalic(nodes, selectedIds);

	return [
		styleCategory(
			t("whiteboard.style.section.textSize"),
			textOk,
			needText,
			TEXT_SIZES.map((size) => ({
				label: t(SIZE_LABEL[size]),
				onSelect: () => handlers.setTextSize(size),
			})),
		),
		styleCategory(
			t("whiteboard.style.section.fill"),
			stickyOk,
			needSticky,
			STICKY_COLORS.map((color) => ({
				label: t(`whiteboard.style.fill.${color}`),
				onSelect: () => handlers.setStickyFill(color),
			})),
		),
		styleCategory(
			t("whiteboard.style.section.textColor"),
			textOk,
			needText,
			TEXT_COLORS.map((color) => ({
				label: t(`whiteboard.style.textColor.${color}`),
				onSelect: () => handlers.setTextColor(color),
			})),
		),
		styleCategory(
			t("whiteboard.style.section.font"),
			textOk,
			needText,
			FONT_FAMILIES.map((font) => ({
				label: t(`whiteboard.style.font.${font}`),
				onSelect: () => handlers.setFontFamily(font),
			})),
		),
		styleCategory(t("whiteboard.style.section.emphasis"), textOk, needText, [
			{
				label: t("whiteboard.style.bold"),
				...(isBold ? { icon: IconName.CheckCircle } : {}),
				onSelect: () => handlers.toggleBold(),
			},
			{
				label: t("whiteboard.style.italic"),
				...(isItalic ? { icon: IconName.CheckCircle } : {}),
				onSelect: () => handlers.toggleItalic(),
			},
		]),
	];
}
