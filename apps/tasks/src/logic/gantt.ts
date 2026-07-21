/**
 * Timeline / Gantt compiler (9.14.11) — pure layout model for the timeline
 * view: one lane per task, a day-quantized bar per task, and dependency
 * edges between visible bars.
 *
 * Day quantization: `scheduledAt` is a calendar-date planning field and
 * `dueAt` a deadline, so bars snap to whole local days. An estimate
 * (`estimateMinutes`, 9.14.13) stretches a bar only past the one-day
 * minimum (a 2h task still paints one day; a 3-day estimate paints three).
 * All span boundaries are exact local day-starts produced by the same
 * `nextDayStart` walk the renderer iterates with, so positions stay exact
 * across DST (a fixed 24h step would drift on 23/25-hour days).
 *
 * Span derivation per task:
 *   - scheduled + due  → bar from the scheduled day through the due day.
 *   - scheduled only   → bar from the scheduled day, estimate-long.
 *   - due only         → bar ENDING on the due day, estimate-long, with
 *                        `derivedStart` marking the inferred start.
 *   - neither          → unscheduled; counted, not drawn.
 */

import { addDays as addDaysSdk, startOfDay } from "@brainstorm-os/sdk/date-grid";
import type { Task } from "../types/task";
import { topLevelTasks } from "./subtask-tree";
import { indexById, isBlocked } from "./task-dependencies";

/** The local day-start containing `ms` — the shared `@brainstorm-os/sdk/date-grid`
 *  `startOfDay` (the ONE day-walk Calendar / Database / Journal use; a
 *  DST fix there reaches the Gantt too). Re-exported under the Gantt's
 *  vocabulary so the view + tests speak one dialect. */
export function dayStart(ms: number): number {
	return startOfDay(ms);
}

/** The day-start immediately after the day-start `dayMs`. */
export function nextDayStart(dayMs: number): number {
	return addDaysSdk(dayMs, 1);
}

/** The day-start immediately before the day-start `dayMs`. */
export function prevDayStart(dayMs: number): number {
	return addDaysSdk(dayMs, -1);
}

/** `days` day-starts after the day-start `dayMs` (O(1), DST-safe —
 *  `setDate`-based in the SDK). */
export function addDays(dayMs: number, days: number): number {
	return addDaysSdk(dayMs, days);
}

/** Whole days an estimate stretches a bar to — sub-day estimates keep the
 *  one-day minimum; only multi-day effort (>24h) widens the bar. */
export function estimateDays(estimateMinutes: number | undefined): number {
	if (estimateMinutes === undefined || !Number.isFinite(estimateMinutes)) return 1;
	if (estimateMinutes <= 0) return 1;
	return Math.max(1, Math.ceil(estimateMinutes / (24 * 60)));
}

export type GanttSpan = {
	/** Inclusive bar start — an exact local day-start. */
	startMs: number;
	/** Exclusive bar end — the day-start AFTER the last painted day. */
	endMs: number;
	/** True when the start was inferred (due-only task) rather than planned. */
	derivedStart: boolean;
};

/** A task's day-quantized bar, or null when it carries no date at all. */
export function ganttSpan(task: Task): GanttSpan | null {
	const days = estimateDays(task.estimateMinutes);
	if (task.scheduledAt !== null) {
		const start = dayStart(task.scheduledAt);
		if (task.dueAt !== null) {
			// Through the due day; a due date before the scheduled day still
			// paints the scheduled day (data is contradictory, not the view).
			const end = Math.max(nextDayStart(dayStart(task.dueAt)), nextDayStart(start));
			return { startMs: start, endMs: end, derivedStart: false };
		}
		return { startMs: start, endMs: addDays(start, days), derivedStart: false };
	}
	if (task.dueAt !== null) {
		const end = nextDayStart(dayStart(task.dueAt));
		return { startMs: addDaysSdk(end, -days), endMs: end, derivedStart: true };
	}
	return null;
}

export type GanttRow = {
	task: Task;
	span: GanttSpan;
	/** At least one open dependency (9.14.8) — the bar renders blocked. */
	blocked: boolean;
};

/** A dependency edge between two visible lanes: `fromIndex`'s task must
 *  complete before `toIndex`'s starts. */
export type GanttEdge = {
	fromIndex: number;
	toIndex: number;
};

export type GanttModel = {
	rows: GanttRow[];
	edges: GanttEdge[];
	/** Padded, day-aligned viewport range (start inclusive, end exclusive).
	 *  Always contains today so the today line is on screen. */
	rangeStartMs: number;
	rangeEndMs: number;
	/** Top-level tasks carrying no date — listed in the footer note. */
	unscheduledCount: number;
};

/** Lanes sort by start, then end, then creation — a stable chronology so
 *  dependency edges mostly flow downward. */
function byChronology(a: GanttRow, b: GanttRow): number {
	if (a.span.startMs !== b.span.startMs) return a.span.startMs - b.span.startMs;
	if (a.span.endMs !== b.span.endMs) return a.span.endMs - b.span.endMs;
	return a.task.createdAt - b.task.createdAt;
}

/**
 * Compile the timeline model. `tasks` is the caller-filtered visible set
 * (tag filter, completed visibility); subtasks roll up under their parent
 * (excluded via `topLevelTasks`), matching the board + flat surfaces.
 * Blocking is judged against `allTasks` (default: the visible set) — the
 * caller passes the UNFILTERED list so a tag-filtered-out or unscheduled
 * blocker still marks its dependent blocked.
 */
export function compileGantt(
	tasks: readonly Task[],
	now: number,
	allTasks: readonly Task[] = tasks,
): GanttModel {
	const byId = indexById(allTasks);
	const top = topLevelTasks(tasks);

	const rows: GanttRow[] = [];
	let unscheduledCount = 0;
	for (const task of top) {
		const span = ganttSpan(task);
		if (span === null) {
			unscheduledCount += 1;
			continue;
		}
		rows.push({ task, span, blocked: isBlocked(task, byId) });
	}
	rows.sort(byChronology);

	const laneOf = new Map<string, number>();
	rows.forEach((row, index) => laneOf.set(row.task.id, index));
	const edges: GanttEdge[] = [];
	rows.forEach((row, toIndex) => {
		for (const depId of row.task.dependsOn ?? []) {
			const fromIndex = laneOf.get(depId);
			if (fromIndex !== undefined && fromIndex !== toIndex) {
				edges.push({ fromIndex, toIndex });
			}
		}
	});

	const today = dayStart(now);
	let minStart = today;
	let maxEnd = nextDayStart(today);
	for (const row of rows) {
		if (row.span.startMs < minStart) minStart = row.span.startMs;
		if (row.span.endMs > maxEnd) maxEnd = row.span.endMs;
	}
	return {
		rows,
		edges,
		rangeStartMs: prevDayStart(minStart),
		rangeEndMs: addDays(maxEnd, 2),
		unscheduledCount,
	};
}

/** The day-starts spanning `[rangeStartMs, rangeEndMs)` in order — the
 *  renderer's single source for column positions (index-aligned). */
export function rangeDays(model: GanttModel): number[] {
	const days: number[] = [];
	for (let d = model.rangeStartMs; d < model.rangeEndMs; d = nextDayStart(d)) {
		days.push(d);
	}
	return days;
}
