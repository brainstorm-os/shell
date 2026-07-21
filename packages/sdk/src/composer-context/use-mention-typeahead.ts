/**
 * `useMentionTypeahead` — wires a plain `<textarea>` composer to the shared
 * fancy-menus typeahead (controlled-list mode) for `@`-mentions. As the user
 * types, {@link detectMention} finds the active `@token`; the host searches for
 * matching entities/people; the results render in the runtime typeahead anchored
 * to the textarea, with the HOST owning the keyboard (arrow / enter / escape) per
 * the controlled-list contract. Committing a row excises the typed `@token` and
 * hands the host a {@link MessageAttachment} to add to its draft rail.
 *
 * The composer keeps focus throughout (the typeahead never grabs it), so typing
 * is never interrupted — the sanctioned pattern from the editor caret typeaheads.
 */

import type { MessageAttachment } from "@brainstorm-os/sdk-types";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type TypeaheadMenuItem,
	closeTypeaheadMenu,
	openTypeaheadMenu,
	setTypeaheadActiveIndex,
} from "../menus";
import { type MentionMatch, clearMentionToken, detectMention } from "./mention-detect";
import { type ComposerContextHost, type ContextCandidate, candidateToAttachment } from "./types";

/** Debounce before firing the host search, so each keystroke doesn't hit the
 *  vault. Short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 120;

export type UseMentionTypeaheadOptions = {
	host: ComposerContextHost;
	/** The textarea's current value (the host owns the input state). */
	value: string;
	/** Replace the textarea value (used to excise the `@token` on commit). */
	setValue: (next: string) => void;
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	/** Add the committed attachment to the host's draft rail. */
	onAttach: (att: MessageAttachment) => void;
	/** Accessible name for the typeahead listbox (host `t()`-resolved). */
	ariaLabel: string;
	/** Row label when the search returned nothing (host `t()`-resolved). */
	emptyLabel: string;
};

export type MentionTypeahead = {
	/** Whether the typeahead is currently open (composer suppresses Enter-send). */
	isOpen: boolean;
	/** Call from the textarea's `onChange` AFTER updating `value`, and from
	 *  caret-moving events (click / keyup), to recompute the active mention. */
	sync: () => void;
	/** Call from the textarea's `onKeyDown`. Returns true when the keystroke was
	 *  consumed by the typeahead (the composer must then NOT also act on it). */
	onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
	/** Insert the `@` trigger at the caret and focus the textarea — the discovery
	 *  path for the attach button (so users who don't know to type `@` still can). */
	trigger: () => void;
	/** Close the typeahead immediately. */
	close: () => void;
	/** Deferred close for the textarea's `onBlur` — waits a tick so a click on a
	 *  typeahead row commits first. Timer-safe across unmount. */
	blur: () => void;
};

export function useMentionTypeahead(options: UseMentionTypeaheadOptions): MentionTypeahead {
	const { host, value, setValue, textareaRef, onAttach, ariaLabel, emptyLabel } = options;

	const [isOpen, setIsOpen] = useState(false);
	const candidatesRef = useRef<readonly ContextCandidate[]>([]);
	const activeIndexRef = useRef(0);
	const matchRef = useRef<MentionMatch | null>(null);
	// Monotonic id so a slow search result can't overwrite a newer one.
	const searchSeqRef = useRef(0);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const close = useCallback(() => {
		matchRef.current = null;
		candidatesRef.current = [];
		activeIndexRef.current = 0;
		searchSeqRef.current++;
		if (debounceRef.current) {
			clearTimeout(debounceRef.current);
			debounceRef.current = null;
		}
		if (blurTimerRef.current) {
			clearTimeout(blurTimerRef.current);
			blurTimerRef.current = null;
		}
		closeTypeaheadMenu();
		setIsOpen(false);
	}, []);

	const render = useCallback(() => {
		const anchor = textareaRef.current;
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
			onSelect: (id) => commitById(id),
		});
		setIsOpen(true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ariaLabel, emptyLabel, textareaRef]);

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

	const sync = useCallback(() => {
		const el = textareaRef.current;
		if (!el) return;
		const match = detectMention(el.value, el.selectionStart ?? el.value.length);
		if (!match) {
			if (matchRef.current) close();
			return;
		}
		matchRef.current = match;
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => runSearch(match.query), SEARCH_DEBOUNCE_MS);
		// Open immediately (with prior/empty items) so the panel doesn't flicker;
		// the debounced search refreshes the rows.
		if (!isOpen) render();
	}, [textareaRef, close, runSearch, render, isOpen]);

	const commitCandidate = useCallback(
		(candidate: ContextCandidate) => {
			const el = textareaRef.current;
			const match = matchRef.current;
			if (el && match) {
				const caret = el.selectionStart ?? el.value.length;
				const next = clearMentionToken(el.value, match, caret);
				setValue(next.text);
				// Restore the caret to where the `@` was, after React applies the value.
				requestAnimationFrame(() => {
					const node = textareaRef.current;
					if (node) {
						node.focus();
						node.setSelectionRange(next.caret, next.caret);
					}
				});
			}
			onAttach(candidateToAttachment(candidate));
			close();
		},
		[textareaRef, setValue, onAttach, close],
	);

	const commitById = useCallback(
		(id: string) => {
			const candidate = candidatesRef.current.find((c) => c.id === id);
			if (candidate) commitCandidate(candidate);
		},
		[commitCandidate],
	);

	const onKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
			// Never claim a key mid-IME-composition (keyCode 229 / isComposing): the
			// Enter that confirms a CJK candidate must reach the IME, not commit a
			// mention or send the message.
			if (e.nativeEvent.isComposing) return false;
			if (!isOpen) return false;
			const candidates = candidatesRef.current;
			switch (e.key) {
				case "ArrowDown": {
					e.preventDefault();
					if (candidates.length === 0) return true;
					activeIndexRef.current = (activeIndexRef.current + 1) % candidates.length;
					setTypeaheadActiveIndex(activeIndexRef.current);
					return true;
				}
				case "ArrowUp": {
					e.preventDefault();
					if (candidates.length === 0) return true;
					activeIndexRef.current = (activeIndexRef.current - 1 + candidates.length) % candidates.length;
					setTypeaheadActiveIndex(activeIndexRef.current);
					return true;
				}
				case "Enter":
				case "Tab": {
					const candidate = candidates[activeIndexRef.current];
					if (!candidate) {
						// Empty results — let the key through (Enter sends; Tab moves on).
						if (e.key === "Tab") return false;
						e.preventDefault();
						return true;
					}
					e.preventDefault();
					commitCandidate(candidate);
					return true;
				}
				case "Escape": {
					e.preventDefault();
					close();
					return true;
				}
				default:
					return false;
			}
		},
		[isOpen, commitCandidate, close],
	);

	const trigger = useCallback(() => {
		const el = textareaRef.current;
		if (!el) return;
		const caret = el.selectionStart ?? el.value.length;
		const needsSpace = caret > 0 && !/\s/.test(el.value[caret - 1] ?? " ");
		const insert = `${needsSpace ? " " : ""}@`;
		const next = el.value.slice(0, caret) + insert + el.value.slice(caret);
		setValue(next);
		const nextCaret = caret + insert.length;
		requestAnimationFrame(() => {
			const node = textareaRef.current;
			if (node) {
				node.focus();
				node.setSelectionRange(nextCaret, nextCaret);
				sync();
			}
		});
	}, [textareaRef, setValue, sync]);

	// Deferred close for the textarea's `onBlur`: a click on a typeahead row blurs
	// the textarea, so closing is deferred a tick to let the row's click commit
	// first. The timer is tracked + cleared by `close` (and the unmount effect) so
	// it never fires after the component is gone.
	const blur = useCallback(() => {
		if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
		blurTimerRef.current = setTimeout(() => {
			blurTimerRef.current = null;
			close();
		}, 200);
	}, [close]);

	// Tear down the menu (and any pending blur timer) if the consumer unmounts.
	useEffect(() => close, [close]);

	return { isOpen, sync, onKeyDown, trigger, close, blur };
}
