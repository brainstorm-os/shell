/**
 * Side Outline panel (B11.26) — the open note's headings as a navigable
 * list. Click / Enter scrolls the heading into view; the heading the reader
 * is currently in is tracked off the document scroller and marked
 * `aria-current`. Always live: with no note, or a note without headings, it
 * renders its own empty state rather than the toggle going dead.
 */

import { Orientation, useCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import { EmptyState, EmptyStateTone } from "@brainstorm-os/sdk/empty-state";
import { IconName } from "@brainstorm-os/sdk/icon";
import type { LexicalEditor } from "lexical";
import { type MutableRefObject, type ReactNode, useCallback, useEffect, useState } from "react";
import { type OutlineEntry, activeOutlineIndex, outlineBaseLevel } from "../editor/outline";
import { t } from "../i18n/t";

/** How far below the scroller's top edge a heading counts as "reached" —
 *  roughly one line, so the active row flips as the heading passes under
 *  the header rather than only once it has scrolled fully out of view. */
const ACTIVE_THRESHOLD_PX = 48;

export function OutlinePanel({
	hasNote,
	entries,
	editorRef,
	scrollContainer,
}: {
	hasNote: boolean;
	entries: readonly OutlineEntry[];
	editorRef: MutableRefObject<LexicalEditor | null>;
	/** The element the document scrolls inside (`.notes__main`). */
	scrollContainer: () => HTMLElement | null;
}): ReactNode {
	const [cursor, setCursor] = useState(0);
	const [current, setCurrent] = useState(-1);

	useEffect(() => {
		const scroller = scrollContainer();
		if (!scroller || entries.length === 0) {
			setCurrent(-1);
			return;
		}
		let frame = 0;
		const measure = (): void => {
			frame = 0;
			const editor = editorRef.current;
			const top = scroller.getBoundingClientRect().top + ACTIVE_THRESHOLD_PX;
			const tops = entries.map((e) => {
				const el = editor?.getElementByKey(e.key);
				return el ? el.getBoundingClientRect().top : null;
			});
			setCurrent(activeOutlineIndex(tops, top));
		};
		const onScroll = (): void => {
			if (frame === 0) frame = requestAnimationFrame(measure);
		};
		measure();
		scroller.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			scroller.removeEventListener("scroll", onScroll);
			if (frame !== 0) cancelAnimationFrame(frame);
		};
	}, [entries, editorRef, scrollContainer]);

	useEffect(() => {
		setCursor((c) => Math.min(c, Math.max(0, entries.length - 1)));
	}, [entries.length]);

	const reveal = useCallback(
		(index: number) => {
			const entry = entries[index];
			const editor = editorRef.current;
			if (!entry || !editor) return;
			setCursor(index);
			editor.getElementByKey(entry.key)?.scrollIntoView({ behavior: "smooth", block: "start" });
		},
		[entries, editorRef],
	);

	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Vertical,
		count: entries.length,
		activeIndex: cursor,
		onActiveIndexChange: setCursor,
		onActivate: reveal,
		wrap: false,
		typeahead: (i) => entries[i]?.text ?? "",
	});

	if (!hasNote || entries.length === 0) {
		return (
			<EmptyState
				icon={IconName.View}
				tone={EmptyStateTone.Compact}
				title={hasNote ? t("notes.outline.emptyTitle") : t("notes.outline.noNoteTitle")}
				hint={hasNote ? t("notes.outline.emptyHint") : t("notes.outline.noNoteHint")}
				className="notes__outline-empty"
			/>
		);
	}

	const base = outlineBaseLevel(entries);
	return (
		<ul {...containerProps} className="notes__outline-list" aria-label={t("notes.outline.list")}>
			{entries.map((entry, index) => (
				<li
					key={entry.key}
					{...getItemProps(index)}
					className="notes__outline-item"
					data-depth={Math.min(entry.level - base, 5)}
					aria-current={index === current ? "location" : undefined}
				>
					<button
						type="button"
						className="notes__outline-link"
						tabIndex={-1}
						onClick={() => reveal(index)}
					>
						{entry.text || t("notes.toc.untitled")}
					</button>
				</li>
			))}
		</ul>
	);
}
