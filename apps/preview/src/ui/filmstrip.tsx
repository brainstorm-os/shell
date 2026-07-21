/**
 * `<Filmstrip>` — the thumbnail strip below the stage. Each thumb is an
 * option in a horizontal listbox; click or keyboard-activate navigates to
 * that file.
 *
 * KBN-A-preview (filmstrip): the strip is a horizontal listbox via the
 * shared DOM composite-keyboard binding (`attachCompositeKeyboard` from
 * `@brainstorm-os/sdk/a11y`) — ArrowLeft/Right rove between thumbs, Enter/Space
 * activates. React renders the thumbs; the binding stamps roles + roving
 * tabindex and is re-applied (`refresh()`) after each render so the cursor
 * mirrors the current file index.
 */

import { Orientation, attachCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import { type ReactElement, useEffect, useRef } from "react";
import type { PreviewFile } from "../demo/dataset";
import { ThumbUrlCache, kindClassFor, kindGlyphFor } from "./filmstrip-thumb";

export function Filmstrip({
	siblings,
	cursor,
	onNavigate,
}: {
	siblings: ReadonlyArray<PreviewFile>;
	cursor: number;
	onNavigate: (index: number) => void;
}): ReactElement {
	const stripRef = useRef<HTMLDivElement>(null);
	const cacheRef = useRef<ThumbUrlCache>(new ThumbUrlCache());
	// Read live in the binding callbacks so they never close over stale props.
	const siblingsRef = useRef(siblings);
	siblingsRef.current = siblings;
	const cursorRef = useRef(cursor);
	cursorRef.current = cursor;
	const onNavigateRef = useRef(onNavigate);
	onNavigateRef.current = onNavigate;

	// Release the blob: URLs minted for the previous sibling list, then the
	// final batch on unmount.
	useEffect(() => {
		const cache = cacheRef.current;
		return () => cache.releaseAll();
	}, []);
	const prevSiblingsRef = useRef(siblings);
	if (prevSiblingsRef.current !== siblings) {
		cacheRef.current.releaseAll();
		prevSiblingsRef.current = siblings;
	}

	const multi = siblings.length > 1;
	const handleRef = useRef<ReturnType<typeof attachCompositeKeyboard> | null>(null);

	useEffect(() => {
		const strip = stripRef.current;
		if (!strip || !multi) return;
		const handle = attachCompositeKeyboard(strip, {
			orientation: Orientation.Horizontal,
			count: () => siblingsRef.current.length,
			activeIndex: () => cursorRef.current,
			onActiveIndexChange: (i) => onNavigateRef.current(i),
			onActivate: (i) => onNavigateRef.current(i),
		});
		handleRef.current = handle;
		return () => {
			handle.destroy();
			handleRef.current = null;
		};
	}, [multi]);

	// Re-stamp roving tabindex / aria-selected after each render so the strip
	// reflects the live cursor (the binding owns the ARIA, React owns the DOM).
	useEffect(() => {
		handleRef.current?.refresh();
	});

	if (!multi) {
		return <div ref={stripRef} className="preview__filmstrip preview__filmstrip--empty" />;
	}

	const cache = cacheRef.current;

	return (
		<div ref={stripRef} className="preview__filmstrip">
			{siblings.map((file, i) => {
				const thumbUrl = cache.urlFor(file);
				return (
					<button
						key={file.id}
						type="button"
						className={`preview__filmstrip-item${i === cursor ? " preview__filmstrip-item--active" : ""}`}
						data-composite-index={i}
						aria-label={file.info.name}
						title={file.info.name}
						onClick={() => onNavigate(i)}
					>
						<span
							className={`preview__filmstrip-thumb preview__filmstrip-thumb--${kindClassFor(
								file.info.mime,
							)}`}
						>
							{thumbUrl ? (
								<img
									className="preview__filmstrip-image"
									alt=""
									loading="lazy"
									decoding="async"
									src={thumbUrl}
								/>
							) : (
								<span className="preview__filmstrip-glyph">{kindGlyphFor(file.info.mime)}</span>
							)}
						</span>
						<span className="preview__filmstrip-name">{file.info.name}</span>
					</button>
				);
			})}
		</div>
	);
}
