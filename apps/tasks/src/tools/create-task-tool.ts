/**
 * `app.io.brainstorm.tasks.create-task` — Tasks as a tool PROVIDER (Tool-10,
 * doc 78). Another app hands over an object; Tasks adds a task named after it.
 *
 * What already happened before this runs, in the shell: the caller's
 * `tools.call:io.brainstorm.tasks/create-task` grant, the declared-argument
 * validation, the `allowedTypes` check against the entity's REAL type, the
 * read-only lock, and (for an agent, or on first use) a human's approval. This
 * side re-checks what it can anyway — it is the last code before a write, and
 * a handler that trusts its caller is one registry bug away from a hole.
 *
 * The write is Tasks' own, under Tasks' own `entities.write:brainstorm/Task/v1`
 * grant — the declared effect is `writes-vault`. Nothing in the source object
 * is touched; it is read once, for its title.
 *
 * Errors thrown here cross back as the provider's error text, which no
 * consumer renders (a refusal chip shows the consumer's own wording for the
 * named kind). They are codes for a log, not copy.
 */

import { resolveEntityTitle } from "@brainstorm-os/sdk/entity-title";
import { composeTask } from "../logic/compose-task";
import type { Task } from "../types/task";

/** The tool's name in the manifest's `registrations.tools`. */
export const CREATE_TASK_TOOL = "create-task";

/** The one declared argument — the object the task is made from. */
export const CREATE_TASK_SOURCE_ARG = "source";

/** The declared `allowedTypes` of {@link CREATE_TASK_SOURCE_ARG}. Kept in step
 *  with the manifest by `create-task-tool.test.ts`. */
export const CREATE_TASK_SOURCE_TYPES: readonly string[] = ["io.brainstorm.notes/Note/v1"];

/** A task name is a one-line label; a note title has no such bound. */
export const CREATE_TASK_NAME_MAX = 200;

/** Ids are minted by the shell (ULID / UUID / app-stable slugs) — far under
 *  this. A longer string is not an id and is not looked up. */
const ENTITY_ID_MAX = 256;

export enum CreateTaskToolError {
	BadArguments = "create-task: bad arguments",
	SourceUnavailable = "create-task: source unavailable",
	NotWritten = "create-task: task not written",
}

/** What the CALLER gets back: the id of the task that was made, and nothing
 *  else. In particular nothing READ from the source — Tasks reads the object
 *  under its own grants, and echoing its title would hand it to a caller that
 *  may hold no read grant of its own (the Tool-10 review's confused-deputy
 *  finding). The shell now refuses such a caller outright; this is the second
 *  lock, so the answer stays safe if that check ever regresses. */
export type CreateTaskToolResult = {
	taskId: string;
};

export type CreateTaskToolDeps = {
	/** Read the source object. Null when it does not exist or Tasks may not
	 *  read it — the two are deliberately indistinguishable to the caller. */
	getEntity: (
		id: string,
	) => Promise<{ type: string; properties: Readonly<Record<string, unknown>> } | null>;
	/** Persist the new task. MUST reject when the write did not land: the
	 *  caller is told "created" on the strength of this resolving. */
	createTask: (task: Task) => Promise<void>;
	newId: () => string;
	now: () => number;
	/** Localised name for a source that carries no title. */
	untitledName: () => string;
	/** Localised "made from <title>" line for the task's notes. */
	describeSource: (title: string) => string;
};

/** Read the source id out of the argument bag exactly ONCE. The bag crossed a
 *  process boundary as structured-clone data, so it is a plain object — but
 *  `Object.hasOwn` costs nothing and an inherited key is never an argument. */
function readSourceId(args: unknown): string | null {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
	if (!Object.hasOwn(args, CREATE_TASK_SOURCE_ARG)) return null;
	const value: unknown = (args as Record<string, unknown>)[CREATE_TASK_SOURCE_ARG];
	if (typeof value !== "string") return null;
	if (value.length === 0 || value.length > ENTITY_ID_MAX) return null;
	return value;
}

/** A title becomes a one-line task name: whitespace runs (newlines included)
 *  collapse to a single space, and the result is cut at a code-point boundary
 *  so a surrogate pair is never split. */
export function taskNameFromTitle(title: string): string {
	const oneLine = title.replace(/\s+/gu, " ").trim();
	return Array.from(oneLine).slice(0, CREATE_TASK_NAME_MAX).join("");
}

export async function runCreateTaskTool(
	args: unknown,
	deps: CreateTaskToolDeps,
): Promise<CreateTaskToolResult> {
	const sourceId = readSourceId(args);
	if (sourceId === null) throw new Error(CreateTaskToolError.BadArguments);

	let source: Awaited<ReturnType<CreateTaskToolDeps["getEntity"]>>;
	try {
		source = await deps.getEntity(sourceId);
	} catch {
		source = null;
	}
	// The shell already resolved the type from the store; this is the second
	// lock, against a declaration and a handler that drifted apart.
	if (source === null || !CREATE_TASK_SOURCE_TYPES.includes(source.type)) {
		throw new Error(CreateTaskToolError.SourceUnavailable);
	}

	const title = taskNameFromTitle(resolveEntityTitle(source.properties) ?? "");
	const name = title.length > 0 ? title : deps.untitledName();
	const task = composeTask(
		{ name, ...(title.length > 0 ? { notes: deps.describeSource(title) } : {}) },
		{ id: deps.newId(), now: deps.now() },
	);
	try {
		await deps.createTask(task);
	} catch {
		// The store's own message may quote vault content; the caller gets a code.
		throw new Error(CreateTaskToolError.NotWritten);
	}
	return { taskId: task.id };
}
