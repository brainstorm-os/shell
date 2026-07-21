import {
	EntityEventVerb,
	RecurrenceKind,
	TriggerKind,
	Weekday,
	triggerToProperties,
	workflowToProperties,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { decodeTimeTriggerConfig, deriveScheduleRegistration } from "./automations-registration";

const T0 = Date.UTC(2026, 5, 6, 9, 0, 0);

function workflowRow(id: string, triggerId: string, enabled = true) {
	return {
		id,
		properties: workflowToProperties({
			name: id,
			enabled,
			triggerId,
			steps: [],
			capabilities: [],
		}),
	};
}

function triggerRow(
	id: string,
	kind: TriggerKind,
	config: Record<string, unknown>,
	enabled = true,
) {
	return { id, properties: triggerToProperties({ kind, config, enabled }) };
}

describe("decodeTimeTriggerConfig", () => {
	it("decodes a structured recurrence + epoch/ISO one-shots", () => {
		const recurrence = { kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Mon] };
		expect(decodeTimeTriggerConfig({ recurrence })).toEqual({ recurrence });
		expect(decodeTimeTriggerConfig({ oneShotAt: T0 })).toEqual({ oneShotAt: T0 });
		expect(decodeTimeTriggerConfig({ oneShotAt: new Date(T0).toISOString() })).toEqual({
			oneShotAt: T0,
		});
	});

	it("fails closed on malformed config — null, never a throw", () => {
		expect(decodeTimeTriggerConfig({})).toBeNull();
		expect(decodeTimeTriggerConfig({ recurrence: "RRULE:FREQ=DAILY" })).toBeNull();
		expect(decodeTimeTriggerConfig({ oneShotAt: "not a date" })).toBeNull();
		expect(decodeTimeTriggerConfig({ oneShotAt: Number.NaN })).toBeNull();
	});
});

describe("deriveScheduleRegistration", () => {
	it("registers enabled workflows bound to enabled Time/EntityEvent triggers", () => {
		const reg = deriveScheduleRegistration({
			workflows: [
				workflowRow("wf_time", "t_time"),
				workflowRow("wf_event", "t_event"),
				workflowRow("wf_manual", "t_manual"),
			],
			triggers: [
				triggerRow("t_time", TriggerKind.Time, { oneShotAt: T0 }),
				triggerRow("t_event", TriggerKind.EntityEvent, {
					entityType: "brainstorm/Task/v1",
					verb: EntityEventVerb.Create,
				}),
				triggerRow("t_manual", TriggerKind.Manual, {}),
			],
			reminders: [],
		});
		expect(reg.workflows).toEqual([
			{ triggerId: "t_time", workflowId: "wf_time", config: { oneShotAt: T0 } },
		]);
		expect(reg.entityEvents).toEqual([
			{ workflowId: "wf_event", type: "brainstorm/Task/v1", verb: EntityEventVerb.Create },
		]);
	});

	it("collects enabled Startup workflows into startups (11b.10)", () => {
		const reg = deriveScheduleRegistration({
			workflows: [
				workflowRow("wf_boot", "t_boot"),
				workflowRow("wf_boot_off", "t_boot", false),
				workflowRow("wf_boot_trigoff", "t_boot_off"),
			],
			triggers: [
				triggerRow("t_boot", TriggerKind.Startup, {}),
				triggerRow("t_boot_off", TriggerKind.Startup, {}, false),
			],
			reminders: [],
		});
		// Only the enabled workflow on the enabled Startup trigger; a Startup
		// registers nothing in workflows/entityEvents (fires on launch, not the
		// scheduler).
		expect(reg.startups).toEqual(["wf_boot"]);
		expect(reg.workflows).toEqual([]);
		expect(reg.entityEvents).toEqual([]);
	});

	it("refuses an EntityEvent trigger on WorkflowRun/v1 (self-amplifying loop)", () => {
		const reg = deriveScheduleRegistration({
			workflows: [workflowRow("wf_loop", "t_loop")],
			triggers: [
				triggerRow("t_loop", TriggerKind.EntityEvent, {
					entityType: "brainstorm/WorkflowRun/v1",
					verb: EntityEventVerb.Create,
				}),
			],
			reminders: [],
		});
		expect(reg.entityEvents).toEqual([]);
	});

	it("skips disabled workflows, disabled/dangling triggers, and bad verbs", () => {
		const reg = deriveScheduleRegistration({
			workflows: [
				workflowRow("wf_off", "t_time", false),
				workflowRow("wf_dangling", "t_gone"),
				workflowRow("wf_trigger_off", "t_off"),
				workflowRow("wf_bad_verb", "t_bad"),
			],
			triggers: [
				triggerRow("t_time", TriggerKind.Time, { oneShotAt: T0 }),
				triggerRow("t_off", TriggerKind.Time, { oneShotAt: T0 }, false),
				triggerRow("t_bad", TriggerKind.EntityEvent, { entityType: "T/v1", verb: "onNonsense" }),
			],
			reminders: [],
		});
		expect(reg.workflows).toEqual([]);
		expect(reg.entityEvents).toEqual([]);
	});

	it("derives reminder schedules from their own persisted fields", () => {
		const due = new Date(T0).toISOString();
		const reg = deriveScheduleRegistration({
			workflows: [],
			triggers: [],
			reminders: [
				{ id: "rem_1", properties: { subject: "Water plants", dueAt: due } },
				{ id: "rem_done", properties: { subject: "Done", dueAt: due, completedAt: due } },
			],
		});
		expect(reg.reminders).toEqual([{ reminderId: "rem_1", config: { oneShotAt: T0 } }]);
	});
});
