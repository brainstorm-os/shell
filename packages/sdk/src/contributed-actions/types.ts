/**
 * Host-side types for the action surface (doc 63 §Host side). The runtime
 * slice the hook + primitive need, kept structural so a test can pass a plain
 * object and an app passes its real `brainstorm` runtime.
 */

import type {
	ContributedAction,
	ContributedActionTarget,
	ContributedVerb,
} from "@brainstorm-os/sdk-types";

/** The minimal runtime slice `useContributedActions` / `<ActionMenu>` read —
 *  the `intents.suggestActions` discovery surface plus `dispatch` for
 *  activating a chosen action. Both optional so a standalone / test runtime
 *  degrades to "no contributed actions" rather than throwing. */
export type ContributedActionsRuntime = {
	services?: {
		intents?: {
			dispatch?: (i: { verb: string; payload: Record<string, unknown> }) => unknown;
			suggestActions?: (input: {
				target: ContributedActionTarget;
				verbs: readonly ContributedVerb[];
			}) => Promise<readonly ContributedAction[]>;
		};
	} | null;
} | null;

export type UseContributedActionsInput = {
	runtime: ContributedActionsRuntime;
	target: ContributedActionTarget;
	/** The verbs to surface (defaults per the host's eligibility, OQ-AS-1). */
	verbs: readonly ContributedVerb[];
};
