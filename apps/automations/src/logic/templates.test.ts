import {
	TriggerKind,
	aggregateWorkflowCapabilities,
	isValidTrigger,
	isValidWorkflow,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { WORKFLOW_TEMPLATES, instantiateTemplate, templateById } from "./templates";

// The automations app's granted capability ceiling (manifest.json): a
// template must not exceed this, or an instantiated workflow is denied at
// run time.
const APP_GRANT = new Set(["notifications.post", "intents.dispatch:open"]);

describe("WORKFLOW_TEMPLATES", () => {
	it("every template has a valid trigger and produces a valid workflow", () => {
		for (const template of WORKFLOW_TEMPLATES) {
			expect(isValidTrigger(template.trigger)).toBe(true);
			const { makeWorkflow } = instantiateTemplate(template);
			const workflow = makeWorkflow("trigger-id");
			expect(isValidWorkflow(workflow)).toBe(true);
			expect(workflow.triggerId).toBe("trigger-id");
		}
	});

	it("stays within the app's granted capability ceiling", () => {
		for (const template of WORKFLOW_TEMPLATES) {
			for (const cap of aggregateWorkflowCapabilities(template.steps)) {
				expect(APP_GRANT.has(cap)).toBe(true);
			}
		}
	});

	it("only uses engine trigger kinds", () => {
		const engine = new Set([TriggerKind.Time, TriggerKind.EntityEvent, TriggerKind.Manual]);
		for (const template of WORKFLOW_TEMPLATES) {
			expect(engine.has(template.trigger.kind)).toBe(true);
		}
	});

	it("has unique ids", () => {
		const ids = WORKFLOW_TEMPLATES.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("offers mailbox triage + follow-up starters", () => {
		const triage = templateById("triage-new-email");
		expect(triage?.trigger.kind).toBe(TriggerKind.EntityEvent);
		expect(triage?.trigger.config).toMatchObject({ entityType: "brainstorm/Email/v1" });
		expect(triage?.tags).toContain("mailbox");

		const followUp = templateById("email-follow-up-nudge");
		expect(followUp?.trigger.kind).toBe(TriggerKind.Time);
		expect(followUp?.tags).toContain("follow-up");
	});
});

describe("instantiateTemplate", () => {
	it("computes the capability sheet from the steps and creates disabled", () => {
		const template = templateById("daily-planning-nudge");
		if (!template) throw new Error("missing template");
		const { makeWorkflow } = instantiateTemplate(template);
		const workflow = makeWorkflow("trig-1");
		expect(workflow.enabled).toBe(false);
		expect(workflow.capabilities).toEqual(["notifications.post"]);
	});
});

describe("templateById", () => {
	it("returns undefined for an unknown id", () => {
		expect(templateById("nope")).toBeUndefined();
	});
});
