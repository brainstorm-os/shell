import { describe, expect, it } from "vitest";
import {
	JOURNAL_ENTRY_TYPE,
	type VaultEntity,
	type VaultSnapshot,
	notesFromSnapshot,
} from "../runtime";
import {
	bodyWordCount,
	indexByDateKey,
	previewBodyText,
	projectJournalEntries,
	wordCount,
} from "./journal-projection";

describe("previewBodyText", () => {
	it("returns plain strings as-is", () => {
		expect(previewBodyText("hello world")).toBe("hello world");
	});

	it("flattens a Lexical-style nested body", () => {
		const body = {
			root: {
				type: "root",
				children: [
					{
						type: "paragraph",
						children: [
							{ type: "text", text: "First " },
							{ type: "text", text: "line." },
						],
					},
					{
						type: "paragraph",
						children: [{ type: "text", text: "Second line." }],
					},
				],
			},
		};
		expect(previewBodyText(body)).toBe("First  line. Second line.");
	});

	it("truncates with ellipsis past maxChars", () => {
		const long = "a".repeat(250);
		const out = previewBodyText(long, 50);
		expect(out).toMatch(/^a{49}…$/);
	});

	it("returns empty string for unknown body shapes", () => {
		expect(previewBodyText(null)).toBe("");
		expect(previewBodyText(undefined)).toBe("");
		expect(previewBodyText(42)).toBe("");
		expect(previewBodyText({})).toBe("");
	});
});

describe("wordCount", () => {
	it("returns 0 for empty / whitespace input", () => {
		expect(wordCount("")).toBe(0);
		expect(wordCount("   ")).toBe(0);
	});

	it("counts space-separated tokens", () => {
		expect(wordCount("hello world")).toBe(2);
		expect(wordCount("the quick brown fox")).toBe(4);
	});

	it("collapses repeated whitespace", () => {
		expect(wordCount("hello\n\n  world")).toBe(2);
	});
});

describe("bodyWordCount — counts the whole body, not the preview (F-012)", () => {
	it("counts every word past the 200-char preview cap", () => {
		// 60 words ≈ 300 chars — well past the preview's 200-char truncation,
		// where the old `wordCount(previewBodyText(body))` would cap out.
		const longText = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
		expect(longText.length).toBeGreaterThan(200);
		expect(bodyWordCount(longText)).toBe(60);
		// The preview path under-counts (the bug being fixed).
		expect(wordCount(previewBodyText(longText))).toBeLessThan(60);
	});

	it("walks a nested Lexical body", () => {
		const body = {
			root: {
				type: "root",
				children: [
					{ type: "paragraph", children: [{ type: "text", text: "one two three" }] },
					{ type: "paragraph", children: [{ type: "text", text: "four five" }] },
				],
			},
		};
		expect(bodyWordCount(body)).toBe(5);
	});

	it("is 0 for empty / unknown bodies", () => {
		expect(bodyWordCount("")).toBe(0);
		expect(bodyWordCount(null)).toBe(0);
		expect(bodyWordCount({})).toBe(0);
	});
});

describe("projectJournalEntries — word count source (F-012)", () => {
	it("prefers the persisted wordCount over recomputing from a clipped body", () => {
		// After a save, `note.body` is only the 120-char snippet — counting it
		// would cap the footer. The persisted full-body count must win.
		const clippedBody = "word ".repeat(20).trim(); // ~20 words in the snippet
		const out = projectJournalEntries([
			{ id: "n1", title: "2026-05-14", body: clippedBody, wordCount: 240 },
		]);
		expect(out[0]?.wordCount).toBe(240);
		expect(bodyWordCount(clippedBody)).toBeLessThan(240);
	});

	it("falls back to counting the full body when no count is persisted", () => {
		const fullBody = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
		const out = projectJournalEntries([{ id: "n1", title: "2026-05-14", body: fullBody }]);
		expect(out[0]?.wordCount).toBe(60);
	});
});

describe("projectJournalEntries", () => {
	it("filters notes whose title isn't a canonical ISO date", () => {
		const out = projectJournalEntries([
			{ id: "n1", title: "Random note" },
			{ id: "n2", title: "2026-05-14" },
			{ id: "n3", title: "2026-05-14 — gratitudes" },
		]);
		expect(out).toHaveLength(1);
		expect(out[0]?.noteId).toBe("n2");
	});

	it("sorts by date ascending", () => {
		const out = projectJournalEntries([
			{ id: "n1", title: "2026-05-14" },
			{ id: "n2", title: "2026-01-01" },
			{ id: "n3", title: "2026-03-15" },
		]);
		expect(out.map((e) => e.dateKey)).toEqual(["2026-01-01", "2026-03-15", "2026-05-14"]);
	});

	it("populates preview + wordCount from the body", () => {
		const out = projectJournalEntries([
			{ id: "n1", title: "2026-05-14", body: "It rained today and I felt calm." },
		]);
		expect(out[0]?.preview).toBe("It rained today and I felt calm.");
		expect(out[0]?.wordCount).toBe(7);
	});

	it("survives missing bodies", () => {
		const out = projectJournalEntries([{ id: "n1", title: "2026-05-14" }]);
		expect(out[0]?.preview).toBe("");
		expect(out[0]?.wordCount).toBe(0);
	});

	it("projects the note's OWN icon (per-object-icons-everywhere)", () => {
		const out = projectJournalEntries([
			{ id: "n1", title: "2026-05-14", icon: { kind: "emoji", value: "🌧️" } },
			{
				id: "n2",
				title: "2026-05-15",
				icon: { kind: "pack", value: "phosphor/cloud", color: "#39f" },
			},
			{ id: "n3", title: "2026-05-16" },
			{ id: "n4", title: "2026-05-17", icon: { kind: "bogus", value: "x" } },
			{ id: "n5", title: "2026-05-18", icon: "not-an-object" },
		]);
		const byId = new Map(out.map((e) => [e.noteId, e.icon]));
		expect(byId.get("n1")).toEqual({ kind: "emoji", value: "🌧️" });
		expect(byId.get("n2")).toEqual({ kind: "pack", value: "phosphor/cloud", color: "#39f" });
		// No icon / malformed icon → null (header shows the journal glyph).
		expect(byId.get("n3")).toBeNull();
		expect(byId.get("n4")).toBeNull();
		expect(byId.get("n5")).toBeNull();
	});

	it("uses local midnight for dateEpochMs", () => {
		const out = projectJournalEntries([{ id: "n1", title: "2026-05-14" }]);
		const first = out[0];
		if (!first) throw new Error("expected one entry");
		const d = new Date(first.dateEpochMs);
		expect(d.getFullYear()).toBe(2026);
		expect(d.getMonth()).toBe(4);
		expect(d.getDate()).toBe(14);
		expect(d.getHours()).toBe(0);
		expect(d.getMinutes()).toBe(0);
	});

	it("rejects out-of-range date strings (Feb 30 etc.)", () => {
		const out = projectJournalEntries([
			{ id: "n1", title: "2026-02-30" },
			{ id: "n2", title: "2026-13-01" },
			{ id: "n3", title: "2026-00-15" },
		]);
		expect(out).toHaveLength(0);
	});
});

describe("indexByDateKey", () => {
	it("indexes entries by dateKey for O(1) lookup", () => {
		const entries = projectJournalEntries([
			{ id: "n1", title: "2026-05-14" },
			{ id: "n2", title: "2026-05-15" },
		]);
		const idx = indexByDateKey(entries);
		expect(idx.get("2026-05-14")?.noteId).toBe("n1");
		expect(idx.get("2026-05-15")?.noteId).toBe("n2");
		expect(idx.get("2026-05-16")).toBeUndefined();
	});

	it("resolves a day with two rows to the earliest-created one, whatever the snapshot order", () => {
		const welcome = {
			id: "welcome-journal-day-one",
			title: "2026-10-19",
			body: "Your first journal entry.",
			createdAt: 100,
		};
		const minted = { id: "journal-2026-10-19", title: "2026-10-19", createdAt: 200 };
		expect(indexByDateKey(projectJournalEntries([minted, welcome])).get("2026-10-19")?.noteId).toBe(
			"welcome-journal-day-one",
		);
		expect(indexByDateKey(projectJournalEntries([welcome, minted])).get("2026-10-19")?.noteId).toBe(
			"welcome-journal-day-one",
		);
	});
});

// 9.3.5.7 — Journal renders REAL data. Journal entries are written to
// `entities.db` as their own object type (`io.brainstorm.journal/Entry/v1`,
// `properties.title` / `properties.body`) and surface through
// `vaultEntities.list()`. This locks the full pipeline an entities-store
// snapshot travels: notesFromSnapshot → projectJournalEntries →
// indexByDateKey. No demo, no kv.
describe("real entities.db snapshot → journal projection", () => {
	const entity = (over: Partial<VaultEntity>): VaultEntity => ({
		id: "e",
		type: JOURNAL_ENTRY_TYPE,
		properties: {},
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
		ownerAppId: "io.brainstorm.journal",
		...over,
	});

	it("projects a date-titled shared Note row (with body) into a dated entry", () => {
		const snapshot: VaultSnapshot = {
			entities: [
				entity({
					id: "note_journal_1",
					properties: {
						title: "2026-05-14",
						body: "Shipped the entities migration.",
						icon: { kind: "emoji", value: "🚀" },
					},
				}),
				// Non-date Note — excluded by the projection.
				entity({ id: "note_misc", properties: { title: "Grocery list" } }),
				// Soft-deleted date note — excluded by notesFromSnapshot.
				entity({
					id: "note_gone",
					properties: { title: "2026-05-15" },
					deletedAt: 123,
				}),
				// Different entity type — excluded by notesFromSnapshot.
				{
					id: "task_1",
					type: "brainstorm/Task/v1",
					properties: { title: "2026-05-16" },
					createdAt: 0,
					updatedAt: 0,
					deletedAt: null,
					ownerAppId: "io.brainstorm.tasks",
				},
				// A real Note with a date-shaped title — must NOT surface in the
				// journal now that journal entries are their own type.
				{
					id: "note_dateish",
					type: "io.brainstorm.notes/Note/v1",
					properties: { title: "2026-05-17" },
					createdAt: 0,
					updatedAt: 0,
					deletedAt: null,
					ownerAppId: "io.brainstorm.notes",
				},
			],
			links: [],
		};
		const entries = projectJournalEntries(notesFromSnapshot(snapshot));
		expect(entries).toHaveLength(1);
		const idx = indexByDateKey(entries);
		const day = idx.get("2026-05-14");
		expect(day?.noteId).toBe("note_journal_1");
		expect(day?.icon).toEqual({ kind: "emoji", value: "🚀" });
		expect(day?.preview).toBe("Shipped the entities migration.");
		expect(day?.wordCount).toBe(4);
		expect(idx.get("2026-05-15")).toBeUndefined();
		expect(idx.get("2026-05-16")).toBeUndefined();
		// The date-titled Note is a note, not a journal entry — excluded.
		expect(idx.get("2026-05-17")).toBeUndefined();
	});
});
