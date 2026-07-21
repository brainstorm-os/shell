/**
 * BlockGutterPlugin — left-margin hover affordance for the editor:
 *   - A `+` button inserts an empty paragraph below the hovered row.
 *   - A grip handle:
 *       - On click → opens the block-action menu (TurnInto + Delete),
 *         scoped to the current block-selection if any (else the
 *         hovered row).
 *       - On drag → reorders the selected block(s). 4-pixel threshold
 *         distinguishes click vs. drag. A horizontal line indicator
 *         tracks the would-be drop position; release commits the move
 *         via `moveBlocksTo`.
 *
 * Implementation notes:
 *   - The plugin renders a single fixed-position gutter element that
 *     follows the hovered top-level block. Mousemove handlers, throttled
 *     to one rAF, pick the nearest row by Y-coord and look up its DOM
 *     rect via `editor.getElementByKey`.
 *   - The action menu reuses the slash-menu visual pattern.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createParagraphNode,
	$getNodeByKey,
	$getRoot,
	type LexicalEditor,
	type NodeKey,
} from "lexical";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BlockCommand } from "../block-command";
import { useEditorT } from "../i18n";
import { GripIcon, PlusIcon } from "../icons";
import { getAllBlocks } from "../top-level-block";
import { openBlockActionMenu } from "./block-action-menu";
import { gutterAnchor } from "./block-gutter-anchor";
import { moveBlocksTo } from "./block-ops";
import { useBlockSelectionStore } from "./block-selection-plugin";

/** Distance from the block's left edge to the gutter element's left
 *  edge. The gutter is two 22px buttons with a 2px gap (46px wide). At
 *  68px we land ~22px of breathing space between the grip and the block
 *  text — anything tighter and the controls visually touch the content. */
const GUTTER_OFFSET_LEFT = 68;
const DRAG_THRESHOLD_PX = 4;

type HoverState = { key: NodeKey; top: number; left: number };
type DragState = {
	keys: ReadonlySet<NodeKey>;
	dropTargetKey: NodeKey | null;
	indicatorTop: number;
	indicatorLeft: number;
	indicatorWidth: number;
};

export type BlockGutterPluginProps = {
	/** Ordered list of commands the action menu surfaces. The host app
	 *  assembles its own catalogue (`@brainstorm-os/editor`'s `BlockCommand`
	 *  type). When omitted, the action menu renders no command rows —
	 *  the gutter still works for `+` insert + drag-to-reorder. */
	commands?: readonly BlockCommand[];
	/** CSS selector for the scroll container that owns the document.
	 *  Defaults to walking the editor root's nearest scrollable ancestor.
	 *  Notes passes `.notes__main`, Journal passes its own scroll host. */
	scrollContainerSelector?: string;
	/** Id of the document being edited — forwarded into every command's
	 *  `CommandContext` so document-aware actions (e.g. "Copy link to block")
	 *  can reference the open entity. */
	documentId?: string;
};

export function BlockGutterPlugin({
	commands,
	scrollContainerSelector,
	documentId,
}: BlockGutterPluginProps = {}) {
	const [editor] = useLexicalComposerContext();
	const t = useEditorT();
	const selectionStore = useBlockSelectionStore();
	const [hover, setHover] = useState<HoverState | null>(null);
	const [drag, setDrag] = useState<DragState | null>(null);
	const frameRef = useRef<number | null>(null);
	const dragActiveRef = useRef(false);
	// Mirror of `hover` for listeners (scroll/resize) whose closure would
	// otherwise capture a stale value — they reposition the *currently*
	// hovered block, so they need its live key.
	const hoverRef = useRef<HoverState | null>(null);
	useEffect(() => {
		hoverRef.current = hover;
	}, [hover]);

	useEffect(() => {
		const root = editor.getRootElement();
		if (!root) return;
		// The gutter sits ~22px left of the block content, OUTSIDE the
		// contenteditable's box. Listening on the contenteditable means the
		// cursor "falls into the gap" between block and gutter and the hover
		// state drops. Bind to the document's scroll container (the host
		// app supplies a selector, e.g. Notes' `.notes__main` or Journal's
		// own scroll host); fall back to the editor root itself.
		const main =
			(scrollContainerSelector
				? (root.closest(scrollContainerSelector) as HTMLElement | null)
				: findScrollableAncestor(root)) ?? root;

		// Position for a known block key off its *current* viewport rect.
		// Shared by hover (mousemove) and the scroll/resize repositioners
		// so the two paths can never drift. `null` ⇒ the block is outside
		// the scroll container's visible band ⇒ hide the gutter (it must
		// not stay frozen at a stale Y — the "stuck while scrolling" bug).
		function positionFor(key: NodeKey): HoverState | null {
			const rect = editor.getElementByKey(key)?.getBoundingClientRect();
			if (!rect) return null;
			const anchor = gutterAnchor(rect, main.getBoundingClientRect(), GUTTER_OFFSET_LEFT);
			if (!anchor) return null;
			return { key, top: anchor.top, left: anchor.left };
		}

		function compute(event: MouseEvent): HoverState | null {
			const next = findHoveredBlock(editor, event.clientY);
			if (!next) return null;
			return positionFor(next);
		}

		function onMouseMove(event: MouseEvent) {
			if (dragActiveRef.current) return;
			if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
			frameRef.current = requestAnimationFrame(() => {
				setHover(compute(event));
			});
		}

		// Scrolling the doc (or resizing) moves blocks under a stationary
		// pointer; recompute the gutter from the still-hovered block's fresh
		// rect so it tracks the content instead of freezing. The action menu is
		// now a self-managing fancy-menu (dismisses on escape / outside-click /
		// select), so the gutter no longer force-closes it — and must not:
		// opening the menu locks body scroll, which fires a spurious `scroll`
		// here and would otherwise close the menu the instant it appeared.
		function onScrollOrResize() {
			if (dragActiveRef.current) return;
			if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
			frameRef.current = requestAnimationFrame(() => {
				const cur = hoverRef.current;
				if (cur) setHover(positionFor(cur.key));
			});
		}

		function onMouseLeave(event: MouseEvent) {
			if (dragActiveRef.current) return;
			// The gutter is portaled to <body> (fixed overlay), so it is NOT a
			// DOM descendant of `.notes__main`. Moving the pointer from a block
			// onto the gutter button therefore fires `mouseleave` on main —
			// clearing hover would unmount the gutter the instant the cursor
			// reaches it (the "blink / can't click the +/grip" bug). Keep it
			// mounted when the pointer is heading into the gutter chrome itself.
			const to = event.relatedTarget;
			if (
				to instanceof Element &&
				to.closest(".bs-editor__block-gutter, .fm-menu, .bs-editor__drop-indicator")
			) {
				return;
			}
			if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
			setHover(null);
		}

		main.addEventListener("mousemove", onMouseMove);
		main.addEventListener("mouseleave", onMouseLeave);
		// `scroll` does not bubble — bind on the actual scroll container
		// (`.notes__main`, `overflow-y:auto`). Resize can move blocks too.
		main.addEventListener("scroll", onScrollOrResize, { passive: true });
		window.addEventListener("resize", onScrollOrResize);
		return () => {
			main.removeEventListener("mousemove", onMouseMove);
			main.removeEventListener("mouseleave", onMouseLeave);
			main.removeEventListener("scroll", onScrollOrResize);
			window.removeEventListener("resize", onScrollOrResize);
			if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
		};
	}, [editor, scrollContainerSelector]);

	const addBelow = useCallback(() => {
		if (!hover) return;
		editor.update(() => {
			const node = $getNodeByKey(hover.key);
			if (!node) return;
			const paragraph = $createParagraphNode();
			node.insertAfter(paragraph);
			paragraph.selectStart();
		});
	}, [editor, hover]);

	const openMenu = useCallback(
		(event: React.MouseEvent<HTMLButtonElement>) => {
			if (!hover) return;
			const rect = event.currentTarget.getBoundingClientRect();
			const snap = selectionStore.getSnapshot();
			if (snap.selectedKeys.size === 0) {
				selectionStore.setOnly(hover.key);
			}
			const blockKey = hover.key;
			openBlockActionMenu({
				anchor: rect,
				commands: commands ?? [],
				t,
				onActivate: (command) => {
					const s = selectionStore.getSnapshot();
					const blockKeys = s.selectedKeys.size > 0 ? s.selectedKeys : new Set<NodeKey>([blockKey]);
					command.run({ editor, blockKeys, ...(documentId ? { documentId } : {}) });
				},
			});
		},
		[hover, selectionStore, commands, t, editor, documentId],
	);

	const onGripPointerDown = useCallback(
		(event: React.PointerEvent<HTMLButtonElement>) => {
			if (event.button !== 0) return;
			if (!hover) return;
			// Stop the document-level marquee/selection capture handlers from
			// also reacting to this gesture.
			event.preventDefault();
			event.stopPropagation();

			const hoverKey = hover.key;
			const startX = event.clientX;
			const startY = event.clientY;
			let started = false;
			let lastTarget: NodeKey | null = null;

			// If hover isn't in the current selection, the drag carries only
			// the hovered block. Otherwise the whole selection moves.
			const snap = selectionStore.getSnapshot();
			const dragKeys: ReadonlySet<NodeKey> = snap.selectedKeys.has(hoverKey)
				? new Set(snap.selectedKeys)
				: new Set([hoverKey]);

			function refreshIndicator(clientY: number): void {
				const target = pickDropTarget(editor, clientY, dragKeys);
				lastTarget = target;
				setDrag(buildDragState(editor, dragKeys, target));
			}

			function detach(): void {
				document.removeEventListener("pointermove", onMove, true);
				document.removeEventListener("pointerup", onUp, true);
				document.removeEventListener("pointercancel", onCancel, true);
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
				dragActiveRef.current = false;
			}

			function onMove(e: PointerEvent): void {
				if (!started) {
					if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) return;
					started = true;
					dragActiveRef.current = true;
					document.body.style.cursor = "grabbing";
					document.body.style.userSelect = "none";
				}
				e.preventDefault();
				refreshIndicator(e.clientY);
			}

			function finish(commit: boolean): void {
				detach();
				if (started && commit) moveBlocksTo(editor, dragKeys, lastTarget);
				setDrag(null);
			}

			function onUp(_e: PointerEvent): void {
				finish(true);
			}

			function onCancel(_e: PointerEvent): void {
				finish(false);
			}

			document.addEventListener("pointermove", onMove, true);
			document.addEventListener("pointerup", onUp, true);
			document.addEventListener("pointercancel", onCancel, true);
		},
		[editor, hover, selectionStore],
	);

	// Portaled to <body>: the gutter, drop indicator and action menu are
	// `position: fixed` and positioned from viewport-coordinate rects. When
	// the notes sidebar is open `.notes__doc` carries a `transform`, which
	// makes it the containing block for fixed descendants and would resolve
	// these coordinates against the doc's offset box instead of the viewport.
	return createPortal(
		<>
			{hover && (
				<div
					className={
						drag ? "bs-editor__block-gutter bs-editor__block-gutter--dragging" : "bs-editor__block-gutter"
					}
					style={{ top: `${hover.top}px`, left: `${hover.left}px` }}
				>
					<button
						type="button"
						className="bs-editor__block-gutter-btn bs-editor__block-gutter-btn--add"
						onClick={addBelow}
						aria-label={t("editor.gutter.addBelow")}
						title={t("editor.gutter.addBelow")}
					>
						<PlusIcon />
					</button>
					<button
						type="button"
						className="bs-editor__block-gutter-btn bs-editor__block-gutter-btn--grip"
						onClick={openMenu}
						onPointerDown={onGripPointerDown}
						aria-label={t("editor.gutter.openMenu")}
						title={t("editor.gutter.openMenu")}
					>
						<GripIcon />
					</button>
				</div>
			)}
			{drag && (
				<div
					className="bs-editor__drop-indicator"
					style={{
						top: `${drag.indicatorTop}px`,
						left: `${drag.indicatorLeft}px`,
						width: `${drag.indicatorWidth}px`,
					}}
					aria-hidden="true"
				/>
			)}
		</>,
		document.body,
	);
}

function findScrollableAncestor(el: HTMLElement): HTMLElement | null {
	let cur: HTMLElement | null = el.parentElement;
	while (cur) {
		const style = window.getComputedStyle(cur);
		if (/(auto|scroll)/.test(style.overflowY)) return cur;
		cur = cur.parentElement;
	}
	return null;
}

/** Pick the block the drop indicator should land before. Returns the
 *  key of the block whose top edge the pointer Y is closest to; or
 *  `null` to append at the end. Skips blocks that are part of the drag
 *  set itself (you can't drop a block before itself). */
function pickDropTarget(
	editor: LexicalEditor,
	clientY: number,
	dragKeys: ReadonlySet<NodeKey>,
): NodeKey | null {
	let target: NodeKey | null = null;
	editor.getEditorState().read(() => {
		for (const child of getAllBlocks($getRoot())) {
			const key = child.getKey();
			if (dragKeys.has(key)) continue;
			const el = editor.getElementByKey(key);
			if (!el) continue;
			const rect = el.getBoundingClientRect();
			const midpoint = rect.top + rect.height / 2;
			if (clientY < midpoint) {
				target = key;
				return;
			}
		}
		// Fell past every block — append.
		target = null;
	});
	return target;
}

function buildDragState(
	editor: LexicalEditor,
	keys: ReadonlySet<NodeKey>,
	targetKey: NodeKey | null,
): DragState | null {
	let result: DragState | null = null;
	editor.getEditorState().read(() => {
		const editable = editor.getRootElement();
		if (!editable) return;
		const editableRect = editable.getBoundingClientRect();
		// Indicator above the target if there's one, else below the last
		// non-dragged block.
		if (targetKey !== null) {
			const el = editor.getElementByKey(targetKey);
			if (!el) return;
			const rect = el.getBoundingClientRect();
			result = {
				keys,
				dropTargetKey: targetKey,
				indicatorTop: rect.top,
				indicatorLeft: editableRect.left,
				indicatorWidth: editableRect.width,
			};
			return;
		}
		// Append: indicator below the last non-dragged block.
		let lastNonDragged: NodeKey | null = null;
		for (const block of getAllBlocks($getRoot())) {
			if (keys.has(block.getKey())) continue;
			lastNonDragged = block.getKey();
		}
		const tail = lastNonDragged ? editor.getElementByKey(lastNonDragged) : null;
		const rect = tail ? tail.getBoundingClientRect() : editableRect;
		result = {
			keys,
			dropTargetKey: null,
			indicatorTop: rect.bottom,
			indicatorLeft: editableRect.left,
			indicatorWidth: editableRect.width,
		};
	});
	return result;
}

function findHoveredBlock(editor: LexicalEditor, clientY: number): NodeKey | null {
	const root = editor.getRootElement();
	if (!root) return null;
	let bestKey: NodeKey | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	editor.getEditorState().read(() => {
		for (const block of getAllBlocks($getRoot())) {
			const el = editor.getElementByKey(block.getKey());
			if (!el) continue;
			const rect = el.getBoundingClientRect();
			const within = clientY >= rect.top && clientY <= rect.bottom;
			if (within) {
				bestKey = block.getKey();
				bestDistance = 0;
				return;
			}
			const distance = Math.min(Math.abs(clientY - rect.top), Math.abs(clientY - rect.bottom));
			if (distance < bestDistance) {
				bestDistance = distance;
				bestKey = block.getKey();
			}
		}
	});
	return bestKey;
}
