/**
 * Tasks repository over the **shared entities service** — the real
 * `entities.db`. Implements the `TasksRepository` contract the app's call
 * sites depend on.
 *
 * Two types read in one combined query; writes are get-then-create-or-update
 * keyed on the stable, app-owned id (iteration ids, `proj-<stage>`). The
 * app's domain `createdAt`/`updatedAt` stay in the property bag — the store
 * owns entity-level timestamps and would clobber them on every write.
 * Plumbing lives in `@brainstorm-os/sdk/storage-repository`.
 */

import { deleteEntity, queryEntityRows, upsertEntity } from "@brainstorm-os/sdk/storage-repository";
import type { Project } from "../types/project";
import type { Task } from "../types/task";
import { parseStoredProject, parseStoredTask, serializeProject, serializeTask } from "./codec";
import type { TasksRepository } from "./repository";
import type { EntitiesService, EntityRecord } from "./runtime";

export const TASK_TYPE = "brainstorm/Task/v1";
export const PROJECT_TYPE = "brainstorm/Project/v1";

function logError(op: string, err: unknown): void {
	console.error(`[tasks/entities-repo] ${op} failed:`, err);
}

function taskToProps(task: Task): Record<string, unknown> {
	const { id: _id, ...props } = serializeTask(task);
	return props;
}
function projectToProps(project: Project): Record<string, unknown> {
	const { id: _id, ...props } = serializeProject(project);
	return props;
}
function entityToTask(e: EntityRecord): Task | null {
	return parseStoredTask({ ...e.properties, id: e.id });
}
function entityToProject(e: EntityRecord): Project | null {
	return parseStoredProject({ ...e.properties, id: e.id });
}

export function createEntitiesRepository(entities: EntitiesService): TasksRepository {
	return {
		async listAll() {
			const rows = await queryEntityRows(entities, [TASK_TYPE, PROJECT_TYPE], "listAll", logError);
			const tasks: Task[] = [];
			const projects: Project[] = [];
			for (const row of rows) {
				if (row.type === TASK_TYPE) {
					const t = entityToTask(row as EntityRecord);
					if (t) tasks.push(t);
				} else if (row.type === PROJECT_TYPE) {
					const p = entityToProject(row as EntityRecord);
					if (p) projects.push(p);
				}
			}
			return { tasks, projects };
		},
		saveTask: (task) =>
			upsertEntity(entities, TASK_TYPE, task.id, taskToProps(task), "saveTask", logError),
		saveProject: (project) =>
			upsertEntity(
				entities,
				PROJECT_TYPE,
				project.id,
				projectToProps(project),
				"saveProject",
				logError,
			),
		deleteTask: (id) => deleteEntity(entities, id, "deleteTask", logError),
		deleteProject: (id) => deleteEntity(entities, id, "deleteProject", logError),
	};
}
