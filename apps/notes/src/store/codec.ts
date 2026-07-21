/**
 * Notes storage codec — the persisted-blob ⇄ `StoredNote` boundary.
 * One `note:<id>` key per note (see ./note.ts). The blob *is* the
 * `StoredNote` shape, so serialize is identity; parse is where the
 * read-time migrations live (legacy icon shapes, pre-B5.3 missing
 * `values`, post-N4 body↔snippet narrowing). Lifting this out of
 * `useNotes` (9.3.5.N-notes.2) gives the repository seam a single
 * mapping point — the entities-service-backed repo (9.3.5.N-notes.3)
 * reuses it verbatim so kv and shared-store rows decode identically.
 *
 * Body shape (post-N4): `body` is a denormalised plain-text snippet
 * string. Disk rows pre-N4 may still carry a legacy
 * `SerializedEditorState` object under `body`; the codec keeps that
 * object in-memory under `bodyLegacy` (so the vault-open migration
 * sees it and can plant it into the universal-body Y.Doc root) and
 * leaves `body` as the empty string until the migration computes the
 * real snippet. A row whose `bodyLegacy` survives a migration sweep
 * is the rollback escape-hatch (see `migrate-body.ts` §Reversibility).
 */

import { coerceNoteReferences } from "@brainstorm-os/sdk/note-references";
import { migrateValuesField } from "@brainstorm-os/sdk/property-ui/pure";
import type { SerializedEditorState } from "lexical";
import { NOTE_KEY_PREFIX, type StoredNote, readCover, readIcon } from "./note";

export function noteKey(id: string): string {
	return NOTE_KEY_PREFIX + id;
}

/** Decode a persisted note blob, applying read-time migrations.
 *  Returns `null` for a row with no string `id` (skip, don't throw —
 *  a single corrupt row must not blank the vault). */
export function parseStoredNote(value: unknown): StoredNote | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Partial<StoredNote> & {
		icon?: unknown;
		cover?: unknown;
		values?: unknown;
		body?: unknown;
		bodyLegacy?: unknown;
	};
	if (typeof raw.id !== "string") return null;
	const storedTitle = typeof raw.title === "string" ? raw.title : "";
	const { body, bodyLegacy } = decodeBody(raw.body, raw.bodyLegacy);
	const note: StoredNote = {
		id: raw.id,
		title: storedTitle,
		icon: readIcon(raw.icon),
		cover: readCover(raw.cover),
		body,
		values: migrateValuesField(raw.values),
		createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
		updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
	};
	if (bodyLegacy !== undefined) note.bodyLegacy = bodyLegacy;
	const bodyRefs = coerceNoteReferences((raw as { bodyRefs?: unknown }).bodyRefs);
	if (bodyRefs) note.bodyRefs = bodyRefs;
	if ((raw as { locked?: unknown }).locked === true) note.locked = true;
	return note;
}

/** The blob written under `noteKey(note.id)`. Identity today — kept as
 *  a named seam so the entities-backed repo can diverge (property bag
 *  vs entity-level fields) without touching call sites. */
export function serializeNote(note: StoredNote): StoredNote {
	return note;
}

/** Pre-N2 rows wrote the body as a `SerializedEditorState` object; N2
 *  kept the field as a denormalised snippet but tolerated the legacy
 *  object until N4. Here we normalise: an object body is preserved
 *  verbatim as `bodyLegacy` (the migration uses it as its planting
 *  source) and `body` is reset to the empty string (the migration fills
 *  in the real snippet from the planted Y.Doc). A non-object body is
 *  already a snippet string. An explicit `bodyLegacy` already on disk
 *  (a previously-migrated row) wins — never overwrite a legacy snapshot
 *  the user might want to roll back to. */
function decodeBody(
	body: unknown,
	bodyLegacy: unknown,
): { body: string; bodyLegacy?: SerializedEditorState | string } {
	const legacy = pickLegacy(bodyLegacy);
	if (typeof body === "string") {
		return legacy === undefined ? { body } : { body, bodyLegacy: legacy };
	}
	if (isLegacyEditorStateLike(body)) {
		if (legacy !== undefined) {
			// Both an on-disk `body` AND a `bodyLegacy` exist. The existing
			// `bodyLegacy` wins (it's the user-recoverable rollback target;
			// overwriting it would discard pre-migration state the user
			// might still need). The on-disk `body` is also a legacy blob
			// and is therefore unrecoverable through this row — log loudly
			// so a future investigation can see the conflict, then prefer
			// the rollback target. The migration itself can't produce this
			// state; reaching it means hand-edited / corrupt rows.
			console.warn(
				"[notes/codec] note row carries both `body` (legacy shape) and `bodyLegacy`; the on-disk legacy `body` will be dropped in favour of the existing `bodyLegacy` rollback target",
			);
			return { body: "", bodyLegacy: legacy };
		}
		return { body: "", bodyLegacy: body as SerializedEditorState };
	}
	return legacy === undefined ? { body: "" } : { body: "", bodyLegacy: legacy };
}

function pickLegacy(value: unknown): SerializedEditorState | string | undefined {
	if (typeof value === "string") return value;
	if (isLegacyEditorStateLike(value)) return value as SerializedEditorState;
	return undefined;
}

function isLegacyEditorStateLike(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const root = (value as { root?: unknown }).root;
	if (!root || typeof root !== "object") return false;
	const r = root as { type?: unknown; children?: unknown };
	return r.type === "root" && Array.isArray(r.children);
}
