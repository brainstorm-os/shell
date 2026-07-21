/**
 * NotesList — right-sidebar list of notes, sorted by `updatedAt`
 * (most-recently edited first). Editing the body, renaming the title, or
 * picking an icon bumps `updatedAt` via `useNotes.update`, so the order
 * tracks user activity without a separate "last opened" channel. Merely
 * opening a note does not bump `updatedAt`, so it doesn't reorder; the
 * note floats to the top only once it's actually edited.
 *
 * In the default (recency) view, rows are grouped under date-section
 * headers — Today / Yesterday / Previous 7 days / Previous 30 days /
 * by-month — via the shared `@brainstorm-os/sdk/date-buckets` bucketer
 * (identical sections in every such list), so a row no longer carries a
 * per-row "edited 4m ago" caption. The inline-search view stays flat in
 * relevance order (date sections would fight the ranking).
 *
 * Rows + headers are windowed with @tanstack/react-virtual: only the
 * visible slice (plus a small overscan) is in the DOM, so a vault with
 * thousands of notes scrolls as cheaply as one with ten. `getItemKey`
 * keys rows by note id (headers by bucket key) so a reorder shifts
 * existing DOM rather than remounting it.
 *
 * Every row carries the shared cross-app object menu (right-click +
 * the ⋯ overflow): Open / Pin·Unpin / Delete, identical to the menu on
 * the open note's title and to every other app — built once in
 * `noteObjectMenuContext`, rendered by the SDK chrome.
 */

import { clipPlainText, extractPlainText } from "@brainstorm-os/editor";
import { type NavigationMode, navModeFromEvent } from "@brainstorm-os/sdk";
import { Orientation, useCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import { groupByDateBucket } from "@brainstorm-os/sdk/date-buckets";
import { setEntityDragData } from "@brainstorm-os/sdk/entity-drag";
import { IconName } from "@brainstorm-os/sdk/icon";
import { ObjectMenuTrigger } from "@brainstorm-os/sdk/object-menu";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useMemo, useRef } from "react";
import { t } from "../i18n/t";
import { NOTE_TYPE } from "../store/entities-repository";
import type { StoredNote } from "../store/note";
import type { NotesBrainstorm } from "../store/runtime";
import { EntityIcon } from "./entity-icon";
import { noteObjectMenuContext } from "./object-menu-context";
/** Fixed row pitch. Titles are single-line (nowrap + ellipsis) so every
 *  note row is the same height; date-section headers use a shorter fixed
 *  pitch. Two constant pitches keep scrolling jank-free with no per-row
 *  measurement. */
const ROW_HEIGHT = 36;
const SECTION_HEIGHT = 30;

/** The flat virtualised sequence: section headers interleaved with note
 *  rows. A `kind` is a discriminator drawn from a fixed set → enum per
 *  code conventions. */
enum RowKind {
	Header = "header",
	Note = "note",
}

type FlatRow =
	| { kind: RowKind.Header; key: string; label: string }
	| { kind: RowKind.Note; note: StoredNote };

export type NotesListProps = {
	notes: Map<string, StoredNote>;
	selectedId: string | null;
	/** Open a note. `mode` carries the click modifier (Cmd/Ctrl → new tab,
	 *  Shift → new window); a plain click / keyboard activation omits it and
	 *  the host selects in place. */
	onSelect: (id: string, mode?: NavigationMode) => void;
	/** When set (inline search active), render exactly these note ids in
	 *  this order (the search index's relevance rank) instead of the
	 *  default most-recently-edited sort. Ids with no matching note are
	 *  skipped. */
	order?: readonly string[] | undefined;
	/** Empty-state copy. Defaults to the "no notes yet" message; the
	 *  search caller passes a "no matches" string. */
	emptyLabel?: string | undefined;
	/** Runtime for the shared object menu (Open / Pin·Unpin). `null`
	 *  before ready → the trigger is inert (right-click is a no-op). */
	runtime: NotesBrainstorm | null;
	/** Delete the note — wired as the menu's app-owned destructive
	 *  action. The app owns the actual removal + any confirm. */
	onRemoveNote: (id: string) => void | Promise<void>;
	/** DND-6 — "Link to note…" keyboard twin of dragging this row into an
	 *  editor: opens the target-note picker anchored to `anchor`. Omitted →
	 *  no menu item (e.g. a host without the twin flow). */
	onLinkInto?: (source: { id: string; title: string }, anchor: Element | null) => void;
};

export function NotesList({
	notes,
	selectedId,
	onSelect,
	order,
	emptyLabel,
	runtime,
	onRemoveNote,
	onLinkInto,
}: NotesListProps) {
	const flatRows = useMemo<FlatRow[]>(() => {
		if (order) {
			// Inline-search: flat relevance order, no date sections.
			return order
				.map((id) => notes.get(id))
				.filter((n): n is StoredNote => n !== undefined)
				.map((note) => ({ kind: RowKind.Note, note }));
		}
		// Sort by live `updatedAt`: editing the open note bumps it on each
		// autosave, so it floats to the top / into Today and — being the most
		// recent — stays pinned there while editing (it only moves once, no
		// repeated yanking). Merely opening a note doesn't bump `updatedAt`, so
		// an un-edited open note keeps its place.
		const sorted = [...notes.values()].sort((a, b) => b.updatedAt - a.updatedAt);
		const groups = groupByDateBucket(sorted, (n) => n.updatedAt, {
			labels: {
				today: t("notes.list.section.today"),
				yesterday: t("notes.list.section.yesterday"),
				last7: t("notes.list.section.last7"),
				last30: t("notes.list.section.last30"),
			},
		});
		const rows: FlatRow[] = [];
		for (const group of groups) {
			rows.push({ kind: RowKind.Header, key: group.bucket.key, label: group.bucket.label });
			for (const note of group.items) rows.push({ kind: RowKind.Note, note });
		}
		return rows;
	}, [notes, order]);

	// Disambiguate identical row labels — chiefly blank "Untitled" notes that
	// share a minute and so collide on the time suffix (F-039): the 2nd, 3rd, …
	// in display order get an "(n)" so a column of blanks is never ambiguous.
	// Computed over the full ordered set (NOT per virtual row, which renders out
	// of order). Only the untitled fallback is numbered — two notes a user named
	// the same are left alone.
	const labelById = useMemo(() => {
		const ordered: StoredNote[] = [];
		for (const r of flatRows) if (r.kind === RowKind.Note) ordered.push(r.note);
		return disambiguateLabels(ordered);
	}, [flatRows]);

	const scrollRef = useRef<HTMLDivElement | null>(null);

	const virtualizer = useVirtualizer({
		count: flatRows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: (index) => (flatRows[index]?.kind === RowKind.Header ? SECTION_HEIGHT : ROW_HEIGHT),
		getItemKey: (index) => {
			const r = flatRows[index];
			if (!r) return index;
			return r.kind === RowKind.Header ? `§${r.key}` : r.note.id;
		},
		overscan: 8,
	});

	// KBN-A-notes (sidebar list): the note list adopts the SDK composite-keyboard
	// reducer as a vertical listbox. Date-section headers are interleaved in the
	// flat sequence, so their indices go in `disabled` — arrows skip straight from
	// note to note. The list is virtualized (rows scroll in/out of the DOM), so it
	// keeps focus on the container and tracks the active row via
	// `aria-activedescendant` + `scrollToIndex` (the Bin precedent). Selecting a
	// note opens it (the app's single select-and-open action), so arrow-move ===
	// select; Enter is the same. Editor-side Lexical keyboard + block-selection
	// `app/escape` stay with the B11.x editor-parity ladder.
	const headerIndices = useMemo(() => {
		const set = new Set<number>();
		flatRows.forEach((r, i) => {
			if (r.kind === RowKind.Header) set.add(i);
		});
		return set;
	}, [flatRows]);
	const activeIndex = useMemo(
		() => flatRows.findIndex((r) => r.kind === RowKind.Note && r.note.id === selectedId),
		[flatRows, selectedId],
	);
	const selectRowAt = useCallback(
		(index: number) => {
			const r = flatRows[index];
			if (r && r.kind === RowKind.Note) onSelect(r.note.id);
			virtualizer.scrollToIndex(index);
		},
		[flatRows, onSelect, virtualizer],
	);
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Vertical,
		count: flatRows.length,
		activeIndex,
		onActiveIndexChange: selectRowAt,
		onActivate: selectRowAt,
		disabled: headerIndices,
		useAriaActiveDescendant: true,
	});

	if (flatRows.length === 0) {
		return (
			<div className="notes__sidebar-empty">
				<p>{emptyLabel ?? t("notes.empty.title")}</p>
			</div>
		);
	}

	return (
		<div className="notes__sidebar-scroll" ref={scrollRef}>
			<ul
				{...containerProps}
				className="notes__sidebar-list"
				aria-label={t("notes.list.region")}
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map((row) => {
					const item = flatRows[row.index];
					if (!item) return null;
					const place = {
						height: row.size,
						transform: `translateY(${row.start}px)`,
					} as const;
					if (item.kind === RowKind.Header) {
						return (
							<li
								key={row.key}
								className="notes__sidebar-row notes__sidebar-section"
								style={place}
								role="presentation"
							>
								<span role="heading" aria-level={3}>
									{item.label}
								</span>
							</li>
						);
					}
					const note = item.note;
					const isActive = note.id === selectedId;
					const title = displayTitle(note);
					const rowLabel = labelById.get(note.id) ?? listLabel(note);
					// The note's OWN icon only — an unset icon reads as an
					// empty (fixed-width) slot, never a synthesized default,
					// so the list matches the open doc + header. The slot
					// keeps its 18px box so titles stay aligned.
					const icon = note.icon ?? null;
					return (
						<li key={row.key} {...getItemProps(row.index)} className="notes__sidebar-row" style={place}>
							<ObjectMenuTrigger
								className="notes__sidebar-menu"
								variant="row"
								moreActionsLabel={t("notes.objectMenu.more")}
								context={() =>
									noteObjectMenuContext({
										noteId: note.id,
										noteTitle: title,
										runtime,
										onRemove: () => onRemoveNote(note.id),
										// DND-6 — the keyboard/menu twin of dragging this row
										// into an editor (reference semantic, target picked).
										...(onLinkInto
											? {
													extraItems: [
														{
															id: "link-to-note",
															label: t("notes.objectMenu.linkToNote"),
															icon: IconName.KindLink,
															run: () => onLinkInto({ id: note.id, title }, scrollRef.current),
														},
													],
												}
											: {}),
									})
								}
							>
								<button
									type="button"
									className={
										isActive ? "notes__sidebar-item notes__sidebar-item--active" : "notes__sidebar-item"
									}
									// Keyboard nav is the listbox container's job (roving via
									// `aria-activedescendant`); the row button stays mouse-only so it
									// isn't a second tab stop. `aria-selected` on the <li> conveys
									// the active row to AT.
									tabIndex={-1}
									onClick={(event) => onSelect(note.id, navModeFromEvent(event))}
									draggable
									onDragStart={(event) => {
										if (event.dataTransfer) {
											setEntityDragData(event.dataTransfer, {
												entityId: note.id,
												entityType: NOTE_TYPE,
												label: title,
											});
											event.dataTransfer.effectAllowed = "copyLink";
										}
									}}
								>
									<span className="notes__sidebar-icon" aria-hidden="true">
										<EntityIcon icon={icon} size={16} />
									</span>
									<span className="notes__sidebar-title">{rowLabel}</span>
								</button>
							</ObjectMenuTrigger>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

function displayTitle(note: StoredNote): string {
	const explicit = note.title.trim();
	if (explicit) return explicit;
	const body = extractPlainText(note.body);
	if (!body) return t("notes.list.untitled");
	return clipPlainText(body);
}

/**
 * The visible label for a list row. Same as {@link displayTitle}, except a
 * note with neither a title nor body text — which would otherwise be a bare
 * "Untitled" indistinguishable from every other blank note (F-039) — is
 * suffixed with its last-edited clock time so two blank notes are tellable
 * apart. The clean `displayTitle` is still used for the drag + object-menu
 * labels, where a single note's identity isn't ambiguous.
 */
export function listLabel(note: StoredNote): string {
	const base = displayTitle(note);
	if (base !== t("notes.list.untitled")) return base;
	const time = new Date(note.updatedAt).toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
	return `${base} · ${time}`;
}

/**
 * Final display labels for a list of notes in display order, keyed by id.
 * Identical *untitled* labels — blank notes that share a minute, so collide on
 * the time suffix — get an "(n)" on the 2nd, 3rd, … occurrence so a column of
 * blanks is never ambiguous (F-039). Notes a user deliberately named the same
 * are left as-is.
 */
export function disambiguateLabels(notesInOrder: ReadonlyArray<StoredNote>): Map<string, string> {
	const untitled = t("notes.list.untitled");
	const counts = new Map<string, number>();
	const out = new Map<string, string>();
	for (const note of notesInOrder) {
		const base = listLabel(note);
		if (base.startsWith(untitled)) {
			const n = (counts.get(base) ?? 0) + 1;
			counts.set(base, n);
			out.set(note.id, n > 1 ? `${base} (${n})` : base);
		} else {
			out.set(note.id, base);
		}
	}
	return out;
}
