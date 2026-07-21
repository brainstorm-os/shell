/**
 * `openTableMenu` — the table-actions menu (insert / arrange / delete rows
 * and columns, toggle the header row, sort, fill down). Opened explicitly
 * from the floating trigger the `TablesPlugin` renders at the table's
 * top-left — never on cell focus.
 *
 * Renders through the shared fancy-menus runtime (`@brainstorm-os/sdk/menus`) so
 * it matches every other menu's chrome / escape-stack / glass / keyboard
 * model and carries leading icons. Each editor icon is a pre-rendered React
 * node, so we wrap it in an `IconParam` whose component renders that node
 * (fancy-menus paints icons from a component, not a pre-built element).
 */

import {
	type ContextMenuItem,
	type IconComponent,
	type IconParam,
	openContextMenu,
} from "@brainstorm-os/sdk/menus";
import type { LexicalEditor } from "lexical";
import type { ReactNode } from "react";
import type { EditorT } from "../i18n";
import {
	ArrowDownIcon,
	ArrowLeftIcon,
	ArrowRightIcon,
	ArrowUpIcon,
	FillDownIcon,
	MoveColLeftIcon,
	MoveColRightIcon,
	SortAscIcon,
	SortDescIcon,
	TableIcon,
	TrashIcon,
} from "../icons";
import {
	TableAxis,
	TableEdge,
	deleteTable,
	deleteTableLine,
	fillDownColumn,
	insertTableLine,
	moveTableColumn,
	sortTableBySelectedColumn,
	toggleHeaderRow,
} from "./table-ops";

export type OpenTableMenuOptions = {
	/** The trigger button the menu drops from (anchors + flips + toggles its
	 *  `aria-expanded` open state). */
	anchor: HTMLElement;
	editor: LexicalEditor;
	t: EditorT;
};

/** Wrap a pre-rendered editor icon node as a fancy-menus `IconParam`. */
function nodeIcon(node: ReactNode): IconParam {
	const Glyph: IconComponent = () => <>{node}</>;
	return { icon: Glyph };
}

export function openTableMenu(options: OpenTableMenuOptions): void {
	const { anchor, editor, t } = options;
	// Run a structural mutation, then return focus to the editor so typing
	// continues where the caret was.
	const op = (run: () => void) => () => {
		run();
		editor.focus();
	};
	const items: ContextMenuItem[] = [
		{
			id: "row-above",
			label: t("editor.table.rowAbove"),
			icon: nodeIcon(ArrowUpIcon()),
			onSelect: op(() => insertTableLine(editor, TableAxis.Row, TableEdge.Before)),
		},
		{
			id: "row-below",
			label: t("editor.table.rowBelow"),
			icon: nodeIcon(ArrowDownIcon()),
			onSelect: op(() => insertTableLine(editor, TableAxis.Row, TableEdge.After)),
		},
		{
			id: "col-left",
			label: t("editor.table.colLeft"),
			icon: nodeIcon(ArrowLeftIcon()),
			onSelect: op(() => insertTableLine(editor, TableAxis.Column, TableEdge.Before)),
		},
		{
			id: "col-right",
			label: t("editor.table.colRight"),
			icon: nodeIcon(ArrowRightIcon()),
			onSelect: op(() => insertTableLine(editor, TableAxis.Column, TableEdge.After)),
		},
		{ id: "divider-1", label: "", divider: true },
		{
			id: "header-row",
			label: t("editor.table.headerRow"),
			icon: nodeIcon(TableIcon()),
			onSelect: op(() => toggleHeaderRow(editor)),
		},
		{
			id: "sort-asc",
			label: t("editor.table.sortAsc"),
			icon: nodeIcon(SortAscIcon()),
			onSelect: op(() => sortTableBySelectedColumn(editor, true)),
		},
		{
			id: "sort-desc",
			label: t("editor.table.sortDesc"),
			icon: nodeIcon(SortDescIcon()),
			onSelect: op(() => sortTableBySelectedColumn(editor, false)),
		},
		{
			id: "fill-down",
			label: t("editor.table.fillDown"),
			icon: nodeIcon(FillDownIcon()),
			onSelect: op(() => fillDownColumn(editor)),
		},
		{
			id: "move-col-left",
			label: t("editor.table.moveColLeft"),
			icon: nodeIcon(MoveColLeftIcon()),
			onSelect: op(() => moveTableColumn(editor, false)),
		},
		{
			id: "move-col-right",
			label: t("editor.table.moveColRight"),
			icon: nodeIcon(MoveColRightIcon()),
			onSelect: op(() => moveTableColumn(editor, true)),
		},
		{ id: "divider-2", label: "", divider: true },
		{
			id: "delete-row",
			label: t("editor.table.deleteRow"),
			icon: nodeIcon(TrashIcon()),
			onSelect: op(() => deleteTableLine(editor, TableAxis.Row)),
		},
		{
			id: "delete-col",
			label: t("editor.table.deleteCol"),
			icon: nodeIcon(TrashIcon()),
			onSelect: op(() => deleteTableLine(editor, TableAxis.Column)),
		},
		{
			id: "delete-table",
			label: t("editor.table.deleteTable"),
			icon: nodeIcon(TrashIcon()),
			destructive: true,
			onSelect: op(() => deleteTable(editor)),
		},
	];
	const rect = anchor.getBoundingClientRect();
	openContextMenu({ x: rect.left, y: rect.bottom }, items, {
		anchor,
		menuLabel: t("editor.table.toolbar.region"),
	});
}
