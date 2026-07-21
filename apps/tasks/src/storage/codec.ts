/**
 * Persistence codec for the Tasks app's two entity types.
 *
 * Long-term keystone — the on-disk JSON protocol that the Stage 9.3
 * entities service will adopt without rename. Reads + writes go through
 * these helpers; **all** runtime shape validation lives here, so a
 * malformed row from a future migration / sync conflict drops to `null`
 * rather than crashing the renderer.
 *
 * Storage keys:
 *   - `task:<id>`    — one row per `Task/v1`
 *   - `project:<id>` — one row per `Project/v1`
 *
 * The prefix dot-separators (`task:` / `project:`) mirror the namespace
 * conventions in `apps/notes` (`note:<id>`) + `apps/files` (`folder:<id>`),
 * so the same shell-side `vaultEntities` scanner (Stage 9.13.1.8 preview
 * service) can ingest Tasks rows without code changes — it already keys
 * off the `<kind>:` prefix.
 */

import { type Recurrence, isRecurrence } from "@brainstorm-os/sdk-types";
import { nullableNumber, nullableString } from "@brainstorm-os/sdk/codec-helpers";
import { parseIcon } from "@brainstorm-os/sdk/entity-icon";
import { parseComments } from "../logic/task-comments";
import type { Project } from "../types/project";
import { Priority, type Task } from "../types/task";

export const TASK_KEY_PREFIX = "task:";
export const PROJECT_KEY_PREFIX = "project:";

export function taskKey(id: string): string {
	return TASK_KEY_PREFIX + id;
}

export function projectKey(id: string): string {
	return PROJECT_KEY_PREFIX + id;
}

export function serializeTask(task: Task): Task {
	// Tasks are plain JSON; the storage backend handles its own
	// serialisation. Returning a structural clone keeps the on-disk
	// shape decoupled from any caller-side mutation.
	return { ...task };
}

export function serializeProject(project: Project): Project {
	return { ...project };
}

/** Parse a `storage.get(taskKey(id))` result into a `Task`. Returns
 *  `null` for any malformed input — caller drops the row + logs. */
export function parseStoredTask(raw: unknown): Task | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;

	if (typeof r.id !== "string" || r.id === "") return null;
	if (typeof r.name !== "string") return null;
	if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return null;
	if (typeof r.updatedAt !== "number" || !Number.isFinite(r.updatedAt)) return null;

	const priority = isPriority(r.priority) ? r.priority : Priority.None;
	const recurrence = isRecurrence(r.recurrence) ? (r.recurrence as Recurrence) : null;
	const icon = parseIcon(r.icon);

	const task: Task = {
		id: r.id,
		name: r.name,
		completedAt: nullableNumber(r.completedAt),
		priority,
		scheduledAt: nullableNumber(r.scheduledAt),
		dueAt: nullableNumber(r.dueAt),
		projectId: nullableString(r.projectId),
		assigneeId: nullableString(r.assigneeId),
		parentId: nullableString(r.parentId),
		recurrence,
		statusKey: nullableString(r.statusKey),
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
	};
	if (typeof r.notes === "string") task.notes = r.notes;
	if (r.locked === true) task.locked = true;
	if (icon) task.icon = icon;
	const taskSort = nullableNumber(r.sortIndex);
	if (taskSort !== null) task.sortIndex = taskSort;
	const dependsOn = parseDependsOn(r.dependsOn);
	if (dependsOn.length > 0) task.dependsOn = dependsOn;
	const estimate = parseMinutes(r.estimateMinutes);
	if (estimate !== null) task.estimateMinutes = estimate;
	const logged = parseMinutes(r.loggedMinutes);
	if (logged !== null) task.loggedMinutes = logged;
	const tags = parseTags(r.tags);
	if (tags.length > 0) task.tags = tags;
	const comments = parseComments(r.comments);
	if (comments.length > 0) task.comments = comments;
	const values = parseValues(r.values);
	if (values) task.values = values;
	return task;
}

/** Custom vault-property values (9.14.16) — a non-empty plain object keyed
 *  by catalog property key. Anything else (array, scalar, empty) drops so a
 *  malformed bag degrades to "no custom properties", never a crash. */
function parseValues(raw: unknown): NonNullable<Task["values"]> | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	return Object.keys(raw).length > 0 ? (raw as NonNullable<Task["values"]>) : null;
}

export function parseStoredProject(raw: unknown): Project | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;

	if (typeof r.id !== "string" || r.id === "") return null;
	if (typeof r.name !== "string") return null;
	if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return null;
	if (typeof r.updatedAt !== "number" || !Number.isFinite(r.updatedAt)) return null;

	const icon = parseIcon(r.icon);

	const project: Project = {
		id: r.id,
		name: r.name,
		statusKey: nullableString(r.statusKey),
		milestoneAt: nullableNumber(r.milestoneAt),
		colorHint: nullableString(r.colorHint),
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
	};
	if (typeof r.description === "string") project.description = r.description;
	if (icon) project.icon = icon;
	const projectSort = nullableNumber(r.sortIndex);
	if (projectSort !== null) project.sortIndex = projectSort;
	return project;
}

/** Coerce a stored `dependsOn` to a clean, deduped string-id array (9.14.8).
 *  Tolerates a non-array / mixed input by dropping non-string entries. */
function parseDependsOn(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const v of raw) {
		if (typeof v === "string" && v.length > 0 && !out.includes(v)) out.push(v);
	}
	return out;
}

/** Coerce a stored `tags` to a clean, normalised, deduped string array
 *  (9.14.10) — trimmed + lower-cased, blanks + non-strings dropped. */
function parseTags(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const v of raw) {
		if (typeof v !== "string") continue;
		const tag = v.trim().replace(/\s+/g, " ").toLowerCase();
		if (tag.length > 0 && !out.includes(tag)) out.push(tag);
	}
	return out;
}

/** A stored minute count → a finite non-negative integer, or null (9.14.13). */
function parseMinutes(raw: unknown): number | null {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
	return Math.round(raw);
}

function isPriority(v: unknown): v is Priority {
	return (
		v === Priority.None ||
		v === Priority.Low ||
		v === Priority.Medium ||
		v === Priority.High ||
		v === Priority.Critical
	);
}
