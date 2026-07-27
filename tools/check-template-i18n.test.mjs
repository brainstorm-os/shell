/**
 * Workflow-template i18n coverage gate.
 *
 * The id extraction is the delicate part: a bare `id:` scan over `templates.ts`
 * also matches STEP ids, and demanding catalog keys for a step called `trigger`
 * would make the gate fail on correct code. That false positive is the first
 * thing tested here, because it is the one that would get the gate deleted.
 */

import { describe, expect, it } from "vitest";
import { findMissingTemplateKeys, requiredKeys, templateIdsFrom } from "./check-template-i18n.mjs";

const REGISTRY = `
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = Object.freeze([
	{
		id: "daily-planning-nudge",
		name: "Daily planning nudge",
		steps: [TRIGGER_STEP, notify("plan", "Plan", "Plan the day.")],
	},
	{
		id: "triage-new-email",
		name: "Triage new email",
		steps: [
			{ id: "trigger", kind: StepKind.Trigger },
			{ id: "notify", kind: StepKind.Notify },
		],
	},
]);

export function templateById(id: string) {
	return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}
`;

describe("templateIdsFrom", () => {
	it("extracts the template ids", () => {
		expect(templateIdsFrom(REGISTRY)).toEqual(["daily-planning-nudge", "triage-new-email"]);
	});

	it("does NOT pick up nested step ids", () => {
		// `{ id: "trigger" }` is a step, not a template. Treating it as one would
		// demand `template.trigger.name` and fail the gate on correct code — which
		// is exactly how a gate earns a reputation for lying.
		expect(templateIdsFrom(REGISTRY)).not.toContain("trigger");
		expect(templateIdsFrom(REGISTRY)).not.toContain("notify");
	});

	it("stops at the end of the registry array", () => {
		// Anything after `]);` — helper functions, other exports — is out of scope.
		expect(templateIdsFrom(`${REGISTRY}\nconst OTHER = [{\n\t\tid: "not-a-template"\n\t}];`)).toEqual(
			["daily-planning-nudge", "triage-new-email"],
		);
	});

	it("returns nothing when the registry is missing, so the runner can fail loudly", () => {
		expect(templateIdsFrom("export const SOMETHING_ELSE = [];")).toEqual([]);
	});
});

describe("requiredKeys", () => {
	it("demands name, desc and trigger", () => {
		expect(requiredKeys("x")).toEqual(["template.x.name", "template.x.desc", "template.x.trigger"]);
	});
});

describe("findMissingTemplateKeys", () => {
	const full = (id) => Object.fromEntries(requiredKeys(id).map((k) => [k, "text"]));

	it("passes when every locale has every key", () => {
		expect(findMissingTemplateKeys(["a"], { en: full("a"), fr: full("a") })).toEqual([]);
	});

	it("reports the exact locale and key that is missing", () => {
		// The real shape of the bug: en was fine, so an English-only check would
		// have passed while every other locale rendered the raw key id.
		const missing = findMissingTemplateKeys(["a"], { en: full("a"), fr: {} });
		expect(missing).toHaveLength(3);
		expect(missing.every((m) => m.locale === "fr")).toBe(true);
		expect(missing.map((m) => m.key)).toContain("template.a.name");
	});

	it("treats an empty or whitespace value as missing", () => {
		// A blank string renders as nothing at all, which is not better than the
		// raw key — it is worse, because it looks intentional.
		const catalog = { ...full("a"), "template.a.desc": "   " };
		expect(findMissingTemplateKeys(["a"], { en: catalog })).toEqual([
			{ locale: "en", key: "template.a.desc" },
		]);
	});

	it("treats a non-string value as missing", () => {
		const catalog = { ...full("a"), "template.a.name": 42 };
		expect(findMissingTemplateKeys(["a"], { en: catalog })).toEqual([
			{ locale: "en", key: "template.a.name" },
		]);
	});

	it("checks every template, not just the first", () => {
		expect(findMissingTemplateKeys(["a", "b"], { en: full("a") }).map((m) => m.key)).toEqual(
			requiredKeys("b"),
		);
	});
});
