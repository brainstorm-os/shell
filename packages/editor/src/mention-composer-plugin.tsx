/**
 * `MentionComposerPlugin` — the editor-native `@`-mention bridge for any
 * `CompactEditor` surface (chat composer, comment composer). The shared
 * `composer-context` mention hook is coupled to a `<textarea>` (it reads
 * `selectionStart` / rewrites `value`); a Lexical surface has neither, so this
 * re-wires the same flow over the editor:
 *
 *   - on every selection/edit, read the active text node + caret offset and run
 *     the shared {@link detectMention}; an `@token` opens the shared fancy-menus
 *     typeahead anchored to the editor, the host searches, results render;
 *   - arrow / enter / tab / escape are claimed at CRITICAL priority so they
 *     drive the typeahead BEFORE the CompactEditor's Enter-to-submit handler;
 *   - committing a row hands the chosen candidate to the consumer and rewrites
 *     the `@token`: with {@link MentionComposerPluginProps.insertNode} (the
 *     chat/agent model) the token becomes a real inline {@link MentionNode}
 *     chip followed by a space — Slack-style, the mention lives in the text; a
 *     consumer can instead supply {@link MentionComposerPluginProps.tokenText}
 *     to leave a plain `@Name` run (the comments model); by default the token
 *     is excised entirely (the legacy rail-chip model).
 *
 * The `+`/"add" affordance drives the same flow via the imperative
 * {@link MentionComposerHandle.trigger}, inserting `@` at the caret.
 */

import {
	type ComposerContextHost,
	type ContextCandidate,
	type MentionMatch,
	clearMentionToken,
	detectMention,
} from "@brainstorm-os/sdk/composer-context";
import {
	type TypeaheadMenuItem,
	closeTypeaheadMenu,
	openTypeaheadMenu,
	setTypeaheadActiveIndex,
} from "@brainstorm-os/sdk/menus";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister } from "@lexical/utils";
import {
	$getNodeByKey,
	$getSelection,
	$isRangeSelection,
	$isTextNode,
	COMMAND_PRIORITY_CRITICAL,
	KEY_ARROW_DOWN_COMMAND,
	KEY_ARROW_UP_COMMAND,
	KEY_ENTER_COMMAND,
	KEY_ESCAPE_COMMAND,
	KEY_TAB_COMMAND,
} from "lexical";
import {
	type ForwardedRef,
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
} from "react";
import { $createMentionNode } from "./nodes/mention-node";

/** Debounce before firing the host search, so each keystroke doesn't hit the
 *  vault. Matches the shared textarea hook. */
const SEARCH_DEBOUNCE_MS = 120;

export type MentionComposerHandle = {
	/** Insert the `@` trigger at the caret + focus — the "add" button's path. */
	trigger: () => void;
};

export type MentionComposerPluginProps = {
	host: ComposerContextHost;
	/** Called with the chosen candidate when a row commits. Optional — an
	 *  `insertNode` consumer usually needs no side channel (the mention lives in
	 *  the editor state and is read off the submitted rich body). */
	onSelect?: (candidate: ContextCandidate) => void;
	/** Accessible name for the typeahead listbox (host `t()`-resolved). */
	ariaLabel: string;
	/** Row label when the search returned nothing (host `t()`-resolved). */
	emptyLabel: string;
	/** How to rewrite the `@token` on commit. Return the replacement text (e.g.
	 *  `"@Ada "`) to leave an inline mention run; return null (the default) to
	 *  excise the token entirely (the rail-chip model). Ignored when
	 *  {@link insertNode} is set. */
	tokenText?: (candidate: ContextCandidate) => string | null;
	/** Replace the `@token` with a real inline {@link MentionNode} chip (plus a
	 *  trailing space so typing continues naturally). The host's CompactEditor
	 *  must register `MentionNode` via `additionalNodes`. */
	insertNode?: boolean;
};

type ActiveMention = { nodeKey: string; match: MentionMatch; caret: number };

export const MentionComposerPlugin = forwardRef<MentionComposerHandle, MentionComposerPluginProps>(
	function MentionComposerPlugin(
		{ host, onSelect, ariaLabel, emptyLabel, tokenText, insertNode },
		ref: ForwardedRef<MentionComposerHandle>,
	) {
		const [editor] = useLexicalComposerContext();
		const openRef = useRef(false);
		const activeRef = useRef<ActiveMention | null>(null);
		const candidatesRef = useRef<readonly ContextCandidate[]>([]);
		const activeIndexRef = useRef(0);
		const searchSeqRef = useRef(0);
		const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

		const close = useCallback(() => {
			activeRef.current = null;
			candidatesRef.current = [];
			activeIndexRef.current = 0;
			searchSeqRef.current++;
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
			}
			closeTypeaheadMenu();
			openRef.current = false;
		}, []);

		const commit = useCallback(
			(candidate: ContextCandidate) => {
				const active = activeRef.current;
				if (active) {
					editor.update(() => {
						const node = $getNodeByKey(active.nodeKey);
						if ($isTextNode(node)) {
							const cleared = clearMentionToken(node.getTextContent(), active.match, active.caret);
							if (insertNode) {
								node.setTextContent(cleared.text);
								node.select(cleared.caret, cleared.caret);
								const sel = $getSelection();
								if ($isRangeSelection(sel)) {
									sel.insertNodes([
										$createMentionNode(candidate.id, candidate.entityType ?? "", candidate.label),
									]);
									sel.insertText(" ");
								}
								return;
							}
							const inline = tokenText?.(candidate) ?? null;
							if (inline === null) {
								node.setTextContent(cleared.text);
								node.select(cleared.caret, cleared.caret);
							} else {
								const next =
									cleared.text.slice(0, cleared.caret) + inline + cleared.text.slice(cleared.caret);
								const caret = cleared.caret + inline.length;
								node.setTextContent(next);
								node.select(caret, caret);
							}
						}
					});
				}
				onSelect?.(candidate);
				close();
			},
			[editor, onSelect, close, tokenText, insertNode],
		);

		const commitById = useCallback(
			(id: string) => {
				const candidate = candidatesRef.current.find((c) => c.id === id);
				if (candidate) commit(candidate);
			},
			[commit],
		);

		const render = useCallback(() => {
			const anchor = editor.getRootElement();
			if (!anchor) return;
			const candidates = candidatesRef.current;
			const items: TypeaheadMenuItem[] =
				candidates.length > 0
					? candidates.map((c) => ({
							id: c.id,
							label: c.label,
							...(c.description ? { description: c.description } : {}),
						}))
					: [{ id: "__empty__", label: emptyLabel, disabled: true }];
			openTypeaheadMenu({
				items,
				anchor,
				activeIndex: candidates.length > 0 ? activeIndexRef.current : -1,
				ariaLabel,
				onSelect: commitById,
			});
			openRef.current = true;
		}, [editor, ariaLabel, emptyLabel, commitById]);

		const runSearch = useCallback(
			(query: string) => {
				const seq = ++searchSeqRef.current;
				void Promise.resolve(host.searchCandidates(query))
					.then((results) => {
						if (seq !== searchSeqRef.current) return;
						candidatesRef.current = results;
						activeIndexRef.current = 0;
						render();
					})
					.catch(() => {
						if (seq !== searchSeqRef.current) return;
						candidatesRef.current = [];
						render();
					});
			},
			[host, render],
		);

		// Re-detect the active mention on every selection/content change.
		useEffect(
			() =>
				editor.registerUpdateListener(({ editorState }) => {
					editorState.read(() => {
						const sel = $getSelection();
						if (!$isRangeSelection(sel) || !sel.isCollapsed()) {
							if (openRef.current) close();
							return;
						}
						const node = sel.anchor.getNode();
						if (!$isTextNode(node)) {
							if (openRef.current) close();
							return;
						}
						const offset = sel.anchor.offset;
						const match = detectMention(node.getTextContent(), offset);
						if (!match) {
							if (openRef.current) close();
							return;
						}
						activeRef.current = { nodeKey: node.getKey(), match, caret: offset };
						if (debounceRef.current) clearTimeout(debounceRef.current);
						const query = match.query;
						debounceRef.current = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
						if (!openRef.current) render();
					});
				}),
			[editor, close, render, runSearch],
		);

		// Claim navigation/commit keys before the composer's Enter-to-submit.
		useEffect(
			() =>
				mergeRegister(
					editor.registerCommand(
						KEY_ARROW_DOWN_COMMAND,
						(e) => {
							if (!openRef.current) return false;
							e?.preventDefault();
							const n = candidatesRef.current.length;
							if (n > 0) {
								activeIndexRef.current = (activeIndexRef.current + 1) % n;
								setTypeaheadActiveIndex(activeIndexRef.current);
							}
							return true;
						},
						COMMAND_PRIORITY_CRITICAL,
					),
					editor.registerCommand(
						KEY_ARROW_UP_COMMAND,
						(e) => {
							if (!openRef.current) return false;
							e?.preventDefault();
							const n = candidatesRef.current.length;
							if (n > 0) {
								activeIndexRef.current = (activeIndexRef.current - 1 + n) % n;
								setTypeaheadActiveIndex(activeIndexRef.current);
							}
							return true;
						},
						COMMAND_PRIORITY_CRITICAL,
					),
					editor.registerCommand(
						KEY_ENTER_COMMAND,
						(e) => {
							if (!openRef.current) return false;
							const candidate = candidatesRef.current[activeIndexRef.current];
							e?.preventDefault();
							if (candidate) commit(candidate);
							return true;
						},
						COMMAND_PRIORITY_CRITICAL,
					),
					editor.registerCommand(
						KEY_TAB_COMMAND,
						(e) => {
							if (!openRef.current) return false;
							const candidate = candidatesRef.current[activeIndexRef.current];
							if (!candidate) return false;
							e?.preventDefault();
							commit(candidate);
							return true;
						},
						COMMAND_PRIORITY_CRITICAL,
					),
					editor.registerCommand(
						KEY_ESCAPE_COMMAND,
						(e) => {
							if (!openRef.current) return false;
							e?.preventDefault();
							close();
							return true;
						},
						COMMAND_PRIORITY_CRITICAL,
					),
				),
			[editor, commit, close],
		);

		useImperativeHandle(
			ref,
			() => ({
				trigger: () => {
					editor.focus();
					editor.update(() => {
						const sel = $getSelection();
						if (!$isRangeSelection(sel)) return;
						const node = sel.anchor.getNode();
						const offset = sel.anchor.offset;
						const prev = $isTextNode(node) && offset > 0 ? node.getTextContent().charAt(offset - 1) : " ";
						sel.insertText(/\s/.test(prev) || offset === 0 ? "@" : " @");
					});
				},
			}),
			[editor],
		);

		// Tear down the menu (and any pending search timer) on unmount.
		useEffect(() => close, [close]);

		return null;
	},
);
