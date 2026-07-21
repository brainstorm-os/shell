/**
 * Maps the Tasks runtime onto the structural slice the shared cross-app
 * object menu (`@brainstorm-os/sdk/object-menu`) needs. Both per-object
 * surfaces — task rows and project rows — go through ONE delegated
 * listener (`delegated-object-menu.ts`) that calls the shared
 * `openObjectMenu`, so the Open → Pin/Unpin → Remove order + chrome is
 * identical to every other app (per the shared-fundamentals contract §A
 * "Object menu"). This file is just the runtime adapter.
 */

import type { ObjectMenuRuntime } from "@brainstorm-os/sdk/object-menu";
import type { TasksBrainstorm } from "../storage/runtime";

/** Map the Tasks runtime onto the structural slice the shared menu
 *  needs. Returns `null` in preview / no-shell mode so callers can skip
 *  the menu entirely (it has nothing to act through). */
export function toObjectMenuRuntime(runtime: TasksBrainstorm | null): ObjectMenuRuntime {
	if (!runtime) return null;
	return {
		capabilities: runtime.capabilities ?? [],
		services: {
			...(runtime.services.intents
				? { intents: { dispatch: (i) => runtime.services.intents?.dispatch(i) } }
				: {}),
			...(runtime.services.dashboard
				? {
						dashboard: {
							pin: (target) => runtime.services.dashboard?.pin(target) ?? Promise.resolve(false),
							unpin: (target) => runtime.services.dashboard?.unpin(target) ?? Promise.resolve(false),
							isPinned: (target) => runtime.services.dashboard?.isPinned(target) ?? Promise.resolve(false),
						},
					}
				: {}),
		},
	};
}
