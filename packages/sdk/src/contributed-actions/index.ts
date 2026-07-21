/**
 * `@brainstorm-os/sdk/contributed-actions` — the host framework of the action
 * surface (doc 63). One hook (`useContributedActions`) that resolves +
 * groups the contributed actions for a target, and one primitive
 * (`<ActionMenu>`) that drops a contribution-aware menu into a React tree over
 * the shared object-menu renderer. The flat grouping/cap/trust logic lives in
 * `@brainstorm-os/sdk-types` (`groupContributedActions`) and is re-exported here
 * for hosts that render their own layout.
 */

export { ActionMenu, type ActionMenuProps } from "./action-menu";
export {
	useContributedActions,
	type UseContributedActionsResult,
} from "./use-contributed-actions";
export type { ContributedActionsRuntime, UseContributedActionsInput } from "./types";
export {
	ACTION_GROUP_ORDER,
	INLINE_ACTIONS_PER_GROUP,
	ActionGroup,
	ActionTrustTier,
	ContributedVerb,
	type ContributedAction,
	type ContributedActionGroup,
	type ContributedActionTarget,
	contributedActionId,
	groupContributedActions,
	groupForVerb,
} from "@brainstorm-os/sdk-types";
