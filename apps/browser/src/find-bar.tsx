/**
 * Find-in-page bar — chrome-side UI over the host's `findInPage` /
 * `stopFind` (the page-side search runs in the engine; the chrome only
 * sends the query and paints the match count from `FindResult` metadata
 * events — coordinates and highlights never cross the boundary).
 *
 * Deliberately NOT the SDK `find-replace` `<FindBar>`: that contract is a
 * synchronous model-search provider (`search(query): Match[]` over the
 * editor model) with replace — the engine's find is async, count-only, and
 * read-only, so faking matches would lie to the shared controller. Same
 * keyboard model though: Enter / Shift+Enter cycle, Escape closes (bound by
 * the host app), all via the SDK shortcut binder, never raw `e.key`.
 */

import { Icon, IconName } from "@brainstorm/sdk/icon";
import { attachShortcut } from "@brainstorm/sdk/shortcut";
import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { t } from "./i18n";

export type FindMatchState = { matches: number; activeMatch: number };

export function FindBar({
	query,
	result,
	onQueryChange,
	onNext,
	onPrevious,
	onClose,
}: {
	query: string;
	result: FindMatchState | null;
	onQueryChange: (next: string) => void;
	onNext: () => void;
	onPrevious: () => void;
	onClose: () => void;
}): ReactElement {
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);

	// Enter / Shift+Enter cycle matches while typing in the field — single-key
	// chords need the explicit while-editable opt-in (the find bar owns the
	// input, so the gesture is unambiguous).
	useEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		const offNext = attachShortcut(el, "Enter", onNext, { allowWhileSuppressed: true });
		const offPrev = attachShortcut(el, "Shift+Enter", onPrevious, { allowWhileSuppressed: true });
		return () => {
			offNext();
			offPrev();
		};
	}, [onNext, onPrevious]);

	const hasQuery = query.length > 0;
	const counter = !hasQuery
		? ""
		: result === null || result.matches === 0
			? t("find.noMatches")
			: t("find.matches", { active: String(result.activeMatch), total: String(result.matches) });

	return (
		<div className="browser__findbar" role="search" aria-label={t("find.open")}>
			<input
				ref={inputRef}
				className="bs-input bs-input--sm browser__findbar-input"
				type="text"
				value={query}
				onChange={(e) => onQueryChange(e.target.value)}
				placeholder={t("find.placeholder")}
				aria-label={t("find.placeholder")}
				spellCheck={false}
			/>
			<span className="browser__findbar-count" role="status">
				{counter}
			</span>
			{/* The SDK glyph pack has no vertical carets; the chrome rotates the
			    horizontal ones (CSS, not new generated glyphs). */}
			<button
				type="button"
				className="browser__navbtn browser__navbtn--caret-up"
				aria-label={t("find.previous")}
				data-bs-tooltip={t("find.previous")}
				title={!hasQuery ? t("find.previous") : undefined}
				disabled={!hasQuery}
				onClick={onPrevious}
			>
				<Icon name={IconName.CaretLeft} size={14} />
			</button>
			<button
				type="button"
				className="browser__navbtn browser__navbtn--caret-down"
				aria-label={t("find.next")}
				data-bs-tooltip={t("find.next")}
				title={!hasQuery ? t("find.next") : undefined}
				disabled={!hasQuery}
				onClick={onNext}
			>
				<Icon name={IconName.CaretLeft} size={14} />
			</button>
			<button
				type="button"
				className="browser__navbtn"
				aria-label={t("find.close")}
				data-bs-tooltip={t("find.close")}
				onClick={onClose}
			>
				<Icon name={IconName.Close} size={14} />
			</button>
		</div>
	);
}
