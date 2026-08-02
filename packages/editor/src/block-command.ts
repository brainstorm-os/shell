/**
 * Shared scaffolding for the block-command palette consumed by the
 * slash menu, block-gutter action menu, and right-click context menu.
 *
 * The TYPES live in this package so every editor surface (Notes,
 * Journal, future Books / Code-editor) agrees on the shape, but the
 * actual command CATALOGUE stays app-local. Each app assembles its
 * own array of `BlockCommand`s — Notes includes media / embed /
 * property commands that depend on Notes-specific nodes, Journal
 * mounts a slimmer set tied to the baseline node kinds.
 *
 * `label` / `description` are pre-resolved strings: the host app calls
 * its own `t(...)` when constructing the array, so the editor plugins
 * never see app-namespaced i18n ids. Trade-off: locale change requires
 * rebuilding the array, which is fine in practice (locale flips are
 * full-remount events).
 */

import type { LexicalEditor, NodeKey } from "lexical";
import type { ReactNode } from "react";

export enum CommandCategory {
	Basic = "basic",
	Lists = "lists",
	Media = "media",
	Embed = "embed",
	Layout = "layout",
	Property = "property",
	/** Rarely-reached power blocks (ToC, equation) — last slash section. */
	Advanced = "advanced",
	Action = "action",
	Align = "align",
	Indent = "indent",
	TurnInto = "turn-into",
	/** Bulk text colour / highlight on the selected block(s) (B11.7) — only
	 *  surfaced in the block action menu, never the slash menu. */
	Color = "color",
	Highlight = "highlight",
}

export type CommandContext = {
	editor: LexicalEditor;
	/** Block-selection keys (top-level node ids) the command should target.
	 *  Empty when the command is dispatched from a caret-only surface (slash
	 *  menu); populated when dispatched from the gutter / action menu /
	 *  right-click menu — those surfaces seed it from the BlockSelectionStore
	 *  (or the row the user clicked). */
	blockKeys?: ReadonlySet<NodeKey>;
	/** Id of the document (entity) the editor is editing. Threaded by the host
	 *  app so document-aware commands — e.g. "Copy link to block" (B11.13),
	 *  which mints `brainstorm://entity/<documentId>#block-<blockId>` — can
	 *  reference the open document. Absent on surfaces that don't know the
	 *  document (a detached editor's slash menu). */
	documentId?: string;
};

export type BlockCommand = {
	id: string;
	category: CommandCategory;
	label: string;
	description?: string;
	icon: ReactNode;
	keywords: readonly string[];
	/** When true, the surface renders this command with a destructive
	 *  affordance (red tint in the action menu, etc.). */
	destructive?: boolean;
	/** May return a promise (Tool-7b).
	 *
	 * Every built-in command is synchronous — it edits the Lexical tree and
	 * returns. A CONTRIBUTED command is not: an app tool crosses the broker,
	 * may wait on a shell-owned approval, and refuses with a NAMED error
	 * (`Denied` · `NeedsConfirm` · `Busy` · `TooLarge` · `Timeout` ·
	 * `ProviderError`). A `void` return had nowhere to put any of that, which
	 * is why the editor surfaces could not carry app tools at all.
	 *
	 * Surfaces MUST NOT await this — the menu closes on activation either way —
	 * but they must not drop the promise either: a swallowed refusal is a menu
	 * row that silently does nothing. A contributed command reports its own
	 * outcome through the reporter it was built with, so the surface only has
	 * to avoid an unhandled rejection. */
	run: (ctx: CommandContext) => unknown;
};
