/**
 * Journal "today-journal" dashboard widget — pure data-shaping coverage.
 * `shapeJournalWidget` is the widget's only non-presentational logic; the
 * component shell mirrors the real-shell-verified Contacts widget.
 */

import { describe, expect, it } from "vitest";
import { dateKeyForJournal } from "./logic/journal-keys";
import { JOURNAL_ENTRY_TYPE } from "./runtime";
import {
	PREVIOUS_LIMIT,
	type WidgetJournalEntity,
	dateLabelForKey,
	shapeJournalWidget,
} from "./widget-data";

/** A fixed "now" well away from any DST edge: local noon. */
const NOW = new Date(2026, 5, 20, 12, 0, 0, 0);
const TODAY_KEY = dateKeyForJournal(NOW);

/** The `YYYY-MM-DD` key `offset` days before NOW (noon-anchored, DST-safe). */
function dayKey(offset: number): string {
	return dateKeyForJournal(new Date(NOW.getTime() - offset * 86_400_000));
}

function entry(
	dateKey: string,
	body: unknown,
	overrides: Partial<WidgetJournalEntity> = {},
): WidgetJournalEntity {
	return {
		id: `journal-${dateKey}`,
		type: JOURNAL_ENTRY_TYPE,
		properties: { title: dateKey, body },
		deletedAt: null,
		...overrides,
	};
}

describe("shapeJournalWidget", () => {
	it("counts a streak through today", () => {
		const entities = [
			entry(dayKey(0), "today"),
			entry(dayKey(1), "yesterday"),
			entry(dayKey(2), "before"),
		];
		const { streak, today } = shapeJournalWidget(entities, NOW);
		expect(streak).toBe(3);
		expect(today?.dateKey).toBe(TODAY_KEY);
	});

	it("preserves the streak when today is still unwritten", () => {
		const entities = [entry(dayKey(1), "yesterday"), entry(dayKey(2), "before")];
		const { streak, today } = shapeJournalWidget(entities, NOW);
		expect(streak).toBe(2);
		expect(today).toBeNull();
	});

	it("breaks the streak on a gap", () => {
		const entities = [entry(dayKey(0), "today"), entry(dayKey(2), "skipped a day")];
		expect(shapeJournalWidget(entities, NOW).streak).toBe(1);
	});

	it("reads 0 for an empty vault", () => {
		const model = shapeJournalWidget([], NOW);
		expect(model.streak).toBe(0);
		expect(model.today).toBeNull();
		expect(model.previous).toEqual([]);
	});

	it("ignores entries with empty bodies — for the streak and for rows", () => {
		const entities = [
			entry(dayKey(0), "   "),
			entry(dayKey(1), "yesterday"),
			entry(dayKey(2), ""),
			entry(dayKey(3), "counts"),
		];
		const model = shapeJournalWidget(entities, NOW);
		// Today is blank → the streak is the run ending yesterday; day-2's empty
		// body breaks it there.
		expect(model.streak).toBe(1);
		expect(model.today).toBeNull();
		expect(model.previous.map((r) => r.dateKey)).toEqual([dayKey(1), dayKey(3)]);
	});

	it("lists previous written days newest-first, capped, excluding today", () => {
		const entities = Array.from({ length: 7 }, (_, i) => entry(dayKey(i), `entry ${i}`));
		const model = shapeJournalWidget(entities, NOW);
		expect(model.today?.snippet).toBe("entry 0");
		expect(model.previous).toHaveLength(PREVIOUS_LIMIT);
		expect(model.previous.map((r) => r.dateKey)).toEqual([
			dayKey(1),
			dayKey(2),
			dayKey(3),
			dayKey(4),
		]);
	});

	it("skips deleted rows, foreign types, and non-canonical titles", () => {
		const entities = [
			entry(dayKey(1), "kept"),
			entry(dayKey(2), "deleted", { deletedAt: 123 }),
			entry(dayKey(3), "wrong type", { type: "io.brainstorm.notes/Note/v1" }),
			{
				...entry(dayKey(4), "dated note"),
				properties: { title: `${dayKey(4)} — gratitudes`, body: "x" },
			},
		];
		const model = shapeJournalWidget(entities, NOW);
		expect(model.previous.map((r) => r.dateKey)).toEqual([dayKey(1)]);
		// Yesterday is the only written day → a still-extendable 1-day run.
		expect(model.streak).toBe(1);
	});

	it("flattens a Lexical body into the snippet", () => {
		const body = {
			root: { children: [{ children: [{ text: "Deep work" }, { text: "morning" }] }] },
		};
		const model = shapeJournalWidget([entry(dayKey(0), body)], NOW);
		expect(model.today?.snippet).toBe("Deep work morning");
		expect(model.streak).toBe(1);
	});
});

describe("dateLabelForKey", () => {
	it("localizes a canonical key to a short date", () => {
		const label = dateLabelForKey(dayKey(1));
		expect(label.length).toBeGreaterThan(0);
		expect(label).not.toBe(dayKey(1));
	});

	it("falls back to the raw string for a malformed key", () => {
		expect(dateLabelForKey("not-a-date")).toBe("not-a-date");
	});
});
