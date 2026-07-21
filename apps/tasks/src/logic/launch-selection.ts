/**
 * Map an incoming `LaunchContext` to the initial sidebar selection +
 * row-highlight id Tasks should show on boot.
 *
 * Called from `app.ts` once the tasks + projects load. The helper is
 * pure (no DOM, no SDK dep) so the cross-app `intent.open` wiring is
 * unit-testable end-to-end via the same `compileSurface` keystone.
 *
 * Resolution rules (in order):
 *   - `entityId` is a known Project id → jump to that Project surface.
 *   - `entityId` is a known Task id → jump to a surface that contains
 *     the task: prefer Project (if the task has one), fall back to
 *     Today (if scheduled today) or Upcoming (if scheduled future) or
 *     Inbox (no project, no schedule). Highlight the row.
 *   - Otherwise → fall through; caller keeps its default selection
 *     (typically Today).
 *
 * Why a pure resolver rather than baking this into `bootApp`? Cross-app
 * navigation will exercise this every time another app dispatches
 * `intent.open` on a Task/Project entity — the rule set is the same
 * for boot AND for the running-app push-channel case (lands in a
 * follow-up). Centralising makes the second-wiring trivial.
 */

import type { LaunchContext } from "@brainstorm-os/sdk-types";
import type { Project } from "../types/project";
import { TaskSurface } from "../types/surface";
import type { Task } from "../types/task";
import type { SidebarSelection } from "../ui/sidebar";
import { endOfToday } from "./date-buckets";
import { surfaceFor } from "./task-status";

export type LaunchSelection = {
	selection: SidebarSelection;
	/** Task id to scroll-to + highlight after first paint. `null` when
	 *  no specific task was named (e.g. `entityId` matched a Project). */
	highlightTaskId: string | null;
};

export function pickInitialSelectionForLaunch(
	launch: LaunchContext | undefined,
	tasks: readonly Task[],
	projects: readonly Project[],
	now: number,
): LaunchSelection | null {
	if (!launch || launch.reason !== "open-entity") return null;
	const entityId = launch.entityId;
	if (!entityId) return null;

	const project = projects.find((p) => p.id === entityId);
	if (project) {
		return {
			selection: { kind: TaskSurface.Project, projectId: project.id },
			highlightTaskId: null,
		};
	}

	const task = tasks.find((t) => t.id === entityId);
	if (task) {
		if (task.projectId !== null) {
			const containing = projects.find((p) => p.id === task.projectId);
			if (containing) {
				return {
					selection: { kind: TaskSurface.Project, projectId: containing.id },
					highlightTaskId: task.id,
				};
			}
		}
		const endOfTodayMs = endOfToday(now);
		const surface = surfaceFor(task, endOfTodayMs);
		// `surfaceFor` may return Project for a project-owned task; we already
		// covered that branch above. Fold any remaining Project return into
		// Inbox so we always land on a built-in surface here.
		const target = surface === TaskSurface.Project ? TaskSurface.Inbox : (surface as InboxOrToday);
		return {
			selection: { kind: target },
			highlightTaskId: task.id,
		};
	}

	return null;
}

type InboxOrToday = TaskSurface.Inbox | TaskSurface.Today | TaskSurface.Upcoming;
