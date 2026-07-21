/**
 * LinkMarkupPlugin — Mod+K surface for wrapping a selection in a
 * `brainstorm://entity/<id>` LinkNode + click-through routing for those
 * links.
 *
 * Open path:
 *   1. `useShortcut(OpenLinkMarkup)` fires on Mod+K. When the editor
 *      selection is a non-collapsed `RangeSelection`, we snapshot the
 *      selection (anchor/focus keys + offsets) and the visual bounding
 *      rect of the native range; clone the selected text into a search
 *      query seed so the picker starts pre-filtered.
 *   2. The popover renders a tiny entity picker (search input + entity
 *      list) anchored to the captured rect. Typing filters via the
 *      shared `filterEntities` helper from `mention-ops.ts` (same
 *      three-tier ranking the `@`-typeahead uses).
 *   3. On accept we restore the captured Lexical selection inside an
 *      `editor.update()` block (the input's focus has erased the live
 *      DOM selection by this point), then call `$toggleLink` with the
 *      freshly-built entity URI. Direct `$toggleLink` (rather than the
 *      command dispatch) keeps the wrap path drivable from a headless
 *      editor without `LinkPlugin` registered.
 *
 * Click path:
 *   We attach a single capture-phase click listener to the editor's
 *   root element. It routes two shapes through the shared SDK
 *  `openEntity` primitive (per
 *   §The Link component — one navigation path, not a per-surface
 *   hand-roll):
 *     - an `<a>` whose href resolves to `brainstorm://entity/<id>`
 *       (Mod+K link markup) — id only, the shell resolver fills the type;
 *     - a `MentionNode` chip (`@`-mention) — carries both `data-entity-id`
 *       and `data-entity-type`, so the type-specific opener is reached
 *       without a resolver round-trip.
 *   Plain external `https://` links fall through to the default `<a>`
 *   behaviour — the browser handles them.
 *
 *   Modifier-held clicks (Cmd / Ctrl / Shift / Alt / middle-button) pass
 *   through too, so power users keep the default "open in new tab"
 *   semantics.
 */

import { getBlockAnchorsController, revealBlockByKey } from "@brainstorm-os/editor";
import { NavigationMode, navModeFromEvent } from "@brainstorm-os/sdk";
import type { VaultEntity } from "@brainstorm-os/sdk-types";
import {
	type SearchPickerItem,
	closeSearchPicker,
	openSearchPicker,
} from "@brainstorm-os/sdk/menus";
import { friendlyTypeName } from "@brainstorm-os/sdk/system-entities";
import { $toggleLink } from "@lexical/link";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createRangeSelection,
	$getNodeByKey,
	$getSelection,
	$isRangeSelection,
	$setSelection,
	type LexicalEditor,
} from "lexical";
import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n/t";
import { ActionId } from "../keyboard/action-ids";
import { useShortcut } from "../keyboard/use-shortcut";
import { getBrainstorm } from "../store/runtime";
import {
	LinkClickAction,
	buildEntityLinkUrl,
	findBinaryLinkFromEvent,
	findEntityLinkFromEvent,
	findMentionFromEvent,
	resolveLinkClick,
	triggerBinaryLinkDownload,
} from "./link-markup-ops";
import { entityDisplayName, filterEntities } from "./mention-ops";
import { dispatchOpenEntity } from "./open-entity-dispatch";

const NOTE_TYPE = "io.brainstorm.notes/Note/v1";
const EMPTY_ROW_ID = "__empty";

type AnchorRect = { top: number; left: number; bottom: number };

/** A zero-width caret-style `DOMRect` from the captured selection rect, so the
 *  picker drops from the live selection (which has no single anchor element). */
function rectFromAnchor(anchor: AnchorRect): DOMRect {
	const height = anchor.bottom - anchor.top;
	return {
		x: anchor.left,
		y: anchor.top,
		top: anchor.top,
		bottom: anchor.bottom,
		left: anchor.left,
		right: anchor.left,
		width: 0,
		height,
		toJSON: () => ({ x: anchor.left, y: anchor.top, width: 0, height }),
	};
}

type CapturedSelection = {
	anchorKey: string;
	anchorOffset: number;
	focusKey: string;
	focusOffset: number;
	anchorType: "text" | "element";
	focusType: "text" | "element";
};

type PickerState = {
	selection: CapturedSelection;
	anchor: AnchorRect;
	initialQuery: string;
};

export type LinkMarkupPluginProps = {
	/** The currently-open note's id, excluded from the picker so the user
	 *  can't link a selection back to itself. Optional — pass `null` for
	 *  the empty "no note open" state. */
	currentNoteId: string | null;
};

export function LinkMarkupPlugin({ currentNoteId }: LinkMarkupPluginProps) {
	const [editor] = useLexicalComposerContext();
	const [state, setState] = useState<PickerState | null>(null);

	const close = useCallback(() => setState(null), []);

	const openPicker = useCallback(() => {
		// Snapshot the current Lexical selection + visual rect before the
		// popover claims focus (which clears the DOM selection).
		const snapshot = readSelectionSnapshot(editor);
		if (!snapshot) return;
		setState(snapshot);
	}, [editor]);

	useShortcut(
		ActionId.OpenLinkMarkup,
		useCallback(
			(event) => {
				event.preventDefault();
				openPicker();
			},
			[openPicker],
		),
	);

	const commit = useCallback(
		(entity: VaultEntity) => {
			if (!state) return;
			applyLinkMarkup(editor, state.selection, buildEntityLinkUrl(entity.id));
		},
		[editor, state],
	);

	useLinkClickInterceptor(editor, currentNoteId);

	// Open the shared search picker over a title-filtered entity list while a
	// selection is captured. The runtime owns the input / keyboard / dismissal;
	// this owns the entity source, the `filterEntities` ranking (+ self-exclusion
	// + a type-tag caption), committing, and returning focus to the editor.
	useEffect(() => {
		if (!state) return;
		let cancelled = false;
		const excludeIds = currentNoteId ? new Set([currentNoteId]) : new Set<string>();
		const focusEditor = (): void => {
			editor.focus();
			const rootElement = editor.getRootElement();
			if (rootElement && document.activeElement !== rootElement) {
				rootElement.focus({ preventScroll: true });
			}
		};

		const open = (entities: readonly VaultEntity[]): void => {
			const toItems = (query: string): SearchPickerItem[] => {
				const results = filterEntities(entities, query, excludeIds);
				if (results.length === 0) {
					return [
						{
							id: EMPTY_ROW_ID,
							label:
								query.trim().length > 0
									? t("notes.linkMarkup.noResults", { query })
									: t("notes.linkMarkup.empty"),
							disabled: true,
						},
					];
				}
				return results.map((result) => ({
					id: result.entity.id,
					label: entityDisplayName(result.entity),
					caption:
						result.entity.type === NOTE_TYPE
							? t("notes.linkMarkup.entityType.note")
							: friendlyTypeName(result.entity.type),
				}));
			};
			openSearchPicker({
				placeholder: t("notes.linkMarkup.searchPlaceholder"),
				ariaLabel: t("notes.linkMarkup.region"),
				// The runtime's filter input opens empty; seed the initial *results*
				// with the selected text so the matching entity shows up-front.
				initialQuery: state.initialQuery,
				rect: rectFromAnchor(state.anchor),
				filter: toItems,
				onSelect: (id) => {
					const entity = entities.find((e) => e.id === id);
					if (entity) commit(entity);
				},
				onClose: () => {
					close();
					focusEditor();
				},
			});
		};

		const vaultEntities = getBrainstorm()?.services.vaultEntities;
		if (!vaultEntities) {
			open([]);
		} else {
			void vaultEntities
				.list()
				.then((snapshot) => {
					if (!cancelled) open(snapshot.entities);
				})
				.catch((error: unknown) => {
					console.warn("[notes/link-markup] vaultEntities.list failed:", error);
					if (!cancelled) open([]);
				});
		}

		return () => {
			cancelled = true;
			closeSearchPicker();
		};
	}, [state, editor, currentNoteId, commit, close]);

	// The picker is rendered by the menu runtime, not as a child here.
	return null;
}

/** Read the editor's live selection + the visual range rect, snapshot
 *  both so the popover can later restore them inside an `editor.update`
 *  callback. Returns `null` when:
 *    - the selection isn't a `RangeSelection`,
 *    - the selection is collapsed (nothing to wrap),
 *    - no native DOM range is available (chord fired from a non-editor
 *      context). */
function readSelectionSnapshot(editor: LexicalEditor): PickerState | null {
	let captured: CapturedSelection | null = null;
	let initialQuery = "";
	editor.getEditorState().read(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection) || selection.isCollapsed()) return;
		const text = selection.getTextContent();
		if (text.length === 0) return;
		captured = {
			anchorKey: selection.anchor.key,
			anchorOffset: selection.anchor.offset,
			anchorType: selection.anchor.type,
			focusKey: selection.focus.key,
			focusOffset: selection.focus.offset,
			focusType: selection.focus.type,
		};
		initialQuery = text.trim();
	});
	if (!captured) return null;
	const rect = readSelectionRect();
	if (!rect) return null;
	return { selection: captured, anchor: rect, initialQuery };
}

function readSelectionRect(): AnchorRect | null {
	if (typeof window === "undefined") return null;
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0).cloneRange();
	const rect = range.getBoundingClientRect();
	if (!rect || (rect.top === 0 && rect.left === 0 && rect.bottom === 0 && rect.width === 0)) {
		return null;
	}
	return { top: rect.top, left: rect.left, bottom: rect.bottom };
}

/** Wrap the captured selection in a LinkNode with the given URL. Restored
 *  inside `editor.update()` because the popover input had focus while
 *  picking — by the time we run, the DOM selection has been cleared.
 *
 *  Exported so a headless test can drive the wrap path without the
 *  popover surface. */
export function applyLinkMarkup(
	editor: LexicalEditor,
	captured: CapturedSelection,
	url: string,
): void {
	editor.update(
		() => {
			const anchorNode = $getNodeByKey(captured.anchorKey);
			const focusNode = $getNodeByKey(captured.focusKey);
			if (!anchorNode || !focusNode) return;
			const selection = $createRangeSelection();
			selection.anchor.set(captured.anchorKey, captured.anchorOffset, captured.anchorType);
			selection.focus.set(captured.focusKey, captured.focusOffset, captured.focusType);
			$setSelection(selection);
			// $toggleLink operates on the active selection inside this same
			// editor.update() — no command dispatch required, which keeps the
			// path testable in a headless editor without `LinkPlugin`.
			$toggleLink(url);
		},
		{ discrete: true },
	);
}

/** Attach a single capture-phase click listener to the editor's root
 *  element. For clicks landing on an `<a>` whose href resolves to a
 *  `brainstorm://entity/<id>` URI, preventDefault and route through the
 *  intents bus; a binary `brainstorm://asset/…` / `brainstorm://app-file/…`
 *  href triggers a download instead (will-navigate would drop it).
 *  External `https://` links fall through. */
function useLinkClickInterceptor(editor: LexicalEditor, currentNoteId: string | null): void {
	useEffect(() => {
		const root = editor.getRootElement();
		if (!root) return;
		function onClick(event: MouseEvent) {
			// Entity links + mention chips route through the shell with the click.s
			// navigation mode (plain = replace, Cmd/Ctrl = new tab, Shift = new window).
			// External links still pass through to the browser.
			if (!root) return;
			const link = findEntityLinkFromEvent(event.target, root);
			if (link) {
				const decision = resolveLinkClick({
					href: link.anchor.getAttribute("href"),
				});
				if (decision.action !== LinkClickAction.OpenEntity) return;
				event.preventDefault();
				event.stopPropagation();
				const mode = navModeFromEvent(event);
				// A same-document block anchor (B11.13) opened in place needs no
				// shell round-trip — resolve + scroll right here. New-tab / new-
				// window still dispatch so the shell places the new surface.
				if (
					decision.blockId &&
					decision.entityId === currentNoteId &&
					mode === NavigationMode.Replace &&
					revealAnchorInEditor(editor, decision.blockId)
				) {
					return;
				}
				dispatchOpenEntity({
					entityId: decision.entityId,
					...(link.entityType ? { entityType: link.entityType } : {}),
					mode,
					...(decision.blockId ? { blockId: decision.blockId } : {}),
				});
				return;
			}
			// An imported PDF / uploaded file link (`brainstorm://asset/…`,
			// `brainstorm://app-file/…`): plain navigation is dropped by the
			// app view's will-navigate guard, so save it via the same
			// `<a download>` path the FileBlockNode chip uses. The link text
			// carries the display filename for imported files.
			const binary = findBinaryLinkFromEvent(event.target, root);
			if (binary) {
				event.preventDefault();
				event.stopPropagation();
				triggerBinaryLinkDownload(binary.url, binary.anchor.textContent);
				return;
			}
			const mention = findMentionFromEvent(event.target, root);
			if (!mention) return;
			event.preventDefault();
			event.stopPropagation();
			dispatchOpenEntity({ ...mention, mode: navModeFromEvent(event) });
		}
		root.addEventListener("click", onClick, true);
		return () => {
			root.removeEventListener("click", onClick, true);
		};
	}, [editor, currentNoteId]);
}

/** Resolve a `#block-<id>` anchor inside the live editor and scroll +
 *  flash it. `false` (caller dispatches a plain open) when the anchors
 *  plugin isn't mounted or the block is gone. */
function revealAnchorInEditor(editor: LexicalEditor, anchorId: string): boolean {
	const controller = getBlockAnchorsController(editor);
	if (!controller) return false;
	const key = controller.resolveBlockKey(anchorId);
	if (!key) return false;
	return revealBlockByKey(editor, key);
}
