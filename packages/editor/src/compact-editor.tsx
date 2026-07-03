/**
 * `<CompactEditor>` — a small, non-Yjs Lexical surface for short rich text
 * (chat messages, comments, replies). It is deliberately NOT the block
 * document editor: no slash menu, no block gutter, no headings/lists/toggles.
 * The user gets inline marks (bold / italic / underline / strike / code) and
 * links via the shared `InlineToolbarPlugin` + native chords, Enter-to-submit
 * and Shift+Enter for a newline — the messaging contract every composer uses.
 *
 * Unlike `<BrainstormEditor>` (always Yjs/collaboration-backed for a persisted
 * document), a CompactEditor is a transient local draft: its content is read
 * out on submit as BOTH a serialized Lexical state (the rich body) and a
 * plain-text flattening (the body agents / search read), then the surface is
 * cleared. There is no CRDT and no per-draft Y.Doc — the message/comment entity
 * is what persists.
 */

import { AutoLinkNode, LinkNode } from "@lexical/link";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	COMMAND_PRIORITY_HIGH,
	type EditorState,
	FORMAT_TEXT_COMMAND,
	KEY_ENTER_COMMAND,
	type Klass,
	type LexicalEditor,
	type LexicalNode,
} from "lexical";
import {
	type ForwardedRef,
	type ReactNode,
	forwardRef,
	useEffect,
	useImperativeHandle,
	useMemo,
} from "react";
import { EditorI18nProvider, type EditorManifest } from "./i18n";
import { InlineToolbarPlugin } from "./plugins/inline-toolbar-plugin";
import { mergeTheme } from "./theme";
// Colocated so the surface carries its own chrome (grid overlay, single-line
// sizing, inline marks). A bare side-effect import in index.ts gets dropped by
// consumers that import named exports — the package is `sideEffects: ["*.css"]`,
// which marks index.ts pure, so Rollup hoists straight to this module and skips
// index.ts's CSS line. Importing it here is what every CompactEditor host gets.
import "./compact-editor.css";

/** The two representations a composer persists: `state` is the rich Lexical
 *  JSON (stored on the entity's `richBody`); `text` is the plain-text
 *  flattening (the entity's `body`, what persona-agents + search read). */
export type CompactEditorPayload = {
	/** Serialized Lexical `EditorState` as JSON (the rich body). */
	state: string;
	/** Plain-text flattening, newlines preserved (the plain body). */
	text: string;
	/** No meaningful content (whitespace-only). */
	isEmpty: boolean;
};

/** Imperative control a host keeps via `ref` — drives a Send button, focuses
 *  the surface, or clears it after an out-of-band send. */
export type CompactEditorHandle = {
	/** Read the current payload and fire `onSubmit` (no-op when empty/disabled). */
	submit(): void;
	/** Empty the surface back to a single blank paragraph. */
	clear(): void;
	/** Move focus into the editor. */
	focus(): void;
	/** Replace the draft with plain text (intent seeding), caret at the end. */
	setText(text: string): void;
};

export type CompactEditorProps = {
	/** Placeholder shown while empty. */
	placeholder?: ReactNode;
	/** Accessible name for the editing surface. */
	ariaLabel?: string;
	/** Class on the outer wrapper. */
	className?: string;
	/** Class on the contenteditable host. */
	contentClassName?: string;
	/** Focus the surface on mount. */
	autoFocus?: boolean;
	/** Lock the surface (no edits, no submit). */
	disabled?: boolean;
	/** Show the floating inline-format toolbar on selection (default true). */
	toolbar?: boolean;
	/** Fires on every edit so the host can reflect empty/non-empty state
	 *  (e.g. enable a Send button). */
	onChange?: (payload: CompactEditorPayload) => void;
	/** Enter (or `handle.submit()`) fires this with the current payload. The
	 *  surface is NOT auto-cleared — the host calls `handle.clear()` once the
	 *  send succeeds, so a rejected/failed send keeps the draft. */
	onSubmit?: (payload: CompactEditorPayload) => void;
	/** Extra Lexical node classes (e.g. `MentionNode`) registered alongside
	 *  the inline baseline. */
	additionalNodes?: ReadonlyArray<Klass<LexicalNode>>;
	/** Extra plugins mounted inside the composer (e.g. a mention typeahead). */
	children?: ReactNode;
	/** Host overrides for editor-internal strings (inline toolbar labels). */
	i18nOverrides?: Partial<EditorManifest>;
};

/** The inline-only node set: links on top of the always-registered Paragraph /
 *  Text / LineBreak built-ins. Block nodes are intentionally excluded. */
const INLINE_BASELINE_NODES: ReadonlyArray<Klass<LexicalNode>> = [LinkNode, AutoLinkNode];

function readPayload(editor: LexicalEditor): CompactEditorPayload {
	const editorState = editor.getEditorState();
	const state = JSON.stringify(editorState.toJSON());
	const text = editorState.read(() => $getRoot().getTextContent());
	return { state, text, isEmpty: text.trim().length === 0 };
}

/** Behaviour bridge — lives inside the composer so it has the editor instance.
 *  Wires the imperative handle, the change notifier, Enter-to-submit, the
 *  strike/code chords, and the disabled/autoFocus lifecycle. */
function CompactBehaviorPlugin({
	handleRef,
	onChange,
	onSubmit,
	disabled,
	autoFocus,
}: {
	handleRef: ForwardedRef<CompactEditorHandle>;
	onChange: ((payload: CompactEditorPayload) => void) | undefined;
	onSubmit: ((payload: CompactEditorPayload) => void) | undefined;
	disabled: boolean;
	autoFocus: boolean;
}): null {
	const [editor] = useLexicalComposerContext();

	const clear = useMemo(
		() => () => {
			editor.update(() => {
				const root = $getRoot();
				root.clear();
				root.append($createParagraphNode());
			});
		},
		[editor],
	);

	const doSubmit = useMemo(
		() => () => {
			if (disabled) return;
			const payload = readPayload(editor);
			if (payload.isEmpty) return;
			onSubmit?.(payload);
		},
		[editor, disabled, onSubmit],
	);

	useImperativeHandle(
		handleRef,
		() => ({
			submit: doSubmit,
			clear,
			focus: () => editor.focus(),
			setText: (text: string) => {
				// Discrete so a follow-up `submit()` in the same tick reads the seeded
				// draft (Lexical otherwise batches the update to a microtask).
				editor.update(
					() => {
						const root = $getRoot();
						root.clear();
						const paragraph = $createParagraphNode();
						if (text) paragraph.append($createTextNode(text));
						root.append(paragraph);
						paragraph.selectEnd();
					},
					{ discrete: true },
				);
			},
		}),
		[doSubmit, clear, editor],
	);

	useEffect(() => editor.setEditable(!disabled), [editor, disabled]);

	useEffect(() => {
		if (autoFocus && !disabled) editor.focus();
	}, [editor, autoFocus, disabled]);

	useEffect(() => {
		if (!onChange) return;
		return editor.registerUpdateListener(({ editorState }: { editorState: EditorState }) => {
			const text = editorState.read(() => $getRoot().getTextContent());
			onChange({
				state: JSON.stringify(editorState.toJSON()),
				text,
				isEmpty: text.trim().length === 0,
			});
		});
	}, [editor, onChange]);

	useEffect(
		() =>
			editor.registerCommand(
				KEY_ENTER_COMMAND,
				(event: KeyboardEvent | null) => {
					// Shift+Enter keeps Lexical's default (soft newline); IME-composition
					// Enter (the CJK candidate confirm) never submits.
					if (event === null || event.shiftKey || event.isComposing) return false;
					event.preventDefault();
					doSubmit();
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
		[editor, doSubmit],
	);

	useEffect(() => {
		function onKeydown(e: KeyboardEvent): void {
			if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
			const key = e.key.toLowerCase();
			if (key !== "s" && key !== "e") return;
			e.preventDefault();
			editor.dispatchCommand(FORMAT_TEXT_COMMAND, key === "s" ? "strikethrough" : "code");
		}
		const root = editor.getRootElement();
		root?.addEventListener("keydown", onKeydown);
		return () => root?.removeEventListener("keydown", onKeydown);
	}, [editor]);

	return null;
}

export const CompactEditor = forwardRef<CompactEditorHandle, CompactEditorProps>(
	function CompactEditor(props, ref): ReactNode {
		const {
			placeholder = null,
			ariaLabel,
			className = "",
			contentClassName = "bs-compact-editor__content",
			autoFocus = false,
			disabled = false,
			toolbar = true,
			onChange,
			onSubmit,
			additionalNodes,
			children,
			i18nOverrides,
		} = props;

		// `editable` is reconciled live by the behaviour plugin's `setEditable`
		// effect, so the static config is always editable — rebuilding it on a
		// `disabled` flip would remount the composer and lose draft content.
		const initialConfig = useMemo(
			() => ({
				namespace: "brainstorm-compact-editor",
				theme: mergeTheme(),
				editable: true,
				nodes: additionalNodes ? [...INLINE_BASELINE_NODES, ...additionalNodes] : INLINE_BASELINE_NODES,
				onError: (error: Error) => {
					console.error("[brainstorm-compact-editor]", error);
				},
			}),
			[additionalNodes],
		);

		return (
			<EditorI18nProvider {...(i18nOverrides ? { overrides: i18nOverrides } : {})}>
				<LexicalComposer initialConfig={initialConfig}>
					<div className={`bs-compact-editor ${className}`.trim()}>
						<RichTextPlugin
							contentEditable={
								<ContentEditable
									className={contentClassName}
									{...(ariaLabel ? { ariaLabel } : {})}
									spellCheck
								/>
							}
							placeholder={<div className="bs-compact-editor__placeholder">{placeholder}</div>}
							ErrorBoundary={LexicalErrorBoundary}
						/>
						<HistoryPlugin />
						<LinkPlugin />
						{toolbar ? <InlineToolbarPlugin /> : null}
						<CompactBehaviorPlugin
							handleRef={ref}
							onChange={onChange}
							onSubmit={onSubmit}
							disabled={disabled}
							autoFocus={autoFocus}
						/>
						{children}
					</div>
				</LexicalComposer>
			</EditorI18nProvider>
		);
	},
);
