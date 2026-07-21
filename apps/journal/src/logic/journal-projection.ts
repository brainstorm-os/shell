/**
 * Project a vault-wide note list to the journal-entry projection.
 *
 * **Long-term keystone**: 9.16.2 swaps the input source (in-memory demo →
 * `services.vaultEntities.list` filtered to `Note/v1`) but the projection
 * stays. The Journal renderer only consumes `JournalEntry[]`; whoever
 * sources notes is replaceable.
 *
 * Filters notes whose title is a canonical ISO date (`YYYY-MM-DD`) and
 * sorts by date ascending. Body extraction is intentionally cheap —
 * the preview drop renders plain text; rich blocks land in 9.16.2 when
 * the editor mounts.
 */

import { parseIcon } from "@brainstorm-os/sdk/entity-icon";
import type { ValuesMap } from "@brainstorm-os/sdk/property-ui";
import type { JournalEntry } from "../types/entry";
import { parseHabits, parseMood } from "./check-in";
import { dateKeyForJournal, isJournalNoteTitle, parseJournalDateKey } from "./journal-keys";

/** Loose Note shape — anything with a title + a body string. Matches the
 *  StoredNote shape from the Notes app's storage layer; tests pass plain
 *  literals. `icon` is the loosely-typed `properties.icon` blob (the
 *  shared `parseIcon` validates it). */
export type NoteLike = {
	id: string;
	title: string;
	body?: unknown;
	icon?: unknown;
	/** Bound property values from `entity.properties.values`. Optional —
	 *  the demo dataset and tests can omit it. */
	values?: unknown;
	/** Denormalised word count over the WHOLE body, persisted by the editor
	 *  autosave (`buildJournalDenormalizer`). Authoritative when present —
	 *  `note.body` itself is only the clipped 120-char snippet after a save,
	 *  so recomputing from it would cap the count. Absent for never-edited
	 *  seed / demo entries, which still carry a full body to count. */
	wordCount?: number;
	/** Daily check-in (9.16.8) — `properties.mood` (a `MoodId` string) and
	 *  `properties.habits` (a `HabitId[]`). Loosely typed; the projection
	 *  validates both via the `check-in` guards. */
	mood?: unknown;
	habits?: unknown;
	/** Entity timestamps — used to render the properties panel's
	 *  Created / Updated block. Optional; the projection falls back to
	 *  the entry's own date when absent. */
	createdAt?: number;
	updatedAt?: number;
};

/** Extract a plain-text preview from a note body. Handles three body
 *  shapes:
 *   - plain string (preview drop dataset)
 *   - Lexical SerializedEditorState { root: { children: [...] } }
 *   - any other → empty string
 */
export function previewBodyText(body: unknown, maxChars = 200): string {
	const flat = flattenBody(body).trim();
	if (flat.length <= maxChars) return flat;
	return `${flat.slice(0, maxChars - 1).trimEnd()}…`;
}

// Cap walk depth for hostile / corrupted bodies — 64 is well past any
// plausible Lexical document.
const MAX_BODY_DEPTH = 64;

function flattenBody(body: unknown): string {
	if (typeof body === "string") return body;
	if (!body || typeof body !== "object") return "";
	const root = (body as { root?: unknown }).root;
	if (!root || typeof root !== "object") return "";
	const out: string[] = [];
	walk(root, out, 0);
	return out.join(" ");
}

function walk(node: unknown, out: string[], depth: number): void {
	if (depth > MAX_BODY_DEPTH) return;
	if (!node || typeof node !== "object") return;
	const n = node as { type?: unknown; text?: unknown; children?: unknown };
	if (typeof n.text === "string") {
		out.push(n.text);
		return;
	}
	if (Array.isArray(n.children)) {
		for (const child of n.children) walk(child, out, depth + 1);
	}
}

export function wordCount(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	return trimmed.split(/\s+/).length;
}

/** Word count over the *whole* body (F-012). Distinct from
 *  `wordCount(previewBodyText(body))`, which counted only the 200-char
 *  preview — so the footer/properties "N words" capped out and read far
 *  lower than the entry actually was. */
export function bodyWordCount(body: unknown): number {
	return wordCount(flattenBody(body));
}

/** Filter + project a list of vault notes into `JournalEntry` rows
 *  sorted by date ascending. Notes whose title is not a canonical ISO
 *  date are skipped (a user-titled `"2026-05-14 — gratitudes"` is NOT
 *  a journal entry — see `parseJournalDateKey` for the strict rule). */
export function projectJournalEntries(notes: readonly NoteLike[]): JournalEntry[] {
	const out: JournalEntry[] = [];
	for (const note of notes) {
		if (!isJournalNoteTitle(note.title)) continue;
		const epoch = parseJournalDateKey(note.title);
		if (epoch === null) continue;
		const preview = previewBodyText(note.body);
		out.push({
			noteId: note.id,
			icon: parseIcon(note.icon),
			dateEpochMs: epoch,
			dateKey: dateKeyForJournal(epoch),
			rawTitle: note.title,
			preview,
			// Prefer the persisted full-body count (written by autosave). Fall
			// back to counting `note.body` only for never-edited seed / demo
			// entries that still carry the whole body — after a save, body is
			// the clipped snippet and would under-count.
			wordCount: typeof note.wordCount === "number" ? note.wordCount : bodyWordCount(note.body),
			// Carry the raw body verbatim — the day-body editor needs it
			// to seed an empty Y.Doc on first open. We don't filter shape
			// here; the editor mount applies its own type guard before
			// planting (snippet strings + unknown shapes degrade safely
			// to a no-op).
			seedBody: note.body ?? null,
			values: parseValues(note.values),
			mood: parseMood(note.mood),
			habits: parseHabits(note.habits),
			createdAt: typeof note.createdAt === "number" ? note.createdAt : epoch,
			updatedAt: typeof note.updatedAt === "number" ? note.updatedAt : epoch,
		});
	}
	out.sort((a, b) => a.dateEpochMs - b.dateEpochMs);
	return out;
}

/** Index entries by date key for O(1) lookup from grid cells. */
export function indexByDateKey(entries: readonly JournalEntry[]): Map<string, JournalEntry> {
	const out = new Map<string, JournalEntry>();
	for (const e of entries) out.set(e.dateKey, e);
	return out;
}

/** Defensively parse `entity.properties.values` — the entities service
 *  returns whatever was persisted; a corrupted vault or a never-bound
 *  note legitimately has no `values` field. Anything that isn't a
 *  plain object reads as empty so the properties panel doesn't choke. */
function parseValues(raw: unknown): ValuesMap {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	return { ...(raw as ValuesMap) };
}
