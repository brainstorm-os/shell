import { describe, expect, it, vi } from "vitest";
import { JOURNAL_ENTRY_TYPE, type VaultEntity } from "../runtime";
import type { JournalEntry } from "../types/entry";
import { dateMsForEntryId, dayEntityIdFromRows, ensureDayEntry, pickDayEntry } from "./day-entry";
import { parseJournalDateKey } from "./journal-keys";

const DAY = "2026-10-19";
const WELCOME_ID = "welcome-journal-day-one";
const STABLE_ID = `journal-${DAY}`;

function entry(over: Partial<JournalEntry> & { noteId: string }): JournalEntry {
	return {
		icon: null,
		dateEpochMs: parseJournalDateKey(DAY) ?? 0,
		dateKey: DAY,
		rawTitle: DAY,
		preview: "",
		wordCount: 0,
		seedBody: null,
		values: {},
		mood: null,
		habits: [],
		createdAt: 1,
		updatedAt: 1,
		...over,
	};
}

function row(over: Partial<VaultEntity> & { id: string }): VaultEntity {
	return {
		type: JOURNAL_ENTRY_TYPE,
		properties: { title: DAY },
		createdAt: 1,
		updatedAt: 1,
		deletedAt: null,
		ownerAppId: "io.brainstorm.journal",
		...over,
	};
}

describe("pickDayEntry", () => {
	it("picks the earliest-created entry for a day whatever the list order", () => {
		const welcome = entry({ noteId: WELCOME_ID, createdAt: 100 });
		const minted = entry({ noteId: STABLE_ID, createdAt: 200 });
		expect(pickDayEntry([minted, welcome], DAY)?.noteId).toBe(WELCOME_ID);
		expect(pickDayEntry([welcome, minted], DAY)?.noteId).toBe(WELCOME_ID);
	});

	it("breaks a created-at tie by id so two devices agree", () => {
		const a = entry({ noteId: "journal-b", createdAt: 5 });
		const b = entry({ noteId: "journal-a", createdAt: 5 });
		expect(pickDayEntry([a, b], DAY)?.noteId).toBe("journal-a");
	});

	it("ignores other days and returns null for an unwritten day", () => {
		const other = entry({ noteId: "journal-2026-10-18", dateKey: "2026-10-18" });
		expect(pickDayEntry([other], DAY)).toBeNull();
	});
});

describe("dayEntityIdFromRows", () => {
	it("finds the live journal row titled with the day, earliest created first", () => {
		const rows = [
			row({ id: STABLE_ID, createdAt: 200 }),
			row({ id: WELCOME_ID, createdAt: 100 }),
			row({ id: "note-1", type: "io.brainstorm.notes/Note/v1", createdAt: 1 }),
			row({ id: "binned", createdAt: 1, deletedAt: 5 }),
			row({ id: "journal-2026-10-18", properties: { title: "2026-10-18" }, createdAt: 1 }),
		];
		expect(dayEntityIdFromRows(rows, DAY)).toBe(WELCOME_ID);
		expect(dayEntityIdFromRows(rows, "2026-10-20")).toBeNull();
	});
});

describe("ensureDayEntry", () => {
	it("returns the entry the list already shows without touching the vault", async () => {
		const listRows = vi.fn();
		const create = vi.fn();
		const existing = entry({ noteId: WELCOME_ID });
		await expect(
			ensureDayEntry({ dateKey: DAY, existing, stableId: STABLE_ID, listRows, create }),
		).resolves.toEqual({ noteId: WELCOME_ID, created: false, row: null });
		expect(listRows).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});

	it("reuses a same-day row the snapshot has not delivered yet instead of minting a second one", async () => {
		const listRows = vi.fn(async () => [row({ id: WELCOME_ID, createdAt: 100 })]);
		const create = vi.fn();
		const result = await ensureDayEntry({
			dateKey: DAY,
			existing: null,
			stableId: STABLE_ID,
			listRows,
			create,
		});
		expect(result?.noteId).toBe(WELCOME_ID);
		expect(result?.created).toBe(false);
		expect(result?.row?.id).toBe(WELCOME_ID);
		expect(create).not.toHaveBeenCalled();
	});

	it("mints the deterministic id only when the day truly has no entry", async () => {
		const listRows = vi.fn(async () => [] as VaultEntity[]);
		const create = vi.fn(async () => undefined);
		const result = await ensureDayEntry({
			dateKey: DAY,
			existing: null,
			stableId: STABLE_ID,
			listRows,
			create,
		});
		expect(create).toHaveBeenCalledWith(STABLE_ID);
		expect(result).toEqual({ noteId: STABLE_ID, created: true, row: null });
	});

	it("treats an already-exists rejection as the entry being there", async () => {
		const create = vi.fn(async () => {
			throw new Error("entity already exists");
		});
		const result = await ensureDayEntry({
			dateKey: DAY,
			existing: null,
			stableId: STABLE_ID,
			listRows: async () => [],
			create,
		});
		expect(result?.noteId).toBe(STABLE_ID);
	});

	it("gives up on any other create failure or a failed authoritative read", async () => {
		await expect(
			ensureDayEntry({
				dateKey: DAY,
				existing: null,
				stableId: STABLE_ID,
				listRows: async () => [],
				create: async () => {
					throw new Error("capability denied");
				},
			}),
		).resolves.toBeNull();
		const create = vi.fn();
		await expect(
			ensureDayEntry({
				dateKey: DAY,
				existing: null,
				stableId: STABLE_ID,
				listRows: async () => {
					throw new Error("worker gone");
				},
				create,
			}),
		).resolves.toBeNull();
		expect(create).not.toHaveBeenCalled();
	});
});

describe("dateMsForEntryId", () => {
	it("decodes a deterministic id without the entry list", () => {
		expect(dateMsForEntryId(STABLE_ID, [])).toBe(parseJournalDateKey(DAY));
	});

	it("resolves a seeded (non-deterministic) id through the loaded entries", () => {
		expect(dateMsForEntryId(WELCOME_ID, [entry({ noteId: WELCOME_ID })])).toBe(
			parseJournalDateKey(DAY),
		);
		expect(dateMsForEntryId("unknown", [])).toBeNull();
	});
});
