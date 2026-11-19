/**
 * `TasksRepository` — the storage contract the app's data layer is written
 * against. Implemented by `createEntitiesRepository` (the shared
 * `entities.db` store); the renderer call sites depend only on this type.
 */

import type { Project } from "../types/project";
import type { Task } from "../types/task";

export type TasksRepository = {
	listAll(): Promise<{ tasks: Task[]; projects: Project[] }>;
	saveTask(task: Task): Promise<void>;
	/** Create a task that must not already exist, REJECTING when the write did
	 *  not land. `saveTask` logs and swallows a failure — right for a UI gesture
	 *  the live list will contradict, wrong for a tool call (Tool-10), whose
	 *  caller is told "created" on the strength of this resolving. */
	createTask(task: Task): Promise<void>;
	deleteTask(id: string): Promise<void>;
	saveProject(project: Project): Promise<void>;
	deleteProject(id: string): Promise<void>;
};
