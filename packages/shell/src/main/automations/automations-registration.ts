/**
 * Session-open schedule derivation (11b.6 deploy residue (a)) — the pure
 * half of the deployment glue: persisted `Workflow`/`Trigger`/`Reminder`
 * entity rows → the `ScheduleRegistration` the `AutomationsHost` hydrates
 * from. Entities are the source of truth; this is re-derived on every
 * vault open AND whenever an automation entity changes, so the scheduler
 * always reflects what is saved.
 *
 * Defensive throughout (the rows are app-written data): a malformed
 * trigger config, an unknown verb, or a dangling `triggerId` silently
 * yields no registration for that workflow — fail-closed for scheduling
 * (nothing fires off bad data), never a throw that would silence the
 * rest of the vault's automations.
 */

import {
	type EntityEventVerb,
	REMINDER_TYPE_URL,
	TRIGGER_TYPE_URL,
	TriggerKind,
	WORKFLOW_RUN_TYPE_URL,
	WORKFLOW_TYPE_URL,
	isEntityEventVerb,
	isRecurrence,
	propertiesToReminder,
	propertiesToTrigger,
	propertiesToWorkflow,
} from "@brainstorm-os/sdk-types";
import type { EntityEventTrigger, ScheduleRegistration } from "./automations-host";
import { reminderToTriggerConfig } from "./reminder-schedule";
import type { TimeTriggerConfig } from "./trigger-schedule";

/** The automation entity types whose change should re-derive the schedule. */
export const AUTOMATION_SCHEDULE_TYPES: readonly string[] = Object.freeze([
	WORKFLOW_TYPE_URL,
	TRIGGER_TYPE_URL,
	REMINDER_TYPE_URL,
]);

/** A persisted entity row, as the entities service returns it. */
export type AutomationEntityRow = {
	id: string;
	properties: Record<string, unknown>;
};

export type AutomationEntityRows = {
	workflows: readonly AutomationEntityRow[];
	triggers: readonly AutomationEntityRow[];
	reminders: readonly AutomationEntityRow[];
};

/**
 * Decode a `Trigger/v1` `config` bag into the scheduler's
 * `TimeTriggerConfig`. `recurrence` must be the structured sdk-types
 * `Recurrence` (OQ-165); `oneShotAt` accepts epoch ms or an ISO string.
 * Returns `null` when neither decodes — such a trigger never fires.
 */
export function decodeTimeTriggerConfig(config: Record<string, unknown>): TimeTriggerConfig | null {
	const out: TimeTriggerConfig = {};
	if (isRecurrence(config.recurrence)) out.recurrence = config.recurrence;
	const oneShot = config.oneShotAt;
	if (typeof oneShot === "number" && Number.isFinite(oneShot)) {
		out.oneShotAt = oneShot;
	} else if (typeof oneShot === "string") {
		const parsed = Date.parse(oneShot);
		if (Number.isFinite(parsed)) out.oneShotAt = parsed;
	}
	return out.recurrence !== undefined || out.oneShotAt !== undefined ? out : null;
}

/**
 * Project the persisted automation entities into the registration the
 * host hydrates from. Only enabled workflows bound to enabled triggers
 * register; `Manual` triggers register nothing (they run via `runNow`);
 * gated trigger kinds (webhook / file-watch / startup / intent) are
 * skipped until their surfaces land.
 */
export function deriveScheduleRegistration(rows: AutomationEntityRows): ScheduleRegistration {
	const triggersById = new Map(rows.triggers.map((t) => [t.id, propertiesToTrigger(t.properties)]));

	const workflows: ScheduleRegistration["workflows"] = [];
	const entityEvents: EntityEventTrigger[] = [];
	for (const row of rows.workflows) {
		const workflow = propertiesToWorkflow(row.properties);
		if (!workflow.enabled || workflow.triggerId === "") continue;
		const trigger = triggersById.get(workflow.triggerId);
		if (!trigger || !trigger.enabled) continue;
		switch (trigger.kind) {
			case TriggerKind.Time: {
				const config = decodeTimeTriggerConfig(trigger.config);
				if (config) workflows.push({ triggerId: workflow.triggerId, workflowId: row.id, config });
				break;
			}
			case TriggerKind.EntityEvent: {
				const entityType = trigger.config.entityType;
				const verb = trigger.config.verb;
				// SECURITY/stability: an EntityEvent trigger on `WorkflowRun/v1`
				// would self-amplify — every run persists a run, which would
				// fire the trigger again, unbounded. Refused at derivation.
				if (
					typeof entityType === "string" &&
					entityType !== "" &&
					entityType !== WORKFLOW_RUN_TYPE_URL &&
					isEntityEventVerb(verb)
				) {
					entityEvents.push({ workflowId: row.id, type: entityType, verb: verb as EntityEventVerb });
				}
				break;
			}
			default:
				break;
		}
	}

	const reminders: ScheduleRegistration["reminders"] = [];
	for (const row of rows.reminders) {
		const config = reminderToTriggerConfig(propertiesToReminder(row.properties));
		if (config) reminders.push({ reminderId: row.id, config });
	}

	return { workflows, reminders, entityEvents };
}
