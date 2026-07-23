/**
 * 11b.14 — curated starter workflows (pure data + instantiation). Until
 * the visual builder lands (11b.11, OQ-166), templates are the way a user
 * creates a real `Workflow/v1` + its `Trigger/v1`. Each template is a
 * structurally-valid trigger + step list; `instantiateTemplate` mints the
 * trigger entity first, then the workflow pointing at it, with the
 * capability sheet computed from the steps (doc 39 §Aggregate capabilities).
 *
 * The curated set stays within the automations app's granted capability
 * ceiling (`notifications.post`, `intents.dispatch:open`) so an
 * instantiated template actually runs once the scheduler is wired — a
 * Notify nudge across the three engine trigger kinds (Time / EntityEvent /
 * Manual). Templates that need broader grants are the builder's concern.
 *
 * Instantiated workflows are created **disabled**: the user reviews the
 * capability sheet and flips the toggle before anything fires (safe default).
 */

import {
	type EntityEventVerb,
	EntityEventVerb as EntityEventVerbEnum,
	type Recurrence,
	RecurrenceKind,
	StepKind,
	type TriggerDef,
	TriggerKind,
	Weekday,
	type WorkflowDef,
	type WorkflowStep,
	aggregateWorkflowCapabilities,
} from "@brainstorm-os/sdk-types";

export type WorkflowTemplate = {
	id: string;
	name: string;
	description: string;
	icon?: string;
	/** What the trigger fires on, summarised for the gallery card. */
	triggerSummary: string;
	trigger: TriggerDef;
	steps: WorkflowStep[];
	tags?: string[];
};

const TRIGGER_STEP: WorkflowStep = { id: "trigger", kind: StepKind.Trigger };

function notify(id: string, title: string, body: string): WorkflowStep {
	return { id, kind: StepKind.Notify, title, body };
}

function timeTrigger(recurrence: Recurrence): TriggerDef {
	return { kind: TriggerKind.Time, config: { recurrence }, enabled: true };
}

function entityEventTrigger(entityType: string, verb: EntityEventVerb): TriggerDef {
	return { kind: TriggerKind.EntityEvent, config: { entityType, verb }, enabled: true };
}

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = Object.freeze([
	{
		id: "daily-planning-nudge",
		name: "Daily planning nudge",
		description: "Every morning, a nudge to set your top priorities for the day.",
		icon: "sun",
		triggerSummary: "Every day at 9:00",
		trigger: timeTrigger({ kind: RecurrenceKind.Daily, every: 1 }),
		steps: [
			TRIGGER_STEP,
			notify("nudge", "Plan your day", "What are the three things that matter most today?"),
		],
		tags: ["focus", "daily"],
	},
	{
		id: "weekly-review-nudge",
		name: "Weekly review nudge",
		description: "A Friday-afternoon prompt to reflect on the week and tee up the next.",
		icon: "calendar-check",
		triggerSummary: "Every Friday at 16:00",
		trigger: timeTrigger({ kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Fri] }),
		steps: [
			TRIGGER_STEP,
			notify("review", "Weekly review", "Wins, misses, and what's next — take ten minutes."),
		],
		tags: ["review", "weekly"],
	},
	{
		id: "new-bookmark-alert",
		name: "New bookmark alert",
		description: "Get a heads-up whenever a bookmark is saved to your vault.",
		icon: "bookmark",
		triggerSummary: "When a bookmark is created",
		trigger: entityEventTrigger("brainstorm/Bookmark/v1", EntityEventVerbEnum.Create),
		steps: [
			TRIGGER_STEP,
			notify("saved", "Bookmark saved", "A new bookmark just landed in your vault."),
		],
		tags: ["bookmarks"],
	},
	{
		id: "triage-new-email",
		name: "Triage new email",
		description: "When a new email lands, a nudge to classify it — file, flag, or follow up.",
		icon: "envelope",
		triggerSummary: "When an email arrives",
		trigger: entityEventTrigger("brainstorm/Email/v1", EntityEventVerbEnum.Create),
		steps: [TRIGGER_STEP, notify("triage", "New email", "Triage it: file, flag, or follow up.")],
		tags: ["mailbox", "email"],
	},
	{
		id: "email-follow-up-nudge",
		name: "Email follow-up nudge",
		description: "A daily prompt to chase down the email threads still waiting on a reply.",
		icon: "clock",
		triggerSummary: "Every day at 8:00",
		trigger: timeTrigger({ kind: RecurrenceKind.Daily, every: 1 }),
		steps: [TRIGGER_STEP, notify("follow-up", "Follow-ups", "Any threads still waiting on a reply?")],
		tags: ["mailbox", "email", "follow-up"],
	},
	{
		id: "manual-test-notification",
		name: "Test notification",
		description: "A run-on-demand workflow for trying the engine — fires a single notification.",
		icon: "bell",
		triggerSummary: "Run on demand",
		trigger: { kind: TriggerKind.Manual, config: {}, enabled: true },
		steps: [
			TRIGGER_STEP,
			notify("ping", "It works", "Your automation engine fired this notification."),
		],
		tags: ["test"],
	},
]);

export type InstantiatedTemplate = {
	trigger: TriggerDef;
	/** Build the workflow once the trigger entity id is known. */
	makeWorkflow: (triggerId: string) => WorkflowDef;
};

/** Resolve a template into the entities to persist: a trigger, and a
 *  workflow factory that binds to the created trigger's id. The workflow's
 *  capabilities are computed from its steps; it is created disabled. */
export function instantiateTemplate(template: WorkflowTemplate): InstantiatedTemplate {
	const capabilities = aggregateWorkflowCapabilities(template.steps);
	return {
		trigger: template.trigger,
		makeWorkflow: (triggerId: string): WorkflowDef => {
			const def: WorkflowDef = {
				name: template.name,
				description: template.description,
				enabled: false,
				triggerId,
				steps: template.steps,
				capabilities,
			};
			if (template.icon !== undefined) def.icon = template.icon;
			if (template.tags !== undefined) def.tags = [...template.tags];
			return def;
		},
	};
}

export function templateById(id: string): WorkflowTemplate | undefined {
	return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}
