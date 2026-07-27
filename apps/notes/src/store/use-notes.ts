/**
 * Single-document Notes store. Wraps `storage.kv` with a React hook
 * exposing the currently-loaded notes Map, the selected id, and CRUD
 * operations. The hook is local to this app — there's no shared global
 * store, no Redux, no Zustand. v1 stays simple; multi-doc routing comes
 * from the dashboard, not from inside this app.
 *
 * Storage contract: one `note:<id>` key per note (see ./note.ts). Body is
 * stored as a Lexical serialized state OR a legacy string (auto-upgraded
 * on read).
 */

import { createQueryStore } from "@brainstorm-os/react-yjs";
import type { PropertyDef, PropertyValueByValueType, ValueType } from "@brainstorm-os/sdk-types";
import { writeValue } from "@brainstorm-os/sdk/property-ui/pure";
import { useCallback, useEffect, useRef, useState } from "react";
import { createEntitiesRepository, foreignEntityToNote } from "./entities-repository";
import { runVaultBodyMigration } from "./migrate-body";
import { type StoredNote, newNoteId } from "./note";
import type { NotesRepository } from "./repository";
import { type EntitiesService, getBrainstorm } from "./runtime";
import { getYDocResolverApi } from "./ydoc-resolver";

/** Optional seed for `create()` — the compose intent passes a `title`
 *  here so the new note pre-populates a journal date-key, a bookmark
 *  URL summary, etc. `migrateTitleIntoBody` synthesises the proper
 *  TitleNode on the next load. */
export type CreateSeed = {
	title?: string;
};

export type UseNotes = {
	ready: boolean;
	error: string | null;
	notes: Map<string, StoredNote>;
	selectedId: string | null;
	select: (id: string | null) => void;
	/** Open an entity by id for editing. A known note just selects;
	 *  anything else (a Person, a Task — the generic-fallback target) is
	 *  fetched via the shared entities service, adapted into the editable
	 *  note shape, added to the working set and selected. No-ops when the
	 *  id resolves to nothing or the entities service is absent. */
	openEntity: (id: string) => void;
	create: (seed?: CreateSeed) => StoredNote | null;
	update: (id: string, patch: Partial<StoredNote>) => void;
	/** Set one property value on `noteId`, value-type-narrowed against
	 *  `def`. Wraps `writeValue` + `update` so cells can be one-liners;
	 *  setting a shape-empty value clears the entry from the note's
	 *  `values`. */
	setValue: <V extends ValueType>(
		noteId: string,
		def: PropertyDef & { valueType: V },
		next: PropertyValueByValueType[V],
	) => void;
	remove: (id: string) => Promise<void>;
};

export function useNotes(): UseNotes {
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notes, setNotes] = useState<Map<string, StoredNote>>(new Map());
	const [selectedId, setSelectedId] = useState<string | null>(null);

	// Pending writes per noteId — coalesces fast-typing updates into one
	// storage.put per save tick.
	const pendingRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
	const repoRef = useRef<NotesRepository | null>(null);
	const entitiesSvcRef = useRef<EntitiesService | null>(null);
	// Mirror of `notes` for callbacks that must read the current set
	// without re-creating on every keystroke.
	const notesMapRef = useRef(notes);
	notesMapRef.current = notes;
	// Mirror of the open note id — the store's `reconcile` reads it to keep the
	// open note from ever dropping out of the list (which would unmount its
	// editor mid-edit).
	const selectedIdRef = useRef(selectedId);
	selectedIdRef.current = selectedId;
	// Notes created this session, for the abandoned-empty auto-discard (F-066).
	const createdThisSessionRef = useRef<Set<string>>(new Set());
	const prevSelectedRef = useRef<string | null>(null);

	useEffect(() => {
		const bs = getBrainstorm();
		if (!bs) {
			setError("Notes runtime missing — preload didn't expose the brainstorm bridge.");
			return;
		}
		let cancelStaleRefresh: (() => void) | null = null;
		const sub = bs.on("ready", () => {
			// Notes lives in the single object space — the shared entities
			// service over `entities.db`, visible to Graph/Database via the
			// aggregator (note→note edges keep painting via 9.3.5.N-notes.3a).
			// Seeded + user-authored notes are written straight to
			// `entities.db`, so the app reads it directly.
			const entitiesSvc = bs.services.entities;
			entitiesSvcRef.current = entitiesSvc ?? null;
			if (!entitiesSvc) {
				setReady(true);
				return;
			}
			const repo = createEntitiesRepository(entitiesSvc);
			repoRef.current = repo;
			const resolverApi = getYDocResolverApi();
			const ydocResolve = resolverApi?.resolve;
			const ydocWhenLoaded = resolverApi?.whenLoaded;
			const runMigration = (map: Map<string, StoredNote>): void => {
				if (!ydocResolve) return;
				void runVaultBodyMigration({
					notes: map,
					repo,
					resolve: ydocResolve,
					...(ydocWhenLoaded ? { whenLoaded: ydocWhenLoaded } : {}),
					storage: bs.services.storage,
				});
			};
			void repo.listAll().then((map) => {
				// Render the list as soon as we have it — the legacy-body
				// migration plants Y.Doc content for each row, but the
				// LIST only needs `title` / `icon` / snippet (already on
				// the row). Blocking `setReady` on a full-vault migration
				// would stall the empty-state forever when one of the
				// per-note `whenLoaded` calls hangs (e.g. IPC backpressure
				// dropping a `loadDoc` request — see the
				// `WHEN_LOADED_TIMEOUT_MS` carve-out in migrate-body). The
				// migration still runs, just in the background: rows that
				// finish planting receive an `entities.onChange` signal
				// and re-render naturally; rows the user opens before
				// planting completes show the live editor reading from a
				// post-plant Y.Doc the moment the per-note plant lands.
				setNotes(map);
				setReady(true);
				runMigration(map);
			});
			// Re-list whenever the vault-entities surface fires its staleness
			// signal. This catches the dev `reseed-vault` flow: the seeder
			// backfills entities.db AFTER Notes has booted on an empty vault,
			// and without this the in-memory map stayed empty until the user
			// reloaded the app window.
			//
			// Coalescing matters here: the boot migration alone fires N broadcasts
			// (one per planted note), and a single user write (an icon pick, say)
			// races concurrent worker writes. Un-batched, every broadcast re-renders
			// the whole virtualised sidebar and detaches the open note's editor host
			// mid-typing.
			if (bs.services.vaultEntities?.onChange) {
				const onChange = bs.services.vaultEntities.onChange;
				// The shared reactivity core (`@brainstorm-os/react-yjs`) owns the
				// subscribe → coalesce → refetch → short-circuit → teardown dance
				// that this file used to hand-roll. It is driven imperatively rather
				// than via `useLiveEntities` because the repo is constructed inside
				// this ready-callback, so there is no source to hand a hook at the
				// top of the component.
				//
				// The one thing that kept Notes off the shared stack was the merge
				// below, which `equals` cannot express — that is now the store's
				// `reconcile` option.
				const store = createQueryStore<Map<string, StoredNote>>({
					initial: notesMapRef.current,
					load: () => repo.listAll(),
					subscribe: (onInvalidate) => {
						const sub = onChange(onInvalidate);
						return () => sub.unsubscribe();
					},
					// Pin against LIVE component state (`notesMapRef`), not the store's
					// own `prev` snapshot. Optimistic edits — every keystroke's
					// `update()` — call `setNotes` directly and never pass through the
					// store, so the store's snapshot lags React by however long the
					// user has been typing. Reconciling against it pins a STALE copy of
					// the open note over the in-flight one, so a vault broadcast
					// mid-edit reverts what you just typed and thrashes the sidebar.
					// The pre-store code read React state via `setNotes(prev => …)`;
					// this keeps that semantic.
					reconcile: (_storeSnapshot, next) =>
						pinLocalNotes(notesMapRef.current, next, pendingRef.current.keys(), selectedIdRef.current),
					// The body migration + sibling writes fire a stream of `onChange`
					// broadcasts; without this guard every one swaps in a new Map → the
					// virtualised list re-renders and the scroll/order "jumps", even
					// though no visible field moved.
					equals: sidebarEquivalent,
					coalesceMs: 250,
				});
				// We deliberately do NOT re-run `runMigration` on refresh. The boot
				// pass + per-note open-time fallback are sufficient, and chaining
				// migration → save → broadcast → refresh → migration formed a
				// self-amplifying loop that thrashed the sidebar.
				const unsubscribeStore = store.subscribe(() => setNotes(store.getSnapshot()));
				cancelStaleRefresh = () => {
					unsubscribeStore();
					store.dispose();
				};
			}
		});
		return () => {
			sub.unsubscribe();
			// Drop the store: unbinds the signal and cancels any armed trailing
			// reload, without which a broadcast within 250ms of teardown fires
			// `setNotes` on an unmounted component.
			cancelStaleRefresh?.();
		};
	}, []);

	const select = useCallback((id: string | null) => {
		setSelectedId(id);
	}, []);

	const openEntity = useCallback((id: string) => {
		if (notesMapRef.current.has(id)) {
			setSelectedId(id);
			return;
		}
		const svc = entitiesSvcRef.current;
		if (!svc) return;
		void svc
			.get(id)
			.then((record) => {
				if (!record) return;
				const adapted = foreignEntityToNote(record);
				setNotes((prev) => {
					if (prev.has(adapted.id)) return prev;
					return new Map(prev).set(adapted.id, adapted);
				});
				setSelectedId(adapted.id);
			})
			.catch((e) => {
				console.warn("[notes] openEntity failed for", id, e);
			});
	}, []);

	const create = useCallback((seed?: CreateSeed): StoredNote | null => {
		const repo = repoRef.current;
		if (!repo) return null;
		const now = Date.now();
		const note: StoredNote = {
			id: newNoteId(),
			title: typeof seed?.title === "string" ? seed.title : "",
			icon: null,
			cover: null,
			body: "",
			values: {},
			createdAt: now,
			updatedAt: now,
		};
		setNotes((prev) => new Map(prev).set(note.id, note));
		setSelectedId(note.id);
		createdThisSessionRef.current.add(note.id);
		void repo.save(note).catch((e) => {
			console.error("[notes] create persist failed:", e);
			setError(`Couldn't save: ${(e as Error).message}`);
		});
		return note;
	}, []);

	const update = useCallback((id: string, patch: Partial<StoredNote>) => {
		setNotes((prev) => {
			const existing = prev.get(id);
			if (!existing) return prev;
			const next = new Map(prev);
			const updated = { ...existing, ...patch, updatedAt: Date.now() };
			next.set(id, updated);
			schedulePersist(updated, pendingRef.current, repoRef.current);
			return next;
		});
	}, []);

	const setValue = useCallback(
		<V extends ValueType>(
			noteId: string,
			def: PropertyDef & { valueType: V },
			next: PropertyValueByValueType[V],
		) => {
			setNotes((prev) => {
				const existing = prev.get(noteId);
				if (!existing) return prev;
				const nextValues = writeValue(existing.values, def, next);
				if (nextValues === existing.values) return prev;
				const updated: StoredNote = {
					...existing,
					values: nextValues,
					updatedAt: Date.now(),
				};
				const out = new Map(prev);
				out.set(noteId, updated);
				schedulePersist(updated, pendingRef.current, repoRef.current);
				return out;
			});
		},
		[],
	);

	const remove = useCallback(async (id: string) => {
		const repo = repoRef.current;
		if (!repo) return;
		try {
			await repo.remove(id);
		} catch (e) {
			console.error("[notes] delete failed:", e);
			setError(`Couldn't delete: ${(e as Error).message}`);
			return;
		}
		setNotes((prev) => {
			const next = new Map(prev);
			next.delete(id);
			return next;
		});
		setSelectedId((prev) => {
			if (prev !== id) return prev;
			// Move selection to most-recent remaining note.
			return null;
		});
	}, []);

	// Auto-discard a note created this session that the user opened and left
	// completely empty — no title, body, icon, cover or properties (Notion /
	// Apple-Notes behaviour, F-066). Scoped to session-created + still-empty
	// notes so it can never delete real content: the gated AutosavePlugin writes
	// the title/body mirrors only on real user input, so an empty mirror means
	// nothing was ever typed (no flush race). Pre-existing empty notes are left
	// alone — a deliberate non-deletion.
	const discardIfAbandoned = useCallback(
		(id: string | null) => {
			if (!shouldDiscardAbandoned(id, createdThisSessionRef.current, notesMapRef.current)) return;
			createdThisSessionRef.current.delete(id as string);
			void remove(id as string);
		},
		[remove],
	);

	// (a) Navigating away to another note.
	useEffect(() => {
		const prev = prevSelectedRef.current;
		prevSelectedRef.current = selectedId;
		if (prev === null || prev === selectedId) return;
		discardIfAbandoned(prev);
	}, [selectedId, discardIfAbandoned]);

	// (b) Leaving Notes entirely without first switching notes — closing/parking
	// the window or a hard page teardown. Without this, the (a) selection-change
	// path never fires and an abandoned blank piles up as an "Untitled" ghost in
	// the sidebar (F-196). Closing a window *parks* the renderer (hidden but
	// alive), so the async `remove` IPC still completes before unload.
	useEffect(() => {
		const onHide = (event: Event) => {
			if (event instanceof CustomEvent && (event.detail as { visible?: boolean })?.visible !== false) {
				return;
			}
			discardIfAbandoned(selectedIdRef.current);
		};
		window.addEventListener("brainstorm:app-visibility", onHide);
		window.addEventListener("pagehide", onHide);
		return () => {
			window.removeEventListener("brainstorm:app-visibility", onHide);
			window.removeEventListener("pagehide", onHide);
		};
	}, [discardIfAbandoned]);

	return { ready, error, notes, selectedId, select, openEntity, create, update, setValue, remove };
}

/** True when a note carries nothing the user authored — no title, no body
 *  snippet, no icon, no cover, no property values. The auto-discard (F-066)
 *  only ever removes a note that is this empty AND was created this session. */
export function isAbandonedEmpty(note: StoredNote): boolean {
	return (
		note.title.trim() === "" &&
		note.body.trim() === "" &&
		note.icon === null &&
		note.cover === null &&
		Object.keys(note.values).length === 0
	);
}

/** The shared discard decision behind both auto-discard triggers — navigating
 *  to another note (a) and leaving Notes entirely (b, F-196). A note is
 *  discarded only when it was created this session AND is still
 *  `isAbandonedEmpty`, so it can never remove pre-existing or authored content.
 *  Pure so the guard is unit-tested without rendering the hook. */
export function shouldDiscardAbandoned(
	id: string | null,
	sessionCreated: ReadonlySet<string>,
	notes: ReadonlyMap<string, StoredNote>,
): id is string {
	if (id === null || !sessionCreated.has(id)) return false;
	const note = notes.get(id);
	return note !== undefined && isAbandonedEmpty(note);
}

/** True when two note maps render the same sidebar — same ids in the same
 *  order, and the same per-row fields the list/header actually show. Lets a
 *  no-op `vaultEntities.onChange` refresh bail out of `setNotes` so the
 *  virtualised sidebar doesn't re-render (and scroll-jump) for nothing. */
/**
 * Merge in-memory note state OVER a fresh disk snapshot — the store's
 * `reconcile`, and the reason Notes could not use the shared reactivity stack
 * until that option existed (`equals` can suppress a render but cannot merge).
 *
 * Two things are pinned:
 *
 *  - **any note with a save still in flight.** The on-disk row is stale until
 *    our debounced persist lands, so adopting it would visibly revert the
 *    user's last keystrokes.
 *  - **the currently-open note, ALWAYS.** A refresh whose `listAll` snapshot
 *    momentarily misses the open note — a freshly-created sub-page racing the
 *    entities write, the background body migration, a sibling-app write —
 *    would otherwise drop it from the map, so `notes.get(selectedId)` goes
 *    null, the editor UNMOUNTS and remounts, the note "hides" from the
 *    sidebar, the title re-seeds and the selection resets. That was a reported
 *    sub-page bug; pinning the open note is its fix. Its canonical content
 *    still lives in the Y.Doc, and a later refresh after navigation re-adopts
 *    disk state.
 *
 * Returns `next` itself when nothing needed pinning, so the `equals`
 * short-circuit downstream still sees an unchanged snapshot.
 */
export function pinLocalNotes(
	prev: Map<string, StoredNote>,
	next: Map<string, StoredNote>,
	pendingIds: Iterable<string>,
	openId: string | null,
): Map<string, StoredNote> {
	const preserve = new Set(pendingIds);
	if (openId) preserve.add(openId);
	let merged: Map<string, StoredNote> | null = null;
	for (const id of preserve) {
		const optimistic = prev.get(id);
		if (!optimistic) continue;
		merged ??= new Map(next);
		merged.set(id, optimistic);
	}
	return merged ?? next;
}

function sidebarEquivalent(a: Map<string, StoredNote>, b: Map<string, StoredNote>): boolean {
	if (a === b) return true;
	if (a.size !== b.size) return false;
	// Compare by id (order-independent — the list re-sorts by recency). Only
	// the fields that drive the sort + visible row text; icon/cover are
	// re-parsed objects each `listAll` (reference-unstable) and only ever
	// change via the optimistic `update` path, never via this refresh.
	for (const [id, m] of a) {
		const n = b.get(id);
		if (!n || m.updatedAt !== n.updatedAt || m.title !== n.title || m.body !== n.body) {
			return false;
		}
	}
	return true;
}

const SAVE_DEBOUNCE_MS = 400;

function schedulePersist(
	note: StoredNote,
	pending: Map<string, ReturnType<typeof setTimeout>>,
	repo: NotesRepository | null,
) {
	if (!repo) return;
	const existing = pending.get(note.id);
	if (existing) clearTimeout(existing);
	// Keep the pending entry alive until the save IPC round-trip completes,
	// so the store's `reconcile` still sees the id as pending and correctly pins
	// the optimistic-state revert during the in-flight window (not just
	// during the debounce window). Deleting in the timeout body (before
	// awaiting `repo.save`) left a ~one-IPC-roundtrip gap where a refresh
	// could still adopt stale disk state.
	const handle = setTimeout(() => {
		void (async () => {
			try {
				await repo.save(note);
			} catch (e) {
				console.error("[notes] persist failed:", e);
			} finally {
				if (pending.get(note.id) === handle) pending.delete(note.id);
			}
		})();
	}, SAVE_DEBOUNCE_MS);
	pending.set(note.id, handle);
}
