/**
 * Widget-mode mount (Stage 7.3a). Kept in its own `.tsx` so the React tree
 * uses JSX — the imperative `app.ts` entry calls `mountTasksWidget()` from its
 * widget-launch branch, mirroring how `apps/notes/src/main.tsx` mounts its
 * widget root. Mounting via JSX (rather than `createElement` in `app.ts`)
 * keeps the `AppErrorBoundary` wrapper clean.
 */

import { AppErrorBoundary } from "@brainstorm-os/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm-os/sdk/menus";
import type { WidgetLaunch } from "@brainstorm-os/sdk/widget";
import { createRoot } from "react-dom/client";
import { TasksWidget } from "./widget";

/** Clear the full-app chrome baked into index.html and mount the compact
 *  widget surface (open-tasks glance list) into a fresh React root. */
export function mountTasksWidget(launch: WidgetLaunch): void {
	document.body.replaceChildren();
	document.body.classList.remove("is-booting");
	const root = document.createElement("div");
	root.id = "root";
	document.body.appendChild(root);
	mountMenuHost();
	createRoot(root).render(
		<AppErrorBoundary appName="tasks">
			<TasksWidget launch={launch} />
		</AppErrorBoundary>,
	);
}
