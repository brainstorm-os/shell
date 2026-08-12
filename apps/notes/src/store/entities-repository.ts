/**
 * Notes repository over the **shared entities service** — the real
 * `entities.db`. Implements the `NotesRepository` contract `useNotes`
 * depends on.
 *
 * Id handling: Notes owns stable `n_…` ids that double as mention-edge
 * endpoints, so `save` is a get-then-create-or-update keyed on
 * `note.id`, and `create` passes the id through (the entities service
 * accepts a caller id — entity ids are local opaque strings).
 *
 * Body story: the rich-text `body` (+ `values`/`icon`/`title`/domain
 * timestamps) ride the **property bag** for this rung; the body→Y.Doc
 * move is the deliberately-last 9.3.5.N-notes.4. There are **no link
 * writes** — the entities service has no app link API; note→note edges
 * are derived shell-side from the body by `aggregateSharedEntities`
 * (9.3.5.N-notes.3a). The property shape mirrors what the shell
 * `note-entities-codec` reads, so Graph/Database render a note
 * identically whether it came from the kv bridge or a fresh write.
 *
 * Error contract matches the kv repo seam: `listAll` swallows → empty
 * map (bad boot still lets the user create); `save`/`remove` throw so
 * `useNotes` keeps its create/delete banner + silent autosave UX.
 */

import { entityTitleOr } from "@brainstorm-os/sdk/entity-title";
import { parseStoredNote, serializeNote } from "./codec";
import type { StoredNote } from "./note";
import type { NotesRepository } from "./repository";
import type { EntitiesService, EntityRecord } from "./runtime";

/** Mirrors the manifest registration + the shell `note-entities-codec`
 *  canonical value (protocol — kept in sync deliberately, like the
 *  mention walker duplication). */
export const NOTE_TYPE = "io.brainstorm.notes/Note/v1";

function logError(op: string, err: unknown): void {
	console.error(`[notes/entities-repo] ${op} failed:`, err);
}

// `id` is the entity id; everything else (incl. the app's domain
// createdAt/updatedAt) is the property bag. The entity's own
// store-managed timestamps are separate provenance and deliberately
// NOT used as the note timestamps — the store overwrites them on every
// write, which would lose e.g. a migrated note's original dates.
//
// `bodyLegacy` is stripped: it is a Notes-internal rollback target
// produced by `decodeBody` when an on-disk row carried a legacy
// `SerializedEditorState` shape, and the migration uses it as the
// planting source. Persisting it back into the SHARED entity property
// bag would make every subsequent read see BOTH a projection-supplied
// `body` (legacy obj from the kv backfill) AND a Notes-supplied
// `bodyLegacy` (same obj) → the codec's dual-body warning fires on
// every load (1980 hits in one session before this fix), and the body
// gets reset to "" in memory. The rollback target lives in the
// in-memory `StoredNote` only.
function noteToProps(note: StoredNote): Record<string, unknown> {
	const { id: _id, bodyLegacy: _bodyLegacy, ...props } = serializeNote(note);
	return props;
}

function entityToNote(e: EntityRecord): StoredNote | null {
	// Fall back to the entity ROW's createdAt/updatedAt when the property bag
	// lacks them (e.g. a sub-page created with just `{ title }`). Without this
	// `parseStoredNote` defaults a missing `updatedAt` to `Date.now()` —
	// RECOMPUTED on every parse — so the note's recency stamp changed on every
	// sidebar refresh and it churned around the list. Mirrors
	// `foreignEntityToNote` (the open path), which already did this; the two
	// disagreeing is what made the same note stable when open but jumpy in the
	// list.
	const props = e.properties as Record<string, unknown>;
	return parseStoredNote({
		...props,
		id: e.id,
		createdAt: typeof props.createdAt === "number" ? props.createdAt : e.createdAt,
		updatedAt: typeof props.updatedAt === "number" ? props.updatedAt : e.updatedAt,
	});
}

/**
 * Adapt **any** vault entity (not just `Note/v1`) into the editable
 * `StoredNote` shape so Notes can be the universal object editor (the
 * generic-fallback target — doc-31 §Resolution). The object's rich-text
 * `body` (universal-body design) loads into the editor; its display name
 * (`title`/`name`/`label`) seeds the TitleNode when there's no body yet;
 * any existing `values` bag drives the property panel. Round-trips
 * through `repo.save`, whose `entities.update` MERGES the patch — the
 * entity's own structured props (a Person's `email`, …) are preserved,
 * the entity `type` is untouched.
 */
export function foreignEntityToNote(e: EntityRecord): StoredNote {
	const props = e.properties as Record<string, unknown>;
	const title = entityTitleOr(props, "");
	// parseStoredNote can't return null here — `id` is a non-empty string.
	return parseStoredNote({
		...props,
		id: e.id,
		title,
		createdAt: typeof props.createdAt === "number" ? props.createdAt : e.createdAt,
		updatedAt: typeof props.updatedAt === "number" ? props.updatedAt : e.updatedAt,
	}) as StoredNote;
}

export function createEntitiesRepository(entities: EntitiesService): NotesRepository {
	return {
		async listAll() {
			const map = new Map<string, StoredNote>();
			let rows: EntityRecord[];
			try {
				rows = await entities.query({ type: NOTE_TYPE });
			} catch (err) {
				logError("listAll", err);
				return map;
			}
			for (const row of rows) {
				const note = entityToNote(row);
				if (note) map.set(note.id, note);
			}
			return map;
		},
		async save(note) {
			const props = noteToProps(note);
			const existing = await entities.get(note.id);
			if (existing) {
				await entities.update(note.id, props);
				return;
			}
			try {
				await entities.create(NOTE_TYPE, props, note.id);
			} catch (err) {
				// The id can already exist even though `get` returned
				// nothing — a prior session migrated it, or it was created
				// under a different type/owner the Notes view can't see
				// (the entities table keys ids globally). Treat the bridge
				// as the idempotent upsert its docstring promises rather
				// than flooding the console once per pre-migrated row.
				if (err instanceof Error && /already exists/.test(err.message)) {
					await entities.update(note.id, props);
					return;
				}
				throw err;
			}
		},
		async patchBody(id, body) {
			// Body-only patch — the shared entities service merges this
			// into the existing property bag, so a concurrent user edit
			// to `values` / `title` / `updatedAt` is preserved. Used by
			// the background body migration to avoid clobbering edits the
			// user made before the migration walked their note. A row
			// that's been removed mid-flight throws `Invalid` from the
			// service; swallow it (the migration is best-effort).
			try {
				await entities.update(id, { body });
			} catch (err) {
				if (err instanceof Error && err.name === "Invalid") return;
				throw err;
			}
		},
		async remove(id) {
			await entities.delete(id);
		},
	};
}
