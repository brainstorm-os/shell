/**
 * `brainstorm/Project/v1` — first-class project entity, Tasks-app-owned
 * (resolves OQ-TK-2). Owns project-specific properties (status, milestone
 * date) without bloating the Note schema; the Project ↔ Note relationship
 * lives in the typed-link graph rather than in this row.
 */

import type { Icon } from "@brainstorm-os/sdk-types";

export type Project = {
	id: string;
	name: string;
	description?: string;
	icon?: Icon | null;

	/** Vocabulary key into the `project-status` dictionary (e.g.
	 *  `active`, `paused`, `done`). */
	statusKey: string | null;

	/** Epoch ms — target completion date for the project as a whole. */
	milestoneAt: number | null;

	/** Optional CSS colour string used as the project's accent tint in
	 *  task rows. Tracked separately from `icon` so a user who picks an
	 *  icon doesn't lose their colour preference. */
	colorHint: string | null;

	/** Manual sort position in the sidebar's active-projects list. Null
	 *  = no user-chosen position; the renderer falls back to `createdAt`
	 *  ascending. Drag-and-drop renumbers the list to integers `0..n-1`
	 *  on every drop, so there's no fractional/sparse-index bookkeeping. */
	sortIndex?: number | null;

	createdAt: number;
	updatedAt: number;
};
