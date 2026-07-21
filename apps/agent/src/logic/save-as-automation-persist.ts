/**
 * Agent-6 — persist a confirmed {@link WorkflowDraft} as the two automation
 * entities (a `Trigger/v1` then a `Workflow/v1` bound to its id), through the
 * cap-checked `entities` service.
 *
 * The Agent app holds `entities.write:brainstorm/Workflow/v1` and
 * `entities.write:brainstorm/Trigger/v1` (declared in its manifest); the broker
 * re-checks both writes server-side. We reuse the SAME pure codecs the
 * Automations app persists with (`triggerToProperties` / `workflowToProperties`
 * from `@brainstorm-os/sdk-types`) so the shell scheduler hydrates the row with the
 * identical decoder — no second serialization.
 *
 * SECURITY: the draft's `capabilities` are already proven ⊆ the conversation's
 * frozen set by `generalizeConversationToWorkflow`; this layer only serializes +
 * writes, it never widens caps. The trigger is created first so the workflow can
 * reference a real id (mirrors the Automations save path).
 */

import {
	type EntitiesService,
	TRIGGER_TYPE_URL,
	WORKFLOW_TYPE_URL,
	type WorkflowDef,
	triggerToProperties,
	workflowToProperties,
} from "@brainstorm-os/sdk-types";
import type { WorkflowDraft } from "./save-as-automation";

/** Persist a draft as Trigger + Workflow entities; returns the created
 *  workflow's id. Throws on a write failure (the caller surfaces it). */
export async function persistWorkflowDraft(
	entities: EntitiesService,
	draft: WorkflowDraft,
): Promise<string> {
	const trigger = await entities.create(TRIGGER_TYPE_URL, triggerToProperties(draft.trigger));
	const def: WorkflowDef = { ...draft.workflow, triggerId: trigger.id };
	const workflow = await entities.create(WORKFLOW_TYPE_URL, workflowToProperties(def));
	return workflow.id;
}
