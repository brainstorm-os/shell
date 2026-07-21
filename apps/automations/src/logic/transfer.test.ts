import {
	RecurrenceKind,
	StepKind,
	type TriggerDef,
	TriggerKind,
	type WorkflowDef,
	type WorkflowStep,
	aggregateWorkflowCapabilities,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	AUTOMATION_BUNDLE_KIND,
	AUTOMATION_BUNDLE_VERSION,
	exportAutomation,
	importAutomation,
	parseAutomationBundle,
	resolveImportName,
	serializeAutomationBundle,
} from "./transfer";

const STEPS: WorkflowStep[] = [
	{ id: "trigger", kind: StepKind.Trigger },
	{ id: "ping", kind: StepKind.Notify, title: "Hi", body: "There" },
];

const TRIGGER: TriggerDef = {
	kind: TriggerKind.Time,
	config: { recurrence: { kind: RecurrenceKind.Daily, every: 1 } },
	enabled: true,
};

const WORKFLOW: WorkflowDef = {
	name: "Daily ping",
	description: "Says hi",
	icon: "bell",
	enabled: true,
	triggerId: "trg_local_1",
	steps: STEPS,
	capabilities: aggregateWorkflowCapabilities(STEPS),
	tags: ["test"],
};

describe("exportAutomation", () => {
	it("packs authorable fields and drops identity / capabilities / enablement", () => {
		const bundle = exportAutomation(WORKFLOW, TRIGGER);
		expect(bundle.kind).toBe(AUTOMATION_BUNDLE_KIND);
		expect(bundle.version).toBe(AUTOMATION_BUNDLE_VERSION);
		expect(bundle.workflow).toEqual({
			name: "Daily ping",
			description: "Says hi",
			icon: "bell",
			tags: ["test"],
			steps: STEPS,
		});
		expect("capabilities" in bundle.workflow).toBe(false);
		expect("triggerId" in bundle.workflow).toBe(false);
		expect("enabled" in bundle.workflow).toBe(false);
		expect(bundle.trigger).toEqual({ kind: TRIGGER.kind, config: TRIGGER.config });
	});
});

describe("parseAutomationBundle", () => {
	it("round-trips an exported bundle", () => {
		const text = serializeAutomationBundle(exportAutomation(WORKFLOW, TRIGGER));
		const parsed = parseAutomationBundle(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.bundle.workflow.name).toBe("Daily ping");
	});

	it("rejects non-JSON, non-bundles, and wrong versions", () => {
		expect(parseAutomationBundle("nope").ok).toBe(false);
		const wrongKind = parseAutomationBundle(JSON.stringify({ kind: "x", version: 1 }));
		expect(wrongKind.ok === false && wrongKind.issues.join(" ")).toContain(
			"Not an automation bundle",
		);
		const wrongVersion = parseAutomationBundle(
			JSON.stringify({ kind: AUTOMATION_BUNDLE_KIND, version: 99, workflow: {}, trigger: {} }),
		);
		expect(wrongVersion.ok === false && wrongVersion.issues.join(" ")).toContain(
			"Unsupported bundle version",
		);
	});

	it("rejects an unknown trigger kind and an unknown step kind", () => {
		const badTrigger = parseAutomationBundle(
			JSON.stringify({
				kind: AUTOMATION_BUNDLE_KIND,
				version: 1,
				workflow: { name: "x", steps: STEPS },
				trigger: { kind: "psychic", config: {} },
			}),
		);
		expect(badTrigger.ok === false && badTrigger.issues.join(" ")).toContain(
			'Unknown trigger kind "psychic"',
		);
		const badStep = parseAutomationBundle(
			JSON.stringify({
				kind: AUTOMATION_BUNDLE_KIND,
				version: 1,
				workflow: { name: "x", steps: [{ id: "s", kind: "explode" }] },
				trigger: { kind: TriggerKind.Manual, config: {} },
			}),
		);
		expect(badStep.ok === false && badStep.issues.join(" ")).toContain("unknown kind");
	});

	it("a null step entry is an issue, never a throw (fail-closed)", () => {
		const result = parseAutomationBundle(
			JSON.stringify({
				kind: AUTOMATION_BUNDLE_KIND,
				version: 1,
				workflow: { name: "x", steps: [null] },
				trigger: { kind: TriggerKind.Manual, config: {} },
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.issues.join(" ")).toContain("malformed step");
	});

	it("rejects empty steps and a blank name via the shared validators", () => {
		const result = parseAutomationBundle(
			JSON.stringify({
				kind: AUTOMATION_BUNDLE_KIND,
				version: 1,
				workflow: { name: "  ", steps: [] },
				trigger: { kind: TriggerKind.Manual, config: {} },
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues.join(" ")).toContain("name is empty");
			expect(result.issues.join(" ")).toContain("no steps");
		}
	});
});

describe("importAutomation", () => {
	it("re-mints disabled with capabilities recomputed from the steps", () => {
		const bundle = exportAutomation(
			// A tampered sheet on the source must not survive the round-trip.
			{ ...WORKFLOW, capabilities: ["vault.admin", "everything.*"] },
			TRIGGER,
		);
		const imported = importAutomation(bundle);
		expect(imported.trigger.enabled).toBe(true);
		const workflow = imported.makeWorkflow("trg_new");
		expect(workflow.enabled).toBe(false);
		expect(workflow.triggerId).toBe("trg_new");
		expect(workflow.capabilities).toEqual(aggregateWorkflowCapabilities(STEPS));
		expect(workflow.capabilities).not.toContain("vault.admin");
	});

	it("honours a caller-resolved display name", () => {
		const bundle = exportAutomation(WORKFLOW, TRIGGER);
		expect(importAutomation(bundle, "Daily ping (2)").makeWorkflow("t").name).toBe("Daily ping (2)");
	});
});

describe("resolveImportName", () => {
	it("keeps a free name, suffixes a taken one, and defaults a blank one", () => {
		expect(resolveImportName("Fresh", ["Other"])).toBe("Fresh");
		expect(resolveImportName("Taken", ["Taken"])).toBe("Taken (2)");
		expect(resolveImportName("Taken", ["Taken", "Taken (2)"])).toBe("Taken (3)");
		expect(resolveImportName("   ", [])).toBe("Imported automation");
	});
});
