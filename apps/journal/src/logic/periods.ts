/**
 * Periodic notes (9.16.4) — weekly + monthly rollup entries.
 *
 * A periodic note is a `JOURNAL_ENTRY_TYPE` entity like a daily entry, but
 * keyed by an ISO week (`2026-W20`) or month (`2026-05`) instead of a day,
 * with a stable id (`journal-week-2026-W20` / `journal-month-2026-05`). Its
 * body is seeded with auto-backlinks (`@`-mentions) to the constituent days
 * that already have entries — so the shell's reference walker wires the
 * rollup to each day (and each day's backlinks panel shows the rollup).
 *
 * Pure: key/range/constituent-day math + the seed-state builder. Week math
 * is ISO-8601 (weeks start Monday; week 1 holds the year's first Thursday).
 */

import { MENTION_NODE_TYPE } from "@brainstorm-os/sdk/note-references";
import type { SerializedEditorState } from "lexical";
import { JOURNAL_ENTRY_TYPE } from "../runtime";
import { dateKeyForJournal } from "./journal-keys";

export enum PeriodKind {
	Week = "week",
	Month = "month",
}

const DAY_MS = 86_400_000;

/** ISO-8601 week + week-year for a local date. */
function isoWeek(date: Date): { weekYear: number; week: number } {
	const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	const dayNum = d.getUTCDay() || 7; // Mon=1 … Sun=7
	d.setUTCDate(d.getUTCDate() + 4 - dayNum); // shift to the week's Thursday
	const weekYear = d.getUTCFullYear();
	const yearStart = Date.UTC(weekYear, 0, 1);
	const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
	return { weekYear, week };
}

/** `YYYY-Www` ISO week key for a date. */
export function isoWeekKeyOf(date: Date): string {
	const { weekYear, week } = isoWeek(date);
	return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

/** `YYYY-MM` month key for a date. */
export function monthKeyOf(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function periodKeyOf(kind: PeriodKind, date: Date): string {
	return kind === PeriodKind.Week ? isoWeekKeyOf(date) : monthKeyOf(date);
}

/** Stable entity id for a periodic note — distinct namespace from daily
 *  `journal-YYYY-MM-DD` ids so the two never collide. */
export function periodStableId(kind: PeriodKind, key: string): string {
	return `journal-${kind}-${key}`;
}

/** Monday (local midnight) of the ISO week containing `date`. */
function startOfIsoWeek(date: Date): Date {
	const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	const dayNum = d.getDay() || 7; // Mon=1 … Sun=7
	d.setDate(d.getDate() - (dayNum - 1));
	return d;
}

/** The period's [start, end] local-midnight bounds (end = last day). */
export function periodRange(kind: PeriodKind, date: Date): { start: Date; end: Date } {
	if (kind === PeriodKind.Week) {
		const start = startOfIsoWeek(date);
		const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
		return { start, end };
	}
	const start = new Date(date.getFullYear(), date.getMonth(), 1);
	const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
	return { start, end };
}

/** All `YYYY-MM-DD` day keys in the period, in chronological order. */
export function constituentDayKeys(kind: PeriodKind, date: Date): string[] {
	const { start, end } = periodRange(kind, date);
	const out: string[] = [];
	const cursor = new Date(start);
	while (cursor.getTime() <= end.getTime()) {
		out.push(dateKeyForJournal(cursor));
		cursor.setDate(cursor.getDate() + 1);
	}
	return out;
}

/** Human label for a periodic note, e.g. `"Week of May 11 – 17, 2026"` or
 *  `"May 2026"`. */
export function periodLabel(kind: PeriodKind, date: Date): string {
	if (kind === PeriodKind.Month) {
		return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
	}
	const { start, end } = periodRange(kind, date);
	const startStr = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	const endStr = end.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
	return `Week of ${startStr} – ${endStr}`;
}

const TEXT_NODE_BASE = { format: 0, version: 1, style: "", mode: "normal", detail: 0 } as const;
const BLOCK_NODE_BASE = { format: "", indent: 0, version: 1, direction: null } as const;
const MENTION_NODE_VERSION = 1;

export type PeriodicDayLink = { entityId: string; label: string };

/** Build the seed `SerializedEditorState` for a fresh periodic note: a
 *  heading with the period label, a paragraph of `@`-mentions to each
 *  constituent day that has an entry (the auto-backlinks), and an empty
 *  paragraph to write the review into. With no day links, just the heading
 *  + a writing paragraph. */
export function buildPeriodicSeedState(
	label: string,
	dayLinks: readonly PeriodicDayLink[],
): SerializedEditorState {
	const children: unknown[] = [
		{
			type: "heading",
			tag: "h2",
			children: [{ type: "text", text: label, ...TEXT_NODE_BASE }],
			...BLOCK_NODE_BASE,
		},
	];
	for (const day of dayLinks) {
		children.push({
			type: "paragraph",
			children: [
				{
					type: MENTION_NODE_TYPE,
					version: MENTION_NODE_VERSION,
					entityId: day.entityId,
					entityType: JOURNAL_ENTRY_TYPE,
					label: day.label,
				},
			],
			...BLOCK_NODE_BASE,
		});
	}
	children.push({ type: "paragraph", children: [], ...BLOCK_NODE_BASE });
	return {
		root: { type: "root", children, ...BLOCK_NODE_BASE },
	} as unknown as SerializedEditorState;
}
