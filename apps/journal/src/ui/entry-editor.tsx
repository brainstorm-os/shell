/**
 * JournalEntryEditor — the React island mounted inside Journal's plain-
 * DOM day-body slot (`apps/journal/src/app.ts` → `renderEntryBody`).
 *
 * The Journal day view used to render `<p>{entry.preview}</p>` — a
 * read-only flattened snippet derived from `entity.properties.body`.
 * Editing required dispatching `intent.open` against Notes (a context
 * switch the user shouldn't have to take). This component swaps the
 * read-only paragraph for the live `<BrainstormEditor>` bound to the
 * journal note's Y.Doc; edits persist through the same resolver
 * transport the Notes app uses (`services.entities.applyDoc`), so the
 * two surfaces stay in lockstep.
 *
 * First-open seeding: a journal note seeded by `seed-cli` has its body
 * in `entity.properties.body` (Lexical SerializedEditorState) but the
 * per-entity Y.Doc is still empty — Notes' `migrate-body` plants it on
 * Notes-boot, but the user might open Journal first. We pass a
 * `(editor) => void` initialiser to `<BrainstormEditor>`'s
 * `initialEditorState` prop. `CollaborationPlugin` calls that
 * initialiser exactly once — when its sync settles on an empty doc —
 * so the plant is automatic, deterministic, and idempotent across opens
 * (Notes' migrate-body and Journal both no-op against a non-empty doc).
 *
 * Minimum-viable surface: baseline Lexical nodes plus the journal-side
 * passthroughs (`JOURNAL_PASSTHROUGH_NODES` — `title`, `mention`,
 * `horizontalrule`, table cells). The passthroughs are *required*: the
 * seeded journal `.ydoc` plants a TitleNode at root[0], and without a
 * registered "title" class `@lexical/yjs`'s binding throws
 * `Node title is not registered` mid-sync and the contenteditable
 * renders empty. No MentionTypeahead, no SlashMenu, no TablesPlugin —
 * power users open the day in Notes for the full rich-text suite;
 * Journal-in-place keeps the chrome light so the calendar context
 * isn't crowded. Snippet recompute relies on Notes' `migrate-body` boot
 * pass for now — same path that already heals every other note in the
 * vault.
 */

import {
	AutosavePlugin,
	BlankRecoveryPlugin,
	BrainstormEditor,
	CommentHighlightPlugin,
	EditorCapturePlugin,
	FULL_EDITOR_NODES,
	FullEditorPlugins,
	type SelectionCommentAnchor,
	TitleNode,
	TitlePlugin,
	richTextTheme,
} from "@brainstorm/editor";
import { useYDoc, useYDocApplyPending, useYDocLoaded } from "@brainstorm/react-yjs";
import {
	$getRoot,
	$parseSerializedNode,
	type LexicalEditor,
	type SerializedEditorState,
	type SerializedLexicalNode,
} from "lexical";
import { useMemo, useRef } from "react";
import { useOpenCommentBlockIds } from "../store/comments-bindings";
import { clearJournalEditor, setJournalEditor } from "./editor-bridge";
import { JournalDevPlugin } from "./journal-dev-plugin";
import { JournalMentionClickPlugin } from "./mention-click-plugin";

/** The Journal's deliberate slash-menu palette (F-070 rung (b)): the writing
 *  blocks a daily log actually reaches for, in order. Deliberately omits the
 *  2- and 3-column layouts — Marcus flagged a multi-column layout as backwards
 *  for a dated entry (F-070). The host-gated "Reference" embed appends after. */
const JOURNAL_BLOCK_PALETTE: readonly string[] = [
	"block.paragraph",
	"block.heading1",
	"block.heading2",
	"block.heading3",
	"block.bulletList",
	"block.numberedList",
	"block.todoList",
	"block.quote",
	"block.callout",
	"block.code",
	"block.divider",
	"block.toggle",
	"block.table",
];

export type JournalEntryEditorProps = {
	/** The journal note's stable entity id (e.g. `journal-2026-05-14`).
	 *  Resolved through the shell-installed YDocResolver. */
	noteId: string;
	/** When `false`, the entry is locked (read-only) — the contenteditable
	 *  rejects edits. Defaults to editable. */
	editable?: boolean;
	/** Raw `entity.properties.body` from the projection. When present
	 *  AND shaped like a Lexical `SerializedEditorState`, used to seed
	 *  the Y.Doc on first open via `CollaborationPlugin`'s
	 *  `initialEditorState` callback. A plain-string snippet (Notes-
	 *  autosaved body) is ignored — the snippet is lossy and would
	 *  erase block structure. */
	seedBody?: unknown;
	/** Denormalise the edited body into the entity's `body` snippet so the
	 *  calendar / week previews stay in sync. Wired by `app.ts` to
	 *  `services.entities.update`; omitted in preview / standalone. */
	onDenormalize?: (noteId: string, body: SerializedEditorState) => void;
	/** Comments wiring (B11.9) — the inline toolbar's "Comment" row and the
	 *  highlight chip's click-to-thread, both routed to `app.ts` which opens
	 *  the right panel's Comments tab. Omitted in preview / standalone. */
	onCommentSelection?: (anchor: SelectionCommentAnchor) => void;
	onCommentBlockClick?: (blockId: string) => void;
	/** Blank-render recovery (F-236): the host bumps the React `key` (a
	 *  capped per-note nonce) when the Y.Doc has content but Lexical rendered
	 *  none — the apply/observeDeep race that lost a seeded / cold-reopened
	 *  body. `onRecoverReset` releases the spent budget on a clean hydrate. */
	onRecoverBlank?: () => void;
	onRecoverReset?: () => void;
	/** Hint shown while the body is empty (e.g. the "Write…" prompt on a
	 *  not-yet-created day). Rendered through `BrainstormEditor`'s placeholder. */
	placeholder?: string;
};

function isLexicalState(value: unknown): value is SerializedEditorState {
	if (!value || typeof value !== "object") return false;
	const root = (value as { root?: unknown }).root;
	if (!root || typeof root !== "object") return false;
	const r = root as { type?: unknown; children?: unknown };
	return r.type === "root" && Array.isArray(r.children);
}

/** Notes-specific node types the journal-side editor still doesn't
 *  register. Stripped before `parseEditorState` so a state planted by
 *  Notes' richer editor doesn't blow up the journal mount with an
 *  unknown-class error. The shared `@brainstorm/editor` extraction
 *  promoted Title/Toggle/Callout/Columns into this build, so those
 *  types no longer need stripping; what's still Notes-only is what
 *  hasn't moved yet (property blocks, mentions w/o typeahead, embeds,
 *  transclusions, backlinks, equations, code-block specials). */
const NOTES_ONLY_NODE_TYPES: ReadonlySet<string> = new Set([
	"backlinks",
	"property-block",
	"property-list-block",
	"block-embed",
	"toggle-summary",
	"toggle-children",
	"checklist",
	"checklist-item",
	"equation",
	"emoji",
]);

type SerializedNode = { type?: unknown; children?: unknown };

function isNotesOnlyType(type: unknown): boolean {
	return typeof type === "string" && NOTES_ONLY_NODE_TYPES.has(type);
}

/** Recursively strip nodes whose `type` isn't in `BASELINE_NODES` —
 *  preserves the inline text content where possible by lifting a
 *  Notes-only block's children into its parent. The plant fires once
 *  per fresh open; cost is negligible. */
function stripNotesOnlyNodes(value: SerializedEditorState): SerializedEditorState {
	const cloneChildren = (children: unknown): SerializedNode[] => {
		if (!Array.isArray(children)) return [];
		const out: SerializedNode[] = [];
		for (const raw of children) {
			if (!raw || typeof raw !== "object") continue;
			const node = raw as SerializedNode;
			const nested = cloneChildren(node.children);
			if (isNotesOnlyType(node.type)) {
				// Lift the lifted-block's text-bearing descendants into a
				// fresh paragraph so the content survives even though the
				// block type itself is unknown to the baseline editor.
				if (nested.length > 0) {
					out.push({
						type: "paragraph",
						version: 1,
						format: "",
						indent: 0,
						direction: null,
						children: nested,
					} as SerializedNode);
				}
				continue;
			}
			out.push({ ...node, children: nested });
		}
		return out;
	};
	const root = value.root as unknown as SerializedNode;
	const sanitized: SerializedEditorState = {
		root: {
			...root,
			children: cloneChildren(root.children),
		},
	} as unknown as SerializedEditorState;
	return sanitized;
}

/**
 * Plant a sanitized seed into an EMPTY editor — MUST run inside the
 * `editor.update()` that `CollaborationPlugin` invokes the function-variant
 * `initialEditorState` within. The old implementation called
 * `editor.setEditorState()` (and a nested `editor.update`/`editor.focus`) here,
 * which is illegal inside an active update — Lexical throws (error #94), the
 * plant is swallowed, the doc stays empty, and on the implicit-create handoff
 * the placeholder text (the user's first word) is lost (F-299). Instead we
 * deserialize the top-level blocks with the update-safe `$parseSerializedNode`
 * and append them, then drop the caret at the end so typing continues
 * uninterrupted. Returns the number of planted blocks (0 = nothing seeded).
 */
export function plantJournalSeed(editor: LexicalEditor, sanitized: SerializedEditorState): number {
	const root = $getRoot();
	if (!root.isEmpty()) return 0;
	const children = (sanitized.root as unknown as { children?: unknown })?.children;
	if (!Array.isArray(children) || children.length === 0) return 0;
	const nodes = children.map((child) => $parseSerializedNode(child as SerializedLexicalNode));
	if (nodes.length === 0) return 0;
	root.append(...nodes);
	$getRoot().selectEnd();
	return nodes.length;
}

export function JournalEntryEditor({
	noteId,
	editable,
	seedBody,
	onDenormalize,
	onCommentSelection,
	onCommentBlockClick,
	onRecoverBlank,
	onRecoverReset,
	placeholder,
}: JournalEntryEditorProps) {
	const doc = useYDoc(noteId);
	const whenLoaded = useYDocLoaded(noteId);
	const applyPending = useYDocApplyPending(noteId);
	// Blocks with an open comment thread — drives the shared highlight +
	// click-to-thread chip. Empty (and the plugin inert) without a runtime.
	const commentedBlockIds = useOpenCommentBlockIds(onCommentSelection ? noteId : null);

	// Keep the entity's denormalised `body` snippet in lockstep with edits.
	// AutosavePlugin gates this on a real KEY_DOWN/PASTE/CUT/DROP, so the
	// mount-settle / hydration echo can't fire a spurious write.
	const onChange = useMemo(
		() =>
			onDenormalize ? (state: SerializedEditorState) => onDenormalize(noteId, state) : undefined,
		[onDenormalize, noteId],
	);

	// Capture the seed ONCE per mount. `seedBody` is rebuilt with a fresh
	// object identity on every projection (each live snapshot makes a new
	// `entry`), and `initialEditorState` rides `CollaborationPlugin`'s effect
	// deps — a changing identity tears the Yjs binding down + reconnects it
	// (its cleanup runs `docMap.delete` + `provider.disconnect()` →
	// `awareness.destroy()`) on EVERY live update, blanking a saved entry on
	// reopen (the "previously-opened entry stops showing the editor" report).
	// The seed only ever matters on a fresh empty doc, so the first-seen value
	// is the only one that counts; the per-noteId `key` remount hands a correct
	// fresh seed per entry. Same discipline as Notes' `bootstrapRef`.
	const seedRef = useRef<unknown>(seedBody);
	const initialEditorState = useMemo(() => {
		const seed = seedRef.current;
		if (!isLexicalState(seed)) return undefined;
		// Notes seeds the journal body with a TitleNode at root[0] +
		// Notes-only inline nodes mixed into paragraphs; the baseline
		// editor doesn't register those classes, so Lexical's
		// `parseEditorState` throws an "unknown node" error. Lift the
		// text content out, drop the unknown shells, and plant a
		// baseline-compatible state. Journal already paints the date
		// in its own chrome — the TitleNode loss is acceptable.
		const sanitized = stripNotesOnlyNodes(seed);
		// `CollaborationPlugin` calls this inside its own `editor.update()`, so the
		// plant must use only update-safe APIs (`plantJournalSeed` appends parsed
		// nodes + drops the caret at the end). `selectEnd()` keeps the user's
		// caret-at-end after the implicit-create handoff so typing continues
		// uninterrupted; it only fires on an empty doc, so navigating to a
		// populated day never steals focus.
		return (editor: LexicalEditor) => {
			try {
				plantJournalSeed(editor, sanitized);
			} catch (error) {
				console.warn("[journal/entry-editor] seed plant failed:", error);
			}
		};
	}, []);

	return (
		<BrainstormEditor
			doc={doc}
			docId={noteId}
			editable={editable ?? true}
			namespace="journal"
			theme={richTextTheme}
			contentClassName="notes__contenteditable journal__entry-editor"
			additionalNodes={JOURNAL_EDITOR_NODES}
			{...(placeholder ? { placeholder } : {})}
			{...(initialEditorState ? { initialEditorState } : {})}
			{...(whenLoaded ? { whenLoaded } : {})}
			{...(applyPending ? { applyPending } : {})}
			onError={(error) => {
				console.error("[journal/editor]", error);
			}}
		>
			<FullEditorPlugins
				docId={noteId}
				currentEntityId={noteId}
				palette={JOURNAL_BLOCK_PALETTE}
				autoFocus
				{...(onCommentSelection ? { onComment: onCommentSelection } : {})}
			>
				<TitlePlugin />
				{onChange ? <AutosavePlugin onChange={onChange} /> : null}
				{onCommentSelection ? (
					<CommentHighlightPlugin
						blockIds={commentedBlockIds}
						{...(onCommentBlockClick ? { onBlockClick: onCommentBlockClick } : {})}
					/>
				) : null}
				{onRecoverBlank ? (
					<BlankRecoveryPlugin
						doc={doc}
						onRecover={onRecoverBlank}
						{...(whenLoaded ? { whenLoaded } : {})}
						{...(onRecoverReset ? { onHydrated: onRecoverReset } : {})}
					/>
				) : null}
				<JournalMentionClickPlugin />
				<EditorCapturePlugin onMount={setJournalEditor} onUnmount={clearJournalEditor} />
				<JournalDevPlugin entryId={noteId} />
			</FullEditorPlugins>
		</BrainstormEditor>
	);
}

/** Full Lexical node set the Journal editor registers: the title node
 *  (Journal hides it via CSS — the day chrome paints the date) plus the
 *  shared `FULL_EDITOR_NODES` (callout/toggle/columns/table/HR + the live
 *  mention / date-mention / transclusion / bookmark / web-embed nodes the
 *  shared typeaheads create). The former hand-rolled mention SHIM is gone
 *  now that the real MentionNode ships from @brainstorm/editor. */
export const JOURNAL_EDITOR_NODES = [TitleNode, ...FULL_EDITOR_NODES];
