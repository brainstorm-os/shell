/**
 * Workflow / Reminder entity load/save — the persistence half of the
 * 11b.1 scaffold. Routes through `services.entities`. The pure
 * `*ToProperties` / `propertiesTo*` mappers live in `@brainstorm-os/sdk-types`
 * (`automation-codec.ts`) so the shell's session-open scheduler hydration
 * (11b.6) decodes the same persisted rows with the same code; they are
 * re-exported here for the app's existing call sites.
 */

import {
	REMINDER_TYPE_URL,
	type ReminderDef,
	TRIGGER_TYPE_URL,
	type TriggerDef,
	type VaultEntity,
	WORKFLOW_RUN_TYPE_URL,
	WORKFLOW_TYPE_URL,
	type WorkflowDef,
	isValidReminder,
	isValidTrigger,
	isValidWorkflow,
	propertiesToReminder,
	propertiesToTrigger,
	propertiesToWorkflow,
	reminderToProperties,
	triggerToProperties,
	workflowToProperties,
} from "@brainstorm-os/sdk-types";
import { type BuilderState, builderStateToWorkflow } from "../logic/builder-model";
import { type BuilderTrigger, builderTriggerToDef } from "../logic/builder-trigger";
import { type RunView, toRunViews } from "../logic/run-view";
import type { WorkflowTemplate } from "../logic/templates";
import { instantiateTemplate } from "../logic/templates";
import type { ImportedAutomation } from "../logic/transfer";
import type { EntitiesService, EntityRecord } from "./runtime";

export {
	propertiesToReminder,
	propertiesToTrigger,
	propertiesToWorkflow,
	reminderToProperties,
	triggerToProperties,
	workflowToProperties,
};

export type LoadedWorkflow = { id: string; def: WorkflowDef };
export type LoadedReminder = { id: string; def: ReminderDef };

/** Live entities of one type out of a whole-vault snapshot, skipping
 *  tombstones — the shared projection the snapshot-derived lists run on
 *  (the snapshot itself flows through `@brainstorm-os/react-yjs`
 *  `useVaultEntities`, never a hand-rolled `onChange → list`). */
function entitiesOfType(snapshot: ReadonlyArray<VaultEntity>, type: string): VaultEntity[] {
	return snapshot.filter((e) => e.type === type && e.deletedAt === null);
}

/** Project the saved `Workflow/v1` entities out of a whole-vault snapshot,
 *  decoded — the reactive twin of `listWorkflows`. */
export function workflowsFromSnapshot(snapshot: ReadonlyArray<VaultEntity>): LoadedWorkflow[] {
	return entitiesOfType(snapshot, WORKFLOW_TYPE_URL).map((e) => ({
		id: e.id,
		def: propertiesToWorkflow(e.properties),
	}));
}

/** Project the `Reminder/v1` entities out of a whole-vault snapshot. */
export function remindersFromSnapshot(snapshot: ReadonlyArray<VaultEntity>): LoadedReminder[] {
	return entitiesOfType(snapshot, REMINDER_TYPE_URL).map((e) => ({
		id: e.id,
		def: propertiesToReminder(e.properties),
	}));
}

/** Project the `WorkflowRun/v1` entities into sorted run views, resolving
 *  each run's originating workflow name from the same snapshot. */
export function runsFromSnapshot(snapshot: ReadonlyArray<VaultEntity>): RunView[] {
	const names = new Map(workflowsFromSnapshot(snapshot).map((w) => [w.id, w.def.name]));
	const records = entitiesOfType(snapshot, WORKFLOW_RUN_TYPE_URL).map((e) => ({
		id: e.id,
		type: e.type,
		properties: e.properties,
		createdAt: e.createdAt,
		updatedAt: e.updatedAt,
	}));
	return toRunViews(records, names);
}

export async function listWorkflows(
	entities: EntitiesService | null | undefined,
): Promise<LoadedWorkflow[]> {
	if (!entities) return [];
	const records = await entities.query({ type: WORKFLOW_TYPE_URL });
	return records.map((r) => ({ id: r.id, def: propertiesToWorkflow(r.properties) }));
}

export async function listReminders(
	entities: EntitiesService | null | undefined,
): Promise<LoadedReminder[]> {
	if (!entities) return [];
	const records = await entities.query({ type: REMINDER_TYPE_URL });
	return records.map((r) => ({ id: r.id, def: propertiesToReminder(r.properties) }));
}

/** Persist a workflow — update when `id` exists, else create. Validates
 *  structurally before writing. Returns null outside the shell. */
export async function saveWorkflow(
	entities: EntitiesService | null | undefined,
	def: WorkflowDef,
	id?: string,
): Promise<EntityRecord | null> {
	if (!entities) return null;
	if (!isValidWorkflow(def)) throw new Error("automations: refusing to save an invalid Workflow/v1");
	const props = workflowToProperties(def);
	if (id) {
		const existing = await entities.get(id);
		if (existing) return entities.update(id, props);
	}
	return entities.create(WORKFLOW_TYPE_URL, props, id);
}

export async function saveReminder(
	entities: EntitiesService | null | undefined,
	def: ReminderDef,
	id?: string,
): Promise<EntityRecord | null> {
	if (!entities) return null;
	if (!isValidReminder(def)) throw new Error("automations: refusing to save an invalid Reminder/v1");
	const props = reminderToProperties(def);
	if (id) {
		const existing = await entities.get(id);
		if (existing) return entities.update(id, props);
	}
	return entities.create(REMINDER_TYPE_URL, props, id);
}

export async function deleteReminder(
	entities: EntitiesService | null | undefined,
	id: string,
): Promise<void> {
	if (!entities) return;
	await entities.delete(id);
}

/** Load one `Trigger/v1` by id, decoded — or null when absent / outside
 *  the shell. Export reads the workflow's bound trigger through this. */
export async function loadTrigger(
	entities: EntitiesService | null | undefined,
	id: string,
): Promise<TriggerDef | null> {
	if (!entities) return null;
	const record = await entities.get(id);
	if (!record) return null;
	return propertiesToTrigger(record.properties);
}

export async function saveTrigger(
	entities: EntitiesService | null | undefined,
	def: TriggerDef,
	id?: string,
): Promise<EntityRecord | null> {
	if (!entities) return null;
	if (!isValidTrigger(def)) throw new Error("automations: refusing to save an invalid Trigger/v1");
	const props = triggerToProperties(def);
	if (id) {
		const existing = await entities.get(id);
		if (existing) return entities.update(id, props);
	}
	return entities.create(TRIGGER_TYPE_URL, props, id);
}

/** All `WorkflowRun/v1` records, undecoded — the Runs view decodes them
 *  into its own model (`logic/run-view.ts`). */
export async function listRuns(
	entities: EntitiesService | null | undefined,
): Promise<EntityRecord[]> {
	if (!entities) return [];
	return entities.query({ type: WORKFLOW_RUN_TYPE_URL });
}

/**
 * Persist a template as live entities: create its `Trigger/v1` first, then
 * the `Workflow/v1` bound to that trigger's id. Returns the created
 * workflow record, or null outside the shell. The workflow is disabled
 * (the template default) until the user reviews + enables it.
 */
export async function instantiateWorkflowTemplate(
	entities: EntitiesService | null | undefined,
	template: WorkflowTemplate,
): Promise<EntityRecord | null> {
	if (!entities) return null;
	const { trigger, makeWorkflow } = instantiateTemplate(template);
	const triggerRecord = await saveTrigger(entities, trigger);
	if (!triggerRecord) return null;
	try {
		return await saveWorkflow(entities, makeWorkflow(triggerRecord.id));
	} catch (error) {
		// Don't leave a dangling Trigger pointing at nothing if the workflow
		// write fails — roll the pair back, then re-surface the failure.
		await entities.delete(triggerRecord.id).catch(() => undefined);
		throw error;
	}
}

/**
 * Persist an imported automation as live entities — the same two-phase
 * mint as `instantiateWorkflowTemplate` (Trigger first, then the Workflow
 * bound to its id, with rollback on failure). The bundle was already
 * recomputed disabled with a step-derived capability sheet by
 * `importAutomation` (11b.16), so this layer only writes.
 */
export async function persistImportedAutomation(
	entities: EntitiesService | null | undefined,
	imported: ImportedAutomation,
): Promise<EntityRecord | null> {
	if (!entities) return null;
	const triggerRecord = await saveTrigger(entities, imported.trigger);
	if (!triggerRecord) return null;
	try {
		return await saveWorkflow(entities, imported.makeWorkflow(triggerRecord.id));
	} catch (error) {
		await entities.delete(triggerRecord.id).catch(() => undefined);
		throw error;
	}
}

/**
 * 11b.11 — persist a workflow authored in the builder. **Create** mints the
 * `Trigger/v1` first (rolling it back if the workflow write fails, like the
 * template / import paths), then the `Workflow/v1` bound to its id with the
 * step-derived capability sheet, created **disabled** for review. **Update**
 * (when `existing` is supplied) rewrites the bound trigger in place and
 * patches the workflow, preserving its `enabled` state. Returns the
 * workflow record, or null outside the shell.
 */
export async function saveBuiltWorkflow(
	entities: EntitiesService | null | undefined,
	state: BuilderState,
	trigger: BuilderTrigger,
	existing?: { workflowId: string; triggerId: string; enabled: boolean },
): Promise<EntityRecord | null> {
	if (!entities) return null;
	const triggerDef = builderTriggerToDef(trigger);

	if (existing) {
		await saveTrigger(entities, triggerDef, existing.triggerId);
		const def = builderStateToWorkflow(state, existing.triggerId, existing.enabled);
		return saveWorkflow(entities, def, existing.workflowId);
	}

	const triggerRecord = await saveTrigger(entities, triggerDef);
	if (!triggerRecord) return null;
	try {
		const def = builderStateToWorkflow(state, triggerRecord.id, false);
		return await saveWorkflow(entities, def);
	} catch (error) {
		await entities.delete(triggerRecord.id).catch(() => undefined);
		throw error;
	}
}
