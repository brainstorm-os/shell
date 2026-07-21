import { type Template, TemplateKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	CreateOptionKind,
	buildCreateTemplateMenu,
	draftFromCreateOption,
} from "./template-create-flow";
import type { TemplateDraft } from "./template-entity-codec";

const NOW = 1_700_000_000_000;
const TASK = "brainstorm/Task/v1";
const NOTE = "brainstorm/Note/v1";

function tpl(overrides: Partial<Template> = {}): Template {
	return {
		id: "tpl-1",
		templateKind: TemplateKind.Object,
		targetType: TASK,
		name: "Template",
		icon: null,
		cover: null,
		prototype: {},
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function templateOptionIds(menu: ReturnType<typeof buildCreateTemplateMenu>): string[] {
	return menu.options
		.filter((o) => o.kind === CreateOptionKind.Template)
		.map((o) => (o.kind === CreateOptionKind.Template ? o.template.id : ""));
}

describe("buildCreateTemplateMenu", () => {
	it("returns only Blank when no template applies", () => {
		const menu = buildCreateTemplateMenu([], TASK);
		expect(menu.hasTemplates).toBe(false);
		expect(menu.options).toEqual([{ kind: CreateOptionKind.Blank }]);
		expect(menu.defaultTemplateId).toBeNull();
	});

	it("filters to object templates matching the target type", () => {
		const menu = buildCreateTemplateMenu(
			[
				tpl({ id: "task-a", targetType: TASK }),
				tpl({ id: "note-a", targetType: NOTE }),
				tpl({ id: "snippet", templateKind: TemplateKind.BlockSnippet, targetType: null }),
			],
			TASK,
		);
		expect(menu.hasTemplates).toBe(true);
		expect(templateOptionIds(menu)).toEqual(["task-a"]);
	});

	it("never offers block-snippet templates in the create flow", () => {
		const menu = buildCreateTemplateMenu(
			[tpl({ id: "snippet", templateKind: TemplateKind.BlockSnippet, targetType: null })],
			TASK,
		);
		expect(menu.hasTemplates).toBe(false);
	});

	it("ends the option list with Blank", () => {
		const menu = buildCreateTemplateMenu([tpl({ id: "a" }), tpl({ id: "b" })], TASK);
		expect(menu.options.at(-1)).toEqual({ kind: CreateOptionKind.Blank });
	});

	it("orders applicable templates by name (case-insensitive)", () => {
		const menu = buildCreateTemplateMenu(
			[tpl({ id: "z", name: "zeta" }), tpl({ id: "a", name: "Alpha" }), tpl({ id: "m", name: "mu" })],
			TASK,
		);
		expect(templateOptionIds(menu)).toEqual(["a", "m", "z"]);
	});

	it("surfaces the resolved default first and marks it", () => {
		const menu = buildCreateTemplateMenu(
			[tpl({ id: "a", name: "Alpha" }), tpl({ id: "z", name: "Zeta" })],
			TASK,
			{ collectionDefault: "z" },
		);
		expect(menu.defaultTemplateId).toBe("z");
		expect(templateOptionIds(menu)).toEqual(["z", "a"]);
		const first = menu.options[0];
		expect(first?.kind === CreateOptionKind.Template && first.isDefault).toBe(true);
	});

	it("honors the ladder precedence (view > collection > type)", () => {
		const menu = buildCreateTemplateMenu(
			[tpl({ id: "a" }), tpl({ id: "b" }), tpl({ id: "c" })],
			TASK,
			{
				viewDefault: "a",
				collectionDefault: "b",
				typeDefault: "c",
			},
		);
		expect(menu.defaultTemplateId).toBe("a");
	});

	it("drops a default that no longer applies to the target type", () => {
		const menu = buildCreateTemplateMenu([tpl({ id: "task-a", targetType: TASK })], TASK, {
			// A stale ladder pointing at a note template / deleted id must not apply.
			collectionDefault: "note-default",
		});
		expect(menu.defaultTemplateId).toBeNull();
		expect(templateOptionIds(menu)).toEqual(["task-a"]);
		const first = menu.options[0];
		expect(first?.kind === CreateOptionKind.Template && first.isDefault).toBe(false);
	});
});

describe("draftFromCreateOption", () => {
	const base: TemplateDraft = { type: TASK, properties: { status: "open" } };

	it("hands back the base draft unchanged for Blank", () => {
		const out = draftFromCreateOption({ kind: CreateOptionKind.Blank }, base);
		expect(out).toBe(base);
	});

	it("instantiates a template with criteria pins winning", () => {
		const template = tpl({
			id: "a",
			prototype: { status: "todo", priority: "high" },
		});
		const out = draftFromCreateOption(
			{ kind: CreateOptionKind.Template, template, isDefault: false },
			base,
		);
		// pin (status: open) wins over the template's status: todo
		expect(out.properties.status).toBe("open");
		expect(out.properties.priority).toBe("high");
		expect(out.type).toBe(TASK);
	});

	it("deep-clones prototype values (no shared reference into the template)", () => {
		const template = tpl({ id: "a", prototype: { tags: ["bug"] } });
		const out = draftFromCreateOption(
			{ kind: CreateOptionKind.Template, template, isDefault: false },
			{ properties: {} },
		);
		(out.properties.tags as string[]).push("mutated");
		expect(template.prototype.tags).toEqual(["bug"]);
	});
});
