/**
 * Notes' block-command registry — the shared backbone for slash menu (B4a),
 * block action menu (B4b), and right-click menu (B4c).
 *
 * Since 9.18.3c(d) the generic catalogue (turn-into, structural inserts,
 * align / indent / move / duplicate / delete actions) comes from
 * `@brainstorm/editor`'s shared `createStandardBlockCommands` /
 * `createStandardBlockActions` — the SAME set Journal / Tasks / Bookmarks
 * mount — ordered by `NOTES_BLOCK_PALETTE`. Only the genuinely Notes-coupled
 * commands (media upload, property blocks, sub-pages, ToC, equations, inline
 * field cells, the entity embed picker) are authored here, interleaved into
 * the palette where the Notes slash menu has always shown them.
 */

import {
	type BlockCommand,
	BookmarkIcon,
	ColorTarget,
	CommandCategory,
	type CommandContext,
	EmbedIcon,
	EquationIcon,
	LinkIcon,
	PropertyIcon,
	SWATCH_COLORS,
	SubPageIcon,
	SwatchColor,
	TocIcon,
	TodoListIcon,
	applySwatchToBlocks,
	createEditorT,
	createMediaBlockCommands,
	createStandardBlockActions,
	createStandardBlockCommands,
	createTransclusionCommand,
	getBlockAnchorsController,
	insertSnippet,
	orderCommandsByPalette,
	serializeBlocksAsJson,
	swatchCssValue,
} from "@brainstorm/editor";
import { COLLECTION_TYPE_URL, type Entity } from "@brainstorm/sdk-types";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { openAnchoredMenu } from "@brainstorm/sdk/object-menu";
import {
	TEMPLATE_ENTITY_TYPE,
	blockSnippetToTemplateProperties,
	entityToTemplate,
} from "@brainstorm/sdk/templates";
import {
	$createParagraphNode,
	$getNodeByKey,
	$getSelection,
	$isRangeSelection,
	type ElementNode,
	type LexicalEditor,
	type NodeKey,
} from "lexical";
import type { ReactNode } from "react";
import { t } from "../i18n/t";
import { newNoteId } from "../store/note";
import { getBrainstorm } from "../store/runtime";
import { AddPropertyTargetKind, addPropertyStore } from "./add-property-store";
import { copyBlockLink } from "./block-link";
import { embedPickerStore } from "./embed-picker-store";
import { $createBookmarkNode } from "./nodes/bookmark-node";
import { $createCheckboxFieldNode } from "./nodes/checkbox-field-node";
import { $createDateFieldNode } from "./nodes/date-field-node";
import { $createEquationNode } from "./nodes/equation-node";
import { $createNumberFieldNode } from "./nodes/number-field-node";
import { $createPageRefNode } from "./nodes/page-ref-node";
import { $createSelectFieldNode } from "./nodes/select-field-node";
import { $createTableOfContentsNode } from "./nodes/toc-node";
import { deriveSnippetName, templatesToSnippetOptions } from "./template-snippet";

/** The Notes entity type — a child sub-page is just another Note. Keep
 *  in sync with the same constant in mention-node.tsx. */
const NOTE_ENTITY_TYPE = "io.brainstorm.notes/Note/v1";

/** The Graph app's saved-graph entity type — the `/graph` slash command
 *  scopes the embed picker to it (Graph 9.13.12). */
const GRAPH_ENTITY_TYPE = "brainstorm/Graph/v1";

/** The Books app's highlight entity type — the `/book` slash command scopes
 *  the embed picker to it (Books 9.21.7); the registry resolves the chosen
 *  highlight to the `io.brainstorm.books/embedded-highlight` block. */
const HIGHLIGHT_ENTITY_TYPE = "brainstorm/Highlight/v1";

export type { BlockCommand, CommandContext } from "@brainstorm/editor";
export { CommandCategory, selectBlocksAsRange } from "@brainstorm/editor";

/** Pre-resolved editor-catalogue translator. Notes ships no editor-string
 *  overrides today, so the shared English defaults match what Journal /
 *  Tasks / Bookmarks render — one wording for the shared commands across
 *  every app (F-070). */
const editorT = createEditorT();

const sharedCommands = createStandardBlockCommands(editorT);

/** Deliberate ordered subset of the SHARED catalogue Notes exposes, in three
 *  segments so the Notes-only commands interleave where the slash menu has
 *  always shown them (media after callout, ToC after table, …). */
const PALETTE_TEXT: readonly string[] = [
	"block.paragraph",
	"block.heading1",
	"block.heading2",
	"block.heading3",
	"block.bulletList",
	"block.numberedList",
	"block.todoList",
	"block.quote",
	"block.code",
	"block.callout",
];
const PALETTE_STRUCTURE: readonly string[] = [
	"block.divider",
	"block.toggle",
	"block.toggleHeading1",
	"block.toggleHeading2",
	"block.toggleHeading3",
	"block.table",
];
const PALETTE_LAYOUT: readonly string[] = ["block.columns2", "block.columns3"];

/** The full ordered shared-id palette (F-070 rung (b)) — exported for the
 *  drift-fence test against the shared catalogue. */
export const NOTES_BLOCK_PALETTE: readonly string[] = [
	...PALETTE_TEXT,
	...PALETTE_STRUCTURE,
	...PALETTE_LAYOUT,
];

function shared(ids: readonly string[]): readonly BlockCommand[] {
	return orderCommandsByPalette(sharedCommands, ids);
}

// Media (`/image` `/video` `/audio` `/file`) is the SHARED catalogue from
// `@brainstorm/editor` — the exact same commands Journal / Tasks / Bookmarks
// mount via `<FullEditorPlugins media>` (extracted 2026-06-18). Notes does NOT
// re-author them; that fork is the drift the editor-parity test fences off.
const NOTES_MEDIA_COMMANDS: readonly BlockCommand[] = createMediaBlockCommands(editorT);

const NOTES_PROPERTY_COMMAND: BlockCommand = {
	id: "block.property.add",
	category: CommandCategory.Property,
	label: t("notes.command.property.label"),
	description: t("notes.command.property.description"),
	icon: <PropertyIcon />,
	keywords: ["property", "field", "tag", "metadata", "attribute"],
	run: ({ editor }) => {
		openAddPropertyForCaret(editor);
	},
};

const NOTES_TOC_COMMAND: BlockCommand = {
	id: "block.embed.toc",
	category: CommandCategory.Embed,
	label: t("notes.command.toc.label"),
	description: t("notes.command.toc.description"),
	icon: <TocIcon />,
	keywords: ["table of contents", "toc", "outline", "headings", "index"],
	run: ({ editor }) => {
		editor.update(() => {
			const sel = $getSelection();
			if (!$isRangeSelection(sel)) return;
			try {
				sel.anchor.getNode().getTopLevelElementOrThrow().replace($createTableOfContentsNode());
			} catch {
				// no top-level block — skip.
			}
		});
	},
};

const NOTES_EMBED_COMMANDS: readonly BlockCommand[] = [
	{
		id: "block.embed.subpage",
		category: CommandCategory.Embed,
		label: t("notes.command.subpage.label"),
		description: t("notes.command.subpage.description"),
		icon: <SubPageIcon />,
		keywords: ["page", "subpage", "sub-page", "child", "nested", "object", "note"],
		run: ({ editor }) => {
			insertSubPage(editor);
		},
	},
	{
		id: "block.embed.entity",
		category: CommandCategory.Embed,
		label: t("notes.command.embed.label"),
		description: t("notes.command.embed.description"),
		icon: <EmbedIcon />,
		keywords: ["embed", "preview", "page", "entity", "card", "reference", "insert"],
		run: ({ editor }) => {
			openEmbedPicker(editor);
		},
	},
	{
		// 9.12.12 — `/database`: the same entity picker scoped to
		// `brainstorm/List/v1`, so the chosen List mounts inline as the
		// Database app's live `embedded-list` BP block (resolved through
		// `blocks.forType` on pick, served from its bsblock:// origin).
		id: "block.embed.database",
		category: CommandCategory.Embed,
		label: t("notes.command.database.label"),
		description: t("notes.command.database.description"),
		icon: <EmbedIcon />,
		keywords: ["database", "list", "collection", "table", "grid", "view", "rows"],
		run: ({ editor }) => {
			openEmbedPicker(editor, COLLECTION_TYPE_URL);
		},
	},
	{
		id: "block.embed.graph",
		category: CommandCategory.Embed,
		label: t("notes.command.graph.label"),
		description: t("notes.command.graph.description"),
		icon: <EmbedIcon />,
		keywords: ["graph", "network", "nodes", "links", "vault", "embed"],
		// The `/graph` slash command (Graph 9.13.12) — the generic embed picker
		// scoped to saved Graph entities; the registry resolves the chosen one
		// to the `io.brainstorm.graph/embedded-graph` block.
		run: ({ editor }) => {
			openEmbedPicker(editor, GRAPH_ENTITY_TYPE);
		},
	},
	{
		id: "block.embed.book",
		category: CommandCategory.Embed,
		label: t("notes.command.book.label"),
		description: t("notes.command.book.description"),
		icon: <EmbedIcon />,
		keywords: ["book", "highlight", "annotation", "quote", "reading", "embed"],
		// The `/book` slash command (Books 9.21.7) — the generic embed picker
		// scoped to saved Highlight entities; the registry resolves the chosen one
		// to the `io.brainstorm.books/embedded-highlight` block.
		run: ({ editor }) => {
			openEmbedPicker(editor, HIGHLIGHT_ENTITY_TYPE);
		},
	},
	{
		// `/template` (B11.10 surface #2) — inserts a saved block-snippet template
		// at the caret. Opens the shared anchored-menu picker over the vault's
		// block-snippet `Template/v1`s; a no-op (quiet console) when there are none.
		id: "block.embed.template",
		category: CommandCategory.Embed,
		label: t("notes.command.template.label"),
		description: t("notes.command.template.description"),
		icon: <Icon name={IconName.Sparkle} />,
		keywords: ["template", "snippet", "insert", "reuse", "boilerplate", "block"],
		run: ({ editor }) => {
			void openTemplateSnippetPicker(editor);
		},
	},
	{
		id: "block.embed.equation",
		category: CommandCategory.Embed,
		label: t("notes.command.equation.label"),
		description: t("notes.command.equation.description"),
		icon: <EquationIcon />,
		keywords: ["equation", "math", "latex", "katex", "formula", "tex"],
		run: ({ editor }) => {
			editor.update(() => {
				const sel = $getSelection();
				if (!$isRangeSelection(sel)) return;
				try {
					sel.anchor.getNode().getTopLevelElementOrThrow().replace($createEquationNode("", false));
				} catch {
					// no top-level block — skip.
				}
			});
		},
	},
	{
		id: "block.embed.checkbox",
		category: CommandCategory.Embed,
		label: t("notes.command.checkbox.label"),
		description: t("notes.command.checkbox.description"),
		icon: <TodoListIcon />,
		keywords: ["checkbox", "check", "tick", "task", "done", "todo", "boolean", "cell"],
		// Inline insert (keeps the paragraph / table cell) — distinct from the
		// list-level todo, this drops a single checkable field at the caret.
		run: ({ editor }) => {
			editor.update(() => {
				const sel = $getSelection();
				if (!$isRangeSelection(sel)) return;
				sel.insertNodes([$createCheckboxFieldNode()]);
			});
		},
	},
	{
		id: "block.embed.date",
		category: CommandCategory.Embed,
		label: t("notes.command.date.label"),
		description: t("notes.command.date.description"),
		icon: <Icon name={IconName.KindDate} />,
		keywords: ["date", "due", "calendar", "day", "schedule", "cell", "field"],
		// Inline insert (keeps the paragraph / table cell) — drops a single
		// editable date field at the caret; the Date-typed sibling of the
		// inline checkbox.
		run: ({ editor }) => {
			editor.update(() => {
				const sel = $getSelection();
				if (!$isRangeSelection(sel)) return;
				sel.insertNodes([$createDateFieldNode()]);
			});
		},
	},
	{
		id: "block.embed.number",
		category: CommandCategory.Embed,
		label: t("notes.command.number.label"),
		description: t("notes.command.number.description"),
		icon: <Icon name={IconName.KindNumber} />,
		keywords: ["number", "numeric", "quantity", "count", "price", "score", "cell", "field"],
		// Inline insert (keeps the paragraph / table cell) — drops a single
		// editable number field at the caret; the Number-typed sibling of the
		// inline checkbox / date.
		run: ({ editor }) => {
			editor.update(() => {
				const sel = $getSelection();
				if (!$isRangeSelection(sel)) return;
				sel.insertNodes([$createNumberFieldNode()]);
			});
		},
	},
	{
		id: "block.embed.select",
		category: CommandCategory.Embed,
		label: t("notes.command.select.label"),
		description: t("notes.command.select.description"),
		icon: <Icon name={IconName.KindSelect} />,
		keywords: ["select", "status", "category", "option", "tag", "dropdown", "cell", "field"],
		// Inline insert (keeps the paragraph / table cell) — a single-select
		// field carrying its own inline option set; the Select-typed sibling of
		// the inline checkbox / date / number.
		run: ({ editor }) => {
			editor.update(() => {
				const sel = $getSelection();
				if (!$isRangeSelection(sel)) return;
				sel.insertNodes([$createSelectFieldNode()]);
			});
		},
	},
	{
		id: "block.embed.bookmark",
		category: CommandCategory.Embed,
		label: t("notes.command.bookmark.label"),
		description: t("notes.command.bookmark.description"),
		icon: <BookmarkIcon />,
		keywords: ["bookmark", "link", "url", "web", "embed", "preview"],
		run: ({ editor }) => {
			editor.update(() => {
				const sel = $getSelection();
				if (!$isRangeSelection(sel)) return;
				try {
					sel.anchor.getNode().getTopLevelElementOrThrow().replace($createBookmarkNode(""));
				} catch {
					// no top-level block (shouldn't happen from slash) — skip.
				}
			});
		},
	},
];

export const BLOCK_COMMANDS: readonly BlockCommand[] = [
	...shared(PALETTE_TEXT),
	...NOTES_MEDIA_COMMANDS,
	NOTES_PROPERTY_COMMAND,
	...shared(PALETTE_STRUCTURE),
	NOTES_TOC_COMMAND,
	...shared(PALETTE_LAYOUT),
	...NOTES_EMBED_COMMANDS,
	// Notes mounts `TransclusionTypeaheadPlugin`, so the shared host-gated
	// "Reference" command (rung (c)) belongs in its palette too.
	createTransclusionCommand(editorT),
];

/** Swatch preview for a colour action row: the letter "A" tinted (text) or
 *  on a filled chip (highlight); Default → a slashed empty chip. */
function ColorDot({ target, color }: { target: ColorTarget; color: SwatchColor }): ReactNode {
	const value = swatchCssValue(target, color);
	const style =
		value === null
			? undefined
			: target === ColorTarget.Text
				? { color: value }
				: { backgroundColor: value };
	const kind = target === ColorTarget.Text ? "text" : "highlight";
	return (
		<span
			className={`notes__color-dot notes__color-dot--${kind}${value === null ? " notes__color-dot--clear" : ""}`}
			style={style}
			aria-hidden="true"
		>
			A
		</span>
	);
}

/** A bulk text-colour / highlight action for the block action menu (B11.7) —
 *  applies the swatch to every text node in the selected block(s). */
function colorAction(target: ColorTarget, color: SwatchColor): BlockCommand {
	const isDefault = color === SwatchColor.Default;
	const kind = target === ColorTarget.Text ? "color" : "highlight";
	return {
		id: `block.${kind}.${color}`,
		category: target === ColorTarget.Text ? CommandCategory.Color : CommandCategory.Highlight,
		label: isDefault ? t("notes.inline.color.default") : t(`notes.color.${color}`),
		icon: <ColorDot target={target} color={color} />,
		keywords: ["color", "colour", "highlight", "swatch", color],
		run: ({ editor, blockKeys }) => {
			if (!blockKeys || blockKeys.size === 0) return;
			applySwatchToBlocks(editor, blockKeys, target, color);
		},
	};
}

const COPY_LINK_ACTION: BlockCommand = {
	id: "block.action.copyLink",
	category: CommandCategory.Action,
	label: t("notes.action.copyLink.label"),
	description: t("notes.action.copyLink.description"),
	icon: <LinkIcon />,
	keywords: ["copy", "link", "anchor", "permalink", "share", "reference", "block"],
	// Mints a DURABLE anchor id through the BlockAnchorsPlugin controller
	// (persisted fingerprint in the note's Y.Doc, survives reload —
	// B11.13); degrades to the session block key when the plugin isn't
	// mounted (a detached editor). Inert without a `documentId` —
	// minting a link to a phantom document would dead-end on open.
	run: ({ editor, blockKeys, documentId }) => {
		if (!documentId) return;
		const blockKey = pickAnchorBlock(blockKeys);
		if (!blockKey) return;
		const durable = getBlockAnchorsController(editor)?.ensureAnchorId(blockKey);
		void copyBlockLink(documentId, durable ?? blockKey);
	},
};

const ADD_PROPERTY_ACTION: BlockCommand = {
	id: "block.action.addProperty",
	category: CommandCategory.Property,
	label: t("notes.action.addProperty.label"),
	description: t("notes.action.addProperty.description"),
	icon: <PropertyIcon />,
	keywords: ["property", "metadata", "tag", "field", "add"],
	run: ({ editor, blockKeys }) => {
		const target = pickAnchorBlock(blockKeys);
		if (!target) return;
		openAddPropertyForBlock(editor, target);
	},
};

/** "Save selection as template" (B11.10 surface #2) — capture the selected
 *  block(s) as a block-snippet `Template/v1` the `/template` command later
 *  inserts. Fire-and-forget the create (client-minted id) so the block-action
 *  command never awaits mid-flight — mirroring `insertSubPage`. */
const SAVE_AS_TEMPLATE_ACTION: BlockCommand = {
	id: "block.action.saveAsTemplate",
	category: CommandCategory.Action,
	label: t("notes.action.saveAsTemplate.label"),
	description: t("notes.action.saveAsTemplate.description"),
	icon: <Icon name={IconName.Copy} />,
	keywords: ["template", "snippet", "save", "capture", "reuse", "block"],
	run: ({ editor, blockKeys }) => {
		saveSelectionAsTemplate(editor, blockKeys);
	},
};

const sharedActions = createStandardBlockActions(editorT);
const deleteActionIndex = sharedActions.findIndex((c) => c.id === "block.action.delete");

/** Commands shown in the block-action menu (gutter grip / right-click):
 *  the shared multi-block-aware set with the Notes-only copy-link /
 *  add-property actions slotted before Delete, plus the colour /
 *  highlight swatch rows. */
export const BLOCK_ACTIONS: readonly BlockCommand[] = [
	...sharedActions.slice(0, deleteActionIndex),
	COPY_LINK_ACTION,
	ADD_PROPERTY_ACTION,
	SAVE_AS_TEMPLATE_ACTION,
	...sharedActions.slice(deleteActionIndex),
	...SWATCH_COLORS.map((color) => colorAction(ColorTarget.Text, color)),
	...SWATCH_COLORS.map((color) => colorAction(ColorTarget.Highlight, color)),
];

/** Slash-trigger path: the caller's paragraph (the one with `/property`)
 *  is already empty — `SlashMenuPlugin.activate` cleared it before us.
 *  Open the picker anchored against that paragraph. */
function openAddPropertyForCaret(editor: LexicalEditor): void {
	let paragraphKey: NodeKey | null = null;
	editor.getEditorState().read(() => {
		const sel = $getSelection();
		if (!$isRangeSelection(sel)) return;
		const anchor = sel.anchor.getNode();
		try {
			paragraphKey = anchor.getTopLevelElementOrThrow().getKey();
		} catch {
			paragraphKey = null;
		}
	});
	if (!paragraphKey) return;
	const rect = rectForKey(editor, paragraphKey);
	if (!rect) return;
	addPropertyStore.open({
		kind: AddPropertyTargetKind.ReplaceParagraph,
		paragraphKey,
		anchor: rect,
	});
}

/** Gutter / right-click path: anchor against the first selected block,
 *  insert the resulting PropertyBlockNode *after* that block. */
function openAddPropertyForBlock(editor: LexicalEditor, blockKey: NodeKey): void {
	const rect = rectForKey(editor, blockKey);
	if (!rect) return;
	addPropertyStore.open({
		kind: AddPropertyTargetKind.InsertAfter,
		blockKey,
		anchor: rect,
	});
}

function rectForKey(editor: LexicalEditor, key: NodeKey): DOMRect | null {
	if (typeof document === "undefined") return null;
	const el = editor.getElementByKey(key);
	if (!el) return null;
	return el.getBoundingClientRect();
}

function pickAnchorBlock(keys: ReadonlySet<NodeKey> | undefined): NodeKey | null {
	if (!keys || keys.size === 0) return null;
	// Stable order is not guaranteed across Set iteration in older runtimes,
	// but in practice (V8/JSC/SM) insertion order holds — gutter passes a
	// single-element set, right-click passes a freshly-built one. The
	// fallback `for…of` is safe for both.
	for (const key of keys) return key;
	return null;
}

/** Open the entity picker for the `/embed` slash command. The slash
 *  plugin has already cleared the host paragraph by the time `run`
 *  fires, so the selection sits inside an empty top-level block — its
 *  key + bounding rect anchor the picker. */
function openEmbedPicker(editor: LexicalEditor, typeFilter?: string): void {
	let paragraphKey: NodeKey | null = null;
	editor.getEditorState().read(() => {
		const sel = $getSelection();
		if (!$isRangeSelection(sel)) return;
		try {
			paragraphKey = sel.anchor.getNode().getTopLevelElementOrThrow().getKey();
		} catch {
			paragraphKey = null;
		}
	});
	if (!paragraphKey) return;
	const el = editor.getElementByKey(paragraphKey);
	if (!el) return;
	const rect = el.getBoundingClientRect();
	embedPickerStore.open({
		paragraphKey,
		anchor: { top: rect.top, left: rect.left, bottom: rect.bottom },
		...(typeFilter !== undefined ? { typeFilter } : {}),
	});
}

/** `/template`: query the vault's block-snippet templates and open the shared
 *  anchored-menu picker over them, inserting the chosen fragment at the caret
 *  via the editor paste path (`insertSnippet`). The slash menu has already
 *  cleared its host paragraph, so the picker anchors at that caret and the
 *  insert lands there. No templates → quiet no-op (never throws). */
async function openTemplateSnippetPicker(editor: LexicalEditor): Promise<void> {
	const entities = getBrainstorm()?.services.entities;
	if (!entities) {
		console.info(
			"[notes/template] shared entities service unavailable — no snippet templates to insert.",
		);
		return;
	}
	// Capture the caret anchor point BEFORE the async query so the rect is read
	// while the editor DOM is stable (the query resolves a tick later).
	const point = caretMenuPoint(editor);
	const rows = await entities.query({ type: TEMPLATE_ENTITY_TYPE }).catch(() => []);
	const templates = rows.flatMap((row) => {
		const template = entityToTemplate(row as Entity);
		return template ? [template] : [];
	});
	const options = templatesToSnippetOptions(templates);
	if (options.length === 0) {
		console.info(
			"[notes/template] no block-snippet templates yet — capture one from a block selection's “Save selection as template”.",
		);
		return;
	}
	openAnchoredMenu(
		point,
		options.map((option) => ({
			label: option.name || t("notes.command.template.untitled"),
			icon: IconName.Sparkle,
			onSelect: () => {
				insertSnippet(editor, option.snippet);
			},
		})),
		{ menuLabel: t("notes.command.template.pickerLabel") },
	);
}

/** "Save selection as template": serialize the selected block(s) to the paste
 *  wire format and persist them as a block-snippet `Template/v1`, named from
 *  the first block's text. Fire-and-forget (client-minted by the service) so
 *  the block-action command doesn't await mid-flight. */
function saveSelectionAsTemplate(
	editor: LexicalEditor,
	blockKeys: ReadonlySet<NodeKey> | undefined,
): void {
	if (!blockKeys || blockKeys.size === 0) return;
	const entities = getBrainstorm()?.services.entities;
	if (!entities) {
		console.warn(
			"[notes/template] shared entities service unavailable — can't save a snippet template.",
		);
		return;
	}
	const snippetJson = serializeBlocksAsJson(editor, blockKeys);
	const name = deriveSnippetName(firstBlockText(editor, blockKeys), t("notes.template.defaultName"));
	const now = Date.now();
	void entities
		.create(TEMPLATE_ENTITY_TYPE, {
			...blockSnippetToTemplateProperties(name, snippetJson),
			createdAt: now,
			updatedAt: now,
		})
		.then(() => console.info(`[notes/template] saved snippet template “${name}”`))
		.catch((error) => console.warn("[notes/template] save snippet template failed:", error));
}

/** The bottom-left of the caret's top-level block — the anchor point for the
 *  `/template` picker (a cursor-style menu; no persistent trigger element). */
function caretMenuPoint(editor: LexicalEditor): { x: number; y: number } {
	let key: NodeKey | null = null;
	editor.getEditorState().read(() => {
		const sel = $getSelection();
		if (!$isRangeSelection(sel)) return;
		try {
			key = sel.anchor.getNode().getTopLevelElementOrThrow().getKey();
		} catch {
			key = null;
		}
	});
	const rect = key ? rectForKey(editor, key) : null;
	return rect ? { x: rect.left, y: rect.bottom } : { x: 0, y: 0 };
}

/** Text of the first selected block (insertion order), for naming the snippet. */
function firstBlockText(editor: LexicalEditor, blockKeys: ReadonlySet<NodeKey>): string {
	let text = "";
	editor.getEditorState().read(() => {
		for (const key of blockKeys) {
			const node = $getNodeByKey(key);
			if (node) {
				text = node.getTextContent();
				break;
			}
		}
	});
	return text;
}

function insertSubPage(editor: LexicalEditor): void {
	const entities = getBrainstorm()?.services.entities;
	if (!entities) {
		console.warn(
			"[notes/subpage] shared entities service unavailable — sub-page needs a shell that exposes entities.create.",
		);
		return;
	}
	// Client-mint the id (same generator `useNotes.create` uses) so the page-ref
	// can be inserted synchronously in ONE update — mirroring the equation /
	// bookmark commands — and the entity persisted in the background; the prior
	// `await entities.create` opened an IPC gap mid-command that left the
	// editor in a fragile state. `openEntity` fetches the row on click (it has
	// committed by then). Read the selection INSIDE the update.
	const id = newNoteId();
	let title = "";
	let refKey: string | null = null;
	editor.update(() => {
		const sel = $getSelection();
		if (!$isRangeSelection(sel)) return;
		let block: ElementNode;
		try {
			block = sel.anchor.getNode().getTopLevelElementOrThrow();
		} catch {
			return;
		}
		title = block.getTextContent().trim();
		const ref = $createPageRefNode(id, NOTE_ENTITY_TYPE, title);
		block.replace(ref);
		refKey = ref.getKey();
		// A block-level DecoratorNode can't hold the caret. `block.replace`
		// alone leaves the page-ref NODE-SELECTED (or the selection lost) — the
		// editor then behaves as if a block is selected, so the next keystrokes
		// hit block shortcuts (Mod+d duplicates, etc.) instead of typing, and
		// the page-ref looks "selected". Drop a fresh paragraph after the
		// page-ref and park a collapsed text caret there: the user keeps typing
		// normally and no node-selection lingers.
		const trailing = $createParagraphNode();
		ref.insertAfter(trailing);
		trailing.selectStart();
	});
	// The update bailed (no range selection / no top-level block) — nothing was
	// inserted, so don't mint an orphan Untitled entity with no ref pointing at
	// it.
	if (refKey === null) return;
	// Stamp createdAt/updatedAt so the sub-page sorts with a STABLE recency in
	// the sidebar (a property bag without `updatedAt` makes `parseStoredNote`
	// default it to a fresh `Date.now()` on every list parse → churn).
	const now = Date.now();
	void entities
		.create(NOTE_ENTITY_TYPE, { title, createdAt: now, updatedAt: now }, id)
		.catch((error) => {
			console.warn("[notes/subpage] entities.create failed:", error);
			// The page-ref was inserted synchronously but its target was never
			// persisted — clicking it would dead-end. Drop the dangling ref so the
			// body doesn't autosave a permanently-broken link.
			editor.update(() => {
				$getNodeByKey(refKey as string)?.remove();
			});
		});
}
