/**
 * EmojiTypeaheadPlugin — the `:`-shortcode fuzzy emoji picker (B11.1).
 *
 * Typing `:` at a word boundary followed by a query (`:grin`) opens an
 * anchored menu of matching emoji (ranked by `emojiShortcodeCandidates`);
 * picking one — Enter, click, or completing the full `:slug:` via the
 * existing transformer — splices the `:query` span out and inserts the glyph.
 * Mirrors `MentionTypeaheadPlugin`'s editor-driven model (the editor keeps
 * focus, ↑/↓/Enter/Esc route through Lexical commands) and wears the shared
 * fancy-menus glass + `.fm-row` chrome so it reads as one menu family.
 *
 * Trigger detection is pure (`detectEmojiTrigger`) so it unit-tests without
 * the editor. The `:slug:` (closed) form stays owned by
 * `EMOJI_SHORTCODE_TRANSFORMER`; this only fires on the open `:query` prefix.
 *
 * Skin tones (B11.14): a humanoid emoji (`skinToneSupport`) reveals a strip
 * of the five Fitzpatrick variants on its active/hovered row; clicking a
 * variant inserts the toned glyph, the row body inserts the neutral base.
 */

import { SkinTone } from "@brainstorm-os/sdk-types";
import {
	ALL_EMOJIS,
	type EmojiData,
	applySkinTone,
	emojiShortcodeCandidates,
} from "@brainstorm-os/sdk/icon-picker";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createTextNode,
	$getNodeByKey,
	$getSelection,
	$isRangeSelection,
	$isTextNode,
	COMMAND_PRIORITY_HIGH,
	KEY_ARROW_DOWN_COMMAND,
	KEY_ARROW_UP_COMMAND,
	KEY_ENTER_COMMAND,
	KEY_ESCAPE_COMMAND,
	type LexicalEditor,
	type NodeKey,
	type TextNode,
	createCommand,
} from "lexical";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useEditorT } from "../i18n";
import { useEditorShortcut } from "./editor-shortcut";
import { type EmojiTrigger, detectEmojiTrigger } from "./emoji-typeahead-ops";

/** Mod+e opens the emoji picker in browse mode. */
const OPEN_EMOJI_PICKER_CHORDS = ["Mod+e"] as const;

/** Force the emoji typeahead open in browse mode from outside the plugin
 *  (e.g. the Notes inline-toolbar "Emoji" overflow row) — the same path the
 *  `Mod+e` chord takes. No payload. */
export const OPEN_EMOJI_BROWSE_COMMAND = createCommand<void>("OPEN_EMOJI_BROWSE_COMMAND");

const MENU_WIDTH = 280;
const MENU_GUTTER = 4;
const MENU_MAX_HEIGHT = 300;
const MAX_CANDIDATES = 8;

/** Default browse list shown when the picker is opened by chord (empty
 *  query) — the first slice of the emoji set (Smileys & Emotion lead it). */
const BROWSE_EMOJIS: readonly EmojiData[] = ALL_EMOJIS.slice(0, MAX_CANDIDATES);

/** The five Fitzpatrick variants offered on a humanoid emoji's hover strip
 *  (neutral base is the row body itself). */
const SKIN_TONES: readonly SkinTone[] = [
	SkinTone.Light,
	SkinTone.MediumLight,
	SkinTone.Medium,
	SkinTone.MediumDark,
	SkinTone.Dark,
];

type AnchorRect = { top: number; left: number; bottom: number };
type TypeaheadState = { textKey: NodeKey; trigger: EmojiTrigger; anchor: AnchorRect };

export function EmojiTypeaheadPlugin() {
	const [editor] = useLexicalComposerContext();
	const [state, setState] = useState<TypeaheadState | null>(null);
	const [highlightIndex, setHighlightIndex] = useState(0);
	// Set by the Mod+e chord so a bare `:` opens the browse list; held
	// in a ref because the update-listener closure below reads it live and
	// must not re-subscribe when it flips.
	const forceOpenRef = useRef(false);

	const results = useMemo(() => {
		if (!state) return [];
		if (state.trigger.query === "") return BROWSE_EMOJIS;
		return emojiShortcodeCandidates(state.trigger.query, MAX_CANDIDATES);
	}, [state]);

	useEffect(() => {
		if (highlightIndex >= results.length) setHighlightIndex(0);
	}, [results.length, highlightIndex]);

	useEffect(() => {
		return editor.registerUpdateListener(({ editorState }) => {
			editorState.read(() => {
				const next = computeTriggerState(forceOpenRef.current);
				setState((prev) => {
					if (!next && !prev) return prev;
					// Leaving the trigger releases the chord-forced browse mode.
					if (!next) forceOpenRef.current = false;
					if (
						next &&
						prev &&
						next.textKey === prev.textKey &&
						next.trigger.triggerOffset === prev.trigger.triggerOffset &&
						next.trigger.query === prev.trigger.query
					) {
						return prev;
					}
					return next;
				});
			});
		});
	}, [editor]);

	const close = useCallback(() => {
		forceOpenRef.current = false;
		setState(null);
	}, []);

	// Force browse mode open + drop a `:` at a boundary the detector accepts
	// (mirrors the mention chord). Collapses a range selection to its visual
	// end first so the trigger lands *after* the selected text — the
	// inline-toolbar overflow path showing while text is selected — and is a
	// plain caret insert for the Mod+e chord. Shared by the chord and the
	// OPEN_EMOJI_BROWSE_COMMAND below.
	const forceOpenBrowse = useCallback(() => {
		editor.focus();
		forceOpenRef.current = true;
		insertEmojiBrowseTrigger(editor);
	}, [editor]);

	// Mod+e — open the emoji picker in browse mode at the caret.
	useEditorShortcut(
		OPEN_EMOJI_PICKER_CHORDS,
		useCallback(
			(event: KeyboardEvent) => {
				event.preventDefault();
				forceOpenBrowse();
			},
			[forceOpenBrowse],
		),
	);

	// Same browse-open, dispatchable from outside (the inline toolbar).
	useEffect(
		() =>
			editor.registerCommand(
				OPEN_EMOJI_BROWSE_COMMAND,
				() => {
					forceOpenBrowse();
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
		[editor, forceOpenBrowse],
	);

	const insertGlyph = useCallback(
		(glyph: string) => {
			if (!state) return;
			applyEmojiInsertion(editor, state.textKey, state.trigger, glyph);
			close();
		},
		[editor, state, close],
	);

	useEffect(() => {
		if (!state || results.length === 0) return;
		const offs = [
			editor.registerCommand(
				KEY_ARROW_DOWN_COMMAND,
				(event) => {
					event?.preventDefault();
					setHighlightIndex((i) => (i + 1) % results.length);
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_ARROW_UP_COMMAND,
				(event) => {
					event?.preventDefault();
					setHighlightIndex((i) => (i - 1 + results.length) % results.length);
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_ENTER_COMMAND,
				(event) => {
					event?.preventDefault();
					const pick = results[highlightIndex];
					if (pick) insertGlyph(pick.char);
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
			editor.registerCommand(
				KEY_ESCAPE_COMMAND,
				(event) => {
					event?.preventDefault();
					close();
					return true;
				},
				COMMAND_PRIORITY_HIGH,
			),
		];
		return () => {
			for (const off of offs) off();
		};
	}, [editor, state, results, highlightIndex, insertGlyph, close]);

	if (!state || results.length === 0) return null;

	return (
		<EmojiMenu
			anchor={state.anchor}
			results={results}
			highlightIndex={highlightIndex}
			onHover={setHighlightIndex}
			onPick={insertGlyph}
		/>
	);
}

function computeTriggerState(allowEmpty: boolean): TypeaheadState | null {
	const selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
	const node = selection.anchor.getNode();
	if (!$isTextNode(node)) return null;
	const trigger = detectEmojiTrigger(node.getTextContent(), selection.anchor.offset, allowEmpty);
	if (!trigger) return null;
	const rect = readCaretRect();
	if (!rect) return null;
	return { textKey: node.getKey(), trigger, anchor: rect };
}

function readCaretRect(): AnchorRect | null {
	if (typeof window === "undefined") return null;
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0).cloneRange();
	const rects = range.getClientRects();
	const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
	if (!rect || (rect.top === 0 && rect.left === 0 && rect.bottom === 0)) return null;
	return { top: rect.top, left: rect.left, bottom: rect.bottom };
}

function EmojiMenu({
	anchor,
	results,
	highlightIndex,
	onHover,
	onPick,
}: {
	anchor: AnchorRect;
	results: readonly EmojiData[];
	highlightIndex: number;
	onHover: (index: number) => void;
	onPick: (glyph: string) => void;
}) {
	const t = useEditorT();
	const activeRef = useRef<HTMLButtonElement | null>(null);
	const [style, setStyle] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

	useLayoutEffect(() => {
		const viewportH = window.innerHeight;
		const viewportW = window.innerWidth;
		const spaceBelow = viewportH - anchor.bottom;
		const flipped = spaceBelow < MENU_MAX_HEIGHT + MENU_GUTTER && anchor.top > spaceBelow;
		const top = flipped
			? Math.max(8, anchor.top - MENU_MAX_HEIGHT - MENU_GUTTER)
			: anchor.bottom + MENU_GUTTER;
		const left = Math.min(Math.max(8, anchor.left), viewportW - MENU_WIDTH - 8);
		setStyle({ top, left });
	}, [anchor]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll the active row into view on highlight change.
	useEffect(() => {
		activeRef.current?.scrollIntoView({ block: "nearest" });
	}, [highlightIndex]);

	return (
		<div
			className="fm-menu notes__mention-menu"
			role="listbox"
			aria-label={t("editor.emoji.region")}
			tabIndex={-1}
			style={{ top: `${style.top}px`, left: `${style.left}px`, width: `${MENU_WIDTH}px` }}
			onMouseDown={(event) => event.preventDefault()}
		>
			<div className="fm-list" role="presentation">
				{results.map((emoji, index) => {
					const isActive = index === highlightIndex;
					return (
						<div key={emoji.slug} className="notes__emoji-row" onMouseEnter={() => onHover(index)}>
							<button
								ref={isActive ? activeRef : null}
								type="button"
								role="option"
								aria-selected={isActive}
								data-active={isActive || undefined}
								className="fm-row"
								onClick={() => onPick(emoji.char)}
							>
								<span className="fm-row__icon" aria-hidden="true">
									{emoji.char}
								</span>
								<span className="fm-row__name">{emoji.name}</span>
								<span className="fm-row__caption">{`:${emoji.slug}:`}</span>
							</button>
							{emoji.skinToneSupport && isActive && (
								<div className="notes__emoji-tones" role="group" aria-label={t("editor.emoji.skinTone")}>
									{SKIN_TONES.map((tone) => {
										const toned = applySkinTone(emoji.char, tone);
										return (
											<button
												key={tone}
												type="button"
												className="notes__emoji-tone"
												aria-label={t("editor.emoji.skinTone")}
												onClick={() => onPick(toned)}
											>
												{toned}
											</button>
										);
									})}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

/** Splice the `:query` span out of its text node and drop the glyph in,
 *  leaving the caret right after it. */
export function applyEmojiInsertion(
	editor: LexicalEditor,
	textKey: NodeKey,
	trigger: EmojiTrigger,
	glyph: string,
): void {
	editor.update(
		() => {
			const node = $getNodeByKey(textKey);
			if (!node || !$isTextNode(node)) return;
			const text = node.getTextContent();
			const start = trigger.triggerOffset;
			const end = start + 1 + trigger.query.length;
			if (end > text.length) return;
			const middle = pickMiddle(node, text, start, end);
			if (!middle) return;
			const glyphNode = $createTextNode(glyph);
			middle.replace(glyphNode);
			glyphNode.select(glyph.length, glyph.length);
		},
		{ discrete: true },
	);
}

function pickMiddle(node: TextNode, text: string, start: number, end: number): TextNode | null {
	if (start === 0 && end === text.length) return node;
	const parts = node.splitText(start, end);
	if (parts.length === 0) return null;
	if (start === 0) return parts[0] ?? null;
	return parts[1] ?? null;
}

/** Insert a `:` trigger at the caret (or right after a range selection — the
 *  selection is collapsed to its visual end first, so the selected text
 *  survives) at a boundary `detectEmojiTrigger` accepts: a leading space is
 *  added when the preceding char isn't already a break. Shared by the `Mod+e`
 *  chord and the `OPEN_EMOJI_BROWSE_COMMAND` (the inline-toolbar overflow row),
 *  so both land the same trigger; the caller flips the browse-mode flag. */
export function insertEmojiBrowseTrigger(editor: LexicalEditor): void {
	editor.update(() => {
		const sel = $getSelection();
		if (!$isRangeSelection(sel)) return;
		if (!sel.isCollapsed()) {
			const end = sel.isBackward() ? sel.anchor : sel.focus;
			sel.anchor.set(end.key, end.offset, end.type);
			sel.focus.set(end.key, end.offset, end.type);
		}
		const node = sel.anchor.getNode();
		const before = $isTextNode(node) ? node.getTextContent().slice(0, sel.anchor.offset) : "";
		sel.insertText(emojiBrowseInsertText(before));
	});
}

/** The `:` trigger to splice in given the text preceding the caret — prefixed
 *  with a space unless the previous char is already a break (whitespace or an
 *  opening bracket) or there is none, so `detectEmojiTrigger` accepts it. */
export function emojiBrowseInsertText(before: string): string {
	const prev = before.slice(-1);
	const needsSpace = prev !== "" && !/[\s([{]/.test(prev);
	return needsSpace ? " :" : ":";
}
