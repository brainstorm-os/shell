/**
 * One entry per day — the single resolution rule every Journal path shares.
 *
 * A day can hold more than one `Entry/v1` row: the welcome seed writes its
 * entry under its own id, a sync can land a peer's `journal-<key>` row beside
 * a local one, and until this module existed the autofocus-on-open create
 * raced the first vault snapshot and minted a second row for today. The list,
 * the open-today path and quick capture must all land on the SAME row, so the
 * pick is deterministic (earliest created, then id) rather than snapshot order,
 * and a create first asks the vault itself — the live snapshot can still be the
 * empty initial one when the editor focuses on open.
 */

import { JOURNAL_ENTRY_TYPE, type VaultEntity } from "../runtime";
import type { JournalEntry } from "../types/entry";
import { journalEntryIdToDateMs } from "./journal-keys";

type DayRow = { noteId: string; createdAt: number };

/** Earliest created wins; the id breaks a tie so two devices agree. */
export function compareDayRows(a: DayRow, b: DayRow): number {
	if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
	return a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0;
}

export function pickDayEntry(
	entries: readonly JournalEntry[],
	dateKey: string,
): JournalEntry | null {
	let best: JournalEntry | null = null;
	for (const entry of entries) {
		if (entry.dateKey !== dateKey) continue;
		if (!best || compareDayRows(entry, best) < 0) best = entry;
	}
	return best;
}

function liveDayRows(rows: readonly VaultEntity[], dateKey: string): VaultEntity[] {
	return rows.filter(
		(row) =>
			row.type === JOURNAL_ENTRY_TYPE && row.deletedAt === null && row.properties.title === dateKey,
	);
}

/** The authoritative answer over raw vault rows — same rule as `pickDayEntry`. */
export function dayEntityIdFromRows(rows: readonly VaultEntity[], dateKey: string): string | null {
	let best: VaultEntity | null = null;
	for (const row of liveDayRows(rows, dateKey)) {
		const candidate = { noteId: row.id, createdAt: row.createdAt };
		if (!best || compareDayRows(candidate, { noteId: best.id, createdAt: best.createdAt }) < 0) {
			best = row;
		}
	}
	return best?.id ?? null;
}

export type EnsureDayEntryInput = {
	dateKey: string;
	/** What the live list already resolves the day to. */
	existing: JournalEntry | null;
	/** The deterministic id a brand-new day is minted under. */
	stableId: string;
	/** Read the vault's journal rows — the authoritative check before a mint. */
	listRows: () => Promise<readonly VaultEntity[]>;
	/** Create the entry under `stableId`; an "already exists" rejection counts
	 *  as success. */
	create: (stableId: string) => Promise<void>;
};

export type EnsureDayEntryResult = {
	noteId: string;
	created: boolean;
	/** The vault row when the day was found there but not yet in the live
	 *  list — the caller shows it optimistically until the snapshot catches up. */
	row: VaultEntity | null;
};

export async function ensureDayEntry(
	input: EnsureDayEntryInput,
): Promise<EnsureDayEntryResult | null> {
	if (input.existing) return { noteId: input.existing.noteId, created: false, row: null };

	let rows: readonly VaultEntity[];
	try {
		rows = await input.listRows();
	} catch (error) {
		console.warn("[journal] vaultEntities.list failed before a day create:", error);
		return null;
	}
	const found = dayEntityIdFromRows(rows, input.dateKey);
	if (found) return { noteId: found, created: false, row: rows.find((r) => r.id === found) ?? null };

	try {
		await input.create(input.stableId);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (!/already exists/i.test(msg)) {
			console.warn("[journal] entities.create failed:", error);
			return null;
		}
	}
	return { noteId: input.stableId, created: true, row: null };
}

/** The local-midnight anchor an entry id opens on: decoded from a
 *  deterministic `journal-<key>` id, else looked up in the loaded entries (a
 *  seeded entry carries its own id). */
export function dateMsForEntryId(
	entityId: string,
	entries: readonly JournalEntry[],
): number | null {
	const decoded = journalEntryIdToDateMs(entityId);
	if (decoded !== null) return decoded;
	return entries.find((entry) => entry.noteId === entityId)?.dateEpochMs ?? null;
}
