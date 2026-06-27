/**
 * NotesApp — top-level component. 3-row grid (header / editor / footer)
 * mirroring the dashboard's chrome rhythm. Single-document UX: the editor
 * always shows one note; "New note" creates + selects a fresh document.
 *
 * The shell handles multi-doc routing via the dashboard launcher, not from
 * inside this app — see.
 */

import {
	type CommentsFocusRequest,
	CommentsProvider,
	PlusIcon,
	type SelectionCommentAnchor,
	applySuggestionInEditor,
	denormalizeBody,
	useCommentMentionHost,
} from "@brainstorm/editor";
import { useBlankRecoveryGap } from "@brainstorm/react-yjs";
import { NavigationMode } from "@brainstorm/sdk";
import type {
	CommentAnchor,
	CommentDef,
	Cover,
	Icon,
	PropertyDef,
	PropertyValueByValueType,
	ValueType,
} from "@brainstorm/sdk-types";
import { CoverPicker, type CoverPickerService } from "@brainstorm/sdk/cover-picker";
import { EmptyState } from "@brainstorm/sdk/empty-state";
import { Icon as IconGlyph, IconName } from "@brainstorm/sdk/icon";
import { recallLastViewed, rememberLastViewed } from "@brainstorm/sdk/last-viewed";
import { LockButton } from "@brainstorm/sdk/lock-button";
import { NavButtons, type NavHistory, createNavHistory } from "@brainstorm/sdk/nav-history";
import { type NoteReference, extractNoteReferences } from "@brainstorm/sdk/note-references";
import {
	type ObjectMenuExtraItem,
	ObjectMenuMoreButton,
	ObjectMenuTrigger,
} from "@brainstorm/sdk/object-menu";
import { PanelSide, PanelToggleButton } from "@brainstorm/sdk/panel-toggle";
import { AddIconGlyph } from "@brainstorm/sdk/picker-host";
import { PropertiesProvider } from "@brainstorm/sdk/property-ui";
import { bindValue, clearValue } from "@brainstorm/sdk/property-ui/pure";
import { attachResizable } from "@brainstorm/sdk/resizable";
import { Searchbar } from "@brainstorm/sdk/searchbar";
import { ShareDialog, type ShareDialogLabels } from "@brainstorm/sdk/share-dialog";
import { publishTabIdentity } from "@brainstorm/sdk/tab-identity";
import type { LexicalEditor, SerializedEditorState } from "lexical";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editor } from "./editor/editor";
import { localPresenceName } from "./editor/presence";
import { t } from "./i18n/t";
import { ActionId } from "./keyboard/action-ids";
import { matchesActionChord, useShortcut } from "./keyboard/use-shortcut";
import { PropertiesPanel } from "./properties/properties-panel";
import {
	notesCommitMatcher,
	notesDictionaryEditorMatchers,
	notesEntityTitleSource,
	notesEscapeMatcher,
	notesPropertyUiLabels,
} from "./properties/seam-bindings";
import { useNotesCommentsAdapter, useOpenCommentBlockIds } from "./store/comments-adapter";
import { NOTE_TYPE } from "./store/entities-repository";
import type { StoredNote } from "./store/note";
import { InitialNoteAction, pickInitialNote } from "./store/pick-initial-note";
import { getBrainstorm, openEntityInShell } from "./store/runtime";
import { localNoteOrder, noteSearchOrder } from "./store/search-results";
import { useNotes } from "./store/use-notes";
import { CoverBand } from "./ui/cover-band";
import { EntityIcon } from "./ui/entity-icon";
import { IconPicker } from "./ui/icon-picker";
import {
	NoteExportFormat,
	type NoteExportInput,
	buildNoteExportItems,
	runNoteExport,
} from "./ui/note-export";
import { NotesList } from "./ui/notes-list";
import { noteObjectMenuContext } from "./ui/object-menu-context";
import { NotesRightPanel, RightTab } from "./ui/right-panel-tabs";

const NAV_PREF_KEY = "notes.navOpen";
const PROPS_PREF_KEY = "notes.propsOpen";

/** Cheap order-insensitive equality for the autosave's body-ref diff, so a
 *  keystroke that doesn't change the set of cross-references doesn't re-persist
 *  `bodyRefs`. Compares `kind:entityId` keys. */
function noteRefsEqual(
	a: readonly NoteReference[],
	b: readonly NoteReference[] | undefined,
): boolean {
	const bb = b ?? [];
	if (a.length !== bb.length) return false;
	const key = (r: NoteReference) => `${r.kind}:${r.entityId}`;
	const seen = new Set(bb.map(key));
	return a.every((r) => seen.has(key(r)));
}

/** Older shells / the preview drop don't expose the `covers` service.
 *  The picker still works for Gallery/Color/Remove; the Image tab just
 *  has an empty library and a no-op upload (mirrors how Notes' icon
 *  Upload/Library degrade without the icons service). */
const COVERS_UNAVAILABLE: CoverPickerService = {
	uploadBytes: () => Promise.reject(new Error("covers service unavailable")),
	list: () => Promise.resolve([]),
};

const SHARE_DIALOG_LABELS: ShareDialogLabels = {
	title: t("notes.share.title"),
	membersHeading: t("notes.share.membersHeading"),
	you: t("notes.share.you"),
	roleOwner: t("notes.share.roleOwner"),
	roleEditor: t("notes.share.roleEditor"),
	roleViewer: t("notes.share.roleViewer"),
	revoke: t("notes.share.revoke"),
	addHeading: t("notes.share.addHeading"),
	codePlaceholder: t("notes.share.codePlaceholder"),
	canEdit: t("notes.share.canEdit"),
	canView: t("notes.share.canView"),
	add: t("notes.share.add"),
	inviteHeading: t("notes.share.inviteHeading"),
	getCode: t("notes.share.getCode"),
	copy: t("notes.share.copy"),
	copied: t("notes.share.copied"),
	inviteHint: t("notes.share.inviteHint"),
	shareFailed: t("notes.share.shareFailed"),
	revokeFailed: t("notes.share.revokeFailed"),
	loadFailed: t("notes.share.loadFailed"),
	done: t("notes.share.done"),
};

export function NotesApp() {
	const { ready, error, notes, selectedId, select, openEntity, create, update, setValue, remove } =
		useNotes();
	const note = selectedId ? (notes.get(selectedId) ?? null) : null;
	const runtime = useMemo(() => getBrainstorm(), []);

	// Blank-render recovery (see `blank-recovery-plugin.tsx`): if the editor
	// renders zero blocks while the Y.Doc has content (an apply/observeDeep
	// race), recover by rendering an unmount GAP (`gapped`) for one frame so
	// the replica fully releases and the resolver revives a fresh doc on
	// remount. A same-id key bump can't heal it — the released replica's ref
	// hasn't dropped when the remount re-resolves, so it reuses the populated
	// doc and stays blank. The shared hook owns the budget + gap (also used by
	// Journal); the editor keeps a stable `key={note.id}`.
	const editorHandleRef = useRef<LexicalEditor | null>(null);
	const { gapped, onRecoverBlank, onRecoverReset } = useBlankRecoveryGap(note?.id ?? "");

	// In-app back/forward over the open note (the shared SDK primitive —
	// identical model + chrome + chords across every first-party app). The
	// open-note id IS Notes' single navigable location. Recording is
	// centralised on the selection change so every entry point (list click,
	// search hit, cross-app `intent.open`, create) is captured once; a
	// history-driven `select` is guarded so it doesn't re-record itself.
	const navRef = useRef<NavHistory<string> | null>(null);
	if (!navRef.current) navRef.current = createNavHistory<string>({ initial: "" });
	const nav = navRef.current;
	const applyingFromHistoryRef = useRef(false);
	useEffect(() => {
		if (!selectedId) return;
		if (applyingFromHistoryRef.current) {
			applyingFromHistoryRef.current = false;
			return;
		}
		if (nav.current() === "") nav.replace(selectedId);
		else nav.push(selectedId);
	}, [selectedId, nav]);
	const onHistoryNavigate = useCallback(
		(id: string) => {
			if (!id || id === selectedId) return;
			applyingFromHistoryRef.current = true;
			select(id);
		},
		[select, selectedId],
	);
	// Sidebar row activation. A plain click / keyboard select opens the note
	// in place (same window). A modifier-held click dispatches a cross-app
	// `open` so the window manager honours the mode — Cmd/Ctrl → new tab,
	// Shift → new window — falling back to in-place select if the shell isn't
	// present (standalone / preview) or the dispatch fails.
	const onSelectNote = useCallback(
		(id: string, mode?: NavigationMode) => {
			if (!mode || mode === NavigationMode.Replace) {
				select(id);
				return;
			}
			void openEntityInShell({ entityId: id, entityType: NOTE_TYPE, mode }).then((ok) => {
				if (!ok) select(id);
			});
		},
		[select],
	);
	// The note the user last had open, recalled from the per-device settings
	// service (`@brainstorm/sdk/last-viewed`) — async, so the boot restore
	// below waits on `lastViewedLoaded` before picking, and the persist effect
	// only ever writes a non-null id so a transient null can't wipe it.
	const lastOpenRef = useRef<string | null>(null);
	const [lastViewedLoaded, setLastViewedLoaded] = useState(false);
	const [navOpen, setNavOpen] = useState(() => readPref(NAV_PREF_KEY, true));
	const [propsOpen, setPropsOpen] = useState(() => readPref(PROPS_PREF_KEY, false));
	const [rightTab, setRightTab] = useState<RightTab>(RightTab.Properties);

	// Live comments adapter for the open note (B11.9). Bridges the vault
	// entities signal + entities-service mutations into the shared
	// `@brainstorm/editor` comments adapter; null when no note or on an older
	// shell without the real entities service (Comments tab then stays hidden).
	const commentsAdapter = useNotesCommentsAdapter(note?.id ?? null);
	// Collab-C6 — roster-backed @-mention for the comment composer (Notes wires
	// CommentsProvider by hand, so it builds the same host EntityCommentsPanel does).
	const commentMentionHost = useCommentMentionHost(
		runtime?.services.roster ?? null,
		note?.id ?? null,
	);
	// Pending comment-on-selection anchor (B11.9) — set when the editor's inline
	// "Comment" row fires; routes the panel composer to that block. Cleared on
	// note switch or after the comment is posted / cancelled.
	const [pendingCommentAnchor, setPendingCommentAnchor] = useState<CommentAnchor | null>(null);
	// Click-to-thread (B11.9) — the highlight chip's request to scroll the
	// Comments tab to a block's thread. Nonce-bumped so repeat clicks on the
	// same block re-trigger the scroll; reset on note switch.
	const [commentFocusRequest, setCommentFocusRequest] = useState<CommentsFocusRequest | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: note?.id is the intended re-run trigger (reset on note switch), not a body capture
	useEffect(() => {
		setPendingCommentAnchor(null);
		setCommentFocusRequest(null);
	}, [note?.id]);
	const commentedBlockIds = useOpenCommentBlockIds(commentsAdapter ? (note?.id ?? null) : null);
	// Both comment entry points (inline-toolbar row, highlight chip) land the
	// user on the open Comments tab.
	const openCommentsTab = useCallback(() => {
		setRightTab(RightTab.Comments);
		setPropsOpen(true);
		writePref(PROPS_PREF_KEY, true);
	}, []);
	const onCommentBlockClick = useCallback(
		(blockId: string) => {
			if (!commentsAdapter) return;
			setCommentFocusRequest((prev) => ({ blockId, nonce: (prev?.nonce ?? 0) + 1 }));
			openCommentsTab();
		},
		[commentsAdapter, openCommentsTab],
	);
	const onCommentSelection = useCallback(
		(anchor: SelectionCommentAnchor) => {
			const id = note?.id;
			if (!id || !commentsAdapter) return;
			setPendingCommentAnchor({
				entityId: id,
				blockId: anchor.blockId,
				...(anchor.quote ? { quote: anchor.quote } : {}),
			});
			openCommentsTab();
		},
		[note?.id, commentsAdapter, openCommentsTab],
	);
	// Suggestion apply (B11.9) — the panel hands the suggestion root here;
	// the edit lands in the live editor and the panel resolves on success.
	const onApplySuggestion = useCallback((comment: CommentDef) => {
		const editor = editorHandleRef.current;
		if (!editor) return false;
		return applySuggestionInEditor(editor, comment.anchor, comment.suggestion?.replacement);
	}, []);
	// Inbound `#block-<id>` anchor (B11.13) — set when an `open` intent
	// carries a `blockId`; consumed by the editor's BlockAnchorsPlugin
	// (scroll + flash) once the target note is open, cleared on done /
	// timeout / navigating to a different note. Nonce-bumped so a repeat
	// click on the same link re-scrolls.
	const [anchorReveal, setAnchorReveal] = useState<{
		noteId: string;
		anchorId: string;
		nonce: number;
	} | null>(null);
	const onAnchorDone = useCallback(() => setAnchorReveal(null), []);
	useEffect(() => {
		const openId = note?.id;
		setAnchorReveal((prev) => (prev && openId && prev.noteId !== openId ? null : prev));
	}, [note?.id]);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [coverPickerOpen, setCoverPickerOpen] = useState(false);
	// Collab-C5 — the note id whose share dialog is open (null = closed).
	const [shareTargetId, setShareTargetId] = useState<string | null>(null);
	const navResizeRef = useRef<HTMLDivElement | null>(null);
	const propsResizeRef = useRef<HTMLDivElement | null>(null);

	// ─── Inline search (9.22.3) ──────────────────────────────────────────
	// Query the shell's vault-wide FTS5 index via `services.search.query`
	// (capability `search.read`, a default grant). Preview / older shells
	// have no search service — `searchHits` stays null and the order is
	// derived from a local title/body scan so the bar is never dead.
	const searchSvc = runtime?.services.search ?? null;
	const [searchText, setSearchText] = useState("");
	const [searchHits, setSearchHits] = useState<{ entityId: string }[] | null>(null);
	const searchInputRef = useRef<HTMLInputElement | null>(null);
	const searching = searchText.trim().length > 0;

	useEffect(() => {
		const q = searchText.trim();
		if (q.length === 0 || !searchSvc) {
			setSearchHits(null);
			return;
		}
		let cancelled = false;
		const handle = setTimeout(() => {
			void searchSvc
				.query({ text: q, types: [NOTE_TYPE], limit: 50 })
				.then((hits) => {
					if (!cancelled) setSearchHits(hits.map((h) => ({ entityId: h.entityId })));
				})
				.catch(() => {
					if (!cancelled) setSearchHits(null);
				});
		}, 150);
		return () => {
			cancelled = true;
			clearTimeout(handle);
		};
	}, [searchText, searchSvc]);

	// Derived from the live `notes` map so a rename/edit while searching
	// updates the row without a re-query (mirrors the Tasks app).
	const searchOrder = useMemo<string[] | undefined>(() => {
		if (!searching) return undefined;
		return searchHits !== null
			? noteSearchOrder(notes, searchHits)
			: localNoteOrder(notes, searchText);
	}, [searching, searchHits, notes, searchText]);

	const clearSearch = useCallback(() => {
		setSearchText("");
		setSearchHits(null);
		searchInputRef.current?.focus();
	}, []);

	useShortcut(
		ActionId.FocusNotesSearch,
		useCallback((event: KeyboardEvent) => {
			event.preventDefault();
			const el = searchInputRef.current;
			if (!el) return;
			el.focus();
			el.select();
		}, []),
	);

	useEffect(() => {
		const handle = navResizeRef.current;
		if (!handle) return;
		const r = attachResizable({
			handle,
			side: "left",
			defaultWidth: 260,
			min: 200,
			max: 420,
			storageKey: "notes:nav-width",
			onWidth: (px) => {
				document.body.style.setProperty("--notes-nav-width", `${px}px`);
			},
		});
		return () => r.destroy();
	}, []);

	useEffect(() => {
		const handle = propsResizeRef.current;
		if (!handle) return;
		const r = attachResizable({
			handle,
			side: "right",
			defaultWidth: 320,
			min: 260,
			max: 480,
			storageKey: "notes:props-width",
			onWidth: (px) => {
				document.body.style.setProperty("--notes-props-width", `${px}px`);
			},
		});
		return () => r.destroy();
	}, []);

	// Auto-pick a note when storage finishes loading. Precedence:
	//   1. A cross-app `intent.open` with `entityId` — the receiving app
	//      must land on the requested doc.
	//   2. The note the user last had open (persisted) — so a renderer
	//      refresh / app relaunch returns to where they were, not a
	//      surprise jump to most-recent. Guarded by existence in the
	//      loaded set so a deleted note / vault switch / foreign-entity
	//      id degrades gracefully instead of booting blank.
	//   3. Most-recent — first-ever run / nothing to restore.
	// Recall the last-open note id before the boot pick runs. An explicit
	// `open-entity` launch never needs it, so skip the read in that case.
	useEffect(() => {
		if (runtime?.launch?.reason === "open-entity") {
			setLastViewedLoaded(true);
			return;
		}
		let alive = true;
		void recallLastViewed(runtime?.services?.settings).then((id) => {
			if (!alive) return;
			lastOpenRef.current = id;
			setLastViewedLoaded(true);
		});
		return () => {
			alive = false;
		};
	}, [runtime]);

	useEffect(() => {
		if (!ready || !lastViewedLoaded || selectedId) return;
		const launch = runtime?.launch;
		const pick = pickInitialNote({
			hasLaunchEntity: launch?.reason === "open-entity",
			launchEntityId: launch?.entityId ?? null,
			lastOpenId: lastOpenRef.current,
			hasNote: (id) => notes.has(id),
			mostRecentId: mostRecent(notes)?.id ?? null,
		});
		// `open-entity` routes through `openEntity` (it also adapts a
		// non-note object — Notes is the universal editor); a restored /
		// most-recent pick is a known native note, so plain `select`.
		if (pick.action === InitialNoteAction.OpenEntity) openEntity(pick.entityId);
		else if (pick.action === InitialNoteAction.Select) select(pick.id);
	}, [ready, lastViewedLoaded, selectedId, notes, select, openEntity, runtime]);

	// Persist the open note so the boot restore above can return to it.
	// Never write `null`: the transient null between boot and select (and
	// after deleting the open note) must not wipe the stored id.
	useEffect(() => {
		if (selectedId) void rememberLastViewed(runtime?.services?.settings, selectedId);
	}, [selectedId, runtime]);

	// Running-app intent push — a sibling app dispatches `open` while
	// Notes is already open. The launcher just focuses the existing
	// window, so `runtime.launch` doesn't update — the `app:intent`
	// channel re-emits a lifecycle event we subscribe to here.
	//
	// Two intents land here today:
	//   - `open` { entityId } — focus the named note if present
	//   - `compose` { title? } — idempotent on title: if a note with
	//     that exact title exists, select it; otherwise create one
	//     seeded with the title. Used by Journal's "Start today's
	//     journal" button and (eventually) Bookmarks' paste-URL flow.
	useEffect(() => {
		if (!runtime) return;
		const sub = runtime.on("intent", (event) => {
			if (event.type !== "intent") return;
			const intent = event.intent;
			if (intent.verb === "open") {
				const entityId = intent.payload?.entityId;
				if (typeof entityId !== "string") return;
				openEntity(entityId);
				const blockId = intent.payload?.blockId;
				if (typeof blockId === "string" && blockId.length > 0) {
					setAnchorReveal((prev) => ({
						noteId: entityId,
						anchorId: blockId,
						nonce: (prev?.nonce ?? 0) + 1,
					}));
				}
				return;
			}
			if (intent.verb === "compose") {
				const titleSeed = intent.payload?.title;
				const title = typeof titleSeed === "string" ? titleSeed : "";
				if (title) {
					const existing = findNoteByTitle(notes, title);
					if (existing) {
						select(existing.id);
						return;
					}
				}
				const fresh = create(title ? { title } : undefined);
				if (fresh) select(fresh.id);
				return;
			}
		});
		return () => sub.unsubscribe();
	}, [runtime, notes, select, openEntity, create]);

	const toggleNav = useCallback(() => {
		setNavOpen((open) => {
			const next = !open;
			writePref(NAV_PREF_KEY, next);
			return next;
		});
	}, []);

	const toggleProps = useCallback(() => {
		setPropsOpen((open) => {
			const next = !open;
			writePref(PROPS_PREF_KEY, next);
			return next;
		});
	}, []);

	// Page-level lock (B11.11) — a SYNCED note property (`properties.locked`),
	// not per-device chrome, so a lock set on one device/user is visible
	// everywhere. Derived straight from the open note; the toggle persists
	// through the same entities-backed `update` path as any other note field
	// (optimistic in-memory, then merged + broadcast to peers).
	const locked = note?.locked ?? false;
	const toggleLock = useCallback(() => {
		if (!note) return;
		update(note.id, { locked: !(note.locked ?? false) });
	}, [note, update]);

	useShortcut(
		ActionId.ToggleNoteLock,
		useCallback(
			(event: KeyboardEvent) => {
				if (!note) return;
				event.preventDefault();
				toggleLock();
			},
			[note, toggleLock],
		),
	);

	useShortcut(
		ActionId.ToggleSidebar,
		useCallback(
			(event: KeyboardEvent) => {
				event.preventDefault();
				toggleNav();
			},
			[toggleNav],
		),
	);

	useShortcut(
		ActionId.ToggleProperties,
		useCallback(
			(event: KeyboardEvent) => {
				event.preventDefault();
				toggleProps();
			},
			[toggleProps],
		),
	);

	const onNewNote = useCallback(() => {
		create();
	}, [create]);

	const onDelete = useCallback(async () => {
		if (!note) return;
		await remove(note.id);
	}, [note, remove]);

	const onRemoveNote = useCallback(
		async (id: string) => {
			await remove(id);
		},
		[remove],
	);

	const onPickIcon = useCallback(
		(icon: Icon | null) => {
			if (!note) return;
			update(note.id, { icon });
		},
		[note, update],
	);

	const onPickCover = useCallback(
		(cover: Cover | null) => {
			if (!note) return;
			update(note.id, { cover });
		},
		[note, update],
	);

	const onBodyChange = useCallback(
		(body: SerializedEditorState) => {
			if (!note) return;
			// N3 — the body itself persists via the Y.Doc resolver; this
			// callback denormalises the SerializedEditorState into two
			// sidebar/search-only mirrors:
			//   - `title` — the TitleNode text, shown in headers + rows;
			//   - `body`  — a length-capped plain-text snippet, fed to
			//               `displayTitle()` + `localNoteOrder()` so a
			//               row whose title is empty falls back to a body
			//               snippet, and the local-search fallback still
			//               matches body substrings without resolving the
			//               full Y.Doc replica per row.
			// AutosavePlugin gates this on real user interaction so the
			// mount-settle echo doesn't re-fire (the [[project_notes_
			// autosave_swallows_first_edit]] invariant).
			const { title, snippet } = denormalizeBody(body);
			// Extract body cross-refs from the live editor state and persist them
			// so the shell can project note→note graph edges — the snippet has no
			// rich nodes to walk (F-067).
			const refs = extractNoteReferences(body);
			const titleChanged = title !== note.title;
			const snippetChanged = snippet !== note.body;
			const refsChanged = !noteRefsEqual(refs, note.bodyRefs);
			if (!titleChanged && !snippetChanged && !refsChanged) return;
			const patch: Partial<StoredNote> = {};
			if (titleChanged) patch.title = title;
			if (snippetChanged) patch.body = snippet;
			if (refsChanged) patch.bodyRefs = refs;
			update(note.id, patch);
		},
		[note, update],
	);

	const editorNoteContext = useMemo(
		() =>
			note
				? {
						values: note.values,
						setValue: <V extends ValueType>(
							def: PropertyDef & { valueType: V },
							next: PropertyValueByValueType[V],
						) => setValue(note.id, def, next),
						// Only expose comment-on-selection + highlight when the note has a
						// live comments adapter — gates the toolbar's "Comment" row.
						...(commentsAdapter ? { onCommentSelection, commentedBlockIds, onCommentBlockClick } : {}),
					}
				: null,
		[note, setValue, commentsAdapter, onCommentSelection, commentedBlockIds, onCommentBlockClick],
	);

	const onSetPropertyValue = useCallback(
		<V extends ValueType>(def: PropertyDef & { valueType: V }, next: PropertyValueByValueType[V]) => {
			if (!note) return;
			setValue(note.id, def, next);
		},
		[note, setValue],
	);

	const onClearPropertyValue = useCallback(
		(key: string) => {
			if (!note) return;
			update(note.id, { values: clearValue(note.values, key) });
		},
		[note, update],
	);

	const onBindProperty = useCallback(
		(def: PropertyDef) => {
			if (!note) return;
			const nextValues = bindValue(note.values, def as PropertyDef & { valueType: ValueType });
			if (nextValues === note.values) return;
			update(note.id, { values: nextValues });
		},
		[note, update],
	);

	const headerTitle = note?.title.trim() || (note ? t("notes.list.untitled") : t("notes.app.title"));

	// Publish the open object's name + icon — the shell reads
	// `page-title-updated` / `page-favicon-updated` to label this tab + the
	// OS window.
	const tabIcon = note?.icon ?? null;
	useEffect(() => {
		publishTabIdentity({ title: headerTitle, icon: tabIcon });
	}, [headerTitle, tabIcon]);

	// Export… entries (Markdown / HTML) for the open note's object menu —
	// only when the Files host is bound (older shells / preview drops no-show
	// the rows rather than fail mid-save). They serialise the live editor
	// state captured in `editorHandleRef`, so they reflect unsaved edits.
	const noteExportInput = useMemo<NoteExportInput | null>(() => {
		const files = runtime?.services.files;
		if (!files) return null;
		const filterByFormat: Record<NoteExportFormat, string> = {
			[NoteExportFormat.Markdown]: t("notes.export.markdownFilter"),
			[NoteExportFormat.Html]: t("notes.export.htmlFilter"),
			[NoteExportFormat.Pdf]: t("notes.export.pdfFilter"),
		};
		const exportService = runtime?.services.export;
		return {
			files,
			title: headerTitle,
			getState: () => editorHandleRef.current?.getEditorState().toJSON() ?? null,
			...(exportService ? { exportPdf: (html: string) => exportService.printToPdf({ html }) } : {}),
			labels: {
				filterName: (format) => filterByFormat[format],
				dialogTitle: t("notes.export.dialogTitle"),
				exportAction: t("notes.export.action"),
				formatLegend: t("notes.export.formatLegend"),
				cancel: t("notes.export.cancel"),
			},
		};
	}, [runtime, headerTitle]);
	const noteExportItems = useMemo(
		() => (noteExportInput ? buildNoteExportItems(noteExportInput) : undefined),
		[noteExportInput],
	);

	// B11.6 — `Cmd+P` prints the open note. "Print" routes to PDF export (the
	// document's print artifact, per B11.12), reusing the same save flow as the
	// object-menu PDF row. preventDefault suppresses Chromium's own print
	// dialog (the capture-phase listener runs first). Inert when no note is
	// open or `services.export` is unbound (the Pdf format isn't in the specs).
	const onPrintNote = useCallback(
		(event: KeyboardEvent) => {
			if (!noteExportInput?.exportPdf || !note) return;
			event.preventDefault();
			void runNoteExport(NoteExportFormat.Pdf, noteExportInput);
		},
		[noteExportInput, note],
	);
	useShortcut(ActionId.PrintNote, onPrintNote);
	// "Press {action} to start writing." — the `{action}` slot is a real
	// <kbd> element, so the localised template is split on the placeholder
	// and the chrome is rendered around it (the SDK `t()` only does string
	// interpolation; an embedded element needs the host to stitch).
	const emptyHintParts = t("notes.empty.hint").split("{action}");
	// The note's OWN icon — never a synthesized default. A removed icon
	// reads as empty everywhere (header affordance + doc), per the
	// per-object-icon convention; the type glyph is fallback-only and an
	// unset icon is genuinely unset.
	const noteIcon: Icon | null = note?.icon ?? null;
	// The note's OWN cover (`properties.cover`). `null` → the renderer's
	// id-seeded gradient fallback; per-object-covers-everywhere.
	const noteCover: Cover | null = note?.cover ?? null;

	// Object-menu entries spliced in before Remove: the cover affordance (its
	// own always-visible button made the coverless editor chrome noisy) then
	// Export. Opening the picker is the same `setCoverPickerOpen` flow the cover
	// band click uses; the label flips between Add / Change on whether one is set.
	const objectMenuExtraItems = useMemo<ObjectMenuExtraItem[] | undefined>(() => {
		const coverItem: ObjectMenuExtraItem = {
			id: "cover",
			label: noteCover ? t("notes.coverPicker.open") : t("notes.coverPicker.add"),
			icon: IconName.Palette,
			run: () => setCoverPickerOpen(true),
		};
		return [coverItem, ...(noteExportItems ?? [])];
	}, [noteCover, noteExportItems]);

	// The properties panel only makes sense with an open note. The persisted
	// `propsOpen` preference is remembered, but the panel is never *shown*
	// empty — gate its visibility on having a note so list/no-selection states
	// don't slide in a blank glass overlay.
	const propsVisible = propsOpen && note !== null;

	const propertiesPanel = note ? (
		<PropertiesPanel
			note={note}
			onSetValue={onSetPropertyValue}
			onClear={onClearPropertyValue}
			onBind={onBindProperty}
			onClose={toggleProps}
			// Inside the comments tab strip the tab already says "Properties";
			// suppress the panel's own header so it isn't doubled (F-252).
			hideHeader={Boolean(commentsAdapter)}
		/>
	) : null;

	const shell = (
		<div className="notes" data-nav-open={navOpen} data-props-open={propsVisible}>
			<header className="app-header notes__header">
				<div className="notes__header-left">
					<NavButtons history={nav} onNavigate={onHistoryNavigate} />
					{note && (
						<button
							type="button"
							className="bs-icon-pick"
							style={{
								width: "var(--control-height-sm)",
								height: "var(--control-height-sm)",
								fontSize: "var(--text-size-xl)",
							}}
							aria-label={t("notes.iconPicker.open")}
							aria-haspopup="dialog"
							aria-expanded={pickerOpen}
							onClick={() => setPickerOpen((open) => !open)}
						>
							<EntityIcon icon={noteIcon} size={18} fallback={<AddIconGlyph />} />
						</button>
					)}
					{note ? (
						<ObjectMenuTrigger
							className="notes__header-title-menu"
							moreActionsLabel={t("notes.objectMenu.more")}
							noMoreButton
							context={() =>
								noteObjectMenuContext({
									noteId: note.id,
									noteTitle: headerTitle,
									runtime,
									onRemove: onDelete,
									onShare: () => setShareTargetId(note.id),
									...(objectMenuExtraItems ? { extraItems: objectMenuExtraItems } : {}),
								})
							}
						>
							<span className="app-header__title">{headerTitle}</span>
						</ObjectMenuTrigger>
					) : (
						<span className="app-header__title">{headerTitle}</span>
					)}
				</div>
				<div className="notes__header-right">
					<button
						type="button"
						className="header-icon-btn"
						onClick={onNewNote}
						disabled={!ready}
						aria-label={t("notes.header.newNote")}
						data-bs-tooltip={t("notes.header.newNote")}
						title={!ready ? t("notes.header.newNote") : undefined}
					>
						<PlusIcon />
					</button>
					{note && (
						<LockButton
							locked={locked}
							onToggle={toggleLock}
							lockLabel={t("notes.header.lock")}
							unlockLabel={t("notes.header.unlock")}
						/>
					)}
					<PanelToggleButton
						side={PanelSide.Left}
						open={navOpen}
						onClick={toggleNav}
						labels={{ show: t("notes.sidebar.show"), hide: t("notes.sidebar.hide") }}
						controls="notes-nav"
					/>
					<PanelToggleButton
						side={PanelSide.Right}
						open={propsOpen}
						onClick={toggleProps}
						labels={{
							show: t("notes.properties.show"),
							hide: t("notes.properties.hide"),
						}}
						controls="notes-props"
						disabled={!note}
					/>
					{note && (
						<ObjectMenuMoreButton
							moreActionsLabel={t("notes.objectMenu.more")}
							context={() =>
								noteObjectMenuContext({
									noteId: note.id,
									noteTitle: headerTitle,
									runtime,
									onRemove: onDelete,
									onShare: () => setShareTargetId(note.id),
									...(objectMenuExtraItems ? { extraItems: objectMenuExtraItems } : {}),
								})
							}
						/>
					)}
				</div>
			</header>

			<aside
				id="notes-nav"
				className="notes__nav"
				aria-label={t("notes.sidebar.region")}
				aria-hidden={!navOpen}
				inert={!navOpen ? true : undefined}
			>
				<div className="notes__search">
					<Searchbar
						inputRef={searchInputRef}
						value={searchText}
						onChange={setSearchText}
						placeholder={t("notes.search.placeholder")}
						clearLabel={t("notes.search.clear")}
						onClear={clearSearch}
						onKeyDown={(e) => {
							if (searching && matchesActionChord(ActionId.ClearNotesSearch, e)) {
								e.preventDefault();
								clearSearch();
							}
						}}
					/>
				</div>
				<NotesList
					notes={notes}
					selectedId={selectedId}
					onSelect={onSelectNote}
					order={searchOrder}
					emptyLabel={searching ? t("notes.search.empty") : undefined}
					runtime={runtime}
					onRemoveNote={onRemoveNote}
				/>
			</aside>
			<div
				ref={navResizeRef}
				className="notes__nav-resize"
				role="separator"
				aria-orientation="vertical"
				aria-label={t("notes.sidebar.resize")}
				tabIndex={0}
			/>

			<main className="notes__main" aria-live="polite">
				{error ? (
					<div className="notes__error">
						<p>{error}</p>
					</div>
				) : !ready ? (
					<div className="notes__empty">
						<p>{t("notes.state.loading")}</p>
					</div>
				) : note ? (
					<>
						{/* A coverless note shows no band and no always-on "Add cover"
						    button — that single persistent affordance made the editor
						    chrome noisy. "Add cover" now lives in the object ⋯ menu;
						    the band appears only once a cover is set, and clicking it
						    reopens the picker. The seeded-gradient fallback still backs
						    every reserved-space surface (gallery cards, list, search,
						    dashboard pins) per docs/foundations/50-object-covers.md §56. */}
						{noteCover && (
							<button
								type="button"
								className="notes__doc-cover"
								aria-label={t("notes.coverPicker.open")}
								aria-haspopup="dialog"
								aria-expanded={coverPickerOpen}
								onClick={() => setCoverPickerOpen((open) => !open)}
							>
								<CoverBand subjectId={note.id} cover={noteCover} aspect={16 / 3.5} />
							</button>
						)}
						<div className="notes__doc" data-has-icon={noteIcon ? "true" : "false"}>
							{noteIcon && (
								<button
									type="button"
									className="notes__doc-icon"
									aria-label={t("notes.iconPicker.open")}
									aria-haspopup="dialog"
									aria-expanded={pickerOpen}
									onClick={() => setPickerOpen((open) => !open)}
								>
									<EntityIcon icon={noteIcon} size={28} />
								</button>
							)}
							<div className="notes__body">
								{editorNoteContext && !gapped && (
									<Editor
										key={note.id}
										noteId={note.id}
										storedTitle={note.title}
										onChange={onBodyChange}
										noteContext={editorNoteContext}
										onRecoverBlank={onRecoverBlank}
										onRecoverReset={onRecoverReset}
										editorHandleRef={editorHandleRef}
										locked={locked}
										anchorReveal={anchorReveal && anchorReveal.noteId === note.id ? anchorReveal : null}
										onAnchorDone={onAnchorDone}
									/>
								)}
							</div>
						</div>
					</>
				) : (
					<EmptyState
						icon={IconName.View}
						title={t("notes.empty.title")}
						hint={
							<>
								{emptyHintParts[0]}
								<kbd>{t("notes.header.newNote")}</kbd>
								{emptyHintParts[1]}
							</>
						}
					/>
				)}
			</main>

			<div
				ref={propsResizeRef}
				className="notes__props-resize"
				role="separator"
				aria-orientation="vertical"
				aria-label={t("notes.properties.resize")}
				tabIndex={0}
			/>
			<aside
				id="notes-props"
				className="notes__props glass--strong"
				aria-label={t("notes.properties.region")}
				aria-hidden={!propsVisible}
				inert={!propsVisible ? true : undefined}
			>
				{note &&
					(commentsAdapter ? (
						<CommentsProvider
							adapter={commentsAdapter}
							authorName={localPresenceName()}
							mentionHost={commentMentionHost}
						>
							<NotesRightPanel
								documentId={note.id}
								active={rightTab}
								onTabChange={setRightTab}
								properties={propertiesPanel}
								onClearPending={() => setPendingCommentAnchor(null)}
								{...(pendingCommentAnchor ? { pendingAnchor: pendingCommentAnchor } : {})}
								focusRequest={commentFocusRequest}
								onApplySuggestion={onApplySuggestion}
							/>
						</CommentsProvider>
					) : (
						propertiesPanel
					))}
			</aside>

			{pickerOpen && note && (
				<IconPicker value={note.icon} onChange={onPickIcon} onClose={() => setPickerOpen(false)} />
			)}

			{coverPickerOpen && note && (
				<CoverPicker
					value={note.cover}
					covers={runtime?.services.covers ?? COVERS_UNAVAILABLE}
					onChange={onPickCover}
					onClose={() => setCoverPickerOpen(false)}
					labels={{
						region: t("notes.coverPicker.region"),
						close: t("notes.coverPicker.close"),
						remove: t("notes.coverPicker.remove"),
						tabImage: t("notes.coverPicker.tab.image"),
						tabGallery: t("notes.coverPicker.tab.gallery"),
						tabReposition: t("notes.coverPicker.tab.reposition"),
						upload: t("notes.coverPicker.upload"),
						uploading: t("notes.coverPicker.uploading"),
						dropHint: t("notes.coverPicker.dropHint"),
						libraryEmpty: t("notes.coverPicker.libraryEmpty"),
						focalHint: t("notes.coverPicker.focalHint"),
						useCover: t("notes.coverPicker.useCover"),
						galleryRegion: t("notes.coverPicker.galleryRegion"),
					}}
				/>
			)}

			{shareTargetId && runtime?.services.sharing && runtime?.services.roster ? (
				<ShareDialog
					entityId={shareTargetId}
					entityType={NOTE_TYPE}
					sharing={runtime.services.sharing}
					roster={runtime.services.roster}
					canManage
					labels={SHARE_DIALOG_LABELS}
					onClose={() => setShareTargetId(null)}
				/>
			) : null}
		</div>
	);

	if (!runtime) return shell;
	return (
		<PropertiesProvider
			runtime={runtime}
			labels={notesPropertyUiLabels}
			escapeMatcher={notesEscapeMatcher}
			commitMatcher={notesCommitMatcher}
			entityTitleSource={notesEntityTitleSource}
			dictionaryEditorMatchers={notesDictionaryEditorMatchers}
			dictionaryEntities={[...notes.values()].map((n) => ({ id: n.id, values: n.values }))}
			onRewriteDictionaryEntities={(changed) => {
				for (const c of changed) update(c.id, { values: c.values });
			}}
			dictionarySortStorage={runtime.services.storage}
		>
			{shell}
		</PropertiesProvider>
	);
}

function mostRecent(map: Map<string, StoredNote>): StoredNote | undefined {
	let pick: StoredNote | undefined;
	for (const n of map.values()) {
		if (!pick || n.updatedAt > pick.updatedAt) pick = n;
	}
	return pick;
}

/** Find the first note whose title matches `wanted` exactly. Used by
 *  the `intent.compose` handler for idempotent create-or-select on a
 *  title key (Journal date keys, eventual Bookmark URL summaries). Ties
 *  break on most-recently-updated so a date-key with two duplicate
 *  notes prefers the one the user has touched more recently. */
function findNoteByTitle(map: Map<string, StoredNote>, wanted: string): StoredNote | undefined {
	let pick: StoredNote | undefined;
	for (const n of map.values()) {
		if (n.title !== wanted) continue;
		if (!pick || n.updatedAt > pick.updatedAt) pick = n;
	}
	return pick;
}

function readPref(key: string, fallback: boolean): boolean {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return fallback;
		return raw !== "false";
	} catch {
		return fallback;
	}
}

function writePref(key: string, open: boolean): void {
	try {
		localStorage.setItem(key, String(open));
	} catch {
		// Storage quota / disabled — pref reverts to default on reload.
	}
}

/** Sidebar-toggle glyph. `side` picks which edge holds the filled bar so
 *  the left (navigation) and right (properties) toggles read as
 *  mirror-images — the active state fills the bar on the panel's side. */
