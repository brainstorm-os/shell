import type { Cover, Icon } from "@brainstorm-os/sdk-types";
import { IconKind } from "@brainstorm-os/sdk-types";
import { parseCover } from "@brainstorm-os/sdk/entity-cover";
import type { NoteReference } from "@brainstorm-os/sdk/note-references";
import { type ValuesMap, migrateValuesField } from "@brainstorm-os/sdk/property-ui/pure";
import type { SerializedEditorState } from "lexical";

/** What we store under `note:<id>` in `storage.kv`. v1 — single blob per
 *  note; migrates to one-entity-per-block at Stage 9 (see
 * ). */
export type StoredNote = {
	id: string;
	title: string;
	icon: Icon | null;
	/** The note's OWN cover (`properties.cover`), per the universal
	 *  object-cover model (B7). `null` reads as "no explicit cover" —
	 *  the renderer falls back to the id-seeded gradient. */
	cover: Cover | null;
	/** Denormalised plain-text snippet (or empty string for a never-edited
	 *  note). After 9.3.5.N4 the body of record lives in the Y.Doc's
	 *  universal-body root; this field is a length-capped plain-text mirror
	 *  the sidebar list cards + local-search fallback read without
	 *  resolving the doc. Legacy pre-N2 `SerializedEditorState` payloads
	 *  are migrated on vault open (see `migrate-body.ts`); the pre-migration
	 *  blob is preserved under `bodyLegacy` until the 10.8 sweep purges it. */
	body: string;
	/** Reversibility escape-hatch written by the 9.3.5.N4 migration when a
	 *  legacy `SerializedEditorState` body is planted into the Y.Doc. The
	 *  raw pre-migration blob (a `SerializedEditorState` or a freeform
	 *  legacy string) is retained verbatim so a misplant can be hand-
	 *  rolled back by copying `bodyLegacy` back into `body` and clearing
	 *  the vault-level migration version stamp. Tagged for purge in the
	 *  v1.0 vault-format freeze (plan iteration 10.8). */
	bodyLegacy?: SerializedEditorState | string;
	/** Per-note property values. Keyed by `PropertyDef.key`. Pre-B5.3
	 *  notes had no field; `migrateValuesField` defaults it to `{}` on
	 *  load so cells never see `undefined`. */
	values: ValuesMap;
	/** Body cross-references (`@`-mentions, transclusions, embeds, inline
	 *  links) extracted from the live `SerializedEditorState` at autosave and
	 *  persisted to `properties.bodyRefs`. The denormalised `body` snippet has
	 *  no rich nodes, so this is what lets the shell project note→note graph
	 *  edges (F-067). Absent on never-edited / legacy rows. */
	bodyRefs?: readonly NoteReference[];
	/** Page-level read-only lock (B11.11). A vault-wide, SYNCED boolean
	 *  (`properties.locked`) — not per-device chrome — so locking a note on
	 *  one device/user surfaces it locked everywhere. Advisory: the lock
	 *  gates the in-app editor surface, it is not an access-control boundary
	 *  (any collaborator can toggle it). Absent / `false` reads as unlocked. */
	locked?: boolean;
	createdAt: number;
	updatedAt: number;
};

/** Read an icon from a stored note, normalising legacy shapes. Older
 *  notes wrote `icon` as a raw emoji string before the universal Icon
 *  model landed — wrap those in the Emoji variant on read. */
export function readIcon(raw: unknown): Icon | null {
	if (!raw) return null;
	if (typeof raw === "string") return { kind: IconKind.Emoji, value: raw };
	if (typeof raw !== "object") return null;
	const obj = raw as { kind?: unknown; value?: unknown; color?: unknown };
	if (typeof obj.kind !== "string" || typeof obj.value !== "string") return null;
	switch (obj.kind) {
		case IconKind.Emoji:
			return { kind: IconKind.Emoji, value: obj.value };
		case IconKind.Pack:
			return {
				kind: IconKind.Pack,
				value: obj.value,
				...(typeof obj.color === "string" ? { color: obj.color } : {}),
			};
		case IconKind.Image:
			return { kind: IconKind.Image, value: obj.value };
		default:
			return null;
	}
}

/** Read a cover from a stored note. Delegates to the SDK's `parseCover`
 *  (the one validator: Image/Gradient/Color + focal clamp); legacy notes
 *  have no `cover` field → `null`. */
export function readCover(raw: unknown): Cover | null {
	return parseCover(raw);
}

export const NOTE_KEY_PREFIX = "note:";
export const SAVE_DEBOUNCE_MS = 500;

export function newNoteId(): string {
	const t = Date.now().toString(36);
	const r = Math.random().toString(36).slice(2, 8);
	return `n_${t}_${r}`;
}
